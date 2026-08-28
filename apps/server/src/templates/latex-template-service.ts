import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { unzipSync } from "fflate";
import type { LatexTemplateOption, PublicationTarget, TargetVenue } from "@fastwrite/shared";
import { ApiError } from "../http";

interface GithubTreeEntry { path: string; type: "blob" | "tree"; size?: number }
interface GithubTreeResponse { tree?: GithubTreeEntry[]; truncated?: boolean }

interface TemplateDescriptor extends LatexTemplateOption {
  repository: string;
  ref: string;
  path: string;
  mainDocument?: string;
  archiveUrl?: string;
}

const MIRROR_REPOSITORY = "mikubaka88/CCFA-Skills";
const MIRROR_REF = "main";
const MIRROR_ROOT = "ccf-latex-templates";
const VERIFIED_AT = "2026-08-28";
const MAX_FILES = 250;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const OFFICIAL: Record<string, Omit<TemplateDescriptor, "id">> = {
  iclr: { label: "ICLR 2027 official LaTeX template", trust: "official", sourceUrl: "https://iclr.cc/Conferences/2027/AuthorGuidelines", verifiedAt: VERIFIED_AT, venueSpecific: true, years: [2027], repository: "ICLR/Master-Template", ref: "2027", path: "iclr2027", mainDocument: "iclr2027_conference.tex", archiveUrl: "https://media.iclr.cc/Conferences/ICLR2027/iclr-2027-style-files.zip" },
  cvpr: { label: "CVPR official author kit", trust: "official", sourceUrl: "https://github.com/cvpr-org/author-kit/releases", verifiedAt: VERIFIED_AT, venueSpecific: true, repository: "cvpr-org/author-kit", ref: "main", path: "", mainDocument: "main.tex" },
  acl: { label: "ACL official style files", trust: "official", sourceUrl: "https://github.com/acl-org/acl-style-files", verifiedAt: VERIFIED_AT, venueSpecific: true, repository: "acl-org/acl-style-files", ref: "master", path: "", mainDocument: "acl_latex.tex" }
};

const MIRROR_PATHS: Record<string, string> = {
  aaai: "AAAI", "acm-mm": "ACM-MM", "ase-conference": "ASE", asplos: "ASPLOS", cav: "CAV", ccs: "CCS", chi: "CHI",
  crypto: "CRYPTO", cvpr: "CVPR", dac: "DAC", eurocrypt: "EUROCRYPT", eurosys: "EuroSys", fast: "FAST", fm: "FM", focs: "FOCS",
  fse: "FSE", hpca: "HPCA", hpdc: "HPDC", iccv: "ICCV", icde: "ICDE", icml: "ICML", icse: "ICSE", infocom: "INFOCOM",
  isca: "ISCA", issta: "ISSTA", kdd: "SIGKDD", lics: "LICS", micro: "MICRO", mobicom: "MobiCom", ndss: "NDSS", neurips: "NeurIPS",
  nsdi: "NSDI", oopsla: "OOPSLA", osdi: "OSDI", pldi: "PLDI", popl: "POPL", ppopp: "PPoPP", rtss: "RTSS", sc: "SC",
  sigcomm: "SIGCOMM", siggraph: "SIGGRAPH", sigir: "SIGIR", sigmod: "SIGMOD", sosp: "SOSP", sp: "S&P", stoc: "STOC",
  "ubicomp-imwut": "UbiComp", uist: "UIST", "usenix-atc": "USENIX-ATC", "usenix-security": "USENIX-Security", vldb: "VLDB", vr: "VR", www: "WWW"
};

const ACM_JOURNALS = new Set(["jacm", "taco", "tochi", "tocs", "tods", "tog", "tois", "toplas", "tos", "tosem"]);
const IEEE_JOURNALS = new Set(["jsac", "proceedings-of-the-ieee", "tc", "tcad", "tdsc", "tifs", "tip", "tit", "tkde", "tmc", "tmm", "ton", "tpami", "tpds", "tsc", "tse", "tvcg"]);
const SPRINGER_JOURNALS = new Set(["ijcv", "journal-of-cryptology", "scis", "vldbj"]);

export function templateForVenue(venueId: string): LatexTemplateOption | undefined {
  const descriptor = descriptorForVenue(venueId);
  if (!descriptor) return undefined;
  const { id, label, trust, sourceUrl, verifiedAt, venueSpecific, years } = descriptor;
  return { id, label, trust, sourceUrl, verifiedAt, venueSpecific, ...(years ? { years } : {}) };
}

