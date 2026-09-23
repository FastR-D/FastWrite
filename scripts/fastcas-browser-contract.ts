import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../apps/server/src/app";

const issuer=process.env.FASTCAS_CONTRACT_ISSUER!;
const origin=process.env.FASTCAS_CONTRACT_WRITE_ORIGIN!;
assert.ok(issuer&&origin);
const directory=await mkdtemp(join(tmpdir(),"fastwrite-browser-contract-"));
let server:ReturnType<typeof Bun.serve>|undefined;
try {
 const app=await createApplication(directory,{features:{serverAuth:true},fastcasConfiguration:{
  issuer,clientId:"write",clientSecret:"integration-client-secret-32-characters-long",
  redirectUri:origin+"/api/auth/fastcas/callback",allowLoopbackHTTP:true,allowRegistration:false,
 }});
 const target=new URL(origin);
 server=Bun.serve({hostname:target.hostname,port:Number(target.port),fetch:app});
 const registered=await fetch(origin+"/api/auth/register",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:"alice@example.test",password:"local-password-contract-32-characters",displayName:"Local Alice"})});
 assert.equal(registered.status,201,await registered.clone().text());
 const session=await registered.json() as {token:string;user:{id:string}};
 const created=await fetch(origin+"/api/projects",{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${session.token}`},body:JSON.stringify({name:"Browser preserved writing project"})});
 assert.equal(created.status,201,await created.clone().text());
 const project=await created.json() as {id:string};
 const child=Bun.spawn(["node",join(import.meta.dir,"../../FastCAS/web/tests/fastwrite_contract.mjs")],{
  env:{...process.env,FASTCAS_CONTRACT_WRITE_ORIGIN:origin,FASTCAS_CONTRACT_WRITE_USER_ID:session.user.id,FASTCAS_CONTRACT_WRITE_PROJECT_ID:project.id},stdout:"inherit",stderr:"inherit",
 });
 assert.equal(await child.exited,0,"FastWrite Chrome contract failed");
}finally{server?.stop(true);await rm(directory,{recursive:true,force:true})}
