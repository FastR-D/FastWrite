import type { FastCAS, Link } from "@fastrd/fastcas/server";
import { ApiError } from "../http";
import type { JsonDatabase } from "../storage/database";
import { AuthorizationService } from "./authorization-service";

/** Minimal server-to-server view. No sessions, source text or comment bodies are returned. */
export async function workspaceSummary(sdk: FastCAS, configuration: { issuer: string; clientId: string }, database: JsonDatabase, request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^Bearer [A-Za-z0-9._~-]+$/.test(authorization)) throw new ApiError(401, "workspace_token_required", "需要 FastCAS 服务令牌");
  const raw = authorization.slice(7);
  let claims, live;
  try { claims = await sdk.verifyAccessToken(raw, configuration.clientId, ["workspace:read"]); live = await sdk.introspectToken(raw); }
  catch { throw new ApiError(401, "workspace_token_invalid", "个人摘要服务凭证无效"); }
  if (claims.service !== true || claims.sub !== "fastresearch" || claims.client_id !== "fastresearch" || !live.active || live.sub !== claims.sub || live.client_id !== claims.client_id || !live.aud?.includes(configuration.clientId) || !String(live.scope ?? "").split(" ").includes("workspace:read")) throw new ApiError(403, "workspace_scope_denied", "个人摘要服务权限不足");
  const body = await request.json().catch(() => null) as { subject?: unknown } | null;
  if (!body || typeof body.subject !== "string" || !body.subject || body.subject.length > 256 || Object.keys(body).some(key => key !== "subject")) throw new ApiError(400, "workspace_subject_invalid", "需要有效的 CAS 身份");
  const base = { schemaVersion: "fastresearch.workspace.v1", appId: "fast-write", updatedAt: new Date().toISOString(), metrics: [] as Array<{ id: string; label: string; value: number }>, items: [] as Array<{ id: string; kind: string; title: string; description: string; path: string; occurredAt: string }> };
  const local = database.snapshot().fastcasLinks.filter(item => item.issuer === configuration.issuer && item.link.client_id === configuration.clientId && item.link.subject === body.subject).sort((a, b) => b.link.version - a.link.version)[0];
  if (!local) return { ...base, accountState: "missing" };
  if (local.link.state !== "active") return { ...base, accountState: "inactive" };
  let remote: Link;
  try { remote = await sdk.resolveLink(body.subject); }
  catch { throw new ApiError(503, "workspace_binding_unavailable", "暂时无法确认 FastCAS 账号绑定"); }
  if (["id", "subject", "client_id", "local_account_ref", "version", "state"].some(key => remote[key as keyof Link] !== local.link[key as keyof Link])) return { ...base, accountState: "inactive" };
  const state = database.snapshot();
  if (!state.fastcasLinks.some(item => item.issuer === configuration.issuer && item.link.id === remote.id && item.link.state === "active" && item.link.version === remote.version)) throw new ApiError(409, "workspace_binding_changed", "账号绑定已更改");
  const user = state.users.find(item => item.id === local.userId && item.status === "active");
  if (!user) return { ...base, accountState: "inactive" };
  // A platform administrator sees only their own project memberships here.
  const authorizationService = new AuthorizationService(database);
  const projectIDs = new Set(state.projects.filter(project => authorizationService.projectRole(user.id, project.id)).map(project => project.id));
  const principal = { user: { ...user, platformRole: "user" as const }, sessionId: "workspace-summary" };
  const notifications = state.notifications.filter(item => {
    if (item.userId !== user.id || !item.inApp || item.readAt || (item.projectId && !projectIDs.has(item.projectId))) return false;
    if (!item.threadId) return item.type !== "discussion" && item.type !== "mention";
    const thread = state.commentThreads.find(thread => thread.id === item.threadId && thread.projectId === item.projectId);
    if (!thread) return false;
    const path = state.collaborationDocuments.find(document => document.id === thread.documentId)?.path ?? thread.path;
    return authorizationService.projectPathDecision(principal, thread.projectId, path, "project:read").allowed;
  });
  const comments = notifications.filter(item => item.type === "discussion");
  const mentions = notifications.filter(item => item.type === "mention");
  const items = notifications.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5).map(item => ({ id: item.id, kind: item.type === "mention" ? "mention" : item.type === "discussion" ? "comment" : "notification", title: item.title.slice(0, 180), description: item.type === "mention" ? "有人在评论中提及你" : item.type === "discussion" ? "项目有新评论" : "未读项目通知", path: item.projectId ? `/projects/${encodeURIComponent(item.projectId)}` : "/panel", occurredAt: item.createdAt }));
  for (const project of state.projects.filter(item => projectIDs.has(item.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3)) {
    if (items.length >= 8) break;
    items.push({ id: `project:${project.id}`, kind: "project", title: project.name.slice(0, 180), description: "最近更新的项目", path: `/projects/${encodeURIComponent(project.id)}`, occurredAt: project.updatedAt });
  }
  return { ...base, accountState: "active", metrics: [{ id: "comments", label: "未读评论", value: comments.length }, { id: "mentions", label: "未读提及", value: mentions.length }, { id: "projects", label: "参与项目", value: projectIDs.size }], items };
}
