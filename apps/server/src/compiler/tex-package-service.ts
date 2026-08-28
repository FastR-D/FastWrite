import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { unzip } from "fflate";
import { ApiError, json } from "../http";

const DEFAULT_TEX_LIVE_YEAR = 2025;
const SUPPORTED_TEX_LIVE_YEARS = new Set([2023, 2024, 2025]);
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 128 * 1024 * 1024;
const MAX_EXTRACTED_FILES = 20_000;
const PACKAGE_NAME = /^[a-z][a-z0-9._+-]{0,99}$/i;
const TEX_EXTENSIONS = new Set([".sty", ".cls", ".def", ".cfg", ".tex", ".fd", ".clo", ".ltx"]);
const FONT_EXTENSIONS = new Set([".pfb", ".pfm", ".afm", ".tfm", ".vf", ".map", ".enc"]);
const HISTORIC_TEX_LIVE_ORIGIN = "https://ftp.tu-chemnitz.de/pub/tug/historic/systems/texlive";
const CTAN_JSON_ORIGIN = "https://ctan.org/json/2.0/pkg";
const CTAN_MIRROR_ORIGIN = "https://mirrors.ctan.org";
const FILE_TO_PACKAGE_INDEX_URL = "https://cdn.siglum.org/tl2025/bundles/file-to-package.json";
const PACKAGE_FILE_EXTENSIONS = [".sty", ".cls", ".def", ".clo", ".fd", ".cfg", ".tex"];

interface CtanPackageInfo {
  errors?: unknown;
  name?: string;
  contained_in?: string;
  texlive?: string;
  miktex?: string;
  install?: string;
  ctan?: { file?: boolean; path?: string };
}

interface ProcessedFile {
  path: string;
  content: string;
  encoding?: "base64";
}

interface ProcessedPackage {
  name: string;
  files: Record<string, ProcessedFile>;
  totalFiles: number;
  dependencies: string[];
  source: string;
}

export interface TexPackageProvider {
  initialize(): Promise<void>;
  texLiveArchive(packageName: string, requestedYear?: string | null): Promise<Response>;
  ctanPackage(packageName: string, requestedYear?: string | null): Promise<Response>;
  ctanPackageInfo(packageName: string): Promise<Response>;
}

export class TexPackageService implements TexPackageProvider {
  private readonly archiveCache: string;
  private readonly ctanCache: string;
  private readonly inFlight = new Map<string, Promise<Uint8Array>>();
  private fileToPackageIndex: Promise<Record<string, string>> | null = null;

  constructor(
    dataDirectory: string,
    private readonly fetcher: typeof fetch = globalThis.fetch
  ) {
    this.archiveCache = join(dataDirectory, "tex-packages", "archives");
    this.ctanCache = join(dataDirectory, "tex-packages", "ctan");
  }

  async initialize(): Promise<void> {
    await Promise.all([mkdir(this.archiveCache, { recursive: true }), mkdir(this.ctanCache, { recursive: true })]);
  }

  async texLiveArchive(packageName: string, requestedYear?: string | null): Promise<Response> {
    const name = validatePackageName(packageName);
    const year = parseTexLiveYear(requestedYear);
    const bytes = await this.cachedArchive(name, year);
    return new Response(bytes, {
      headers: {
        "content-type": "application/x-xz",
        "content-length": String(bytes.byteLength),
        "cache-control": "public, max-age=31536000, immutable"
      }
    });
  }

  async ctanPackageInfo(packageName: string): Promise<Response> {
    const name = validatePackageName(packageName);
    const response = await this.fetchUpstream(`${CTAN_JSON_ORIGIN}/${encodeURIComponent(name)}`);
    const info = response.ok ? await response.json() as CtanPackageInfo : { errors: ["Not found"] };
    if (!response.ok || info.errors) {
      const containedIn = await this.lookupPackageContainer(name);
      if (!containedIn) throw new ApiError(404, "tex_package_not_found", `TeX package '${name}' was not found`);
      return json({ name, contained_in: containedIn });
    }
    return json({ ...info, contained_in: info.contained_in ?? info.texlive ?? info.miktex ?? info.name ?? name });
  }

