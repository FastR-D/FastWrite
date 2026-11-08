import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as Y from "yjs";
import type { CollaborationReviewSessionView, CommentThreadView } from "@fastwrite/shared";
import { createApplication } from "../app";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(latexCompiler?: import("../app").ApplicationOptions["latexCompiler"]) {
  const directory = await mkdtemp(join(tmpdir(), "fastwrite-team-writing-")); directories.push(directory);
  const app = await createApplication(directory, { ...(latexCompiler ? { latexCompiler } : {}), features: { serverAuth: true }, bootstrapAdmin: { email: "admin@example.test", password: "test-admin-password-for-collaboration" } });
  const request = async (path: string, token?: string, method = "GET", body?: unknown) => app(new Request(`http://test${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const register = async (name: string) => (await (await request("/api/auth/register", undefined, "POST", { email: `${name}@example.test`, password: "collaboration-testing-password", displayName: name })).json()) as { token: string; user: { id: string } };
  const owner = await register("Owner"), reviewer = await register("Reviewer"), viewer = await register("Viewer");
  const project = await (await request("/api/projects", owner.token, "POST", { name: "Collaborative paper" })).json() as { id: string };
  const root = `/api/projects/${project.id}`;
  for (const [account, role, email] of [[reviewer, "commenter", "Reviewer"], [viewer, "viewer", "Viewer"]] as const) {
    const invitation = await (await request(`${root}/invitations`, owner.token, "POST", { email: `${email}@example.test`, role })).json() as { token: string };
    expect((await request(`/api/invitations/${invitation.token}/accept`, account.token, "POST")).status).toBe(200);
  }
  const read = async () => ((await (await request(`${root}/file?path=main.tex`, owner.token)).json()) as { content: string }).content;
  const edit = async (change: (text: Y.Text) => void) => {
    const initial = await (await request(`${root}/collaboration?path=main.tex`, owner.token)).json() as { update: string; documentId: string };
    const doc = new Y.Doc(); Y.applyUpdate(doc, Buffer.from(initial.update, "base64")); change(doc.getText("content"));
    const result = await request(`${root}/collaboration/persist`, owner.token, "POST", { path: "main.tex", documentId: initial.documentId, update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64") });
    expect(result.status).toBe(200); doc.destroy();
  };
  const create = async (replacement?: string, body = "Please improve this passage.") => {
    const content = await read(), from = content.indexOf("Introduction"); expect(from).toBeGreaterThan(0);
    return request(`${root}/comments`, reviewer.token, "POST", { path: "main.tex", from, to: from + 12, quote: "Introduction", body, ...(replacement === undefined ? {} : { replacement }) });
  };
  const list = async () => await (await request(`${root}/comments`, owner.token)).json() as CommentThreadView[];
  return { app, request, owner, reviewer, viewer, root, read, edit, create, list };
}

describe("collaborative paper review", () => {
  test("reviewers propose, writers decide once, and concurrent edits outside the selection survive", async () => {
    const f = await fixture();
    const response = await f.create("Background"); expect(response.status).toBe(201);
    const thread = await response.json() as CommentThreadView;
    expect(thread).toMatchObject({ canComment: true, canEdit: false, suggestion: { status: "pending" }, messages: [{ authorName: "Reviewer" }] });
    expect((await f.request(`${f.root}/comments/${thread.id}/decision`, f.reviewer.token, "POST", { decision: "accepted" })).status).toBe(403);
    await f.edit(text => text.insert(0, "% concurrent collaborator\n"));
    const decisions = await Promise.all([1, 2].map(() => f.request(`${f.root}/comments/${thread.id}/decision`, f.owner.token, "POST", { decision: "accepted" })));
    expect(decisions.map(item => item.status).sort()).toEqual([200, 409]);
    expect(await f.read()).toContain("% concurrent collaborator"); expect(await f.read()).toContain("Background");
    expect((await f.list())[0]).toMatchObject({ status: "resolved", suggestion: { status: "accepted", decidedByUserId: f.owner.user.id } });
  });

  test("changed text blocks acceptance, can be reanchored, and rejection preserves the source", async () => {
    const f = await fixture();
    const thread = await (await f.create("Overview")).json() as CommentThreadView;
    await f.edit(text => { const from = text.toString().indexOf("Introduction"); text.insert(from + 5, " revised "); });
    expect((await f.list())[0]!.anchorStatus).toBe("changed");
    const source = await f.read();
    expect((await f.request(`${f.root}/comments/${thread.id}/decision`, f.owner.token, "POST", { decision: "accepted" })).status).toBe(409);
    expect(await f.read()).toBe(source);
    const from = source.indexOf("Intro revised duction"), quote = "Intro revised duction";
    expect(from).toBeGreaterThan(0);
    expect((await f.request(`${f.root}/comments/${thread.id}/reanchor`, f.reviewer.token, "POST", { path: "main.tex", from, to: from + quote.length, quote })).status).toBe(200);
    expect((await f.list())[0]!.anchorStatus).toBe("attached");
    expect((await f.request(`${f.root}/comments/${thread.id}/decision`, f.owner.token, "POST", { decision: "rejected" })).status).toBe(200);
    expect(await f.read()).toBe(source);
    expect((await f.request(`${f.root}/comments/${thread.id}/decision`, f.owner.token, "POST", { decision: "accepted" })).status).toBe(409);
  });

  test("comments retain authors, replies, resolved state and orphaned anchors without GET mutations", async () => {
    const f = await fixture();
    const thread = await (await f.create()).json() as CommentThreadView;
    expect((await f.request(`${f.root}/comments/${thread.id}/messages`, f.owner.token, "POST", { body: `Thanks @[Reviewer](${f.reviewer.user.id})` })).status).toBe(201);
    expect((await f.list())[0]!.messages.map(message => message.authorName)).toEqual(["Reviewer", "Owner"]);
    const notifications = await (await f.request("/api/notifications", f.reviewer.token)).json() as Array<{ title: string }>;
    expect(notifications.length).toBe(1);
    expect((await f.request(`${f.root}/comments/${thread.id}`, f.owner.token, "PATCH", { status: "resolved" })).status).toBe(200);
    await f.edit(text => { const from = text.toString().indexOf("Introduction"); text.delete(from, 12); });
    const orphaned = (await f.list())[0]!;
    expect(orphaned).toMatchObject({ status: "resolved", anchorStatus: "orphaned" });
    expect((await f.list())[0]!.updatedAt).toBe(orphaned.updatedAt);
    expect((await f.request(`${f.root}/comments`, f.viewer.token, "POST", { path: "main.tex", from: 0, to: 1, body: "No permission" })).status).toBe(403);
    const content = await f.read();
    expect((await f.request(`${f.root}/comments`, f.reviewer.token, "POST", { path: "main.tex", from: 0, to: 1, quote: "incorrect", body: "Stale selection" })).status).toBe(409);
    expect((await f.request(`${f.root}/comments`, f.reviewer.token, "POST", { path: "main.tex", from: 0, to: 1, quote: content.slice(0, 1), body: { invalid: true } })).status).toBe(400);
  });

  test("external saves update the same CRDT document and preserve unrelated comment anchors", async () => {
    const f = await fixture();
    const thread = await (await f.create()).json() as CommentThreadView;
    const before = await (await f.request(`${f.root}/collaboration?path=main.tex`, f.owner.token)).json() as { documentId: string };
    const file = await (await f.request(`${f.root}/file?path=main.tex`, f.owner.token)).json() as { content: string; file: { version: number } };
    const content = `% external approved edit\n${file.content}\n% second edit\n`;
    expect((await f.request(`${f.root}/file?path=main.tex`, f.owner.token, "PUT", { content, baseVersion: file.file.version })).status).toBe(200);
    const after = await (await f.request(`${f.root}/collaboration?path=main.tex`, f.owner.token)).json() as { documentId: string; update: string };
    expect(after.documentId).toBe(before.documentId);
    const doc = new Y.Doc(); Y.applyUpdate(doc, Buffer.from(after.update, "base64"));
    expect(doc.getText("content").toString()).toBe(content); doc.destroy();
    const anchored = (await f.list())[0]!;
    expect(anchored.id).toBe(thread.id); expect(anchored.anchorStatus).toBe("attached");
    expect(content.slice(anchored.from, anchored.to)).toBe("Introduction");
    await f.edit(text => text.insert(text.length, "\n% live edit after external save"));
    expect(await f.read()).toContain("live edit after external save");
  });

  test("external review feedback is visible in the project and obeys read/comment permissions", async () => {
    const f = await fixture();
    const share = await (await f.request(`${f.root}/shares`, f.owner.token, "POST", { permission: "comment" })).json() as { token: string };
    expect((await f.request(`/api/shared/${share.token}/comments`, undefined, "POST", { path: "main.tex", line: 4, author: "External reviewer", body: "Please explain the result." })).status).toBe(201);
    const feedback = await (await f.request(`${f.root}/shared-comments`, f.owner.token)).json() as Array<{ id: string; author: string; canComment: boolean; shareId?: string }>;
    expect(feedback).toMatchObject([{ author: "External reviewer", canComment: true }]);
    expect(feedback[0]!.shareId).toBeUndefined();
    expect((await f.request(`${f.root}/shared-comments/${feedback[0]!.id}`, f.viewer.token, "PATCH", { status: "resolved" })).status).toBe(403);
    expect((await f.request(`${f.root}/shared-comments/${feedback[0]!.id}`, f.owner.token, "PATCH", { status: "resolved" })).status).toBe(204);
    const publicView = await (await f.request(`/api/shared/${share.token}`)).json() as { comments: Array<{ status: string }> };
    expect(publicView.comments[0]!.status).toBe("resolved");
    expect((await f.request(`${f.root}/shared-comments`)).status).toBe(401);
  });

  test("native reviewing autosaves isolated tracked edits with stable identities and retries", async () => {
    const f = await fixture();
    expect((await f.request(`${f.root}/review-sessions`, f.viewer.token, "POST", { path: "main.tex" })).status).toBe(403);
    const started = await f.request(`${f.root}/review-sessions`, f.reviewer.token, "POST", { path: "main.tex" });
    expect(started.status).toBe(201); const session = await started.json() as CollaborationReviewSessionView;
    expect((await f.request(`${f.root}/review-sessions/${session.id}`, f.owner.token)).status).toBe(404);
    const original = await f.read(), content = original.replace("Introduction", "Background");
    const save = { draftContent: content, expectedRevision: 0, operationId: "autosave_1" };
    expect((await f.request(`${f.root}/review-sessions/${session.id}`, f.reviewer.token, "PUT", save)).status).toBe(200);
    const first = (await f.list())[0]!;
    expect(first).toMatchObject({ authorUserId: f.reviewer.user.id, review: { sessionId: session.id }, suggestion: { replacement: "Background", status: "pending" } });
    expect(await f.read()).toBe(original);
    expect((await f.request(`${f.root}/review-sessions/${session.id}`, f.reviewer.token, "PUT", save)).status).toBe(200);
    expect(await f.list()).toHaveLength(1);
    expect((await f.request(`${f.root}/review-sessions/${session.id}`, f.reviewer.token, "PUT", { draftContent: original.replace("Introduction", "Overview"), expectedRevision: 1, operationId: "autosave_2" })).status).toBe(200);
    expect((await f.list())[0]!.id).toBe(first.id);
    expect((await f.list())[0]!.suggestion!.replacement).toBe("Overview");
    expect((await f.request(`${f.root}/review-sessions/${session.id}`, f.reviewer.token, "PUT", { ...save, operationId: "stale_window" })).status).toBe(409);
  });

  test("tracked changes preserve concurrent writing, freeze decided drafts, and support withdrawal", async () => {
    const f = await fixture();
    const session = await (await f.request(`${f.root}/review-sessions`, f.reviewer.token, "POST", { path: "main.tex" })).json() as CollaborationReviewSessionView;
    const content = session.baseContent.replace("Introduction", "Background");
    expect((await f.request(`${f.root}/review-sessions/${session.id}`, f.reviewer.token, "PUT", { draftContent: content, expectedRevision: 0, operationId: "one" })).status).toBe(200);
    await f.edit(text => text.insert(0, "% author wrote concurrently\n"));
    const thread = (await f.list())[0]!;
    expect((await f.request(`${f.root}/comments/${thread.id}/decision`, f.owner.token, "POST", { decision: "accepted" })).status).toBe(200);
    expect(await f.read()).toContain("Background"); expect(await f.read()).toContain("author wrote concurrently");
    expect((await f.request(`${f.root}/review-sessions/${session.id}`, f.reviewer.token, "PUT", { draftContent: content + "new input", expectedRevision: 1, operationId: "late" })).status).toBe(409);
    const next = await (await f.request(`${f.root}/review-sessions`, f.reviewer.token, "POST", { path: "main.tex", previousId: session.id })).json() as CollaborationReviewSessionView;
    expect(next.id).not.toBe(session.id); expect(next.baseContent).toBe(await f.read());
    expect((await f.request(`${f.root}/review-sessions/${next.id}`, f.reviewer.token, "PUT", { draftContent: next.baseContent + "\nnew", expectedRevision: 0, operationId: "new" })).status).toBe(200);
    expect((await f.request(`${f.root}/review-sessions/${next.id}`, f.reviewer.token, "PUT", { draftContent: next.baseContent, expectedRevision: 1, operationId: "undo" })).status).toBe(200);
    expect((await f.list()).some(item => item.review?.sessionId === next.id && item.suggestion?.status === "withdrawn")).toBe(true);
    expect(await f.read()).toBe(next.baseContent);
  });

  test("named versions restore source files, project discussions and anchored review state", async () => {
    const f = await fixture();
    const thread = await (await f.create("Overview")).json() as CommentThreadView;
    expect((await f.request(`${f.root}/comments`, f.reviewer.token, "POST", { scope: "project", body: "Submission plan" })).status).toBe(201);
    expect((await f.request(`${f.root}/comments`, f.viewer.token, "POST", { scope: "project", body: "Forbidden" })).status).toBe(403);
    expect((await f.request(`${f.root}/files`, f.owner.token, "POST", { path: "figure.bin", content: "\u0000original-binary" })).status).toBe(201);
    const source = await f.read();
    const saved = await f.request(`${f.root}/checkpoints`, f.owner.token, "POST", { label: "First submission" });
    expect(saved.status).toBe(201); const version = await saved.json() as { oid: string };
    expect((await f.request(`${f.root}/comments/${thread.id}/decision`, f.owner.token, "POST", { decision: "accepted" })).status).toBe(200);
    expect((await f.request(`${f.root}/files`, f.owner.token, "POST", { path: "later.txt", content: "later source" })).status).toBe(201);
    expect((await f.request(`${f.root}/files?path=figure.bin`, f.owner.token, "DELETE")).status).toBe(204);
    expect((await f.app(new Request(`http://test${f.root}/assets?path=figure.bin`, { method: "PUT", headers: { authorization: `Bearer ${f.owner.token}`, "content-type": "application/octet-stream" }, body: new Uint8Array([0, 255, 1, 2, 3]) }))).status).toBe(201);
    expect((await f.request(`${f.root}/comments`, f.reviewer.token, "POST", { scope: "project", body: "Discussion after checkpoint" })).status).toBe(201);
    const preview = await (await f.request(`${f.root}/checkpoints/${version.oid}/preview`, f.owner.token)).json() as { projectVersion: number; discussionVersion: string };
    expect((await f.request(`${f.root}/checkpoints/${version.oid}/restore`, f.viewer.token, "POST", { expectedVersion: preview.projectVersion, expectedDiscussionVersion: preview.discussionVersion })).status).toBe(403);
    const restore = await f.request(`${f.root}/checkpoints/${version.oid}/restore`, f.owner.token, "POST", { expectedVersion: preview.projectVersion, expectedDiscussionVersion: preview.discussionVersion });
    expect(restore.status).toBe(200); expect(await restore.json()).toMatchObject({ removed: ["later.txt"], annotationsRestored: true, safetyOid: expect.any(String) });
    expect(await f.read()).toBe(source);
    const binary = await f.request(`${f.root}/asset?path=figure.bin`, f.owner.token);
    expect(await binary.text()).toBe("\u0000original-binary");
    const restored = await f.list();
    expect(restored.find(item => item.id === thread.id)).toMatchObject({ status: "open", anchorStatus: "attached", suggestion: { status: "pending" } });
    expect(restored.filter(item => item.scope === "project")).toHaveLength(1);
    const versions = await (await f.request(`${f.root}/checkpoints`, f.reviewer.token)).json() as { commits: Array<{ label: string; authorName: string }> };
    expect(versions.commits).toContainEqual(expect.objectContaining({ label: "First submission", authorName: "Owner" }));
    expect(versions.commits.some(item => item.label === "恢复前的自动副本")).toBe(true);
  });

  test("restore confirmation is invalidated by a new discussion even without source changes", async () => {
    const f = await fixture();
    const version = await (await f.request(`${f.root}/checkpoints`, f.owner.token, "POST", { label: "Before review" })).json() as { oid: string };
    const preview = await (await f.request(`${f.root}/checkpoints/${version.oid}/preview`, f.owner.token)).json() as { projectVersion: number; discussionVersion: string };
    expect((await f.request(`${f.root}/comments`, f.reviewer.token, "POST", { scope: "project", body: "New decision while confirming" })).status).toBe(201);
    const result = await f.request(`${f.root}/checkpoints/${version.oid}/restore`, f.owner.token, "POST", { expectedVersion: preview.projectVersion, expectedDiscussionVersion: preview.discussionVersion });
    expect(result.status).toBe(409);
    expect((await f.list()).some(item => item.messages[0]?.body === "New decision while confirming")).toBe(true);
  });

  test("automatic collaboration versions capture only changed shared state", async () => {
    const f = await fixture(); await f.create();
    await f.app.checkpointCollaborations();
    const first = await (await f.request(`${f.root}/checkpoints`, f.owner.token)).json() as { commits: Array<{ oid: string; label: string }> };
    expect(first.commits.some(item => item.label === "自动保存")).toBe(true);
    await f.app.checkpointCollaborations();
    const unchanged = await (await f.request(`${f.root}/checkpoints`, f.owner.token)).json() as { commits: unknown[] };
    expect(unchanged.commits).toHaveLength(first.commits.length);
    await f.request(`${f.root}/comments`, f.reviewer.token, "POST", { scope: "project", body: "New collaboration state" });
    await f.app.checkpointCollaborations();
    const changed = await (await f.request(`${f.root}/checkpoints`, f.owner.token)).json() as { commits: unknown[] };
    expect(changed.commits).toHaveLength(first.commits.length + 1);
  });

  test("shared compiled PDFs use read permission, recheck historical paths, and do not grant compilation", async () => {
    const f = await fixture({ compile: async () => ({ success: true, projectVersion: 1, snapshotId: "shared_snapshot", engine: "server", log: "safe compiler log", pdfBase64: Buffer.from("%PDF-mock").toString("base64"), workspacePaths: ["main.tex", "private.txt"] }) });
    await f.request(`${f.root}/files`, f.owner.token, "POST", { path: "private.txt", content: "private result" });
    const queued = await (await f.request(`${f.root}/compile`, f.owner.token, "POST")).json() as { id: string };
    for (let attempt = 0; attempt < 100; attempt++) { const job = await (await f.request(`/api/jobs/${queued.id}`, f.owner.token)).json() as { status: string }; if (job.status === "completed") break; await new Promise(resolve => setTimeout(resolve, 5)); }
    const preview = await f.request(`${f.root}/compiled-preview`, f.viewer.token);
    expect(preview.status).toBe(200); expect(await preview.json()).toMatchObject({ snapshotId: "shared_snapshot", pdfBase64: expect.any(String) });
    expect((await f.request(`${f.root}/compile`, f.viewer.token, "POST")).status).toBe(403);
    expect((await f.request(`${f.root}/compiled-preview`)).status).toBe(401);
    expect((await f.request(`${f.root}/acl/new`, f.owner.token, "PUT", { pathPrefix: "private.txt", subjectType: "user", subjectId: f.viewer.user.id, action: "read", effect: "deny" })).status).toBe(200);
    expect((await f.request(`${f.root}/compiled-preview`, f.viewer.token)).status).toBe(403);
    expect((await f.request(`${f.root}/compiled-preview?after=shared_snapshot`, f.viewer.token)).status).toBe(403);
  });

  test("share links validate expiry and preserve normalized labels and permissions", async () => {
    const f = await fixture();
    for (const expiresAt of ["not-a-date", "2000-01-01T00:00:00Z"]) expect((await f.request(`${f.root}/shares`, f.owner.token, "POST", { permission: "comment", expiresAt })).status).toBe(400);
    expect((await f.request(`${f.root}/shares`, f.owner.token, "POST", { permission: "editor" })).status).toBe(400);
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    const result = await f.request(`${f.root}/shares`, f.owner.token, "POST", { permission: "comment", label: " Guest review ", expiresAt });
    expect(result.status).toBe(201); expect(await result.json()).toMatchObject({ label: "Guest review", expiresAt, permission: "comment" });
  });

  test("live reviewing rebases independent accepted edits while preserving proposal identities and replies", async () => {
    const f = await fixture();
    const session = await (await f.request(`${f.root}/review-sessions`, f.reviewer.token, "POST", { path: "main.tex" })).json() as CollaborationReviewSessionView;
    const save = { draftContent: session.baseContent.replace("Introduction", "Overview"), expectedRevision: 0, operationId: "initial-proposal" };
    expect((await f.request(`${f.root}/review-sessions/${session.id}`, f.reviewer.token, "PUT", save)).status).toBe(200);
    const proposal = (await f.list())[0]!;
    await f.request(`${f.root}/comments/${proposal.id}/messages`, f.owner.token, "POST", { body: "I am reviewing this edit" });
    await f.edit(text => text.insert(0, "% accepted elsewhere\n"));
    const rebased = await (await f.request(`${f.root}/review-sessions/${session.id}`, f.reviewer.token)).json() as CollaborationReviewSessionView;
    expect(rebased.liveConflict).toBe(false); expect(rebased.baseContent).toBe(await f.read());
    expect(rebased.draftContent).toContain("accepted elsewhere"); expect(rebased.draftContent).toContain("Overview");
    const preserved = (await f.list()).find(item => item.id === proposal.id)!;
    expect(preserved.suggestion?.status).toBe("pending"); expect(preserved.messages).toHaveLength(2); expect(preserved.anchorStatus).toBe("attached");
    const retry = await f.request(`${f.root}/review-sessions/${session.id}`, f.reviewer.token, "PUT", save);
    expect(retry.status).toBe(200); expect((await retry.json() as CollaborationReviewSessionView).draftContent).toBe(rebased.draftContent);
  });

  test("live reviewing keeps overlapping proposals explicit and blocks stale acceptance", async () => {
    const f = await fixture();
    const session = await (await f.request(`${f.root}/review-sessions`, f.reviewer.token, "POST", { path: "main.tex" })).json() as CollaborationReviewSessionView;
    await f.request(`${f.root}/review-sessions/${session.id}`, f.reviewer.token, "PUT", { draftContent: session.baseContent.replace("Introduction", "Overview"), expectedRevision: 0, operationId: "ours" });
    await f.edit(text => { const from = text.toString().indexOf("Introduction"); text.insert(from + 5, " revised "); });
    const refresh = await (await f.request(`${f.root}/review-sessions/${session.id}`, f.reviewer.token)).json() as CollaborationReviewSessionView;
    expect(refresh.liveConflict).toBe(true); expect(refresh.draftContent).toContain("Overview");
    const proposal = (await f.list())[0]!;
    expect(proposal.anchorStatus).toBe("changed");
    expect((await f.request(`${f.root}/comments/${proposal.id}/decision`, f.owner.token, "POST", { decision: "accepted" })).status).toBe(409);
    expect(await f.read()).toContain("revised");
  });

  test("ownership transfer assigns one owner and preserves only editing rights for the previous owner", async () => {
    const f = await fixture();
    const result = await f.request(`${f.root}/transfer`, f.owner.token, "POST", { personalOwnerUserId: f.reviewer.user.id });
    expect(result.status).toBe(200);
    expect(await (await f.request(`${f.root}/access?path=main.tex`, f.owner.token)).json()).toMatchObject({ role: "editor", canWrite: true, canManage: false, canInvite: false });
    expect(await (await f.request(`${f.root}/access?path=main.tex`, f.reviewer.token)).json()).toMatchObject({ role: "owner", canManage: true });
    expect((await f.request(`${f.root}/shares`, f.owner.token, "POST", { permission: "read" })).status).toBe(403);
    expect((await f.request(`${f.root}/members/${f.owner.user.id}`, f.reviewer.token, "PATCH", { role: "viewer" })).status).toBe(200);
  });

  test("presence is authenticated, permits read-only collaborators, and cannot be impersonated", async () => {
    const f = await fixture();
    const capability = await (await f.request(`${f.root}/access?path=main.tex`, f.reviewer.token)).json();
    expect(capability).toMatchObject({ role: "commenter", canWrite: false, canComment: true, realtime: true });
    const presence = await f.request(`${f.root}/collaboration/presence`, f.viewer.token, "POST", { clientId: "viewer-tab", path: "main.tex", name: "Fake Owner", color: "red", line: 8 });
    expect(presence.status).toBe(200);
    expect(await presence.json()).toMatchObject([{ name: "Viewer", userId: f.viewer.user.id, line: 8 }]);
    expect((await f.request(`${f.root}/collaboration/presence`, f.owner.token, "POST", { clientId: "viewer-tab", path: "main.tex" })).status).toBe(409);
    expect((await f.request(`${f.root}/collaboration/presence`, undefined)).status).toBe(401);
    const grant = await (await f.request("/api/collaboration/tokens", f.viewer.token, "POST", { projectId: f.root.split("/").at(-1), path: "main.tex" })).json() as { scope: string };
    expect(grant.scope).toBe("read");
    expect((await f.request(`${f.root}/collaboration/presence/viewer-tab`, f.viewer.token, "DELETE")).status).toBe(204);
    expect(await (await f.request(`${f.root}/collaboration/presence`, f.owner.token)).json()).toEqual([]);
  });
});
