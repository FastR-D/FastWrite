import type { MemoryCandidate, MemoryFreshness, MemoryItem, MemoryItemStatus, MemoryOverview, MemorySectionSummary, MemorySource, OutlineItem, PaperMemory, PaperSkillRef, WorkspaceTreeNode } from "@fastwrite/shared";
import { ApiError } from "../http";
import type { JsonDatabase } from "../storage/database";
import type { WorkspaceService } from "../workspace/workspace-service";
import type { AgentProvider, MemoryAgentOutput, MemoryHierarchyOutput } from "./provider";
import type { SkillRegistry } from "./skill-registry";

const MEMORY_CHUNK_BYTES = 48_000;
const MAX_HIERARCHY_FACTS = 200;
const MAX_ITEM_CONTENT = 4_000;
const MAX_SUMMARY_CONTENT = 8_000;
const MAX_LOCAL_CORE_CONTENT = 2_000;
const MAX_LOCAL_SECTION_CONTENT = 2_500;
const MEMORY_FILE = "memory.md";

type MemoryDocument = { path: string; content: string; version: number };
type ProposedItem = Pick<MemoryItem, "category" | "label" | "content" | "sources"> & { key: string };
type ProposedSection = Pick<MemorySectionSummary, "key" | "path" | "title" | "content" | "sources">;

function now() { return new Date().toISOString(); }
function textPaths(nodes: WorkspaceTreeNode[]): string[] { return nodes.flatMap((node) => node.type === "directory" ? textPaths(node.children) : node.kind === "text" ? [node.path] : []); }
function outlineItems(items: OutlineItem[]): OutlineItem[] { return items.flatMap((item) => [item, ...outlineItems(item.children)]); }
function normalized(value: string): string { return value.trim().replace(/\s+/g, " ").toLocaleLowerCase(); }
function itemKey(category: MemoryItem["category"], label: string): string { return `${category}:${normalized(label)}`; }
function sectionKey(path: string, title: string): string { return `${path}:${normalized(title)}`; }
function itemLocked(item: MemoryItem): boolean { return item.locked ?? (item.status === "confirmed" || item.humanEdited === true); }
function summaryLocked(summary: MemoryOverview | MemorySectionSummary): boolean { return summary.locked || summary.humanEdited; }
function memoryTextPath(path: string): boolean { return path !== MEMORY_FILE && /\.(?:tex|md|bib|txt)$/i.test(path); }

export class MemoryService {
  constructor(private readonly database: JsonDatabase, private readonly workspaces: WorkspaceService, private readonly skills: SkillRegistry, private readonly provider?: AgentProvider) {}

  latest(projectId: string): PaperMemory | null {
    const stored = this.latestStored(projectId);
    if (!stored) return null;
    return this.withFreshness(stored, this.database.snapshot().fileVersions[projectId] ?? {});
  }

