import { normalizeWorkspacePath } from "./path";

export interface SyncTexBlock {
  type: string;
  page: number;
  tag?: number;
  line?: number;
  column?: number;
  h?: number;
  v?: number;
  width?: number;
  height?: number;
  depth?: number;
}

export interface SyncTexDocument {
  inputs: ReadonlyMap<number, string>;
  blocks: SyncTexBlock[];
  magnification: number;
  unit: number;
  xOffset: number;
  yOffset: number;
}

export interface SyncTexParseOptions {
  workspacePaths?: string[];
  mainDocument?: string;
}

export interface SourceLocation {
  path: string;
  line: number;
}

export interface PdfLocation {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function parseSyncTex(content: string, options: SyncTexParseOptions = {}): SyncTexDocument {
  const inputs = new Map<number, string>();
  const blocks: SyncTexBlock[] = [];
  let magnification = 1000;
  let unit = 1;
  let xOffset = 0;
  let yOffset = 0;
  let page = 0;

  for (const rawLine of content.replaceAll("\0", "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const input = line.match(/^Input:(\d+):(.+)$/);
    if (input?.[1] && input[2]) {
      const resolved = resolveWorkspaceInput(input[2], options);
      if (resolved) inputs.set(Number.parseInt(input[1], 10), resolved);
      continue;
    }
    if (line.startsWith("Magnification:")) magnification = positiveNumber(line.slice(14), 1000);
    else if (line.startsWith("Unit:")) unit = positiveNumber(line.slice(5), 1);
    else if (line.startsWith("X Offset:")) xOffset = finiteNumber(line.slice(9), 0);
    else if (line.startsWith("Y Offset:")) yOffset = finiteNumber(line.slice(9), 0);
    else if (line[0] === "{") page = Math.max(0, finiteNumber(line.slice(1), page));
    else if (["h", "v", "x", "k", "g", "[", "("].includes(line[0] ?? "")) {
      const block = parseBlock(line, page);
      if (block) blocks.push(block);
    }
  }

  return { inputs, blocks, magnification, unit, xOffset, yOffset };
}

export function sourceToPdf(document: SyncTexDocument, path: string, line: number): PdfLocation | null {
  const tag = findInputTag(document.inputs, path);
  if (tag === null) return null;
  const candidates = document.blocks.filter((block) => block.tag === tag && block.line !== undefined && block.page > 0 && block.h !== undefined && block.v !== undefined);
  if (candidates.length === 0) return null;
  const block = candidates.reduce((best, candidate) => {
    const candidateDistance = Math.abs((candidate.line ?? 0) - line);
    const bestDistance = Math.abs((best.line ?? 0) - line);
    if (candidateDistance !== bestDistance) return candidateDistance < bestDistance ? candidate : best;
    if (candidate.page !== best.page) return candidate.page < best.page ? candidate : best;
    return (candidate.v ?? 0) < (best.v ?? 0) ? candidate : best;
  });
  return {
    page: block.page,
    x: toPdfPoints(block.h ?? 0, document.xOffset, document),
    y: toPdfPoints(block.v ?? 0, document.yOffset, document),
    width: Math.max(18, toPdfPoints(block.width ?? 0, 0, document)),
    height: Math.max(12, toPdfPoints((block.height ?? 0) + (block.depth ?? 0), 0, document))
  };
}

export function pdfToSource(document: SyncTexDocument, page: number, x: number, y: number): SourceLocation | null {
  const rawX = fromPdfPoints(x, document.xOffset, document);
  const rawY = fromPdfPoints(y, document.yOffset, document);
  let best: SyncTexBlock | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const block of document.blocks) {
    if (block.page !== page || block.tag === undefined || block.line === undefined || !document.inputs.has(block.tag)) continue;
    const horizontal = Math.abs((block.h ?? rawX) - rawX);
    const vertical = Math.abs((block.v ?? rawY) - rawY);
    const distance = vertical * 2 + horizontal;
    if (distance < bestDistance) {
      best = block;
      bestDistance = distance;
    }
  }
  if (!best?.tag || !best.line) return null;
  const path = document.inputs.get(best.tag);
  return path ? { path, line: best.line } : null;
}

function parseBlock(line: string, page: number): SyncTexBlock | null {
  const type = line[0];
  if (!type) return null;
  const [tagAndLine = "", coordinates = "", dimensions = ""] = line.slice(1).split(":");
  const [tag, sourceLine, column] = tagAndLine.split(",").map(optionalNumber);
  const [h, v] = coordinates.split(",").map(optionalNumber);
  const [width, height, depth] = dimensions.split(",").map(optionalNumber);
  return compactBlock({ type, page, tag, line: sourceLine, column, h, v, width, height, depth });
}

function compactBlock(block: Record<string, string | number | undefined>): SyncTexBlock {
  return Object.fromEntries(Object.entries(block).filter(([, value]) => value !== undefined && !Number.isNaN(value))) as unknown as SyncTexBlock;
}

function resolveWorkspaceInput(input: string, options: SyncTexParseOptions): string | null {
  const normalizedInput = input.replaceAll("\\", "/").replace(/\/\.\//g, "/").replace(/^\.\//, "");
  const basename = normalizedInput.split("/").at(-1)?.toLowerCase();
  if (basename === "document.tex" && options.mainDocument) return normalizeWorkspacePath(options.mainDocument);
  const workspacePaths = options.workspacePaths?.map(normalizeWorkspacePath) ?? [];
  const exact = workspacePaths.find((path) => normalizedInput === path || normalizedInput.endsWith(`/${path}`));
  if (exact) return exact;
  const basenameMatches = workspacePaths.filter((path) => path.split("/").at(-1)?.toLowerCase() === basename);
  if (basenameMatches.length === 1) return basenameMatches[0] ?? null;
  if (workspacePaths.length > 0) return null;
  try {
    return normalizeWorkspacePath(normalizedInput.replace(/^\/+/, ""));
  } catch {
    return null;
  }
}

function findInputTag(inputs: ReadonlyMap<number, string>, requestedPath: string): number | null {
  const normalized = normalizeWorkspacePath(requestedPath);
  for (const [tag, path] of inputs) if (path === normalized) return tag;
  const basename = normalized.split("/").at(-1)?.toLowerCase();
  const matches = [...inputs].filter(([, path]) => path.split("/").at(-1)?.toLowerCase() === basename);
  return matches.length === 1 ? matches[0]?.[0] ?? null : null;
}

function toPdfPoints(value: number, offset: number, document: SyncTexDocument): number {
  return ((value * document.unit + offset) * 1000) / document.magnification / 65536;
}

function fromPdfPoints(value: number, offset: number, document: SyncTexDocument): number {
  return ((value * 65536 * document.magnification) / 1000 - offset) / document.unit;
}

function optionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveNumber(value: string, fallback: number): number {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function finiteNumber(value: string, fallback: number): number {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
