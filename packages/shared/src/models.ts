export type ResearchDomainId =
  | "computer-architecture-systems"
  | "computer-networks"
  | "network-information-security"
  | "software-engineering-systems-languages"
  | "database-data-mining-retrieval"
  | "theoretical-computer-science"
  | "graphics-multimedia"
  | "artificial-intelligence"
  | "human-computer-interaction"
  | "interdisciplinary-emerging";

export type AgentWireApi = "chat" | "responses";

/** @deprecated Compatibility name. Values identify research domains. */
export type WritingProfile = ResearchDomainId;
export type PublicationVenueId = string;

export type ManuscriptStage = "draft" | "submission" | "camera-ready";

export interface PublicationTarget {
  domain: ResearchDomainId;
  venueId: PublicationVenueId;
  year?: number;
  track?: string;
  stage: ManuscriptStage;
}

export interface PublicationVenueOption {
  value: PublicationVenueId;
  label: string;
  kind: "conference" | "journal";
  domain: ResearchDomainId;
  edition: string;
  verifiedAt: string;
  sourceUrl: string;
  tracks?: ReadonlyArray<{ value: string; label: string }>;
  template?: LatexTemplateOption;
  constraints?: {
    pageLimit?: number;
    totalPageLimit?: number;
    cameraReadyPageLimit?: number;
    cameraReadyTotalPageLimit?: number;
    anonymous?: boolean;
    requiredSections?: string[];
    requiredLatex?: string[];
  };
}

export interface LatexTemplateOption {
  id: string;
  label: string;
  trust: "official" | "publisher" | "community-mirror";
  sourceUrl: string;
  verifiedAt: string;
  venueSpecific: boolean;
  years?: ReadonlyArray<number>;
}

export type ComplianceFindingStatus = "pass" | "error" | "warning" | "unresolved";
export interface ComplianceFinding {
  id: string;
  category: "pages" | "template" | "anonymity" | "comments" | "citations" | "references" | "required-section" | (string & {});
  status: ComplianceFindingStatus;
  message: string;
  path?: string;
  line?: number;
  evidence?: string;
  sourceUrl?: string;
}

export interface CitationVerification {
  key: string;
  status: "verified" | "mismatch" | "unresolved" | "missing";
  title?: string;
  doi?: string;
  url?: string;
  message: string;
}

export interface ComplianceReport {
  projectId: string;
  projectVersion: number;
  publicationTarget?: PublicationTarget;
  checkedAt: string;
  renderedPages?: number;
  mainBodyPages?: number;
  summary: { errors: number; warnings: number; unresolved: number; passed: number };
  submissionBlocked: boolean;
  findings: ComplianceFinding[];
  citations: CitationVerification[];
}

/** @deprecated API compatibility name. Values identify a research domain, not one venue. */
export type TargetVenue = ResearchDomainId;

export interface PaperSkillRef {
  id: WritingProfile;
  name: string;
  version: string;
  /** @deprecated Stored as `venue` for database/API compatibility; semantically this is the research domain. */
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
  publicationTarget?: PublicationTarget;
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
  publicationTarget?: PublicationTarget;
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
  publicationTarget?: PublicationTarget;
  initializeFromTemplate?: boolean;
}

export interface GithubImportRequest {
  repository: string;
  ref?: string;
  name?: string;
  mainDocument?: string;
  venue?: TargetVenue;
  publicationTarget?: PublicationTarget;
}

export type GithubSyncStatus = "conflicts" | "ready-to-compile" | "completed" | "remote-changed" | "failed";
export type GithubSyncConflictKind = "text" | "binary" | "delete-modify";
export type GithubSyncResolutionChoice = "fastwrite" | "github" | "edited";

export interface GithubSyncConflict {
  path: string;
  kind: GithubSyncConflictKind;
  baseContent?: string;
  fastwriteContent?: string;
  githubContent?: string;
}

