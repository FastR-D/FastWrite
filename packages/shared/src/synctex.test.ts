import { describe, expect, test } from "bun:test";
import { parseSyncTex, pdfToSource, sourceToPdf } from "./synctex";

const fixture = `SyncTeX Version:1
Input:1:/document.tex
Input:2:/workspace/sections/method.tex
Input:3:/texlive/article.cls
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
h1,8:6553600,13107200:13107200,786432,0
h2,42:6553600,19660800:19660800,983040,0
}`;

describe("SyncTeX mapping", () => {
  test("maps the compiler document alias and ignores external package files", () => {
    const parsed = parseSyncTex(fixture, { mainDocument: "main.tex", workspacePaths: ["main.tex", "sections/method.tex"] });
    expect([...parsed.inputs.values()]).toEqual(["main.tex", "sections/method.tex"]);
    expect(sourceToPdf(parsed, "sections/method.tex", 42)).toEqual({ page: 1, x: 100, y: 300, width: 300, height: 15 });
    expect(pdfToSource(parsed, 1, 101, 302)).toEqual({ path: "sections/method.tex", line: 42 });
  });

  test("uses the nearest mapped source line when an exact line has no box", () => {
    const parsed = parseSyncTex(fixture, { mainDocument: "main.tex", workspacePaths: ["main.tex", "sections/method.tex"] });
    expect(sourceToPdf(parsed, "main.tex", 10)?.y).toBe(200);
    expect(sourceToPdf(parsed, "missing.tex", 1)).toBeNull();
  });
});
