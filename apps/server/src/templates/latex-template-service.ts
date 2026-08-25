import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { LatexTemplateOption, PublicationTarget, TargetVenue } from "@fastwrite/shared";
import { ApiError } from "../http";

interface GithubTreeEntry { path: string; type: "blob" | "tree"; size?: number }
interface GithubTreeResponse { tree?: GithubTreeEntry[]; truncated?: boolean }

interface TemplateDescriptor extends LatexTemplateOption {
  repository: string;
  ref: string;
  path: string;
  mainDocument?: string;
}

const MIRROR_REPOSITORY = "mikubaka88/CCFA-Skills";
const MIRROR_REF = "fd5c7e3afcc097d874d296a0e1e8118ae597f847";
const MIRROR_ROOT = "ccf-latex-templates";
const VERIFIED_AT = "2026-08-25";
const MAX_FILES = 250;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const OFFICIAL: Record<string, Omit<TemplateDescriptor, "id">> = {
  iclr: { label: "ICLR 2026 official LaTeX template", trust: "official", sourceUrl: "https://github.com/ICLR/Master-Template/tree/master/iclr2026", verifiedAt: VERIFIED_AT, venueSpecific: true, repository: "ICLR/Master-Template", ref: "master", path: "iclr2026", mainDocument: "iclr2026_conference.tex" },
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
  const { id, label, trust, sourceUrl, verifiedAt, venueSpecific } = descriptor;
  return { id, label, trust, sourceUrl, verifiedAt, venueSpecific };
}

function descriptorForVenue(venueId: string): TemplateDescriptor | undefined {
  const official = OFFICIAL[venueId];
  if (official) return { id: `official-${venueId}`, ...official };
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
  constructor(private readonly dataDirectory: string, private readonly fetcher: typeof fetch = fetch) {}

  async materialize(name: string, venue: TargetVenue, target: PublicationTarget): Promise<{ stagingDirectory: string; mainDocument: string; displayName: string }> {
    const descriptor = descriptorForVenue(target.venueId);
    if (!descriptor || target.domain !== venue) throw new ApiError(400, "template_unavailable", "No reviewed LaTeX template is available for the selected venue");
    const apiUrl = `https://api.github.com/repos/${descriptor.repository}/git/trees/${encodeURIComponent(descriptor.ref)}?recursive=1`;
    const response = await this.fetcher(apiUrl, { headers: { Accept: "application/vnd.github+json", "User-Agent": "FastWrite" } });
    if (!response.ok) throw new ApiError(502, "template_fetch_failed", `Template source returned HTTP ${response.status}`);
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
      await personalizeTitle(join(stagingDirectory, mainDocument), name);
      return { stagingDirectory, mainDocument, displayName: `${descriptor.label} · ${descriptor.trust}` };
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      throw error;
    }
  }
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
