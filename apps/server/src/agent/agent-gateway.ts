import type { AgentProvider } from "./provider";

export interface AgentGateway {
  readonly kind: "claude" | "codex";
  readonly provider: AgentProvider;
}

export class HarnessAgentGateway implements AgentGateway {
  readonly kind: "claude" | "codex";
  constructor(readonly provider: AgentProvider, kind: "claude" | "codex" = "codex") { this.kind = kind; }
}

export function asGateway(provider: AgentProvider | undefined): AgentGateway | undefined {
  return provider ? provider as unknown as AgentGateway : undefined;
}
