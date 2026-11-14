import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaimEvidenceLink, FileContentResponse, PaperClaim, PaperProject } from "@fastwrite/shared";
import { createApplication } from "../app";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fastwrite-claim-http-"));
  roots.push(root);
  const app = await createApplication(root);
  const request = async <T>(path: string, method = "GET", body?: unknown, status = 200): Promise<T> => {
    const response = await app(new Request(`http://fastwrite.test/api${path}`, {
      method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }));
    expect(response.status).toBe(status);
    return status === 204 ? undefined as T : response.json() as Promise<T>;
  };
  const save = async (projectId: string, content: string) => {
    const path = `/projects/${projectId}/file?path=main.tex`;
    const opened = await request<FileContentResponse>(path);
    await request(path, "PUT", { content, baseVersion: opened.file.version });
  };
  return { request, save };
}

test("HTTP file rename preserves another project's supported workspace evidence", async () => {
  const { request, save } = await fixture();
  const projects: PaperProject[] = [];
  for (const name of ["A", "B"]) {
    const project = await request<PaperProject>("/projects", "POST", { name }, 201);
    projects.push(project);
    await save(project.id, "The evaluated result improves accuracy by 10%.");
    const [claim] = await request<PaperClaim[]>(`/projects/${project.id}/claim-scans`, "POST", undefined, 201);
    await request(`/projects/${project.id}/claims/${claim!.id}/links`, "POST", { kind: "workspace", path: "main.tex", anchor: claim!.anchor }, 201);
    await request(`/projects/${project.id}/claims/${claim!.id}`, "PATCH", { reviewStatus: "supported" });
  }
  const [a, b] = projects;
  const before = await request<PaperClaim[]>(`/projects/${b!.id}/claims`);
  const links = await request<ClaimEvidenceLink[]>(`/projects/${b!.id}/claim-links`);
  await request(`/projects/${a!.id}/files`, "PATCH", { from: "main.tex", to: "renamed.tex" }, 204);
  expect(await request<ClaimEvidenceLink[]>(`/projects/${b!.id}/claim-links`)).toEqual(links);
  expect(await request<PaperClaim[]>(`/projects/${b!.id}/claims`)).toEqual(before);
  expect(await request<PaperClaim[]>(`/projects/${a!.id}/claims`)).toMatchObject([
    { anchor: { path: "renamed.tex" }, reviewStatus: "supported" }
  ]);
});

test("HTTP scan and save keep decimal anchors and current reanchored semantics", async () => {
  const { request, save } = await fixture();
  const project = await request<PaperProject>("/projects", "POST", { name: "Claim semantics" }, 201);
  const base = `/projects/${project.id}`;
  const prefix = "\\section{Results}\nContext before the measured statement.\n";
  const suffix = "\nContext after the measured statement.\n\\end{document}\n";
  const original = "The evaluated result improves accuracy by 10.5%.";
  await save(project.id, prefix + original + suffix);
  const [claim] = await request<PaperClaim[]>(`${base}/claim-scans`, "POST", undefined, 201);
  expect(claim).toMatchObject({ anchor: { exactText: original }, numbers: [{ normalized: 10.5, unit: "%" }] });
  const link = await request<ClaimEvidenceLink>(`${base}/claims/${claim!.id}/links`, "POST", {
    kind: "review-waiver", approvedByUser: true, reason: "Checked original measurements"
  }, 201);
  await request(`${base}/claims/${claim!.id}`, "PATCH", { reviewStatus: "supported" });
  const text = "This limitation shows no accuracy benefit \\cite{paper}.";
  const content = prefix + text + suffix;
  await save(project.id, content);
  const updated = await request<PaperClaim[]>(`${base}/claims`);
  expect(updated).toHaveLength(1);
  expect(updated[0]).toMatchObject({ id: claim!.id, createdAt: claim!.createdAt, createdBy: claim!.createdBy,
    anchor: { exactText: text }, normalizedText: text, type: "limitation", surface: "citation",
    anchorStatus: "reanchored", reviewStatus: "needs-review" });
  expect(updated[0]!.numbers).toBeUndefined();
  expect(content.slice(updated[0]!.anchor.startOffset, updated[0]!.anchor.endOffset)).toBe(text);
  expect(await request<PaperClaim[]>(`${base}/claims`)).toEqual(updated);
  const rescanned = await request<PaperClaim[]>(`${base}/claim-scans`, "POST", undefined, 201);
  expect(rescanned.map(({ updatedAt, ...item }) => item)).toEqual(updated.map(({ updatedAt, ...item }) => item));
  expect(await request<ClaimEvidenceLink[]>(`${base}/claim-links`)).toEqual([link]);
});
