import type { AccountUser, PlatformRole, TeamRole } from "@fastwrite/shared";
import { ApiError } from "../http";
import type { JsonDatabase, DatabaseState } from "../storage/database";
import { requireRole, type Principal } from "./auth-service";

export interface UserInput { email: string; displayName: string; password?: string; platformRole: PlatformRole; status?: "active" | "disabled"; reason: string; }
export async function prepareLocalAccount(input: { email: string; displayName?: string; password: string }, id = `user_${crypto.randomUUID()}`) {
  const email = normalizeEmail(input.email);
  if (typeof input.password !== "string" || input.password.length < 12 || input.password.length > 1024) throw new ApiError(400, "password_length_invalid", "密码长度须为 12–1024 个字符");
  if (input.displayName !== undefined && typeof input.displayName !== "string") throw new ApiError(400, "user_input_invalid", "用户名称无效");
  const now = new Date().toISOString();
  const user: AccountUser = { id, emailNormalized: email, displayName: (input.displayName?.trim() || email.split("@")[0]!).slice(0, 100), platformRole: "user", status: "active", authzVersion: 1, createdAt: now, updatedAt: now };
  return { user, loginEmail: email, passwordHash: await Bun.password.hash(input.password, { algorithm: "argon2id" }) };
}
export function insertLocalAccount(state: DatabaseState, prepared: Awaited<ReturnType<typeof prepareLocalAccount>>) {
  const { user, passwordHash, loginEmail } = prepared;
  if (state.users.some(item => item.id === user.id || item.emailNormalized === user.emailNormalized) || state.externalIdentities.some(item => item.issuer === "fastwrite:local" && item.subject === loginEmail)) throw new ApiError(409, "account_exists", "此邮箱已有 FastWrite 账号，请使用已有账号登录后绑定");
  state.users.push(user);
  state.localCredentials.push({ userId: user.id, passwordHash });
  state.externalIdentities.push({ id: `identity_${crypto.randomUUID()}`, userId: user.id, issuer: "fastwrite:local", subject: loginEmail, email: loginEmail, createdAt: user.createdAt });
}

