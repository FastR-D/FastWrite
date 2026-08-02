export type WritingProfile = "security-top4" | "ai-top-tier";

/** @deprecated API compatibility name. Values now identify a shared writing profile, not one venue. */
export type TargetVenue = WritingProfile;

export interface PaperSkillRef {
  id: WritingProfile;
  name: "Security Top-4" | "AI Top-Tier";
  version: string;
  /** @deprecated Stored as `venue` for database/API compatibility; semantically this is the writing profile. */
  venue: TargetVenue;
}

export type ImportSource =
  | { type: "local"; displayName: string }
  | { type: "github"; repository: string; ref: string; commit: string };

export interface PaperProject {
  id: string;
  name: string;
  mainDocument: string;
  skill: PaperSkillRef;
  source: ImportSource;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export type PaperFileKind = "text" | "image" | "binary";

export interface PaperFile {
  path: string;
  name: string;
  kind: PaperFileKind;
  size: number;
  version: number;
  updatedAt: string;
}

export interface FileTreeNode extends PaperFile {
  type: "file";
}

export interface DirectoryTreeNode {
  type: "directory";
  path: string;
  name: string;
  children: WorkspaceTreeNode[];
  loaded?: boolean;
}

export type WorkspaceTreeNode = FileTreeNode | DirectoryTreeNode;

export interface OutlineItem {
  id: string;
  title: string;
  level: number;
  path: string;
  line: number;
  children: OutlineItem[];
}

export interface UploadManifestEntry {
  path: string;
  kind: "file" | "directory";
  size: number;
  mimeType?: string;
  checksum?: string;
}

export interface UploadSession {
  id: string;
  projectName: string;
  mainDocument: string;
  venue: TargetVenue;
  sourceName: string;
  entries: UploadManifestEntry[];
  receivedPaths: string[];
  receivedBytes: number;
  totalBytes: number;
  status: "pending" | "uploading" | "completing" | "completed" | "cancelled" | "failed";
  createdAt: string;
  expiresAt: string;
  projectId?: string;
  error?: string;
}

export type ImportStatus = "queued" | "analyzing" | "copying" | "completed" | "failed" | "cancelled";

export interface ProjectImport {
  id: string;
  source: "github" | "local";
  status: ImportStatus;
  progress: number;
  stage: string;
  projectId?: string;
  error?: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface FileContentResponse {
  file: PaperFile;
  content: string;
}

export interface TextSelection {
  path: string;
  text: string;
  from: number;
  to: number;
  startLine: number;
  endLine: number;
  fileVersion: number;
}

export interface SaveFileRequest {
  content: string;
  baseVersion: number;
}

export interface SaveFileResponse {
  file: PaperFile;
  projectVersion: number;
}

export interface CreateProjectRequest {
  name: string;
  mainDocument?: string;
  venue?: TargetVenue;
}

export interface GithubImportRequest {
  repository: string;
  ref?: string;
  name?: string;
  mainDocument?: string;
  venue?: TargetVenue;
}

export type ReviseCommandId =
  | "academic-polish"
  | "logic-check"
  | "condense"
  | "expand-argument"
  | "reorganize"
  | "grammar"
  | "citation-suggestion";

export interface ReviseRequest {
  selection: TextSelection;
  command?: ReviseCommandId;
  instruction?: string;
  /** The latest unaccepted candidate when the user continues the same Revise chat. */
  workingText?: string;
  /** Conversation context for the selected span. The server caps this before sending it to the provider. */
  history?: ReviseTurn[];
}

export interface ReviseTurn {
  role: "user" | "assistant";
  content: string;
}

export type AgentRunStatus = "queued" | "running" | "waiting-approval" | "completed" | "failed" | "cancelled";

export interface AgentRun {
  id: string;
  projectId: string;
  type: "revise" | "draft" | "agent" | "review";
  status: AgentRunStatus;
  objective: string;
  skill: PaperSkillRef;
  changeSetId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  steps?: AgentRunStep[];
  memoryVersion?: number;
  auditTrail?: AgentAuditEvent[];
}

export interface AgentAuditEvent {
  id: string;
  action: "context-read" | "context-search" | "plan-created" | "execution-started" | "changes-proposed" | "proposal-edited" | "hunk-decision" | "compile" | "rollback";
  summary: string;
  paths?: string[];
  createdAt: string;
}

export interface AgentRunStep {
  id: string;
  label: string;
  status: "pending" | "running" | "completed" | "failed";
}

export type ChangeSetStatus = "proposed" | "partially-accepted" | "accepted" | "rejected" | "conflict" | "rolled-back";
export type TextHunkStatus = "pending" | "accepted" | "rejected";

export interface TextHunk {
  id: string;
  from: number;
  to: number;
  before: string;
  after: string;
  status: TextHunkStatus;
  rationale?: string;
  evidence?: TextHunkEvidence[];
}

export interface TextHunkEvidence {
  issueId: string;
  issueTitle: string;
  path: string;
  line?: number;
  excerpt: string;
  inferred: boolean;
}

export interface TextChange {
  operation?: "replace" | "create";
  path: string;
  from: number;
  to: number;
  before: string;
  after: string;
  baseVersion: number;
  baseContent?: string;
  currentVersion?: number;
  hunks?: TextHunk[];
  appliedVersion?: number;
}

export interface ChangeSetDecisionRequest {
  decisions: Array<{ path: string; hunkIds: string[]; status: "accepted" | "rejected" }>;
}

export interface ChangeSetEditRequest {
  changes: Array<{ path: string; after: string }>;
}

export interface ChangeSet {
  id: string;
  projectId: string;
  agentRunId: string;
  status: ChangeSetStatus;
  summary: string;
  rationale: string;
  changes: TextChange[];
  appliedFileVersion?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReviseResponse {
  run: AgentRun;
  changeSet: ChangeSet;
}

export interface DraftRequest {
  /** Natural-language Agent message. Preferred by the focused Draft flow. */
  brief?: string;
  /** Structured fields remain supported for API clients and saved legacy plans. */
  topic?: string;
  researchQuestion?: string;
  contributions?: string[];
  materials?: string;
}

export interface DraftOutlineSection {
  path: string;
  title: string;
  purpose: string;
}

export type DraftPlanStatus = "proposed" | "generating" | "waiting-approval" | "accepted" | "cancelled" | "failed";

export interface DraftPlan {
  id: string;
  projectId: string;
  agentRunId: string;
  status: DraftPlanStatus;
  request: DraftRequest;
  outline: DraftOutlineSection[];
  changeSetId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DraftPlanResponse {
  run: AgentRun;
  plan: DraftPlan;
}

export type ReviewSeverity = "blocking" | "major" | "minor" | "suggestion";
export type ReviewIssueStatus = "open" | "planned" | "in_revision" | "resolved" | "dismissed";

export interface ReviewSnapshotFile {
  path: string;
  version: number;
  digest: string;
}

export interface ReviewSnapshot {
  id: string;
  projectId: string;
  projectVersion: number;
  mainDocument: string;
  skill: PaperSkillRef;
  files: ReviewSnapshotFile[];
  memoryVersion?: number;
  compileRecordId?: string;
  sourceOnly: boolean;
  createdAt: string;
}

export interface ReviewEvidence {
  path: string;
  section?: string;
  line?: number;
  excerpt: string;
  inferred: boolean;
}

export interface ReviewIssue {
  id: string;
  reportId: string;
  category: "novelty" | "soundness" | "technical-depth" | "threat-model" | "evaluation" | "reproducibility" | "related-work" | "clarity" | "ethics";
  severity: ReviewSeverity;
  priority: number;
  title: string;
  rationale: string;
  impact: string;
  suggestion: string;
  evidence: ReviewEvidence[];
  status: ReviewIssueStatus;
  createdAt: string;
  updatedAt: string;
  source?: "agent" | "manual";
  mergedIntoId?: string;
  history?: ReviewIssueHistoryEntry[];
}

export interface ReviewIssueHistoryEntry {
  id: string;
  action: "created" | "status" | "priority" | "merged" | "edited";
  reason: string;
  actor: "user" | "agent" | "system";
  createdAt: string;
}

export interface ReviewReport {
  id: string;
  projectId: string;
  agentRunId: string;
  snapshotId: string;
  overallAssessment: string;
  recommendation: "strong-accept" | "accept" | "borderline" | "reject" | "strong-reject";
  strengths: string[];
  weaknesses: string[];
  nextSteps: string[];
  issues: ReviewIssue[];
  createdAt: string;
}

export interface ReviewResponse {
  run: AgentRun;
  snapshot: ReviewSnapshot;
  report: ReviewReport;
}

export type MemoryCategory = "research-question" | "contribution" | "system-model" | "threat-model" | "term" | "experiment" | "limitation" | "open-question";
export type MemoryItemStatus = "suggested" | "confirmed" | "rejected" | "needs-information" | "stale";

export interface MemorySource {
  path: string;
  line?: number;
  section?: string;
  excerpt: string;
  fileVersion: number;
}

export interface MemoryItem {
  id: string;
  category: MemoryCategory;
  label: string;
  content: string;
  status: MemoryItemStatus;
  sources: MemorySource[];
  createdAt: string;
  updatedAt: string;
}

export interface PaperMemory {
  id: string;
  projectId: string;
  version: number;
  projectVersion: number;
  items: MemoryItem[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentTaskRequest {
  objective: string;
  scope: { type: "file" | "section" | "project"; path?: string };
  issueIds?: string[];
}

export type AgentTaskStatus = "proposed" | "generating" | "waiting-approval" | "accepted" | "cancelled" | "failed";

export interface AgentTaskPlan {
  id: string;
  projectId: string;
  agentRunId: string;
  status: AgentTaskStatus;
  request: AgentTaskRequest;
  steps: string[];
  affectedFiles: string[];
  risks: string[];
  validation: string[];
  changeSetId?: string;
  acceptedProjectVersion?: number;
  compileRecordId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTaskPlanResponse {
  run: AgentRun;
  plan: AgentTaskPlan;
}

export type IssueResolutionStatus = "planned" | "in-revision" | "needs-review" | "resolved" | "reopened" | "rolled-back";

export interface IssueResolution {
  id: string;
  projectId: string;
  issueIds: string[];
  reviewSnapshotIds: string[];
  agentRunId: string;
  baseProjectVersion: number;
  memoryVersion?: number;
  skill: PaperSkillRef;
  changeSetId?: string;
  acceptedProjectVersion?: number;
  compileRecordId?: string;
  status: IssueResolutionStatus;
  rereviewAssessment?: string;
  issueAssessments?: Array<{ issueId: string; resolved: boolean; assessment: string }>;
  regressions?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CompileRecord {
  id: string;
  projectId: string;
  projectVersion: number;
  status: "success" | "error";
  summary: string;
  createdAt: string;
}

export type CompletionKind = "auto";
export interface CompletionRequest { path: string; cursor: number; fileVersion: number; kind: CompletionKind }
export interface CompletionResponse { suggestion: string; path: string; cursor: number; fileVersion: number; kind: CompletionKind }

export const WRITING_PROFILES: ReadonlyArray<{ value: WritingProfile; label: string }> = [
  { value: "security-top4", label: "Security Top-4" },
  { value: "ai-top-tier", label: "AI Top-Tier" }
];

/** @deprecated Prefer WRITING_PROFILES. */
export const TARGET_VENUES = WRITING_PROFILES;

export function normalizeWritingProfile(value: unknown): WritingProfile {
  return value === "ai-top-tier" ? "ai-top-tier" : "security-top4";
}

export function paperSkillForProfile(value: unknown): PaperSkillRef {
  const profile = normalizeWritingProfile(value);
  return {
    id: profile,
    name: profile === "ai-top-tier" ? "AI Top-Tier" : "Security Top-4",
    version: "1.0.0",
    venue: profile
  };
}
