import { normalizeWorkspacePath, type ChangeSet, type FastReadBundleReceipt, type MetadataObservation, type ProjectResearchWork, type ProjectResearchWorkDetails, type ResearchIdentifier, type ResearchProviderResult, type ResearchRun, type ResearchWork, type SourceEvidence } from "@fastwrite/shared";
import { ApiError } from "../http";
import type { JsonDatabase } from "../storage/database";
import type { WorkspaceService } from "../workspace/workspace-service";

const MAX_QUERY = 500;
const USER_AGENT = "FastWrite/0.1 (research metadata)";
const now = () => new Date().toISOString();

export class ResearchService {
  private readonly cache = new Map<string, { expiresAt: number; observations: Observation[] }>();
  constructor(private readonly database: JsonDatabase, private readonly workspaces: WorkspaceService, private readonly fetcher: typeof fetch = fetch) {}

  async search(projectId: string, query: string, signal?: AbortSignal): Promise<{ run: ResearchRun; works: ResearchWork[] }> {
    this.workspaces.getProject(projectId);
    const normalized = query.trim().slice(0, MAX_QUERY);
    if (!normalized) throw new ApiError(400, "research_query_required", "A research query is required");
    const run: ResearchRun = { id: `research_run_${crypto.randomUUID()}`, projectId, query: normalized, status: "running", workIds: [], createdAt: now(), updatedAt: now() };
    await this.database.mutate((state) => state.researchRuns.push(run));
    try {
      const cached = this.cache.get(normalized);
      let observations: Observation[][];
      let providers: ResearchProviderResult[];
      if (cached && cached.expiresAt > Date.now()) {
        observations = [cached.observations];
        providers = [{ provider: "cache", status: "completed", resultCount: cached.observations.length }];
      } else {
        const requests = [
          { provider: "crossref" as const, promise: this.crossref(normalized, signal) },
          { provider: "openalex" as const, promise: this.openAlex(normalized, signal) },
          { provider: "semantic-scholar" as const, promise: this.semanticScholar(normalized, signal) },
          { provider: "arxiv" as const, promise: this.arxiv(normalized, signal) }
        ];
        const settled = await Promise.allSettled(requests.map((item) => item.promise));
        if (signal?.aborted) throw new ApiError(499, "research_cancelled", "Research cancelled");
        observations = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
        providers = settled.map((result, index) => result.status === "fulfilled"
          ? { provider: requests[index]!.provider, status: "completed", resultCount: result.value.length }
          : { provider: requests[index]!.provider, status: "failed", resultCount: 0, error: providerError(result.reason) });
        if (providers.some((item) => item.status === "completed")) this.cache.set(normalized, { expiresAt: Date.now() + 5 * 60_000, observations: observations.flat() });
      }
      if (!providers.some((item) => item.status === "completed")) {
        const failed = await this.database.mutate((state) => {
          const stored = state.researchRuns.find((item) => item.id === run.id)!;
          stored.status = "failed";
          stored.providers = providers;
          stored.error = "All research providers failed";
          stored.updatedAt = now();
          return stored;
        });
        return { run: failed, works: [] };
      }
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
      const updated = await this.database.mutate((state) => { const stored = state.researchRuns.find((item) => item.id === run.id)!; stored.status = "completed"; stored.providers = providers; const failedCount = providers.filter((item) => item.status === "failed").length; if (failedCount) stored.error = `${failedCount} research provider${failedCount === 1 ? "" : "s"} unavailable`; else delete stored.error; stored.updatedAt = now(); return stored; });
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

  listWorks(projectId: string): ProjectResearchWorkDetails[] {
    this.workspaces.getProject(projectId); const state = this.database.snapshot();
    return state.projectResearchWorks.filter((item) => item.projectId === projectId).map((link) => { const work = state.researchWorks.find((candidate) => candidate.id === link.workId); return work ? { ...work, project: link, identifiers: state.researchIdentifiers.filter((item) => item.workId === work.id), metadataObservations: state.metadataObservations.filter((item) => item.workId === work.id).sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt)) } : undefined; }).filter(Boolean) as ProjectResearchWorkDetails[];
  }

