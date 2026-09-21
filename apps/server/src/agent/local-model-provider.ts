import type { AgentProvider, CompletionAgentInput, ReviseAgentInput } from "./provider";

export interface LocalModelProviderOptions { endpoint: string; model: string; fetcher?: typeof fetch; }

/** OpenAI-compatible local endpoint adapter for Ollama/LM Studio and loopback deployments. */
export class LocalModelProvider implements AgentProvider {
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: LocalModelProviderOptions) { this.fetcher = options.fetcher ?? fetch; }
  async complete(input: CompletionAgentInput, signal?: AbortSignal) { return this.request<{ suggestion: string }>("completion", input, signal); }
  async revise(input: ReviseAgentInput, signal?: AbortSignal) { const result = await this.request<{ replacement?: string; rationale?: string }>("revise", input, signal); return { replacement: result.replacement ?? "", rationale: result.rationale ?? "Local model response" }; }
  private async request<T>(operation: string, input: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.fetcher(`${this.options.endpoint.replace(/\/$/, "")}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: this.options.model, messages: [{ role: "user", content: JSON.stringify({ operation, input }) }], temperature: 0 }), ...(signal ? { signal } : {}) });
    if (!response.ok) throw new Error(`Local model returned HTTP ${response.status}`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("Local model returned an empty response");
    return JSON.parse(content) as T;
  }
}