  /** Returns the stored memory, or enough of a checked-in memory.md to reopen it after a database reset. */
  async get(projectId: string): Promise<PaperMemory | null> {
    const stored = this.latest(projectId);
    if (stored) return stored;
    const file = await this.readMemoryFile(projectId);
    if (!file) return null;
    const reviewed = sectionFromMarkdown(file.content, "Reviewed Context");
    const instructions = sectionFromMarkdown(file.content, "User Instructions");
    if (!reviewed && !instructions) return null;
    const project = this.workspaces.getProject(projectId);
    const timestamp = now();
    return {
      id: `memory_file_${projectId}`,
      projectId,
      version: 0,
      projectVersion: project.version,
      ...(reviewed ? { overview: { content: reviewed, origin: "human" as const, humanEdited: true, locked: true, createdAt: timestamp, updatedAt: timestamp } } : {}),
      sections: [],
      items: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
  }

  async extract(projectId: string): Promise<PaperMemory> {
    if (!this.provider?.extractMemory) throw new ApiError(503, "agent_not_configured", "Set OPENAI_API_KEY to generate Paper Memory");
    const project = this.workspaces.getProject(projectId);
    const [documents, outline] = await Promise.all([this.documents(projectId), this.workspaces.outline(projectId)]);
    const skill = await this.skills.load(project.skill, project.publicationTarget);
    const documentMap = new Map(documents.map((document) => [document.path, document]));
    const outputs: MemoryAgentOutput[] = [];
    for (const chunk of documentChunks(documents)) {
      outputs.push(await this.provider.extractMemory({ documents: chunk, skill: project.skill, skillInstructions: skill.instructions, venueInstructions: skill.venueInstructions }));
    }

    const timestamp = now();
    const proposed = deduplicateItems(outputs.flatMap((output) => this.validateItems(output, documentMap, timestamp)));
    const hierarchy = await this.hierarchy(projectId, project.skill, skill.instructions, skill.venueInstructions, outline, proposed);
    const sectionProposals = this.sectionProposals(outline, hierarchy, proposed, timestamp);
    const overviewContent = cleanContent(hierarchy.overview, MAX_SUMMARY_CONTENT) || fallbackOverview(proposed);
    const previous = this.latest(projectId);
    const versions = this.database.snapshot().fileVersions[projectId] ?? {};
    const memory: PaperMemory = {
      id: `memory_${crypto.randomUUID()}`,
      projectId,
      version: (previous?.version ?? 0) + 1,
      projectVersion: project.version,
      overview: reconcileOverview(previous?.overview, overviewContent, timestamp),
      sections: reconcileSections(previous?.sections ?? [], sectionProposals, versions, timestamp),
      items: reconcileItems(previous?.items ?? [], proposed, versions, timestamp),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const saved = await this.database.mutate((state) => { state.paperMemories.push(memory); return memory; });
    await this.syncFile(saved, "candidate");
    return saved;
  }

  async updateItem(projectId: string, itemId: string, updates: { status?: MemoryItemStatus; content?: string; label?: string }, signal?: AbortSignal): Promise<PaperMemory> {
    const latest = this.requireLatest(projectId);
    const item = latest.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new ApiError(404, "memory_item_not_found", "Paper Memory item not found");
    if (updates.content !== undefined && !updates.content.trim()) throw new ApiError(400, "memory_content_empty", "Memory content cannot be empty");
    const nextLabel = updates.label === undefined ? item.label : updates.label.trim();
    const nextContent = updates.content === undefined
      ? item.content
      : await this.polishContent(projectId, "fact", nextLabel || item.label, updates.content, MAX_ITEM_CONTENT, signal);
    const edited = nextContent !== item.content || nextLabel !== item.label;
    if (updates.status) item.status = updates.status;
    item.content = nextContent;
    item.label = nextLabel || item.label;
    item.key = itemKey(item.category, item.label);
    if (edited) { item.origin = "human"; item.humanEdited = true; item.locked = true; delete item.candidate; }
    if (updates.status === "confirmed") { item.locked = true; delete item.candidate; }
    item.freshness = freshness(item.sources, this.database.snapshot().fileVersions[projectId] ?? {});
    item.updatedAt = now();
    return this.saveAndSync(latest);
  }

  async updateOverview(projectId: string, content: string, locked = true, signal?: AbortSignal): Promise<PaperMemory> {
    const latest = this.requireLatest(projectId);
    const timestamp = now();
    if (!content.trim()) throw new ApiError(400, "memory_content_empty", "Memory overview cannot be empty");
    latest.overview = {
      content: await this.polishContent(projectId, "overview", "Paper overview", content, MAX_SUMMARY_CONTENT, signal), origin: "human", humanEdited: true, locked,
      createdAt: latest.overview?.createdAt ?? timestamp, updatedAt: timestamp
    };
    return this.saveAndSync(latest);
  }

  async updateSection(projectId: string, sectionId: string, content: string, locked = true, signal?: AbortSignal): Promise<PaperMemory> {
    const latest = this.requireLatest(projectId);
    const section = latest.sections?.find((candidate) => candidate.id === sectionId);
    if (!section) throw new ApiError(404, "memory_section_not_found", "Paper Memory section was not found");
    if (!content.trim()) throw new ApiError(400, "memory_content_empty", "Memory section cannot be empty");
    section.content = await this.polishContent(projectId, "section", `${section.title} (${section.path})`, content, MAX_SUMMARY_CONTENT, signal);
    section.origin = "human";
    section.humanEdited = true;
    section.locked = locked;
    delete section.candidate;
    section.freshness = freshness(section.sources, this.database.snapshot().fileVersions[projectId] ?? {});
    section.updatedAt = now();
    return this.saveAndSync(latest);
  }

  async acceptOverviewCandidate(projectId: string): Promise<PaperMemory> {
    const latest = this.requireLatest(projectId);
    const candidate = latest.overview?.candidate;
    if (!latest.overview || !candidate) throw new ApiError(409, "memory_candidate_not_found", "Paper overview has no regenerated candidate");
    latest.overview.content = candidate.content;
    latest.overview.origin = "ai";
    latest.overview.humanEdited = false;
    latest.overview.locked = true;
    latest.overview.updatedAt = now();
    delete latest.overview.candidate;
    return this.saveAndSync(latest);
  }

  async acceptSectionCandidate(projectId: string, sectionId: string): Promise<PaperMemory> {
    const latest = this.requireLatest(projectId);
    const section = latest.sections?.find((candidate) => candidate.id === sectionId);
    if (!section?.candidate) throw new ApiError(409, "memory_candidate_not_found", "Paper Memory section has no regenerated candidate");
    section.content = section.candidate.content;
    section.sources = section.candidate.sources;
    section.origin = "ai";
    section.humanEdited = false;
    section.locked = true;
    section.updatedAt = now();
    delete section.candidate;
    return this.saveAndSync(latest);
  }

  async acceptItemCandidate(projectId: string, itemId: string): Promise<PaperMemory> {
    const latest = this.requireLatest(projectId);
    const item = latest.items.find((candidate) => candidate.id === itemId);
    if (!item?.candidate) throw new ApiError(409, "memory_candidate_not_found", "Paper Memory fact has no regenerated candidate");
    item.label = item.candidate.label;
    item.content = item.candidate.content;
    item.sources = item.candidate.sources;
    item.key = itemKey(item.category, item.label);
    item.origin = "ai";
    item.humanEdited = false;
    item.status = "confirmed";
    item.locked = true;
    item.freshness = freshness(item.sources, this.database.snapshot().fileVersions[projectId] ?? {});
    item.updatedAt = now();
    delete item.candidate;
    return this.saveAndSync(latest);
  }

  rollback(projectId: string): Promise<PaperMemory> {
    const memories = this.database.snapshot().paperMemories.filter((memory) => memory.projectId === projectId).sort((a, b) => b.version - a.version);
    if (memories.length < 2) throw new ApiError(409, "memory_no_previous_version", "Paper Memory has no previous version");
    return this.saveAndSync(this.withFreshness(memories[1]!, this.database.snapshot().fileVersions[projectId] ?? {}));
  }

  /** Accept the complete candidate in one review action and make it the durable project memory. */
  async applyReviewed(projectId: string): Promise<PaperMemory> {
    const latest = this.requireLatest(projectId);
    const approved = structuredClone(latest);
    const timestamp = now();
    if (approved.overview?.candidate) {
      approved.overview.content = approved.overview.candidate.content;
      delete approved.overview.candidate;
    }
    if (approved.overview) { approved.overview.locked = true; approved.overview.updatedAt = timestamp; }
    approved.sections = (approved.sections ?? []).map((section) => {
      if (section.candidate) { section.content = section.candidate.content; delete section.candidate; }
      section.locked = true; section.updatedAt = timestamp;
      return section;
    });
    approved.items = approved.items.map((item) => {
      if (item.status === "rejected") return item;
      if (item.candidate) {
        item.label = item.candidate.label;
        item.content = item.candidate.content;
        item.sources = item.candidate.sources;
        item.key = itemKey(item.category, item.label);
        delete item.candidate;
      }
      item.status = "confirmed";
      item.locked = true;
      item.updatedAt = timestamp;
      return item;
    });
    return this.saveAndSync(approved);
  }

  /** Full durable context is reserved for the cross-file Agent workflow. */
  async fullAgentContext(projectId: string): Promise<{ version?: number; content: string }> {
    const latest = this.latest(projectId);
    const memoryFile = await this.readMemoryFile(projectId);
    const instructions = memoryFile ? sectionFromMarkdown(memoryFile.content, "User Instructions") : "";
    if (!latest) {
      const reviewed = memoryFile ? sectionFromMarkdown(memoryFile.content, "Reviewed Context") : "";
      const content = [instructions ? `[user-instructions]\n${instructions}` : "", reviewed ? `[reviewed-paper-memory]\n${reviewed}` : ""].filter(Boolean).join("\n\n");
      return content ? { content } : { content: "" };
    }
    const lines: string[] = instructions ? [`[user-instructions]\n${instructions}`] : [];
    if (latest.overview && summaryLocked(latest.overview)) lines.push(`[paper-overview] ${latest.overview.content}`);
    for (const section of latest.sections ?? []) {
      if (summaryLocked(section) && (section.freshness === "current" || section.humanEdited)) lines.push(`[section:${section.title}] ${section.content}`);
    }
    for (const item of latest.items) {
      const confirmed = item.status === "confirmed" || itemLocked(item);
      if (confirmed && (item.freshness === "current" || itemLocked(item))) {
        lines.push(`[${item.category}] ${item.label}: ${item.content}${item.freshness === "stale" ? " (source changed; user-confirmed)" : ""}`);
      }
    }
    const content = lines.join("\n");
    return content ? { version: latest.version, content } : { content };
  }

  /** Local writers receive only a compact paper core and the active file's section summary. */
  async focusedWriterContext(projectId: string, path: string, sectionTitle?: string): Promise<{ version?: number; content: string }> {
    const latest = this.latest(projectId);
    if (!latest) {
      const memoryFile = await this.readMemoryFile(projectId);
      const reviewed = memoryFile ? sectionFromMarkdown(memoryFile.content, "Reviewed Context") : "";
      const overview = markdownSubsection(reviewed, "Overview");
      const section = markdownSectionForPath(reviewed, path, sectionTitle);
      const content = [overview ? `[paper-overview] ${overview.slice(0, MAX_LOCAL_CORE_CONTENT)}` : "", section ? `[current-section] ${section.slice(0, MAX_LOCAL_SECTION_CONTENT)}` : ""].filter(Boolean).join("\n");
      return content ? { content } : { content: "" };
    }

    const lines: string[] = [];
    if (latest.overview && summaryLocked(latest.overview)) {
      lines.push(`[paper-overview] ${latest.overview.content.slice(0, MAX_LOCAL_CORE_CONTENT)}`);
    } else {
      const core = latest.items
        .filter((item) => ["research-question", "contribution", "system-model"].includes(item.category))
        .filter((item) => (item.status === "confirmed" || itemLocked(item)) && (item.freshness === "current" || item.humanEdited))
        .slice(0, 6)
        .map((item) => `${item.label}: ${item.content}`)
        .join("\n");
      if (core) lines.push(`[paper-overview] ${core.slice(0, MAX_LOCAL_CORE_CONTENT)}`);
    }
    const matchingSections = (latest.sections ?? []).filter((section) => section.path === path && (!sectionTitle || normalized(section.title) === normalized(sectionTitle)));
    const usableSections = matchingSections.filter((section) => summaryLocked(section) && section.content && (section.freshness === "current" || section.humanEdited));
    for (const section of usableSections) {
      lines.push(`[current-section:${section.title}] ${section.content.slice(0, MAX_LOCAL_SECTION_CONTENT)}`);
    }
    if (!usableSections.length) {
      const localFacts = latest.items
        .filter((item) => (item.status === "confirmed" || itemLocked(item)) && (item.freshness === "current" || item.humanEdited))
        .filter((item) => item.sources.some((source) => source.path === path && (!sectionTitle || !source.section || normalized(source.section) === normalized(sectionTitle))))
        .slice(0, 6)
        .map((item) => `${item.label}: ${item.content}`)
        .join("\n");
      if (localFacts) lines.push(`[current-section${sectionTitle ? `:${sectionTitle}` : ""}] ${localFacts.slice(0, MAX_LOCAL_SECTION_CONTENT)}`);
    }
    const content = lines.join("\n");
    return content ? { version: latest.version, content } : { content: "" };
  }

  private latestStored(projectId: string): PaperMemory | null {
    return this.database.snapshot().paperMemories.filter((memory) => memory.projectId === projectId).sort((a, b) => b.version - a.version)[0] ?? null;
  }

  private requireLatest(projectId: string): PaperMemory {
    const latest = this.latest(projectId);
    if (!latest) throw new ApiError(404, "paper_memory_not_found", "Generate Paper Memory first");
    return latest;
  }

  private withFreshness(memory: PaperMemory, versions: Record<string, { version: number }>): PaperMemory {
    const result = structuredClone(memory);
    result.items = result.items.map((item) => ({
      ...item,
      key: item.key ?? itemKey(item.category, item.label),
      origin: item.origin ?? "ai",
      humanEdited: item.humanEdited ?? false,
      locked: itemLocked(item),
      freshness: freshness(item.sources, versions)
    }));
    if (result.sections) result.sections = result.sections.map((section) => ({ ...section, origin: section.origin ?? "ai", humanEdited: section.humanEdited ?? false, freshness: freshness(section.sources, versions) }));
    if (result.overview) result.overview = { ...result.overview, origin: result.overview.origin ?? "ai", humanEdited: result.overview.humanEdited ?? false };
    return result;
  }

  private async documents(projectId: string): Promise<MemoryDocument[]> {
    const paths = textPaths(await this.workspaces.tree(projectId)).filter(memoryTextPath);
    return Promise.all(paths.map(async (path) => {
      const opened = await this.workspaces.readTextFile(projectId, path);
      return { path, content: opened.content, version: opened.file.version };
    }));
  }

  private async saveAndSync(source: PaperMemory): Promise<PaperMemory> {
    const saved = await this.saveVersion(source);
    await this.syncFile(saved, "reviewed");
    return saved;
  }

  private async polishContent(projectId: string, kind: "overview" | "section" | "fact", title: string, content: string, limit: number, signal?: AbortSignal): Promise<string> {
    if (!this.provider?.polishMemory) throw new ApiError(503, "memory_polish_not_configured", "Configure FASTWRITE_MEMORY_* in .env to polish edited Paper Memory");
    const project = this.workspaces.getProject(projectId);
    const skill = await this.skills.load(project.skill, project.publicationTarget);
    const polished = await this.provider.polishMemory({ kind, title, content: cleanContent(content, limit), skill: project.skill, skillInstructions: skill.instructions, venueInstructions: skill.venueInstructions }, signal);
    const result = cleanContent(polished.content, limit);
    if (!result) throw new ApiError(502, "memory_polish_empty", "The configured Memory model returned empty content");
    return result;
  }

  private async readMemoryFile(projectId: string): Promise<{ content: string; version: number } | null> {
    if (!await this.workspaces.fileExists(projectId, MEMORY_FILE)) return null;
    const opened = await this.workspaces.readTextFile(projectId, MEMORY_FILE);
    return { content: opened.content, version: opened.file.version };
  }

  private async syncFile(memory: PaperMemory, mode: "candidate" | "reviewed"): Promise<void> {
    const existing = await this.readMemoryFile(memory.projectId);
    const instructions = existing ? sectionFromMarkdown(existing.content, "User Instructions") : "";
    const content = renderMemoryFile(memory, instructions, mode);
    if (!existing) { await this.workspaces.createFile(memory.projectId, MEMORY_FILE, content); return; }
    await this.workspaces.saveTextFile(memory.projectId, MEMORY_FILE, { content, baseVersion: existing.version });
  }

  private validateItems(output: MemoryAgentOutput, documents: Map<string, MemoryDocument>, timestamp: string): ProposedItem[] {
    return output.items.flatMap((item) => {
      const label = item.label.trim();
      const content = cleanContent(item.content, MAX_ITEM_CONTENT);
      const sources = item.sources.flatMap((source) => sourceFor(source.path, source.excerpt, source.section, documents));
      if (!label || !content || !sources.length) return [];
      return [{ category: item.category, label, content, sources, key: itemKey(item.category, label) }];
    });
  }

  private async hierarchy(_projectId: string, skill: PaperSkillRef, skillInstructions: string, venueInstructions: string, outline: OutlineItem[], facts: ProposedItem[]): Promise<MemoryHierarchyOutput> {
    const flatOutline = outlineItems(outline).map(({ path, title, line }) => ({ path, title, line })).slice(0, 200);
    const hierarchyFacts = facts.slice(0, MAX_HIERARCHY_FACTS).map((fact) => ({ category: fact.category, label: fact.label, content: fact.content, sources: fact.sources.map((source) => ({ path: source.path, ...(source.section ? { section: source.section } : {}) })) }));
    if (this.provider?.summarizeMemory) {
      return this.provider.summarizeMemory({ outline: flatOutline, facts: hierarchyFacts, skill, skillInstructions, venueInstructions });
    }
    return { overview: fallbackOverview(facts), sections: flatOutline.map((section) => ({ path: section.path, title: section.title, content: fallbackSection(section.path, facts) })) };
  }

  private sectionProposals(outline: OutlineItem[], hierarchy: MemoryHierarchyOutput, facts: ProposedItem[], timestamp: string): ProposedSection[] {
    const summaries = new Map(hierarchy.sections.map((section) => [sectionKey(section.path, section.title), section]));
    return outlineItems(outline).map((entry) => {
      const key = sectionKey(entry.path, entry.title);
      const summary = summaries.get(key);
      const content = cleanContent(summary?.content ?? fallbackSection(entry.path, facts), MAX_SUMMARY_CONTENT);
      const sources = sourcesForPath(entry.path, facts);
      return { key, path: entry.path, title: entry.title, content, sources };
    }).filter((section) => Boolean(section.content));
  }

  private saveVersion(source: PaperMemory): Promise<PaperMemory> {
    const project = this.workspaces.getProject(source.projectId);
    const latestVersion = Math.max(0, ...this.database.snapshot().paperMemories.filter((memory) => memory.projectId === source.projectId).map((memory) => memory.version));
    const saved: PaperMemory = { ...structuredClone(source), id: `memory_${crypto.randomUUID()}`, version: latestVersion + 1, projectVersion: project.version, createdAt: now(), updatedAt: now() };
    return this.database.mutate((state) => { state.paperMemories.push(saved); return saved; });
  }
}

function documentChunks(documents: MemoryDocument[]): MemoryDocument[][] {
  const fragments = documents.flatMap(splitDocument);
  const groups: MemoryDocument[][] = [];
  let current: MemoryDocument[] = [];
  let bytes = 0;
  for (const fragment of fragments) {
    const size = Buffer.byteLength(fragment.content);
    if (current.length && bytes + size > MEMORY_CHUNK_BYTES) { groups.push(current); current = []; bytes = 0; }
    current.push(fragment);
    bytes += size;
  }
  if (current.length) groups.push(current);
  return groups;
}

function splitDocument(document: MemoryDocument): MemoryDocument[] {
  if (Buffer.byteLength(document.content) <= MEMORY_CHUNK_BYTES) return [document];
  const lines = document.content.split("\n");
  const fragments: MemoryDocument[] = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (current && Buffer.byteLength(next) > MEMORY_CHUNK_BYTES) { fragments.push({ ...document, content: current }); current = line; }
    else current = next;
  }
  if (current) fragments.push({ ...document, content: current });
  return fragments;
}

function sourceFor(path: string, rawExcerpt: string, section: string | null, documents: Map<string, MemoryDocument>): MemorySource[] {
  const document = documents.get(path);
  const excerpt = rawExcerpt.trim().slice(0, 1_000);
  const offset = document?.content.indexOf(excerpt) ?? -1;
  if (!document || !excerpt || offset < 0) return [];
  return [{ path, line: document.content.slice(0, offset).split("\n").length, ...(section ? { section } : {}), excerpt, fileVersion: document.version }];
}

function deduplicateItems(items: ProposedItem[]): ProposedItem[] {
  const result = new Map<string, ProposedItem>();
  for (const item of items) {
    const existing = result.get(item.key);
    if (!existing) { result.set(item.key, item); continue; }
    existing.sources = mergeSources(existing.sources, item.sources);
    if (item.content.length > existing.content.length) existing.content = item.content;
  }
  return [...result.values()];
}

function reconcileItems(previous: MemoryItem[], proposed: ProposedItem[], versions: Record<string, { version: number }>, timestamp: string): MemoryItem[] {
  const existing = new Map(previous.map((item) => [item.key ?? itemKey(item.category, item.label), item]));
  const result: MemoryItem[] = [];
  for (const proposal of proposed) {
    const current = existing.get(proposal.key);
    if (current?.status === "rejected") { result.push(current); existing.delete(proposal.key); continue; }
    if (current && itemLocked(current)) {
      const same = normalized(current.content) === normalized(proposal.content) && normalized(current.label) === normalized(proposal.label);
      const locked = clearCandidate(current);
      result.push({ ...locked, key: proposal.key, locked: true, freshness: freshness(current.sources, versions), ...(same ? { sources: mergeSources(current.sources, proposal.sources) } : { candidate: candidateFor(proposal, timestamp) }) });
    } else if (current) {
      const generated = clearCandidate(current);
      result.push({ ...generated, key: proposal.key, label: proposal.label, content: proposal.content, sources: proposal.sources, status: "suggested", origin: "ai", humanEdited: false, locked: false, freshness: freshness(proposal.sources, versions), updatedAt: timestamp });
    } else {
      result.push({ id: `memory_item_${crypto.randomUUID()}`, key: proposal.key, category: proposal.category, label: proposal.label, content: proposal.content, status: "suggested", sources: proposal.sources, origin: "ai", humanEdited: false, locked: false, freshness: freshness(proposal.sources, versions), createdAt: timestamp, updatedAt: timestamp });
    }
    existing.delete(proposal.key);
  }
  for (const item of existing.values()) if (itemLocked(item) || item.status === "rejected") result.push({ ...item, locked: itemLocked(item), freshness: freshness(item.sources, versions) });
  return result;
}

function reconcileOverview(previous: MemoryOverview | undefined, content: string, timestamp: string): MemoryOverview {
  if (previous && summaryLocked(previous)) {
    const same = normalized(previous.content) === normalized(content);
    return { ...clearCandidate(previous), locked: true, ...(same ? {} : { candidate: { label: "Paper overview", content, sources: [], createdAt: timestamp } }) };
  }
  return { content, origin: "ai", humanEdited: false, locked: false, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp };
}

function reconcileSections(previous: MemorySectionSummary[], proposed: ProposedSection[], versions: Record<string, { version: number }>, timestamp: string): MemorySectionSummary[] {
  const existing = new Map(previous.map((section) => [section.key, section]));
  const result: MemorySectionSummary[] = [];
  for (const proposal of proposed) {
    const current = existing.get(proposal.key);
    if (current && summaryLocked(current)) {
      const same = normalized(current.content) === normalized(proposal.content);
      const locked = clearCandidate(current);
      result.push({ ...locked, locked: true, freshness: freshness(current.sources, versions), ...(same ? { sources: mergeSources(current.sources, proposal.sources) } : { candidate: candidateFor({ label: proposal.title, content: proposal.content, sources: proposal.sources }, timestamp) }) });
    } else if (current) {
      const generated = clearCandidate(current);
      result.push({ ...generated, path: proposal.path, title: proposal.title, content: proposal.content, sources: proposal.sources, origin: "ai", humanEdited: false, locked: false, freshness: freshness(proposal.sources, versions), updatedAt: timestamp });
    } else {
      result.push({ id: `memory_section_${crypto.randomUUID()}`, key: proposal.key, path: proposal.path, title: proposal.title, content: proposal.content, sources: proposal.sources, origin: "ai", humanEdited: false, locked: false, freshness: freshness(proposal.sources, versions), createdAt: timestamp, updatedAt: timestamp });
    }
    existing.delete(proposal.key);
  }
  for (const section of existing.values()) if (summaryLocked(section)) result.push({ ...section, freshness: freshness(section.sources, versions) });
  return result;
}

function candidateFor(value: Pick<MemoryItem, "label" | "content" | "sources">, timestamp: string): MemoryCandidate {
  return { label: value.label, content: value.content, sources: value.sources, createdAt: timestamp };
}

function clearCandidate<T extends { candidate?: MemoryCandidate }>(value: T): Omit<T, "candidate"> {
  const { candidate: _candidate, ...rest } = value;
  return rest;
}

function mergeSources(left: MemorySource[], right: MemorySource[]): MemorySource[] {
  const values = new Map<string, MemorySource>();
  for (const source of [...left, ...right]) values.set(`${source.path}:${source.fileVersion}:${source.excerpt}`, source);
  return [...values.values()];
}

function freshness(sources: MemorySource[], versions: Record<string, { version: number }>): MemoryFreshness {
  return sources.some((source) => versions[source.path]?.version !== source.fileVersion) ? "stale" : "current";
}

function cleanContent(value: string, maximum: number): string { return value.trim().slice(0, maximum); }
function sourcesForPath(path: string, facts: ProposedItem[]): MemorySource[] { return mergeSources([], facts.filter((fact) => fact.sources.some((source) => source.path === path)).flatMap((fact) => fact.sources.filter((source) => source.path === path))); }
function fallbackOverview(facts: ProposedItem[]): string { return facts.slice(0, 8).map((fact) => `${fact.label}: ${fact.content}`).join("\n").slice(0, MAX_SUMMARY_CONTENT); }
function fallbackSection(path: string, facts: ProposedItem[]): string { return facts.filter((fact) => fact.sources.some((source) => source.path === path)).slice(0, 5).map((fact) => `${fact.label}: ${fact.content}`).join("\n").slice(0, MAX_SUMMARY_CONTENT); }

function sectionFromMarkdown(content: string, heading: string): string {
  const marker = `## ${heading}`;
  const start = content.indexOf(marker);
  if (start < 0) return "";
  const bodyStart = start + marker.length;
  const next = content.indexOf("\n## ", bodyStart);
  return content.slice(bodyStart, next < 0 ? undefined : next).trim().replace(/^<!--[^]*?-->\s*/u, "");
}

function markdownSubsection(content: string, heading: string): string {
  const marker = `### ${heading}`;
  const start = content.indexOf(marker);
  if (start < 0) return "";
  const bodyStart = start + marker.length;
  const next = content.indexOf("\n### ", bodyStart);
  return content.slice(bodyStart, next < 0 ? undefined : next).trim();
}

function markdownSectionForPath(content: string, path: string, title?: string): string {
  const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedTitle = title?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^### ${escapedTitle || ".+"} \\(${escapedPath}\\)\\s*$`, "m").exec(content);
  if (!match || match.index === undefined) return "";
  const bodyStart = match.index + match[0].length;
  const next = content.indexOf("\n### ", bodyStart);
  return content.slice(bodyStart, next < 0 ? undefined : next).trim();
}

function renderMemoryFile(memory: PaperMemory, instructions: string, mode: "candidate" | "reviewed"): string {
  const candidate = mode === "candidate";
  const context = renderContext(memory, candidate);
  const instructionsBody = instructions || "<!-- Add durable cross-file constraints, terminology, and non-negotiable claims here. Only the cross-file Agent receives these instructions. -->";
  const label = candidate ? "Candidate Context" : "Reviewed Context";
  return `# Paper Memory

This file is part of the paper workspace. Edit **User Instructions** directly for cross-file Agent work; Revise and Completion receive only the reviewed paper overview and active Section summary. Review reads the current paper snapshot without Memory.

## User Instructions

${instructionsBody}

## ${label}

${context || "No extracted context yet."}
`;
}

function renderContext(memory: PaperMemory, candidate: boolean): string {
  const lines: string[] = [];
  const overview = candidate
    ? memory.overview?.candidate?.content ?? memory.overview?.content
    : memory.overview && summaryLocked(memory.overview) ? memory.overview.content : undefined;
  if (overview) lines.push(`### Overview\n\n${overview}`);
  const sections = candidate ? memory.sections ?? [] : (memory.sections ?? []).filter(summaryLocked);
  for (const section of sections) {
    const content = candidate ? section.candidate?.content ?? section.content : section.content;
    if (content) lines.push(`### ${section.title} (${section.path})\n\n${content}`);
  }
  const items = memory.items.filter((item) => candidate || item.status === "confirmed" || item.locked);
  if (items.length) {
    lines.push("### Facts\n");
    for (const item of items) {
      const label = candidate ? item.candidate?.label ?? item.label : item.label;
      const content = candidate ? item.candidate?.content ?? item.content : item.content;
      lines.push(`- **${item.category}: ${label}** - ${content}`);
    }
  }
  return lines.join("\n\n");
}
