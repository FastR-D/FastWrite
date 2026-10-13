import { expect, test, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApplication } from "../app";


test("Git mutations preflight every selected path, including directory descendants", async () => {
 const directory=await mkdtemp(join(tmpdir(),"fastwrite-git-access-"));
 const app=await createApplication(directory,{features:{serverAuth:true},bootstrapAdmin:{email:"admin@example.test",password:"test-password-long-enough"}});
 const request=(path:string,token?:string,method="GET",body?:unknown)=>app(new Request("http://test"+path,{method,headers:{...(token?{authorization:"Bearer "+token}:{}),"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})}));
 const json=async(path:string,token?:string,method="GET",body?:unknown)=>{const r=await request(path,token,method,body);expect(r.status).toBeLessThan(300);return await r.json() as any;};
 try{
  const owner=await json("/api/auth/register",undefined,"POST",{email:"owner@example.test",password:"test-password-long-enough"});
  const editor=await json("/api/auth/register",undefined,"POST",{email:"editor@example.test",password:"test-password-long-enough"});
  const project=await json("/api/projects",owner.token,"POST",{name:"ACL"});const base="/api/projects/"+project.id;
  const invite=await json(base+"/invitations",owner.token,"POST",{email:"editor@example.test",role:"editor"});
  await json("/api/invitations/"+invite.token+"/accept",editor.token,"POST");
  await json(base+"/files",owner.token,"POST",{path:"restricted/secret.tex",content:"original"});
  await json(base+"/history/checkpoint",owner.token,"POST");
  await json(base+"/file?path=restricted/secret.tex",owner.token,"PUT",{baseVersion:1,content:"private change"});
  await json(base+"/acl/new",owner.token,"PUT",{pathPrefix:"restricted",subjectType:"user",subjectId:editor.user.id,action:"read",effect:"deny"});
  for(const action of ["stage","unstage","discard"]){
   for(const paths of [["restricted/secret.tex"],["restricted"],["main.tex","restricted/secret.tex"]]) expect((await request(base+"/history/"+action,editor.token,"POST",{paths})).status).toBe(403);
  }
  for(const action of ["checkpoint","commit"]) expect((await request(base+"/history/"+action,editor.token,"POST",{message:"blocked"})).status).toBe(403);
  expect((await json(base+"/file?path=restricted/secret.tex",owner.token)).content).toBe("private change");
  expect((await json(base+"/history/working-status",editor.token)).files).toEqual([]);
  expect((await request(base+"/history/stage",owner.token,"POST",{paths:["restricted/secret.tex"]})).status).toBe(204);
 }finally{await rm(directory,{recursive:true,force:true});}
});
