import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type {
  CreateProjectRequest,
  GithubImportRequest,
  GithubSyncResolution,
  DraftOutlineSection,
  DraftRequest,
  ReviewIssueStatus,
  MemoryItemStatus,
  AgentTaskRequest,
  CompletionRequest,
  ChangeSetEditRequest,
  ChangeSetDecisionRequest,
  ReviseRequest,
  SaveFileRequest,
  PublicationTarget,
  TargetVenue,
  UploadManifestEntry
  ,AgentWireApi
} from "@fastwrite/shared";
import type { AgentProvider } from "./agent/provider";
import { OpenAIAgentProvider } from "./agent/provider";
import { DraftService } from "./agent/draft-service";
import { ReviseService } from "./agent/revise-service";
import { ReviewService } from "./agent/review-service";
import { MemoryService } from "./agent/memory-service";
import { AgentTaskService } from "./agent/agent-task-service";
import { CompletionService } from "./agent/completion-service";
import { SkillRegistry } from "./agent/skill-registry";
import { TexPackageService, type TexPackageProvider } from "./compiler/tex-package-service";
import { LatexCompileService } from "./compiler/latex-compile-service";
import { ComplianceService } from "./compliance/compliance-service";
import { embeddedWebFile } from "./embedded-web";
import { config, type AgentProviderConfiguration } from "./config";
import { GithubService } from "./imports/github-service";
import { UploadService } from "./imports/upload-service";
import { GithubSyncService } from "./sync/github-sync-service";
import { ApiError, errorResponse, json, readJson, withRuntimeHeaders } from "./http";
import { JsonDatabase } from "./storage/database";
import { WorkspaceService } from "./workspace/workspace-service";
import { LatexTemplateService } from "./templates/latex-template-service";
import { ResearchService } from "./research/research-service";
import { ClaimService } from "./claims/claim-service";
import { AlignmentService } from "./alignment/alignment-service";
import { normalizePlaceholderFindings } from "./agent/citation-findings";

interface Services {
  database: JsonDatabase;
  workspaces: WorkspaceService;
  uploads: UploadService;
  github: GithubService;
  githubSync: GithubSyncService;
  revisions: ReviseService;
  drafts: DraftService;
  reviews: ReviewService;
  memories: MemoryService;
  agentTasks: AgentTaskService;
  completions: CompletionService;
  texPackages: TexPackageProvider;
  latexCompiler: LatexCompileService;
  skillRegistry: SkillRegistry;
  compliance: ComplianceService;
  latexTemplates: LatexTemplateService;
  research: ResearchService;
  claims: ClaimService;
  alignment: AlignmentService;
}

type Handler = (request: Request, params: Record<string, string>, url: URL) => Promise<Response> | Response;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export interface ApplicationOptions {
  agentProvider?: AgentProvider;
  texPackages?: TexPackageProvider;
}

function providerFor(configuration: AgentProviderConfiguration): AgentProvider | undefined {
  return configuration.apiKey ? new OpenAIAgentProvider(configuration.apiKey, configuration.model, configuration.baseURL, configuration.wireAPI) : undefined;
}

interface AgentSettingsInput {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  wireAPI?: AgentWireApi;
}

function boundedSetting(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maximum) : undefined;
}

function runtimeAgentProvider(getProvider: () => AgentProvider | undefined): AgentProvider {
  return new Proxy({}, {
    get(_target, property) {
      if (property === "then") return undefined;
      const current = getProvider();
      const method = current?.[property as keyof AgentProvider];
      return typeof method === "function" ? (...args: unknown[]) => {
        const provider = getProvider();
        const activeMethod = provider?.[property as keyof AgentProvider];
        if (typeof activeMethod !== "function") throw new ApiError(503, "agent_not_configured", "Add an API key in Project settings to enable Agent tasks");
        return (activeMethod as (...parameters: unknown[]) => unknown).apply(provider, args);
      } : undefined;
    }
  }) as AgentProvider;
}

