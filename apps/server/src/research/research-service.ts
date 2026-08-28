import type { MetadataObservation, ProjectResearchWork, ResearchIdentifier, ResearchRun, ResearchWork, SourceEvidence, ChangeSet } from "@fastwrite/shared";
import { ApiError } from "../http";
import type { JsonDatabase } from "../storage/database";
import type { WorkspaceService } from "../workspace/workspace-service";

const MAX_QUERY = 500;
const USER_AGENT = "FastWrite/0.1 (research metadata)";
const now = () => new Date().toISOString();

export class ResearchService {
  private readonly cache = new Map<string, { expiresAt: number; observations: Observation[] }>();
  constructor(private readonly database: JsonDatabase, private readonly workspaces: WorkspaceService) {}

  async search(projectId: string, query: string, signal?: AbortSignal): Promise<{ run: ResearchRun; works: ResearchWork[] }> {
    this.workspaces.getProject(projectId);
    const normalized = query.trim().slice(0, MAX_QUERY);
    if (!normalized) throw new ApiError(400, "research_query_required", "A research query is required");
    const run: ResearchRun = { id: `research_run_${crypto.randomUUID()}`, projectId, query: normalized, status: "running", workIds: [], createdAt: now(), updatedAt: now() };
    await this.database.mutate((state) => state.researchRuns.push(run));
    try {
      const cached = this.cache.get(normalized);
      const observations = cached && cached.expiresAt > Date.now() ? splitObservations(cached.observations) : await Promise.all([this.crossref(normalized, signal), this.openAlex(normalized, signal), this.semanticScholar(normalized, signal), this.arxiv(normalized, signal)]);
      if (!cached || cached.expiresAt <= Date.now()) this.cache.set(normalized, { expiresAt: Date.now() + 5 * 60_000, observations: observations.flat() });
      const works: ResearchWork[] = [];
      for (const observation of observations.flat()) {
        const existing = findWork(this.database.snapshot().researchWorks, this.database.snapshot().researchIdentifiers, observation.identifiers, observation.title, observation.authors, observation.year);
        const work = existing ?? { id: `work_${crypto.randomUUID()}`, title: observation.title, authors: observation.authors, ...(observation.year ? { year: observation.year } : {}), ...(observation.venue ? { venue: observation.venue } : {}), metadataStatus: "candidate" as const, publicationStatus: "unknown" as const, createdAt: now(), updatedAt: now() };
        works.push(work);
        await this.database.mutate((state) => {
          const storedWork = state.researchWorks.find((candidate) => candidate.id === work.id);
          if (!storedWork) state.researchWorks.push(work);
          else if (normalize(storedWork.title) !== normalize(observation.title) || (storedWork.year && observation.year && storedWork.year !== observation.year) || normalize(storedWork.authors[0] ?? "") !== normalize(observation.authors[0] ?? "")) { storedWork.metadataStatus = "conflicting"; storedWork.updatedAt = now(); }
          if (!state.projectResearchWorks.some((item) => item.projectId === projectId && item.workId === work.id)) state.projectResearchWorks.push({ projectId, workId: work.id, status: "candidate", createdAt: now(), updatedAt: now() });
          for (const identifier of observation.identifiers) if (!state.researchIdentifiers.some((item) => item.workId === work.id && item.scheme === identifier.scheme && item.value === identifier.value)) state.researchIdentifiers.push({ workId: work.id, ...identifier });
          state.metadataObservations.push({ id: `observation_${crypto.randomUUID()}`, workId: work.id, provider: observation.provider, fields: { title: observation.title, authors: observation.authors, ...(observation.year ? { year: observation.year } : {}), ...(observation.venue ? { venue: observation.venue } : {}) }, fetchedAt: now() });
          const stored = state.researchRuns.find((item) => item.id === run.id); if (stored && !stored.workIds.includes(work.id)) stored.workIds.push(work.id);
        });
      }
      const updated = await this.database.mutate((state) => { const stored = state.researchRuns.find((item) => item.id === run.id)!; stored.status = "completed"; stored.updatedAt = now(); return stored; });
      return { run: updated, works: dedupeWorks(works) };
    } catch (error) {
      await this.database.mutate((state) => { const stored = state.researchRuns.find((item) => item.id === run.id); if (stored) { stored.status = signal?.aborted ? "cancelled" : "failed"; stored.error = error instanceof Error ? error.message : "Research failed"; stored.updatedAt = now(); } });
      if (signal?.aborted) throw new ApiError(499, "research_cancelled", "Research cancelled");
      return { run: this.database.snapshot().researchRuns.find((item) => item.id === run.id)!, works: [] };
    }
  }

