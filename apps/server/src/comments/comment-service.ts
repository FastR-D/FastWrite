import { createHash } from "node:crypto";
import * as Y from "yjs";
import { buildReviewHunks } from "@fastwrite/shared";
import type { CollaborationReviewSession, CollaborationReviewSessionView, CommentThread, CommentThreadView } from "@fastwrite/shared";
import { ApiError } from "../http";
import type { DatabaseState, JsonDatabase } from "../storage/database";
import type { Principal } from "../auth/auth-service";
import { AuthorizationService } from "../auth/authorization-service";
import { CollaborationService } from "../collaboration/collaboration-service";
import { createNotification } from "../notifications/notification-service";

type CreateCommentInput = { path?: string; from?: number; to?: number; body: string; quote?: string; replacement?: string; scope?: "project" };
type ReanchorInput = { path: string; from: number; to: number; quote?: string };
export class CommentService {
  private readonly decisions = new Map<string, Promise<unknown>>();
  constructor(private readonly database: JsonDatabase, private readonly collaboration: CollaborationService, private readonly authorization: AuthorizationService) {}

  async list(projectId: string, principal: Principal): Promise<CommentThreadView[]> {
    this.authorization.requireProject(principal, projectId, "project:read");
    return this.database.snapshot().commentThreads.filter(thread => thread.projectId === projectId)
      .map(thread => this.view(thread, principal)).filter((thread): thread is CommentThreadView => !!thread)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  create(projectId: string, principal: Principal, input: CreateCommentInput) { return this.collaboration.withProjectLock(projectId, () => this.createNow(projectId, principal, input)); }
  private async createNow(projectId: string, principal: Principal, input: CreateCommentInput) {
    if (input.scope === "project") return this.createProjectDiscussion(projectId, principal, input.body);
    if (typeof input.path !== "string") throw new ApiError(400, "comment_anchor_invalid", "请选择评论位置");
    this.authorization.requireProjectPath(principal, projectId, input.path, "comment:write");
    const body = validateBody(input.body);
    if (input.replacement !== undefined && (typeof input.replacement !== "string" || input.replacement.length > 50_000)) throw new ApiError(400, "suggestion_invalid", "修改建议不能超过 50,000 字符");
    const anchor = await this.collaboration.positions(projectId, input.path, input.from!, input.to!);
    const quote = anchor.content.slice(input.from, input.to);
    if (input.quote !== undefined && input.quote !== quote) throw new ApiError(409, "comment_selection_changed", "选区已更改，请重新选择文本后提交");
    if (input.replacement !== undefined && input.replacement === quote) throw new ApiError(400, "suggestion_unchanged", "建议内容与原文相同");
    const now = new Date().toISOString();
    const thread: CommentThread = {
      id: `thread_${crypto.randomUUID()}`, projectId, documentId: anchor.documentId, path: input.path,
      startRelativePosition: anchor.start, endRelativePosition: anchor.end, quote,
      contextHash: digest(anchor.content, input.from!, input.to!), fileVersion: anchor.fileVersion,
      status: "open", authorUserId: principal.user.id, createdAt: now, updatedAt: now,
      ...(input.replacement !== undefined ? { suggestion: { replacement: input.replacement, status: "pending" as const } } : {})
    };
    await this.database.mutate(state => {
      const mentionedUserIds = this.mentions(state, projectId, input.path!, body);
      state.commentThreads.push(thread);
      state.commentMessages.push({ id: `comment_${crypto.randomUUID()}`, threadId: thread.id, authorUserId: principal.user.id, body, mentionedUserIds, createdAt: now, updatedAt: now });
      this.notify(state, mentionedUserIds, principal, thread, mentionedUserIds);
      audit(state, principal, thread, thread.suggestion ? "suggestion.create" : "comment.create");
    });
    return this.view(thread, principal)!;
  }

  private async createProjectDiscussion(projectId: string, principal: Principal, text: string) {
    this.authorization.requireProjectPath(principal, projectId, "", "comment:write");
    const body = validateBody(text), now = new Date().toISOString();
    const thread: CommentThread = { id: `thread_${crypto.randomUUID()}`, projectId, scope: "project", documentId: "", path: "", startRelativePosition: "", endRelativePosition: "", quote: "", contextHash: "", fileVersion: 0, status: "open", authorUserId: principal.user.id, createdAt: now, updatedAt: now };
    await this.database.mutate(state => {
      const mentionedUserIds = this.mentions(state, projectId, "", body);
      state.commentThreads.push(thread);
      state.commentMessages.push({ id: `comment_${crypto.randomUUID()}`, threadId: thread.id, authorUserId: principal.user.id, body, mentionedUserIds, createdAt: now, updatedAt: now });
      this.notify(state, mentionedUserIds, principal, thread, mentionedUserIds);
      audit(state, principal, thread, "discussion.create");
    });
    return this.view(thread, principal)!;
  }

  reply(projectId: string, threadId: string, principal: Principal, input: string) { return this.collaboration.withProjectLock(projectId, () => this.replyNow(projectId, threadId, principal, input)); }
  private async replyNow(projectId: string, threadId: string, principal: Principal, input: string) {
    const thread = this.requireThread(projectId, threadId, principal);
    this.authorization.requireProjectPath(principal, projectId, this.path(thread), "comment:write");
    const body = validateBody(input), now = new Date().toISOString();
    return this.database.mutate(state => {
      const mentionedUserIds = this.mentions(state, projectId, this.path(thread), body);
      const participants = state.commentMessages.filter(item => item.threadId === thread.id).map(item => item.authorUserId);
      const message = { id: `comment_${crypto.randomUUID()}`, threadId, authorUserId: principal.user.id, body, mentionedUserIds, createdAt: now, updatedAt: now };
      state.commentMessages.push(message);
      state.commentThreads.find(item => item.id === threadId)!.updatedAt = now;
      this.notify(state, [...new Set([...mentionedUserIds, ...participants])], principal, thread, mentionedUserIds);
      audit(state, principal, thread, "comment.reply");
      return message;
    });
  }

  updateStatus(projectId: string, threadId: string, principal: Principal, status: "open" | "resolved") { return this.collaboration.withProjectLock(projectId, () => this.updateStatusNow(projectId, threadId, principal, status)); }
  private async updateStatusNow(projectId: string, threadId: string, principal: Principal, status: "open" | "resolved") {
    const existing = this.requireThread(projectId, threadId, principal);
    this.authorization.requireProjectPath(principal, projectId, this.path(existing), "comment:write");
    if (existing.suggestion) throw new ApiError(409, "suggestion_requires_decision", "请通过接受或拒绝处理修改建议");
    await this.database.mutate(state => {
      const thread = state.commentThreads.find(item => item.id === threadId)!;
      thread.status = status; thread.updatedAt = new Date().toISOString();
      audit(state, principal, thread, `comment.${status}`);
    });
    return this.view(this.requireThread(projectId, threadId, principal), principal)!;
  }

  async decide(projectId: string, threadId: string, principal: Principal, decision: "accepted" | "rejected") {
    // Serialize accept/reject/reanchor to prevent duplicate decisions and stale anchors.
    const key = this.requireThread(projectId, threadId, principal).review?.sessionId ?? threadId;
    const previous = this.decisions.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.collaboration.withProjectLock(projectId, async () => {
      const thread = this.requireThread(projectId, threadId, principal);
      this.authorization.requireProjectPath(principal, projectId, this.path(thread), "project:write");
      if (!thread.suggestion || thread.suggestion.status !== "pending") throw new ApiError(409, "suggestion_already_decided", "修改建议已处理");
      const result = decision === "accepted" ? await this.collaboration.replaceAnchored(projectId, thread.documentId, thread.startRelativePosition, thread.endRelativePosition, thread.quote, thread.suggestion.replacement) : undefined;
      await this.database.mutate(state => {
        const stored = state.commentThreads.find(item => item.id === threadId)!;
        stored.suggestion = { ...stored.suggestion!, status: decision, decidedByUserId: principal.user.id, decidedAt: new Date().toISOString() };
        stored.status = "resolved"; stored.updatedAt = new Date().toISOString();
        const review = state.collaborationReviewSessions.find(item => item.id === stored.review?.sessionId);
        if (review) review.closedAt = stored.updatedAt;
        this.notify(state, [stored.authorUserId], principal, stored);
        audit(state, principal, stored, `suggestion.${decision}`);
      });
      return { thread: this.view(this.requireThread(projectId, threadId, principal), principal)!, ...(result ? { collaboration: result } : {}) };
    }));
    this.decisions.set(key, operation);
    try { return await operation; } finally { if (this.decisions.get(key) === operation) this.decisions.delete(key); }
  }

