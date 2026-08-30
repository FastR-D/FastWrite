import { ApiError } from "../http";

export const DEFAULT_AGENT_TIMEOUT_MS = 300_000;

interface AgentOperationOptions {
  signal?: AbortSignal | undefined;
  timeoutEnv?: string;
  defaultTimeoutMs?: number;
  label: string;
  codePrefix?: string;
  cancelledMessage?: string;
  timeoutMessage?: string;
}

export async function runAgentOperation<T>(operation: (signal: AbortSignal) => Promise<T>, options: AgentOperationOptions): Promise<T> {
  const controller = new AbortController();
  const fallback = options.defaultTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  const configured = Number.parseInt(process.env[options.timeoutEnv ?? "FASTWRITE_AGENT_TIMEOUT_MS"] ?? String(fallback), 10);
  const timeoutMs = Number.isFinite(configured) ? Math.min(600_000, Math.max(1_000, configured)) : fallback;
  const prefix = options.codePrefix ?? "agent";
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const cancel = () => controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) controller.abort();
  const abortError = () => new ApiError(
    timedOut ? 504 : 499,
    timedOut ? `${prefix}_timeout` : `${prefix}_cancelled`,
    timedOut ? options.timeoutMessage ?? `${options.label} timed out before producing an approvable result` : options.cancelledMessage ?? `${options.label} cancelled; no changes were created`
  );
  try {
    if (controller.signal.aborted) throw abortError();
    const cancellation = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
    return await Promise.race([operation(controller.signal), cancellation]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

export function isAgentCancellation(error: unknown): boolean {
  return error instanceof ApiError && error.code.endsWith("_cancelled");
}