  async confirm(projectId: string, runId: string): Promise<ResearchRun> {
    this.workspaces.getProject(projectId); return this.database.mutate((state) => { const run = state.researchRuns.find((item) => item.projectId === projectId && item.id === runId); if (!run) throw new ApiError(404, "research_run_not_found", "Research run not found"); if (run.status === "cancelled") throw new ApiError(409, "research_run_cancelled", "Research run is cancelled"); return run; });
  }

  async updatePlan(projectId: string, runId: string, queryPlan: { steps: string[]; rationale?: string }): Promise<ResearchRun> {
    this.workspaces.getProject(projectId); return this.database.mutate((state) => { const run = state.researchRuns.find((item) => item.projectId === projectId && item.id === runId); if (!run) throw new ApiError(404, "research_run_not_found", "Research run not found"); if (!Array.isArray(queryPlan.steps) || queryPlan.steps.length === 0 || queryPlan.steps.length > 20 || queryPlan.steps.some((step) => typeof step !== "string" || !step.trim())) throw new ApiError(400, "research_plan_invalid", "Research query plan must contain 1-20 non-empty steps"); run.queryPlan = { steps: queryPlan.steps.map((step) => step.trim()), ...(queryPlan.rationale?.trim() ? { rationale: queryPlan.rationale.trim().slice(0, 1000) } : {}) }; run.updatedAt = now(); return run; });
  }

  async cancel(projectId: string, runId: string): Promise<ResearchRun> {
    this.workspaces.getProject(projectId); return this.database.mutate((state) => { const run = state.researchRuns.find((item) => item.projectId === projectId && item.id === runId); if (!run) throw new ApiError(404, "research_run_not_found", "Research run not found"); if (run.status === "running" || run.status === "planned") run.status = "cancelled"; run.updatedAt = now(); return run; });
  }

  listWorks(projectId: string): Array<ResearchWork & { project: ProjectResearchWork }> {
    this.workspaces.getProject(projectId); const state = this.database.snapshot();
    return state.projectResearchWorks.filter((item) => item.projectId === projectId).map((link) => { const work = state.researchWorks.find((candidate) => candidate.id === link.workId); return work ? { ...work, project: link } : undefined; }).filter(Boolean) as Array<ResearchWork & { project: ProjectResearchWork }>;
  }

  async importWork(projectId: string, input: { title: string; authors?: string[]; year?: number; venue?: string; doi?: string; arxiv?: string; citationKey?: string }): Promise<ResearchWork> {
    this.workspaces.getProject(projectId); const title = input.title.trim(); if (!title) throw new ApiError(400, "research_title_required", "Research work title is required");
    const timestamp = now(); const work: ResearchWork = { id: `work_${crypto.randomUUID()}`, title, authors: (input.authors ?? []).map(String).slice(0, 100), ...(Number.isInteger(input.year) ? { year: input.year } : {}), ...(input.venue ? { venue: input.venue.trim() } : {}), metadataStatus: "verified", publicationStatus: "unknown", createdAt: timestamp, updatedAt: timestamp };
    await this.database.mutate((state) => { state.researchWorks.push(work); state.projectResearchWorks.push({ projectId, workId: work.id, status: "saved", ...(input.citationKey ? { citationKey: input.citationKey.trim() } : {}), createdAt: timestamp, updatedAt: timestamp }); for (const [scheme, value] of [["doi", input.doi], ["arxiv", input.arxiv]] as const) if (value?.trim()) state.researchIdentifiers.push({ workId: work.id, scheme, value: value.trim() }); });
    return work;
  }

  async saveWork(projectId: string, workId: string, updates: { status?: ProjectResearchWork["status"]; citationKey?: string }): Promise<ProjectResearchWork> {
    this.workspaces.getProject(projectId); return this.database.mutate((state) => { const link = state.projectResearchWorks.find((item) => item.projectId === projectId && item.workId === workId); if (!link) throw new ApiError(404, "research_work_not_found", "Research work is not linked to this project"); if (updates.status) link.status = updates.status; if (updates.citationKey !== undefined) { const key = updates.citationKey.trim(); if (key) link.citationKey = key; else delete link.citationKey; } link.updatedAt = now(); return link; });
  }

