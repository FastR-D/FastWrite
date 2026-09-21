import type {
  CollaborationPersistRequest, CollaborationPersistResponse,
  HistoryWorkingComparison, HistoryChanges, HistoryCommit, HistorySummary, HistoryPage, HistoryTreeEntry, HistoryFileSide, HistoryComparison,
  FileContentResponse,
  ChangeSet,
  ChangeSetEditRequest,
  ChangeSetDecisionRequest,
  DraftOutlineSection,
  DraftPlan,
  DraftPlanResponse,
  DraftRequest,
  GithubImportRequest,
  GithubSyncResolution,
  GithubSyncRun,
  OutlineItem,
  PaperFile,
  PaperProject,
  SaveFileRequest,
  SaveFileResponse,
  ReviseRequest,
  ReviseResponse,
  ReviewReport,
  ReviewResponse,
  ReviewIssue,
  ReviewIssueStatus,
  MemoryItemStatus,
  PaperMemory,
  AgentTaskPlan,
  AgentRun,
  AgentTaskPlanResponse,
  AgentTaskRequest,
  AgentTaskSkillDescriptor,
  IssueResolution,
  CompileRecord,
  CompletionRequest,
  CompletionResponse,
  HunkFinding,
  ClaimRelation,
  UploadManifestEntry,
  UploadSession,
  PublicationTarget,
  PublicationVenueOption,
  ComplianceReport,
  TargetVenue,
  WorkingStatus,
  WorkspaceTreeNode
  ,AgentWireApi
  ,ResearchWork, ResearchRun, ProjectResearchWork, ProjectResearchWorkDetails, PaperClaim, SourceEvidence, FastReadBundleReceipt, ClaimEvidenceLink
  ,AlignmentFinding
} from "@fastwrite/shared";

export class ApiClientError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = localStorage.getItem("fastwrite.session-token");
  if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
  let response = await fetch(path, { ...init, headers });
  if (response.status === 401 && token && !path.startsWith("/api/auth/")) {
    const refreshed = await fetch("/api/auth/refresh", { method: "POST" });
    if (refreshed.ok) {
      const session = await refreshed.json() as { token: string };
      localStorage.setItem("fastwrite.session-token", session.token);
      headers.set("authorization", `Bearer ${session.token}`);
      response = await fetch(path, { ...init, headers });
    } else localStorage.removeItem("fastwrite.session-token");
  }
  if (!response.ok) {
    let body: { error?: { code?: string; message?: string; details?: unknown } } = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      // Preserve the status fallback when a proxy or server returns non-JSON.
    }
    throw new ApiClientError(response.status, body.error?.code ?? "request_failed", body.error?.message ?? `Request failed (${response.status})`, body.error?.details);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function jsonInit(method: string, body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {})
  };
}

