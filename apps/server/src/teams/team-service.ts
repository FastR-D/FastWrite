import { createHash, randomBytes } from "node:crypto";
import { normalizeWorkspacePath, type AccessRequest, type AccountUser, type Invitation, type NotificationPreference, type ProjectAclAction, type ProjectAclRule, type ProjectMember, type ProjectRole, type Team, type TeamGroupBinding, type TeamHarnessPolicy, type TeamMember, type TeamRole, type UserNotification, type UserNotificationType } from "@fastwrite/shared";
import { ApiError } from "../http";
import type { JsonDatabase } from "../storage/database";
import type { Principal } from "../auth/auth-service";
import { AuthorizationService } from "../auth/authorization-service";
import { createNotification, notificationPreferences } from "../notifications/notification-service";

export class TeamService {
  constructor(private readonly database: JsonDatabase, private readonly authorization: AuthorizationService) {}

  async personalWorkspace(principal: Principal): Promise<Team> {
    const existing = this.database.snapshot().teams.find((team) => team.personalUserId === principal.user.id);
    if (existing) return existing;
    const timestamp = new Date().toISOString(); const team: Team = { id: `team_${crypto.randomUUID()}`, name: `${principal.user.displayName}'s workspace`, slug: `personal-${principal.user.id.slice(-12)}`, personalUserId: principal.user.id, createdAt: timestamp, updatedAt: timestamp };
    await this.database.mutate((state) => { if (!state.teams.some((item) => item.personalUserId === principal.user.id)) { state.teams.push(team); state.teamMembers.push({ teamId: team.id, userId: principal.user.id, role: "owner", createdAt: timestamp, updatedAt: timestamp }); state.auditEvents.push(audit(principal.user.id, "workspace.personal.create", "team", team.id)); } });
    return this.database.snapshot().teams.find((item) => item.personalUserId === principal.user.id)!;
  }

