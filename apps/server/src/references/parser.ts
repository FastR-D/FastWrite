import { Unzip, UnzipInflate } from "fflate";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { normalizeWorkspacePath, type ParsedReference, type ReferenceLocator, type ReferenceSection } from "@fastwrite/shared";
import { posix } from "node:path";
import { ApiError } from "../http";

export const REFERENCE_PARSER_VERSION = "1";
export const MAX_REFERENCE_BYTES = 30 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 1500;
const MAX_CHARACTERS = 2_000_000;

const invalid = (message: string) => new ApiError(422, "reference_invalid", message);
export function isPdf(bytes: Uint8Array): boolean { return new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-"; }

/** Inspect central-directory quotas before starting any decompression, then bound actual output too. */
export function readReferenceZip(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.byteLength > MAX_REFERENCE_BYTES) throw new ApiError(413, "reference_too_large", "Reference upload exceeds 30 MB");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
  }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw invalid("Use a complete, single-volume ZIP archive");
  const count = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);
  const centralEnd = cursor + view.getUint32(end + 12, true);
  if (!count || count > MAX_FILES || centralEnd > end) throw invalid("ZIP entry count or directory size exceeds the reference limits");
  const expected = new Map<string, number>();
  let expanded = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > centralEnd || view.getUint32(cursor, true) !== 0x02014b50) throw invalid("Invalid ZIP directory");
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const size = view.getUint32(cursor + 24, true);
    const nameSize = view.getUint16(cursor + 28, true);
    const extraSize = view.getUint16(cursor + 30, true);
    const commentSize = view.getUint16(cursor + 32, true);
    const mode = (view.getUint32(cursor + 38, true) >>> 16) & 0xf000;
    const next = cursor + 46 + nameSize + extraSize + commentSize;
    if (next > centralEnd || flags & 1 || ![0, 8].includes(method) || (mode && mode !== 0x8000 && mode !== 0x4000)) throw invalid("Encrypted ZIPs, special files and unsupported compression are not accepted");
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(cursor + 46, cursor + 46 + nameSize));
    let path: string;
    try { path = normalizeWorkspacePath(name.replace(/\/$/, "")); } catch { throw invalid("ZIP paths must stay inside the reference archive"); }
    if (!path || path.split("/").length > 20 || expected.has(path)) throw invalid("ZIP contains an empty, duplicate or excessively deep path");
    expanded += size;
    if (size > MAX_FILE_BYTES || expanded > MAX_EXPANDED_BYTES) throw new ApiError(413, "reference_archive_too_large", "ZIP expanded size exceeds the reference limits");
    expected.set(path, size);
    cursor = next;
  }
  const files = new Map<string, Uint8Array>();
  const seen = new Set<string>();
  let actualBytes = 0;
  try {
    const unzip = new Unzip(file => {
      const path = normalizeWorkspacePath(file.name.replace(/\/$/, ""));
      if (!expected.has(path) || seen.has(path)) throw invalid("ZIP local entries do not match its directory");
      seen.add(path);
      const parts: Uint8Array[] = [];
      let size = 0;
      file.ondata = (error, data, final) => {
        if (error) throw error;
        size += data.length; actualBytes += data.length;
        if (size > MAX_FILE_BYTES || actualBytes > MAX_EXPANDED_BYTES || size > expected.get(path)!) throw invalid("ZIP expanded data exceeds its declared limits");
        parts.push(data);
        if (final) {
          if (size !== expected.get(path)) throw invalid("ZIP entry is incomplete");
          if (!file.name.endsWith("/")) {
            const result = new Uint8Array(size); let offset = 0;
            for (const part of parts) { result.set(part, offset); offset += part.length; }
            files.set(path, result);
          }
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    for (let from = 0; from < bytes.length; from += 16_384) unzip.push(bytes.subarray(from, from + 16_384), from + 16_384 >= bytes.length);
    if (seen.size !== expected.size) throw invalid("ZIP archive is incomplete");
  } catch (error) { if (error instanceof ApiError) throw error; throw invalid("Could not read this ZIP archive"); }
  return files;
}

export function referenceCandidates(files: Map<string, Uint8Array>): { kind: "tex-zip" | "pdf-zip"; candidates: string[] } {
  const tex = [...files.keys()].filter(path => /\.tex$/i.test(path) && !/(^|\/)(__MACOSX|\.[^/]+)\//.test(path));
  if (tex.length) {
    const roots = tex.filter(path => /\\documentclass(?:\[[^\]]*\])?\s*\{/.test(maskComments(decodeTex(files.get(path)!))));
    return { kind: "tex-zip", candidates: (roots.length ? roots : tex).sort() };
  }
  const pdfs = [...files.entries()].filter(([, bytes]) => isPdf(bytes)).map(([path]) => path).sort();
  if (!pdfs.length) throw invalid("ZIP contains no PDF or TeX paper");
  return { kind: "pdf-zip", candidates: pdfs };
}

function decodeTex(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n?/g, "\n"); }
  catch { throw invalid("TeX sources must use UTF-8 encoding"); }
}
function maskComments(text: string): string {
  return text.split("\n").map(line => {
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== "%") continue;
      let slashes = 0; for (let previous = i - 1; previous >= 0 && line[previous] === "\\"; previous--) slashes++;
      if (slashes % 2 === 0) return line.slice(0, i) + " ".repeat(line.length - i);
    }
    return line;
  }).join("\n");
}
function balanced(text: string, open: number): { value: string; end: number } | undefined {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === "{") depth++;
    if (text[i] === "}" && --depth === 0) return { value: text.slice(open + 1, i), end: i + 1 };
  }
  return undefined;
}

