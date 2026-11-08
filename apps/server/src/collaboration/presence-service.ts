import type { CollaboratorPresence } from "@fastwrite/shared";
import type { Principal } from "../auth/auth-service";
import type { AuthorizationService } from "../auth/authorization-service";
import { ApiError } from "../http";

const TTL = 45_000;
const palette = ["#2563eb", "#059669", "#c2410c", "#7c3aed", "#be123c"];
export class PresenceService {
  private readonly projects = new Map<string, Map<string, CollaboratorPresence>>();
  constructor(private readonly authorization: AuthorizationService) {}
  list(projectId: string, principal: Principal): CollaboratorPresence[] {
    this.authorization.requireProject(principal, projectId, "project:read");
    this.prune();
    return [...(this.projects.get(projectId)?.values() ?? [])].filter(item => this.authorization.projectPathDecision(principal, projectId, item.path, "project:read").allowed);
  }
  update(projectId: string, principal: Principal, input: { clientId?: string; path?: string; line?: number }) {
    if (typeof input.clientId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.clientId) || typeof input.path !== "string" || !input.path) throw new ApiError(400, "presence_invalid", "clientId and path are required");
    this.authorization.requireProjectPath(principal, projectId, input.path, "project:read");
    this.prune();
    const project = this.projects.get(projectId) ?? new Map<string, CollaboratorPresence>();
    const existing = project.get(input.clientId);
    if (existing && existing.userId !== principal.user.id) throw new ApiError(409, "presence_client_in_use", "Presence client belongs to another user");
    if (!existing && project.size >= 500) throw new ApiError(429, "presence_limit", "Too many active collaborators");
    let hash = 0; for (const character of principal.user.id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    project.set(input.clientId, { clientId: input.clientId, userId: principal.user.id, name: principal.user.displayName, color: palette[hash % palette.length]!, path: input.path,
      ...(Number.isInteger(input.line) && input.line! > 0 ? { line: input.line! } : {}), updatedAt: new Date().toISOString() });
    this.projects.set(projectId, project);
    return this.list(projectId, principal);
  }
  remove(projectId: string, clientId: string, principal: Principal) {
    const project = this.projects.get(projectId);
    if (project?.get(clientId)?.userId === principal.user.id) project.delete(clientId);
    if (!project?.size) this.projects.delete(projectId);
  }
  private prune() {
    for (const [projectId, project] of this.projects) {
      for (const [id, item] of project) if (Date.now() - Date.parse(item.updatedAt) >= TTL) project.delete(id);
      if (!project.size) this.projects.delete(projectId);
    }
  }
}
