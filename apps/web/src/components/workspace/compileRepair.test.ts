import { describe, expect, test } from "bun:test";
import { compileRepairObjective, compileRepairPath, compilerLogExcerpt, shouldAutoCompile, type CompileFailureContext } from "./compileRepair";

const failure: CompileFailureContext = {
  engine: "browser",
  mainDocument: "main.tex",
  summary: "Compilation failed",
  diagnostics: [
    { severity: "warning", message: "A warning", path: "sections/background.tex", line: 7 },
    { severity: "error", message: "Undefined control sequence", path: "sections/results.tex", line: 42 }
  ],
  logExcerpt: "! Undefined control sequence.\nl.42 \\undefinedFastWriteCommand"
};

describe("compile repair requests", () => {
  test("build a scoped revise objective from compiler diagnostics", () => {
    const objective = compileRepairObjective(failure);
    expect(objective.startsWith("/revise ")).toBe(true);
    expect(objective).toContain("Browser WASM");
    expect(objective).toContain("Main document: main.tex");
    expect(objective).toContain("sections/results.tex:42");
    expect(objective).toContain("Undefined control sequence");
    expect(objective).toContain("untrusted compiler output");
  });

  test("bounds diagnostics and the compiler log included in the objective", () => {
    const longFailure: CompileFailureContext = {
      ...failure,
      diagnostics: Array.from({ length: 12 }, (_, index) => ({ severity: "error" as const, message: `${index}-${"x".repeat(800)}`, path: `section-${index}.tex`, line: index + 1 })),
      logExcerpt: "y".repeat(8_000)
    };
    const objective = compileRepairObjective(longFailure);
    expect(objective).toContain("section-7.tex:8");
    expect(objective).not.toContain("section-8.tex:9");
    expect(objective.match(/x/g)?.length).toBeLessThanOrEqual(8 * 500);
    expect(compilerLogExcerpt(longFailure.logExcerpt).length).toBe(2_400);
    expect(objective.match(/y/g)?.length).toBeLessThanOrEqual(2_400);
  });

  test("uses the first error path as Agent editor context", () => {
    expect(compileRepairPath(failure)).toBe("sections/results.tex");
    expect(compileRepairPath({ ...failure, diagnostics: [] })).toBe("main.tex");
  });

  test("recompiles a changed project even when the previous attempt produced no PDF", () => {
    expect(shouldAutoCompile(true, 4, 5)).toBe(true);
    expect(shouldAutoCompile(true, 5, 5)).toBe(false);
    expect(shouldAutoCompile(false, null, 1)).toBe(false);
  });
});