  async listFastReadBundles(projectId: string): Promise<FastReadBundleReceipt[]> {
    this.workspaces.getProject(projectId);
    const state = this.database.snapshot();
    const stored = new Map(state.fastReadBundles.filter((item) => item.projectId === projectId).map((item) => [item.manifestPath, item]));
    const manifests = flattenText(await this.workspaces.tree(projectId)).filter(isFastReadManifestPath);
    const timestamp = now();
    for (const manifestPath of manifests) {
      if (stored.has(manifestPath)) continue;
      const bundleId = bundleIdFromManifestPath(manifestPath);
      stored.set(manifestPath, {
        id: fastReadReceiptId(projectId, bundleId),
        projectId,
        bundleId,
        manifestPath,
        status: "pending",
        workIds: [],
        evidenceIds: [],
        createdAt: timestamp,
        updatedAt: timestamp
      });
    }
    return [...stored.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async importFastReadBundles(projectId: string, manifestPath?: string): Promise<FastReadBundleReceipt[]> {
    const paths = manifestPath
      ? [normalizeFastReadManifestPath(manifestPath)]
      : (await this.listFastReadBundles(projectId)).filter((item) => item.status !== "imported").map((item) => item.manifestPath);
    const results: FastReadBundleReceipt[] = [];
    for (const path of paths) results.push(await this.tryImportFastReadBundle(projectId, path));
    return results;
  }

  async tryImportFastReadBundle(projectId: string, manifestPath: string): Promise<FastReadBundleReceipt> {
    this.workspaces.getProject(projectId);
    const normalizedPath = normalizeFastReadManifestPath(manifestPath);
    const bundleId = bundleIdFromManifestPath(normalizedPath);
    const existing = this.database.snapshot().fastReadBundles.find((item) => item.projectId === projectId && item.bundleId === bundleId);
    if (existing?.status === "imported") return existing;
    try {
      return await this.importVerifiedFastReadBundle(projectId, bundleId, normalizedPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : "FastRead bundle import failed";
      return this.database.mutate((state) => upsertFastReadReceipt(state.fastReadBundles, {
        id: existing?.id ?? fastReadReceiptId(projectId, bundleId),
        projectId,
        bundleId,
        manifestPath: normalizedPath,
        status: "failed",
        workIds: existing?.workIds ?? [],
        evidenceIds: existing?.evidenceIds ?? [],
        error: message,
        createdAt: existing?.createdAt ?? now(),
        updatedAt: now()
      }));
    }
  }

  private async importVerifiedFastReadBundle(projectId: string, bundleId: string, manifestPath: string): Promise<FastReadBundleReceipt> {
    const manifest = parseFastReadManifest((await this.workspaces.readTextFile(projectId, manifestPath)).content, bundleId);
    const directory = manifestPath.slice(0, -"/manifest.json".length);
    const contents = new Map<string, string>();
    for (const entry of manifest.files) {
      const content = (await this.workspaces.readTextFile(projectId, `${directory}/${entry.name}`)).content;
      if (Buffer.byteLength(content, "utf8") !== entry.bytes) throw new ApiError(409, "fastread_bundle_size_mismatch", `FastRead bundle file '${entry.name}' has an unexpected byte length`);
      if (sha256(content) !== entry.sha256) throw new ApiError(409, "fastread_bundle_hash_mismatch", `FastRead bundle file '${entry.name}' failed SHA-256 verification`);
      contents.set(entry.name, content);
    }
    for (const required of ["evidence.md", "citations.json", "references.bib"]) if (!contents.has(required)) throw new ApiError(400, "fastread_bundle_incomplete", `FastRead bundle is missing '${required}'`);
    const payload = parseFastReadCitations(contents.get("citations.json")!, bundleId);
    const citationKeys = bibtexKeys(contents.get("references.bib")!);
    const timestamp = now();

    return this.database.mutate((state) => {
      const taskWorks = new Map<string, ResearchWork>();
      const workIds: string[] = [];
      const evidenceIds: string[] = [];
      for (const [index, paper] of payload.papers.entries()) {
        const identifiers = paper.doi ? [{ scheme: "doi" as const, value: paper.doi.toLowerCase() }] : [];
        let work = findWork(state.researchWorks, state.researchIdentifiers, identifiers, paper.title, paper.authors, paper.year);
        if (!work) {
          work = {
            id: `work_fastread_${sha256(`${paper.doi ?? ""}\u0000${normalize(paper.title)}\u0000${paper.year ?? ""}`).slice(0, 24)}`,
            title: paper.title,
            authors: paper.authors,
            ...(paper.year ? { year: paper.year } : {}),
            metadataStatus: "verified",
            publicationStatus: "unknown",
            createdAt: timestamp,
            updatedAt: timestamp
          };
          state.researchWorks.push(work);
        }
        const citationKey = citationKeys[index] ?? citationKeyForIndex(work, index);
        const projectLink = state.projectResearchWorks.find((item) => item.projectId === projectId && item.workId === work!.id);
        if (projectLink) {
          projectLink.status = "saved";
          projectLink.citationKey ||= citationKey;
          projectLink.updatedAt = timestamp;
        } else state.projectResearchWorks.push({ projectId, workId: work.id, status: "saved", citationKey, createdAt: timestamp, updatedAt: timestamp });
        for (const identifier of identifiers) if (!state.researchIdentifiers.some((item) => item.workId === work!.id && item.scheme === identifier.scheme && item.value === identifier.value)) state.researchIdentifiers.push({ workId: work.id, ...identifier });
        const observationId = `observation_fastread_${sha256(`${bundleId}\u0000${paper.id}`).slice(0, 24)}`;
        if (!state.metadataObservations.some((item) => item.id === observationId)) state.metadataObservations.push({ id: observationId, workId: work.id, provider: "fastread", fields: { title: paper.title, authors: paper.authors, ...(paper.year ? { year: paper.year } : {}), ...(paper.doi ? { doi: paper.doi } : {}) }, fetchedAt: timestamp });
        taskWorks.set(paper.id, work);
        workIds.push(work.id);
      }
      for (const [index, citation] of payload.citations.entries()) {
        const work = taskWorks.get(citation.task_id);
        if (!work) throw new ApiError(400, "fastread_bundle_citation_orphaned", `FastRead citation '${citation.task_id}' has no paper metadata`);
        const evidenceId = `evidence_fastread_${sha256(`${projectId}\u0000${bundleId}\u0000${index}\u0000${citation.task_id}\u0000${citation.page}\u0000${citation.exact_quote}`).slice(0, 24)}`;
        if (!state.sourceEvidence.some((item) => item.id === evidenceId)) state.sourceEvidence.push({
          id: evidenceId,
          projectId,
          workId: work.id,
          kind: "quote",
          origin: "source-text",
          representation: "verbatim",
          status: "approved",
          content: citation.exact_quote,
          locatorType: "page",
          locator: String(citation.page),
          sourceTaskId: citation.task_id,
          sourceHash: citation.source_hash,
          ...(citation.note ? { sourceNote: citation.note } : {}),
          fastReadBundleId: bundleId,
          approvedAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp
        });
        evidenceIds.push(evidenceId);
      }
      return upsertFastReadReceipt(state.fastReadBundles, {
        id: fastReadReceiptId(projectId, bundleId),
        projectId,
        bundleId,
        manifestPath,
        status: "imported",
        workIds: [...new Set(workIds)],
        evidenceIds: [...new Set(evidenceIds)],
        importedAt: timestamp,
        createdAt: state.fastReadBundles.find((item) => item.projectId === projectId && item.bundleId === bundleId)?.createdAt ?? timestamp,
        updatedAt: timestamp
      });
    });
  }

  async importWork(projectId: string, input: { title: string; authors?: string[]; year?: number; venue?: string; doi?: string; arxiv?: string; citationKey?: string }): Promise<ResearchWork> {
    this.workspaces.getProject(projectId); const title = typeof input.title === "string" ? input.title.trim() : ""; if (!title) throw new ApiError(400, "research_title_required", "Research work title is required");
    if (input.year !== undefined && (!Number.isInteger(input.year) || input.year < 1000 || input.year > 3000)) throw new ApiError(400, "research_year_invalid", "Research work year must be a four-digit integer");
    const authors = (Array.isArray(input.authors) ? input.authors : []).map((item) => String(item).trim()).filter(Boolean).slice(0, 100);
    const timestamp = now();
    const identifiers = ([
      input.doi?.trim() ? { scheme: "doi" as const, value: input.doi.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").toLowerCase() } : undefined,
      input.arxiv?.trim() ? { scheme: "arxiv" as const, value: input.arxiv.trim().replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//i, "").replace(/\.pdf$/i, "") } : undefined
    ]).filter(Boolean) as Array<{ scheme: ResearchIdentifier["scheme"]; value: string }>;
    return this.database.mutate((state) => {
      let work = findWork(state.researchWorks, state.researchIdentifiers, identifiers, title, authors, input.year);
      if (!work) {
        work = { id: `work_${crypto.randomUUID()}`, title, authors, ...(Number.isInteger(input.year) ? { year: input.year } : {}), ...(input.venue?.trim() ? { venue: input.venue.trim() } : {}), metadataStatus: "verified", publicationStatus: "unknown", createdAt: timestamp, updatedAt: timestamp };
        state.researchWorks.push(work);
      } else {
        work.metadataStatus = "verified";
        work.updatedAt = timestamp;
      }
      const link = state.projectResearchWorks.find((item) => item.projectId === projectId && item.workId === work!.id);
      if (link) { link.status = "saved"; if (input.citationKey?.trim()) link.citationKey = input.citationKey.trim(); link.updatedAt = timestamp; }
      else state.projectResearchWorks.push({ projectId, workId: work.id, status: "saved", ...(input.citationKey?.trim() ? { citationKey: input.citationKey.trim() } : {}), createdAt: timestamp, updatedAt: timestamp });
      for (const identifier of identifiers) if (!state.researchIdentifiers.some((item) => item.workId === work!.id && item.scheme === identifier.scheme && item.value.toLowerCase() === identifier.value.toLowerCase())) state.researchIdentifiers.push({ workId: work.id, ...identifier });
      if (!state.metadataObservations.some((item) => item.workId === work!.id && item.provider === "user" && normalize(String(item.fields.title ?? "")) === normalize(title))) state.metadataObservations.push({ id: `observation_${crypto.randomUUID()}`, workId: work.id, provider: "user", fields: { title, authors, ...(Number.isInteger(input.year) ? { year: input.year! } : {}), ...(input.venue?.trim() ? { venue: input.venue.trim() } : {}) }, fetchedAt: timestamp });
      return work;
    });
  }

  async saveWork(projectId: string, workId: string, updates: { status?: ProjectResearchWork["status"]; citationKey?: string }): Promise<ProjectResearchWork> {
    this.workspaces.getProject(projectId); if (updates.status && !new Set(["candidate", "saved", "rejected"]).has(updates.status)) throw new ApiError(400, "research_status_invalid", "Research work status is invalid"); return this.database.mutate((state) => { const link = state.projectResearchWorks.find((item) => item.projectId === projectId && item.workId === workId); if (!link) throw new ApiError(404, "research_work_not_found", "Research work is not linked to this project"); if (updates.status) link.status = updates.status; if (updates.citationKey !== undefined) { const key = typeof updates.citationKey === "string" ? updates.citationKey.trim() : ""; if (key && !/^[A-Za-z][A-Za-z0-9:._-]{0,127}$/.test(key)) throw new ApiError(400, "citation_key_invalid", "Citation key contains unsupported characters"); if (key) link.citationKey = key; else delete link.citationKey; } link.updatedAt = now(); return link; });
  }

  async citationContext(projectId: string, citationKey: string): Promise<{ key: string; contexts: Array<{ path: string; line: number; excerpt: string }>; bibliography?: { path: string; line: number; entry: string } }> {
    this.workspaces.getProject(projectId); const contexts: Array<{ path: string; line: number; excerpt: string }> = []; let bibliography: { path: string; line: number; entry: string } | undefined;
    const files = await this.workspaces.tree(projectId); const paths = flattenText(files).filter((path) => /\.(?:tex|bib)$/i.test(path));
    for (const path of paths) { const file = await this.workspaces.readTextFile(projectId, path); for (const match of file.content.matchAll(new RegExp(`\\\\(?:cite|citep|citet|parencite|textcite|autocite)\\*?(?:\\[[^\\]]*\\]){0,2}\\{[^}]*\\b${escapeRegExp(citationKey)}\\b[^}]*\\}`, "g"))) { const offset = match.index ?? 0; const line = file.content.slice(0, offset).split("\n").length; contexts.push({ path, line, excerpt: file.content.slice(Math.max(0, offset - 240), Math.min(file.content.length, offset + match[0].length + 240)).trim() }); }
      const entry = file.content.match(new RegExp(`@\\w+\\s*\\{\\s*${escapeRegExp(citationKey)}\\s*,[\\s\\S]*?(?=\\n@|$)`, "i")); if (entry) bibliography = { path, line: file.content.slice(0, entry.index ?? 0).split("\n").length, entry: entry[0].slice(0, 4000) }; }
    return { key: citationKey, contexts, ...(bibliography ? { bibliography } : {}) };
  }

  async proposeBibtexChange(projectId: string, workId: string, targetBibPath: string): Promise<ChangeSet> {
    this.workspaces.getProject(projectId); const state = this.database.snapshot(); const work = state.researchWorks.find((item) => item.id === workId); if (!work) throw new ApiError(404, "research_work_not_found", "Research work not found");
    const normalizedTarget = normalizeWorkspacePath(targetBibPath); const exists = await this.workspaces.fileExists(projectId, normalizedTarget); const opened = exists ? await this.workspaces.readTextFile(projectId, normalizedTarget) : undefined; const link = state.projectResearchWorks.find((item) => item.projectId === projectId && item.workId === workId); if (!link || link.status !== "saved") throw new ApiError(409, "research_work_not_approved", "Approve the research work before proposing BibTeX");
    const key = link.citationKey || citationKey(work); const entry = `@article{${key},\n  title = {${work.title}},\n${work.authors.length ? `  author = {${work.authors.join(" and ")}},\n` : ""}${work.year ? `  year = {${work.year}},\n` : ""}${work.venue ? `  journal = {${work.venue}},\n` : ""}}\n`;
    return { id: `change_${crypto.randomUUID()}`, projectId, agentRunId: `research_${crypto.randomUUID()}`, status: "proposed", approvalMode: "explicit-finish", summary: `Add BibTeX entry ${key}`, rationale: "Generated from user-approved research metadata; review and accept through the ChangeSet workflow.", changes: [{ operation: opened ? "replace" : "create", path: normalizedTarget, from: opened?.content.length ?? 0, to: opened?.content.length ?? 0, before: "", after: opened ? `\n${entry}` : entry, baseVersion: opened?.file.version ?? 0, ...(opened ? { baseContent: opened.content } : {}) }], createdAt: now(), updatedAt: now() };
  }

  async extractPdfEvidence(projectId: string, workId: string, pdfBase64: string, authorized: boolean): Promise<SourceEvidence[]> {
    this.workspaces.getProject(projectId); if (!authorized) throw new ApiError(403, "pdf_authorization_required", "Explicit authorization is required before parsing a local PDF"); if (pdfBase64.length > 20_000_000) throw new ApiError(413, "pdf_too_large", "PDF exceeds the 15 MB parsing limit"); const state = this.database.snapshot(); if (!state.researchWorks.some((work) => work.id === workId)) throw new ApiError(404, "research_work_not_found", "Research work not found"); const text = Buffer.from(pdfBase64, "base64").toString("latin1").replace(/[^\x20-\x7E\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000); if (!text) return [];
    const timestamp = now(); const evidence: SourceEvidence = { id: `evidence_${crypto.randomUUID()}`, projectId, workId, kind: "background", origin: "model-extraction", representation: "paraphrase", status: "candidate", content: text, locatorType: "page", locator: "1", createdAt: timestamp, updatedAt: timestamp };
    await this.database.mutate((current) => current.sourceEvidence.push(evidence)); return [evidence];
  }

  private async crossref(query: string, signal?: AbortSignal): Promise<Observation[]> { const response = await this.fetcher(`https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=5`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(5000)]) }); requireProviderResponse(response, "Crossref"); const body = await response.json() as { message?: { items?: any[] } }; return (body.message?.items ?? []).map((item) => ({ provider: "crossref" as const, title: item.title?.[0] ?? "", authors: (item.author ?? []).map((author: any) => [author.given, author.family].filter(Boolean).join(" ")), year: item.published?.["date-parts"]?.[0]?.[0] ?? item.issued?.["date-parts"]?.[0]?.[0], venue: item["container-title"]?.[0], identifiers: item.DOI ? [{ scheme: "doi" as const, value: String(item.DOI).toLowerCase() }] : [] })).filter((item) => item.title); }
  private async openAlex(query: string, signal?: AbortSignal): Promise<Observation[]> { const response = await this.fetcher(`https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=5`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(5000)]) }); requireProviderResponse(response, "OpenAlex"); const body = await response.json() as { results?: any[] }; return (body.results ?? []).map((item) => ({ provider: "openalex" as const, title: item.title ?? "", authors: (item.authorships ?? []).map((author: any) => author.author?.display_name).filter(Boolean), year: item.publication_year, venue: item.primary_location?.source?.display_name, identifiers: item.ids?.doi ? [{ scheme: "doi" as const, value: String(item.ids.doi).replace(/^https?:\/\/doi\.org\//i, "").toLowerCase() }] : item.id ? [{ scheme: "openalex" as const, value: String(item.id) }] : [] })).filter((item) => item.title); }
  private async semanticScholar(query: string, signal?: AbortSignal): Promise<Observation[]> { const response = await this.fetcher(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=5&fields=title,authors,year,venue,externalIds`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(5000)]) }); requireProviderResponse(response, "Semantic Scholar"); const body = await response.json() as { data?: any[] }; return (body.data ?? []).map((item) => ({ provider: "semantic-scholar" as const, title: item.title ?? "", authors: (item.authors ?? []).map((author: any) => author.name).filter(Boolean), year: item.year, venue: item.venue, identifiers: item.externalIds?.DOI ? [{ scheme: "doi" as const, value: String(item.externalIds.DOI).toLowerCase() }] : item.paperId ? [{ scheme: "semantic-scholar" as const, value: String(item.paperId) }] : [] })).filter((item) => item.title); }
  private async arxiv(query: string, signal?: AbortSignal): Promise<Observation[]> { const response = await this.fetcher(`https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=5`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(5000)]) }); requireProviderResponse(response, "arXiv"); const xml = await response.text(); return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => { const entry = match[1] ?? ""; const title = decodeXml(/<title>([\s\S]*?)<\/title>/.exec(entry)?.[1] ?? "").replace(/\s+/g, " ").trim(); const id = /<id>([^<]+)</.exec(entry)?.[1]?.trim(); const year = Number(/<published>(\d{4})/.exec(entry)?.[1]); const authors = [...entry.matchAll(/<name>([^<]+)</g)].map((item) => decodeXml(item[1] ?? "")); return { provider: "arxiv" as const, title, authors, ...(Number.isFinite(year) && year > 0 ? { year } : {}), identifiers: id ? [{ scheme: "arxiv" as const, value: id.split("/").pop()! }] : [] }; }).filter((item) => item.title); }
}

type Observation = { provider: "crossref" | "openalex" | "semantic-scholar" | "arxiv"; title: string; authors: string[]; year?: number; venue?: string; identifiers: Array<{ scheme: ResearchIdentifier["scheme"]; value: string }> };
function findWork(works: ResearchWork[], knownIdentifiers: ResearchIdentifier[], identifiers: Observation["identifiers"], title: string, authors: string[], year?: number): ResearchWork | undefined { const byIdentifier = works.find((work) => identifiers.some((identifier) => knownIdentifiers.some((known) => known.workId === work.id && known.scheme === identifier.scheme && known.value.toLowerCase() === identifier.value.toLowerCase()))); if (byIdentifier) return byIdentifier; const normalizedTitle = normalize(title); const first = normalize(authors[0] ?? ""); return works.find((work) => normalize(work.title) === normalizedTitle && (!year || !work.year || work.year === year) && (!first || normalize(work.authors[0] ?? "") === first)) ?? undefined; }
function normalize(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function dedupeWorks(works: ResearchWork[]): ResearchWork[] { return [...new Map(works.map((work) => [work.id, work])).values()]; }
function flattenText(nodes: any[]): string[] { return nodes.flatMap((node) => node.type === "directory" ? flattenText(node.children) : node.kind === "text" ? [node.path] : []); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&"); }
function citationKey(work: ResearchWork): string { return `${(work.authors[0] ?? "ref").replace(/[^A-Za-z]/g, "").toLowerCase() || "ref"}${work.year ?? ""}`; }
function decodeXml(value: string): string { return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }
function requireProviderResponse(response: Response, provider: string): void { if (!response.ok) throw new Error(`${provider} returned HTTP ${response.status}`); }
function providerError(error: unknown): string { return (error instanceof Error ? error.message : "Provider request failed").replace(/https?:\/\/\S+/g, "provider endpoint").slice(0, 240); }

type FastReadManifest = {
  version: 1;
  bundle_id: string;
  immutable: true;
  files: Array<{ name: string; sha256: string; bytes: number }>;
};

type FastReadCitations = {
  papers: Array<{ id: string; title: string; authors: string[]; year?: number; doi?: string; content_hash?: string }>;
  citations: Array<{ task_id: string; page: number; exact_quote: string; role?: string; note?: string; source_hash: string }>;
};

const FASTREAD_FILES = new Set(["evidence.md", "citations.json", "references.bib", "user-notes.md"]);
const FASTREAD_MANIFEST = /^references\/fastread\/([0-9a-f]{24})\/manifest\.json$/;

function isFastReadManifestPath(path: string): boolean { return FASTREAD_MANIFEST.test(path); }

function normalizeFastReadManifestPath(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  if (!isFastReadManifestPath(normalized)) throw new ApiError(400, "fastread_manifest_path_invalid", "FastRead manifest must be references/fastread/<24 hex bundle id>/manifest.json");
  return normalized;
}

function bundleIdFromManifestPath(path: string): string {
  const match = FASTREAD_MANIFEST.exec(path);
  if (!match?.[1]) throw new ApiError(400, "fastread_manifest_path_invalid", "FastRead manifest path is invalid");
  return match[1];
}

function fastReadReceiptId(projectId: string, bundleId: string): string {
  return `fastread_${sha256(`${projectId}\u0000${bundleId}`).slice(0, 24)}`;
}

function parseFastReadManifest(content: string, bundleId: string): FastReadManifest {
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { throw new ApiError(400, "fastread_manifest_invalid", "FastRead manifest is not valid JSON"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError(400, "fastread_manifest_invalid", "FastRead manifest must be an object");
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || value.bundle_id !== bundleId || value.immutable !== true || !Array.isArray(value.files)) throw new ApiError(400, "fastread_manifest_invalid", "FastRead manifest version, bundle id, or immutable marker is invalid");
  if (value.files.length > FASTREAD_FILES.size) throw new ApiError(400, "fastread_manifest_invalid", "FastRead manifest contains too many files");
  const names = new Set<string>();
  const files = value.files.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new ApiError(400, "fastread_manifest_invalid", "FastRead manifest file entries must be objects");
    const entry = item as Record<string, unknown>;
    if (typeof entry.name !== "string" || !FASTREAD_FILES.has(entry.name) || names.has(entry.name)) throw new ApiError(400, "fastread_manifest_invalid", "FastRead manifest contains an unknown or duplicate file");
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new ApiError(400, "fastread_manifest_invalid", `FastRead manifest hash for '${entry.name}' is invalid`);
    if (!Number.isInteger(entry.bytes) || (entry.bytes as number) < 0 || (entry.bytes as number) > 20_000_000) throw new ApiError(400, "fastread_manifest_invalid", `FastRead manifest size for '${entry.name}' is invalid`);
    names.add(entry.name);
    return { name: entry.name, sha256: entry.sha256, bytes: entry.bytes as number };
  });
  return { version: 1, bundle_id: bundleId, immutable: true, files };
}

function parseFastReadCitations(content: string, bundleId: string): FastReadCitations {
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { throw new ApiError(400, "fastread_citations_invalid", "FastRead citations.json is not valid JSON"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError(400, "fastread_citations_invalid", "FastRead citations.json must be an object");
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || value.bundle_id !== bundleId || !Array.isArray(value.papers) || !Array.isArray(value.citations)) throw new ApiError(400, "fastread_citations_invalid", "FastRead citations version or bundle id is invalid");
  if (value.papers.length > 500 || value.citations.length > 10_000) throw new ApiError(413, "fastread_bundle_too_large", "FastRead bundle exceeds import limits");
  const papers = value.papers.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new ApiError(400, "fastread_citations_invalid", "FastRead paper metadata must be an object");
    const paper = item as Record<string, unknown>;
    const id = typeof paper.id === "string" ? paper.id.trim().slice(0, 256) : "";
    if (!id) throw new ApiError(400, "fastread_citations_invalid", "FastRead paper metadata is missing an id");
    const title = typeof paper.title === "string" && paper.title.trim() ? paper.title.trim().slice(0, 2_000) : "Untitled FastRead paper";
    const authors = Array.isArray(paper.authors) ? paper.authors.filter((author): author is string => typeof author === "string").map((author) => author.trim().slice(0, 300)).filter(Boolean).slice(0, 100) : [];
    const year = Number.isInteger(paper.year) && (paper.year as number) > 0 ? paper.year as number : undefined;
    const doi = typeof paper.doi === "string" && paper.doi.trim() ? paper.doi.trim().slice(0, 500) : undefined;
    const content_hash = typeof paper.content_hash === "string" ? paper.content_hash.trim().slice(0, 256) : undefined;
    return { id, title, authors, ...(year ? { year } : {}), ...(doi ? { doi } : {}), ...(content_hash ? { content_hash } : {}) };
  });
  const citations = value.citations.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new ApiError(400, "fastread_citations_invalid", "FastRead citation entries must be objects");
    const citation = item as Record<string, unknown>;
    const task_id = typeof citation.task_id === "string" ? citation.task_id.trim().slice(0, 256) : "";
    const page = Number.isInteger(citation.page) ? citation.page as number : 0;
    const exact_quote = typeof citation.exact_quote === "string" ? citation.exact_quote.trim().slice(0, 4_000) : "";
    if (!task_id || page <= 0 || !exact_quote) throw new ApiError(400, "fastread_citations_invalid", "FastRead citations require task_id, positive page, and exact_quote");
    return {
      task_id,
      page,
      exact_quote,
      ...(typeof citation.role === "string" && citation.role.trim() ? { role: citation.role.trim().slice(0, 100) } : {}),
      ...(typeof citation.note === "string" && citation.note.trim() ? { note: citation.note.trim().slice(0, 1_000) } : {}),
      source_hash: typeof citation.source_hash === "string" ? citation.source_hash.trim().slice(0, 256) : ""
    };
  });
  return { papers, citations };
}

function bibtexKeys(content: string): string[] {
  return [...content.matchAll(/@\w+\s*\{\s*([^,\s]+)/g)].map((match) => match[1]!).filter(Boolean);
}

function citationKeyForIndex(work: ResearchWork, index: number): string {
  return `${citationKey(work)}_${index + 1}`;
}

function sha256(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

function upsertFastReadReceipt(receipts: FastReadBundleReceipt[], receipt: FastReadBundleReceipt): FastReadBundleReceipt {
  const index = receipts.findIndex((item) => item.projectId === receipt.projectId && item.bundleId === receipt.bundleId);
  if (index >= 0) receipts[index] = receipt;
  else receipts.push(receipt);
  return receipt;
}
