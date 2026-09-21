import { readFile, readdir } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { WRITING_PROFILES, type AgentTaskIntent, type AgentTaskSkillDescriptor, type PaperSkillRef, type PublicationTarget, type PublicationVenueOption, type ResearchDomainId } from "@fastwrite/shared";
import { templateForVenue } from "../templates/latex-template-service";
import type { JsonDatabase } from "../storage/database";
import { writingGuard, writingGuardMany } from "../writing/writing-guard";

export interface LoadedSkill {
  instructions: string;
  venueInstructions: string;
  venueRules?: { version?: string; sourceUrl?: string; stages?: string[]; checks?: Array<{ id: string; category: string; pattern?: string; message?: string }> };
}

export type WorkflowSkill = "draft" | "revise" | "review" | "completion" | "memory-extract" | "memory-polish" | "compile-repair";

export interface WorkflowSkillDescriptor { id: WorkflowSkill; version: string; instructions: string }
export interface SkillManifest { id: string; version: string; scope: "system" | "team" | "project"; owner: string; license: string; workflows: string[]; requiredEvidence: string[]; capabilities: string[]; maxContextChars: number; riskLevel: "low" | "medium" | "high"; requiresReview: boolean; references: Array<{ url: string; license: string; verifiedAt: string }>; fixtures?: Array<{ id: string; input: string; expected: string }>; eval?: { status: "not-run" | "passed" | "failed"; score?: number; checkedAt?: string; message?: string }; revoked?: boolean; revokedReason?: string }

