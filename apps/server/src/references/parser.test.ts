import { describe, expect, test } from "bun:test";
import { zipSync, strToU8 } from "fflate";
import { parseReferencePdf, parseReferenceTex, readReferenceZip, referenceCandidates } from "./parser";
import { referencePdf } from "./fixtures";
const sources = (files: Record<string, string>) => new Map(Object.entries(files).map(([path, content]) => [path, strToU8(content)]));

describe("reference paper parsing", () => {
  test("expands nested and repeated TeX inputs in document order with section spans", () => {
    const files = sources({ "paper/main.tex": "\\documentclass{article}\n\\begin{document}\n\\section{Introduction}\nMotivation.\\input{sections/method}\n\\section{Results}\nResult only.\\input{shared}\n\\end{document}", "paper/sections/method.tex": "\\subsection{Method {details}}\nApproach only.\\input{../shared}\n", "paper/shared.tex": "Shared repeated prose." });
    const parsed = parseReferenceTex(files, "paper/main.tex");
    expect(parsed.sections.map(section => section.title)).toEqual(["Introduction", "Method details", "Results"]);
    expect(parsed.text.match(/Shared repeated prose/g)).toHaveLength(2);
    const intro = parsed.sections[0]!, method = parsed.sections[1]!, results = parsed.sections[2]!;
    expect(parsed.text.slice(intro.from, intro.to)).toContain("Approach only");
    expect(parsed.text.slice(method.from, method.to)).not.toContain("Result only");
    expect(parsed.text.slice(results.from, results.to)).not.toContain("Motivation");
    expect(parsed.blocks.find(block => block.text.includes("Approach only"))?.locator.path).toBe("paper/sections/method.tex");
    expect(parsed.text).not.toContain("documentclass");
  });
  test("reports missing inputs, cycles and out-of-root paths without running TeX", () => {
    const parsed = parseReferenceTex(sources({ "main.tex": "\\section{Start}\nText.\\input{loop}\\input{missing}\\input{../../escape}", "loop.tex": "Loop.\\input{main}" }), "main.tex");
    expect(parsed.warnings.join(" ")).toContain("cycle"); expect(parsed.warnings.join(" ")).toContain("Missing"); expect(parsed.warnings.join(" ")).toContain("outside archive");
  });
  test("ignores commented and verbatim includes and handles unbraced input", () => {
    const parsed = parseReferenceTex(sources({ "main.tex": "% \\input{missing}\n\\section{Intro}\n\\begin{verbatim}\\input{danger}\\end{verbatim}\n\\input child\n", "child.tex": "Visible child." }), "main.tex");
    expect(parsed.text).toContain("Visible child"); expect(parsed.warnings.join(" ")).not.toContain("Missing");
  });
  test("detects multiple TeX entry files and PDF-only ZIPs", () => {
    const files = readReferenceZip(zipSync({ "a.tex": strToU8("\\documentclass{article}"), "b.tex": strToU8("\\documentclass{article}") }));
    expect(referenceCandidates(files).candidates).toEqual(["a.tex", "b.tex"]);
    expect(referenceCandidates(readReferenceZip(zipSync({ "paper.pdf": referencePdf([["Introduction", "A synthetic example."]]) })))).toEqual({ kind: "pdf-zip", candidates: ["paper.pdf"] });
  });
  test("rejects path traversal, normalized duplicates, links and inflated size claims before expansion", () => {
    expect(() => readReferenceZip(zipSync({ "../escape.tex": strToU8("bad") }))).toThrow("paths");
    expect(() => readReferenceZip(zipSync({ "a.tex": strToU8("x"), "./a.tex": strToU8("y") }))).toThrow("duplicate");
    const archive = zipSync({ "a.tex": strToU8("safe") });
    const index = archive.findIndex((_, i) => archive[i] === 0x50 && archive[i + 1] === 0x4b && archive[i + 2] === 1 && archive[i + 3] === 2);
    const symlink = archive.slice(); new DataView(symlink.buffer).setUint32(index + 38, 0xa0000000, true);
    expect(() => readReferenceZip(symlink)).toThrow("special files");
    const inflated = archive.slice(); new DataView(inflated.buffer).setUint32(index + 24, 128 * 1024 * 1024, true);
    expect(() => readReferenceZip(inflated)).toThrow("expanded size");
  });
  test("preserves PDF page locators and text beyond evidence limits", async () => {
    const lines = Array.from({ length: 45 }, (_, index) => `Line ${index}: a complete example explaining paragraph organization and careful academic transitions.`);
    const parsed = await parseReferencePdf(referencePdf([["Introduction", ...lines], ["Conclusion", "END_OF_PAPER_MARKER"]]));
    expect(parsed.text.length).toBeGreaterThan(4000);
    expect(parsed.text).toContain("END_OF_PAPER_MARKER"); expect(parsed.pageCount).toBe(2);
    expect(parsed.sections.map(section => section.title)).toContain("Introduction");
    expect(parsed.blocks.at(-1)?.locator.page).toBe(2);
  });
  test("rejects invalid and image-only PDFs instead of presenting empty text as ready", async () => {
    expect(parseReferencePdf(strToU8("%PDF-not-valid"))).rejects.toMatchObject({ status: 422 });
    expect(parseReferencePdf(referencePdf([[]]))).rejects.toThrow("no extractable text");
  });
});