export const api = {
  auth: {
    register: (body: { email: string; password: string; displayName?: string }) => request<{ user: { id: string; emailNormalized: string; displayName: string; platformRole: string }; token: string }>("/api/auth/register", jsonInit("POST", body)),
    login: (body: { email: string; password: string }) => request<{ user: { id: string; emailNormalized: string; displayName: string; platformRole: string }; token: string }>("/api/auth/login", jsonInit("POST", body)),
    providers: () => request<{ local: boolean; oidc: boolean; cas: boolean }>("/api/auth/providers"),
    refresh: () => request<{ user: { id: string; emailNormalized: string; displayName: string; platformRole: string }; token: string }>("/api/auth/refresh", { method: "POST" }),
    me: (signal?: AbortSignal) => request<{ id: string; emailNormalized: string; displayName: string; platformRole: string }>("/api/auth/me", signal ? { signal } : undefined),
    logout: () => request<void>("/api/auth/logout", { method: "POST" })
  },
  admin: {
    health: () => request<{ users: number; activeSessions: number; teams: number; projects: number; collaborationDocuments: number; pendingInvitations: number }>("/api/admin/health"),
    identityProviders: () => request<{ oidc: { configured: boolean; issuer?: string; redirectUri?: string; clientId?: string }; cas: { configured: boolean; serverUrl?: string; serviceUrl?: string }; local: { configured: boolean } }>("/api/admin/identity-providers"),
    users: () => request<Array<{ id: string; emailNormalized: string; displayName: string; platformRole: string; status: string; createdAt: string; updatedAt: string; activeSessionCount: number }>>("/api/admin/users"),
    audits: (limit = 100) => request<Array<{ id: string; actorUserId?: string; action: string; resourceType: string; resourceId: string; metadata?: Record<string, string>; createdAt: string }>>(`/api/admin/audit-events?limit=${limit}`),
    disableUser: (userId: string, reason: string) => request<void>(`/api/admin/users/${encodeURIComponent(userId)}/disable`, jsonInit("POST", { reason })),
    revokeSessions: (userId: string, reason: string) => request<void>(`/api/admin/users/${encodeURIComponent(userId)}/sessions/revoke`, jsonInit("POST", { reason })),
    updatePlatformRole: (userId: string, role: "platform_admin" | "support_auditor" | "user", reason: string) => request<{ id: string; platformRole: string }>(`/api/admin/users/${encodeURIComponent(userId)}/platform-role`, jsonInit("PATCH", { role, reason }))
  },
  teams: {
    list: (signal?: AbortSignal) => request<Array<{ id: string; name: string; slug: string; personalUserId?: string }>>("/api/teams", signal ? { signal } : undefined),
    create: (name: string) => request<{ id: string; name: string; slug: string }>("/api/teams", jsonInit("POST", { name })),
    policy: (teamId: string) => request<{ personalHarness: boolean; allowedProviders?: Array<"codex" | "claude" | "openai-compatible">; maxConcurrentRuns?: number; dailyBudgetUsd?: number }>(`/api/teams/${encodeURIComponent(teamId)}/harness-policy`),
    updatePolicy: (teamId: string, body: { personalHarness: boolean; allowedProviders?: Array<"codex" | "claude" | "openai-compatible">; maxConcurrentRuns?: number; dailyBudgetUsd?: number }) => request<unknown>(`/api/teams/${encodeURIComponent(teamId)}/harness-policy`, jsonInit("PATCH", body)),
    groupBindings: (teamId: string) => request<Array<{ id: string; idpGroup: string; role: "admin" | "member" }>>(`/api/teams/${encodeURIComponent(teamId)}/group-bindings`),
    saveGroupBinding: (teamId: string, bindingId: string, body: { idpGroup: string; role: "admin" | "member" }) => request<unknown>(`/api/teams/${encodeURIComponent(teamId)}/group-bindings/${encodeURIComponent(bindingId)}`, jsonInit("PUT", body)),
    deleteGroupBinding: (teamId: string, bindingId: string) => request<void>(`/api/teams/${encodeURIComponent(teamId)}/group-bindings/${encodeURIComponent(bindingId)}`, { method: "DELETE" }),
    previewGroupBindings: (teamId: string, groups: string[]) => request<Array<{ id: string; idpGroup: string; role: "admin" | "member" }>>(`/api/teams/${encodeURIComponent(teamId)}/group-bindings/preview`, jsonInit("POST", { groups })),
    invite: (teamId: string, body: { email: string; role: "admin" | "member"; expiresAt?: string; message?: string }) => request<{ invitation: { id: string; expiresAt: string; message?: string }; token: string }>(`/api/teams/${encodeURIComponent(teamId)}/invitations`, jsonInit("POST", body)),
    members: (teamId: string) => request<{ members: Array<{ userId: string; role: "owner" | "admin" | "member"; user: { id: string; displayName: string; emailNormalized: string } }>; canManage: boolean; canManageInvitations: boolean }>(`/api/teams/${encodeURIComponent(teamId)}/members`),
    updateMember: (teamId: string, userId: string, role: "admin" | "member") => request<unknown>(`/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`, jsonInit("PATCH", { role })),
    removeMember: (teamId: string, userId: string) => request<void>(`/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" }),
    invitations: (teamId: string) => request<Array<{ id: string; emailNormalized: string; role: string; expiresAt: string; message?: string; createdAt: string; acceptedAt?: string; revokedAt?: string }>>(`/api/teams/${encodeURIComponent(teamId)}/invitations`),
    resendInvitation: (invitationId: string) => request<{ token: string }>(`/api/invitations/${encodeURIComponent(invitationId)}/resend`, { method: "POST" }),
    revokeInvitation: (invitationId: string) => request<void>(`/api/invitations/${encodeURIComponent(invitationId)}`, { method: "DELETE" })
  },
  invitations: {
    accept: (token: string) => request<unknown>(`/api/invitations/${encodeURIComponent(token)}/accept`, { method: "POST" })
  },
  notifications: {
    list: () => request<Array<{ id: string; type: string; title: string; body?: string; projectId?: string; accessRequestId?: string; readAt?: string; createdAt: string }>>("/api/notifications"),
    markRead: (id: string) => request<unknown>(`/api/notifications/${encodeURIComponent(id)}/read`, { method: "POST" }),
    preferences: () => request<Array<{ type: "access_request" | "access_request_decision" | "mention"; inApp: boolean; email: boolean }>>("/api/notification-preferences"),
    updatePreference: (type: "access_request" | "access_request_decision" | "mention", input: { inApp?: boolean; email?: boolean }) => request<unknown>(`/api/notification-preferences/${encodeURIComponent(type)}`, { method: "PUT", body: JSON.stringify(input) })
  },
  harness: {
    sessions: (signal?: AbortSignal) => request<Array<{ harness: string; sessionId: string; cwd: string; title?: string; createdAt: string; updatedAt: string }>>("/api/harness-sessions", signal ? { signal } : undefined),
    createSession: (kind: string, body: { cwd: string; title?: string }) => request<{ harness: string; sessionId: string; cwd: string }>(`/api/harnesses/${encodeURIComponent(kind)}/sessions`, jsonInit("POST", body)),
    resumeSession: (kind: string, sessionId: string, cwd: string) => request<{ harness: string; sessionId: string; cwd: string }>(`/api/harnesses/${encodeURIComponent(kind)}/sessions/${encodeURIComponent(sessionId)}/resume`, jsonInit("POST", { cwd })),
    sendMessage: (kind: string, sessionId: string, body: { cwd: string; content: string; skills?: Array<{ id: string; name: string; path: string; version: string }> }, signal?: AbortSignal) => request<{ sessionId: string; events: unknown[] }>(`/api/harnesses/${encodeURIComponent(kind)}/sessions/${encodeURIComponent(sessionId)}/messages`, jsonInit("POST", body, signal)),
    list: (signal?: AbortSignal) => request<Array<{ status: { kind: string; state: string; message?: string }; capabilities: Record<string, boolean> }>>("/api/harnesses", signal ? { signal } : undefined),
    runs: (signal?: AbortSignal) => request<Array<{ id: string; status: string; session: { harness: string; sessionId: string; cwd: string }; events: unknown[]; createdAt: string; updatedAt: string }>>("/api/harness-runs", signal ? { signal } : undefined),
    createRun: (body: { kind: "claude" | "codex"; sessionId: string; cwd: string; content: string; skills?: Array<{ id: string; name: string; path: string; version: string }> }, signal?: AbortSignal) => request<{ events: unknown[] }>("/api/harness-runs", jsonInit("POST", body, signal)),
    getRun: (runId: string, signal?: AbortSignal) => request<{ id: string; status: string; events: unknown[] }>(`/api/harness-runs/${encodeURIComponent(runId)}`, signal ? { signal } : undefined),
    events: (runId: string, since = 0, limit = 2000, signal?: AbortSignal) => request<unknown[]>(`/api/harness-runs/${encodeURIComponent(runId)}/events?since=${since}&limit=${limit}`, signal ? { signal } : undefined),
    mcp: (signal?: AbortSignal) => request<Array<{ id: string; name: string; version: string; enabled: boolean; tools: Array<{ name: string; description: string }> }>>("/api/mcp", signal ? { signal } : undefined),
    mcpAudit: (projectId?: string, signal?: AbortSignal) => request<Array<{ id: string; projectId: string; tool: string; status: string; durationMs: number; createdAt: string }>>(`/api/mcp/audit${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`, signal ? { signal } : undefined),
    workflowSkills: (signal?: AbortSignal) => request<Array<{ id: string; version: string }>>("/api/skills/workflows", signal ? { signal } : undefined)
    ,approvals: (runId: string, signal?: AbortSignal) => request<Array<{ id: string; status: string; reason: string }>>(`/api/harness-runs/${encodeURIComponent(runId)}/approvals`, signal ? { signal } : undefined),
    decideApproval: (approvalId: string, decision: "approved" | "denied") => request<{ id: string; status: string }>(`/api/harness-approvals/${encodeURIComponent(approvalId)}`, jsonInit("POST", { decision }))
  },
  shared: {
    get: (token: string) => request<{ project: { id: string; name: string; mainDocument: string; version: number }; permission: "read" | "comment"; tree: WorkspaceTreeNode[]; comments: Array<{ id: string; path: string; line?: number; author: string; body: string; status: "open" | "resolved"; createdAt: string }> }>(`/api/shared/${encodeURIComponent(token)}`),
    file: (token: string, path: string) => request<{ path: string; content: string; version: number }>(`/api/shared/${encodeURIComponent(token)}/file?path=${encodeURIComponent(path)}`),
    comment: (token: string, body: { path: string; line?: number; author: string; body: string }) => request<{ id: string }>(`/api/shared/${encodeURIComponent(token)}/comments`, jsonInit("POST", body))
  },
  agentSettings: {
    get: (signal?: AbortSignal) => request<{ configured: boolean; harness?: "claude" | "codex"; source: "runtime" | "environment" | "none"; baseURL?: string; model?: string; wireAPI: AgentWireApi }>("/api/harness-settings", signal ? { signal } : undefined),
    save: (body: { apiKey: string; baseURL?: string; model?: string; wireAPI: AgentWireApi }) => request<{ configured: boolean; source: "runtime" | "environment" | "none"; baseURL?: string; model?: string; wireAPI: AgentWireApi }>("/api/harness-settings", jsonInit("PUT", body))
  },
  venues: {
    list: (signal?: AbortSignal) => request<PublicationVenueOption[]>("/api/venues", signal ? { signal } : undefined)
  },
  agentSkills: { list: (signal?: AbortSignal) => request<AgentTaskSkillDescriptor[]>("/api/agent-skills", signal ? { signal } : undefined) },
  projects: {
    accessRequestInfo: (id: string) => request<{ id: string; name: string }>(`/api/access-requests/${encodeURIComponent(id)}`),
    requestAccess: (id: string, body: { role: "maintainer" | "editor" | "commenter" | "viewer"; message?: string }) => request<{ id: string; status: "pending" }>(`/api/projects/${encodeURIComponent(id)}/access-requests`, jsonInit("POST", body)),
    list: (signal?: AbortSignal) => request<PaperProject[]>("/api/projects", signal ? { signal } : undefined),
    get: (id: string, signal?: AbortSignal) => request<PaperProject>(`/api/projects/${id}`, signal ? { signal } : undefined),
    create: (body: { name: string; mainDocument?: string; venue?: TargetVenue; publicationTarget?: PublicationTarget; initializeFromTemplate?: boolean; teamId?: string }) => request<PaperProject>("/api/projects", jsonInit("POST", body)),
    update: (id: string, body: Partial<Pick<PaperProject, "name" | "mainDocument">> & { venue?: TargetVenue; publicationTarget?: PublicationTarget | null }) => request<PaperProject>(`/api/projects/${id}`, jsonInit("PATCH", body)),
    exportUrl: (id: string) => `/api/projects/${id}/export`,
    checkpoint: (id: string) => request<{ createdAt: string }>(`/api/projects/${id}/history/checkpoint`, { method: "POST" }),
    history: (id: string, limit = 50, signal?: AbortSignal) => request<HistoryCommit[]>(`/api/projects/${id}/history?limit=${limit}`, signal ? { signal } : undefined),
    historySummary: (id: string, oid: string, signal?: AbortSignal) => request<HistorySummary>(`/api/projects/${id}/history/${encodeURIComponent(oid)}`, signal ? { signal } : undefined),
    historyPage: (id: string, options: { cursor?: string; path?: string; limit?: number } = {}, signal?: AbortSignal) => {
      const query = new URLSearchParams();
      if (options.cursor) query.set("cursor", options.cursor);
      if (options.path) query.set("path", options.path);
      if (options.limit !== undefined) query.set("limit", String(options.limit));
      return request<HistoryPage>(`/api/projects/${id}/history-page?${query}`, signal ? { signal } : undefined);
    },
    historyTree: (id: string, oid: string, signal?: AbortSignal) => request<HistoryTreeEntry[]>(`/api/projects/${id}/history/${encodeURIComponent(oid)}/tree`, signal ? { signal } : undefined),
    historySide: (id: string, oid: string, path: string, signal?: AbortSignal) => request<HistoryFileSide>(`/api/projects/${id}/history/${encodeURIComponent(oid)}/side?path=${encodeURIComponent(path)}`, signal ? { signal } : undefined),
    workingStatus: (id: string, signal?: AbortSignal) =>
      request<WorkingStatus>(`/api/projects/${id}/history/working-status`, signal ? { signal } : undefined),
    stagePaths: (id: string, paths: string[]) =>
      request<void>(`/api/projects/${id}/history/stage`, jsonInit("POST", { paths })),
    unstagePaths: (id: string, paths: string[]) =>
      request<void>(`/api/projects/${id}/history/unstage`, jsonInit("POST", { paths })),
    discardPaths: (id: string, paths: string[]) =>
      request<void>(`/api/projects/${id}/history/discard`, jsonInit("POST", { paths })),
    commitWorking: (id: string, message: string) =>
      request<{ oid: string }>(`/api/projects/${id}/history/commit`, jsonInit("POST", { message })),
    historyWorkingCompare: (id: string, baseRef: string, path: string, projectVersion: number, oldPath?: string, signal?: AbortSignal) => request<HistoryWorkingComparison>(`/api/projects/${id}/history-working-compare?${new URLSearchParams({ baseRef, path, projectVersion: String(projectVersion), ...(oldPath ? { oldPath } : {}) })}`, signal ? { signal } : undefined),
    historyChanges: (id: string, baseRef: string, targetRef: string, signal?: AbortSignal) => request<HistoryChanges>(`/api/projects/${id}/history-changes?${new URLSearchParams({ baseRef, targetRef })}`, signal ? { signal } : undefined),
    historyCompare: (id: string, baseRef: string, targetRef: string, path: string, oldPath?: string, signal?: AbortSignal) => {
      const query = new URLSearchParams({ baseRef, targetRef, path, ...(oldPath ? { oldPath } : {}) });
      return request<HistoryComparison>(`/api/projects/${id}/history-compare?${query}`, signal ? { signal } : undefined);
    },
    historyFile: (id: string, oid: string, path: string, signal?: AbortSignal) => request<{ path: string; content: string }>(`/api/projects/${id}/history/${encodeURIComponent(oid)}/file?path=${encodeURIComponent(path)}`, signal ? { signal } : undefined),
    restoreHistory: (id: string, oid: string, paths: string[], expectedVersion?: number) => request<{ oid?: string; restored: string[] }>(`/api/projects/${id}/history/${encodeURIComponent(oid)}/restore`, jsonInit("POST", { paths, ...(expectedVersion !== undefined ? { expectedVersion } : {}) })),
    provenance: (id: string, signal?: AbortSignal) => request<unknown>(`/api/projects/${id}/provenance`, signal ? { signal } : undefined),
    createShare: (id: string, permission: "read" | "comment") => request<{ id: string; token: string; permission: "read" | "comment"; createdAt: string }>(`/api/projects/${id}/shares`, jsonInit("POST", { permission })),
    shares: (id: string) => request<Array<{ id: string; permission: "read" | "comment"; label?: string; expiresAt?: string; revokedAt?: string; createdAt: string }>>(`/api/projects/${id}/shares`),
    revokeShare: (id: string, shareId: string) => request<void>(`/api/projects/${id}/shares/${shareId}`, { method: "DELETE" }),
    collaboration: (id: string, path: string) => request<{ documentId: string; path: string; fileVersion: number; update: string; presence: Array<{ clientId: string; name: string; color?: string; path: string; line?: number; updatedAt: string }> }>(`/api/projects/${id}/collaboration?path=${encodeURIComponent(path)}`),
    collaborationPersist: (id: string, body: CollaborationPersistRequest) => request<CollaborationPersistResponse>(`/api/projects/${id}/collaboration/persist`, jsonInit("POST", body)),
    collaborationFlush: (id: string, path: string) => request<FileContentResponse>(`/api/projects/${id}/collaboration/flush`, jsonInit("POST", { path })),
    collaborationUpdate: (id: string, body: { path: string; update: string; baseVersion: number; clientId: string; name: string; color?: string; line?: number }) => request<{ documentId: string; path: string; fileVersion: number; update: string; presence: Array<{ clientId: string; name: string; color?: string; path: string; line?: number; updatedAt: string }> }>(`/api/projects/${id}/collaboration`, jsonInit("POST", body)),
    collaborationPresence: (id: string, body: { clientId: string; name: string; path: string; line?: number; color?: string }) => request<Array<{ clientId: string; name: string; color?: string; path: string; line?: number; updatedAt: string }>>(`/api/projects/${id}/collaboration/presence`, jsonInit("POST", body)),
    collaborationToken: (projectId: string, path: string) => request<{ token: string; expiresAt: string; projectId: string; path: string; scope: "read" | "write" }>("/api/collaboration/tokens", jsonInit("POST", { projectId, path })),
    acl: (id: string) => request<Array<{ id: string; pathPrefix: string; subjectType: "user" | "project_role" | "team_role" | "idp_group"; subjectId: string; action: "read" | "comment" | "edit" | "manage" | "run_ai" | "manage_harness" | "export" | "sync_github"; effect: "allow" | "deny" }>>(`/api/projects/${encodeURIComponent(id)}/acl`),
    saveAcl: (projectId: string, ruleId: string, body: { pathPrefix: string; subjectType: "user" | "project_role" | "team_role" | "idp_group"; subjectId: string; action: "read" | "comment" | "edit" | "manage" | "run_ai" | "manage_harness" | "export" | "sync_github"; effect: "allow" | "deny" }) => request<unknown>(`/api/projects/${encodeURIComponent(projectId)}/acl/${encodeURIComponent(ruleId)}`, jsonInit("PUT", body)),
    deleteAcl: (projectId: string, ruleId: string) => request<void>(`/api/projects/${encodeURIComponent(projectId)}/acl/${encodeURIComponent(ruleId)}`, { method: "DELETE" }),
    comments: (id: string, signal?: AbortSignal) => request<Array<{ id: string; path: string; quote: string; status: "open" | "resolved" | "orphaned"; anchorStatus: "attached" | "orphaned"; from?: number; to?: number; messages: Array<{ id: string; authorUserId: string; body: string; mentionedUserIds?: string[]; createdAt: string }> }>>(`/api/projects/${id}/comments`, signal ? { signal } : undefined),
    createComment: (id: string, body: { path: string; from: number; to: number; body: string }) => request<unknown>(`/api/projects/${id}/comments`, jsonInit("POST", body)),
    replyComment: (id: string, threadId: string, body: string) => request<unknown>(`/api/projects/${id}/comments/${encodeURIComponent(threadId)}/messages`, jsonInit("POST", { body })),
    updateComment: (id: string, threadId: string, status: "open" | "resolved") => request<unknown>(`/api/projects/${id}/comments/${encodeURIComponent(threadId)}`, jsonInit("PATCH", { status })),
    reanchorComment: (id: string, threadId: string, body: { path: string; from: number; to: number }) => request<unknown>(`/api/projects/${id}/comments/${encodeURIComponent(threadId)}/reanchor`, jsonInit("POST", body)),
    invite: (id: string, body: { email: string; role: "maintainer" | "editor" | "commenter" | "viewer"; expiresAt?: string; message?: string }) => request<{ invitation: { id: string; expiresAt: string; message?: string }; token: string }>(`/api/projects/${id}/invitations`, jsonInit("POST", body)),
    invitations: (id: string) => request<Array<{ id: string; emailNormalized: string; role: string; expiresAt: string; message?: string; createdAt: string; acceptedAt?: string; revokedAt?: string }>>(`/api/projects/${id}/invitations`),
    resendInvitation: (invitationId: string) => request<{ invitation: { id: string; expiresAt: string }; token: string }>(`/api/invitations/${encodeURIComponent(invitationId)}/resend`, { method: "POST" }),
    revokeInvitation: (invitationId: string) => request<void>(`/api/invitations/${encodeURIComponent(invitationId)}`, { method: "DELETE" }),
    members: (id: string) => request<{ members: Array<{ userId: string; role: "owner" | "maintainer" | "editor" | "commenter" | "viewer"; createdAt: string; user: { displayName: string; emailNormalized: string } }>; canManage: boolean }>(`/api/projects/${id}/members`),
    updateMember: (id: string, userId: string, role: "maintainer" | "editor" | "commenter" | "viewer") => request<unknown>(`/api/projects/${id}/members/${encodeURIComponent(userId)}`, jsonInit("PATCH", { role })),
    removeMember: (id: string, userId: string) => request<void>(`/api/projects/${id}/members/${encodeURIComponent(userId)}`, { method: "DELETE" }),
    accessRequests: (id: string) => request<Array<{ id: string; requesterUserId: string; requester: { id: string; displayName: string; emailNormalized: string }; requestedRole: "maintainer" | "editor" | "commenter" | "viewer"; message?: string; status: "pending" | "approved" | "rejected"; createdAt: string }>>(`/api/projects/${id}/access-requests`),
    audit: (id: string) => request<Array<{ id: string; action: string; resourceType: string; resourceId: string; actorUserId?: string; createdAt: string }>>(`/api/projects/${id}/audit`),
    decideAccessRequest: (id: string, requestId: string, approved: boolean) => request<unknown>(`/api/projects/${id}/access-requests/${encodeURIComponent(requestId)}/decision`, jsonInit("POST", { approved })),
    tree: (id: string, signal?: AbortSignal) => request<WorkspaceTreeNode[]>(`/api/projects/${id}/files`, signal ? { signal } : undefined),
    treeLevel: (id: string, directory = "", signal?: AbortSignal) => request<WorkspaceTreeNode[]>(`/api/projects/${id}/files?directory=${encodeURIComponent(directory)}`, signal ? { signal } : undefined),
    outline: (id: string, signal?: AbortSignal) => request<OutlineItem[]>(`/api/projects/${id}/outline`, signal ? { signal } : undefined),
    search: (id: string, query: string, signal?: AbortSignal) => request<{ query: string; matches: Array<{ path: string; line: number; excerpt: string }>; truncated: boolean }>(`/api/projects/${id}/search?query=${encodeURIComponent(query)}`, signal ? { signal } : undefined),
    readFile: (id: string, path: string, signal?: AbortSignal) => request<FileContentResponse>(`/api/projects/${id}/file?path=${encodeURIComponent(path)}`, signal ? { signal } : undefined),
    saveFile: (id: string, path: string, body: SaveFileRequest, signal?: AbortSignal) => request<SaveFileResponse>(`/api/projects/${id}/file?path=${encodeURIComponent(path)}`, jsonInit("PUT", body, signal)),
    createFile: (id: string, path: string, content = "") => request<PaperFile>(`/api/projects/${id}/files`, jsonInit("POST", { path, content })),
    addFile: (id: string, path: string, file: File, signal?: AbortSignal) => request<PaperFile>(`/api/projects/${id}/assets?path=${encodeURIComponent(path)}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: file, ...(signal ? { signal } : {}) }),
    renameFile: (id: string, from: string, to: string) => request<void>(`/api/projects/${id}/files`, jsonInit("PATCH", { from, to })),
    deleteFile: (id: string, path: string) => request<void>(`/api/projects/${id}/files?path=${encodeURIComponent(path)}`, { method: "DELETE" })
    ,delete: (id: string) => request<void>(`/api/projects/${id}`, { method: "DELETE" })
  },
  uploads: {
    create: (body: { projectName: string; mainDocument: string; venue: string; publicationTarget?: PublicationTarget; sourceName: string; entries: UploadManifestEntry[] }, signal?: AbortSignal) => request<UploadSession>("/api/upload-sessions", jsonInit("POST", body, signal)),
    file: (id: string, path: string, file: File, signal?: AbortSignal) => request<UploadSession>(`/api/upload-sessions/${id}/files?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: file,
      ...(signal ? { signal } : {})
    }),
    complete: (id: string, signal?: AbortSignal) => request<PaperProject>(`/api/upload-sessions/${id}/complete`, { method: "POST", ...(signal ? { signal } : {}) }),
    cancel: (id: string) => request<void>(`/api/upload-sessions/${id}`, { method: "DELETE" })
  },
  github: {
    import: (body: GithubImportRequest, signal?: AbortSignal) => request<PaperProject>("/api/project-imports/github", jsonInit("POST", body, signal)),
    startSync: (projectId: string, signal?: AbortSignal) => request<GithubSyncRun>(`/api/projects/${projectId}/github-sync`, { method: "POST", ...(signal ? { signal } : {}) }),
    resolveSync: (projectId: string, syncId: string, resolutions: GithubSyncResolution[]) => request<GithubSyncRun>(`/api/projects/${projectId}/github-sync/${syncId}/resolve`, jsonInit("POST", { resolutions })),
    finalizeSync: (projectId: string, syncId: string) => request<GithubSyncRun>(`/api/projects/${projectId}/github-sync/${syncId}/finalize`, { method: "POST" })
  },
  revisions: {
    propose: (projectId: string, body: ReviseRequest, signal?: AbortSignal) => request<ReviseResponse>(`/api/projects/${projectId}/revisions`, jsonInit("POST", body, signal)),
    accept: (projectId: string, changeSetId: string) => request<ChangeSet>(`/api/projects/${projectId}/change-sets/${changeSetId}/accept`, { method: "POST" }),
    reject: (projectId: string, changeSetId: string) => request<ChangeSet>(`/api/projects/${projectId}/change-sets/${changeSetId}/reject`, { method: "POST" }),
    rollback: (projectId: string, changeSetId: string, resolutions?: Array<{ path: string; currentVersion: number; content: string }>) => request<ChangeSet>(`/api/projects/${projectId}/change-sets/${changeSetId}/rollback`, resolutions?.length ? jsonInit("POST", { resolutions }) : { method: "POST" }),
    get: (projectId: string, changeSetId: string, signal?: AbortSignal) => request<ChangeSet>(`/api/projects/${projectId}/change-sets/${changeSetId}`, signal ? { signal } : undefined),
    edit: (projectId: string, changeSetId: string, body: ChangeSetEditRequest) => request<ChangeSet>(`/api/projects/${projectId}/change-sets/${changeSetId}`, jsonInit("PATCH", body)),
    decide: (projectId: string, changeSetId: string, body: ChangeSetDecisionRequest) => request<ChangeSet>(`/api/projects/${projectId}/change-sets/${changeSetId}/decide`, jsonInit("POST", body)),
    finish: (projectId: string, changeSetId: string) => request<ChangeSet>(`/api/projects/${projectId}/change-sets/${changeSetId}/finish`, { method: "POST" })
  },
  drafts: {
    list: (projectId: string, signal?: AbortSignal) => request<DraftPlan[]>(`/api/projects/${projectId}/drafts`, signal ? { signal } : undefined),
    plan: (projectId: string, body: DraftRequest, signal?: AbortSignal) => request<DraftPlanResponse>(`/api/projects/${projectId}/drafts`, jsonInit("POST", body, signal)),
    confirm: (projectId: string, planId: string, outline: DraftOutlineSection[], signal?: AbortSignal) => request<DraftPlanResponse & { changeSet: ChangeSet }>(`/api/projects/${projectId}/drafts/${planId}/confirm`, jsonInit("POST", { outline }, signal)),
    cancel: (projectId: string, planId: string) => request<DraftPlan>(`/api/projects/${projectId}/drafts/${planId}/cancel`, { method: "POST" })
  },
  reviews: {
    list: (projectId: string, signal?: AbortSignal) => request<ReviewReport[]>(`/api/projects/${projectId}/reviews`, signal ? { signal } : undefined),
    run: (projectId: string, sourceOnly: boolean, signal?: AbortSignal, preview?: { pageText: string[]; projectVersion: number }) => request<ReviewResponse>(`/api/projects/${projectId}/reviews`, jsonInit("POST", { sourceOnly, ...(!sourceOnly ? preview : {}) }, signal)),
    updateIssue: (projectId: string, issueId: string, body: { status?: ReviewIssueStatus; priority?: number; reason?: string }) => request<ReviewIssue>(`/api/projects/${projectId}/review-issues/${issueId}`, jsonInit("PATCH", body)),
    createIssue: (projectId: string, body: Pick<ReviewIssue, "category" | "severity" | "title" | "rationale" | "impact" | "suggestion"> & { reportId?: string }) => request<ReviewIssue>(`/api/projects/${projectId}/review-issues`, jsonInit("POST", body)),
    mergeIssues: (projectId: string, masterId: string, duplicateIds: string[], reason?: string) => request<ReviewIssue>(`/api/projects/${projectId}/review-issues/${masterId}/merge`, jsonInit("POST", { duplicateIds, ...(reason ? { reason } : {}) }))
  },
  memory: {
    get: (projectId: string, signal?: AbortSignal) => request<PaperMemory | null>(`/api/projects/${projectId}/memory`, signal ? { signal } : undefined),
    extract: (projectId: string, signal?: AbortSignal) => request<PaperMemory>(`/api/projects/${projectId}/memory/extract`, { method: "POST", ...(signal ? { signal } : {}) }),
    apply: (projectId: string) => request<PaperMemory>(`/api/projects/${projectId}/memory/apply`, { method: "POST" }),
    updateOverview: (projectId: string, body: { content: string; locked?: boolean }) => request<PaperMemory>(`/api/projects/${projectId}/memory/overview`, jsonInit("PATCH", body)),
    acceptOverviewCandidate: (projectId: string) => request<PaperMemory>(`/api/projects/${projectId}/memory/overview/accept`, { method: "POST" }),
    updateSection: (projectId: string, sectionId: string, body: { content: string; locked?: boolean }) => request<PaperMemory>(`/api/projects/${projectId}/memory/sections/${encodeURIComponent(sectionId)}`, jsonInit("PATCH", body)),
    acceptSectionCandidate: (projectId: string, sectionId: string) => request<PaperMemory>(`/api/projects/${projectId}/memory/sections/${encodeURIComponent(sectionId)}/accept`, { method: "POST" }),
    updateItem: (projectId: string, itemId: string, body: { status?: MemoryItemStatus; content?: string; label?: string }) => request<PaperMemory>(`/api/projects/${projectId}/memory/items/${itemId}`, jsonInit("PATCH", body)),
    acceptItemCandidate: (projectId: string, itemId: string) => request<PaperMemory>(`/api/projects/${projectId}/memory/items/${itemId}/accept`, { method: "POST" }),
    rollback: (projectId: string) => request<PaperMemory>(`/api/projects/${projectId}/memory/rollback`, { method: "POST" })
  },
  agentTasks: {
    runs: (projectId: string, signal?: AbortSignal) => request<AgentRun[]>(`/api/projects/${projectId}/agent-runs`, signal ? { signal } : undefined),
    list: (projectId: string, signal?: AbortSignal) => request<AgentTaskPlan[]>(`/api/projects/${projectId}/agent-tasks`, signal ? { signal } : undefined),
    plan: (projectId: string, body: AgentTaskRequest, signal?: AbortSignal) => request<AgentTaskPlanResponse & { resolution?: IssueResolution }>(`/api/projects/${projectId}/agent-tasks`, jsonInit("POST", body, signal)),
    confirm: (projectId: string, planId: string, signal?: AbortSignal) => request<AgentTaskPlanResponse & { changeSet: ChangeSet; resolution?: IssueResolution }>(`/api/projects/${projectId}/agent-tasks/${planId}/confirm`, { method: "POST", ...(signal ? { signal } : {}) }),
    cancel: (projectId: string, planId: string) => request<AgentTaskPlan>(`/api/projects/${projectId}/agent-tasks/${planId}/cancel`, { method: "POST" }),
    resolutions: (projectId: string, signal?: AbortSignal) => request<IssueResolution[]>(`/api/projects/${projectId}/issue-resolutions`, signal ? { signal } : undefined),
    rereview: (projectId: string, resolutionId: string, signal?: AbortSignal) => request<IssueResolution>(`/api/projects/${projectId}/issue-resolutions/${resolutionId}/rereview`, { method: "POST", ...(signal ? { signal } : {}) }),
    reopen: (projectId: string, resolutionId: string) => request<IssueResolution>(`/api/projects/${projectId}/issue-resolutions/${resolutionId}/reopen`, { method: "POST" })
  },
  compileResults: {
    latest: (projectId: string, signal?: AbortSignal) => request<CompileRecord | null>(`/api/projects/${projectId}/compile-results/latest`, signal ? { signal } : undefined),
    record: (projectId: string, body: { projectVersion: number; status: "success" | "error"; summary: string }) => request<CompileRecord>(`/api/projects/${projectId}/compile-results`, jsonInit("POST", body))
  },
  compiler: {
    compileOnServer: (projectId: string, signal?: AbortSignal) => request<{ success: boolean; projectVersion: number; snapshotId: string; engine: "server"; log: string; error?: string; pdfBase64?: string; syncTexData?: string; workspacePaths: string[]; pageText?: string[] }>(`/api/projects/${projectId}/compile`, { method: "POST", ...(signal ? { signal } : {}) })
  },
  completions: {
    suggest: (projectId: string, body: CompletionRequest, signal?: AbortSignal) => request<CompletionResponse>(`/api/projects/${projectId}/completions`, jsonInit("POST", body, signal))
  },
  compliance: {
    check: (projectId: string, body: { renderedPages?: number; mainBodyPages?: number; verifyCitationsOnline?: boolean }, signal?: AbortSignal) => request<ComplianceReport>(`/api/projects/${projectId}/compliance-checks`, jsonInit("POST", body, signal))
  },
  research: {
    search: (projectId: string, query: string, signal?: AbortSignal) => request<{ run: ResearchRun; works: ResearchWork[] }>(`/api/projects/${projectId}/research-runs`, jsonInit("POST", { query }, signal)),
    confirm: (projectId: string, runId: string) => request<ResearchRun>(`/api/projects/${projectId}/research-runs/${runId}/confirm`, { method: "POST" }),
    updatePlan: (projectId: string, runId: string, queryPlan: { steps: string[]; rationale?: string }) => request<ResearchRun>(`/api/projects/${projectId}/research-runs/${runId}`, jsonInit("PATCH", queryPlan)),
    cancel: (projectId: string, runId: string) => request<ResearchRun>(`/api/projects/${projectId}/research-runs/${runId}/cancel`, { method: "POST" }),
    works: (projectId: string, signal?: AbortSignal) => request<ProjectResearchWorkDetails[]>(`/api/projects/${projectId}/research-works`, signal ? { signal } : undefined),
    fastReadBundles: (projectId: string, signal?: AbortSignal) => request<FastReadBundleReceipt[]>(`/api/projects/${projectId}/fastread-bundles`, signal ? { signal } : undefined),
    importFastReadBundles: (projectId: string, manifestPath?: string) => request<FastReadBundleReceipt[]>(`/api/projects/${projectId}/fastread-bundles/import`, jsonInit("POST", manifestPath ? { manifestPath } : {})),
    import: (projectId: string, body: { title: string; authors?: string[]; year?: number; venue?: string; doi?: string; arxiv?: string; citationKey?: string }) => request<ResearchWork>(`/api/projects/${projectId}/research-works/import`, jsonInit("POST", body)),
    approve: (projectId: string, workId: string, body: { status?: "candidate" | "saved" | "rejected"; citationKey?: string }) => request<ProjectResearchWork>(`/api/projects/${projectId}/research-works/${workId}`, jsonInit("PATCH", body)),
    verifyMetadata: (projectId: string, workId: string) => request<ResearchWork>(`/api/projects/${projectId}/research-works/${workId}/verify-metadata`, { method: "POST" }),
    citationContext: (projectId: string, key: string) => request<{ key: string; contexts: Array<{ path: string; line: number; excerpt: string }>; bibliography?: { path: string; line: number; entry: string } }>(`/api/projects/${projectId}/research-citations/${encodeURIComponent(key)}`),
    bibtexChange: (projectId: string, workId: string, targetBibPath: string) => request<ChangeSet>(`/api/projects/${projectId}/research-works/${workId}/bibtex-changes`, jsonInit("POST", { targetBibPath }))
    ,pdfEvidence: (projectId: string, workId: string, pdfBase64: string) => request<SourceEvidence[]>(`/api/projects/${projectId}/research-works/${workId}/pdf-evidence`, jsonInit("POST", { pdfBase64, authorized: true }))
  },
  claims: {
    scan: (projectId: string) => request<PaperClaim[]>(`/api/projects/${projectId}/claim-scans`, { method: "POST" }),
    list: (projectId: string) => request<PaperClaim[]>(`/api/projects/${projectId}/claims`),
    links: (projectId: string, claimId?: string) => request<ClaimEvidenceLink[]>(claimId ? `/api/projects/${projectId}/claims/${claimId}/links` : `/api/projects/${projectId}/claim-links`),
    linkEvidence: (projectId: string, claimId: string, evidenceId: string, citationKey?: string) => request<ClaimEvidenceLink>(`/api/projects/${projectId}/claims/${claimId}/links`, jsonInit("POST", { kind: "literature", evidenceId, ...(citationKey ? { citationKey } : {}) })),
    linkWaiver: (projectId: string, claimId: string, reason: string) => request<ClaimEvidenceLink>(`/api/projects/${projectId}/claims/${claimId}/links`, jsonInit("POST", { kind: "review-waiver", reason, approvedByUser: true })),
    unlinkEvidence: (projectId: string, claimId: string, linkId: string) => request<void>(`/api/projects/${projectId}/claims/${claimId}/links/${linkId}`, { method: "DELETE" }),
    reanchor: (projectId: string, claimId: string) => request<PaperClaim>(`/api/projects/${projectId}/claims/${claimId}/reanchor`, { method: "POST" }),
    update: (projectId: string, claimId: string, body: { reviewStatus?: PaperClaim["reviewStatus"] }) => request<PaperClaim>(`/api/projects/${projectId}/claims/${claimId}`, jsonInit("PATCH", body)),
    evidence: (projectId: string) => request<SourceEvidence[]>(`/api/projects/${projectId}/evidence`),
    updateEvidence: (projectId: string, evidenceId: string, status: SourceEvidence["status"]) => request<SourceEvidence>(`/api/projects/${projectId}/evidence/${evidenceId}`, jsonInit("PATCH", { status })),
    addEvidence: (projectId: string, body: { workId: string; content: string; kind?: string; locator: string; locatorType?: string; origin?: string; representation?: string }) => request<SourceEvidence>(`/api/projects/${projectId}/evidence`, jsonInit("POST", body)),
    writingChecks: (projectId: string, signal?: AbortSignal) => request<{ projectId: string; projectVersion: number; findings: HunkFinding[] }>(`/api/projects/${projectId}/writing-checks`, { method: "POST", ...(signal ? { signal } : {}) }),
    argumentGraph: (projectId: string, signal?: AbortSignal) => request<{ projectId: string; relations: ClaimRelation[] }>(`/api/projects/${projectId}/argument-graph`, signal ? { signal } : undefined),
    confirmRelation: (projectId: string, body: { fromClaimId: string; toClaimId: string; type: ClaimRelation["type"] }) => request<ClaimRelation>(`/api/projects/${projectId}/argument-graph/confirm`, jsonInit("POST", body)),
    adversarialMemo: (projectId: string, signal?: AbortSignal) => request<{ id: string; projectId: string; advisory: true; strongestRejection: string; objections: Array<{ id: string; kind: string; message: string; claimIds: string[]; anchorPaths: string[]; selectable: true }>; createdAt: string }>(`/api/projects/${projectId}/adversarial-memo`, { method: "POST", ...(signal ? { signal } : {}) })
  },
  alignment: {
    check: (projectId: string) => request<{ projectId: string; findings: AlignmentFinding[] }>(`/api/projects/${projectId}/alignment-checks`, { method: "POST" })
  }
};
