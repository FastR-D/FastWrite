import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AccountUser, ExternalIdentity, PlatformRole } from "@fastwrite/shared";
import { ApiError } from "../http";
import type { JsonDatabase } from "../storage/database";
import type { AuthenticatedIdentity } from "./identity-provider";

export interface Principal { user: AccountUser; sessionId: string; idpGroups?: string[]; }

const LOCAL_ISSUER = "fastwrite:local";
const ACCESS_TOKEN_MS = 15 * 60_000;
const REFRESH_TOKEN_MS = 30 * 86400_000;
export interface AuthResult { user: AccountUser; token: string; refreshToken: string; }
export interface CollaborationRoomGrant { userId: string; sessionId: string; projectId: string; path: string; scope: "read" | "write"; authzVersion: number; expiresAt: string; }

export class AuthService {
  private readonly roomTokenSecret: string;
  constructor(private readonly database: JsonDatabase, roomTokenSecret?: string) { this.roomTokenSecret = roomTokenSecret || randomBytes(32).toString("base64url"); }

  async ensureBootstrapAdmin(input: { email: string; password: string }): Promise<boolean> {
    const email = normalizeEmail(input.email);
    if (input.password.length < 12) throw new Error("Bootstrap admin password must be at least 12 characters");
    if (this.database.snapshot().users.some((user) => user.emailNormalized === email)) return false;
    const timestamp = new Date().toISOString();
    const user: AccountUser = { id: `user_${crypto.randomUUID()}`, emailNormalized: email, displayName: "FastWrite Administrator", platformRole: "platform_admin", status: "active", authzVersion: 1, createdAt: timestamp, updatedAt: timestamp };
    const passwordHash = await Bun.password.hash(input.password, { algorithm: "argon2id" });
    await this.database.mutate((state) => {
      state.users.push(user);
      state.externalIdentities.push({ id: `identity_${crypto.randomUUID()}`, userId: user.id, issuer: LOCAL_ISSUER, subject: email, email, createdAt: timestamp });
      state.localCredentials.push({ userId: user.id, passwordHash });
      state.auditEvents.push(audit(user.id, "auth.bootstrap_register", "user", user.id));
    });
    return true;
  }

  async register(input: { email: string; password: string; displayName?: string }): Promise<AuthResult> {
    const email = normalizeEmail(input.email);
    if (input.password.length < 12) throw new ApiError(400, "password_too_short", "Password must be at least 12 characters");
    const timestamp = new Date().toISOString();
    const user: AccountUser = { id: `user_${crypto.randomUUID()}`, emailNormalized: email, displayName: (input.displayName?.trim() || email.split("@")[0] || "User").slice(0, 100), platformRole: this.database.snapshot().users.length ? "user" : "platform_admin", status: "active", authzVersion: 1, createdAt: timestamp, updatedAt: timestamp };
    const passwordHash = await Bun.password.hash(input.password, { algorithm: "argon2id" });
    const token = randomToken(); const refreshToken = randomToken();
    await this.database.mutate((state) => {
      if (state.externalIdentities.some((identity) => identity.issuer === LOCAL_ISSUER && identity.subject === email)) throw new ApiError(409, "account_exists", "An account already exists for this email");
      state.users.push(user);
      state.externalIdentities.push({ id: `identity_${crypto.randomUUID()}`, userId: user.id, issuer: LOCAL_ISSUER, subject: email, email, createdAt: timestamp });
      state.localCredentials.push({ userId: user.id, passwordHash });
      state.sessions.push(session(user.id, token, refreshToken, timestamp));
      state.auditEvents.push(audit(user.id, "auth.register", "user", user.id));
    });
    return { user, token, refreshToken };
  }

