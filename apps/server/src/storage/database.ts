import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { paperSkillForProfile, type AgentRun, type AgentTaskPlan, type ChangeSet, type CompileRecord, type DraftPlan, type IssueResolution, type PaperMemory, type PaperProject, type ReviewReport, type ReviewSnapshot, type UploadSession } from "@fastwrite/shared";

export interface FileVersionRecord {
  version: number;
  updatedAt: string;
}

export interface DatabaseState {
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
}

const EMPTY_DATABASE: DatabaseState = { projects: [], uploadSessions: [], fileVersions: {}, agentRuns: [], changeSets: [], draftPlans: [], reviewSnapshots: [], reviewReports: [], paperMemories: [], agentTaskPlans: [], issueResolutions: [], compileRecords: [] };

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
      this.state = {
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
        compileRecords: parsed.compileRecords ?? []
      };
      let migrated = false;
      const normalizeSkill = (record: { skill: PaperProject["skill"] }) => {
        const normalized = paperSkillForProfile(record.skill?.venue ?? record.skill?.id);
        if (record.skill?.id !== normalized.id || record.skill?.name !== normalized.name || record.skill?.venue !== normalized.venue) {
          record.skill = normalized;
          migrated = true;
        }
      };
      for (const project of this.state.projects) normalizeSkill(project);
      for (const run of this.state.agentRuns) normalizeSkill(run);
      for (const snapshot of this.state.reviewSnapshots) normalizeSkill(snapshot);
      for (const resolution of this.state.issueResolutions) normalizeSkill(resolution);
      if (migrated) await this.flush();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.flush();
    }
  }

  snapshot(): DatabaseState {
    return structuredClone(this.state);
  }

  async mutate<T>(mutation: (state: DatabaseState) => T): Promise<T> {
    const result = mutation(this.state);
    await this.flush();
    return structuredClone(result);
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