  async ctanPackage(packageName: string, requestedYear?: string | null): Promise<Response> {
    const name = validatePackageName(packageName);
    const year = parseTexLiveYear(requestedYear);
    const cachePath = join(this.ctanCache, `${name}@tl${year}-v2.json`);
    const cached = await readFile(cachePath).catch(() => null);
    if (cached) return new Response(cached, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" } });

    const infoResponse = await this.fetchUpstream(`${CTAN_JSON_ORIGIN}/${encodeURIComponent(name)}`);
    if (!infoResponse.ok) throw new ApiError(404, "tex_package_not_found", `TeX package '${name}' was not found`);
    const info = await infoResponse.json() as CtanPackageInfo;
    if (info.errors) throw new ApiError(404, "tex_package_not_found", `TeX package '${name}' was not found`);

    const processed = await this.downloadCtanPackage(name, info);
    const encoded = new TextEncoder().encode(JSON.stringify(processed));
    if (encoded.byteLength > MAX_PACKAGE_BYTES) throw new ApiError(413, "tex_package_too_large", `TeX package '${name}' is too large`);
    await writeAtomically(cachePath, encoded);
    return new Response(encoded, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" } });
  }

  private async cachedArchive(name: string, year: number): Promise<Uint8Array> {
    const directory = join(this.archiveCache, String(year));
    const path = join(directory, `${name}.tar.xz`);
    const cachedInfo = await stat(path).catch(() => null);
    if (cachedInfo) {
      if (cachedInfo.size > MAX_PACKAGE_BYTES) throw new ApiError(413, "tex_package_too_large", `TeX package '${name}' is too large`);
      return new Uint8Array(await readFile(path));
    }

    const key = `${year}:${name}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const pending = (async () => {
      const url = `${HISTORIC_TEX_LIVE_ORIGIN}/${year}/tlnet-final/archive/${encodeURIComponent(name)}.tar.xz`;
      const response = await this.fetchUpstream(url);
      if (!response.ok) throw new ApiError(404, "tex_package_not_found", `TeX package '${name}' was not found in TeX Live ${year}`);
      const bytes = await boundedBytes(response, name);
      if (!isXzArchive(bytes)) throw new ApiError(502, "invalid_tex_package_archive", "The TeX package repository returned an invalid archive");
      await mkdir(directory, { recursive: true });
      await writeAtomically(path, bytes);
      return bytes;
    })().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);
    return pending;
  }

  private async downloadCtanPackage(name: string, info: CtanPackageInfo): Promise<ProcessedPackage> {
    const directCtanPath = info.ctan?.path && /\.[a-z0-9]+$/i.test(info.ctan.path) ? info.ctan.path : undefined;
    if (info.ctan?.file && directCtanPath) {
      const response = await this.fetchUpstream(`${CTAN_MIRROR_ORIGIN}${safeCtanPath(directCtanPath)}`);
      if (response.ok) {
        const content = new TextDecoder().decode(await boundedBytes(response, name));
        const fileName = directCtanPath.split("/").pop() ?? `${name}.sty`;
        const directory = `/texlive/texmf-dist/tex/latex/${name}`;
        return { name, files: { [`${directory}/${fileName}`]: { path: directory, content } }, totalFiles: 1, dependencies: extractDependencies(content, name), source: "ctan-raw" };
      }
    }

    for (const url of ctanZipCandidates(name, info)) {
      const response = await this.fetchUpstream(url);
      if (!response.ok) continue;
      const bytes = await boundedBytes(response, name);
      if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) continue;
      return processZip(await unzipPackage(bytes), name);
    }
    throw new ApiError(404, "tex_package_not_found", `TeX package '${name}' has no downloadable runtime files`);
  }

  private async fetchUpstream(url: string): Promise<Response> {
    try {
      return await this.fetcher(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
    } catch {
      throw new ApiError(502, "tex_package_upstream_unavailable", "The TeX package repository is unavailable");
    }
  }

  private async lookupPackageContainer(name: string): Promise<string | null> {
    if (!this.fileToPackageIndex) {
      this.fileToPackageIndex = (async () => {
        const response = await this.fetchUpstream(FILE_TO_PACKAGE_INDEX_URL);
        if (!response.ok) return {};
        const bytes = await boundedBytes(response, "file-to-package index");
        try { return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, string>; }
        catch { return {}; }
      })();
    }
    const index = await this.fileToPackageIndex;
    for (const extension of PACKAGE_FILE_EXTENSIONS) {
      const container = index[`${name}${extension}`];
      if (container) return container;
    }
    return null;
  }
}

function validatePackageName(value: string): string {
  if (!PACKAGE_NAME.test(value)) throw new ApiError(400, "invalid_tex_package", "Invalid TeX package name");
  return value;
}

function parseTexLiveYear(value?: string | null): number {
  if (!value) return DEFAULT_TEX_LIVE_YEAR;
  const year = Number.parseInt(value, 10);
  if (!SUPPORTED_TEX_LIVE_YEARS.has(year) || String(year) !== value) throw new ApiError(400, "unsupported_tex_live_year", "Supported TeX Live years are 2023, 2024, and 2025");
  return year;
}

async function boundedBytes(response: Response, name: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PACKAGE_BYTES) throw new ApiError(413, "tex_package_too_large", `TeX package '${name}' is too large`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_PACKAGE_BYTES) throw new ApiError(413, "tex_package_too_large", `TeX package '${name}' is too large`);
  return bytes;
}

async function writeAtomically(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temporary, bytes);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function safeCtanPath(path: string): string {
  if (!path.startsWith("/") || path.includes("..") || /[?#]/.test(path)) throw new ApiError(502, "invalid_ctan_response", "CTAN returned an invalid package path");
  return path;
}

function ctanZipCandidates(name: string, info: CtanPackageInfo): string[] {
  const candidates: string[] = [];
  if (info.install) candidates.push(`${CTAN_MIRROR_ORIGIN}/install${safeCtanPath(info.install)}`);
  if (info.ctan?.path) {
    const path = safeCtanPath(info.ctan.file ? info.ctan.path.slice(0, info.ctan.path.lastIndexOf("/")) : info.ctan.path);
    candidates.push(`${CTAN_MIRROR_ORIGIN}${path}.zip`, `${CTAN_MIRROR_ORIGIN}${path}/${encodeURIComponent(name)}.zip`, `${CTAN_MIRROR_ORIGIN}${path}.tds.zip`);
  }
  return [...new Set(candidates)];
}

function isXzArchive(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 6 && bytes[0] === 0xfd && bytes[1] === 0x37 && bytes[2] === 0x7a && bytes[3] === 0x58 && bytes[4] === 0x5a && bytes[5] === 0x00;
}

function unzipPackage(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => unzip(bytes, (error, files) => error ? reject(new ApiError(502, "invalid_ctan_archive", "CTAN returned an invalid package archive")) : resolve(files)));
}

function processZip(files: Record<string, Uint8Array>, name: string): ProcessedPackage {
  const output: Record<string, ProcessedFile> = {};
  const dependencies = new Set<string>();
  let extractedBytes = 0;
  let examinedFiles = 0;
  for (const [archivePath, bytes] of Object.entries(files)) {
    examinedFiles += 1;
    extractedBytes += bytes.byteLength;
    if (examinedFiles > MAX_EXTRACTED_FILES || extractedBytes > MAX_EXTRACTED_BYTES) throw new ApiError(413, "tex_package_too_large", `TeX package '${name}' expands beyond the safety limit`);
    const normalized = archivePath.replaceAll("\\", "/");
    if (normalized.includes("../") || normalized.includes("/doc/") || normalized.includes("/source/")) continue;
    const fileName = normalized.split("/").pop() ?? "";
    const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")).toLowerCase() : "";
    if (TEX_EXTENSIONS.has(extension)) {
      const directory = texTargetDirectory(normalized, name);
      const content = new TextDecoder().decode(bytes);
      output[`${directory}/${fileName}`] = { path: directory, content };
      for (const dependency of extractDependencies(content, name)) dependencies.add(dependency);
    } else if (FONT_EXTENSIONS.has(extension)) {
      const directory = fontTargetDirectory(normalized, name);
      output[`${directory}/${fileName}`] = { path: directory, content: Buffer.from(bytes).toString("base64"), encoding: "base64" };
    }
  }
  const totalFiles = Object.keys(output).length;
  if (totalFiles === 0) throw new ApiError(404, "tex_package_not_found", `TeX package '${name}' has no usable runtime files`);
  return { name, files: output, totalFiles, dependencies: [...dependencies], source: "ctan-zip" };
}

function texTargetDirectory(path: string, name: string): string {
  const latex = path.match(/(?:^|\/)tex\/latex\/([^/]+)/)?.[1];
  if (latex) return `/texlive/texmf-dist/tex/latex/${latex}`;
  const generic = path.match(/(?:^|\/)tex\/generic\/([^/]+)/)?.[1];
  if (generic) return `/texlive/texmf-dist/tex/generic/${generic}`;
  return `/texlive/texmf-dist/tex/latex/${name}`;
}

function fontTargetDirectory(path: string, name: string): string {
  const match = path.match(/(?:^|\/)(fonts\/[^/]+(?:\/[^/]+)*)\//)?.[1];
  return match ? `/texlive/texmf-dist/${match}` : `/texlive/texmf-dist/fonts/type1/public/${name}`;
}

function extractDependencies(content: string, packageName: string): string[] {
  const dependencies = new Set<string>();
  for (const match of content.matchAll(/\\RequirePackage(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
    for (const name of match[1]!.split(",").map((item) => item.trim())) if (PACKAGE_NAME.test(name) && name !== packageName) dependencies.add(name);
  }
  return [...dependencies];
}