  reanchor(projectId: string, threadId: string, principal: Principal, input: ReanchorInput) { return this.collaboration.withProjectLock(projectId, () => this.reanchorNow(projectId, threadId, principal, input)); }
  private async reanchorNow(projectId: string, threadId: string, principal: Principal, input: ReanchorInput) {
    const thread = this.requireThread(projectId, threadId, principal);
    if (thread.scope === "project") throw new ApiError(400, "discussion_has_no_anchor", "项目讨论不需要关联正文位置");
    const lockKey = thread.review?.sessionId ?? threadId;
    if (this.decisions.has(lockKey)) throw new ApiError(409, "suggestion_decision_pending", "修改建议正在处理中");
    this.authorization.requireProjectPath(principal, projectId, this.path(thread), "comment:write");
    this.authorization.requireProjectPath(principal, projectId, input.path, "comment:write");
    if (thread.suggestion && thread.suggestion.status !== "pending") throw new ApiError(409, "suggestion_already_decided", "已处理的建议不能重新关联");
    const anchor = await this.collaboration.positions(projectId, input.path, input.from, input.to);
    const quote = anchor.content.slice(input.from, input.to);
    if (input.quote !== undefined && input.quote !== quote) throw new ApiError(409, "comment_selection_changed", "选区已更改，请重新选择文本");
    await this.database.mutate(state => {
      if (this.decisions.has(lockKey)) throw new ApiError(409, "suggestion_decision_pending", "修改建议正在处理中");
      const stored = state.commentThreads.find(item => item.id === threadId)!;
      Object.assign(stored, { documentId: anchor.documentId, path: input.path, startRelativePosition: anchor.start, endRelativePosition: anchor.end, quote, contextHash: digest(anchor.content, input.from, input.to), fileVersion: anchor.fileVersion, status: "open", updatedAt: new Date().toISOString() });
      const review = state.collaborationReviewSessions.find(item => item.id === stored.review?.sessionId);
      if (review) review.closedAt = new Date().toISOString();
      audit(state, principal, stored, "comment.reanchor");
    });
    return this.view(this.requireThread(projectId, threadId, principal), principal)!;
  }

