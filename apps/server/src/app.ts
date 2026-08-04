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
  TargetVenue,
  UploadManifestEntry
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
import { embeddedWebFile } from "./embedded-web";
import { config, type AgentProviderConfiguration } from "./config";
import { GithubService } from "./imports/github-service";
import { UploadService } from "./imports/upload-service";
import { GithubSyncService } from "./sync/github-sync-service";
import { ApiError, errorResponse, json, readJson, withRuntimeHeaders } from "./http";
import { JsonDatabase } from "./storage/database";
import { WorkspaceService } from "./workspace/workspace-service";

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
  return configuration.apiKey ? new OpenAIAgentProvider(configuration.apiKey, configuration.model, configuration.baseURL) : undefined;
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
  const providers = {
    completion: defaultProvider ?? providerFor(config.agentProviders.completion),
    agent: defaultProvider ?? providerFor(config.agentProviders.agent),
    revise: defaultProvider ?? providerFor(config.agentProviders.revise),
    review: defaultProvider ?? providerFor(config.agentProviders.review),
    memory: defaultProvider ?? providerFor(config.agentProviders.memory)
  };
  const memories = new MemoryService(database, workspaces, new SkillRegistry(config.skillsDirectory), providers.memory);
  const revisions = new ReviseService(database, workspaces, new SkillRegistry(config.skillsDirectory), providers.revise, memories);
  const drafts = new DraftService(database, workspaces, new SkillRegistry(config.skillsDirectory), providers.agent);
  const reviews = new ReviewService(database, workspaces, new SkillRegistry(config.skillsDirectory), providers.review);
  const agentTasks = new AgentTaskService(database, workspaces, new SkillRegistry(config.skillsDirectory), providers.agent, memories, providers.review);
  const completions = new CompletionService(workspaces, new SkillRegistry(config.skillsDirectory), providers.completion, memories);
  const services: Services = { database, workspaces, uploads, github: new GithubService(dataDirectory, workspaces), githubSync: new GithubSyncService(dataDirectory, database, workspaces), revisions, drafts, reviews, memories, agentTasks, completions, texPackages, latexCompiler: new LatexCompileService(dataDirectory, workspaces) };
  const routes = buildRoutes(services);

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

function buildRoutes({ database, workspaces, uploads, github, githubSync, revisions, drafts, reviews, memories, agentTasks, completions, texPackages, latexCompiler }: Services): Route[] {
  return [
    route("GET", "/api/health", async () => json({ status: "ok" })),
    route("GET", "/api/texlive/:packageName", async (_request, params, url) => texPackages.texLiveArchive(required(params, "packageName"), url.searchParams.get("tlYear"))),
    route("GET", "/api/fetch/:packageName", async (_request, params, url) => texPackages.ctanPackage(required(params, "packageName"), url.searchParams.get("tlYear"))),
    route("GET", "/api/ctan-pkg/:packageName", async (_request, params) => texPackages.ctanPackageInfo(required(params, "packageName"))),
    route("GET", "/api/projects", async () => json(workspaces.listProjects())),
    route("POST", "/api/projects", async (request) => {
      const body = await readJson<CreateProjectRequest>(request);
      return json(await workspaces.createEmpty(body.name, body.mainDocument, body.venue), 201);
    }),
    route("GET", "/api/projects/:projectId", async (_request, params) => json(workspaces.getProject(required(params, "projectId")))),
    route("PATCH", "/api/projects/:projectId", async (request, params) => {
      const body = await readJson<{ name?: string; mainDocument?: string; venue?: TargetVenue }>(request);
      return json(await workspaces.updateProject(required(params, "projectId"), body));
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
      const body = await readJson<{ sourceOnly?: boolean }>(request);
      return json(await reviews.run(required(params, "projectId"), body.sourceOnly === true, request.signal), 201);
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
      return json(changeSet);
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
