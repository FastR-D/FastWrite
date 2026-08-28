import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { normalizePublicationTarget, paperSkillForProfile, type AgentRun, type AgentTaskPlan, type ChangeSet, type CompileRecord, type DraftPlan, type GithubSyncRun, type IssueResolution, type PaperMemory, type PaperProject, type ReviewReport, type ReviewSnapshot, type UploadSession, type ResearchWork, type ProjectResearchWork, type ResearchIdentifier, type MetadataObservation, type SourceEvidence, type PaperClaim, type ClaimEvidenceLink, type ResearchRun } from "@fastwrite/shared";

export interface FileVersionRecord {
  version: number;
  updatedAt: string;
}

export interface DatabaseState {
  schemaVersion: number;
  projects: PaperProject[];
  uploadSessions: UploadSession[];
  fileVersions: Record<string, Record<string, FileVersionRecord>>;
  agentRuns: AgentRun[];
  changeSets: ChangeSet[];
  draftPlans: DraftPlan[];
  reviewSnapshots: ReviewSnapshot[];
  reviewReports: ReviewReport[];
  paperMemories: PaperMemory[];
  agentTaskPlans: AgentTaskPlan[];
  issueResolutions: IssueResolution[];
  compileRecords: CompileRecord[];
  githubSyncRuns: GithubSyncRun[];
  researchWorks: ResearchWork[];
  projectResearchWorks: ProjectResearchWork[];
  researchIdentifiers: ResearchIdentifier[];
  metadataObservations: MetadataObservation[];
  sourceEvidence: SourceEvidence[];
  paperClaims: PaperClaim[];
  claimEvidenceLinks: ClaimEvidenceLink[];
  researchRuns: ResearchRun[];
}

export const CURRENT_SCHEMA_VERSION = 2;
const EMPTY_DATABASE: DatabaseState = { schemaVersion: CURRENT_SCHEMA_VERSION, projects: [], uploadSessions: [], fileVersions: {}, agentRuns: [], changeSets: [], draftPlans: [], reviewSnapshots: [], reviewReports: [], paperMemories: [], agentTaskPlans: [], issueResolutions: [], compileRecords: [], githubSyncRuns: [], researchWorks: [], projectResearchWorks: [], researchIdentifiers: [], metadataObservations: [], sourceEvidence: [], paperClaims: [], claimEvidenceLinks: [], researchRuns: [] };

