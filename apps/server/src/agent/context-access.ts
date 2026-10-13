/** Request-scoped authorization for additional files supplied to an AI workflow. */
export interface AgentContextAccess {
  canUsePath(path: string): boolean;
  // Project memory can summarize any source, so omit it for restricted callers.
  includeMemory: boolean;
}
