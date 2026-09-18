import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { WRITING_PROFILES, type AgentTaskIntent, type AgentTaskSkillDescriptor, type PaperSkillRef, type PublicationTarget, type PublicationVenueOption, type ResearchDomainId } from "@fastwrite/shared";
import { templateForVenue } from "../templates/latex-template-service";

export interface LoadedSkill {
  instructions: string;
  venueInstructions: string;
  venueRules?: { version?: string; sourceUrl?: string; stages?: string[]; checks?: Array<{ id: string; category: string; pattern?: string; message?: string }> };
}

export type WorkflowSkill = "draft" | "revise" | "review" | "completion" | "memory-extract" | "memory-polish" | "compile-repair";

export interface WorkflowSkillDescriptor { id: WorkflowSkill; version: string; instructions: string }
export interface SkillManifest { id: string; version: string; scope: "system" | "team" | "project"; owner: string; license: string; workflows: string[]; requiredEvidence: string[]; capabilities: string[]; maxContextChars: number; riskLevel: "low" | "medium" | "high"; requiresReview: boolean; references: Array<{ url: string; license: string; verifiedAt: string }> }

export class SkillRegistry {
  constructor(private readonly skillsDirectory: string) {}

  async loadWorkflow(workflow: WorkflowSkill): Promise<string> {
    return readFile(join(this.skillsDirectory, workflow, "SKILL.md"), "utf8");
  }

  async workflowCatalog(): Promise<WorkflowSkillDescriptor[]> {
    const workflows: WorkflowSkill[] = ["draft", "revise", "review", "completion", "memory-extract", "memory-polish", "compile-repair"];
    return Promise.all(workflows.map(async (id) => {
      const instructions = await this.loadWorkflow(id);
      const version = /^version:\s*([^\s]+)\s*$/m.exec(instructions)?.[1] ?? "unversioned";
      return { id, version, instructions };
    }));
  }