export class SkillRegistry {
  constructor(private readonly skillsDirectory: string, private readonly database?: JsonDatabase) {}

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
    const overrides = new Map((this.database?.snapshot().skillReleaseOverrides ?? []).map((item) => [item.skillId, item]));
    return manifests.filter((manifest): manifest is SkillManifest => Boolean(manifest)).map((manifest) => {
      const override = overrides.get(manifest.id);
      return override ? { ...manifest, ...(override.revoked ? { revoked: true, revokedReason: override.reason } : {}), ...(override.eval ? { eval: override.eval } : {}) } : manifest;
    }).sort((a, b) => a.id.localeCompare(b.id));
  }

  async release(id: string): Promise<SkillManifest> {
    const manifest = (await this.publishedCatalog()).find((item) => item.id === id);
    if (!manifest) throw new Error(`Unknown Skill release '${id}'`);
    return manifest;
  }

  async evaluate(id: string): Promise<SkillManifest> {
    const manifest = await this.release(id);
    if (manifest.revoked) return { ...manifest, eval: { status: "failed", score: 0, message: "Release is revoked and cannot be evaluated.", checkedAt: new Date().toISOString() } };
    const fixtures = manifest.fixtures ?? [];
    const checkedAt = new Date().toISOString();
    if (!fixtures.length) return { ...manifest, eval: { status: "not-run", message: "No fixtures declared for this release.", checkedAt } };
    const failures: string[] = [];
    for (const fixture of fixtures) {
      let content = fixture.input;
      if (fixture.input.startsWith("fixture:")) {
        const name = fixture.input.slice("fixture:".length);
        const root = resolve(this.skillsDirectory, manifest.id, "fixtures");
        const candidate = resolve(root, name);
        if (relative(root, candidate).startsWith("..") || relative(root, candidate).includes("..")) { failures.push(`${fixture.id}: fixture path escapes release directory`); continue; }
        try { content = await readFile(candidate, "utf8"); } catch { failures.push(`${fixture.id}: fixture file not found`); continue; }
      }
      const findings = (manifest.id === "review" ? writingGuard({ path: `${fixture.id}.tex`, content }) : writingGuard({ path: `${fixture.id}.txt`, content }));
      const expected = fixture.expected.trim().toLowerCase();
      const actual = findings.length ? "findings" : "clean";
      const valid = expected === actual || (expected === "blocking" && findings.some((item) => item.status === "blocking")) || (expected === "warning" && findings.some((item) => item.status === "warning"));
      if (!valid) failures.push(`${fixture.id}: expected ${fixture.expected}, got ${actual}`);
    }
    const result = { status: failures.length ? "failed" as const : "passed" as const, score: (fixtures.length - failures.length) / fixtures.length, message: failures.length ? failures.join("; ").slice(0, 500) : `${fixtures.length} fixture${fixtures.length === 1 ? "" : "s"} passed.` };
    const evaluated = { ...manifest, eval: { ...result, checkedAt } };
    if (this.database) await this.database.mutate((state) => { const prior = state.skillReleaseOverrides.find((item) => item.skillId === id); if (prior) prior.eval = { ...result, checkedAt }; else state.skillReleaseOverrides.push({ skillId: id, revoked: false, reason: "", eval: { ...result, checkedAt }, createdAt: checkedAt }); });
    return evaluated;
  }

  async rollback(id: string, reason: string): Promise<SkillManifest> {
    const manifest = await this.release(id);
    if (!reason.trim()) throw new Error("A rollback reason is required");
    const cleanReason = reason.trim().slice(0, 500); const createdAt = new Date().toISOString();
    if (this.database) await this.database.mutate((state) => { const prior = state.skillReleaseOverrides.find((item) => item.skillId === id); if (prior) { prior.revoked = true; prior.reason = cleanReason; prior.createdAt = createdAt; } else state.skillReleaseOverrides.push({ skillId: id, revoked: true, reason: cleanReason, createdAt }); });
    return { ...manifest, revoked: true, revokedReason: cleanReason };
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
  const fixtures = value.fixtures === undefined ? undefined : (() => { if (!Array.isArray(value.fixtures) || value.fixtures.some((fixture) => !fixture || typeof fixture !== "object" || typeof (fixture as Record<string, unknown>).id !== "string" || typeof (fixture as Record<string, unknown>).input !== "string" || typeof (fixture as Record<string, unknown>).expected !== "string")) throw new Error("Skill manifest fixtures are invalid"); return (value.fixtures as Array<Record<string, unknown>>).slice(0, 100).map((fixture) => ({ id: String(fixture.id).slice(0, 100), input: String(fixture.input).slice(0, 20_000), expected: String(fixture.expected).slice(0, 20_000) })); })();
  const evalRecord = value.eval === undefined ? undefined : (() => { if (!value.eval || typeof value.eval !== "object") throw new Error("Skill manifest eval is invalid"); const item = value.eval as Record<string, unknown>; if (typeof item.status !== "string" || !new Set(["not-run", "passed", "failed"]).has(item.status) || (item.score !== undefined && (typeof item.score !== "number" || item.score < 0 || item.score > 1))) throw new Error("Skill manifest eval is invalid"); return { status: item.status as "not-run" | "passed" | "failed", ...(typeof item.score === "number" ? { score: item.score } : {}), ...(typeof item.checkedAt === "string" ? { checkedAt: item.checkedAt } : {}), ...(typeof item.message === "string" ? { message: item.message.slice(0, 500) } : {}) }; })();
  if (typeof value.revoked !== "undefined" && typeof value.revoked !== "boolean") throw new Error("Skill manifest revoked is invalid");
  return { id, version: string("version", /^\d+\.\d+\.\d+$/), scope, owner: string("owner"), license: string("license"), workflows: list("workflows"), requiredEvidence: list("requiredEvidence"), capabilities: list("capabilities"), maxContextChars: maxContextChars as number, riskLevel, requiresReview: value.requiresReview, references: references.map((reference) => { const item = reference as Record<string, string>; return { url: item.url!, license: item.license!, verifiedAt: item.verifiedAt! }; }), ...(fixtures ? { fixtures } : {}), ...(evalRecord ? { eval: evalRecord } : {}), ...(value.revoked === true ? { revoked: true, ...(typeof value.revokedReason === "string" ? { revokedReason: value.revokedReason.slice(0, 500) } : {}) } : {}) };
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
