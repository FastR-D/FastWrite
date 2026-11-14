import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonDatabase } from "../storage/database";
import { WorkspaceService } from "../workspace/workspace-service";
import { ClaimService } from "./claim-service";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fastwrite-claims-"));
  roots.push(root);
  const database = new JsonDatabase(root);
  await database.initialize();
  const workspaces = new WorkspaceService(root, database);
  await workspaces.initialize();
  const claims = new ClaimService(database, workspaces);
  const save = async (projectId: string, path: string, content: string) => {
    const opened = await workspaces.readTextFile(projectId, path);
    await workspaces.saveTextFile(projectId, path, { content, baseVersion: opened.file.version });
  };
  const persisted = async () => {
    const reopened = new JsonDatabase(root);
    await reopened.initialize();
    return reopened.snapshot();
  };
  return { database, workspaces, claims, save, persisted };
}

for (const source of ["results.tex", "results"]) {
  test(`rename ${source} scopes evidence by all project claims and preserves the other project`, async () => {
    const { database, workspaces, claims, save, persisted } = await fixture();
    const a = await workspaces.createEmpty("A");
    const b = await workspaces.createEmpty("B");
    const evidencePath = source === "results" ? "results/data.tex" : source;
    const untouchedPath = source === "results" ? "results.bak/data.tex" : "results.tex.bak.tex";
    for (const project of [a, b]) {
      await save(project.id, "main.tex", "The evaluated result improves accuracy by 10%.");
      await workspaces.createFile(project.id, evidencePath, "The experiment shows reliable evidence.");
      await workspaces.createFile(project.id, untouchedPath, "Unchanged evidence outside the renamed path.");
      const scanned = await claims.scan(project.id);
      const main = scanned.find((claim) => claim.anchor.path === "main.tex")!;
      const evidence = scanned.find((claim) => claim.anchor.path === evidencePath)!;
      await claims.link(project.id, main.id, { kind: "workspace", path: evidencePath, anchor: evidence.anchor });
      await claims.update(project.id, main.id, { reviewStatus: "supported" });
      const opened = await workspaces.readTextFile(project.id, untouchedPath);
      await claims.link(project.id, evidence.id, { kind: "workspace", path: untouchedPath, anchor: {
        path: untouchedPath, fileVersion: opened.file.version, startOffset: 0, endOffset: opened.content.length,
        exactText: opened.content, prefix: "", suffix: ""
      } });
    }
    const before = database.snapshot();
    const bClaims = before.paperClaims.filter((claim) => claim.projectId === b.id);
    const bLinks = claims.links(b.id);
    const aLinks = claims.links(a.id);
    // WorkspaceService currently accepts only file renames; exercise the claims
    // directory-prefix contract against a real disk move without changing it.
    if (source === "results") await rename(join(workspaces.workspaceRoot(a.id), source), join(workspaces.workspaceRoot(a.id), "renamed.tex"));
    else await workspaces.renamePath(a.id, source, "renamed.tex");
    await claims.renamePath(a.id, source, "renamed.tex");
    expect(claims.links(b.id)).toEqual(bLinks);
    expect(await claims.list(b.id)).toEqual(bClaims);
    const after = await persisted();
    expect(after.paperClaims.filter((claim) => claim.projectId === b.id)).toEqual(bClaims);
    expect(after.claimEvidenceLinks.filter((link) => bLinks.some((previous) => previous.id === link.id))).toEqual(bLinks);
    const own = after.paperClaims.filter((claim) => claim.projectId === a.id);
    expect(own.find((claim) => claim.anchor.exactText === "The experiment shows reliable evidence.")!.anchor.path)
      .toBe(`renamed.tex${evidencePath.slice(source.length)}`);
    expect(own.find((claim) => claim.anchor.path === "main.tex")!.reviewStatus).toBe("supported");
    expect(claims.links(a.id)).toEqual(aLinks.map((link) => link.kind === "workspace" && link.path === evidencePath
      ? { ...link, path: `renamed.tex${evidencePath.slice(source.length)}`, anchor: { ...link.anchor, path: `renamed.tex${evidencePath.slice(source.length)}` } }
      : link));
  });
}