export class AdminUsers {
  constructor(private readonly database: JsonDatabase) {}
  async create(actor: Principal, input: UserInput) {
    requireRole(actor.user, "platform_admin"); validate(input);
    const prepared = await prepareLocalAccount({ ...input, password: input.password ?? "" });
    prepared.user.platformRole = input.platformRole; prepared.user.status = input.status ?? "active";
    return this.database.mutate(state => { insertLocalAccount(state, prepared); record(state, actor, "user.create", prepared.user.id, input.reason); return prepared.user; });
  }
  async update(actor: Principal, userId: string, input: UserInput) {
    requireRole(actor.user, "platform_admin"); validate(input);
    const email = normalizeEmail(input.email);
    const passwordHash = input.password ? (await prepareLocalAccount({ ...input, password: input.password })).passwordHash : undefined;
    return this.database.mutate(state => {
      const user = find(state, userId);
      const status = input.status ?? user.status;
      if (userId === actor.user.id && status !== "active") throw new ApiError(409, "admin_self_disable", "不能停用自己的账号");
      protectAdmin(state, user, input.platformRole, status);
      if (state.users.some(item => item.id !== userId && item.emailNormalized === email) || state.externalIdentities.some(item => item.userId !== userId && item.issuer === "fastwrite:local" && item.subject === email)) throw new ApiError(409, "account_exists", "此邮箱已有账号");
      const identity = state.externalIdentities.find(item => item.userId === userId && item.issuer === "fastwrite:local");
      if (identity) { identity.subject = email; identity.email = email; }
      if (passwordHash) {
        const credential = state.localCredentials.find(item => item.userId === userId);
        if (credential) credential.passwordHash = passwordHash; else state.localCredentials.push({ userId, passwordHash });
        if (!identity) state.externalIdentities.push({ id: `identity_${crypto.randomUUID()}`, userId, issuer: "fastwrite:local", subject: email, email, createdAt: new Date().toISOString() });
      }
      Object.assign(user, { emailNormalized: email, displayName: input.displayName.trim(), platformRole: input.platformRole, status, authzVersion: user.authzVersion + 1, updatedAt: new Date().toISOString() });
      for (const session of state.sessions) if (session.userId === userId) session.revokedAt ??= user.updatedAt;
      record(state, actor, "user.update", userId, input.reason); return user;
    });
  }
  async remove(actor: Principal, userId: string, reason: string) {
    requireRole(actor.user, "platform_admin"); validateReason(reason);
    await this.database.mutate(state => {
      const user = find(state, userId);
      if (userId === actor.user.id) throw new ApiError(409, "admin_self_delete", "不能删除自己的账号");
      protectAdmin(state, user, "user", "disabled");
      if (state.projects.some(item => item.personalOwnerUserId === userId) || state.projectMembers.some(item => item.userId === userId && item.role === "owner") || state.teamMembers.some(item => item.userId === userId && item.role === "owner" && !state.teams.some(team => team.id === item.teamId && team.personalUserId === userId))) throw new ApiError(409, "user_owns_resources", "请先转移此用户拥有的项目和团队，再删除账号");
      const personal = new Set(state.teams.filter(item => item.personalUserId === userId).map(item => item.id));
      if (state.projects.some(item => item.teamId && personal.has(item.teamId))) throw new ApiError(409, "user_owns_resources", "请先转移个人工作区中的项目，再删除账号");
      state.users = state.users.filter(item => item.id !== userId);
      state.sessions = state.sessions.filter(item => item.userId !== userId);
      state.localCredentials = state.localCredentials.filter(item => item.userId !== userId);
      state.externalIdentities = state.externalIdentities.filter(item => item.userId !== userId);
      // Retain FastCAS mappings as tombstones: remote links cannot recreate a deleted account.
      state.fastcasLinks = state.fastcasLinks.map(item => item.userId === userId ? { ...item, link: { ...item.link, state: "revoked" } } : item);
      state.teamMembers = state.teamMembers.filter(item => item.userId !== userId && !personal.has(item.teamId));
      state.teams = state.teams.filter(item => !personal.has(item.id));
      state.projectMembers = state.projectMembers.filter(item => item.userId !== userId);
      state.projectAclRules = state.projectAclRules.filter(item => !(item.subjectType === "user" && item.subjectId === userId));
      state.notifications = state.notifications.filter(item => item.userId !== userId);
      state.notificationPreferences = state.notificationPreferences.filter(item => item.userId !== userId);
      record(state, actor, "user.delete", userId, reason);
    });
  }
  teams(actor: Principal, userId: string) {
    requireRole(actor.user, "platform_admin"); const state = this.database.snapshot(); find(state, userId);
    return state.teams.filter(team => !team.personalUserId).map(team => ({ id: team.id, name: team.name, role: state.teamMembers.find(member => member.teamId === team.id && member.userId === userId)?.role ?? "" }));
  }
  async setTeam(actor: Principal, userId: string, teamId: string, role: TeamRole | "", reason: string) {
    requireRole(actor.user, "platform_admin"); validateReason(reason);
    if (!["", "owner", "admin", "member"].includes(role)) throw new ApiError(400, "team_role_invalid", "团队角色无效");
    await this.database.mutate(state => {
      const user = find(state, userId); const team = state.teams.find(item => item.id === teamId && !item.personalUserId);
      if (!team) throw new ApiError(404, "team_not_found", "团队不存在");
      const member = state.teamMembers.find(item => item.teamId === teamId && item.userId === userId);
      if (member?.role === "owner" && role !== "owner" && !state.teamMembers.some(item => item.teamId === teamId && item.userId !== userId && item.role === "owner")) throw new ApiError(409, "last_team_owner", "团队至少需要保留一位所有者");
      const now = new Date().toISOString();
      if (!role) state.teamMembers = state.teamMembers.filter(item => item !== member);
      else if (member) { member.role = role; member.updatedAt = now; delete member.idpGroupBindingIds; }
      else state.teamMembers.push({ teamId, userId, role, createdAt: now, updatedAt: now });
      user.authzVersion++; user.updatedAt = now;
      record(state, actor, "user.team.update", userId, reason, { teamId, role });
    });
  }
}
function normalizeEmail(value: string) { if (typeof value !== "string" || value.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) throw new ApiError(400, "email_invalid", "请输入有效邮箱"); return value.trim().toLowerCase(); }
function validateReason(reason: string) { if (typeof reason !== "string" || reason.trim().length < 8 || reason.trim().length > 500) throw new ApiError(400, "admin_reason_invalid", "请填写 8–500 个字符的操作原因"); }
function validate(input: UserInput) { if (!input || typeof input !== "object") throw new ApiError(400, "user_input_invalid", "请填写有效的用户资料"); validateReason(input.reason); if (!["user", "support_auditor", "platform_admin"].includes(input.platformRole) || typeof input.displayName !== "string" || !input.displayName.trim() || input.displayName.trim().length > 100 || input.status !== undefined && !["active", "disabled"].includes(input.status) || input.password !== undefined && typeof input.password !== "string") throw new ApiError(400, "user_input_invalid", "请填写有效的用户资料"); }
function find(state: DatabaseState, id: string) { const user = state.users.find(item => item.id === id); if (!user) throw new ApiError(404, "user_not_found", "用户不存在"); return user; }
function protectAdmin(state: DatabaseState, user: AccountUser, role: PlatformRole, status: string) { if (user.platformRole === "platform_admin" && user.status === "active" && (role !== "platform_admin" || status !== "active") && !state.users.some(item => item.id !== user.id && item.platformRole === "platform_admin" && item.status === "active")) throw new ApiError(409, "last_platform_admin", "至少需要保留一位有效的平台管理员"); }
function record(state: DatabaseState, actor: Principal, action: string, userId: string, reason: string, extra = {}) { state.auditEvents.push({ id: `audit_${crypto.randomUUID()}`, actorUserId: actor.user.id, action, resourceType: "user", resourceId: userId, metadata: { reason: reason.trim(), ...extra }, createdAt: new Date().toISOString() }); }