export interface GithubSyncRun {
  id: string;
  projectId: string;
  status: GithubSyncStatus;
  repository: string;
  branch: string;
  baseCommit: string;
  remoteCommit: string;
  projectVersion?: number;
  hasChangesToPush: boolean;
  conflicts: GithubSyncConflict[];
  pushedCommit?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GithubSyncResolution {
  path: string;
  choice: GithubSyncResolutionChoice;
  content?: string;
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
  issueIds?: string[];
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
  publicationTarget?: PublicationTarget;
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
  action: "context-read" | "context-search" | "plan-created" | "execution-started" | "generation-progress" | "changes-proposed" | "proposal-edited" | "hunk-edited" | "hunk-decision" | "review-finished" | "compile" | "rollback";
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
  findings?: HunkFinding[];
}

export interface HunkFinding {
  id: string;
  source: "claim" | "citation" | "numeric" | "structure" | "review" | "compliance" | "style";
  referenceId: string;
  status: "pass" | "warning" | "blocking" | "unresolved";
  message: string;
  anchors?: ClaimAnchor[];
  confidence?: "high" | "medium" | "low";
  suggestedAction?: string;
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
  overwriteConflicts?: Array<{ path: string; currentVersion: number | null }>;
}

export interface ChangeSetEditRequest {
  changes?: Array<{ path: string; after: string }>;
  hunks?: Array<{ path: string; hunkId: string; after: string }>;
}

export interface ChangeSetConflictFile {
  path: string;
  currentContent: string | null;
  reviewedContent: string;
  currentVersion: number | null;
}

export interface ChangeSetConflictDetails {
  changeSetId: string;
  conflicts: ChangeSetConflictFile[];
}

export interface ChangeSet {
  id: string;
  projectId: string;
  agentRunId: string;
  status: ChangeSetStatus;
  summary: string;
  rationale: string;
  changes: TextChange[];
  approvalMode?: "explicit-finish";
  reviewFinishedAt?: string;
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
export type ReviewIssueStatus = "open" | "planned" | "in_revision" | "needs_review" | "resolved" | "dismissed";

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
  publicationTarget?: PublicationTarget;
  files: ReviewSnapshotFile[];
  memoryVersion?: number;
  compileRecordId?: string;
  sourceOnly: boolean;
  createdAt: string;
}

export interface ReviewEvidence {
  path?: string;
  section?: string;
  line?: number;
  excerpt: string;
  page?: number;
  source?: "latex" | "pdf-preview" | "citation" | "compliance";
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
  /** Input used for this report; PDF text is request-scoped and never persisted. */
  inputType?: "source" | "pdf-preview";
  createdFromProjectVersion?: number;
  stale?: boolean;
  passes?: Array<{ id: "mechanical" | "evidence" | "argument" | "domain" | "venue" | "adversarial" | "synthesis"; status: "completed" | "failed" | "skipped"; issues: string[]; error?: string; provider?: string; model?: string; inputBoundary?: string; unavailableReason?: string }>;
  createdAt: string;
}

export interface ReviewResponse {
  run: AgentRun;
  snapshot: ReviewSnapshot;
  report: ReviewReport;
}

export type MemoryCategory = "research-question" | "contribution" | "system-model" | "threat-model" | "term" | "experiment" | "limitation" | "open-question";
export type MemoryItemStatus = "suggested" | "confirmed" | "rejected" | "needs-information" | "stale";
export type MemoryOrigin = "ai" | "human";
export type MemoryFreshness = "current" | "stale";

export interface MemorySource {
  path: string;
  line?: number;
  section?: string;
  excerpt: string;
  fileVersion: number;
}

export interface MemoryCandidate {
  label: string;
  content: string;
  sources: MemorySource[];
  createdAt: string;
}

export interface MemoryOverview {
  content: string;
  origin: MemoryOrigin;
  humanEdited: boolean;
  locked: boolean;
  candidate?: MemoryCandidate;
  createdAt: string;
  updatedAt: string;
}

export interface MemorySectionSummary {
  id: string;
  key: string;
  path: string;
  title: string;
  content: string;
  sources: MemorySource[];
  origin: MemoryOrigin;
  humanEdited: boolean;
  locked: boolean;
  freshness: MemoryFreshness;
  candidate?: MemoryCandidate;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryItem {
  id: string;
  /** Stable identity used to reconcile regenerated facts without duplicating them. */
  key?: string;
  category: MemoryCategory;
  label: string;
  content: string;
  status: MemoryItemStatus;
  sources: MemorySource[];
  origin?: MemoryOrigin;
  humanEdited?: boolean;
  locked?: boolean;
  freshness?: MemoryFreshness;
  candidate?: MemoryCandidate;
  createdAt: string;
  updatedAt: string;
}

export interface PaperMemory {
  id: string;
  projectId: string;
  version: number;
  projectVersion: number;
  overview?: MemoryOverview;
  sections?: MemorySectionSummary[];
  items: MemoryItem[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentTaskRequest {
  objective: string;
  scope: { type: "file" | "section" | "project"; path?: string };
  issueIds?: string[];
  intent?: AgentTaskIntent;
}

export type AgentTaskIntent = "draft" | "continue" | "revise";

export type AgentTaskStatus = "proposed" | "generating" | "waiting-approval" | "accepted" | "cancelled" | "failed";

export interface AgentTaskPlan {
  id: string;
  projectId: string;
  agentRunId: string;
  status: AgentTaskStatus;
  request: AgentTaskRequest;
  intent: AgentTaskIntent;
  steps: string[];
  affectedFiles: string[];
  risks: string[];
  validation: string[];
  sectionBudget?: Array<{ section: string; targetPages?: number; purpose: string }>;
  venueChecks?: Array<{
    requirement: string;
    status: "satisfied" | "missing" | "uncertain" | "not-applicable";
    evidencePaths: string[];
    action: string;
  }>;
  evidenceDependencies?: EvidenceDependency[];
  missingEvidence?: string[];
  sectionContracts?: SectionContract[];
  changeSetId?: string;
  acceptedProjectVersion?: number;
  compileRecordId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceDependency {
  step: string;
  requiredClaimIds: string[];
  missingEvidence: string[];
}

export interface ResearchWork {
  id: string;
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  metadataStatus: "candidate" | "verified" | "conflicting" | "unresolved";
  publicationStatus: "normal" | "corrected" | "retracted" | "unknown";
  createdAt: string;
  updatedAt: string;
}

export interface ProjectResearchWork {
  projectId: string;
  workId: string;
  status: "candidate" | "saved" | "rejected";
  citationKey?: string;
  createdAt: string;
  updatedAt: string;
}

export type ResearchRunStatus = "planned" | "running" | "completed" | "cancelled" | "failed";
export interface ResearchRun {
  id: string;
  projectId: string;
  query: string;
  status: ResearchRunStatus;
  provider?: string;
  queryPlan?: { steps: string[]; rationale?: string };
  workIds: string[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchIdentifier {
  workId: string;
  scheme: "doi" | "arxiv" | "openalex" | "semantic-scholar" | "url";
  value: string;
}

export interface MetadataObservation {
  id: string;
  workId: string;
  provider: "crossref" | "openalex" | "semantic-scholar" | "arxiv" | "publisher" | "user";
  fields: Record<string, string | number | string[]>;
  fetchedAt: string;
}

export type ResearchEvidenceKind = "background" | "claim" | "method" | "result" | "limitation" | "quote";
export interface SourceEvidence {
  id: string;
  projectId: string;
  workId: string;
  kind: ResearchEvidenceKind;
  origin: "source-text" | "registry-abstract" | "model-extraction" | "user";
  representation: "verbatim" | "paraphrase";
  status: "candidate" | "approved" | "rejected" | "stale";
  content: string;
  locatorType: "page" | "section" | "paragraph" | "abstract";
  locator: string;
  createdByRunId?: string;
  approvedAt?: string;
  createdAt: string;
  updatedAt: string;
  citationKey?: string;
}

export interface ClaimAnchor {
  path: string;
  fileVersion: number;
  startOffset: number;
  endOffset: number;
  exactText: string;
  prefix: string;
  suffix: string;
}

export interface PaperClaim {
  id: string;
  projectId: string;
  anchor: ClaimAnchor;
  type: "background" | "contribution" | "method" | "result" | "comparison" | "limitation";
  reviewStatus: "detected" | "needs-review" | "supported" | "partial" | "unsupported";
  anchorStatus: "current" | "stale" | "reanchored" | "orphaned";
  createdBy: "user" | "agent" | "scanner";
  createdAt: string;
  updatedAt: string;
  surface?: "number" | "scope" | "citation" | "caption" | "table-cell" | "artifact-reference" | "text";
  semanticType?: "background" | "contribution" | "method" | "result" | "comparison" | "limitation";
  normalizedText?: string;
  numbers?: Array<{ raw: string; normalized: number; unit?: string; metric?: string; direction?: "higher" | "lower"; aggregation?: string }> | undefined;
}

export interface SectionContract {
  path: string; purpose: string; requiredClaimIds: string[]; allowedEvidenceIds: string[];
  requiredTablesOrFigures: string[]; terminology: string[]; openQuestions: string[]; targetWords?: number;
}

export interface ClaimRelation {
  id: string; projectId: string; fromClaimId: string; toClaimId: string;
  type: "motivates" | "addresses" | "implements" | "evaluates" | "supports" | "limits";
  status: "candidate" | "confirmed" | "stale"; origin: "scanner" | "agent" | "user";
}

export type ClaimEvidenceLink =
  | { id: string; claimId: string; kind: "literature"; evidenceId: string; citationKey?: string }
  | { id: string; claimId: string; kind: "workspace"; path: string; anchor: ClaimAnchor; stale?: boolean }
  | { id: string; claimId: string; kind: "review-waiver"; reason: string; approvedByUser: true };

export interface AlignmentFinding {
  id: string;
  kind: "number" | "file" | "citation";
  status: "pass" | "warning" | "unresolved";
  message: string;
  path?: string;
  line?: number;
  evidence?: string;
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
  publicationTarget?: PublicationTarget;
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
  { value: "computer-architecture-systems", label: "计算机体系结构、并行与分布计算、存储系统" },
  { value: "computer-networks", label: "计算机网络" },
  { value: "network-information-security", label: "网络与信息安全" },
  { value: "software-engineering-systems-languages", label: "软件工程、系统软件与程序设计语言" },
  { value: "database-data-mining-retrieval", label: "数据库、数据挖掘与内容检索" },
  { value: "theoretical-computer-science", label: "计算机科学理论" },
  { value: "graphics-multimedia", label: "计算机图形学与多媒体" },
  { value: "artificial-intelligence", label: "人工智能" },
  { value: "human-computer-interaction", label: "人机交互与普适计算" },
  { value: "interdisciplinary-emerging", label: "交叉、综合与新兴" }
];

export function normalizePublicationTarget(value: unknown, profile: WritingProfile): PublicationTarget | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<PublicationTarget>;
  if (typeof raw.venueId !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(raw.venueId)) return undefined;
  const legacyDomain = legacyVenueDomain(raw.venueId);
  const domain = normalizeWritingProfile(raw.domain ?? legacyDomain ?? profile);
  if (domain !== profile) return undefined;
  const stage: ManuscriptStage = raw.stage === "draft" || raw.stage === "camera-ready" ? raw.stage : "submission";
  const year = typeof raw.year === "number" && Number.isInteger(raw.year) && raw.year >= 2000 && raw.year <= 2100 ? raw.year : undefined;
  const track = typeof raw.track === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/i.test(raw.track) ? raw.track : undefined;
  return { domain, venueId: raw.venueId, stage, ...(year ? { year } : {}), ...(track ? { track } : {}) };
}

/** @deprecated Prefer WRITING_PROFILES. */
export const TARGET_VENUES = WRITING_PROFILES;

export function normalizeWritingProfile(value: unknown): WritingProfile {
  if (value === "ai-top-tier") return "artificial-intelligence";
  if (value === "security-top4" || value === "sp") return "network-information-security";
  return WRITING_PROFILES.some((profile) => profile.value === value) ? value as WritingProfile : "network-information-security";
}

export function paperSkillForProfile(value: unknown): PaperSkillRef {
  const profile = normalizeWritingProfile(value);
  return {
    id: profile,
    name: WRITING_PROFILES.find((item) => item.value === profile)?.label ?? profile,
    version: "2.0.0",
    venue: profile
  };
}

function legacyVenueDomain(venueId: string): ResearchDomainId | undefined {
  if (["aaai", "neurips", "acl", "cvpr", "iccv", "icml", "ijcai", "artificial-intelligence", "tpami", "ijcv", "jmlr"].includes(venueId)) return "artificial-intelligence";
  if (["ccs", "eurocrypt", "sp", "crypto", "usenix-security", "ndss", "tdsc", "tifs", "journal-of-cryptology"].includes(venueId)) return "network-information-security";
  return undefined;
}