  async login(input: { email: string; password: string }): Promise<AuthResult> {
    const email = normalizeEmail(input.email);
    const state = this.database.snapshot();
    const identity = state.externalIdentities.find((item) => item.issuer === LOCAL_ISSUER && item.subject === email);
    const credential = identity && state.localCredentials.find((item) => item.userId === identity.userId);
    const user = identity && state.users.find((item) => item.id === identity.userId);
    if (!credential || !user || !(await Bun.password.verify(input.password, credential.passwordHash))) throw new ApiError(401, "login_invalid", "Invalid email or password");
    if (user.status !== "active") throw new ApiError(403, "account_disabled", "This account is disabled");
    const token = randomToken(); const refreshToken = randomToken(); const timestamp = new Date().toISOString();
    await this.database.mutate((current) => { current.sessions.push(session(user.id, token, refreshToken, timestamp)); current.auditEvents.push(audit(user.id, "auth.login", "session", user.id)); });
    return { user, token, refreshToken };
  }

  async loginExternal(identity: AuthenticatedIdentity): Promise<AuthResult> {
    if (!identity.issuer || !identity.subject) throw new ApiError(400, "external_identity_invalid", "The identity provider did not return a stable subject");
    const timestamp = new Date().toISOString(); const token = randomToken(); const refreshToken = randomToken(); let user: AccountUser | undefined;
    await this.database.mutate((state) => {
      const existing = state.externalIdentities.find((item) => item.issuer === identity.issuer && item.subject === identity.subject);
      user = existing && state.users.find((item) => item.id === existing.userId);
      if (!user) {
        const emailNormalized = identity.email ? normalizeEmail(identity.email) : `external-${hash(`${identity.issuer}:${identity.subject}`).slice(0, 24)}@identity.invalid`;
        user = { id: `user_${crypto.randomUUID()}`, emailNormalized, displayName: (identity.displayName || identity.username || emailNormalized.split("@")[0] || "User").slice(0, 100), platformRole: state.users.length ? "user" : "platform_admin", status: "active", authzVersion: 1, createdAt: timestamp, updatedAt: timestamp };
        state.users.push(user);
        const external: ExternalIdentity = { id: `identity_${crypto.randomUUID()}`, userId: user.id, issuer: identity.issuer, subject: identity.subject, ...(identity.email ? { email: identity.email } : {}), ...(identity.username ? { username: identity.username } : {}), createdAt: timestamp };
        state.externalIdentities.push(external); state.auditEvents.push(audit(user.id, "auth.external_register", "user", user.id));
      }
      if (user.status !== "active") throw new ApiError(403, "account_disabled", "This account is disabled");
      state.sessions.push(session(user.id, token, refreshToken, timestamp, undefined, normalizedIdpGroups(identity.issuer, identity.groups))); state.auditEvents.push(audit(user.id, "auth.external_login", "session", user.id));
    });
    if (!user) throw new ApiError(500, "external_login_failed", "Unable to complete external login");
    return { user, token, refreshToken };
  }

  async refresh(request: Request): Promise<AuthResult> {
    const raw = cookie(request, "fastwrite.refresh");
    if (!raw) throw new ApiError(401, "refresh_missing", "Refresh session is required");
    const tokenHash = hash(raw); const timestamp = new Date().toISOString();
    const snapshot = this.database.snapshot(); const existing = snapshot.sessions.find((item) => item.refreshTokenHash === tokenHash);
    if (!existing || !existing.refreshExpiresAt || existing.refreshExpiresAt <= timestamp) throw new ApiError(401, "refresh_invalid", "Refresh session is invalid or expired");
    if (existing.revokedAt) {
      await this.database.mutate((state) => { for (const session of state.sessions) if (session.familyId && session.familyId === existing.familyId) session.revokedAt ??= timestamp; state.auditEvents.push(audit(existing.userId, "auth.refresh.replay", "session", existing.id)); });
      throw new ApiError(401, "refresh_replayed", "Refresh session has already been used");
    }
    const user = snapshot.users.find((item) => item.id === existing.userId);
    if (!user || user.status !== "active") throw new ApiError(401, "session_invalid", "Your session has expired");
    const token = randomToken(); const refreshToken = randomToken(); const familyId = existing.familyId ?? existing.id;
    await this.database.mutate((state) => {
      const stored = state.sessions.find((item) => item.id === existing.id);
      if (!stored || stored.revokedAt) throw new ApiError(401, "refresh_replayed", "Refresh session has already been used");
      stored.revokedAt = timestamp;
      const rotated = session(user.id, token, refreshToken, timestamp, familyId, existing.idpGroups);
      state.sessions.push(rotated);
      state.auditEvents.push(audit(user.id, "auth.refresh", "session", rotated.id));
    });
    return { user, token, refreshToken };
  }

