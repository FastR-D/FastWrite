import { mkdir, readFile, readdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { AgentProvider } from "../agent/provider";
import { ApiError } from "../http";
import { safeSvgInput, validateScene, type DiagramScene } from "./scene";

export interface DiagramRecord { id: string; state: "queued" | "running" | "succeeded" | "failed"; created: string; model: string; parentId?: string; scene?: DiagramScene; error?: string }
export class DiagramService {
  private running = false;
  private directory: string;
  constructor(root: string, private provider: Pick<AgentProvider,"generateDiagram">) { this.directory = join(root,"diagrams"); }
  async initialize() { await mkdir(this.directory,{recursive:true});for(const r of await this.list())if(r.state==='queued'||r.state==='running')await this.write({...r,state:'failed',error:'生成被服务重启中断，请检查后重新提交。'}); }
  private path(id: string) { if(!/^[0-9a-f-]{36}$/.test(id))throw new ApiError(404,'diagram_not_found','Diagram not found');return join(this.directory,id+'.json'); }
  private async write(record: DiagramRecord) { const target=this.path(record.id);const temp=target+'.'+crypto.randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(record));await rename(temp,target);return record; }
  async get(id: string): Promise<DiagramRecord> { try{return JSON.parse(await readFile(this.path(id),'utf8')) as DiagramRecord}catch(error){if(error instanceof ApiError)throw error;throw new ApiError(404,'diagram_not_found','Diagram not found')} }
  async list(): Promise<DiagramRecord[]> { const names=(await readdir(this.directory)).filter(n=>/^[0-9a-f-]{36}\.json$/.test(n));const records=await Promise.all(names.map(n=>this.get(n.slice(0,-5))));return records.sort((a,b)=>b.created.localeCompare(a.created)); }
  async save(scene: unknown,parentId?: string) { if(parentId)await this.get(parentId);return this.write({id:crypto.randomUUID(),state:'succeeded',created:new Date().toISOString(),model:'manual',...(parentId?{parentId}:{}),scene:validateScene(scene)}); }
  async generate(input: {instruction?: unknown;svg?: unknown;model?: unknown;parentId?: unknown}) {
    if(this.running)throw new ApiError(429,'diagram_busy','已有绘图任务正在生成，请稍后重试');
    if(typeof input.instruction!=='string'||!input.instruction.trim()||input.instruction.length>10000)throw new ApiError(400,'diagram_instruction_invalid','请输入 1–10000 字的绘图需求');
    if(input.model!==undefined&&input.model!=='gpt-6-astra')throw new ApiError(400,'diagram_model_invalid','本模块指定模型为 gpt-6-astra；不会静默替换模型');
    const svg=input.svg?safeSvgInput(input.svg):'';
    const parent=typeof input.parentId==='string'?await this.get(input.parentId):undefined;
    if(!this.provider.generateDiagram)throw new ApiError(503,'diagram_provider_unavailable','当前代理不支持结构化绘图');
    const record: DiagramRecord={id:crypto.randomUUID(),state:'queued',created:new Date().toISOString(),model:'gpt-6-astra',...(parent?{parentId:parent.id}:{})};
    this.running=true;
    try{await this.write(record)}catch(error){this.running=false;throw error}
    void (async()=>{const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),300000);try{
      await this.write({...record,state:'running'});
      const output=await this.provider.generateDiagram!({instruction:input.instruction as string,svg,model:'gpt-6-astra',previous:parent?.scene??null},controller.signal);
      await this.write({...record,state:'succeeded',scene:validateScene(output)});
    }catch(error){await this.write({...record,state:'failed',error:error instanceof ApiError?error.message:'模型生成失败或超时；未执行任何生成脚本，请检查代理配置或调整需求。'})}finally{clearTimeout(timer);this.running=false}})();
    return record;
  }
}
