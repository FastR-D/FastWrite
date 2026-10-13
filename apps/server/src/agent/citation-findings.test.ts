import { describe, expect, test } from "bun:test";
import { citationKeys, citationFindings, normalizePlaceholderFindings } from "./citation-findings";
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

test("natbib citation forms, starred commands and spaced optional arguments retain key identity",()=>{
 const content=String.raw`\citeauthor* {AuthorKey} \citeyearpar{YearKey} \Citealp [see] [p. 3] {MixedCase, Other} \citenum{NumberKey} \nocite{HiddenKey}`;
 const findings=citationFindings(content,new Set(["MixedCase"]));
 expect(findings.map(item=>item.referenceId)).toEqual(["AuthorKey","YearKey","MixedCase","Other","NumberKey","HiddenKey"]);
 expect(findings.find(item=>item.referenceId==="MixedCase")?.status).toBe("pass");
 expect(findings.filter(item=>item.status==="blocking")).toHaveLength(5);
});

test("commented citations neither authorize keys nor generate blocking findings",()=>{
 const text=String.raw`% \cite{commented}
Visible \cite{active}. % \citeauthor{hidden}
Escaped \% followed by \cite{afterPercent}.
\cite% continued command
{continued}`;
 expect(citationKeys(text)).toEqual(["active","afterPercent","continued"]);
 expect(citationFindings(text,new Set(["active","afterPercent","continued"])).every(item=>item.status==="pass")).toBe(true);
});