function descriptorForVenue(venueId: string, year?: number): TemplateDescriptor | undefined {
  const official = OFFICIAL[venueId];
  if (official) {
    if (year !== undefined && !official.years?.includes(year)) return undefined;
    return { id: `official-${venueId}-${official.years?.[0] ?? "current"}`, ...official };
  }
  let mirrorPath = MIRROR_PATHS[venueId];
  let venueSpecific = true;
  let trust: TemplateDescriptor["trust"] = "community-mirror";
  if (!mirrorPath && ACM_JOURNALS.has(venueId)) { mirrorPath = "ACM"; venueSpecific = false; trust = "publisher"; }
  if (!mirrorPath && IEEE_JOURNALS.has(venueId)) { mirrorPath = "IEEE"; venueSpecific = false; trust = "publisher"; }
  if (!mirrorPath && SPRINGER_JOURNALS.has(venueId)) { mirrorPath = "Springer"; venueSpecific = false; trust = "publisher"; }
  if (!mirrorPath && venueId === "sicomp") { mirrorPath = "SIAM"; venueSpecific = false; trust = "publisher"; }
  if (!mirrorPath) return undefined;
  const mainDocument = mirrorPath === "AAAI" ? "aaai2026_template.tex" : mirrorPath === "NeurIPS" ? "neurips_2026.tex" : mirrorPath === "SIAM" ? "lexample.tex" : undefined;
  return {
    id: `ccfa-mirror-${venueId}`,
    label: `${venueSpecific ? venueId.toUpperCase() : mirrorPath} LaTeX template (${trust === "publisher" ? "publisher family" : "community mirror"})`,
    trust,
    sourceUrl: `https://github.com/${MIRROR_REPOSITORY}/tree/${MIRROR_REF}/${MIRROR_ROOT}/${encodeURIComponent(mirrorPath)}`,
    verifiedAt: VERIFIED_AT,
    venueSpecific,
    repository: MIRROR_REPOSITORY,
    ref: MIRROR_REF,
    path: `${MIRROR_ROOT}/${mirrorPath}`,
    ...(mainDocument ? { mainDocument } : {})
  };
}

export class LatexTemplateService {
  constructor(private readonly dataDirectory: string, private readonly fetcher: typeof fetch = fetch, private readonly bundledDirectory = resolve(import.meta.dir, "bundled")) {}

  async materialize(name: string, venue: TargetVenue, target: PublicationTarget): Promise<{ stagingDirectory: string; mainDocument: string; displayName: string }> {
    const descriptor = descriptorForVenue(target.venueId, target.year);
    if (!descriptor || target.domain !== venue) throw new ApiError(400, "template_unavailable", "No reviewed LaTeX template is available for the selected venue");
    const bundledDirectory = this.bundledDirectoryFor(descriptor);
    const cacheDirectory = this.cacheDirectory(descriptor);
    if (await directoryExists(cacheDirectory)) return this.materializeCached(name, descriptor, cacheDirectory);
    try {
      if (descriptor.archiveUrl) return this.materializeExternalArchive(name, descriptor, cacheDirectory);
      return await this.materializeRepository(name, descriptor, cacheDirectory);
    } catch (error) {
      if (bundledDirectory && await directoryExists(bundledDirectory)) return this.materializeCached(name, descriptor, bundledDirectory);
      throw error;
    }
  }