test("scan keeps decimal sentences, original offsets, and linked identity on rescan", async () => {
  const { workspaces, claims, save, persisted } = await fixture();
  const project = await workspaces.createEmpty("Decimals");
  const sentences = [
    "The evaluated result improves accuracy by 10.5%.",
    "The evaluated result reduces latency by -2.75 ms!",
    "The evaluated result improves accuracy by 3.25\\%?"
  ];
  const content = `\\section{Results}\n  ${sentences[0]}  ${sentences[1]}\n\t${sentences[2]}\nThis result improves without terminal punctuation`;
  await save(project.id, "main.tex", content);
  const scanned = await claims.scan(project.id);
  expect(scanned.map((claim) => claim.anchor.exactText)).toEqual(sentences);
  expect(scanned.map((claim) => claim.numbers)).toEqual([
    [{ raw: "10.5%", normalized: 10.5, unit: "%" }],
    [{ raw: "-2.75 ms", normalized: -2.75, unit: "ms" }],
    [{ raw: "3.25", normalized: 3.25 }]
  ]);
  for (const claim of scanned) {
    expect(content.slice(claim.anchor.startOffset, claim.anchor.endOffset)).toBe(claim.anchor.exactText);
    expect(claim.anchor.startOffset).toBe(content.indexOf(claim.anchor.exactText));
  }
  const link = await claims.link(project.id, scanned[0]!.id, { kind: "review-waiver", reason: "Checked original measurements", approvedByUser: true });
  expect((await claims.scan(project.id)).map((claim) => claim.id)).toEqual(scanned.map((claim) => claim.id));
  expect(claims.links(project.id)).toEqual([link]);
  expect((await persisted()).paperClaims).toEqual(await claims.list(project.id));
});

const original = "The evaluated result improves accuracy by 10%.";
const prefix = "\\section{Results}\nContext before the measured statement.\n";
const suffix = "\nContext after the measured statement.\n\\end{document}\n";
for (const scenario of [
  { text: "The evaluated result improves accuracy by 20%.", type: "result", surface: "number", numbers: [{ raw: "20%", normalized: 20, unit: "%" }] },
  { text: "The evaluated result improves accuracy without a percentage.", type: "result", surface: "text", numbers: undefined },
  { text: "This limitation shows no accuracy benefit.", type: "limitation", surface: "text", numbers: undefined },
  { text: "This limitation shows no accuracy benefit \\cite{paper}.", type: "limitation", surface: "citation", numbers: undefined },
  { text: "This limitation shows no accuracy benefit.", path: "caption.tex", type: "limitation", surface: "caption", numbers: undefined }
]) {
  test(`context reanchor synchronizes ${scenario.surface}/${scenario.type}: ${scenario.text}`, async () => {
    const { workspaces, claims, save, persisted } = await fixture();
    const path = scenario.path ?? "main.tex";
    const project = await workspaces.createEmpty("Reanchor", path);
    await save(project.id, path, prefix + original + suffix);
    const [before] = await claims.scan(project.id);
    expect(before!.anchor.exactText).toBe(original);
    const link = await claims.link(project.id, before!.id, { kind: "review-waiver", reason: "Checked original measurements", approvedByUser: true });
    await claims.update(project.id, before!.id, { reviewStatus: "supported" });
    const content = prefix + scenario.text + suffix;
    await save(project.id, path, content);
    const [updated] = await claims.list(project.id);
    expect(updated).toMatchObject({
      id: before!.id, createdAt: before!.createdAt, createdBy: before!.createdBy,
      anchor: { exactText: scenario.text, path }, anchorStatus: "reanchored", reviewStatus: "needs-review",
      type: scenario.type, surface: scenario.surface, normalizedText: scenario.text
    });
    expect(updated!.numbers).toEqual(scenario.numbers);
    expect(content.slice(updated!.anchor.startOffset, updated!.anchor.endOffset)).toBe(scenario.text);
    expect(await claims.list(project.id)).toEqual([updated!]);
    const rescanned = await claims.scan(project.id);
    expect(rescanned.map(({ updatedAt, ...claim }) => claim)).toEqual([updated!].map(({ updatedAt, ...claim }) => claim));
    expect(claims.links(project.id)).toEqual([link]);
    expect((await persisted()).paperClaims).toEqual(rescanned);
  });
}

test("moving exact text preserves supported review with valid waiver evidence", async () => {
  const { workspaces, claims, save } = await fixture();
  const project = await workspaces.createEmpty("Moved claim");
  await save(project.id, "main.tex", prefix + original + suffix);
  const [before] = await claims.scan(project.id);
  const link = await claims.link(project.id, before!.id, { kind: "review-waiver", reason: "Checked original measurements", approvedByUser: true });
  const supported = await claims.update(project.id, before!.id, { reviewStatus: "supported" });
  const content = "Additional context.\n" + prefix + original + suffix;
  await save(project.id, "main.tex", content);
  const [moved] = await claims.list(project.id);
  expect(moved).toEqual({ ...supported, anchor: {
    ...supported.anchor, fileVersion: supported.anchor.fileVersion + 1,
    startOffset: content.indexOf(original), endOffset: content.indexOf(original) + original.length,
    prefix: content.slice(content.indexOf(original) - 40, content.indexOf(original))
  }, anchorStatus: "reanchored", updatedAt: moved!.updatedAt });
  expect(claims.links(project.id)).toEqual([link]);
  expect(await claims.list(project.id)).toEqual([moved!]);
});
