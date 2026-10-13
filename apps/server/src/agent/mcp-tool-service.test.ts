import { describe, expect, test } from "bun:test";
import { McpRegistry } from "@fastwrite/harness-core";
import { McpToolService } from "./mcp-tool-service";

describe("McpToolService input validation", () => {
  test("rejects malformed input before tool execution", async () => {
    const registry = new McpRegistry();
    registry.register({ id: "workspace", name: "Workspace", version: "1.0.0", enabled: true, tools: [{ name: "read", description: "read", inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } } }] });
    const service = new McpToolService(registry, {} as never);
    await expect(service.call("project", "workspace.read", {}, { allow: ["workspace.read"] })).rejects.toMatchObject({ code: "mcp_input_invalid", status: 400 });
  });
});
test("workspace search skips non-text assets instead of aborting the search",async()=>{
 const registry=new McpRegistry();registry.register({id:"workspace",name:"Workspace",version:"1.0.0",enabled:true,tools:[{name:"search",description:"search",inputSchema:{type:"object",required:["query"],properties:{query:{type:"string"}}}}]});const reads:string[]=[];
 const service=new McpToolService(registry,{async tree(){return [{type:"file",path:"figure.png"},{type:"directory",path:"sections",children:[{type:"file",path:"sections/method.tex"}]}];},async readTextFile(_id:string,path:string){reads.push(path);if(path.endsWith(".png"))throw new Error("binary file");return {content:"Document method",file:{version:1}};}} as never);
 expect(await service.call("project","workspace.search",{query:"document"},{allow:["workspace.search"]})).toEqual({query:"document",results:[{path:"sections/method.tex",excerpts:["Document method"]}]});expect(reads).toEqual(["sections/method.tex"]);
});
test("MCP audit retains one outcome for invalid, denied, failed and completed calls",async()=>{
 const {mkdtemp,rm}=await import("node:fs/promises");const {tmpdir}=await import("node:os");const {join}=await import("node:path");const {JsonDatabase}=await import("../storage/database");const {ApiError}=await import("../http");const directory=await mkdtemp(join(tmpdir(),"mcp-audit-"));
 try{
  const database=new JsonDatabase(directory);await database.initialize();const registry=new McpRegistry();registry.register({id:"workspace",name:"Workspace",version:"1.0.0",enabled:true,tools:[{name:"read",description:"read",inputSchema:{type:"object",required:["path"],properties:{path:{type:"string"}}}}]});
  const service=new McpToolService(registry,{async readTextFile(_id:string,path:string){if(path==="private.tex")throw new ApiError(403,"denied","private payload");if(path==="missing.tex")throw new Error("sensitive failure detail");return {content:"secret text",file:{version:1}};}} as never,undefined,database);
  await expect(service.call("p","workspace.read",{}, {allow:["workspace.read"]})).rejects.toMatchObject({code:"mcp_input_invalid"});
  await expect(service.call("p","workspace.read",{path:"main.tex"},{allow:[]})).rejects.toMatchObject({code:"mcp_tool_denied"});
  await expect(service.call("p","workspace.read",{path:"missing.tex"},{allow:["workspace.read"]})).rejects.toThrow("sensitive failure detail");
  await expect(service.call("p","workspace.read",{path:"private.tex"},{allow:["workspace.read"]})).rejects.toMatchObject({code:"denied"});
  await service.call("p","workspace.read",{path:"main.tex"},{allow:["workspace.read"]});
  expect(service.audit("p").map(entry=>entry.status)).toEqual(["failed","denied","failed","denied","completed"]);expect(service.audit("other")).toEqual([]);expect(JSON.stringify(service.audit())).not.toContain("secret");expect(JSON.stringify(service.audit())).not.toContain("sensitive");
  const reopened=new JsonDatabase(directory);await reopened.initialize();expect(reopened.snapshot().mcpAudits).toHaveLength(5);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test("search revalidates earlier result paths after later reads before returning content", async () => {
 const {ApiError}=await import("../http");
 const registry=new McpRegistry();registry.register({id:"workspace",name:"Workspace",version:"1",enabled:true,tools:[{name:"search",description:"search",inputSchema:{type:"object",required:["query"],properties:{query:{type:"string"}}}}]});
 let revoked=false;const paths:string[]=[];
 const service=new McpToolService(registry,{async tree(){return [{type:"file",path:"first.tex"},{type:"file",path:"second.tex"}];},async readTextFile(_id:string,path:string){paths.push(path);if(path==="second.tex")revoked=true;return {content:"private result",file:{version:1}};}} as never);
 await expect(service.call("project","workspace.search",{query:"private"},{allow:["workspace.search"]},{authorizePath:path=>{if(revoked && path==="first.tex")throw new ApiError(403,"revoked","Path access revoked");}})).rejects.toMatchObject({status:403});
 expect(paths).toEqual(["first.tex","second.tex"]);
});

test("read and compile withhold results when access expires while awaiting execution", async () => {
 const {ApiError}=await import("../http");
 const registry=new McpRegistry();registry.register({id:"workspace",name:"Workspace",version:"1",enabled:true,tools:[{name:"read",description:"read",inputSchema:{type:"object",required:["path"],properties:{path:{type:"string"}}}}]});registry.register({id:"latex",name:"LaTeX",version:"1",enabled:true,tools:[{name:"compile",description:"compile",inputSchema:{type:"object"}}]});
 let revoked=false;const validate=()=>{if(revoked)throw new ApiError(401,"expired","Session expired");};
 const service=new McpToolService(registry,{async readTextFile(){revoked=true;return {content:"private result",file:{version:1}};}} as never,{async compile(){revoked=true;return {pdfPath:"private.pdf"};}} as never);
 await expect(service.call("project","workspace.read",{path:"main.tex"},{allow:["workspace.read"]},{validate})).rejects.toMatchObject({status:401});
 revoked=false;
 await expect(service.call("project","latex.compile",{},{allow:["latex.compile"]},{validate})).rejects.toMatchObject({status:401});
});


test("tool schemas enforce nested constraints and reject unknown schema keywords", async () => {
 const registry=new McpRegistry();let reads=0;
 const inputSchema = {
   type: "object", required: ["path", "options"], additionalProperties: false,
   properties: {
     path: { type: "string", maxLength: 10 },
     options: { type: "object", required: ["mode"], additionalProperties: false, properties: { mode: { enum: ["text"] } } }
   }
 };
 registry.register({id:"workspace",name:"Workspace",version:"1",enabled:true,tools:[{name:"read",description:"read",inputSchema}]});
 const service=new McpToolService(registry,{async readTextFile(){reads++;return {content:"ok",file:{version:1}};}} as never);
 for(const input of [{path:"main.tex",options:{mode:"binary"}},{path:"x".repeat(11),options:{mode:"text"}},{path:"main.tex",options:{mode:"text"},extra:true}])await expect(service.call("p","workspace.read",input,{allow:["workspace.read"]})).rejects.toMatchObject({code:"mcp_input_invalid"});
 expect(reads).toBe(0);
 await service.call("p","workspace.read",{path:"main.tex",options:{mode:"text"}},{allow:["workspace.read"]});expect(reads).toBe(1);
 const invalidRegistry=new McpRegistry(); invalidRegistry.register({id:"workspace",name:"Workspace",version:"2",enabled:true,tools:[{name:"read",description:"read",inputSchema:{type:"object",unknownConstraint:true}}]});
 await expect(new McpToolService(invalidRegistry,{} as never).call("p","workspace.read",{path:"main.tex"},{allow:["workspace.read"]})).rejects.toMatchObject({code:"mcp_schema_invalid",status:503});expect(reads).toBe(1);
});

test("oversized tool paths fail instead of being silently truncated to a different file", async () => {
 const registry=new McpRegistry();registry.register({id:"workspace",name:"Workspace",version:"1",enabled:true,tools:[{name:"read",description:"read",inputSchema:{type:"object"}}]});
 let reads=0;const service=new McpToolService(registry,{async readTextFile(){reads++;return {content:"wrong file",file:{version:1}};}} as never);
 await expect(service.call("p","workspace.read",{path:"a".repeat(501)},{allow:["workspace.read"]})).rejects.toMatchObject({code:"mcp_input_invalid"});expect(reads).toBe(0);
});

test("MCP forwards cancellation to in-flight compilation and records one failed outcome",async()=>{
 const {mkdtemp,rm}=await import("node:fs/promises");const {tmpdir}=await import("node:os");const {join}=await import("node:path");const {JsonDatabase}=await import("../storage/database");const {ApiError}=await import("../http");
 const directory=await mkdtemp(join(tmpdir(),"mcp-compile-cancel-"));
 try{
  const database=new JsonDatabase(directory);await database.initialize();const registry=new McpRegistry();registry.register({id:"latex",name:"LaTeX",version:"1",enabled:true,tools:[{name:"compile",description:"compile",inputSchema:{type:"object"}}]});
  const controller=new AbortController();let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});
  const service=new McpToolService(registry,{} as never,{async compile(_project:string,signal:AbortSignal){expect(signal).toBe(controller.signal);return new Promise((_resolve,reject)=>{signal.addEventListener("abort",()=>reject(new ApiError(409,"compile_cancelled","cancelled")),{once:true});entered();});}} as never,database);
  const operation=service.call("project","latex.compile",{},{allow:["latex.compile"]},{signal:controller.signal});void operation.catch(()=>{});
  await ready;controller.abort();await expect(operation).rejects.toMatchObject({code:"compile_cancelled"});
  expect(service.audit("project").map(item=>item.status)).toEqual(["failed"]);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test("external research cannot bypass approval through the generic MCP executor",async()=>{
 const registry=new McpRegistry();registry.register({id:"research",name:"Research",version:"1",enabled:true,tools:[{name:"search",description:"search",inputSchema:{type:"object"}}]});
 const service=new McpToolService(registry,{} as never);
 await expect(service.call("project","research.search",{query:"topic"},{allow:["research.search"]})).rejects.toMatchObject({code:"mcp_approval_required"});
});

test("credential-like research queries are blocked before approval or provider calls",async()=>{
 const registry=new McpRegistry();registry.register({id:"research",name:"Research",version:"1",enabled:true,tools:[{name:"search",description:"search",inputSchema:{type:"object"}}]});
 const service=new McpToolService(registry,{} as never);
 await expect(service.call("project","research.search",{query:"api_key="+"fixture-secret-material-1234567890"},{allow:["research.search"]})).rejects.toMatchObject({code:"mcp_sensitive_input"});
});