  startReview(projectId: string, principal: Principal, path: string, previousId?: string): Promise<CollaborationReviewSessionView> { return this.collaboration.withProjectLock(projectId, () => this.startReviewNow(projectId, principal, path, previousId)); }
  private async startReviewNow(projectId: string, principal: Principal, path: string, previousId?: string): Promise<CollaborationReviewSessionView> {
    this.authorization.requireProjectPath(principal, projectId, path, "comment:write");
    const snapshot = await this.collaboration.open(projectId, path);
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, Buffer.from(snapshot.update, "base64"));
      const content = doc.getText("content").toString();
      return await this.database.mutate(state => {
        if (previousId) {
          const previous = state.collaborationReviewSessions.find(item => item.id === previousId && item.projectId === projectId && item.authorUserId === principal.user.id);
          if (!previous) throw new ApiError(404, "review_session_not_found", "修订草稿不存在");
          previous.closedAt ??= new Date().toISOString();
        }
        const existing = state.collaborationReviewSessions.find(item => item.projectId === projectId && item.documentId === snapshot.documentId && item.authorUserId === principal.user.id && !item.closedAt);
        if (existing) return this.reviewView(existing, state);
        const now = new Date().toISOString();
        const session: CollaborationReviewSession = { id: `human_review_${crypto.randomUUID()}`, projectId, documentId: snapshot.documentId, path: snapshot.path, authorUserId: principal.user.id, baseUpdate: snapshot.update, baseContent: content, draftContent: content, fileVersion: snapshot.fileVersion, revision: 0, createdAt: now, updatedAt: now };
        state.collaborationReviewSessions.push(session);
        return this.reviewView(session, state);
      });
    } finally { doc.destroy(); }
  }

  async getReview(projectId: string, sessionId: string, principal: Principal): Promise<CollaborationReviewSessionView> {
    const session = this.requireReview(projectId, sessionId, principal);
    if (!session.closedAt) {
      const current = await this.collaboration.open(projectId, session.path);
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, Buffer.from(current.update, "base64"));
        if (current.documentId === session.documentId && doc.getText("content").toString() !== session.baseContent && !session.liveConflict) return this.saveReview(projectId, sessionId, principal, { draftContent: session.draftContent, expectedRevision: session.revision, operationId: crypto.randomUUID() });
      } finally { doc.destroy(); }
    }
    return this.reviewView(session, this.database.snapshot());
  }

  async saveReview(projectId: string, sessionId: string, principal: Principal, input: { draftContent: string; expectedRevision: number; operationId: string }): Promise<CollaborationReviewSessionView> {
    if (typeof input.draftContent !== "string" || input.draftContent.length > 2_000_000 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || typeof input.operationId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.operationId)) throw new ApiError(400, "review_draft_invalid", "修订草稿、版本和操作编号无效");
    this.requireReview(projectId, sessionId, principal);
    const previous = this.decisions.get(sessionId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.collaboration.withProjectLock(projectId, async () => {
      const session = this.requireReview(projectId, sessionId, principal);
      const inputHash = createHash("sha256").update(input.draftContent).digest("hex");
      if (session.lastOperationId === input.operationId && session.draftContent === input.draftContent) return this.reviewView(session, this.database.snapshot());
      const seen = session.recentOperations?.find(item => item.id === input.operationId);
      if (seen) { if (seen.inputHash !== inputHash) throw new ApiError(409, "review_operation_reused", "操作编号已用于另一份草稿"); return this.reviewView(session, this.database.snapshot()); }
      if (session.closedAt) throw new ApiError(409, "review_session_closed", "本轮已有修订被处理，草稿已保留。请基于最新正文开始下一轮修订。");
      if (session.revision !== input.expectedRevision) throw new ApiError(409, "review_revision_conflict", "另一窗口已更新此修订草稿，当前输入已保留，请核对后继续。");
      const doc = new Y.Doc(), currentDoc = new Y.Doc();
      try {
        Y.applyUpdate(doc, Buffer.from(session.baseUpdate, "base64"));
        const current = await this.collaboration.open(projectId, session.path);
        if (current.documentId !== session.documentId) throw new ApiError(409, "review_document_replaced", "源文件已替换，当前草稿已保留");
        Y.applyUpdate(currentDoc, Buffer.from(current.update, "base64"));
        const latest = currentDoc.getText("content").toString();
        let baseContent = session.baseContent, draftContent = input.draftContent, baseUpdate = session.baseUpdate;
        let rebased = false, liveConflict = false;
        if (latest !== baseContent) {
          const mapped = buildReviewHunks(baseContent, draftContent).map(hunk => {
            const text = doc.getText("content");
            const from = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromTypeIndex(text, hunk.from), currentDoc)?.index;
            const to = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromTypeIndex(text, hunk.to), currentDoc)?.index;
            if (from === undefined || to === undefined || latest.slice(from, to) !== hunk.before) liveConflict = true;
            return { ...hunk, from: from ?? 0, to: to ?? 0 };
          });
          if (!liveConflict) {
            draftContent = latest;
            for (const hunk of mapped.sort((a, b) => b.from - a.from)) draftContent = draftContent.slice(0, hunk.from) + hunk.after + draftContent.slice(hunk.to);
            if (draftContent.length > 2_000_000) throw new ApiError(409, "review_rebase_too_large", "合并后的草稿超过大小上限，请分文件修订");
            baseContent = latest; baseUpdate = current.update; rebased = true;
          }
        }
        const text = (rebased ? currentDoc : doc).getText("content");
        const hunks = buildReviewHunks(baseContent, draftContent);
        if (hunks.length > 1_000) throw new ApiError(400, "review_draft_too_many_changes", "单轮修订最多包含 1,000 处更改，请分轮提交");
        return await this.database.mutate(state => {
          const stored = state.collaborationReviewSessions.find(item => item.id === sessionId)!;
          const document = state.collaborationDocuments.find(item => item.id === stored.documentId && item.status === "active");
          if (!document) throw new ApiError(409, "review_document_replaced", "源文件已移除或替换，当前草稿已保留。");
          this.authorization.requireProjectPath(principal, projectId, document.path, "comment:write");
          const now = new Date().toISOString();
          const old = state.commentThreads.filter(item => item.review?.sessionId === sessionId && item.suggestion?.status === "pending");
          const range = (thread: CommentThread) => rebased ? { from: Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(Buffer.from(thread.startRelativePosition, "base64")), currentDoc)?.index ?? -1, to: Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(Buffer.from(thread.endRelativePosition, "base64")), currentDoc)?.index ?? -1 } : thread.review!;
          const used = new Set<string>();
          for (const hunk of hunks) {
            const same = old.find(item => !used.has(item.id) && range(item).from === hunk.from && range(item).to === hunk.to)
              ?? old.find(item => !used.has(item.id) && Math.max(range(item).from, hunk.from) <= Math.min(range(item).to, hunk.to));
            const thread: CommentThread = same ?? { id: `thread_${crypto.randomUUID()}`, projectId, documentId: session.documentId, path: document.path, startRelativePosition: "", endRelativePosition: "", quote: hunk.before, contextHash: "", fileVersion: session.fileVersion, status: "open", authorUserId: principal.user.id, createdAt: now, updatedAt: now };
            used.add(thread.id);
            Object.assign(thread, { path: document.path, quote: hunk.before, startRelativePosition: Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, hunk.from))).toString("base64"), endRelativePosition: Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, hunk.to))).toString("base64"), contextHash: digest(baseContent, hunk.from, hunk.to), review: { sessionId, from: hunk.from, to: hunk.to }, suggestion: { replacement: hunk.after, status: "pending" }, updatedAt: now });
            if (!same) { state.commentThreads.push(thread); state.commentMessages.push({ id: `comment_${crypto.randomUUID()}`, threadId: thread.id, authorUserId: principal.user.id, body: "跟踪修订", createdAt: now, updatedAt: now }); }
          }
          for (const thread of old) if (!used.has(thread.id)) { thread.suggestion!.status = "withdrawn"; thread.status = "resolved"; thread.updatedAt = now; }
          Object.assign(stored, { baseContent, baseUpdate, draftContent, path: document.path, revision: stored.revision + 1, lastOperationId: input.operationId, liveConflict, updatedAt: now });
          stored.recentOperations = [...(stored.recentOperations ?? []), { id: input.operationId, inputHash }].slice(-50);
          return this.reviewView(stored, state);
        });
      } finally { doc.destroy(); currentDoc.destroy(); }
    }));
    this.decisions.set(sessionId, operation);
    try { return await operation; } finally { if (this.decisions.get(sessionId) === operation) this.decisions.delete(sessionId); }
  }

  private requireReview(projectId: string, sessionId: string, principal: Principal) {
    this.authorization.requireProject(principal, projectId, "project:read");
    const session = this.database.snapshot().collaborationReviewSessions.find(item => item.id === sessionId && item.projectId === projectId && item.authorUserId === principal.user.id);
    if (!session) throw new ApiError(404, "review_session_not_found", "修订草稿不存在");
    const path = this.database.snapshot().collaborationDocuments.find(item => item.id === session.documentId)?.path ?? session.path;
    this.authorization.requireProjectPath(principal, projectId, path, "comment:write");
    return { ...session, path };
  }
  private reviewView(session: CollaborationReviewSession, state: DatabaseState): CollaborationReviewSessionView {
    const { baseUpdate: _base, ...view } = session;
    return { ...view, pendingCount: state.commentThreads.filter(item => item.review?.sessionId === session.id && item.suggestion?.status === "pending").length };
  }

  private requireThread(projectId: string, threadId: string, principal: Principal) {
    this.authorization.requireProject(principal, projectId, "project:read");
    const thread = this.database.snapshot().commentThreads.find(item => item.id === threadId && item.projectId === projectId);
    if (!thread) throw new ApiError(404, "comment_thread_not_found", "评论不存在");
    this.authorization.requireProjectPath(principal, projectId, this.path(thread), "project:read");
    return thread;
  }
  private path(thread: CommentThread) { return this.database.snapshot().collaborationDocuments.find(item => item.id === thread.documentId)?.path ?? thread.path; }
  private view(thread: CommentThread, principal: Principal): CommentThreadView | undefined {
    const path = this.path(thread);
    if (!this.authorization.projectPathDecision(principal, thread.projectId, path, "project:read").allowed) return;
    const position = thread.scope === "project" ? {} : this.collaboration.absolutePositions(thread.documentId, thread.startRelativePosition, thread.endRelativePosition);
    const attached = thread.scope === "project" || position.start !== undefined && position.end !== undefined && position.end >= position.start && (!thread.quote || position.end > position.start);
    const changed = attached && thread.suggestion?.status === "pending" && position.content?.slice(position.start, position.end) !== thread.quote;
    const state = this.database.snapshot();
    return { ...thread, path, status: thread.status === "orphaned" ? "open" : thread.status,
      anchorStatus: !attached ? "orphaned" : changed ? "changed" : "attached",
      ...(attached && thread.scope !== "project" ? { from: position.start!, to: position.end! } : {}),
      canComment: this.authorization.projectPathDecision(principal, thread.projectId, path, "comment:write").allowed,
      canEdit: this.authorization.projectPathDecision(principal, thread.projectId, path, "project:write").allowed,
      messages: state.commentMessages.filter(item => item.threadId === thread.id).map(item => ({ ...item, authorName: state.users.find(user => user.id === item.authorUserId)?.displayName ?? "已离开的协作者" })) };
  }
  private mentions(state: DatabaseState, projectId: string, path: string, body: string) {
    const ids = [...new Set([...body.matchAll(/@\[[^\]\n]{1,100}\]\((user_[A-Za-z0-9_-]{1,128})\)/g)].map(match => match[1]!))];
    if (ids.some(id => !state.users.some(user => user.id === id && user.status === "active" && this.authorization.projectPathDecision({ user, sessionId: "" }, projectId, path, "project:read").allowed))) throw new ApiError(400, "comment_mention_invalid", "被提及者需要有当前文件的访问权限");
    return ids;
  }
  private notify(state: DatabaseState, recipients: string[], principal: Principal, thread: CommentThread, mentions: string[] = []) {
    for (const userId of new Set(recipients)) {
      const user = state.users.find(item => item.id === userId && item.status === "active");
      if (userId === principal.user.id || !user || !this.authorization.projectPathDecision({ user, sessionId: "" }, thread.projectId, this.path(thread), "project:read").allowed) continue;
      createNotification(state, { userId, type: mentions.includes(userId) ? "mention" : "discussion", title: mentions.includes(userId) ? "有人在评论中提及了你" : `${principal.user.displayName} 更新了论文讨论`, projectId: thread.projectId, threadId: thread.id, body: this.path(thread) || "项目讨论" });
    }
  }
}
function validateBody(body: string) { if (typeof body !== "string" || !body.trim() || body.trim().length > 8_000) throw new ApiError(400, "comment_invalid", "评论需要包含 1–8,000 字符"); return body.trim(); }
function digest(content: string, from: number, to: number) { return createHash("sha256").update(content.slice(Math.max(0, from - 80), Math.min(content.length, to + 80))).digest("hex"); }
function audit(state: DatabaseState, principal: Principal, thread: CommentThread, action: string) { state.auditEvents.push({ id: `audit_${crypto.randomUUID()}`, actorUserId: principal.user.id, action, resourceType: "comment_thread", resourceId: thread.id, createdAt: new Date().toISOString() }); }
