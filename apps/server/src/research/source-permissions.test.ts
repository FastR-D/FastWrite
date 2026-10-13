import { expect, test } from "bun:test";
import { projectAccessFixture } from "../test-support/project-access";

test("citation context filters restricted sources and BibTeX proposals authorize their target before reading it", async () => {
  const { json, request, owner, member, base, deny, cleanup } = await projectAccessFixture();
  try {
    for (const [path, content] of [
      ["private/notes.tex", "PRIVATE_TEX_MARKER \\cite{sample}"],
      ["private/refs.bib", "@article{sample, title={PRIVATE_BIB_MARKER}}"],
      ["public.tex", "PUBLIC_MARKER \\cite{sample}"]
    ]) await json(base + "/files", owner.token, "POST", { path, content });
    const work = await json(base + "/research-works/import", member.token, "POST", { title: "Public paper", citationKey: "publickey" });
    for (const action of ["read", "edit", "run_ai"]) {
      const rule = await deny("private", action);
      if (action === "read") {
        expect((await request(base + "/file?path=private/notes.tex", member.token)).status).toBe(403);
        const context = await json(base + "/research-citations/sample", member.token);
        expect(context.contexts.map((item: any) => item.path)).toEqual(["public.tex"]);
        expect(JSON.stringify(context)).not.toContain("PRIVATE_");
        expect(JSON.stringify(await json(base + "/research-citations/sample", owner.token))).toContain("PRIVATE_BIB_MARKER");
      }
      expect((await request(base + "/research-works/" + work.id + "/bibtex-changes", member.token, "POST", { targetBibPath: "private/refs.bib" })).status).toBe(403);
      expect((await request(base + "/research-works/" + work.id + "/bibtex-changes", member.token, "POST", { targetBibPath: "private/new.bib" })).status).toBe(403);
      expect((await request(base + "/acl/" + rule.id, owner.token, "DELETE")).status).toBe(204);
    }
    const proposal = await json(base + "/research-works/" + work.id + "/bibtex-changes", member.token, "POST", { targetBibPath: "private/refs.bib" });
    expect(proposal.changes[0].baseContent).toContain("PRIVATE_BIB_MARKER");
    expect((await json(base + "/change-sets/" + proposal.id, member.token)).id).toBe(proposal.id);
  } finally { await cleanup(); }
});
