import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonDatabase } from "./database";
import { WorkspaceService } from "../workspace/workspace-service";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("project deletion removes only owned claim links and preserves shared research works", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fastwrite-cascade-"));
  directories.push(directory);
  const database = new JsonDatabase(directory);
  await database.initialize();
  const workspaces = new WorkspaceService(directory, database);
  await workspaces.initialize();
  const removed = await workspaces.createEmpty("Removed project");
  const surviving = await workspaces.createEmpty("Surviving project");
  const timestamp = new Date().toISOString();
  const anchor = { path: "main.tex", fileVersion: 1, startOffset: 0, endOffset: 30, exactText: "A sufficiently long audited claim.", prefix: "", suffix: "" };

  await database.mutate((state) => {
    state.paperClaims.push(
      { id: "claim_removed", projectId: removed.id, anchor, type: "result", reviewStatus: "detected", anchorStatus: "current", createdBy: "scanner", createdAt: timestamp, updatedAt: timestamp },
      { id: "claim_surviving", projectId: surviving.id, anchor, type: "result", reviewStatus: "detected", anchorStatus: "current", createdBy: "scanner", createdAt: timestamp, updatedAt: timestamp }
    );
    state.claimEvidenceLinks.push(
      { id: "link_removed", claimId: "claim_removed", kind: "review-waiver", reason: "audit", approvedByUser: true },
      { id: "link_surviving", claimId: "claim_surviving", kind: "review-waiver", reason: "audit", approvedByUser: true }
    );
    state.researchWorks.push({ id: "work_shared", title: "Shared work", authors: ["Auditor"], metadataStatus: "verified", publicationStatus: "unknown", createdAt: timestamp, updatedAt: timestamp });
    state.projectResearchWorks.push(
      { projectId: removed.id, workId: "work_shared", status: "saved", createdAt: timestamp, updatedAt: timestamp },
      { projectId: surviving.id, workId: "work_shared", status: "saved", createdAt: timestamp, updatedAt: timestamp }
    );
    state.researchIdentifiers.push({ workId: "work_shared", scheme: "doi", value: "10.0000/shared" });
  });

  await database.deleteProject(removed.id);
  const state = database.snapshot();
  expect(state.paperClaims.map((claim) => claim.id)).toEqual(["claim_surviving"]);
  expect(state.claimEvidenceLinks.map((link) => link.id)).toEqual(["link_surviving"]);
  expect(state.projectResearchWorks).toContainEqual(expect.objectContaining({ projectId: surviving.id, workId: "work_shared" }));
  expect(state.researchWorks.map((work) => work.id)).toContain("work_shared");
  expect(state.researchIdentifiers).toContainEqual({ workId: "work_shared", scheme: "doi", value: "10.0000/shared" });
});