  async publishedCatalog(): Promise<SkillManifest[]> {
    const entries = await readdir(this.skillsDirectory, { withFileTypes: true });
    const manifests = await Promise.all(entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("_")).map(async (entry) => {
      const raw = await readFile(join(this.skillsDirectory, entry.name, "manifest.json"), "utf8").catch(() => undefined);
      return raw ? parseSkillManifest(raw, entry.name) : undefined;
    }));
    return manifests.filter((manifest): manifest is SkillManifest => Boolean(manifest)).sort((a, b) => a.id.localeCompare(b.id));
  }

  async taskCatalog(): Promise<AgentTaskSkillDescriptor[]> {
    const entries = await readdir(this.skillsDirectory, { withFileTypes: true });
    const result: AgentTaskSkillDescriptor[] = [];
    for (const entry of entries.filter((item) => item.isDirectory() && item.name.startsWith("task-"))) {
      const content = await readFile(join(this.skillsDirectory, entry.name, "SKILL.md"), "utf8").catch(() => "");
      const field = (name: string) => new RegExp(`^\\s*${name}:\\s*(.+)$`, "m").exec(content)?.[1]?.trim() ?? "";
      const list = (name: string) => field(name).split(",").map((item) => item.trim()).filter(Boolean);
      const intents = list("supportedIntents").filter((item): item is AgentTaskIntent => ["draft", "continue", "revise"].includes(item));
      if (!intents.length) continue;
      result.push({ id: entry.name.slice(5), version: field("version") || "1.0.0", description: field("description") || entry.name, supportedIntents: intents, allowedScope: ["project", "file", "section"].includes(field("allowedScope")) ? field("allowedScope") as AgentTaskSkillDescriptor["allowedScope"] : "project", requiredEvidence: list("requiredEvidence"), validationCommands: list("validationCommands"), riskLevel: ["low", "medium", "high"].includes(field("riskLevel")) ? field("riskLevel") as AgentTaskSkillDescriptor["riskLevel"] : "medium", allowNewFiles: field("allowNewFiles") === "true", requiresReview: field("requiresReview") !== "false" });
    }
    return result.sort((a, b) => a.id.localeCompare(b.id));
  }

  async loadTask(id: string): Promise<{ descriptor: AgentTaskSkillDescriptor; instructions: string }> {
    const descriptor = (await this.taskCatalog()).find((item) => item.id === id);
    if (!descriptor) throw new Error(`Unknown Agent task Skill '${id}'`);
    const instructions = await readFile(join(this.skillsDirectory, `task-${id}`, "SKILL.md"), "utf8");
    return { descriptor, instructions };
  }

  async load(skill: PaperSkillRef, target?: PublicationTarget): Promise<LoadedSkill> {
    const directory = join(this.skillsDirectory, skill.id);
    const [baseInstructions, specializationInstructions, evidenceBoundary, latexSafety, instructions, profileInstructions] = await Promise.all([
      readFile(join(this.skillsDirectory, "_shared", "academic-writing.md"), "utf8"),
      readFile(join(this.skillsDirectory, "_shared", "venue-specialization.md"), "utf8"),
      readFile(join(this.skillsDirectory, "_shared", "evidence-boundary.md"), "utf8"),
      readFile(join(this.skillsDirectory, "_shared", "latex-safety.md"), "utf8"),
      readFile(join(directory, "SKILL.md"), "utf8"),
      readFile(join(directory, "references", "profile.md"), "utf8")
    ]);
    const combinedInstructions = `${baseInstructions}\n\n${evidenceBoundary}\n\n${latexSafety}\n\n${instructions}`;
    if (!target) return { instructions: combinedInstructions, venueInstructions: profileInstructions };
    if (target.domain !== skill.id || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(target.venueId)) return { instructions: combinedInstructions, venueInstructions: profileInstructions };
    const venueInstructions = await readFile(join(directory, "references", "venues", `${target.venueId}.md`), "utf8");
    const venueRules = await readFile(join(directory, "references", "venues", `${target.venueId}.rules.json`), "utf8").then((raw) => JSON.parse(raw) as LoadedSkill["venueRules"]).catch(() => undefined);
    const metadata = parseVenueFrontmatter(venueInstructions, skill.id);
    const targetContext = `Selected publication target: ${metadata?.label ?? target.venueId}\nTemplate year: ${target.year ?? "current verified edition"}\nManuscript stage: ${target.stage}\nTrack: ${target.track ?? "main or regular article"}`;
    return { instructions: combinedInstructions, venueInstructions: `${profileInstructions}\n\n${specializationInstructions}\n\n${targetContext}\n\n${venueInstructions}`, ...(venueRules ? { venueRules } : {}) };
  }

  async catalog(): Promise<PublicationVenueOption[]> {
    const entries: PublicationVenueOption[] = [];
    for (const domain of WRITING_PROFILES) {
      const directory = join(this.skillsDirectory, domain.value, "references", "venues");
      const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
      for (const file of files.filter((name) => name.endsWith(".md")).sort()) {
        const parsed = parseVenueFrontmatter(await readFile(join(directory, file), "utf8"), domain.value);
        if (parsed) {
          const template = templateForVenue(parsed.value);
          entries.push({ ...parsed, ...(template ? { template } : {}) });
        }
      }
    }
    return entries;
  }
}

