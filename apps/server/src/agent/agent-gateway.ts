import type { AgentProvider } from "./provider";

export interface AgentGateway {
  readonly kind: "legacy" | "claude" | "codex";
  readonly provider: AgentProvider;
}

export class LegacyAgentGateway implements AgentGateway {
  readonly kind = "legacy" as const;
  constructor(readonly provider: AgentProvider) {}
}

export function asGateway(provider: AgentProvider | undefined): AgentGateway | undefined {
  return provider ? new LegacyAgentGateway(provider) : undefined;
}
