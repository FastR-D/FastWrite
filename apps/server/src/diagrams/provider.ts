import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import OpenAI from "openai";
import type { AgentProvider } from "../agent/provider";
import { ApiError } from "../http";
import { diagramPrompt, diagramSchema } from "./scene";

/** Schema-only model access. Generated code is never evaluated or spawned. */
export function diagramProvider(root: string): Pick<AgentProvider,"generateDiagram"> {
  return { async generateDiagram(input, signal) {
    if (process.env.FASTWRITE_DIAGRAM_API_KEY) {
      const client = new OpenAI({ apiKey:process.env.FASTWRITE_DIAGRAM_API_KEY, ...(process.env.FASTWRITE_DIAGRAM_BASE_URL?{baseURL:process.env.FASTWRITE_DIAGRAM_BASE_URL}:{}),maxRetries:0,timeout:240000 });
      const response=await client.responses.create({model:"gpt-6-astra",instructions:diagramPrompt,input:JSON.stringify(input),text:{format:{type:"json_schema",name:"diagram_scene",strict:true,schema:diagramSchema}}},signal?{signal}:{});
      if(response.status!=="completed"||!response.output_text)throw new ApiError(502,"diagram_model_incomplete","模型未返回完整图结构");
      return JSON.parse(response.output_text);
    }
    const parent=join(root,"diagram-model");await mkdir(parent,{recursive:true});const cwd=await mkdtemp(join(parent,"run-"));
    const schema=join(cwd,"schema.json"),output=join(cwd,"result.json");await writeFile(schema,JSON.stringify(diagramSchema));
    const command=process.env.FASTWRITE_CODEX_COMMAND||"codex";
    const args=["exec","--ephemeral","--ignore-user-config","--skip-git-repo-check","--sandbox","read-only","--disable","shell_tool","--disable","apply_patch_freeform","--model","gpt-6-astra","--output-schema",schema,"--output-last-message",output,"-"];
    await new Promise<void>((resolve,reject)=>{
      const child=execFile(command,args,{cwd,timeout:270000,maxBuffer:2*1024*1024,windowsHide:true,...(signal?{signal}:{})},error=>error?reject(new ApiError(502,"diagram_codex_failed","Codex 绘图请求失败；请检查 CLI 登录和 gpt-6-astra 可用性")):resolve());
      child.stdin?.end(diagramPrompt+"\nInput data:\n"+JSON.stringify(input));
    });
    return JSON.parse(await readFile(output,"utf8"));
  }};
}
