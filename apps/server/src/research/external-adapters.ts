import { ApiError } from "../http";

export type ExternalAdapterKind = "zotero" | "grobid" | "pandoc";
export interface AdapterConfig { kind: ExternalAdapterKind; baseUrl: string; readOnly: true; allowed: boolean; }
export interface AdapterRequest { kind: ExternalAdapterKind; operation: "health" | "search" | "parse" | "convert"; input?: unknown; authorized: boolean; }

const MAX_INPUT = 50_000;

export class ExternalResearchAdapters {
  constructor(private readonly fetcher: (input: string | Request | URL, init?: RequestInit) => Promise<Response> = fetch) {}

  async call(request: AdapterRequest, config?: AdapterConfig, signal?: AbortSignal): Promise<unknown> {
    if (request.authorized !== true) throw new ApiError(403, "external_adapter_authorization_required", "Explicit authorization is required for external research adapters");
    if (!config || config.allowed !== true || config.readOnly !== true || config.kind !== request.kind) throw new ApiError(403, "external_adapter_not_allowed", "This adapter is not enabled or is not read-only");
    const base = normalizeBaseUrl(config.baseUrl);
    const input = request.input === undefined ? undefined : JSON.stringify(request.input);
    if (input && input.length > MAX_INPUT) throw new ApiError(400, "external_adapter_input_too_large", "Adapter input exceeds the bounded limit");
    if (request.operation === "convert" && request.kind === "pandoc") throw new ApiError(403, "external_adapter_write_denied", "Pandoc conversion is disabled in read-only adapter mode");
    const endpoint = endpointFor(request.kind, request.operation);
    const response = await this.fetcher(`${base}${endpoint}`, { method: request.operation === "health" ? "GET" : "POST", headers: { "content-type": "application/json", "user-agent": "FastWrite/0.1 (authorized research adapter)" }, ...(input ? { body: input } : {}), signal: signal ?? AbortSignal.timeout(5_000) });
    if (!response.ok) throw new ApiError(502, "external_adapter_failed", `External ${request.kind} adapter returned HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 200_000) throw new ApiError(502, "external_adapter_response_too_large", "Adapter response exceeds the bounded limit");
    try { return JSON.parse(text); } catch { return { text: text.slice(0, 200_000) }; }
  }
}

export function adapterCapabilities(kind: ExternalAdapterKind): { read: string[]; write: string[]; requiresAuthorization: boolean } {
  if (kind === "zotero") return { read: ["search", "health"], write: [], requiresAuthorization: true };
  if (kind === "grobid") return { read: ["parse", "health"], write: [], requiresAuthorization: true };
  return { read: ["parse", "health"], write: [], requiresAuthorization: true };
}

function endpointFor(kind: ExternalAdapterKind, operation: AdapterRequest["operation"]): string {
  if (operation === "health") return "/health";
  if (kind === "zotero" && operation === "search") return "/api/users/0/items";
  if (kind === "grobid" && operation === "parse") return "/api/processFulltextDocument";
  if (kind === "pandoc" && operation === "parse") return "/pandoc?from=markdown&to=json";
  throw new ApiError(400, "external_adapter_operation_invalid", "Unsupported adapter operation");
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError(400, "external_adapter_url_invalid", "Adapter base URL is invalid"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ApiError(400, "external_adapter_url_invalid", "Adapter base URL must use HTTP or HTTPS");
  return url.toString().replace(/\/$/, "");
}
