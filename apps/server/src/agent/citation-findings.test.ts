import { describe, expect, test } from "bun:test";
import { citationFindings, normalizePlaceholderFindings } from "./citation-findings";
import type { ChangeSet } from "@fastwrite/shared";

describe("citation findings", () => {
  test("keeps real unapproved citations blocking while treating explicit placeholders as warnings", () => {
    expect(citationFindings("Claim \\cite{unknown}.", new Set())[0]?.status).toBe("blocking");
    expect(citationFindings("Claim \\cite{[EVIDENCE REQUIRED]}.", new Set())[0]?.status).toBe("warning");
    expect(citationFindings("Claim \\cite{approved}.", new Set(["approved"]))[0]?.status).toBe("pass");
  });

  test("repairs placeholder findings saved by older server versions", () => {
    const changeSet = { changes: [{ hunks: [{ findings: [{ id: "citation:[EVIDENCE REQUIRED]", source: "citation", referenceId: "[EVIDENCE REQUIRED]", status: "blocking", message: "old" }] }] }] } as ChangeSet;
    expect(normalizePlaceholderFindings(changeSet).changes[0]?.hunks?.[0]?.findings?.[0]?.status).toBe("warning");
  });
});