export class JsonDatabase {
  private state: DatabaseState = structuredClone(EMPTY_DATABASE);
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(dataDirectory: string) {
    this.path = join(dataDirectory, "database.json");
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<DatabaseState>;
      const originalSchemaVersion = Number.isInteger(parsed.schemaVersion) ? parsed.schemaVersion! : 1;
      const migratedState: DatabaseState = {
        schemaVersion: originalSchemaVersion,
        projects: parsed.projects ?? [],
        uploadSessions: parsed.uploadSessions ?? [],
        fileVersions: parsed.fileVersions ?? {},
        agentRuns: parsed.agentRuns ?? [],
        changeSets: parsed.changeSets ?? [],
        draftPlans: parsed.draftPlans ?? [],
        reviewSnapshots: parsed.reviewSnapshots ?? [],
        reviewReports: parsed.reviewReports ?? [],
        paperMemories: parsed.paperMemories ?? [],
        agentTaskPlans: parsed.agentTaskPlans ?? [],
        issueResolutions: parsed.issueResolutions ?? [],
        compileRecords: parsed.compileRecords ?? [],
        githubSyncRuns: parsed.githubSyncRuns ?? [],
        researchWorks: parsed.researchWorks ?? [],
        projectResearchWorks: parsed.projectResearchWorks ?? [],
        researchIdentifiers: parsed.researchIdentifiers ?? [],
        metadataObservations: parsed.metadataObservations ?? [],
        sourceEvidence: parsed.sourceEvidence ?? [],
        paperClaims: parsed.paperClaims ?? [],
        claimEvidenceLinks: parsed.claimEvidenceLinks ?? [],
        researchRuns: parsed.researchRuns ?? []
      };
      this.state = migrate(migratedState);
      let migrated = false;
      const normalizeSkill = (record: { skill: PaperProject["skill"]; publicationTarget?: PaperProject["publicationTarget"] }) => {
        const normalized = paperSkillForProfile(record.skill?.venue ?? record.skill?.id);
        if (record.skill?.id !== normalized.id || record.skill?.name !== normalized.name || record.skill?.venue !== normalized.venue) {
          record.skill = normalized;
          migrated = true;
        }
        if (record.publicationTarget) {
          const target = normalizePublicationTarget(record.publicationTarget, normalized.id);
          if (target && JSON.stringify(target) !== JSON.stringify(record.publicationTarget)) { record.publicationTarget = target; migrated = true; }
          else if (!target) { delete record.publicationTarget; migrated = true; }
        }
      };
      for (const project of this.state.projects) normalizeSkill(project);
      for (const run of this.state.agentRuns) normalizeSkill(run);
      for (const snapshot of this.state.reviewSnapshots) normalizeSkill(snapshot);
      for (const resolution of this.state.issueResolutions) normalizeSkill(resolution);
      if (migrated || originalSchemaVersion !== CURRENT_SCHEMA_VERSION) await this.flush();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.flush();
    }
  }

  snapshot(): DatabaseState {
    return structuredClone(this.state);
  }

  async mutate<T>(mutation: (state: DatabaseState) => T): Promise<T> {
    const before = structuredClone(this.state);
    try {
      const result = mutation(this.state);
      enforceCapacity(this.state);
      await this.flush();
      return structuredClone(result);
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.mutate((state) => {
      state.projects = state.projects.filter((item) => item.id !== projectId);
      state.uploadSessions = state.uploadSessions.filter((item) => item.projectId !== projectId);
      state.agentRuns = state.agentRuns.filter((item) => item.projectId !== projectId);
      state.changeSets = state.changeSets.filter((item) => item.projectId !== projectId);
      state.draftPlans = state.draftPlans.filter((item) => item.projectId !== projectId);
      state.reviewSnapshots = state.reviewSnapshots.filter((item) => item.projectId !== projectId);
      state.reviewReports = state.reviewReports.filter((item) => item.projectId !== projectId);
      state.paperMemories = state.paperMemories.filter((item) => item.projectId !== projectId);
      state.agentTaskPlans = state.agentTaskPlans.filter((item) => item.projectId !== projectId);
      state.issueResolutions = state.issueResolutions.filter((item) => item.projectId !== projectId);
      state.compileRecords = state.compileRecords.filter((item) => item.projectId !== projectId);
      state.githubSyncRuns = state.githubSyncRuns.filter((item) => item.projectId !== projectId);
      const workIds = new Set(state.projectResearchWorks.filter((item) => item.projectId === projectId).map((item) => item.workId));
      state.projectResearchWorks = state.projectResearchWorks.filter((item) => item.projectId !== projectId);
      state.sourceEvidence = state.sourceEvidence.filter((item) => item.projectId !== projectId);
      state.paperClaims = state.paperClaims.filter((item) => item.projectId !== projectId);
      state.claimEvidenceLinks = state.claimEvidenceLinks.filter((item) => !state.paperClaims.some((claim) => claim.id === item.claimId));
      state.researchRuns = state.researchRuns.filter((item) => item.projectId !== projectId);
      state.researchWorks = state.researchWorks.filter((item) => !workIds.has(item.id));
      state.researchIdentifiers = state.researchIdentifiers.filter((item) => !workIds.has(item.workId));
      state.metadataObservations = state.metadataObservations.filter((item) => !workIds.has(item.workId));
      delete state.fileVersions[projectId];
    });
  }

  private async flush(): Promise<void> {
    const serialized = JSON.stringify(this.state, null, 2);
    this.writeQueue = this.writeQueue.then(async () => {
      const temporaryPath = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporaryPath, serialized, "utf8");
      await rename(temporaryPath, this.path);
    });
    return this.writeQueue;
  }
}

function migrate(state: DatabaseState): DatabaseState {
  if (state.schemaVersion < 2) {
    state.researchWorks ??= [];
    state.projectResearchWorks ??= [];
    state.researchIdentifiers ??= [];
    state.metadataObservations ??= [];
    state.sourceEvidence ??= [];
    state.paperClaims ??= [];
    state.claimEvidenceLinks ??= [];
    state.researchRuns ??= [];
    state.schemaVersion = 2;
  }
  if (state.schemaVersion > CURRENT_SCHEMA_VERSION) throw new Error(`Unsupported database schema version ${state.schemaVersion}`);
  return state;
}

function enforceCapacity(state: DatabaseState): void {
  const maxWorks = Number.parseInt(process.env.FASTWRITE_MAX_RESEARCH_WORKS_PER_PROJECT ?? "5000", 10);
  const maxEvidence = Number.parseInt(process.env.FASTWRITE_MAX_EVIDENCE_PER_PROJECT ?? "10000", 10);
  const maxExcerpt = Number.parseInt(process.env.FASTWRITE_MAX_EVIDENCE_CHARS ?? "4000", 10);
  const maxRuns = Number.parseInt(process.env.FASTWRITE_MAX_RESEARCH_RUNS_PER_PROJECT ?? "1000", 10);
  for (const project of state.projects) {
    if (state.projectResearchWorks.filter((item) => item.projectId === project.id).length > maxWorks) throw new Error("Research work capacity exceeded");
    if (state.sourceEvidence.filter((item) => item.projectId === project.id).length > maxEvidence) throw new Error("Evidence capacity exceeded");
    const runs = state.researchRuns.filter((item) => item.projectId === project.id);
    if (runs.length > maxRuns) {
      const keep = new Set(runs.slice(-maxRuns).map((item) => item.id));
      state.researchRuns = state.researchRuns.filter((item) => item.projectId !== project.id || keep.has(item.id));
    }
  }
  for (const evidence of state.sourceEvidence) if (evidence.content.length > maxExcerpt) evidence.content = evidence.content.slice(0, maxExcerpt);
}
