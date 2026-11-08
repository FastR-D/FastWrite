import { lookup as dnsLookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { ApiError } from "../http";
import { isPdf, MAX_REFERENCE_BYTES } from "./parser";

const blocked = new BlockList();
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(network, prefix, "ipv4");
blocked.addSubnet("2001:db8::", 32, "ipv6"); blocked.addSubnet("2001::", 32, "ipv6"); blocked.addSubnet("2002::", 16, "ipv6");
const globalV6 = new BlockList(); globalV6.addSubnet("2000::", 3, "ipv6");
export function publicReferenceAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, "ipv4") : family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}
export function referenceUrl(value: string): URL {
  let url: URL; try { url = new URL(value); } catch { throw new ApiError(400, "reference_url_invalid", "请输入有效的 HTTPS 论文链接"); }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443" || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || isIP(host) && !publicReferenceAddress(host)) throw new ApiError(400, "reference_url_invalid", "仅支持公共 HTTPS 论文链接");
  return url;
}
export type ReferenceDownload = { bytes: Uint8Array; contentType: string };
export type ReferenceDownloader = (url: string, signal: AbortSignal) => Promise<ReferenceDownload>;

// Resolve and pin the public address for each hop, including publisher redirects.
export async function downloadReference(value: string, signal: AbortSignal, redirects = 0): Promise<ReferenceDownload> {
  const url = referenceUrl(value); signal.throwIfAborted();
  const addresses = await dnsLookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true });
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(item => !publicReferenceAddress(item.address))) throw new ApiError(400, "reference_url_private", "论文链接不能指向本机或内部网络");
  const address = addresses[0]!;
  return new Promise((resolve, reject) => {
    const req = request(url, { signal, family: address.family, headers: { "user-agent": "FastWrite/0.1 (reference paper import)", accept: "application/pdf, application/json, application/zip, text/plain;q=0.8" }, lookup: (_host, _options, callback) => callback(null, address.address, address.family) }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
        response.resume();
        if (redirects >= 5) return reject(new ApiError(422, "reference_redirect_limit", "论文链接重定向次数过多"));
        void downloadReference(new URL(response.headers.location, url).href, signal, redirects + 1).then(resolve, reject); return;
      }
      if ((response.statusCode ?? 500) >= 400) { response.resume(); reject(new ApiError(422, "reference_download_failed", `论文服务返回 ${response.statusCode}，可改为上传本地全文`)); return; }
      const max = (response.headers["content-type"] ?? "").includes("json") ? 2 * 1024 * 1024 : MAX_REFERENCE_BYTES;
      let size = 0; const chunks: Buffer[] = [];
      if (Number(response.headers["content-length"]) > max) { response.destroy(); reject(new ApiError(413, "reference_too_large", "下载内容超过大小限制")); return; }
      response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > max) { response.destroy(); reject(new ApiError(413, "reference_too_large", "下载内容超过大小限制")); } else chunks.push(chunk); });
      response.on("end", () => resolve({ bytes: Buffer.concat(chunks), contentType: response.headers["content-type"] ?? "" }));
      response.on("error", reject);
    });
    req.on("error", reject); req.end();
  });
}

export function referenceIdentifier(input: string): { kind: "arxiv" | "doi" | "url"; value: string } {
  const value = input.trim();
  const arxiv = value.replace(/^arxiv\s*:\s*/i, "").replace(/^https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf|html)\//i, "").replace(/\.pdf(?:\?.*)?$/i, "");
  if (/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v[1-9]\d*)?$/i.test(arxiv)) return { kind: "arxiv", value: arxiv };
  const doi = value.replace(/^doi\s*:\s*/i, "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
  if (/^10\.\d{4,9}\/\S+$/i.test(doi)) return { kind: "doi", value: doi };
  if (/^https:\/\//i.test(value)) return { kind: "url", value: referenceUrl(value).href };
  throw new ApiError(400, "reference_identifier_invalid", "请输入 DOI、arXiv ID 或 HTTPS PDF／LaTeX 链接");
}

export async function resolveReferenceImport(input: unknown, signal: AbortSignal, download: ReferenceDownloader = downloadReference): Promise<{ name: string; bytes: Uint8Array }> {
  if (typeof input !== "string" || !input.trim() || input.length > 2000) throw new ApiError(400, "reference_identifier_invalid", "请输入 DOI、arXiv ID 或论文链接");
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
  const identifier = referenceIdentifier(input);
  const get = async (url: string) => { referenceUrl(url); return download(url, timeout); };
  if (identifier.kind === "arxiv") {
    const result = await get(`https://arxiv.org/pdf/${identifier.value}`);
    if (!isPdf(result.bytes)) throw new ApiError(422, "reference_pdf_unavailable", "arXiv 未返回 PDF 全文，请稍后重试或上传本地文件");
    return { name: `arXiv-${identifier.value.replaceAll("/", "-")}.pdf`, bytes: result.bytes };
  }
  if (identifier.kind === "url") {
    const result = await get(identifier.value);
    let name = decodeURIComponent(new URL(identifier.value).pathname.split("/").pop() || "Reference.pdf");
    if (isPdf(result.bytes)) name = name.replace(/\.[^.]*$/, "") + ".pdf";
    else if (!/\.(tex|latex|zip)$/i.test(name)) throw new ApiError(422, "reference_fulltext_required", "此链接未返回 PDF 或 LaTeX 全文，请填写直接下载链接或上传文件");
    return { name, bytes: result.bytes };
  }
  const arxivDoi = /^10\.48550\/arxiv\.(.+)$/i.exec(identifier.value);
  if (arxivDoi) return resolveReferenceImport(`arxiv:${arxivDoi[1]}`, timeout, download);
  let metadata: { title?: string[]; link?: Array<{ URL?: string; "content-type"?: string }> };
  try {
    const result = await get(`https://api.crossref.org/works/${encodeURIComponent(identifier.value)}`);
    metadata = JSON.parse(new TextDecoder().decode(result.bytes)).message ?? {};
  } catch (error) { if (timeout.aborted) throw error; throw new ApiError(422, "reference_doi_unavailable", "无法解析此 DOI，请核对编号或上传本地全文"); }
  const links = (metadata.link ?? []).filter(link => link.URL && (link["content-type"] === "application/pdf" || /\.pdf(?:$|\?)/i.test(link.URL))).map(link => link.URL!);
  for (const url of [...new Set(links)].slice(0, 4)) {
    try { const result = await get(url.replace(/^http:/, "https:")); if (isPdf(result.bytes)) return { name: `${metadata.title?.[0]?.slice(0, 150) || identifier.value.replaceAll("/", "-")}.pdf`, bytes: result.bytes }; }
    catch (error) { if (timeout.aborted) throw error; }
  }
  throw new ApiError(422, "reference_fulltext_unavailable", "已找到 DOI，但没有可直接下载的 PDF 全文。请上传本地 PDF／LaTeX，或填写开放获取全文链接。");
}
