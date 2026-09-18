import { createHash } from "node:crypto";
import type { CommentThread } from "@fastwrite/shared";
import { ApiError } from "../http";
import type { JsonDatabase } from "../storage/database";
import type { Principal } from "../auth/auth-service";
import { AuthorizationService } from "../auth/authorization-service";
import { CollaborationService } from "../collaboration/collaboration-service";
import { createNotification } from "../notifications/notification-service";

export class CommentService {
  constructor(private readonly database: JsonDatabase, private readonly collaboration: CollaborationService, private readonly authorization: AuthorizationService) {}
  async list(projectId: string, principal: Principal) { this.authorization.requireProject(principal, projectId, "project:read"); return Promise.all(this.database.snapshot().commentThreads.filter((thread) => thread.projectId === projectId && canRead(this.authorization, principal, projectId, thread.path)).map(async (thread) => ({ ...thread, ...(await this.position(thread)), messages: this.database.snapshot().commentMessages.filter((message) => message.threadId === thread.id) }))); }
  async create(projectId: string, principal: Principal, input: { path: string; from: number; to: number; body: string }) { this.authorization.requireProjectPath(principal, projectId, input.path, "comment:write"); if (!input.body?.trim() || input.body.trim().length > 8_000) throw new ApiError(400, "comment_invalid", "Comment text is required and must be under 8,000 characters"); const anchor = await this.collaboration.positions(projectId, input.path, input.from, input.to); const quote = anchor.content.slice(input.from, input.to); const now = new Date().toISOString(); const thread: CommentThread = { id: `thread_${crypto.randomUUID()}`, projectId, documentId: anchor.documentId, path: input.path, startRelativePosition: anchor.start, endRelativePosition: anchor.end, quote, contextHash: digest(anchor.content, input.from, input.to), fileVersion: anchor.fileVersion, status: "open", authorUserId: principal.user.id, createdAt: now, updatedAt: now }; await this.database.mutate((state) => { const mentionedUserIds = validateMentions(state, projectId, input.body); state.commentThreads.push(thread); state.commentMessages.push({ id: `comment_${crypto.randomUUID()}`, threadId: thread.id, authorUserId: principal.user.id, body: input.body.trim(), ...(mentionedUserIds.length ? { mentionedUserIds } : {}), createdAt: now, updatedAt: now }); notifyMentions(state, mentionedUserIds, principal.user.id, projectId, thread.id); state.auditEvents.push({ id: `audit_${crypto.randomUUID()}`, actorUserId: principal.user.id, action: "comment.create", resourceType: "comment_thread", resourceId: thread.id, createdAt: now }); }); return { ...thread, ...(await this.position(thread)), messages: this.database.snapshot().commentMessages.filter((message) => message.threadId === thread.id) }; }
  async reply(projectId: string, threadId: string, principal: Principal, body: string) { const thread = this.requireThread(projectId, threadId); this.authorization.requireProjectPath(principal, projectId, thread.path, "comment:write"); if (!body.trim() || body.trim().length > 8_000) throw new ApiError(400, "comment_invalid", "Comment text is required and must be under 8,000 characters"); const now = new Date().toISOString(); return this.database.mutate((state) => { const mentionedUserIds = validateMentions(state, projectId, body); const message = { id: `comment_${crypto.randomUUID()}`, threadId: thread.id, authorUserId: principal.user.id, body: body.trim(), ...(mentionedUserIds.length ? { mentionedUserIds } : {}), createdAt: now, updatedAt: now }; state.commentMessages.push(message); notifyMentions(state, mentionedUserIds, principal.user.id, projectId, thread.id); thread.updatedAt = now; return message; }); }
  async updateStatus(projectId: string, threadId: string, principal: Principal, status: "open" | "resolved") { const existing = this.requireThread(projectId, threadId); this.authorization.requireProjectPath(principal, projectId, existing.path, "comment:write"); return this.database.mutate((state) => { const thread = state.commentThreads.find((item) => item.id === threadId && item.projectId === projectId)!; thread.status = status; thread.updatedAt = new Date().toISOString(); return thread; }); }
  async reanchor(projectId: string, threadId: string, principal: Principal, input: { path: string; from: number; to: number }) {
    const thread = this.requireThread(projectId, threadId);
    this.authorization.requireProjectPath(principal, projectId, thread.path, "comment:write");
    this.authorization.requireProjectPath(principal, projectId, input.path, "comment:write");
    const anchor = await this.collaboration.positions(projectId, input.path, input.from, input.to);
    const now = new Date().toISOString();
    return this.database.mutate((state) => {
      const thread = state.commentThreads.find((item) => item.id === threadId && item.projectId === projectId)!;
      thread.documentId = anchor.documentId; thread.path = input.path; thread.startRelativePosition = anchor.start; thread.endRelativePosition = anchor.end; thread.quote = anchor.content.slice(input.from, input.to); thread.contextHash = digest(anchor.content, input.from, input.to); thread.fileVersion = anchor.fileVersion; thread.status = "open"; thread.updatedAt = now;
      state.auditEvents.push({ id: `audit_${crypto.randomUUID()}`, actorUserId: principal.user.id, action: "comment.reanchor", resourceType: "comment_thread", resourceId: thread.id, createdAt: now });
      return thread;
    });
  }
  private requireThread(projectId: string, threadId: string) { const thread = this.database.snapshot().commentThreads.find((item) => item.id === threadId && item.projectId === projectId); if (!thread) throw new ApiError(404, "comment_thread_not_found", "Comment thread not found"); return thread; }
  private async position(thread: CommentThread) { const position = this.collaboration.absolutePositions(thread.documentId, thread.startRelativePosition, thread.endRelativePosition); if (position.start === undefined || position.end === undefined) { if (thread.status !== "orphaned") await this.database.mutate((state) => { const stored = state.commentThreads.find((item) => item.id === thread.id); if (stored) { stored.status = "orphaned"; stored.updatedAt = new Date().toISOString(); } }); return { anchorStatus: "orphaned" as const }; } return { anchorStatus: thread.status === "orphaned" ? "orphaned" as const : "attached" as const, from: position.start, to: position.end }; }
}
function digest(content: string, from: number, to: number) { return createHash("sha256").update(content.slice(Math.max(0, from - 80), Math.min(content.length, to + 80))).digest("hex"); }
function validateMentions(state: ReturnType<JsonDatabase["snapshot"]>, projectId: string, body: string): string[] {
  const mentionedUserIds = [...body.matchAll(/@\[[^\]\n]{1,100}\]\((user_[A-Za-z0-9_-]{1,128})\)/g)].map((match) => match[1]!).filter((value, index, values) => values.indexOf(value) === index);
  if (!mentionedUserIds.length) return [];
  const memberIds = new Set(state.projectMembers.filter((member) => member.projectId === projectId).map((member) => member.userId));
  if (mentionedUserIds.some((userId) => !memberIds.has(userId))) throw new ApiError(400, "comment_mention_invalid", "Mentioned users must be project members");
  return mentionedUserIds;
}
function notifyMentions(state: ReturnType<JsonDatabase["snapshot"]>, mentionedUserIds: string[], authorUserId: string, projectId: string, threadId: string): void { for (const userId of mentionedUserIds) if (userId !== authorUserId) createNotification(state, { userId, type: "mention", title: "You were mentioned in a comment", projectId, body: `Comment thread ${threadId}` }); }
function canRead(authorization: AuthorizationService, principal: Principal, projectId: string, path: string): boolean { try { authorization.requireProjectPath(principal, projectId, path, "project:read"); return true; } catch { return false; } }
