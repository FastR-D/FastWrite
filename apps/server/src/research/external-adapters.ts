import { ApiError } from "../http";

export type ExternalAdapterKind = "zotero" | "grobid" | "pandoc";
export interface AdapterConfig { kind: ExternalAdapterKind; baseUrl: string; readOnly: true; allowed: boolean; }
export interface AdapterRequest { kind: ExternalAdapterKind; operation: "health" | "search" | "parse" | "convert"; input?: unknown; authorized: boolean; }

const MAX_INPUT = 50_000;
const MAX_RESPONSE_BYTES = 200_000;
export type ResearchAdapterBaseUrls = Partial<Record<ExternalAdapterKind, string>>;

function configuredBaseUrls(): ResearchAdapterBaseUrls {
  const result: ResearchAdapterBaseUrls = {};
  for (const kind of ["zotero", "grobid", "pandoc"] as const) {
    const value = process.env[`FASTWRITE_RESEARCH_${kind.toUpperCase()}_BASE_URL`]?.trim();
    if (value) result[kind] = value;
  }
  return result;
}

export class ExternalResearchAdapters {
  constructor(private readonly fetcher: (input: string | Request | URL, init?: RequestInit) => Promise<Response> = fetch, private readonly baseUrls: ResearchAdapterBaseUrls = configuredBaseUrls()) {}

  async callConfigured(request: AdapterRequest, requestedBaseUrl?: string, signal?: AbortSignal): Promise<unknown> {
    const configured = this.baseUrls[request.kind];
    if (!configured) throw new ApiError(403, "external_adapter_not_allowed", "Configure this research adapter on the server before using it");
    const baseUrl = normalizeBaseUrl(configured);
    if (requestedBaseUrl !== undefined && normalizeBaseUrl(requestedBaseUrl) !== baseUrl) throw new ApiError(403, "external_adapter_not_allowed", "The requested adapter destination is not configured on the server");
    return this.call(request, { kind: request.kind, baseUrl, readOnly: true, allowed: true }, signal);
  }

  async call(request: AdapterRequest, config?: AdapterConfig, signal?: AbortSignal): Promise<unknown> {
    if (request.authorized !== true) throw new ApiError(403, "external_adapter_authorization_required", "Explicit authorization is required for external research adapters");
    if (!config || config.allowed !== true || config.readOnly !== true || config.kind !== request.kind) throw new ApiError(403, "external_adapter_not_allowed", "This adapter is not enabled or is not read-only");
    const base = normalizeBaseUrl(config.baseUrl);
    const input = request.input === undefined ? undefined : JSON.stringify(request.input);
    if (input && input.length > MAX_INPUT) throw new ApiError(400, "external_adapter_input_too_large", "Adapter input exceeds the bounded limit");
    if (request.operation === "convert" && request.kind === "pandoc") throw new ApiError(403, "external_adapter_write_denied", "Pandoc conversion is disabled in read-only adapter mode");
    const endpoint = endpointFor(request.kind, request.operation);
    const deadline = AbortSignal.timeout(5_000);
    const response = await this.fetcher(`${base}${endpoint}`, { method: request.operation === "health" ? "GET" : "POST", headers: { "content-type": "application/json", "user-agent": "FastWrite/0.1 (authorized research adapter)" }, ...(input ? { body: input } : {}), redirect: "manual", signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
    if (!response.ok) throw new ApiError(502, "external_adapter_failed", `External ${request.kind} adapter returned HTTP ${response.status}`);
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new ApiError(502, "external_adapter_response_too_large", "Adapter response exceeds the bounded limit"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const text = Buffer.concat(chunks).toString("utf8");
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
  if (url.username || url.password || url.search || url.hash || value.includes("#") || value.includes("?")) throw new ApiError(400, "external_adapter_url_invalid", "Adapter base URL cannot contain credentials, query parameters or fragments");
  return url.toString().replace(/\/$/, "");
}
