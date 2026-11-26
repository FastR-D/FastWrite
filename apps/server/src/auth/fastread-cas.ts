import type { FastCASService } from "./fastcas-service";
import type { JsonDatabase } from "../storage/database";
import type { Principal } from "./auth-service";
import { ApiError, readJson } from "../http";

export interface ReadCASIdentity { issuer: string; subject: string; linkId: string; version: number; }

export async function readCASAccount(service: FastCASService | undefined, database: JsonDatabase, subject: string, pinned?: ReadCASIdentity): Promise<{ principal: Principal; identity: ReadCASIdentity }> {
  if (!service) throw new ApiError(503, "fastcas_unavailable", "FastCAS 未配置");
  const { configuration, sdk } = service;
  const local = database.snapshot().fastcasLinks.filter(item => item.issuer === configuration.issuer && item.link.client_id === configuration.clientId && item.link.subject === subject).sort((a, b) => b.link.version - a.link.version)[0];
  if (!local || local.link.state !== "active") throw new ApiError(403, "fastread_cas_unlinked", "请先在 FastWrite 认证同一 FastCAS 账号");
  if (pinned && (pinned.issuer !== configuration.issuer || pinned.subject !== subject || pinned.linkId !== local.link.id || pinned.version !== local.link.version)) throw new ApiError(403, "fastread_cas_changed", "FastCAS 绑定已更改，请重新连接");
  let remote;
  try { remote = await sdk.resolveLink(subject); } catch { throw new ApiError(503, "fastread_cas_unavailable", "暂时无法确认 FastCAS 账号绑定"); }
  if (["id", "client_id", "subject", "local_account_ref", "version", "state"].some(key => remote[key as keyof typeof remote] !== local.link[key as keyof typeof remote])) throw new ApiError(403, "fastread_cas_changed", "FastCAS 绑定已更改");
  const state = database.snapshot();
  if (!state.fastcasLinks.some(item => item.issuer === configuration.issuer && item.userId === local.userId && item.link.id === remote.id && item.link.state === "active" && item.link.version === remote.version)) throw new ApiError(403, "fastread_cas_changed", "FastCAS 绑定已更改");
  const user = state.users.find(item => item.id === local.userId && item.id === remote.local_account_ref && item.status === "active");
  if (!user) throw new ApiError(403, "fastread_cas_inactive", "账号已停用");
  // Service connections retain project membership ACL, never platform-admin authority.
  return { principal: { user: { ...user, platformRole: "user" }, sessionId: `fastread-cas:${user.id}` }, identity: { issuer: configuration.issuer, subject, linkId: remote.id, version: remote.version } };
}

export async function connectReadCAS(service: FastCASService | undefined, database: JsonDatabase, request: Request) {
  if (!service) throw new ApiError(503, "fastcas_unavailable", "FastCAS 未配置");
  const raw = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!raw) throw new ApiError(401, "fastread_cas_token_required", "需要 FastCAS 服务令牌");
  let claims, live;
  try { claims = await service.sdk.verifyAccessToken(raw, service.configuration.clientId, ["fastread:connect"]); live = await service.sdk.introspectToken(raw); }
  catch { throw new ApiError(401, "fastread_cas_invalid", "FastCAS 服务令牌无效"); }
  if (claims.service !== true || claims.sub !== "fastread-sync" || claims.client_id !== "fastread-sync" || !live.active || live.sub !== claims.sub || live.client_id !== claims.client_id || !live.aud?.includes(service.configuration.clientId) || !String(live.scope ?? "").split(" ").includes("fastread:connect")) throw new ApiError(403, "fastread_cas_scope", "FastRead 联动权限不足");
  const body = await readJson<{ subject: string }>(request);
  if (!body || typeof body.subject !== "string" || !body.subject || body.subject.length > 256 || Object.keys(body).some(key => key !== "subject")) throw new ApiError(400, "fastread_cas_subject", "CAS 身份无效");
  return readCASAccount(service, database, body.subject);
}