export function parseSkillManifest(raw: string, directoryName?: string): SkillManifest {
  let input: unknown;
  try { input = JSON.parse(raw); } catch { throw new Error("Skill manifest must be valid JSON"); }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Skill manifest must be an object");
  const value = input as Record<string, unknown>;
  const string = (key: string, pattern?: RegExp) => { const item = value[key]; if (typeof item !== "string" || !item.trim() || (pattern && !pattern.test(item))) throw new Error(`Skill manifest field '${key}' is invalid`); return item.trim(); };
  const list = (key: string) => { const item = value[key]; if (!Array.isArray(item) || item.some((value) => typeof value !== "string" || !value.trim())) throw new Error(`Skill manifest field '${key}' must be a string array`); return [...new Set(item.map((value) => value.trim()))]; };
  const id = string("id", /^[a-z0-9][a-z0-9-]{0,79}$/);
  if (directoryName && id !== directoryName) throw new Error("Skill manifest id must match its directory");
  const scope = string("scope"); if (scope !== "system" && scope !== "team" && scope !== "project") throw new Error("Skill manifest scope is invalid");
  const riskLevel = string("riskLevel"); if (riskLevel !== "low" && riskLevel !== "medium" && riskLevel !== "high") throw new Error("Skill manifest riskLevel is invalid");
  const maxContextChars = value.maxContextChars; if (!Number.isInteger(maxContextChars) || (maxContextChars as number) < 1 || (maxContextChars as number) > 1_000_000) throw new Error("Skill manifest maxContextChars is invalid");
  if (typeof value.requiresReview !== "boolean") throw new Error("Skill manifest requiresReview is invalid");
  const references = value.references; if (!Array.isArray(references) || references.some((reference) => !reference || typeof reference !== "object" || Array.isArray(reference) || typeof (reference as Record<string, unknown>).url !== "string" || typeof (reference as Record<string, unknown>).license !== "string" || typeof (reference as Record<string, unknown>).verifiedAt !== "string")) throw new Error("Skill manifest references are invalid");
  return { id, version: string("version", /^\d+\.\d+\.\d+$/), scope, owner: string("owner"), license: string("license"), workflows: list("workflows"), requiredEvidence: list("requiredEvidence"), capabilities: list("capabilities"), maxContextChars: maxContextChars as number, riskLevel, requiresReview: value.requiresReview, references: references.map((reference) => { const item = reference as Record<string, string>; return { url: item.url!, license: item.license!, verifiedAt: item.verifiedAt! }; }) };
}

function parseVenueFrontmatter(content: string, expectedDomain: ResearchDomainId): PublicationVenueOption | undefined {
  const block = /^---\s*\n([\s\S]*?)\n---/.exec(content)?.[1];
  if (!block) return undefined;
  const fields = Object.fromEntries(block.split(/\r?\n/).flatMap((line) => {
    const match = /^([A-Za-z][A-Za-z0-9]*):\s*(.*?)\s*$/.exec(line);
    return match?.[1] ? [[match[1], (match[2] ?? "").replace(/^['"]|['"]$/g, "")]] : [];
  }));
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(fields.id ?? "") || fields.domain !== expectedDomain || fields.ccfRank !== "A" || (fields.kind !== "conference" && fields.kind !== "journal")) return undefined;
  const pageLimit = positiveNumber(fields.pageLimit);
  const totalPageLimit = positiveNumber(fields.totalPageLimit);
  const cameraReadyPageLimit = positiveNumber(fields.cameraReadyPageLimit);
  const cameraReadyTotalPageLimit = positiveNumber(fields.cameraReadyTotalPageLimit);
  const requiredSections = splitList(fields.requiredSections);
  const requiredLatex = splitList(fields.requiredLatex);
  const constraints: NonNullable<PublicationVenueOption["constraints"]> = {
    ...(pageLimit ? { pageLimit } : {}),
    ...(totalPageLimit ? { totalPageLimit } : {}),
    ...(cameraReadyPageLimit ? { cameraReadyPageLimit } : {}),
    ...(cameraReadyTotalPageLimit ? { cameraReadyTotalPageLimit } : {}),
    ...(fields.anonymous === "true" || fields.anonymous === "false" ? { anonymous: fields.anonymous === "true" } : {}),
    ...(requiredSections.length ? { requiredSections } : {}),
    ...(requiredLatex.length ? { requiredLatex } : {})
  };
  return {
    value: fields.id!, label: fields.name || fields.id!, kind: fields.kind,
    domain: expectedDomain, edition: fields.edition || "unverified", verifiedAt: fields.verifiedAt || "unverified", sourceUrl: fields.sourceUrl || "",
    ...(Object.keys(constraints).length ? { constraints } : {})
  };
}

function positiveNumber(value?: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function splitList(value?: string): string[] {
  return value ? value.split("|").map((item) => item.trim()).filter(Boolean) : [];
}