  async citationContext(projectId: string, citationKey: string): Promise<{ key: string; contexts: Array<{ path: string; line: number; excerpt: string }>; bibliography?: { path: string; line: number; entry: string } }> {
    this.workspaces.getProject(projectId); const contexts: Array<{ path: string; line: number; excerpt: string }> = []; let bibliography: { path: string; line: number; entry: string } | undefined;
    const files = await this.workspaces.tree(projectId); const paths = flattenText(files).filter((path) => /\.(?:tex|bib)$/i.test(path));
    for (const path of paths) { const file = await this.workspaces.readTextFile(projectId, path); for (const match of file.content.matchAll(new RegExp(`\\\\(?:cite|citep|citet|parencite|textcite|autocite)\\*?(?:\\[[^\\]]*\\]){0,2}\\\\{[^}]*\\b${escapeRegExp(citationKey)}\\b[^}]*\\}`, "g"))) { const offset = match.index ?? 0; const line = file.content.slice(0, offset).split("\n").length; contexts.push({ path, line, excerpt: file.content.slice(Math.max(0, offset - 240), Math.min(file.content.length, offset + match[0].length + 240)).trim() }); }
      const entry = file.content.match(new RegExp(`@\\w+\\s*\\{\\s*${escapeRegExp(citationKey)}\\s*,[\\s\\S]*?(?=\\n@|$)`, "i")); if (entry) bibliography = { path, line: file.content.slice(0, entry.index ?? 0).split("\n").length, entry: entry[0].slice(0, 4000) }; }
    return { key: citationKey, contexts, ...(bibliography ? { bibliography } : {}) };
  }

  async proposeBibtexChange(projectId: string, workId: string, targetBibPath: string): Promise<ChangeSet> {
    const project = this.workspaces.getProject(projectId); const state = this.database.snapshot(); const work = state.researchWorks.find((item) => item.id === workId); if (!work) throw new ApiError(404, "research_work_not_found", "Research work not found");
    const opened = await this.workspaces.readTextFile(projectId, targetBibPath); const link = state.projectResearchWorks.find((item) => item.projectId === projectId && item.workId === workId); if (!link || link.status !== "saved") throw new ApiError(409, "research_work_not_approved", "Approve the research work before proposing BibTeX");
    const key = link.citationKey || citationKey(work); const entry = `@article{${key},\n  title = {${work.title}},\n${work.authors.length ? `  author = {${work.authors.join(" and ")}},\n` : ""}${work.year ? `  year = {${work.year}},\n` : ""}${work.venue ? `  journal = {${work.venue}},\n` : ""}}\n`;
    return { id: `change_${crypto.randomUUID()}`, projectId, agentRunId: `research_${crypto.randomUUID()}`, status: "proposed", approvalMode: "explicit-finish", summary: `Add BibTeX entry ${key}`, rationale: "Generated from user-approved research metadata; review and accept through the ChangeSet workflow.", changes: [{ operation: "replace", path: targetBibPath, from: opened.content.length, to: opened.content.length, before: "", after: `\n${entry}`, baseVersion: opened.file.version, baseContent: opened.content }], createdAt: now(), updatedAt: now() };
  }

