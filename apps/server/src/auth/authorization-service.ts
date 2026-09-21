import { normalizeWorkspacePath, type ProjectAclAction, type ProjectRole, type TeamRole } from "@fastwrite/shared";
import { ApiError } from "../http";
import type { JsonDatabase } from "../storage/database";
import type { Principal } from "./auth-service";

export type ProjectAction = "project:read" | "project:write" | "project:invite" | "project:manage" | "comment:write" | "compile:run" | "review:run" | "agent:propose" | "changeset:approve" | "harness:use" | "github:sync";
export type AuthorizationReasonCode = "platform_admin" | "acl_deny" | "acl_allow" | "project_role" | "default_deny";
export interface AuthorizationDecision { allowed: boolean; reasonCode: AuthorizationReasonCode; policyVersion: number; role?: ProjectRole; }

const permissions: Record<ProjectRole, ReadonlySet<ProjectAction>> = {
  owner: new Set(["project:read", "project:write", "project:invite", "project:manage", "comment:write", "compile:run", "review:run", "agent:propose", "changeset:approve", "harness:use", "github:sync"]),
  maintainer: new Set(["project:read", "project:write", "project:invite", "comment:write", "compile:run", "review:run", "agent:propose", "changeset:approve", "harness:use", "github:sync"]),
  editor: new Set(["project:read", "project:write", "comment:write", "compile:run", "review:run", "agent:propose", "harness:use"]),
  commenter: new Set(["project:read", "comment:write"]), viewer: new Set(["project:read"])
};

export class AuthorizationService {
  constructor(private readonly database: JsonDatabase) {}

  projectRole(userId: string, projectId: string): ProjectRole | undefined {
    const state = this.database.snapshot(); const project = state.projects.find((item) => item.id === projectId);
    if (!project) throw new ApiError(404, "project_not_found", "Project not found");
    if (project.personalOwnerUserId === userId) return "owner";
    const member = state.projectMembers.find((item) => item.projectId === projectId && item.userId === userId);
    if (member) return member.role;
    if (project.teamId) {
      const teamMember = state.teamMembers.find((item) => item.teamId === project.teamId && item.userId === userId);
      if (teamMember && (teamMember.role === "owner" || teamMember.role === "admin")) return "maintainer";
      if (teamMember && project.visibility === "team") return "viewer";
    }
    return undefined;
  }

  requireProject(principal: Principal, projectId: string, action: ProjectAction): ProjectRole {
    if (principal.user.platformRole === "platform_admin") return "owner";
    const role = this.projectRole(principal.user.id, projectId);
    if (!role || !permissions[role].has(action)) throw new ApiError(403, "project_access_denied", "You do not have permission to access this project");
    return role;
  }

  requireProjectPath(principal: Principal, projectId: string, path: string, action: ProjectAction): ProjectRole {
    const normalizedPath = normalizeWorkspacePath(path);
    if (principal.user.platformRole === "platform_admin") return "owner";
    const aclAction = aclActionFor(action);
    const state = this.database.snapshot();
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) throw new ApiError(404, "project_not_found", "Project not found");
    const role = this.projectRole(principal.user.id, projectId);
    if (!role) throw new ApiError(403, "project_access_denied", "You do not have permission to access this project");
    const teamRole = project.teamId ? state.teamMembers.find((item) => item.teamId === project.teamId && item.userId === principal.user.id)?.role : undefined;
    const matching = state.projectAclRules.filter((rule) => rule.projectId === projectId && (rule.action === aclAction || (rule.effect === "deny" && rule.action === "read")) && prefixMatches(rule.pathPrefix, normalizedPath) && subjectMatches(rule, principal.user.id, role, teamRole, principal.idpGroups ?? []));
    if (matching.some((rule) => rule.effect === "deny")) throw new ApiError(403, "project_path_access_denied", "You do not have permission to access this path");
    if (permissions[role].has(action) || matching.some((rule) => rule.effect === "allow")) return role;
    throw new ApiError(403, "project_path_access_denied", "You do not have permission to access this path");
  }

  projectPathDecision(principal: Principal, projectId: string, path: string, action: ProjectAction): AuthorizationDecision {
    const normalizedPath = normalizeWorkspacePath(path); const state = this.database.snapshot(); const project = state.projects.find((item) => item.id === projectId);
    if (!project) return { allowed: false, reasonCode: "default_deny", policyVersion: 1 };
    if (principal.user.platformRole === "platform_admin") return { allowed: true, reasonCode: "platform_admin", policyVersion: 1, role: "owner" };
    const role = this.projectRole(principal.user.id, projectId);
    if (!role) return { allowed: false, reasonCode: "default_deny", policyVersion: 1 };
    const aclAction = aclActionFor(action); const teamRole = project.teamId ? state.teamMembers.find((item) => item.teamId === project.teamId && item.userId === principal.user.id)?.role : undefined;
    const matching = state.projectAclRules.filter((rule) => rule.projectId === projectId && (rule.action === aclAction || (rule.effect === "deny" && rule.action === "read")) && prefixMatches(rule.pathPrefix, normalizedPath) && subjectMatches(rule, principal.user.id, role, teamRole, principal.idpGroups ?? []));
    if (matching.some((rule) => rule.effect === "deny")) return { allowed: false, reasonCode: "acl_deny", policyVersion: 1, role };
    if (matching.some((rule) => rule.effect === "allow")) return { allowed: true, reasonCode: "acl_allow", policyVersion: 1, role };
    return { allowed: permissions[role].has(action), reasonCode: permissions[role].has(action) ? "project_role" : "default_deny", policyVersion: 1, role };
  }

  requireTeamRole(principal: Principal, teamId: string, roles: TeamRole[]): TeamRole {
    const member = this.database.snapshot().teamMembers.find((item) => item.teamId === teamId && item.userId === principal.user.id);
    if (!member || !roles.includes(member.role)) throw new ApiError(403, "team_access_denied", "You do not have permission to manage this team");
    return member.role;
  }
}

function aclActionFor(action: ProjectAction): ProjectAclAction {
  if (action === "project:read") return "read";
  if (action === "project:write") return "edit";
  if (action === "comment:write") return "comment";
  if (action === "project:manage" || action === "project:invite") return "manage";
  if (action === "harness:use") return "manage_harness";
  if (action === "github:sync") return "sync_github";
  if (action === "agent:propose" || action === "review:run" || action === "changeset:approve") return "run_ai";
  return "edit";
}

function prefixMatches(prefix: string, path: string): boolean { return prefix === "" || path === prefix || path.startsWith(`${prefix}/`); }
function subjectMatches(rule: { subjectType: "user" | "project_role" | "team_role" | "idp_group"; subjectId: string }, userId: string, projectRole: ProjectRole, teamRole: TeamRole | undefined, idpGroups: string[]): boolean {
  return (rule.subjectType === "user" && rule.subjectId === userId) || (rule.subjectType === "project_role" && rule.subjectId === projectRole) || (rule.subjectType === "team_role" && rule.subjectId === teamRole) || (rule.subjectType === "idp_group" && idpGroups.includes(rule.subjectId));
}