  list(principal: Principal): Team[] { return this.database.snapshot().teams.filter((team) => this.database.snapshot().teamMembers.some((member) => member.teamId === team.id && member.userId === principal.user.id)); }
  policy(teamId: string, principal: Principal): TeamHarnessPolicy {
    this.authorization.requireTeamRole(principal, teamId, ["owner", "admin", "member"]);
    return structuredClone(this.database.snapshot().teams.find((team) => team.id === teamId)?.harnessPolicy ?? { personalHarness: false });
  }
  async updatePolicy(teamId: string, principal: Principal, input: Partial<TeamHarnessPolicy>): Promise<TeamHarnessPolicy> {
    this.authorization.requireTeamRole(principal, teamId, ["owner", "admin"]);
    const policy = normalizeHarnessPolicy(input);
    await this.database.mutate((state) => {
      const team = state.teams.find((item) => item.id === teamId);
      if (!team) throw new ApiError(404, "team_not_found", "Team not found");
      if (team.personalUserId) throw new ApiError(400, "team_policy_personal_workspace", "Personal workspaces do not have team Harness policies");
      team.harnessPolicy = policy; team.updatedAt = new Date().toISOString();
      state.auditEvents.push(audit(principal.user.id, "team.harness_policy.update", "team", team.id));
    });
    return policy;
  }
  async create(principal: Principal, name: string): Promise<Team> { const clean = name.trim().slice(0, 120); if (!clean) throw new ApiError(400, "team_name_required", "Team name is required"); const timestamp = new Date().toISOString(); const team: Team = { id: `team_${crypto.randomUUID()}`, name: clean, slug: slug(clean), createdAt: timestamp, updatedAt: timestamp }; await this.database.mutate((state) => { if (state.teams.some((item) => item.slug === team.slug)) throw new ApiError(409, "team_slug_taken", "A team with this name already exists"); state.teams.push(team); state.teamMembers.push({ teamId: team.id, userId: principal.user.id, role: "owner", createdAt: timestamp, updatedAt: timestamp }); state.auditEvents.push(audit(principal.user.id, "team.create", "team", team.id)); }); return team; }
  groupBindings(teamId: string, principal: Principal): TeamGroupBinding[] { this.authorization.requireTeamRole(principal, teamId, ["owner"]); return this.database.snapshot().teamGroupBindings.filter((binding) => binding.teamId === teamId).map((binding) => structuredClone(binding)); }
  previewGroupBindings(teamId: string, principal: Principal, groups: string[]): Array<Pick<TeamGroupBinding, "id" | "idpGroup" | "role">> { this.authorization.requireTeamRole(principal, teamId, ["owner"]); const claimed = new Set(groups.filter((group) => typeof group === "string").map((group) => group.trim())); return this.database.snapshot().teamGroupBindings.filter((binding) => binding.teamId === teamId && claimed.has(binding.idpGroup)).map(({ id, idpGroup, role }) => ({ id, idpGroup, role })); }
  async saveGroupBinding(teamId: string, principal: Principal, input: { id?: string; idpGroup: string; role: "admin" | "member" }): Promise<TeamGroupBinding> {
    this.authorization.requireTeamRole(principal, teamId, ["owner"]); const idpGroup = input.idpGroup.trim();
    if (!/^https:\/\/.+:.+$/.test(idpGroup) || idpGroup.length > 512) throw new ApiError(400, "team_group_binding_invalid", "Use an issuer-qualified IdP group");
    const now = new Date().toISOString(); return this.database.mutate((state) => { const existing = input.id ? state.teamGroupBindings.find((binding) => binding.id === input.id && binding.teamId === teamId) : undefined; if (input.id && !existing) throw new ApiError(404, "team_group_binding_not_found", "Team group binding not found"); if (state.teamGroupBindings.some((binding) => binding.teamId === teamId && binding.idpGroup === idpGroup && binding.id !== existing?.id)) throw new ApiError(409, "team_group_binding_exists", "This IdP group is already bound"); const binding: TeamGroupBinding = { id: existing?.id ?? `team_group_${crypto.randomUUID()}`, teamId, idpGroup, role: input.role, createdByUserId: existing?.createdByUserId ?? principal.user.id, createdAt: existing?.createdAt ?? now, updatedAt: now }; if (existing) Object.assign(existing, binding); else state.teamGroupBindings.push(binding); state.auditEvents.push(audit(principal.user.id, existing ? "team.group_binding.update" : "team.group_binding.create", "team_group_binding", binding.id)); return structuredClone(binding); });
  }
  async deleteGroupBinding(teamId: string, bindingId: string, principal: Principal): Promise<void> { this.authorization.requireTeamRole(principal, teamId, ["owner"]); await this.database.mutate((state) => { const index = state.teamGroupBindings.findIndex((binding) => binding.id === bindingId && binding.teamId === teamId); if (index < 0) throw new ApiError(404, "team_group_binding_not_found", "Team group binding not found"); state.teamGroupBindings.splice(index, 1); for (let memberIndex = state.teamMembers.length - 1; memberIndex >= 0; memberIndex -= 1) { const member = state.teamMembers[memberIndex]!; if (member.teamId !== teamId || !member.idpGroupBindingIds?.includes(bindingId)) continue; const remaining = state.teamGroupBindings.filter((binding) => binding.teamId === teamId && member.idpGroupBindingIds!.includes(binding.id)); if (!remaining.length) { state.teamMembers.splice(memberIndex, 1); continue; } member.idpGroupBindingIds = remaining.map((binding) => binding.id); member.role = remaining.some((binding) => binding.role === "admin") ? "admin" : "member"; member.updatedAt = new Date().toISOString(); } state.auditEvents.push(audit(principal.user.id, "team.group_binding.delete", "team_group_binding", bindingId)); }); }
  async syncIdpGroups(user: AccountUser, groups: string[]): Promise<void> { const groupSet = new Set(groups); const now = new Date().toISOString(); await this.database.mutate((state) => { const matching = state.teamGroupBindings.filter((binding) => groupSet.has(binding.idpGroup)); const teamBindings = new Map<string, TeamGroupBinding[]>(); for (const binding of matching) teamBindings.set(binding.teamId, [...(teamBindings.get(binding.teamId) ?? []), binding]); for (let index = state.teamMembers.length - 1; index >= 0; index -= 1) { const member = state.teamMembers[index]!; if (member.userId !== user.id || !member.idpGroupBindingIds) continue; const bindings = teamBindings.get(member.teamId) ?? []; if (!bindings.length) { state.teamMembers.splice(index, 1); continue; } member.idpGroupBindingIds = bindings.map((binding) => binding.id); member.role = bindings.some((binding) => binding.role === "admin") ? "admin" : "member"; member.updatedAt = now; teamBindings.delete(member.teamId); } for (const [teamId, bindings] of teamBindings) { if (state.teamMembers.some((member) => member.teamId === teamId && member.userId === user.id)) continue; state.teamMembers.push({ teamId, userId: user.id, role: bindings.some((binding) => binding.role === "admin") ? "admin" : "member", idpGroupBindingIds: bindings.map((binding) => binding.id), createdAt: now, updatedAt: now }); state.auditEvents.push(audit(user.id, "team.group_binding.sync", "team", teamId)); } }); }
  members(teamId: string, principal: Principal): { members: Array<TeamMember & { user: { id: string; displayName: string; emailNormalized: string } }>; canManage: boolean; canManageInvitations: boolean } {
    const role = this.authorization.requireTeamRole(principal, teamId, ["owner", "admin", "member"]);
    const state = this.database.snapshot();
    return { members: state.teamMembers.filter((item) => item.teamId === teamId).flatMap((member) => {
      const user = state.users.find((item) => item.id === member.userId);
      return user ? [{ ...member, user: { id: user.id, displayName: user.displayName, emailNormalized: user.emailNormalized } }] : [];
    }), canManage: role === "owner", canManageInvitations: role === "owner" || role === "admin" };
  }
  async updateTeamMember(teamId: string, userId: string, principal: Principal, role: Exclude<TeamRole, "owner">): Promise<TeamMember> {
    this.authorization.requireTeamRole(principal, teamId, ["owner"]);
    const now = new Date().toISOString();
    return this.database.mutate((state) => {
      const member = state.teamMembers.find((item) => item.teamId === teamId && item.userId === userId);
      if (!member) throw new ApiError(404, "team_member_not_found", "Team member not found");
      if (member.role === "owner") throw new ApiError(409, "team_owner_role_protected", "Transfer ownership before changing an owner's role");
      member.role = role; delete member.idpGroupBindingIds; member.updatedAt = now;
      state.auditEvents.push(audit(principal.user.id, "team.member.role.update", "team", teamId));
      return member;
    });
  }
  async removeTeamMember(teamId: string, userId: string, principal: Principal): Promise<void> {
    this.authorization.requireTeamRole(principal, teamId, ["owner"]);
    await this.database.mutate((state) => {
      const index = state.teamMembers.findIndex((item) => item.teamId === teamId && item.userId === userId);
      if (index < 0) throw new ApiError(404, "team_member_not_found", "Team member not found");
      if (state.teamMembers[index]!.role === "owner") throw new ApiError(409, "team_owner_remove_protected", "Transfer ownership before removing an owner");
      state.teamMembers.splice(index, 1);
      state.auditEvents.push(audit(principal.user.id, "team.member.remove", "team", teamId));
    });
  }
  projectMembers(projectId: string, principal: Principal): { members: Array<ProjectMember & { user: { id: string; displayName: string; emailNormalized: string } }>; canManage: boolean } {
    const role = this.authorization.requireProject(principal, projectId, "project:read");
    const state = this.database.snapshot();
    const members = state.projectMembers.filter((item) => item.projectId === projectId).flatMap((member) => {
      const user = state.users.find((item) => item.id === member.userId);
      return user ? [{ ...member, user: { id: user.id, displayName: user.displayName, emailNormalized: user.emailNormalized } }] : [];
    });
    return { members, canManage: role === "owner" };
  }
  async updateProjectMember(projectId: string, userId: string, principal: Principal, role: Exclude<ProjectRole, "owner">): Promise<ProjectMember> {
    this.authorization.requireProject(principal, projectId, "project:manage");
    const timestamp = new Date().toISOString();
    return this.database.mutate((state) => {
      const member = state.projectMembers.find((item) => item.projectId === projectId && item.userId === userId);
      if (!member) throw new ApiError(404, "project_member_not_found", "Project member not found");
      if (member.role === "owner") throw new ApiError(409, "project_owner_role_protected", "Transfer ownership before changing an owner's role");
      member.role = role; member.updatedAt = timestamp;
      state.auditEvents.push(audit(principal.user.id, "project.member.role.update", "project", projectId));
      return structuredClone(member);
    });
  }
  async removeProjectMember(projectId: string, userId: string, principal: Principal): Promise<void> {
    this.authorization.requireProject(principal, projectId, "project:manage");
    await this.database.mutate((state) => {
      const index = state.projectMembers.findIndex((item) => item.projectId === projectId && item.userId === userId);
      if (index < 0) throw new ApiError(404, "project_member_not_found", "Project member not found");
      if (state.projectMembers[index]!.role === "owner") throw new ApiError(409, "project_owner_remove_protected", "Transfer ownership before removing an owner");
      state.projectMembers.splice(index, 1);
      state.auditEvents.push(audit(principal.user.id, "project.member.remove", "project", projectId));
    });
  }
  projectAcl(projectId: string, principal: Principal): ProjectAclRule[] {
    this.authorization.requireProject(principal, projectId, "project:manage");
    return this.database.snapshot().projectAclRules.filter((rule) => rule.projectId === projectId).sort((left, right) => left.pathPrefix.localeCompare(right.pathPrefix) || left.id.localeCompare(right.id));
  }
  async saveProjectAclRule(projectId: string, principal: Principal, input: { id?: string; pathPrefix: string; subjectType: ProjectAclRule["subjectType"]; subjectId: string; action: ProjectAclAction; effect: "allow" | "deny" }): Promise<ProjectAclRule> {
    this.authorization.requireProject(principal, projectId, "project:manage");
    const pathPrefix = input.pathPrefix === "" ? "" : normalizeWorkspacePath(input.pathPrefix);
    if (!ACL_ACTIONS.includes(input.action) || !ACL_SUBJECT_TYPES.includes(input.subjectType) || !["allow", "deny"].includes(input.effect) || !input.subjectId.trim() || input.subjectId.length > 128) throw new ApiError(400, "project_acl_invalid", "Provide a valid ACL path, subject, action, and effect");
    if (input.subjectType === "project_role" && !PROJECT_ROLES.includes(input.subjectId as ProjectRole)) throw new ApiError(400, "project_acl_subject_invalid", "Unknown project role subject");
    if (input.subjectType === "team_role" && !TEAM_ROLES.includes(input.subjectId as TeamRole)) throw new ApiError(400, "project_acl_subject_invalid", "Unknown team role subject");
    const now = new Date().toISOString();
    return this.database.mutate((state) => {
      const existing = input.id ? state.projectAclRules.find((item) => item.id === input.id && item.projectId === projectId) : undefined;
      if (input.id && !existing) throw new ApiError(404, "project_acl_not_found", "ACL rule not found");
      const rule: ProjectAclRule = { id: existing?.id ?? `acl_${crypto.randomUUID()}`, projectId, pathPrefix, subjectType: input.subjectType, subjectId: input.subjectId.trim(), action: input.action, effect: input.effect, createdByUserId: existing?.createdByUserId ?? principal.user.id, createdAt: existing?.createdAt ?? now, updatedAt: now };
      if (existing) Object.assign(existing, rule); else state.projectAclRules.push(rule);
      state.auditEvents.push(audit(principal.user.id, existing ? "project.acl.update" : "project.acl.create", "project_acl_rule", rule.id));
      return structuredClone(rule);
    });
  }
  async deleteProjectAclRule(projectId: string, ruleId: string, principal: Principal): Promise<void> {
    this.authorization.requireProject(principal, projectId, "project:manage");
    await this.database.mutate((state) => {
      const index = state.projectAclRules.findIndex((item) => item.id === ruleId && item.projectId === projectId);
      if (index < 0) throw new ApiError(404, "project_acl_not_found", "ACL rule not found");
      state.projectAclRules.splice(index, 1); state.auditEvents.push(audit(principal.user.id, "project.acl.delete", "project_acl_rule", ruleId));
    });
  }
  async requestProjectAccess(projectId: string, principal: Principal, input: { role: Exclude<ProjectRole, "owner">; message?: string }): Promise<AccessRequest> {
    const role = input.role;
    if (!["maintainer", "editor", "commenter", "viewer"].includes(role)) throw new ApiError(400, "access_request_role_invalid", "Choose a valid project role");
    const message = input.message?.trim(); if (message && message.length > 2_000) throw new ApiError(400, "access_request_message_invalid", "Access request message must be under 2,000 characters");
    const now = new Date().toISOString(); const request: AccessRequest = { id: `access_${crypto.randomUUID()}`, projectId, requesterUserId: principal.user.id, requestedRole: role, ...(message ? { message } : {}), status: "pending", createdAt: now, updatedAt: now };
    return this.database.mutate((state) => {
      const project = state.projects.find((item) => item.id === projectId); if (!project) throw new ApiError(404, "project_not_found", "Project not found");
      if (state.projectMembers.some((member) => member.projectId === projectId && member.userId === principal.user.id)) throw new ApiError(409, "access_request_already_member", "You already have access to this project");
      if (state.accessRequests.some((item) => item.projectId === projectId && item.requesterUserId === principal.user.id && item.status === "pending")) throw new ApiError(409, "access_request_pending", "You already have a pending access request");
      state.accessRequests.push(request);
      const ownerIds = new Set(state.projectMembers.filter((member) => member.projectId === projectId && member.role === "owner").map((member) => member.userId)); if (project.personalOwnerUserId) ownerIds.add(project.personalOwnerUserId);
      for (const userId of ownerIds) createNotification(state, { userId, type: "access_request", title: `${principal.user.displayName} requested access`, ...(message ? { body: message } : {}), projectId, accessRequestId: request.id });
      state.auditEvents.push(audit(principal.user.id, "project.access_request.create", "project", projectId));
      return request;
    });
  }
  accessRequests(projectId: string, principal: Principal): Array<AccessRequest & { requester: { id: string; displayName: string; emailNormalized: string } }> {
    this.authorization.requireProject(principal, projectId, "project:invite");
    const state = this.database.snapshot();
    return state.accessRequests.filter((item) => item.projectId === projectId).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).flatMap((request) => {
      const requester = state.users.find((user) => user.id === request.requesterUserId);
      return requester ? [{ ...request, requester: { id: requester.id, displayName: requester.displayName, emailNormalized: requester.emailNormalized } }] : [];
    });
  }
  async decideAccessRequest(projectId: string, requestId: string, principal: Principal, approved: boolean): Promise<AccessRequest> {
    this.authorization.requireProject(principal, projectId, "project:invite"); const now = new Date().toISOString();
    return this.database.mutate((state) => {
      const request = state.accessRequests.find((item) => item.id === requestId && item.projectId === projectId); if (!request) throw new ApiError(404, "access_request_not_found", "Access request not found"); if (request.status !== "pending") throw new ApiError(409, "access_request_decided", "Access request has already been decided");
      request.status = approved ? "approved" : "rejected"; request.decidedByUserId = principal.user.id; request.decidedAt = now; request.updatedAt = now;
      if (approved) { const member = state.projectMembers.find((item) => item.projectId === projectId && item.userId === request.requesterUserId); if (member) { member.role = request.requestedRole; member.updatedAt = now; } else state.projectMembers.push({ projectId, userId: request.requesterUserId, role: request.requestedRole, createdAt: now, updatedAt: now }); }
      createNotification(state, { userId: request.requesterUserId, type: "access_request_decision", title: approved ? "Project access approved" : "Project access request declined", projectId, accessRequestId: request.id });
      state.auditEvents.push(audit(principal.user.id, approved ? "project.access_request.approve" : "project.access_request.reject", "project", projectId));
      return request;
    });
  }
  notifications(principal: Principal): UserNotification[] { return this.database.snapshot().notifications.filter((item) => item.userId === principal.user.id && item.inApp).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 100); }
  notificationPreferences(principal: Principal): NotificationPreference[] { return notificationPreferences(this.database.snapshot(), principal.user.id); }
  async updateNotificationPreference(principal: Principal, type: UserNotificationType, input: { inApp?: boolean; email?: boolean }): Promise<NotificationPreference> {
    if (!NOTIFICATION_TYPES.includes(type) || (typeof input.inApp !== "boolean" && typeof input.email !== "boolean")) throw new ApiError(400, "notification_preference_invalid", "Provide a notification type and at least one channel preference");
    return this.database.mutate((state) => {
      const now = new Date().toISOString();
      const existing = state.notificationPreferences.find((item) => item.userId === principal.user.id && item.type === type);
      const preference: NotificationPreference = { userId: principal.user.id, type, inApp: input.inApp ?? existing?.inApp ?? true, email: input.email ?? existing?.email ?? false, updatedAt: now };
      if (existing) Object.assign(existing, preference); else state.notificationPreferences.push(preference);
      state.auditEvents.push(audit(principal.user.id, "notification.preference.update", "notification_preference", type));
      return preference;
    });
  }
  async markNotificationRead(notificationId: string, principal: Principal): Promise<UserNotification> { return this.database.mutate((state) => { const item = state.notifications.find((candidate) => candidate.id === notificationId && candidate.userId === principal.user.id); if (!item) throw new ApiError(404, "notification_not_found", "Notification not found"); item.readAt ??= new Date().toISOString(); return item; }); }
  teamInvitations(teamId: string, principal: Principal): Array<Omit<Invitation, "tokenHash">> { this.authorization.requireTeamRole(principal, teamId, ["owner", "admin"]); return this.invitations("team", teamId); }
  projectInvitations(projectId: string, principal: Principal): Array<Omit<Invitation, "tokenHash">> { this.authorization.requireProject(principal, projectId, "project:invite"); return this.invitations("project", projectId); }
  async inviteTeam(teamId: string, principal: Principal, email: string, role: TeamRole, options?: InvitationOptions): Promise<{ invitation: Omit<Invitation, "tokenHash">; token: string }> { this.authorization.requireTeamRole(principal, teamId, ["owner", "admin"]); if (role === "owner") throw new ApiError(400, "team_owner_invitation_forbidden", "Transfer team ownership instead of inviting an owner"); return this.invite("team", teamId, principal, email, role, options); }
  async inviteProject(projectId: string, principal: Principal, email: string, role: ProjectRole, options?: InvitationOptions): Promise<{ invitation: Omit<Invitation, "tokenHash">; token: string }> { this.authorization.requireProject(principal, projectId, "project:invite"); if (role === "owner") throw new ApiError(400, "project_owner_invitation_forbidden", "Transfer project ownership instead of inviting an owner"); return this.invite("project", projectId, principal, email, role, options); }
  async accept(token: string, principal: Principal): Promise<Invitation> { const tokenHash = hash(token); const timestamp = new Date().toISOString(); return this.database.mutate((state) => { const invitation = state.invitations.find((item) => item.tokenHash === tokenHash); if (!invitation || invitation.revokedAt || invitation.acceptedAt || invitation.expiresAt <= timestamp) throw new ApiError(404, "invitation_not_found", "Invitation is invalid or expired"); if (invitation.emailNormalized !== principal.user.emailNormalized) throw new ApiError(403, "invitation_email_mismatch", "Sign in with the invited email address"); if (invitation.resourceType === "team") { if (!state.teamMembers.some((member) => member.teamId === invitation.resourceId && member.userId === principal.user.id)) state.teamMembers.push({ teamId: invitation.resourceId, userId: principal.user.id, role: invitation.role as TeamRole, createdAt: timestamp, updatedAt: timestamp }); } else if (!state.projectMembers.some((member) => member.projectId === invitation.resourceId && member.userId === principal.user.id)) state.projectMembers.push({ projectId: invitation.resourceId, userId: principal.user.id, role: invitation.role as ProjectRole, createdAt: timestamp, updatedAt: timestamp }); invitation.acceptedAt = timestamp; state.auditEvents.push(audit(principal.user.id, "invitation.accept", invitation.resourceType, invitation.resourceId)); return invitation; }); }
  async revoke(invitationId: string, principal: Principal): Promise<void> { const invitation = this.database.snapshot().invitations.find((item) => item.id === invitationId); if (!invitation) throw new ApiError(404, "invitation_not_found", "Invitation not found"); if (invitation.resourceType === "team") this.authorization.requireTeamRole(principal, invitation.resourceId, ["owner", "admin"]); else this.authorization.requireProject(principal, invitation.resourceId, "project:invite"); await this.database.mutate((state) => { const item = state.invitations.find((candidate) => candidate.id === invitationId); if (item) { item.revokedAt = new Date().toISOString(); state.auditEvents.push(audit(principal.user.id, "invitation.revoke", item.resourceType, item.resourceId)); } }); }
  async resend(invitationId: string, principal: Principal): Promise<{ invitation: Omit<Invitation, "tokenHash">; token: string }> {
    const existing = this.database.snapshot().invitations.find((item) => item.id === invitationId);
    if (!existing) throw new ApiError(404, "invitation_not_found", "Invitation not found");
    if (existing.resourceType === "team") this.authorization.requireTeamRole(principal, existing.resourceId, ["owner", "admin"]); else this.authorization.requireProject(principal, existing.resourceId, "project:invite");
    if (existing.acceptedAt) throw new ApiError(409, "invitation_already_accepted", "Accepted invitations cannot be resent");
    if (existing.revokedAt) throw new ApiError(409, "invitation_revoked", "Revoked invitations cannot be resent");
    await this.database.mutate((state) => { const stored = state.invitations.find((item) => item.id === invitationId); if (stored && !stored.revokedAt) { stored.revokedAt = new Date().toISOString(); state.auditEvents.push(audit(principal.user.id, "invitation.resend", stored.resourceType, stored.resourceId)); } });
    return this.invite(existing.resourceType, existing.resourceId, principal, existing.emailNormalized, existing.role, existing.message ? { message: existing.message } : undefined);
  }
  async transferProject(projectId: string, principal: Principal, input: { teamId?: string; personalOwnerUserId?: string }): Promise<void> {
    this.authorization.requireProject(principal, projectId, "project:manage");
    if (Boolean(input.teamId) === Boolean(input.personalOwnerUserId)) throw new ApiError(400, "project_transfer_invalid", "Choose exactly one team or personal owner");
    if (input.teamId) this.authorization.requireTeamRole(principal, input.teamId, ["owner", "admin"]);
    const timestamp = new Date().toISOString();
    await this.database.mutate((state) => {
      const project = state.projects.find((item) => item.id === projectId); if (!project) throw new ApiError(404, "project_not_found", "Project not found");
      if (input.personalOwnerUserId && !state.users.some((user) => user.id === input.personalOwnerUserId && user.status === "active")) throw new ApiError(404, "user_not_found", "New personal owner not found");
      if (input.teamId && !state.teams.some((team) => team.id === input.teamId && !team.personalUserId)) throw new ApiError(400, "team_invalid", "Projects can only be transferred to a non-personal team");
      delete project.teamId; delete project.personalOwnerUserId;
      if (input.teamId) { project.teamId = input.teamId; project.visibility = "team"; }
      else { project.personalOwnerUserId = input.personalOwnerUserId!; project.visibility = "private"; }
      const ownerId = input.personalOwnerUserId ?? principal.user.id;
      const member = state.projectMembers.find((item) => item.projectId === projectId && item.userId === ownerId);
      if (member) { member.role = "owner"; member.updatedAt = timestamp; } else state.projectMembers.push({ projectId, userId: ownerId, role: "owner", createdAt: timestamp, updatedAt: timestamp });
      state.auditEvents.push(audit(principal.user.id, "project.transfer", "project", projectId));
    });
  }
  private invitations(resourceType: Invitation["resourceType"], resourceId: string): Array<Omit<Invitation, "tokenHash">> {
    return this.database.snapshot().invitations
      .filter((item) => item.resourceType === resourceType && item.resourceId === resourceId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(({ tokenHash: _tokenHash, ...invitation }) => invitation);
  }
  private async invite(resourceType: "team" | "project", resourceId: string, principal: Principal, emailInput: string, role: TeamRole | ProjectRole, options?: InvitationOptions) { const emailNormalized = emailInput.trim().toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNormalized)) throw new ApiError(400, "email_invalid", "Enter a valid email address"); const expiresAt = invitationExpiry(options?.expiresAt); const message = options?.message?.trim(); if (message && message.length > 2_000) throw new ApiError(400, "invitation_message_invalid", "Invitation message must be under 2,000 characters"); const token = randomBytes(32).toString("base64url"); const timestamp = new Date().toISOString(); const invitation: Invitation = { id: `invite_${crypto.randomUUID()}`, resourceType, resourceId, emailNormalized, role, tokenHash: hash(token), invitedByUserId: principal.user.id, expiresAt, ...(message ? { message } : {}), createdAt: timestamp }; await this.database.mutate((state) => {
    const hourAgo = Date.now() - 60 * 60_000;
    const recentInvitations = state.invitations.filter((item) => Date.parse(item.createdAt) >= hourAgo);
    if (recentInvitations.filter((item) => item.invitedByUserId === principal.user.id).length >= 20) throw new ApiError(429, "invitation_rate_limited", "You have reached the hourly invitation limit");
    if (recentInvitations.filter((item) => item.resourceType === resourceType && item.resourceId === resourceId && item.emailNormalized === emailNormalized).length >= 3) throw new ApiError(429, "invitation_recipient_rate_limited", "This recipient has reached the hourly invitation limit for this resource");
    state.invitations.push(invitation); state.auditEvents.push(audit(principal.user.id, "invitation.create", resourceType, resourceId));
  }); const { tokenHash: _tokenHash, ...safe } = invitation; return { invitation: safe, token }; }
}
function slug(value: string) { return `${value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "team"}-${crypto.randomUUID().slice(0, 8)}`; }
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
interface InvitationOptions { expiresAt?: string; message?: string; }
function invitationExpiry(value?: string): string { if (!value) return new Date(Date.now() + 7 * 86400_000).toISOString(); const time = Date.parse(value); if (!Number.isFinite(time) || time < Date.now() + 3_600_000 || time > Date.now() + 30 * 86400_000) throw new ApiError(400, "invitation_expiry_invalid", "Invitation expiry must be between one hour and 30 days from now"); return new Date(time).toISOString(); }
function audit(actorUserId: string, action: string, resourceType: string, resourceId: string) { return { id: `audit_${crypto.randomUUID()}`, actorUserId, action, resourceType, resourceId, createdAt: new Date().toISOString() }; }
const NOTIFICATION_TYPES: UserNotificationType[] = ["access_request", "access_request_decision", "mention"];
const ACL_ACTIONS: ProjectAclAction[] = ["read", "comment", "edit", "manage", "run_ai", "manage_harness", "export", "sync_github"];
const ACL_SUBJECT_TYPES: ProjectAclRule["subjectType"][] = ["user", "project_role", "team_role", "idp_group"];
const PROJECT_ROLES: ProjectRole[] = ["owner", "maintainer", "editor", "commenter", "viewer"];
const TEAM_ROLES: TeamRole[] = ["owner", "admin", "member"];
function normalizeHarnessPolicy(input: Partial<TeamHarnessPolicy>): TeamHarnessPolicy {
  const providers = input.allowedProviders?.filter((provider): provider is "codex" | "claude" | "openai-compatible" => provider === "codex" || provider === "claude" || provider === "openai-compatible");
  const models = input.allowedModels?.filter((model) => typeof model === "string" && model.trim()).map((model) => model.trim().slice(0, 256));
  const tools = input.allowedTools?.filter((tool) => typeof tool === "string" && /^[a-z0-9._-]{1,120}$/i.test(tool));
  if (input.maxConcurrentRuns !== undefined && (!Number.isInteger(input.maxConcurrentRuns) || input.maxConcurrentRuns < 1 || input.maxConcurrentRuns > 100)) throw new ApiError(400, "team_policy_invalid", "maxConcurrentRuns must be between 1 and 100");
  if (input.dailyBudgetUsd !== undefined && (!Number.isFinite(input.dailyBudgetUsd) || input.dailyBudgetUsd < 0 || input.dailyBudgetUsd > 1_000_000)) throw new ApiError(400, "team_policy_invalid", "dailyBudgetUsd must be a valid non-negative amount");
  return { personalHarness: input.personalHarness === true, ...(providers?.length ? { allowedProviders: [...new Set(providers)] } : {}), ...(models?.length ? { allowedModels: [...new Set(models)] } : {}), ...(tools?.length ? { allowedTools: [...new Set(tools)] } : {}), ...(input.maxConcurrentRuns !== undefined ? { maxConcurrentRuns: input.maxConcurrentRuns } : {}), ...(input.dailyBudgetUsd !== undefined ? { dailyBudgetUsd: input.dailyBudgetUsd } : {}) };
}