  async extractPdfEvidence(projectId: string, workId: string, pdfBase64: string, authorized: boolean): Promise<SourceEvidence[]> {
    this.workspaces.getProject(projectId); if (!authorized) throw new ApiError(403, "pdf_authorization_required", "Explicit authorization is required before parsing a local PDF"); if (pdfBase64.length > 20_000_000) throw new ApiError(413, "pdf_too_large", "PDF exceeds the 15 MB parsing limit"); const state = this.database.snapshot(); if (!state.researchWorks.some((work) => work.id === workId)) throw new ApiError(404, "research_work_not_found", "Research work not found"); const text = Buffer.from(pdfBase64, "base64").toString("latin1").replace(/[^\x20-\x7E\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000); if (!text) return [];
    const timestamp = now(); const evidence: SourceEvidence = { id: `evidence_${crypto.randomUUID()}`, projectId, workId, kind: "background", origin: "model-extraction", representation: "paraphrase", status: "candidate", content: text, locatorType: "page", locator: "1", createdAt: timestamp, updatedAt: timestamp };
    await this.database.mutate((current) => current.sourceEvidence.push(evidence)); return [evidence];
  }

  private async crossref(query: string, signal?: AbortSignal): Promise<Observation[]> { const response = await fetch(`https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=5`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(5000)]) }); if (!response.ok) return []; const body = await response.json() as { message?: { items?: any[] } }; return (body.message?.items ?? []).map((item) => ({ provider: "crossref" as const, title: item.title?.[0] ?? "", authors: (item.author ?? []).map((author: any) => [author.given, author.family].filter(Boolean).join(" ")), year: item.published?.["date-parts"]?.[0]?.[0] ?? item.issued?.["date-parts"]?.[0]?.[0], venue: item["container-title"]?.[0], identifiers: item.DOI ? [{ scheme: "doi" as const, value: String(item.DOI).toLowerCase() }] : [] })).filter((item) => item.title); }
  private async openAlex(query: string, signal?: AbortSignal): Promise<Observation[]> { const response = await fetch(`https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=5`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(5000)]) }); if (!response.ok) return []; const body = await response.json() as { results?: any[] }; return (body.results ?? []).map((item) => ({ provider: "openalex" as const, title: item.title ?? "", authors: (item.authorships ?? []).map((author: any) => author.author?.display_name).filter(Boolean), year: item.publication_year, venue: item.primary_location?.source?.display_name, identifiers: item.ids?.doi ? [{ scheme: "doi" as const, value: String(item.ids.doi).replace(/^https?:\/\/doi\.org\//i, "").toLowerCase() }] : item.id ? [{ scheme: "openalex" as const, value: String(item.id) }] : [] })).filter((item) => item.title); }
  private async semanticScholar(query: string, signal?: AbortSignal): Promise<Observation[]> { const response = await fetch(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=5&fields=title,authors,year,venue,externalIds`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(5000)]) }); if (!response.ok) return []; const body = await response.json() as { data?: any[] }; return (body.data ?? []).map((item) => ({ provider: "semantic-scholar" as const, title: item.title ?? "", authors: (item.authors ?? []).map((author: any) => author.name).filter(Boolean), year: item.year, venue: item.venue, identifiers: item.externalIds?.DOI ? [{ scheme: "doi" as const, value: String(item.externalIds.DOI).toLowerCase() }] : item.paperId ? [{ scheme: "semantic-scholar" as const, value: String(item.paperId) }] : [] })).filter((item) => item.title); }
  private async arxiv(query: string, signal?: AbortSignal): Promise<Observation[]> { const response = await fetch(`https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=5`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(5000)]) }); if (!response.ok) return []; const xml = await response.text(); return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => { const entry = match[1] ?? ""; const title = decodeXml(/<title>([\s\S]*?)<\/title>/.exec(entry)?.[1] ?? "").replace(/\s+/g, " ").trim(); const id = /<id>([^<]+)</.exec(entry)?.[1]?.trim(); const year = Number(/<published>(\d{4})/.exec(entry)?.[1]); const authors = [...entry.matchAll(/<name>([^<]+)</g)].map((item) => decodeXml(item[1] ?? "")); return { provider: "arxiv" as const, title, authors, ...(Number.isFinite(year) && year > 0 ? { year } : {}), identifiers: id ? [{ scheme: "arxiv" as const, value: id.split("/").pop()! }] : [] }; }).filter((item) => item.title); }
}

type Observation = { provider: "crossref" | "openalex" | "semantic-scholar" | "arxiv"; title: string; authors: string[]; year?: number; venue?: string; identifiers: Array<{ scheme: ResearchIdentifier["scheme"]; value: string }> };
function findWork(works: ResearchWork[], knownIdentifiers: ResearchIdentifier[], identifiers: Observation["identifiers"], title: string, authors: string[], year?: number): ResearchWork | undefined { const byIdentifier = works.find((work) => identifiers.some((identifier) => knownIdentifiers.some((known) => known.workId === work.id && known.scheme === identifier.scheme && known.value.toLowerCase() === identifier.value.toLowerCase()))); if (byIdentifier) return byIdentifier; const normalizedTitle = normalize(title); const first = normalize(authors[0] ?? ""); return works.find((work) => normalize(work.title) === normalizedTitle && (!year || !work.year || work.year === year) && (!first || normalize(work.authors[0] ?? "") === first)) ?? undefined; }
function normalize(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function dedupeWorks(works: ResearchWork[]): ResearchWork[] { return [...new Map(works.map((work) => [work.id, work])).values()]; }
function flattenText(nodes: any[]): string[] { return nodes.flatMap((node) => node.type === "directory" ? flattenText(node.children) : node.kind === "text" ? [node.path] : []); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&"); }
function citationKey(work: ResearchWork): string { return `${(work.authors[0] ?? "ref").replace(/[^A-Za-z]/g, "").toLowerCase() || "ref"}${work.year ?? ""}`; }
function decodeXml(value: string): string { return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }
function splitObservations(observations: Observation[]): Observation[][] { return [observations]; }
