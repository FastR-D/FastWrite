import type {
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
  WorkspaceTreeNode
  ,AgentWireApi
  ,ResearchWork, ResearchRun, ProjectResearchWork, PaperClaim, SourceEvidence
  ,AlignmentFinding
} from "@fastwrite/shared";

export class ApiClientError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
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
  shared: {
    get: (token: string) => request<{ project: { id: string; name: string; mainDocument: string; version: number }; permission: "read" | "comment"; tree: WorkspaceTreeNode[]; comments: Array<{ id: string; path: string; line?: number; author: string; body: string; status: "open" | "resolved"; createdAt: string }> }>(`/api/shared/${encodeURIComponent(token)}`),
    file: (token: string, path: string) => request<{ path: string; content: string; version: number }>(`/api/shared/${encodeURIComponent(token)}/file?path=${encodeURIComponent(path)}`),
    comment: (token: string, body: { path: string; line?: number; author: string; body: string }) => request<{ id: string }>(`/api/shared/${encodeURIComponent(token)}/comments`, jsonInit("POST", body))
  },
  agentSettings: {
    get: (signal?: AbortSignal) => request<{ configured: boolean; source: "runtime" | "environment" | "none"; baseURL?: string; model?: string; wireAPI: AgentWireApi }>("/api/agent-settings", signal ? { signal } : undefined),
    save: (body: { apiKey: string; baseURL?: string; model?: string; wireAPI: AgentWireApi }) => request<{ configured: boolean; source: "runtime" | "environment" | "none"; baseURL?: string; model?: string; wireAPI: AgentWireApi }>("/api/agent-settings", jsonInit("PUT", body))
  },
  venues: {
    list: (signal?: AbortSignal) => request<PublicationVenueOption[]>("/api/venues", signal ? { signal } : undefined)
  },
  projects: {
    list: (signal?: AbortSignal) => request<PaperProject[]>("/api/projects", signal ? { signal } : undefined),
    get: (id: string, signal?: AbortSignal) => request<PaperProject>(`/api/projects/${id}`, signal ? { signal } : undefined),
    create: (body: { name: string; mainDocument?: string; venue?: TargetVenue; publicationTarget?: PublicationTarget; initializeFromTemplate?: boolean }) => request<PaperProject>("/api/projects", jsonInit("POST", body)),
    update: (id: string, body: Partial<Pick<PaperProject, "name" | "mainDocument">> & { venue?: TargetVenue; publicationTarget?: PublicationTarget | null }) => request<PaperProject>(`/api/projects/${id}`, jsonInit("PATCH", body)),
    exportUrl: (id: string) => `/api/projects/${id}/export`,
    checkpoint: (id: string) => request<{ createdAt: string }>(`/api/projects/${id}/history/checkpoint`, { method: "POST" }),
    history: (id: string, limit = 50, signal?: AbortSignal) => request<Array<{ oid: string; message: string; createdAt: string }>>(`/api/projects/${id}/history?limit=${limit}`, signal ? { signal } : undefined),
    historySummary: (id: string, oid: string, signal?: AbortSignal) => request<{ oid: string; message: string; createdAt: string; paths: string[] }>(`/api/projects/${id}/history/${encodeURIComponent(oid)}`, signal ? { signal } : undefined),
    historyFile: (id: string, oid: string, path: string, signal?: AbortSignal) => request<{ path: string; content: string }>(`/api/projects/${id}/history/${encodeURIComponent(oid)}/file?path=${encodeURIComponent(path)}`, signal ? { signal } : undefined),
    restoreHistory: (id: string, oid: string, paths: string[]) => request<{ oid?: string; restored: string[] }>(`/api/projects/${id}/history/${encodeURIComponent(oid)}/restore`, jsonInit("POST", { paths })),
    provenance: (id: string, signal?: AbortSignal) => request<unknown>(`/api/projects/${id}/provenance`, signal ? { signal } : undefined),
    createShare: (id: string, permission: "read" | "comment") => request<{ id: string; token: string; permission: "read" | "comment"; createdAt: string }>(`/api/projects/${id}/shares`, jsonInit("POST", { permission })),
    shares: (id: string) => request<Array<{ id: string; permission: "read" | "comment"; label?: string; expiresAt?: string; revokedAt?: string; createdAt: string }>>(`/api/projects/${id}/shares`),
    revokeShare: (id: string, shareId: string) => request<void>(`/api/projects/${id}/shares/${shareId}`, { method: "DELETE" }),
    collaboration: (id: string, path: string) => request<{ path: string; fileVersion: number; update: string; presence: Array<{ clientId: string; name: string; color?: string; path: string; line?: number; updatedAt: string }> }>(`/api/projects/${id}/collaboration?path=${encodeURIComponent(path)}`),
    collaborationUpdate: (id: string, body: { path: string; update: string; baseVersion: number; clientId: string; name: string; color?: string; line?: number }) => request<{ path: string; fileVersion: number; update: string; presence: Array<{ clientId: string; name: string; color?: string; path: string; line?: number; updatedAt: string }> }>(`/api/projects/${id}/collaboration`, jsonInit("POST", body)),
    collaborationPresence: (id: string, body: { clientId: string; name: string; path: string; line?: number; color?: string }) => request<Array<{ clientId: string; name: string; color?: string; path: string; line?: number; updatedAt: string }>>(`/api/projects/${id}/collaboration/presence`, jsonInit("POST", body)),
    tree: (id: string, signal?: AbortSignal) => request<WorkspaceTreeNode[]>(`/api/projects/${id}/files`, signal ? { signal } : undefined),
    treeLevel: (id: string, directory = "", signal?: AbortSignal) => request<WorkspaceTreeNode[]>(`/api/projects/${id}/files?directory=${encodeURIComponent(directory)}`, signal ? { signal } : undefined),
    outline: (id: string, signal?: AbortSignal) => request<OutlineItem[]>(`/api/projects/${id}/outline`, signal ? { signal } : undefined),
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
    run: (projectId: string, sourceOnly: boolean, signal?: AbortSignal) => request<ReviewResponse>(`/api/projects/${projectId}/reviews`, jsonInit("POST", { sourceOnly }, signal)),
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
    compileOnServer: (projectId: string, signal?: AbortSignal) => request<{ success: boolean; engine: "server"; log: string; error?: string; pdfBase64?: string; syncTexData?: string; workspacePaths: string[] }>(`/api/projects/${projectId}/compile`, { method: "POST", ...(signal ? { signal } : {}) })
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
    works: (projectId: string, signal?: AbortSignal) => request<Array<ResearchWork & { project: ProjectResearchWork }>>(`/api/projects/${projectId}/research-works`, signal ? { signal } : undefined),
    import: (projectId: string, body: { title: string; authors?: string[]; year?: number; venue?: string; doi?: string; arxiv?: string; citationKey?: string }) => request<ResearchWork>(`/api/projects/${projectId}/research-works/import`, jsonInit("POST", body)),
    approve: (projectId: string, workId: string, body: { status?: "candidate" | "saved" | "rejected"; citationKey?: string }) => request<ProjectResearchWork>(`/api/projects/${projectId}/research-works/${workId}`, jsonInit("PATCH", body)),
    verifyMetadata: (projectId: string, workId: string) => request<ResearchWork>(`/api/projects/${projectId}/research-works/${workId}/verify-metadata`, { method: "POST" }),
    citationContext: (projectId: string, key: string) => request<{ key: string; contexts: Array<{ path: string; line: number; excerpt: string }> }>(`/api/projects/${projectId}/research-citations/${encodeURIComponent(key)}`),
    bibtexChange: (projectId: string, workId: string, targetBibPath: string) => request<ChangeSet>(`/api/projects/${projectId}/research-works/${workId}/bibtex-changes`, jsonInit("POST", { targetBibPath }))
    ,pdfEvidence: (projectId: string, workId: string, pdfBase64: string) => request<SourceEvidence[]>(`/api/projects/${projectId}/research-works/${workId}/pdf-evidence`, jsonInit("POST", { pdfBase64, authorized: true }))
  },
  claims: {
    scan: (projectId: string) => request<PaperClaim[]>(`/api/projects/${projectId}/claim-scans`, { method: "POST" }),
    list: (projectId: string) => request<PaperClaim[]>(`/api/projects/${projectId}/claims`),
    links: (projectId: string, claimId: string) => request<unknown[]>(`/api/projects/${projectId}/claims/${claimId}/links`),
    reanchor: (projectId: string, claimId: string) => request<PaperClaim>(`/api/projects/${projectId}/claims/${claimId}/reanchor`, { method: "POST" }),
    update: (projectId: string, claimId: string, body: { reviewStatus?: PaperClaim["reviewStatus"]; anchorStatus?: PaperClaim["anchorStatus"] }) => request<PaperClaim>(`/api/projects/${projectId}/claims/${claimId}`, jsonInit("PATCH", body)),
    evidence: (projectId: string) => request<SourceEvidence[]>(`/api/projects/${projectId}/evidence`),
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