class ReferenceBuilder {
  result: ParsedReference = { text: "", blocks: [], sections: [], warnings: [] };
  append(text: string, locator: ReferenceLocator) {
    if (!text.trim()) return;
    const from = this.result.text.length;
    if (from + text.length + 2 > MAX_CHARACTERS) throw new ApiError(413, "reference_text_too_large", "Reference text exceeds two million characters; it was not truncated");
    this.result.text += text + "\n\n";
    this.result.blocks.push({ id: `block-${this.result.blocks.length}`, from, to: from + text.length, text, locator });
  }
  heading(title: string, level: number, locator: ReferenceLocator) {
    this.result.sections.push({ id: `section-${this.result.sections.length}`, title, level, from: this.result.text.length, to: 0, locator });
  }
  finish(): ParsedReference {
    const { sections, text } = this.result;
    if (!sections.length && text.trim()) sections.push({ id: "section-0", title: "Full text", level: 1, from: 0, to: text.length, locator: this.result.blocks[0]?.locator ?? {} });
    const stack: ReferenceSection[] = [];
    for (const section of sections) {
      while (stack.length && stack.at(-1)!.level >= section.level) stack.pop()!.to = section.from;
      stack.push(section);
    }
    for (const section of stack) section.to = text.length;
    return this.result;
  }
}

/** Static expansion only: no TeX engine, shell, macro or remote resource is executed. */
export function parseReferenceTex(files: Map<string, Uint8Array>, root: string, signal?: AbortSignal): ParsedReference {
  const builder = new ReferenceBuilder();
  const deadline = performance.now() + 5000;
  let visits = 0;
  const visit = (path: string, stack: string[]) => {
    signal?.throwIfAborted();
    if (stack.includes(path) || stack.length >= 30 || ++visits > 2000) { builder.result.warnings.push(`Include cycle or depth limit: ${path}`); return; }
    const bytes = files.get(path);
    if (!bytes) { builder.result.warnings.push(`Missing included file: ${path}`); return; }
    const source = decodeTex(bytes);
    const masked = maskComments(source).replace(/\\begin\{(verbatim|lstlisting|minted)\}[\s\S]*?\\end\{\1\}/g, match => match.replace(/[^\n]/g, " "));
    const commands = /\\(part|chapter|section|subsection|subsubsection|input|include|subfile|begin|end)(?:\*)?\s*(?:\[[^\]]*\]\s*)?(\{|(?=\S))/g;
    const documentStart = /\\begin\s*\{document\}/.exec(masked);
    let cursor = path === root && documentStart ? documentStart.index + documentStart[0].length : 0;
    const append = (from: number, to: number) => {
      const text = maskComments(source.slice(from, to)).trim();
      builder.append(text, { path, line: source.slice(0, from).split("\n").length });
    };
    for (const match of masked.matchAll(commands)) {
      signal?.throwIfAborted();
      if (performance.now() > deadline) throw invalid("TeX parsing exceeded its time limit; select a smaller source entry");
      const at = match.index!;
      if (at < cursor) continue;
      const command = match[1]!;
      const open = at + match[0].length - (match[2] === "{" ? 1 : 0);
      const argument = match[2] === "{" ? balanced(masked, open) : command === "input" ? (() => { const value = /^[^\s%]+/.exec(masked.slice(open))?.[0]; return value ? { value, end: open + value.length } : undefined; })() : undefined;
      if (!argument) continue;
      const locator = { path, line: source.slice(0, at).split("\n").length };
      if (command === "begin" && argument.value === "document") { cursor = argument.end; continue; }
      if (command === "end" && argument.value === "document") { append(cursor, at); cursor = source.length; break; }
      if (["input", "include", "subfile"].includes(command)) {
        append(cursor, at);
        const requested = /\.[^/]+$/.test(argument.value) ? argument.value : `${argument.value}.tex`;
        if (/[\\{}]/.test(requested) || requested.startsWith("/")) { builder.result.warnings.push(`Unresolved dynamic include in ${path}:${locator.line}`); cursor = argument.end; continue; }
        const options = [posix.normalize(posix.join(posix.dirname(root), requested)), posix.normalize(posix.join(posix.dirname(path), requested))];
        const safe = options.filter(candidate => candidate !== ".." && !candidate.startsWith("../"));
        if (!safe.length) builder.result.warnings.push(`Include outside archive: ${argument.value}`);
        else visit(safe.find(candidate => files.has(candidate)) ?? safe[0]!, [...stack, path]);
        cursor = argument.end;
      } else if (["part", "chapter", "section", "subsection", "subsubsection"].includes(command) || (command === "begin" && argument.value === "abstract")) {
        append(cursor, at);
        const title = command === "begin" ? "Abstract" : argument.value.replace(/\\[a-zA-Z]+\s*/g, "").replace(/[{}]/g, "").trim();
        const level = ({ part: 0, chapter: 0, section: 1, subsection: 2, subsubsection: 3 } as Record<string, number>)[command] ?? 1;
        builder.heading(title, level, locator);
        builder.append(title, locator);
        cursor = argument.end;
      }
    }
    append(cursor, source.length);
  };
  if (!files.has(root)) throw invalid("Selected TeX entry file is missing");
  visit(root, []);
  builder.result.warnings.push("Static TeX parsing preserves source syntax. Custom macros and conditional compilation may require checking the original source.");
  if (!builder.result.text.trim()) throw invalid("No paper text was found in the selected TeX entry");
  return builder.finish();
}