export async function createApplication(dataDirectory = config.dataDirectory, options: ApplicationOptions = {}) {
  const database = new JsonDatabase(dataDirectory);
  await database.initialize();
  const workspaces = new WorkspaceService(dataDirectory, database);
  await workspaces.initialize();
  const uploads = new UploadService(dataDirectory, database, workspaces);
  await uploads.initialize();
  const texPackages = options.texPackages ?? new TexPackageService(dataDirectory);
  await texPackages.initialize();
  const defaultProvider = options.agentProvider;
  const configuredProviders = {
    completion: defaultProvider ?? providerFor(config.agentProviders.completion),
    agent: defaultProvider ?? providerFor(config.agentProviders.agent),
    revise: defaultProvider ?? providerFor(config.agentProviders.revise),
    review: defaultProvider ?? providerFor(config.agentProviders.review),
    memory: defaultProvider ?? providerFor(config.agentProviders.memory)
  };
  let runtimeConfiguration: AgentProviderConfiguration | undefined;
  let runtimeProvider: AgentProvider | undefined;
  const providers = Object.fromEntries(Object.entries(configuredProviders).map(([workflow, provider]) => [workflow, runtimeAgentProvider(() => runtimeProvider ?? provider)])) as typeof configuredProviders;
  const configureAgent = (input: AgentSettingsInput) => {
    const apiKey = boundedSetting(input.apiKey, 1_024);
    if (!apiKey) throw new ApiError(400, "agent_api_key_required", "Enter an API key to enable Agent tasks");
    const baseURL = boundedSetting(input.baseURL, 2_048);
    if (baseURL) {
      try { new URL(baseURL); } catch { throw new ApiError(400, "agent_base_url_invalid", "Base URL must be a valid absolute URL"); }
    }
    if (input.wireAPI !== undefined && input.wireAPI !== "chat" && input.wireAPI !== "responses") throw new ApiError(400, "agent_wire_api_invalid", "Wire API must be 'chat' or 'responses'");
    runtimeConfiguration = { apiKey, ...(baseURL ? { baseURL } : {}), ...(boundedSetting(input.model, 256) ? { model: boundedSetting(input.model, 256) } : {}), wireAPI: input.wireAPI ?? (baseURL ? "chat" : "responses") };
    runtimeProvider = providerFor(runtimeConfiguration);
  };
  const skillRegistry = new SkillRegistry(config.skillsDirectory);
  const latexTemplates = new LatexTemplateService(dataDirectory, fetch, config.templateDirectory);
  const memories = new MemoryService(database, workspaces, skillRegistry, providers.memory);
  const revisions = new ReviseService(database, workspaces, skillRegistry, providers.revise, memories);
  const drafts = new DraftService(database, workspaces, skillRegistry, providers.agent);
  const reviews = new ReviewService(database, workspaces, skillRegistry, providers.review);
  const compliance = new ComplianceService(workspaces, skillRegistry);
  const research = new ResearchService(database, workspaces);
  const claims = new ClaimService(database, workspaces);
  const alignment = new AlignmentService(workspaces);
  const agentTasks = new AgentTaskService(database, workspaces, skillRegistry, providers.agent, memories, providers.review, compliance);
  const completions = new CompletionService(workspaces, skillRegistry, providers.completion, memories);
  const services: Services = { database, workspaces, uploads, github: new GithubService(dataDirectory, workspaces), githubSync: new GithubSyncService(dataDirectory, database, workspaces), revisions, drafts, reviews, memories, agentTasks, completions, texPackages, latexCompiler: new LatexCompileService(dataDirectory, workspaces), skillRegistry, compliance, latexTemplates, research, claims, alignment };
  const routes = buildRoutes(services, {
    status: () => {
      const activeConfiguration = runtimeConfiguration ?? config.agentProviders.agent;
      return { configured: Boolean(runtimeProvider ?? configuredProviders.agent), source: runtimeProvider ? "runtime" : configuredProviders.agent ? "environment" : "none", ...(activeConfiguration.baseURL ? { baseURL: activeConfiguration.baseURL } : {}), ...(activeConfiguration.model ? { model: activeConfiguration.model } : {}), wireAPI: activeConfiguration.wireAPI ?? (activeConfiguration.baseURL ? "chat" : "responses") };
    },
    configure: configureAgent
  });

  return async function fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) {
        const route = routes.find((candidate) => candidate.method === request.method && candidate.pattern.test(url.pathname));
        if (!route) throw new ApiError(404, "route_not_found", "API route not found");
        const match = url.pathname.match(route.pattern)!;
        const params = Object.fromEntries(route.keys.map((key, index) => [key, decodeURIComponent(match[index + 1] ?? "")]));
        return withRuntimeHeaders(await route.handler(request, params, url));
      }
      return withRuntimeHeaders(await serveWeb(url.pathname));
    } catch (error) {
      return withRuntimeHeaders(errorResponse(error));
    }
  };
}

