import type { ApiErrorBody } from "@fastwrite/shared";
import { logServerError } from "./safe-log";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    const body: ApiErrorBody = {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details })
      }
    };
    return json(body, error.status);
  }

  logServerError("unexpected request failure", error);
  return json({ error: { code: "internal_error", message: "Unexpected server error" } } satisfies ApiErrorBody, 500);
}

export async function readJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new ApiError(415, "unsupported_media_type", "Expected an application/json request body");
  }

  try {
    return (await request.json()) as T;
  } catch {
    throw new ApiError(400, "invalid_json", "Request body is not valid JSON");
  }
}

export const CROSS_ORIGIN_HEADERS: Readonly<Record<string, string>> = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
};

export function withRuntimeHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CROSS_ORIGIN_HEADERS)) headers.set(name, value);
  // Monaco generates inline line-position styles and theme stylesheets at runtime.
  // Keep script execution restricted while allowing those rendering styles.
  if (!headers.has("content-security-policy")) headers.set("Content-Security-Policy", "default-src 'self'; img-src 'self' blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; worker-src 'self' blob:; connect-src 'self' blob: ws: wss:");
  if (!headers.has("x-request-id")) headers.set("X-Request-ID", `req_${crypto.randomUUID()}`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Enforce a byte bound while reading, rather than after buffering the entire request. */
export async function readBoundedBytes(request: Request, limit: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid request byte limit");
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) throw new ApiError(400, "invalid_content_length", "Invalid upload content length");
  if (declared !== null && Number(declared) > limit) {
    void request.body?.cancel().catch(() => {});
    throw new ApiError(413, "upload_body_too_large", "Upload body exceeds the declared file size");
  }
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, {once:true});
  request.signal.addEventListener("abort", abort, {once:true});
  if(signal?.aborted || request.signal.aborted) abort();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) throw new ApiError(413, "upload_body_too_large", "Upload body exceeds the declared file size");
      chunks.push(next.value);
    }
    if(signal?.aborted || request.signal.aborted) throw new ApiError(409, "upload_cancelled", "Upload cancelled while reading request body");
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes.buffer;
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "upload_body_incomplete", "Upload body could not be read; retry this file");
  } finally { signal?.removeEventListener("abort",abort);request.signal.removeEventListener("abort",abort);reader.releaseLock(); }
}
