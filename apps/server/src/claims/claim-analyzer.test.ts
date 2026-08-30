import { describe, expect, test } from "bun:test";
import { analyzeClaims } from "./claim-analyzer";

describe("claim analyzer", () => {
  test("extracts semantic, surface and numeric anchors", () => {
    const claims = analyzeClaims({ projectId: "p", path: "results.tex", fileVersion: 4, content: "Our method improves accuracy by 12%.\\n\\caption{Accuracy comparison}\\nA & value\\\\\\nSee \\ref{tab:main} and \\cite{paper}." });
    expect(claims.some((claim) => claim.surface === "caption")).toBe(true);
    expect(claims.some((claim) => claim.surface === "artifact-reference")).toBe(true);
    expect(claims.some((claim) => claim.surface === "citation")).toBe(true);
    expect(claims.every((claim) => claim.anchor.fileVersion === 4)).toBe(true);
  });
});
