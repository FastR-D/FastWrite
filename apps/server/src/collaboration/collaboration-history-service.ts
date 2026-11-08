import { createHash } from "node:crypto";
import { normalizeWorkspacePath, type CollaborationCheckpoint, type CollaborationVersionPage } from "@fastwrite/shared";
import type { Principal } from "../auth/auth-service";
import type { AuthorizationService } from "../auth/authorization-service";
import type { JsonDatabase } from "../storage/database";
import type { WorkspaceService } from "../workspace/workspace-service";
import type { CollaborationService } from "./collaboration-service";
import { ApiError } from "../http";

export class CollaborationHistoryService {
  private readonly automaticSignatures = new Map<string, string>();
  constructor(private readonly database: JsonDatabase, private readonly workspaces: WorkspaceService, private readonly collaboration: CollaborationService, private readonly authorization: AuthorizationService) {}
  async list(projectId: string, principal: Principal, cursor?: string): Promise<CollaborationVersionPage> {
    this.authorization.requireProject(principal, projectId, "project:read");
    const page = await this.workspaces.historyPage(projectId, { limit: 50, ...(cursor ? { cursor } : {}) });
    const state = this.database.snapshot();
    return { ...page, commits: page.commits.map(commit => {
      const snapshot = state.collaborationCheckpoints.find(item => item.projectId === projectId && item.oid === commit.oid);
      return { ...commit, label: snapshot?.label ?? commit.message, authorName: state.users.find(item => item.id === snapshot?.createdByUserId)?.displayName ?? "FastWrite", annotationsAvailable: !!snapshot };
    }) };
  }
  async create(projectId: string, principal: Principal, label: string) {
    if (typeof label !== "string" || !label.trim() || label.trim().length > 120) throw new ApiError(400, "version_label_invalid", "版本名称需要包含 1–120 字符");
    this.authorization.requireProject(principal, projectId, "project:write");
    return this.collaboration.withProjectLock(projectId, async () => {
      await this.requirePaths(principal, projectId, await this.paths(projectId));
      await this.collaboration.flushProject(projectId);
      return this.capture(projectId, principal, label.trim());
    });
  }
  async preview(projectId: string, oid: string, principal: Principal) {
    this.authorization.requireProject(principal, projectId, "project:read");
    const changes = await this.workspaces.historyWorkingChanges(projectId, oid);
    const paths = new Set([...(await this.workspaces.historyTree(projectId, oid)).map(item => item.path), ...await this.paths(projectId)]);
    const files = changes.files.filter(file => [file.path, ...(file.oldPath ? [file.oldPath] : [])].every(path => this.authorization.projectPathDecision(principal, projectId, path, "project:read").allowed));
    return { ...changes, files, discussionVersion: this.discussionVersion(projectId), canRestoreAll: [...paths].every(path => this.authorization.projectPathDecision(principal, projectId, path, "project:write").allowed), annotationsAvailable: this.database.snapshot().collaborationCheckpoints.some(item => item.projectId === projectId && item.oid === changes.baseRef) };
  }
  async restore(projectId: string, oid: string, principal: Principal, input: { expectedVersion: number; expectedDiscussionVersion: string; paths?: string[] }) {
    this.authorization.requireProject(principal, projectId, "project:write");
    if (typeof input.expectedDiscussionVersion !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedDiscussionVersion) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 || (input.paths !== undefined && (!Array.isArray(input.paths) || !input.paths.length || input.paths.some(path => typeof path !== "string" || !normalizeWorkspacePath(path))))) throw new ApiError(400, "version_restore_invalid", "需要有效项目版本及文件范围");
    const tree = await this.workspaces.historyTree(projectId, oid);
    const canonicalOid = (await this.workspaces.historySummary(projectId, oid)).oid;
    const selected = input.paths ? [...new Set(input.paths.map(normalizeWorkspacePath))] : undefined;
    const paths = selected ?? [...new Set([...tree.map(item => item.path), ...await this.paths(projectId)])];
    await this.requirePaths(principal, projectId, paths);
    const snapshot = this.database.snapshot().collaborationCheckpoints.find(item => item.projectId === projectId && item.oid === canonicalOid);
    let safetyOid = "", restoredOid = "";
    const result = await this.collaboration.mutateWorkspace(projectId, async () => {
      if (this.workspaces.getProject(projectId).version !== input.expectedVersion) throw new ApiError(409, "version_conflict", "项目在确认后发生了更改，请刷新恢复预览");
      if (this.discussionVersion(projectId) !== input.expectedDiscussionVersion) throw new ApiError(409, "discussion_version_conflict", "评论或修订在确认后已更新，请刷新恢复预览");
      await this.requirePaths(principal, projectId, paths);
      safetyOid = (await this.capture(projectId, principal, "恢复前的自动副本")).oid;
      return selected ? this.workspaces.restoreHistoryFiles(projectId, canonicalOid, selected, input.expectedVersion) : this.workspaces.restoreProjectHistory(projectId, canonicalOid, input.expectedVersion, snapshot?.mainDocument);
    }, async () => {
      if (snapshot) await this.restoreAnnotations(snapshot, selected);
      await this.database.mutate(state => {
        for (const session of state.collaborationReviewSessions) if (session.projectId === projectId && (!selected || selected.includes(session.path))) session.closedAt ??= new Date().toISOString();
        state.auditEvents.push({ id: `audit_${crypto.randomUUID()}`, actorUserId: principal.user.id, action: "history.restore", resourceType: "project", resourceId: projectId, metadata: { oid: canonicalOid, safetyOid }, createdAt: new Date().toISOString() });
      });
      restoredOid = (await this.capture(projectId, principal, `恢复版本：${snapshot?.label ?? canonicalOid.slice(0, 8)}`)).oid;
    });
    return { ...result, safetyOid, restoredOid, annotationsRestored: !!snapshot };
  }
  async checkpointDueProjects() {
    const projectIds = new Set(this.database.snapshot().collaborationDocuments.filter(item => item.status === "active").map(item => item.projectId));
    for (const projectId of projectIds) await this.collaboration.withProjectLock(projectId, async () => {
      if (!this.database.snapshot().projects.some(item => item.id === projectId)) return;
      await this.collaboration.flushProject(projectId);
      const state = this.database.snapshot(), project = this.workspaces.getProject(projectId);
      const signature = `${project.version}:${this.discussionVersion(projectId)}`;
      if (this.automaticSignatures.get(projectId) === signature) return;
      const latest = state.collaborationCheckpoints.filter(item => item.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (!latest || latest.projectVersion !== project.version || latest.discussionVersion !== this.discussionVersion(projectId)) await this.capture(projectId, undefined, "自动保存");
      this.automaticSignatures.set(projectId, signature);
    });
  }
  private async capture(projectId: string, principal: Principal | undefined, label: string) {
    const oid = await this.workspaces.commitHistory(projectId, principal ? `Saved version: ${label}` : "Auto collaborative save", true);
    if (!oid) throw new ApiError(500, "version_save_failed", "无法保存项目版本");
    const state = this.database.snapshot();
    const threads = state.commentThreads.filter(item => item.projectId === projectId).map(thread => {
      if (thread.scope === "project") return { thread };
      const position = this.collaboration.absolutePositions(thread.documentId, thread.startRelativePosition, thread.endRelativePosition);
      const path = state.collaborationDocuments.find(item => item.id === thread.documentId)?.path ?? thread.path;
      return { thread: { ...thread, path }, ...(position.start !== undefined && position.end !== undefined ? { from: position.start, to: position.end } : {}) };
    });
    const ids = new Set(threads.map(item => item.thread.id));
    const snapshot: CollaborationCheckpoint = { projectId, oid, label, projectVersion: this.workspaces.getProject(projectId).version, discussionVersion: this.discussionVersion(projectId), mainDocument: this.workspaces.getProject(projectId).mainDocument, ...(principal ? { createdByUserId: principal.user.id } : {}), createdAt: new Date().toISOString(), threads, messages: state.commentMessages.filter(item => ids.has(item.threadId)), externalComments: state.shareComments.filter(item => item.projectId === projectId) };
    await this.database.mutate(current => { current.collaborationCheckpoints.push(snapshot); });
    return { oid, label, createdAt: snapshot.createdAt };
  }
  private async restoreAnnotations(snapshot: CollaborationCheckpoint, paths?: string[]) {
    const restored: CollaborationCheckpoint["threads"][number]["thread"][] = [];
    for (const item of snapshot.threads) {
      if (paths && (item.thread.scope === "project" || !paths.includes(item.thread.path))) continue;
      const thread = structuredClone(item.thread);
      if (thread.scope !== "project" && item.from !== undefined && item.to !== undefined) {
        const anchor = await this.collaboration.positions(snapshot.projectId, thread.path, item.from, item.to);
        Object.assign(thread, { documentId: anchor.documentId, startRelativePosition: anchor.start, endRelativePosition: anchor.end, fileVersion: anchor.fileVersion });
      }
      thread.updatedAt = new Date().toISOString(); restored.push(thread);
    }
    await this.database.mutate(state => {
      const removedIds = new Set(state.commentThreads.filter(item => item.projectId === snapshot.projectId && (!paths || item.scope !== "project" && paths.includes(item.path))).map(item => item.id));
      const restoredIds = new Set(restored.map(item => item.id));
      state.commentThreads = state.commentThreads.filter(item => !removedIds.has(item.id));
      state.commentThreads.push(...restored);
      state.commentMessages = state.commentMessages.filter(item => !removedIds.has(item.threadId));
      state.commentMessages.push(...snapshot.messages.filter(item => restoredIds.has(item.threadId)));
      state.shareComments = state.shareComments.filter(item => item.projectId !== snapshot.projectId || paths && !paths.includes(item.path));
      state.shareComments.push(...(snapshot.externalComments ?? []).filter(item => !paths || paths.includes(item.path)));
    });
  }
  private discussionVersion(projectId: string) {
    const state = this.database.snapshot();
    const threads = state.commentThreads.filter(item => item.projectId === projectId), ids = new Set(threads.map(item => item.id));
    return createHash("sha256").update(JSON.stringify([threads, state.commentMessages.filter(item => ids.has(item.threadId)), state.shareComments.filter(item => item.projectId === projectId)])).digest("hex");
  }
  private async paths(projectId: string): Promise<string[]> {
    const result: string[] = [];
    const visit = (nodes: Awaited<ReturnType<WorkspaceService["tree"]>>) => { for (const node of nodes) if (node.type === "file") result.push(node.path); else visit(node.children ?? []); };
    visit(await this.workspaces.tree(projectId)); return result;
  }
  private async requirePaths(principal: Principal, projectId: string, paths: string[]) { for (const path of paths) this.authorization.requireProjectPath(principal, projectId, path, "project:write"); }
}
