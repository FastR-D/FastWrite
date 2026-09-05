export interface AgentProvider { revise(input: any, signal?: AbortSignal): Promise<any>; [key: string]: any }
export interface ReviseAgentInput { [key: string]: any }
export interface ReviseAgentOutput { replacement: string; rationale: string }
export interface CompletionAgentInput { [key: string]: any }
export interface AgentTaskIssue { [key: string]: any }
export interface AgentTaskInput { [key: string]: any }
export interface AgentTaskPlanOutput { [key: string]: any }
export interface AgentTaskExecutionInput extends AgentTaskInput { targetPath: string }
export interface MemoryAgentInput { [key: string]: any }
export interface MemoryAgentOutput { [key: string]: any }
export interface MemoryHierarchyInput { [key: string]: any }
export interface MemoryHierarchyOutput { [key: string]: any }
export interface MemoryPolishInput { [key: string]: any }
export interface ReviewAgentInput { [key: string]: any }
export interface ReviewAgentOutput { [key: string]: any }
export interface DraftAgentInput { [key: string]: any }
export interface DraftGeneratedFile { path: string; content: string; rationale?: string }
