import { describe, expect, test } from "bun:test";
import { parseLatexDiagnostics } from "./latex-diagnostics";

describe("parseLatexDiagnostics", () => {
  test("extracts file-line errors and LaTeX warnings", () => {
    const result = parseLatexDiagnostics(`document.tex:14: LaTeX Error: Undefined control sequence.
LaTeX Warning: Citation 'missing' undefined on input line 21.
Overfull \\hbox (8.0pt too wide) in paragraph at lines 30--31`, ["main.tex"], "main.tex");
    expect(result).toMatchObject([
      { severity: "error", path: "main.tex", line: 14, message: "Undefined control sequence." },
      { severity: "warning", path: "main.tex", line: 21 },
      { severity: "warning", path: "main.tex", line: 30 }
    ]);
  });

  test("joins TeX bang errors with their following source line", () => {
    const result = parseLatexDiagnostics("! LaTeX Error: File `missing.sty' not found.\nl.7 \\usepackage{missing}", ["main.tex"], "main.tex");
    expect(result[0]).toMatchObject({ severity: "error", path: "main.tex", line: 7, message: "File `missing.sty' not found." });
  });

  test("parses diagnostics prefixed by the WASM worker", () => {
    const result = parseLatexDiagnostics("[TeX] ! LaTeX Error: File `enumitem.sty' not found.\n[TeX] ! Emergency stop.\n[TeX] l.25 \\usepackage{enumitem}", ["main.tex"], "main.tex");
    expect(result[0]).toMatchObject({ severity: "error", path: "main.tex" });
    expect(result[0]?.message).toContain("enumitem.sty");
    expect(result[1]).toMatchObject({ severity: "error", path: "main.tex", line: 25, message: "Emergency stop." });
  });
});