  private async materializeRepository(name: string, descriptor: TemplateDescriptor, cacheDirectory: string): Promise<{ stagingDirectory: string; mainDocument: string; displayName: string }> {
    const apiUrl = `https://api.github.com/repos/${descriptor.repository}/git/trees/${encodeURIComponent(descriptor.ref)}?recursive=1`;
    const response = await this.fetcher(apiUrl, { headers: { Accept: "application/vnd.github+json", "User-Agent": "FastWrite" } });
    if (!response.ok) {
      if (response.status === 403) return this.materializeArchive(name, descriptor);
      throw new ApiError(502, "template_fetch_failed", `Template source returned HTTP ${response.status}`);
    }
    const payload = await response.json() as GithubTreeResponse;
    if (payload.truncated || !Array.isArray(payload.tree)) throw new ApiError(502, "template_tree_incomplete", "Template repository listing was incomplete");
    const prefix = descriptor.path ? `${descriptor.path.replace(/\/$/, "")}/` : "";
    const files = payload.tree.filter((entry) => entry.type === "blob" && entry.path.startsWith(prefix)).map((entry) => ({ ...entry, relative: entry.path.slice(prefix.length) })).filter((entry) => safeRelativePath(entry.relative) && !ignoredTemplateFile(entry.relative));
    const totalBytes = files.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
    if (!files.length || files.length > MAX_FILES || totalBytes > MAX_TOTAL_BYTES || files.some((entry) => entry.size === undefined)) throw new ApiError(502, "template_size_invalid", "Template exceeds the safe import limits or has no importable files");
    await mkdir(join(this.dataDirectory, "imports"), { recursive: true });
    const stagingDirectory = await mkdtemp(join(this.dataDirectory, "imports", "template-"));
    try {
      await mapConcurrent(files, 6, async (entry) => {
        const rawUrl = `https://raw.githubusercontent.com/${descriptor.repository}/${encodeURIComponent(descriptor.ref)}/${entry.path.split("/").map(encodeURIComponent).join("/")}`;
        const fileResponse = await this.fetcher(rawUrl, { headers: { "User-Agent": "FastWrite" } });
        if (!fileResponse.ok) throw new ApiError(502, "template_file_fetch_failed", `Could not fetch template file '${entry.relative}'`);
        const bytes = new Uint8Array(await fileResponse.arrayBuffer());
        if (bytes.byteLength !== entry.size) throw new ApiError(502, "template_file_size_mismatch", `Template file '${entry.relative}' changed during import`);
        const destination = join(stagingDirectory, ...entry.relative.split("/"));
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, bytes);
      });
      const mainDocument = chooseMainDocument(files.map((entry) => entry.relative), descriptor.mainDocument);
      if (!mainDocument) throw new ApiError(502, "template_main_missing", "No LaTeX entry document could be identified in this template");
      await this.saveCache(stagingDirectory, cacheDirectory);
      await personalizeTitle(join(stagingDirectory, mainDocument), name);
      return { stagingDirectory, mainDocument, displayName: `${descriptor.label} · ${descriptor.trust}` };
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  private cacheDirectory(descriptor: TemplateDescriptor): string {
    const cacheKey = `${descriptor.id}-${descriptor.ref}`.replace(/[^a-zA-Z0-9._-]/g, "_");
    return join(this.dataDirectory, "templates", cacheKey);
  }

  private bundledDirectoryFor(descriptor: TemplateDescriptor): string | undefined {
    if (descriptor.repository === MIRROR_REPOSITORY) return join(this.bundledDirectory, "ccfa", descriptor.path.slice(`${MIRROR_ROOT}/`.length));
    if (descriptor.id.startsWith("official-acl-")) return join(this.bundledDirectory, "ccfa", "ACL");
    if (descriptor.id.startsWith("official-cvpr-")) return join(this.bundledDirectory, "ccfa", "CVPR");
    return undefined;
  }

  private async saveCache(sourceDirectory: string, cacheDirectory: string): Promise<void> {
    await mkdir(dirname(cacheDirectory), { recursive: true });
    await rm(cacheDirectory, { recursive: true, force: true });
    await cp(sourceDirectory, cacheDirectory, { recursive: true });
  }

  private async materializeCached(name: string, descriptor: TemplateDescriptor, cacheDirectory: string): Promise<{ stagingDirectory: string; mainDocument: string; displayName: string }> {
    const files: string[] = [];
    for await (const file of new Bun.Glob("**/*").scan({ cwd: cacheDirectory, onlyFiles: true })) files.push(file);
    const mainDocument = chooseMainDocument(files, descriptor.mainDocument);
    if (!mainDocument) throw new ApiError(502, "template_main_missing", "No LaTeX entry document could be identified in the cached template");
    await mkdir(join(this.dataDirectory, "imports"), { recursive: true });
    const stagingDirectory = await mkdtemp(join(this.dataDirectory, "imports", "template-"));
    try {
      await cp(cacheDirectory, stagingDirectory, { recursive: true });
      await personalizeTitle(join(stagingDirectory, mainDocument), name);
      return { stagingDirectory, mainDocument, displayName: `${descriptor.label} · ${descriptor.trust}` };
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  private async materializeArchive(name: string, descriptor: TemplateDescriptor): Promise<{ stagingDirectory: string; mainDocument: string; displayName: string }> {
    const archiveUrl = `https://codeload.github.com/${descriptor.repository}/zip/${encodeURIComponent(descriptor.ref)}`;
    return this.materializeArchiveUrl(name, descriptor, this.cacheDirectory(descriptor), archiveUrl, "Template source returned HTTP 403 and archive fallback returned HTTP");
  }

  private async materializeExternalArchive(name: string, descriptor: TemplateDescriptor, cacheDirectory: string): Promise<{ stagingDirectory: string; mainDocument: string; displayName: string }> {
    return this.materializeArchiveUrl(name, descriptor, cacheDirectory, descriptor.archiveUrl!, "Official template archive returned HTTP");
  }

  private async materializeArchiveUrl(name: string, descriptor: TemplateDescriptor, cacheDirectory: string, archiveUrl: string, errorPrefix: string): Promise<{ stagingDirectory: string; mainDocument: string; displayName: string }> {
    const response = await this.fetcher(archiveUrl, { headers: { "User-Agent": "FastWrite" } });
    if (!response.ok) throw new ApiError(502, "template_fetch_failed", `${errorPrefix} ${response.status}`);
    let archive: Record<string, Uint8Array>;
    try {
      archive = unzipSync(new Uint8Array(await response.arrayBuffer()));
    } catch {
      throw new ApiError(502, "template_archive_invalid", "The official template archive could not be read");
    }
    const marker = descriptor.path ? `${descriptor.path.replace(/\/$/, "")}/` : "";
    const archiveEntry = Object.keys(archive).find((path) => marker ? path.includes(marker) : path.split("/").length > 1);
    if (!archiveEntry) throw new ApiError(502, "template_tree_incomplete", "The official template archive did not contain the selected template");
    const prefix = marker ? archiveEntry.slice(0, archiveEntry.indexOf(marker) + marker.length) : `${archiveEntry.split("/")[0]}/`;
    const files = Object.entries(archive)
      .filter(([path, bytes]) => path.startsWith(prefix) && path !== prefix && !path.endsWith("/") && safeRelativePath(path.slice(prefix.length)) && !ignoredTemplateFile(path.slice(prefix.length)))
      .map(([path, bytes]) => ({ path, relative: path.slice(prefix.length), bytes }));
    const totalBytes = files.reduce((sum, entry) => sum + entry.bytes.byteLength, 0);
    if (!files.length || files.length > MAX_FILES || totalBytes > MAX_TOTAL_BYTES) throw new ApiError(502, "template_size_invalid", "Template exceeds the safe import limits or has no importable files");
    await mkdir(join(this.dataDirectory, "imports"), { recursive: true });
    const stagingDirectory = await mkdtemp(join(this.dataDirectory, "imports", "template-"));
    try {
      await Promise.all(files.map(async (entry) => {
        const destination = join(stagingDirectory, ...entry.relative.split("/"));
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, entry.bytes);
      }));
      const mainDocument = chooseMainDocument(files.map((entry) => entry.relative), descriptor.mainDocument);
      if (!mainDocument) throw new ApiError(502, "template_main_missing", "No LaTeX entry document could be identified in this template");
      await this.saveCache(stagingDirectory, cacheDirectory);
      await personalizeTitle(join(stagingDirectory, mainDocument), name);
      return { stagingDirectory, mainDocument, displayName: `${descriptor.label} · ${descriptor.trust}` };
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      throw error;
    }
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

function safeRelativePath(value: string): boolean {
  return Boolean(value) && !value.startsWith("/") && !value.includes("\\") && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function ignoredTemplateFile(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.startsWith(".git") || lower.includes("/.git") || lower.endsWith(".pdf") || lower.endsWith(".zip") || lower.endsWith(".tar.gz");
}

function chooseMainDocument(files: string[], preferred?: string): string | undefined {
  if (preferred && files.includes(preferred)) return preferred;
  return files.filter((file) => file.toLowerCase().endsWith(".tex")).sort((a, b) => scoreMain(b) - scoreMain(a) || a.localeCompare(b))[0];
}

function scoreMain(file: string): number {
  const name = basename(file).toLowerCase();
  let score = file.split("/").length === 1 ? 20 : 0;
  if (name === "main.tex") score += 100;
  if (/template|sample|example|conference/.test(name)) score += 35;
  if (/rebuttal|supp|appendix|checklist|math_command|preamble/.test(name)) score -= 100;
  return score;
}

async function personalizeTitle(path: string, name: string): Promise<void> {
  const text = await readFile(path, "utf8");
  const safeName = name.replace(/[{}\\]/g, "").trim();
  const updated = text.replace(/\\title(?:\[[^\]]*\])?\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/, `\\title{${safeName}}`);
  if (updated !== text) await writeFile(path, updated, "utf8");
}

async function mapConcurrent<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      if (item !== undefined) await work(item);
    }
  }));
}