function buildRoutes({ database, workspaces, uploads, github, githubSync, revisions, drafts, reviews, memories, agentTasks, completions, texPackages, latexCompiler, skillRegistry, compliance, latexTemplates, research, claims, alignment }: Services, agentSettings: { status: () => { configured: boolean; source: "runtime" | "environment" | "none"; baseURL?: string; model?: string; wireAPI: AgentWireApi }; configure: (input: AgentSettingsInput) => void }): Route[] {
  return [
    route("GET", "/api/health", async () => json({ status: "ok" })),
    route("GET", "/api/agent-settings", async () => json(agentSettings.status())),
    route("PUT", "/api/agent-settings", async (request) => { agentSettings.configure(await readJson<AgentSettingsInput>(request)); return json(agentSettings.status()); }),
    route("GET", "/api/venues", async () => json(await skillRegistry.catalog())),
    route("POST", "/api/projects/:projectId/compliance-checks", async (request, params) => {
      const body = await readJson<{ pdfBase64?: string; renderedPages?: number; mainBodyPages?: number; verifyCitationsOnline?: boolean }>(request);
      return json(await compliance.check(required(params, "projectId"), body), 201);
    }),
    route("POST", "/api/projects/:projectId/research-runs", async (request, params) => {
      const body = await readJson<{ query?: string }>(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "invalid_research_request", "Research request must be an object");
      return json(await research.search(required(params, "projectId"), typeof body.query === "string" ? body.query : "", request.signal), 201);
    }),
    route("POST", "/api/projects/:projectId/research-runs/:runId/confirm", async (_request, params) => json(await research.confirm(required(params, "projectId"), required(params, "runId")))),
    route("PATCH", "/api/projects/:projectId/research-runs/:runId", async (request, params) => json(await research.updatePlan(required(params, "projectId"), required(params, "runId"), await readJson<{ steps: string[]; rationale?: string }>(request)))),
    route("POST", "/api/projects/:projectId/research-runs/:runId/cancel", async (_request, params) => json(await research.cancel(required(params, "projectId"), required(params, "runId")))),
    route("GET", "/api/projects/:projectId/research-runs", async (_request, params) => { const projectId = required(params, "projectId"); workspaces.getProject(projectId); return json(database.snapshot().researchRuns.filter((item) => item.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))); }),
    route("GET", "/api/projects/:projectId/research-works", async (_request, params) => json(research.listWorks(required(params, "projectId")))),
    route("POST", "/api/projects/:projectId/research-works/import", async (request, params) => { const body = await readJson<Parameters<ResearchService["importWork"]>[1]>(request); if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "invalid_research_request", "Research import must be an object"); return json(await research.importWork(required(params, "projectId"), body), 201); }),
    route("PATCH", "/api/projects/:projectId/research-works/:workId", async (request, params) => json(await research.saveWork(required(params, "projectId"), required(params, "workId"), await readJson<{ status?: "candidate" | "saved" | "rejected"; citationKey?: string }>(request)))),
    route("GET", "/api/projects/:projectId/research-citations/:citationKey", async (_request, params) => json(await research.citationContext(required(params, "projectId"), required(params, "citationKey")))),
    route("POST", "/api/projects/:projectId/research-works/:workId/bibtex-changes", async (request, params) => { const body = await readJson<{ targetBibPath?: string }>(request); if (!body.targetBibPath) throw new ApiError(400, "target_bib_required", "targetBibPath is required"); const changeSet = await research.proposeBibtexChange(required(params, "projectId"), required(params, "workId"), body.targetBibPath); return json(await database.mutate((state) => { state.changeSets.push(changeSet); return changeSet; }), 201); }),
    route("POST", "/api/projects/:projectId/research-works/:workId/pdf-evidence", async (request, params) => { const body = await readJson<{ pdfBase64?: string; authorized?: boolean }>(request); if (!body.pdfBase64 || body.authorized !== true) throw new ApiError(403, "pdf_authorization_required", "Provide bounded PDF data with explicit authorization"); return json(await research.extractPdfEvidence(required(params, "projectId"), required(params, "workId"), body.pdfBase64, body.authorized === true), 201); }),
    route("POST", "/api/projects/:projectId/claim-scans", async (_request, params) => json(await claims.scan(required(params, "projectId")), 201)),
    route("POST", "/api/projects/:projectId/alignment-checks", async (_request, params) => json(await alignment.check(required(params, "projectId")), 201)),
    route("GET", "/api/projects/:projectId/claims", async (_request, params) => json(claims.list(required(params, "projectId")))),
    route("POST", "/api/projects/:projectId/claims/:claimId/reanchor", async (_request, params) => json(await claims.reanchor(required(params, "projectId"), required(params, "claimId")))),
    route("PATCH", "/api/projects/:projectId/claims/:claimId", async (request, params) => json(await claims.update(required(params, "projectId"), required(params, "claimId"), await readJson<{ reviewStatus?: "detected" | "needs-review" | "supported" | "partial" | "unsupported"; anchorStatus?: "current" | "stale" | "reanchored" | "orphaned" }>(request)))),
    route("POST", "/api/projects/:projectId/claims/:claimId/links", async (request, params) => json(await claims.link(required(params, "projectId"), required(params, "claimId"), await readJson<any>(request)), 201)),
    route("DELETE", "/api/projects/:projectId/claims/:claimId/links/:linkId", async (_request, params) => { await claims.unlink(required(params, "projectId"), required(params, "claimId"), required(params, "linkId")); return new Response(null, { status: 204 }); }),
    route("GET", "/api/projects/:projectId/evidence", async (_request, params) => { const projectId = required(params, "projectId"); workspaces.getProject(projectId); return json(database.snapshot().sourceEvidence.filter((item) => item.projectId === projectId)); }),
    route("POST", "/api/projects/:projectId/evidence", async (request, params) => { const projectId = required(params, "projectId"); workspaces.getProject(projectId); const body = await readJson<{ workId?: string; kind?: "background" | "claim" | "method" | "result" | "limitation" | "quote"; content?: string; locatorType?: "page" | "section" | "paragraph" | "abstract"; locator?: string; origin?: "source-text" | "registry-abstract" | "model-extraction" | "user"; representation?: "verbatim" | "paraphrase" }>(request); if (!body.workId || !body.content?.trim() || !body.locator) throw new ApiError(400, "evidence_invalid", "workId, content and locator are required"); const state = database.snapshot(); if (!state.researchWorks.some((work) => work.id === body.workId)) throw new ApiError(404, "research_work_not_found", "Research work not found"); const timestamp = new Date().toISOString(); return json(await database.mutate((current) => { const evidence = { id: `evidence_${crypto.randomUUID()}`, projectId, workId: body.workId!, kind: body.kind ?? "background", origin: body.origin ?? "user", representation: body.representation ?? "paraphrase", status: "candidate" as const, content: body.content!.trim().slice(0, 4000), locatorType: body.locatorType ?? "abstract", locator: body.locator!.trim().slice(0, 200), createdAt: timestamp, updatedAt: timestamp }; current.sourceEvidence.push(evidence); return evidence; }), 201); }),
    route("PATCH", "/api/projects/:projectId/evidence/:evidenceId", async (request, params) => { const projectId = required(params, "projectId"); workspaces.getProject(projectId); const body = await readJson<{ status?: "candidate" | "approved" | "rejected" | "stale" }>(request); return json(await database.mutate((state) => { const evidence = state.sourceEvidence.find((item) => item.projectId === projectId && item.id === required(params, "evidenceId")); if (!evidence) throw new ApiError(404, "evidence_not_found", "Evidence not found"); if (body.status) evidence.status = body.status; if (body.status === "approved") evidence.approvedAt = new Date().toISOString(); evidence.updatedAt = new Date().toISOString(); return evidence; })); }),
    route("GET", "/api/texlive/:packageName", async (_request, params, url) => texPackages.texLiveArchive(required(params, "packageName"), url.searchParams.get("tlYear"))),
    route("GET", "/api/fetch/:packageName", async (_request, params, url) => texPackages.ctanPackage(required(params, "packageName"), url.searchParams.get("tlYear"))),
    route("GET", "/api/ctan-pkg/:packageName", async (_request, params) => texPackages.ctanPackageInfo(required(params, "packageName"))),
    route("GET", "/api/projects", async () => json(workspaces.listProjects())),
    route("POST", "/api/projects", async (request) => {
      const body = await readJson<CreateProjectRequest>(request);
      if (body.initializeFromTemplate) {
        if (!body.publicationTarget) throw new ApiError(400, "template_target_required", "Select a conference or journal before using its template");
        const venue = body.venue ?? body.publicationTarget.domain;
        const template = await latexTemplates.materialize(body.name, venue, body.publicationTarget);
        return json(await workspaces.importStagingDirectory({ stagingDirectory: template.stagingDirectory, name: body.name, mainDocument: template.mainDocument, venue, publicationTarget: body.publicationTarget, source: { type: "local", displayName: template.displayName } }), 201);
      }
      return json(await workspaces.createEmpty(body.name, body.mainDocument, body.venue, body.publicationTarget), 201);
    }),
    route("GET", "/api/projects/:projectId", async (_request, params) => json(workspaces.getProject(required(params, "projectId")))),
    route("PATCH", "/api/projects/:projectId", async (request, params) => {
      const body = await readJson<{ name?: string; mainDocument?: string; venue?: TargetVenue; publicationTarget?: PublicationTarget | null }>(request);
      return json(await workspaces.updateProject(required(params, "projectId"), body));
    }),
    route("DELETE", "/api/projects/:projectId", async (_request, params) => {
      await workspaces.deleteProject(required(params, "projectId"));
      return new Response(null, { status: 204 });
    }),
    route("GET", "/api/projects/:projectId/export", async (_request, params) => {
      return workspaces.exportProject(required(params, "projectId"));
    }),
    route("POST", "/api/projects/:projectId/history/checkpoint", async (_request, params) => {
      return json(await workspaces.createHistoryCheckpoint(required(params, "projectId")), 201);
    }),
    route("POST", "/api/projects/:projectId/github-sync", async (_request, params) => {
      return json(await githubSync.start(required(params, "projectId")), 201);
    }),
    route("POST", "/api/projects/:projectId/github-sync/:syncId/resolve", async (request, params) => {
      const body = await readJson<{ resolutions: GithubSyncResolution[] }>(request);
      return json(await githubSync.resolve(required(params, "projectId"), required(params, "syncId"), body.resolutions));
    }),
    route("POST", "/api/projects/:projectId/github-sync/:syncId/finalize", async (_request, params) => {
      return json(await githubSync.finalize(required(params, "projectId"), required(params, "syncId")));
    }),
    route("GET", "/api/projects/:projectId/files", async (_request, params, url) => {
      const directory = url.searchParams.get("directory");
      return json(directory === null ? await workspaces.tree(required(params, "projectId")) : await workspaces.treeLevel(required(params, "projectId"), directory));
    }),
    route("GET", "/api/projects/:projectId/file", async (_request, params, url) => {
      return json(await workspaces.readTextFile(required(params, "projectId"), requiredQuery(url, "path")));
    }),
    route("GET", "/api/projects/:projectId/asset", async (_request, params, url) => {
      return workspaces.readAsset(required(params, "projectId"), requiredQuery(url, "path"));
    }),
    route("PUT", "/api/projects/:projectId/file", async (request, params, url) => {
      const body = await readJson<SaveFileRequest>(request);
      return json(await workspaces.saveTextFile(required(params, "projectId"), requiredQuery(url, "path"), body));
    }),
    route("POST", "/api/projects/:projectId/files", async (request, params) => {
      const body = await readJson<{ path: string; content?: string }>(request);
      return json(await workspaces.createFile(required(params, "projectId"), body.path, body.content ?? ""), 201);
    }),
    route("PUT", "/api/projects/:projectId/assets", async (request, params, url) => {
      return json(await workspaces.addFile(required(params, "projectId"), requiredQuery(url, "path"), await request.arrayBuffer()), 201);
    }),
    route("PATCH", "/api/projects/:projectId/files", async (request, params) => {
      const body = await readJson<{ from: string; to: string }>(request);
      await workspaces.renamePath(required(params, "projectId"), body.from, body.to);
      return new Response(null, { status: 204 });
    }),
    route("DELETE", "/api/projects/:projectId/files", async (_request, params, url) => {
      await workspaces.deletePath(required(params, "projectId"), requiredQuery(url, "path"));
      return new Response(null, { status: 204 });
    }),
    route("GET", "/api/projects/:projectId/outline", async (_request, params) => json(await workspaces.outline(required(params, "projectId")))),
    route("GET", "/api/projects/:projectId/skills", async (_request, params) => json(workspaces.getProject(required(params, "projectId")).skill)),
    route("POST", "/api/projects/:projectId/completions", async (request, params) => {
      return json(await completions.suggest(required(params, "projectId"), await readJson<CompletionRequest>(request)), 201);
    }),
    route("POST", "/api/projects/:projectId/revisions", async (request, params) => {
      return json(await revisions.propose(required(params, "projectId"), await readJson<ReviseRequest>(request)), 201);
    }),
    route("GET", "/api/projects/:projectId/drafts", async (_request, params) => json(drafts.list(required(params, "projectId")))),
    route("POST", "/api/projects/:projectId/drafts", async (request, params) => {
      return json(await drafts.plan(required(params, "projectId"), await readJson<DraftRequest>(request), request.signal), 201);
    }),
    route("POST", "/api/projects/:projectId/drafts/:draftId/confirm", async (request, params) => {
      const body = await readJson<{ outline: DraftOutlineSection[] }>(request);
      return json(await drafts.confirm(required(params, "projectId"), required(params, "draftId"), body.outline, request.signal), 201);
    }),
    route("POST", "/api/projects/:projectId/drafts/:draftId/cancel", async (_request, params) => {
      return json(await drafts.cancel(required(params, "projectId"), required(params, "draftId")));
    }),
    route("GET", "/api/projects/:projectId/reviews", async (_request, params) => json(reviews.list(required(params, "projectId")))),
    route("POST", "/api/projects/:projectId/reviews", async (request, params) => {
      const body = await readJson<{ sourceOnly?: boolean; pageText?: string[] }>(request);
      if (body.pageText !== undefined && (!Array.isArray(body.pageText) || body.pageText.some((item) => typeof item !== "string") || body.pageText.length > 20 || body.pageText.reduce((total, item) => total + item.length, 0) > 200_000)) throw new ApiError(400, "review_pdf_preview_invalid", "PDF preview text exceeds the bounded review input limits");
      return json(await reviews.run(required(params, "projectId"), body.sourceOnly === true, request.signal, body.pageText ?? []), 201);
    }),
    route("PATCH", "/api/projects/:projectId/review-issues/:issueId", async (request, params) => {
      return json(await reviews.updateIssue(required(params, "projectId"), required(params, "issueId"), await readJson<{ status?: ReviewIssueStatus; priority?: number; reason?: string }>(request)));
    }),
    route("POST", "/api/projects/:projectId/review-issues", async (request, params) => json(await reviews.createIssue(required(params, "projectId"), await readJson<Parameters<ReviewService["createIssue"]>[1]>(request)), 201)),
    route("POST", "/api/projects/:projectId/review-issues/:issueId/merge", async (request, params) => { const body = await readJson<{ duplicateIds: string[]; reason?: string }>(request); return json(await reviews.mergeIssues(required(params, "projectId"), required(params, "issueId"), body.duplicateIds, body.reason)); }),
    route("GET", "/api/projects/:projectId/memory", async (_request, params) => json(await memories.get(required(params, "projectId")))),
    route("POST", "/api/projects/:projectId/memory/extract", async (_request, params) => json(await memories.extract(required(params, "projectId")), 201)),
    route("POST", "/api/projects/:projectId/memory/apply", async (_request, params) => json(await memories.applyReviewed(required(params, "projectId")))),
    route("PATCH", "/api/projects/:projectId/memory/overview", async (request, params) => {
      const body = await readJson<{ content: string; locked?: boolean }>(request);
      return json(await memories.updateOverview(required(params, "projectId"), body.content, body.locked !== false, request.signal));
    }),
    route("POST", "/api/projects/:projectId/memory/overview/accept", async (_request, params) => json(await memories.acceptOverviewCandidate(required(params, "projectId")))),
    route("PATCH", "/api/projects/:projectId/memory/sections/:sectionId", async (request, params) => {
      const body = await readJson<{ content: string; locked?: boolean }>(request);
      return json(await memories.updateSection(required(params, "projectId"), required(params, "sectionId"), body.content, body.locked !== false, request.signal));
    }),
    route("POST", "/api/projects/:projectId/memory/sections/:sectionId/accept", async (_request, params) => json(await memories.acceptSectionCandidate(required(params, "projectId"), required(params, "sectionId")))),
    route("PATCH", "/api/projects/:projectId/memory/items/:itemId", async (request, params) => {
      return json(await memories.updateItem(required(params, "projectId"), required(params, "itemId"), await readJson<{ status?: MemoryItemStatus; content?: string; label?: string }>(request), request.signal));
    }),
    route("POST", "/api/projects/:projectId/memory/items/:itemId/accept", async (_request, params) => json(await memories.acceptItemCandidate(required(params, "projectId"), required(params, "itemId")))),
    route("POST", "/api/projects/:projectId/memory/rollback", async (_request, params) => json(await memories.rollback(required(params, "projectId")))),
    route("GET", "/api/projects/:projectId/agent-tasks", async (_request, params) => json(agentTasks.list(required(params, "projectId")))),
    route("GET", "/api/projects/:projectId/agent-runs", async (_request, params) => { const projectId = required(params, "projectId"); workspaces.getProject(projectId); return json(database.snapshot().agentRuns.filter((run) => run.projectId === projectId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))); }),
    route("POST", "/api/projects/:projectId/agent-tasks", async (request, params) => json(await agentTasks.plan(required(params, "projectId"), await readJson<AgentTaskRequest>(request), request.signal), 201)),
    route("POST", "/api/projects/:projectId/agent-tasks/:planId/confirm", async (request, params) => json(await agentTasks.confirm(required(params, "projectId"), required(params, "planId"), request.signal), 201)),
    route("POST", "/api/projects/:projectId/agent-tasks/:planId/cancel", async (_request, params) => json(await agentTasks.cancel(required(params, "projectId"), required(params, "planId")))),
    route("GET", "/api/projects/:projectId/issue-resolutions", async (_request, params) => json(agentTasks.resolutions(required(params, "projectId")))),
    route("POST", "/api/projects/:projectId/issue-resolutions/:resolutionId/rereview", async (request, params) => json(await agentTasks.rereview(required(params, "projectId"), required(params, "resolutionId"), request.signal))),
    route("POST", "/api/projects/:projectId/issue-resolutions/:resolutionId/reopen", async (_request, params) => json(await agentTasks.reopen(required(params, "projectId"), required(params, "resolutionId")))),
    route("GET", "/api/projects/:projectId/compile-results/latest", async (_request, params) => {
      const projectId = required(params, "projectId");
      workspaces.getProject(projectId);
      return json(database.snapshot().compileRecords.filter((record) => record.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null);
    }),
    route("POST", "/api/projects/:projectId/compile", async (_request, params) => json(await latexCompiler.compile(required(params, "projectId")))),
    route("POST", "/api/projects/:projectId/compile-results", async (request, params) => {
      const projectId = required(params, "projectId");
      const project = workspaces.getProject(projectId);
      const body = await readJson<{ projectVersion: number; status: "success" | "error"; summary: string }>(request);
      if (!Number.isInteger(body.projectVersion) || body.projectVersion < 1 || body.projectVersion > project.version || !new Set(["success", "error"]).has(body.status)) throw new ApiError(400, "compile_result_invalid", "Compile result does not match a valid project version");
      const record = { id: `compile_${crypto.randomUUID()}`, projectId, projectVersion: body.projectVersion, status: body.status, summary: String(body.summary ?? "").slice(0, 500), createdAt: new Date().toISOString() } as const;
      return json(await database.mutate((state) => {
        state.compileRecords.push(record);
        const auditedRuns = new Set<string>();
        for (const resolution of state.issueResolutions.filter((candidate) => candidate.projectId === projectId && candidate.acceptedProjectVersion === body.projectVersion && new Set(["in-revision", "needs-review"]).has(candidate.status))) {
          resolution.compileRecordId = record.id;
          resolution.status = record.status === "success" ? "needs-review" : "in-revision";
          resolution.updatedAt = record.createdAt;
          for (const report of state.reviewReports) for (const issue of report.issues) if (resolution.issueIds.includes(issue.id)) {
            issue.status = "in_revision";
            issue.updatedAt = record.createdAt;
          }
          auditedRuns.add(resolution.agentRunId);
        }
        for (const plan of state.agentTaskPlans.filter((candidate) => candidate.projectId === projectId && candidate.acceptedProjectVersion === body.projectVersion)) {
          plan.compileRecordId = record.id;
          plan.updatedAt = record.createdAt;
          auditedRuns.add(plan.agentRunId);
        }
        for (const runId of auditedRuns) {
          const run = state.agentRuns.find((candidate) => candidate.id === runId);
          if (run) { run.auditTrail ??= []; run.auditTrail.push({ id: `audit_${crypto.randomUUID()}`, action: "compile", summary: `Browser WASM compile ${record.status} for project version ${record.projectVersion}`, createdAt: record.createdAt }); run.updatedAt = record.createdAt; }
        }
        return record;
      }), 201);
    }),
    route("GET", "/api/projects/:projectId/change-sets/:changeSetId", async (_request, params) => {
      const projectId = required(params, "projectId");
      const changeSet = database.snapshot().changeSets.find((candidate) => candidate.projectId === projectId && candidate.id === required(params, "changeSetId"));
      if (!changeSet) throw new ApiError(404, "changeset_not_found", "Change set not found");
      return json(normalizePlaceholderFindings(changeSet));
    }),
    route("PATCH", "/api/projects/:projectId/change-sets/:changeSetId", async (request, params) => {
      return json(await revisions.editProposal(required(params, "projectId"), required(params, "changeSetId"), await readJson<ChangeSetEditRequest>(request)));
    }),
    route("POST", "/api/projects/:projectId/change-sets/:changeSetId/accept", async (_request, params) => {
      return json(await revisions.accept(required(params, "projectId"), required(params, "changeSetId")));
    }),
    route("POST", "/api/projects/:projectId/change-sets/:changeSetId/decide", async (request, params) => {
      return json(await revisions.decide(required(params, "projectId"), required(params, "changeSetId"), await readJson<ChangeSetDecisionRequest>(request)));
    }),
    route("POST", "/api/projects/:projectId/change-sets/:changeSetId/finish", async (_request, params) => {
      return json(await revisions.finishReview(required(params, "projectId"), required(params, "changeSetId")));
    }),
    route("POST", "/api/projects/:projectId/change-sets/:changeSetId/reject", async (_request, params) => {
      return json(await revisions.reject(required(params, "projectId"), required(params, "changeSetId")));
    }),
    route("POST", "/api/projects/:projectId/change-sets/:changeSetId/rollback", async (_request, params) => {
      return json(await revisions.rollback(required(params, "projectId"), required(params, "changeSetId")));
    }),
    route("POST", "/api/upload-sessions", async (request) => {
      const body = await readJson<{
        projectName: string;
        mainDocument: string;
        venue: TargetVenue;
        publicationTarget?: PublicationTarget;
        sourceName: string;
        entries: UploadManifestEntry[];
      }>(request);
      return json(await uploads.create(body), 201);
    }),
    route("GET", "/api/upload-sessions/:uploadId", async (_request, params) => json(uploads.get(required(params, "uploadId")))),
    route("PUT", "/api/upload-sessions/:uploadId/files", async (request, params, url) => {
      return json(await uploads.uploadFile(required(params, "uploadId"), requiredQuery(url, "path"), await request.arrayBuffer()));
    }),
    route("POST", "/api/upload-sessions/:uploadId/complete", async (_request, params) => {
      return json(await uploads.complete(required(params, "uploadId")), 201);
    }),
    route("DELETE", "/api/upload-sessions/:uploadId", async (_request, params) => {
      await uploads.cancel(required(params, "uploadId"));
      return new Response(null, { status: 204 });
    }),
    route("POST", "/api/project-imports/github", async (request) => {
      const body = await readJson<GithubImportRequest>(request);
      return json(await github.import(body), 201);
    })
  ];
}

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const pattern = path
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        keys.push(segment.slice(1));
        return "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { method, pattern: new RegExp(`^${pattern}/?$`), keys, handler };
}