  principal(request: Request, required = true): Principal | undefined {
    const raw = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? request.headers.get("x-fastwrite-session");
    if (!raw) { if (required) throw new ApiError(401, "authentication_required", "Sign in is required"); return undefined; }
    const state = this.database.snapshot(); const item = state.sessions.find((candidate) => !candidate.revokedAt && candidate.expiresAt > new Date().toISOString() && candidate.tokenHash === hash(raw));
    const user = item && state.users.find((candidate) => candidate.id === item.userId);
    if (!item || !user || user.status !== "active") throw new ApiError(401, "session_invalid", "Your session has expired");
    return { user, sessionId: item.id, idpGroups: item.idpGroups ?? [] };
  }

  issueCollaborationRoomToken(principal: Principal, input: { projectId: string; path: string; scope: "read" | "write" }): { token: string; expiresAt: string } {
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const grant: CollaborationRoomGrant = { userId: principal.user.id, sessionId: principal.sessionId, projectId: input.projectId, path: input.path, scope: input.scope, authzVersion: principal.user.authzVersion, expiresAt };
    const encoded = Buffer.from(JSON.stringify(grant)).toString("base64url");
    return { token: `${encoded}.${this.roomSignature(encoded)}`, expiresAt };
  }

  collaborationRoomGrant(token: string): CollaborationRoomGrant {
    const [encoded, signature, ...extra] = token.split(".");
    if (!encoded || !signature || extra.length || !safeEqual(signature, this.roomSignature(encoded))) throw new ApiError(401, "collaboration_room_invalid", "Collaboration room token is invalid");
    let grant: CollaborationRoomGrant;
    try { grant = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as CollaborationRoomGrant; } catch { throw new ApiError(401, "collaboration_room_invalid", "Collaboration room token is invalid"); }
    if (!grant.userId || !grant.sessionId || !grant.projectId || !grant.path || (grant.scope !== "read" && grant.scope !== "write") || !Number.isInteger(grant.authzVersion) || !grant.expiresAt || Date.parse(grant.expiresAt) <= Date.now()) throw new ApiError(401, "collaboration_room_expired", "Collaboration room token has expired");
    const state = this.database.snapshot(); const session = state.sessions.find((item) => item.id === grant.sessionId && item.userId === grant.userId && !item.revokedAt && item.expiresAt > new Date().toISOString()); const user = state.users.find((item) => item.id === grant.userId);
    if (!session || !user || user.status !== "active" || user.authzVersion !== grant.authzVersion) throw new ApiError(401, "collaboration_room_revoked", "Collaboration room access has been revoked");
    return grant;
  }

