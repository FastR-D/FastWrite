import { extname } from "node:path";

const COMPRESSIBLE = /\.(?:html|js|mjs|css|svg|json)$/;
const FINGERPRINTED_ASSET = /^assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[^/]+$/;

function acceptsGzip(header: string | null): boolean {
  const encodings = (header ?? "").split(",").map((item) => {
    const [name = "", ...parameters] = item.trim().toLowerCase().split(";");
    const quality = parameters.map((parameter) => parameter.trim()).find((parameter) => parameter.startsWith("q="));
    const q = quality === undefined ? 1 : Number(quality.slice(2));
    return { name: name.trim(), q: Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0 };
  });
  const explicit = encodings.find((encoding) => encoding.name === "gzip");
  return explicit ? explicit.q > 0 : encodings.some((encoding) => encoding.name === "*" && encoding.q > 0);
}

/** Respond with a build-produced gzip sibling only when the client accepts it. */
export function webFileResponse(request: Request, path: string, file: Blob, gzipFile?: Blob | null): Response {
  const compressible = COMPRESSIBLE.test(path);
  const useGzip = compressible && !request.headers.has("range") && gzipFile && acceptsGzip(request.headers.get("accept-encoding"));
  const body = useGzip ? gzipFile : file;
  const headers: Record<string, string> = {
    "content-type": webMimeType(extname(path)),
    "content-length": String(body.size),
    "cache-control": path.endsWith(".html") || path === "sw.js" ? "no-cache" : FINGERPRINTED_ASSET.test(path) ? "public, max-age=31536000, immutable" : "public, max-age=3600"
  };
  if (compressible) headers.vary = "Accept-Encoding";
  if (useGzip) headers["content-encoding"] = "gzip";
  return new Response(request.method === "HEAD" ? null : body, { headers });
}

export function webMimeType(extension: string): string {
  return ({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".pdf": "application/pdf",
    ".wasm": "application/wasm"
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}