function required(params: Record<string, string>, key: string): string {
  const value = params[key];
  if (!value) throw new ApiError(400, "missing_parameter", `Missing route parameter '${key}'`);
  return value;
}

function requiredQuery(url: URL, key: string): string {
  const value = url.searchParams.get(key);
  if (!value) throw new ApiError(400, "missing_parameter", `Missing query parameter '${key}'`);
  return value;
}

async function serveWeb(pathname: string): Promise<Response> {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const candidate = join(config.webDirectory, requested);
  if (existsSync(candidate) && (await stat(candidate)).isFile()) {
    const headers: Record<string, string> = { "content-type": mimeType(extname(candidate)) };
    if (/^bundles\//.test(requested) || /^(?:busytex\.wasm|worker\.js)$/.test(requested)) headers["cache-control"] = "public, max-age=3600";
    return new Response(Bun.file(candidate), { headers });
  }
  const embedded = embeddedWebFile(requested);
  if (embedded) return new Response(embedded, { headers: webHeaders(requested) });
  const index = join(config.webDirectory, "index.html");
  if (existsSync(index)) return new Response(Bun.file(index), { headers: { "content-type": "text/html; charset=utf-8" } });
  const embeddedIndex = embeddedWebFile("index.html");
  if (embeddedIndex) return new Response(embeddedIndex, { headers: { "content-type": "text/html; charset=utf-8" } });
  return json({ error: { code: "web_not_built", message: "Web client is not built. Run the development server or build the project." } }, 404);
}

function webHeaders(path: string): Record<string, string> {
  const headers: Record<string, string> = { "content-type": mimeType(extname(path)) };
  if (/^bundles\//.test(path) || /^(?:busytex\.wasm|worker\.js)$/.test(path)) headers["cache-control"] = "public, max-age=3600";
  return headers;
}

export function mimeType(extension: string): string {
  return ({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".woff2": "font/woff2",
    ".wasm": "application/wasm"
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}