  async logout(request: Request): Promise<void> { const principal = this.principal(request); await this.database.mutate((state) => { const item = state.sessions.find((candidate) => candidate.id === principal!.sessionId); if (item) item.revokedAt = new Date().toISOString(); state.auditEvents.push(audit(principal!.user.id, "auth.logout", "session", principal!.sessionId)); }); }
  async disable(userId: string, actor: Principal, reason: string): Promise<void> { requireRole(actor.user, "platform_admin"); const metadata = { reason: adminReason(reason) }; await this.database.mutate((state) => { const user = state.users.find((item) => item.id === userId); if (!user) throw new ApiError(404, "user_not_found", "User not found"); if (user.id === actor.user.id) throw new ApiError(409, "admin_self_disable", "Administrators cannot disable their own account"); user.status = "disabled"; user.authzVersion++; user.updatedAt = new Date().toISOString(); for (const session of state.sessions) if (session.userId === userId) session.revokedAt = new Date().toISOString(); state.auditEvents.push({ ...audit(actor.user.id, "user.disable", "user", userId), metadata }); }); }
  async revokeSessions(userId: string, actor: Principal, reason: string): Promise<void> { requireRole(actor.user, "platform_admin"); const metadata = { reason: adminReason(reason) }; await this.database.mutate((state) => { if (!state.users.some((item) => item.id === userId)) throw new ApiError(404, "user_not_found", "User not found"); const now = new Date().toISOString(); for (const session of state.sessions) if (session.userId === userId) session.revokedAt ??= now; state.auditEvents.push({ ...audit(actor.user.id, "user.sessions.revoke", "user", userId), metadata }); }); }
  async updatePlatformRole(userId: string, role: PlatformRole, actor: Principal, reason: string): Promise<AccountUser> { requireRole(actor.user, "platform_admin"); const metadata = { reason: adminReason(reason), role }; return this.database.mutate((state) => { const user = state.users.find((item) => item.id === userId); if (!user) throw new ApiError(404, "user_not_found", "User not found"); if (user.platformRole === "platform_admin" && role !== "platform_admin" && state.users.filter((item) => item.platformRole === "platform_admin").length === 1) throw new ApiError(409, "last_platform_admin", "At least one platform administrator is required"); user.platformRole = role; user.authzVersion++; user.updatedAt = new Date().toISOString(); state.auditEvents.push({ ...audit(actor.user.id, "user.platform_role.update", "user", userId), metadata }); return user; }); }
  private roomSignature(value: string): string { return createHmac("sha256", this.roomTokenSecret).update(value).digest("base64url"); }
}

export function requireRole(user: AccountUser, role: PlatformRole): void { if (user.platformRole !== role) throw new ApiError(403, "platform_role_required", "This action requires platform administrator access"); }
export function requireAdminReadRole(user: AccountUser): void { if (user.platformRole !== "platform_admin" && user.platformRole !== "support_auditor") throw new ApiError(403, "platform_role_required", "This action requires administrator or support auditor access"); }
export function publicUser(user: AccountUser) { return user; }
function normalizeEmail(value: string): string { const email = value.trim().toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) throw new ApiError(400, "email_invalid", "Enter a valid email address"); return email; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function safeEqual(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function randomToken(): string { return randomBytes(32).toString("base64url"); }
function session(userId: string, token: string, refreshToken: string, createdAt: string, familyId = `family_${crypto.randomUUID()}`, idpGroups?: string[]) { return { id: `session_${crypto.randomUUID()}`, userId, tokenHash: hash(token), refreshTokenHash: hash(refreshToken), familyId, ...(idpGroups?.length ? { idpGroups } : {}), createdAt, expiresAt: new Date(Date.now() + ACCESS_TOKEN_MS).toISOString(), refreshExpiresAt: new Date(Date.now() + REFRESH_TOKEN_MS).toISOString() }; }
function normalizedIdpGroups(issuer: string, groups: string[]): string[] {
  const normalizedIssuer = issuer.trim().replace(/\/$/, "");
  if (!normalizedIssuer) return [];
  return [...new Set(groups.filter((group) => typeof group === "string").map((group) => group.trim()).filter((group) => group.length > 0 && group.length <= 256).map((group) => `${normalizedIssuer}:${group}`))].sort();
}
function audit(actorUserId: string, action: string, resourceType: string, resourceId: string) { return { id: `audit_${crypto.randomUUID()}`, actorUserId, action, resourceType, resourceId, createdAt: new Date().toISOString() }; }
function adminReason(value: string): string { const reason = value.trim(); if (reason.length < 8 || reason.length > 500) throw new ApiError(400, "admin_reason_invalid", "Provide a reason between 8 and 500 characters"); return reason; }
function cookie(request: Request, name: string): string | undefined { return request.headers.get("cookie")?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1); }