export async function parseReferencePdf(bytes: Uint8Array, signal?: AbortSignal): Promise<ParsedReference> {
  if (!isPdf(bytes)) throw invalid("Selected file is not a PDF");
  const builder = new ReferenceBuilder();
  const task = getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: true });
  const abort = () => { void task.destroy(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    const document = await task.promise;
    if (document.numPages > 200) throw new ApiError(413, "reference_too_many_pages", "Reference PDF exceeds 200 pages");
    builder.result.pageCount = document.numPages;
    for (let number = 1; number <= document.numPages; number++) {
      signal?.throwIfAborted();
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const items = content.items.filter((item): item is Extract<typeof item, { str: string }> => "str" in item);
      const width = page.getViewport({ scale: 1 }).width;
      // A gutter with text on both sides suggests columns. Keep spanning headings above each band.
      const left = items.filter(item => item.transform[4]! < width * .45 && item.width < width * .55);
      const right = items.filter(item => item.transform[4]! > width * .48);
      const twoColumns = left.length > 15 && right.length > 15;
      const order = [...items].sort((a, b) => {
        if (twoColumns) {
          const column = (item: typeof a) => item.width > width * .6 ? -1 : item.transform[4]! > width * .48 ? 1 : 0;
          const ac = column(a), bc = column(b);
          if (ac !== bc) return ac - bc;
        }
        return Math.abs(a.transform[5]! - b.transform[5]!) > 3 ? b.transform[5]! - a.transform[5]! : a.transform[4]! - b.transform[4]!;
      });
      let line = "", previousY: number | undefined;
      const flush = () => {
        const text = line.replace(/\s+/g, " ").trim(); line = "";
        if (!text) return;
        if (/^(?:\d+(?:\.\d+)*[.\s]+)?(?:abstract|introduction|related work|background|method(?:ology)?|approach|evaluation|experiments?|results|discussion|limitations|conclusions?|references|appendix)(?:\s*[:.].*)?$/i.test(text)) builder.heading(text, 1, { page: number });
        builder.append(text, { page: number });
      };
      for (const item of order) {
        const y = item.transform[5]!;
        if (previousY !== undefined && Math.abs(y - previousY) > 3) flush();
        line += `${item.str} `;
        previousY = y;
        if (item.hasEOL) flush();
      }
      flush(); page.cleanup();
      if (twoColumns) builder.result.warnings.push(`Page ${number}: inferred two-column reading order; verify excerpts against the PDF.`);
    }
    if (!builder.result.text.trim()) throw invalid("PDF has no extractable text. Upload TeX sources or a PDF with a text layer; OCR is not available.");
    builder.result.warnings.push("PDF headings and paragraph boundaries are inferred. Page ranges and text selections remain available when the outline is incomplete.");
    return builder.finish();
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ApiError) throw error;
    throw invalid(error instanceof Error ? `Could not parse PDF: ${error.message}` : "Could not parse PDF");
  } finally { signal?.removeEventListener("abort", abort); await task.destroy(); }
}
