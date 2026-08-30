import { describe, expect, test } from "bun:test";
import { numericConsistency, writingGuard } from "./writing-guard";

describe("writing guard", () => {
  test("detects unresolved citations and references", () => {
    const findings = writingGuard({ path: "main.tex", content: "See \\cite{missing}. \\ref{fig:x}", approvedCitationKeys: new Set() });
    expect(findings.some((item) => item.source === "citation" && item.status === "blocking")).toBe(true);
    expect(findings.some((item) => item.source === "structure" && item.status === "blocking")).toBe(true);
  });
  test("flags template residue", () => {
    expect(writingGuard({ path: "main.tex", content: "TODO: fill this" }).some((item) => item.status === "warning")).toBe(true);
  });
  test("detects conflicting metric percentages across files", () => {
    const findings = numericConsistency([{ path: "abstract.tex", content: "Accuracy: 90%" }, { path: "results.tex", content: "Accuracy: 80%" }]);
    expect(findings[0]?.status).toBe("blocking");
  });
  test("detects incorrect relative improvement arithmetic", () => {
    const findings = numericConsistency([{ path: "results.tex", content: "from 50% to 60%, relative improvement of 10%." }]);
    expect(findings.some((item) => item.source === "numeric" && item.status === "blocking")).toBe(true);
  });
});
