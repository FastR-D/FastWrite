import { existsSync } from "node:fs";
import { timingSafeEqual, createHash, randomBytes } from "node:crypto";
import { DiagramService } from "./diagrams/service";
import { diagramProvider } from "./diagrams/provider";
import { diagramPrompt, diagramSchema } from "./diagrams/scene";
import { renderDrawio, renderPptx, renderSvg } from "./diagrams/render";
import { stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type {
  CollaborationPersistRequest,
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
  UploadManifestEntry,
  WorkspaceTreeNode,
  OutlineItem,
  PaperClaim,
  ReviewReport,
  SourceEvidence,
  EvidenceCockpit, CitationReviewer
  ,AgentWireApi
} from "@fastwrite/shared";
import type { AgentProvider } from "./agent/provider";
import { asGateway } from "./agent/agent-gateway";
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
import { config, discoverHarnessConfiguration, type AgentProviderConfiguration } from "./config";
import { GithubService } from "./imports/github-service";
import { UploadService } from "./imports/upload-service";
import { GithubSyncService } from "./sync/github-sync-service";
import { ApiError, errorResponse, json, readJson, withRuntimeHeaders } from "./http";
import { JsonDatabase } from "./storage/database";
import { WorkspaceService } from "./workspace/workspace-service";
import { ProjectSearchService } from "./workspace/project-search-service";
import { LatexTemplateService } from "./templates/latex-template-service";
import { ResearchService } from "./research/research-service";
import { ClaimService } from "./claims/claim-service";
import { AlignmentService } from "./alignment/alignment-service";
import { writingGuardMany } from "./writing/writing-guard";
import { deriveArgumentGraph } from "./claims/argument-graph";
import { buildAdversarialMemo } from "./claims/adversarial-memo";
import { normalizePlaceholderFindings } from "./agent/citation-findings";
import { normalizeWorkspacePath } from "@fastwrite/shared";
import { HarnessRegistry, McpRegistry, type McpServerDefinition } from "@fastwrite/harness-core";
import { CodexHarnessAdapter } from "@fastwrite/harness-codex";
import { ClaudeHarnessAdapter } from "@fastwrite/harness-claude";
import { HarnessRunService } from "./agent/harness-run-service";
import { HarnessSessionService } from "./agent/harness-session-service";
import { McpToolService } from "./agent/mcp-tool-service";
import type { HarnessAdapter, HarnessEvent } from "@fastwrite/harness-core";
import { AuthService, requireAdminReadRole, requireRole, type AuthResult, type Principal } from "./auth/auth-service";
import { AuthorizationService, type ProjectAction } from "./auth/authorization-service";
import { TeamService } from "./teams/team-service";
import { HarnessProfileService } from "./harness/profile-service";
import { CollaborationService } from "./collaboration/collaboration-service";
import { CommentService } from "./comments/comment-service";
import { CasIdentityProvider, OidcIdentityProvider, type IdentityProvider } from "./auth/identity-provider";
import { FastCASService, type FastCASConfiguration } from "./auth/fastcas-service";
import { FastCASError } from "@fastrd/fastcas/server";
import { MailDeliveryService, SmtpMailTransport, type MailTransport } from "./notifications/mail-delivery-service";
import { InProcessJobQueue, type JobRecord, type JobStore } from "./jobs/job-queue";
import { InMemoryCollaborationBus, RedisCollaborationBus, type CollaborationBus } from "./collaboration/collaboration-bus";
import { adapterCapabilities, ExternalResearchAdapters, type ExternalAdapterKind } from "./research/external-adapters";
import { ExperimentRunner } from "./experiments/experiment-runner";
import { BackupService } from "./storage/backup-service";
import { LocalObjectStore, createS3ObjectStore, type ObjectStore } from "./storage/object-storage";
import { LocalModelProvider } from "./agent/local-model-provider";
import { createNotification } from "./notifications/notification-service";
import { MetricsRegistry } from "./metrics";

const PROJECT_ACTIONS: ProjectAction[] = ["project:read", "project:write", "project:invite", "project:manage", "comment:write", "compile:run", "review:run", "agent:propose", "changeset:approve", "harness:use", "github:sync"];

interface Services {
  diagrams: DiagramService;
  database: JsonDatabase;
  workspaces: WorkspaceService;
  projectSearch: ProjectSearchService;
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
  harnessRegistry: HarnessRegistry;
  mcpRegistry: McpRegistry;
  harnessRuns: HarnessRunService;
  harnessSessions: HarnessSessionService;
  mcpTools: McpToolService;
  auth: AuthService;
  authorization: AuthorizationService;
  teams: TeamService;
  harnessProfiles: HarnessProfileService;
  collaboration: CollaborationService;
  comments: CommentService;
  mailDelivery: MailDeliveryService;
  externalAdapters: ExternalResearchAdapters;
  jobs: InProcessJobQueue;
  experiments: ExperimentRunner;
  backups: BackupService;
}

type Handler = (request: Request, params: Record<string, string>, url: URL) => Promise<Response> | Response;
export type ApplicationFetch = ((request: Request) => Promise<Response>) & { dispatchMail(): Promise<void>; onAuthChange?(listener: () => void): () => void };

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export interface ApplicationOptions {
  agentProvider?: AgentProvider;
  texPackages?: TexPackageProvider;
  features?: Partial<typeof config.features>;
  oidcProvider?: IdentityProvider;
  casProvider?: IdentityProvider;
  fastcasConfiguration?: FastCASConfiguration;
  mailTransport?: MailTransport;
  researchFetcher?: (input: string | Request | URL, init?: RequestInit) => Promise<Response>;
  metrics?: MetricsRegistry;
  collaborationBus?: CollaborationBus;
  postgresRepository?: import("./storage/repository").PostgresRepository;
}

function providerFor(configuration: AgentProviderConfiguration): AgentProvider | undefined {
  if (!configuration.baseURL || !configuration.model) return undefined;
  return new LocalModelProvider({ endpoint: configuration.baseURL, model: configuration.model });
}

function createRedisCollaborationBus(url: string): CollaborationBus {
  // The dependency is optional for local/offline deployments. Production
  // multi-node mode must install `redis` and provide a reachable endpoint.
  let clientModule: { createClient: (options: { url: string }) => any };
  try {
    clientModule = require("redis") as typeof clientModule;
  } catch {
    throw new ApiError(503, "redis_client_unavailable", "Install the redis client before enabling multi-node collaboration");
  }
  const publisher = clientModule.createClient({ url });
  const subscriber = publisher.duplicate();
  const ready = Promise.all([publisher.connect(), subscriber.connect()]);
  return new RedisCollaborationBus(
    { publish: async (channel, message) => { await ready; return publisher.publish(channel, message); } },
    { subscribe: async (channel, listener) => { await ready; return subscriber.subscribe(channel, listener); }, unsubscribe: async (channel) => { await ready; return subscriber.unsubscribe(channel); } }
  );
}

function providerForHarnessProfile(profile: { provider: string; baseUrl?: string; model?: string }): AgentProvider | undefined {
  if (profile.provider === "openai-compatible" && profile.baseUrl && profile.model) return new LocalModelProvider({ endpoint: profile.baseUrl, model: profile.model });
  return undefined;
}

interface AgentSettingsInput {
  harness?: "claude" | "codex";
  apiKey?: string;
  baseURL?: string;
  model?: string;
  wireAPI?: AgentWireApi;
}

function boundedSetting(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maximum) : undefined;
}

function harnessAdapter(registry: HarnessRegistry, kind: string) {
  if (kind !== "claude" && kind !== "codex") throw new ApiError(400, "harness_invalid", "Unsupported Harness");
  const adapter = registry.get(kind);
  if (!adapter) throw new ApiError(503, "harness_unavailable", `Harness '${kind}' is not configured`);
  return adapter;
}

function defaultMcpServers(): McpServerDefinition[] {
  return [
    { id: "workspace", name: "FastWrite Workspace", version: "1.0.0", enabled: true, tools: [
      { name: "read", description: "Read a workspace file", inputSchema: { type: "object", required: ["path"] } },
      { name: "search", description: "Search workspace text", inputSchema: { type: "object", required: ["query"] } }
    ] },
    { id: "latex", name: "FastWrite LaTeX", version: "1.0.0", enabled: true, tools: [
      { name: "compile", description: "Compile the current paper", inputSchema: { type: "object", required: [] } }
    ] }
  ];
}

function runtimeAgentProvider(getProvider: () => AgentProvider | undefined): AgentProvider {
  return new Proxy({}, {
    get(_target, property) {
      if (property === "then") return undefined;
      const current = getProvider();
      const method = current?.[property as keyof AgentProvider];
      if (typeof method === "function" || property === "revise") return (...args: unknown[]) => {
        const provider = getProvider();
        const activeMethod = provider?.[property as keyof AgentProvider];
        if (typeof activeMethod !== "function") throw new ApiError(503, "agent_not_configured", "Add an API key in Project settings to enable Agent tasks");
        return (activeMethod as (...parameters: unknown[]) => unknown).apply(provider, args);
      };
      return undefined;
    }
  }) as AgentProvider;
}

function harnessProvider(runs: HarnessRunService, kind: "codex" | "claude", cwd: string, model?: string): AgentProvider {
  const request = async (method: string, input: unknown, signal?: AbortSignal): Promise<any> => {
    const adapter = runs.adapter(kind);
    if (!adapter) throw new ApiError(503, "harness_unavailable", `Harness '${kind}' is unavailable`);
    const session = await adapter.createSession({ cwd, title: `FastWrite ${method}` });
    const schema = method === "generateDiagram" ? JSON.stringify(diagramSchema) : method === "planAgentTask" ? '{"steps":[string],"affectedFiles":[string],"risks":[string],"validation":[string]}' : method === "generateAgentTask" ? '{"files":[{"path":string,"content":string,"rationale":string}]}' : method === "planDraft" ? '{"outline":[{"path":string,"title":string,"purpose":string}]}' : method === "generateDraft" ? '{"files":[{"path":string,"content":string,"rationale":string}]}' : method === "revise" ? '{"replacement":string,"rationale":string}' : method === "complete" ? '{"suggestion":string}' : '{"result":object}';
    const scoped = typeof input === "object" && input !== null && "scope" in input && (input as { scope?: { type?: string; section?: unknown } }).scope?.type === "section";
    const responseLanguage = typeof input === "object" && input !== null && "responseLanguage" in input ? (input as { responseLanguage?: string }).responseLanguage : undefined;
    const languageRule = responseLanguage === "zh-CN" ? "Respond to the user-facing explanation in Simplified Chinese; do not translate or change manuscript text unless the task explicitly requests it." : responseLanguage === "en-US" ? "Respond to the user-facing explanation in English; do not change manuscript text language unless the task explicitly requests it." : "Use the user's language for explanations when clear, while preserving the manuscript language requested by the task.";
    const outputRule = scoped ? "For section-scoped execution, return only the requested section replacement in the target file; preserve every line outside the section and never return a whole-file rewrite." : "For file generation, content must be complete compilable LaTeX prose for the requested paper, with abstract, introduction, threat model, method, evaluation plan, and limitations as applicable.";
    const content = method === "generateDiagram" ? `${diagramPrompt}\nSchema: ${schema}\nInput: ${JSON.stringify(input)}` : `You are a structured academic writing engine. Execute operation '${method}'. Return ONLY one valid JSON object matching this exact schema: ${schema}. Do not echo the prompt. ${languageRule} ${outputRule} Never emit TODO, FIXME, placeholder brackets, template markers, or empty sections; if evidence is missing, state a concrete evaluation plan without claiming results. Input:\n${JSON.stringify(input)}`;
    const chunks: string[] = [];
    for await (const event of runs.send({ kind, session, content, ...(method === "generateDiagram" ? { model: "gpt-6-astra" } : model ? { model } : {}), ...(signal ? { signal } : {}) })) { if (event.type === "assistant.delta") chunks.push(event.text); if (event.type === "run.failed") throw new Error(event.error); }
    const text = chunks.join("").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    try { return JSON.parse(text); } catch {
      const candidates: string[] = []; let depth = 0; let start = -1; let quoted = false; let escaped = false;
      for (let index = 0; index < text.length; index++) { const character = text[index]!; if (quoted) { if (escaped) escaped = false; else if (character === "\\") escaped = true; else if (character === '"') quoted = false; continue; } if (character === '"') { quoted = true; continue; } if (character === "{") { if (depth === 0) start = index; depth++; } else if (character === "}" && depth > 0) { depth--; if (depth === 0 && start >= 0) candidates.push(text.slice(start, index + 1)); } }
      for (const candidate of candidates.reverse()) { try { return JSON.parse(candidate); } catch { /* try an earlier complete object */ } }
      const truncated = text.length > 0 && !text.endsWith("}");
      throw new ApiError(502, truncated ? "harness_response_truncated" : "harness_response_invalid", `Harness returned ${truncated ? "truncated" : "invalid"} JSON for ${method}`);
    }
  };
  return new Proxy({} as AgentProvider, { get: (_target, property) => property === "fileGenerationConcurrency" ? () => 1 : (input: unknown, signal?: AbortSignal) => request(String(property), input, signal) });
}

export async function createApplication(dataDirectory = config.dataDirectory, options: ApplicationOptions = {}) {
  const metrics = options.metrics ?? new MetricsRegistry();
  const features = { ...config.features, ...options.features };
  const database = new JsonDatabase(dataDirectory);
  await database.initialize();
  const autoPostgres = options.postgresRepository ?? await configuredPostgresRepository(database.snapshot());
  const postgresCutover = process.env.FASTWRITE_POSTGRES_MODE === "cutover";
  if (autoPostgres) {
    const persisted = await autoPostgres.loadPersistedState();
    if (persisted && postgresCutover) await database.replaceState(persisted);
  }
  const postgresMirror = autoPostgres;
  if (postgresCutover && postgresMirror) database.setPrimaryPersistence(async snapshot => { await postgresMirror.mutate(state => Object.assign(state, snapshot)); });
  let postgresMirrorError: string | undefined;
  let postgresMirrorFailures = 0;
  const persistToPostgres = async () => {
    if (!postgresMirror) return;
    const snapshot = database.snapshot();
    try {
      await postgresMirror.mutate((state) => Object.assign(state, snapshot));
      postgresMirrorError = undefined;
    } catch (error) {
      postgresMirrorFailures += 1;
      postgresMirrorError = error instanceof Error ? error.message.slice(0, 500) : "postgres_mirror_failed";
      console.error(`FastWrite PostgreSQL mirror failed (${postgresMirrorFailures}): ${postgresMirrorError}`);
    }
  };
  if (postgresCutover && postgresMirror) await persistToPostgres();
  const comparePostgres = async () => postgresMirror && "dualReadCompare" in postgresMirror ? await (postgresMirror as import("./storage/postgres-repository").SqlPostgresRepository).dualReadCompare() : { equal: true, legacyHash: "", normalizedHash: "", mismatches: [] as string[] };
  const auth = new AuthService(database, config.collaborationRoomTokenSecret);
  const bootstrapRequested = config.features.serverAuth || process.env.FASTWRITE_BOOTSTRAP_ADMIN_EMAIL || process.env.FASTWRITE_BOOTSTRAP_ADMIN_PASSWORD;
  if (bootstrapRequested) {
    const bootstrapCreated = await auth.ensureBootstrapAdmin(config.bootstrapAdmin);
    if (bootstrapCreated) console.warn(`FastWrite bootstrap admin created: ${config.bootstrapAdmin.email} (change FASTWRITE_BOOTSTRAP_ADMIN_PASSWORD after first login)`);
  }
  const oidc = options.oidcProvider ?? (config.oidc ? new OidcIdentityProvider(config.oidc) : undefined);
  const cas = options.casProvider ?? (config.cas ? new CasIdentityProvider(config.cas) : undefined);
  const fastcasConfiguration = options.fastcasConfiguration ?? config.fastcas;
  const fastcas = fastcasConfiguration ? new FastCASService(fastcasConfiguration, database, auth) : undefined;
  const authorization = new AuthorizationService(database);
  const teams = new TeamService(database, authorization);
  const harnessProfiles = new HarnessProfileService(database, authorization);
  const workspaces = new WorkspaceService(dataDirectory, database);
  await workspaces.initialize();
  const collaborationBus: CollaborationBus = options.collaborationBus ?? (features.multiNodeCollaboration && config.redisUrl
    ? createRedisCollaborationBus(config.redisUrl)
    : new InMemoryCollaborationBus());
  const collaboration = new CollaborationService(database, workspaces, collaborationBus, postgresMirror && "appendUpdate" in postgresMirror && "saveSnapshot" in postgresMirror && "load" in postgresMirror ? postgresMirror as import("./collaboration/collaboration-bus").CollaborationPersistence : undefined);
  const stopCollaborationBus = await collaboration.subscribeBus();
  const comments = new CommentService(database, collaboration, authorization);
  const mailDelivery = new MailDeliveryService(database, options.mailTransport ?? (config.mail ? new SmtpMailTransport(config.mail.smtpUrl, config.mail.from) : undefined));
  const uploads = new UploadService(dataDirectory, database, workspaces);
  await uploads.initialize();
  const texPackages = options.texPackages ?? new TexPackageService(dataDirectory);
  await texPackages.initialize();
  const defaultProvider = options.agentProvider;
  const configuredProviders = defaultProvider ? { completion: defaultProvider, agent: defaultProvider, revise: defaultProvider, review: defaultProvider, memory: defaultProvider } : undefined;
  let runtimeConfiguration: AgentProviderConfiguration | undefined;
  let runtimeProvider: AgentProvider | undefined;
  const configureAgent = (input: AgentSettingsInput) => {
    const apiKey = boundedSetting(input.apiKey, 1_024);
    if (!apiKey) throw new ApiError(400, "agent_api_key_required", "Enter an API key to enable Agent tasks");
    const baseURL = boundedSetting(input.baseURL, 2_048);
    if (baseURL) {
      try { new URL(baseURL); } catch { throw new ApiError(400, "agent_base_url_invalid", "Base URL must be a valid absolute URL"); }
    }
    if (input.wireAPI !== undefined && input.wireAPI !== "chat" && input.wireAPI !== "responses") throw new ApiError(400, "agent_wire_api_invalid", "Wire API must be 'chat' or 'responses'");
    runtimeConfiguration = { apiKey, ...(baseURL ? { baseURL } : {}), ...(boundedSetting(input.model, 256) ? { model: boundedSetting(input.model, 256) } : {}), wireAPI: input.wireAPI ?? (baseURL ? "chat" : "responses") };
    if (input.harness && input.harness !== config.harness) throw new ApiError(400, "harness_runtime_switch_unsupported", "Restart the server to switch Harness implementations");
    runtimeProvider = providerFor(runtimeConfiguration);
  };
  const skillRegistry = new SkillRegistry(config.skillsDirectory, database);
  const harnessRegistry = new HarnessRegistry();
  harnessRegistry.register(new CodexHarnessAdapter());
  harnessRegistry.register(new ClaudeHarnessAdapter());
  const mcpRegistry = new McpRegistry();
  for (const server of defaultMcpServers()) mcpRegistry.register(server);
  const harnessRuns = new HarnessRunService(harnessRegistry, database);
  const harnessProviderInstance = harnessProvider(harnessRuns, config.harness, process.cwd(), config.harnessModel);
  const providers = configuredProviders ?? { completion: harnessProviderInstance, agent: harnessProviderInstance, revise: harnessProviderInstance, review: harnessProviderInstance, memory: harnessProviderInstance };
  const harnessSessions = new HarnessSessionService(database);
  const latexCompiler = new LatexCompileService(dataDirectory, workspaces, { mode: process.env.FASTWRITE_COMPILE_SANDBOX === "bubblewrap" ? "bubblewrap" : "host" });
  const mcpTools = new McpToolService(mcpRegistry, workspaces, latexCompiler, database);
  const latexTemplates = new LatexTemplateService(dataDirectory, fetch, config.templateDirectory);
  const memories = new MemoryService(database, workspaces, skillRegistry, asGateway(providers.memory));
  const revisions = new ReviseService(database, workspaces, skillRegistry, asGateway(providers.revise), memories);
  const drafts = new DraftService(database, workspaces, skillRegistry, asGateway(providers.agent));
  const reviews = new ReviewService(database, workspaces, skillRegistry, asGateway(providers.review));
  const compliance = new ComplianceService(workspaces, skillRegistry);
  const research = new ResearchService(database, workspaces, options.researchFetcher ?? fetch);
  const externalAdapters = new ExternalResearchAdapters(options.researchFetcher ?? fetch);
  const jobStore: JobStore = {
    load: () => database.snapshot().jobs,
    save: async (job) => { await database.mutate((state) => { const index = state.jobs.findIndex((candidate) => candidate.id === job.id); if (index >= 0) state.jobs[index] = job; else state.jobs.push(job); }); await persistToPostgres(); },
    remove: async (id) => { await database.mutate((state) => { state.jobs = state.jobs.filter((candidate) => candidate.id !== id); }); await persistToPostgres(); }
  };
  const jobs = new InProcessJobQueue({ store: jobStore, limits: { total: Number(process.env.FASTWRITE_JOB_MAX_ACTIVE ?? 32), byKind: { "latex.compile": Number(process.env.FASTWRITE_COMPILE_MAX_ACTIVE ?? 4), "experiment.run": Number(process.env.FASTWRITE_EXPERIMENT_MAX_ACTIVE ?? 2) } } });
  const experiments = new ExperimentRunner(dataDirectory, workspaces);
  const objectStore: ObjectStore = config.objectStore ? await createS3ObjectStore(config.objectStore).catch(() => new LocalObjectStore(join(dataDirectory, "objects"))) : new LocalObjectStore(join(dataDirectory, "objects"));
  const backups = new BackupService(database, dataDirectory, objectStore);
  const jobPruneTimer = setInterval(() => { jobs.requeueExpiredLeases(); jobs.prune(); }, 15 * 60_000);
  jobPruneTimer.unref?.();
  for (const persistedJob of jobs.list("latex.compile").filter((job) => job.status === "queued" && process.env.FASTWRITE_JOB_WORKER_MODE !== "external")) {
    jobs.start(persistedJob.id, async (input) => {
      const projectId = (input as { projectId: string }).projectId;
      const persisted = jobs.get(persistedJob.id); const actorId = persisted?.policy?.actorUserId; if (actorId) { const actor = database.snapshot().users.find((user) => user.id === actorId); if (!actor || actor.status !== "active") throw new ApiError(403, "job_actor_revoked", "The job owner is no longer active"); }
      return latexCompiler.compile(projectId);
    });
  }
  const claims = new ClaimService(database, workspaces);
  const alignment = new AlignmentService(workspaces);
  const agentTasks = new AgentTaskService(database, workspaces, skillRegistry, asGateway(providers.agent), memories, asGateway(providers.review), compliance);
  const completions = new CompletionService(workspaces, skillRegistry, asGateway(providers.completion), memories);
  const diagrams = new DiagramService(dataDirectory, options.agentProvider?.generateDiagram ? options.agentProvider : diagramProvider(dataDirectory));
  await diagrams.initialize();
  const services: Services = { diagrams, database, workspaces, projectSearch: new ProjectSearchService(workspaces, authorization), uploads, github: new GithubService(dataDirectory, workspaces), githubSync: new GithubSyncService(dataDirectory, database, workspaces), revisions, drafts, reviews, memories, agentTasks, completions, texPackages, latexCompiler, skillRegistry, compliance, latexTemplates, research, claims, alignment, harnessRegistry, mcpRegistry, harnessRuns, harnessSessions, mcpTools, auth, authorization, teams, harnessProfiles, collaboration, comments, mailDelivery, externalAdapters, jobs, experiments, backups };
  const routes = buildRoutes(services, {
    status: () => {
      const activeConfiguration = runtimeConfiguration ?? config.agentProviders.agent;
      const discovered = discoverHarnessConfiguration(config.harness);
      return { configured: Boolean(runtimeConfiguration ?? runtimeProvider ?? providers.agent) || discovered.configured, harness: config.harness, source: runtimeConfiguration || runtimeProvider ? "runtime" : providers.agent ? "environment" : "none", ...(activeConfiguration.baseURL ? { baseURL: activeConfiguration.baseURL } : discovered.baseURL ? { baseURL: discovered.baseURL } : {}), ...(activeConfiguration.model ? { model: activeConfiguration.model } : discovered.model ? { model: discovered.model } : {}), wireAPI: activeConfiguration.wireAPI ?? (activeConfiguration.baseURL ? "chat" : "responses") };
    },
    configure: configureAgent,
    postgresMirror: () => ({ configured: Boolean(postgresMirror), healthy: Boolean(postgresMirror) && !postgresMirrorError, failures: postgresMirrorFailures, ...(postgresMirrorError ? { lastError: postgresMirrorError } : {}) }),
    postgresCompare: comparePostgres
  }, features.serverAuth, oidc, cas, metrics, fastcas);

  const applicationFetch: ApplicationFetch = async function applicationFetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) {
        const route = routes.find((candidate) => candidate.method === request.method && candidate.pattern.test(url.pathname));
        if (!route) throw new ApiError(404, "route_not_found", "API route not found");
        const match = url.pathname.match(route.pattern)!;
        const params = Object.fromEntries(route.keys.map((key, index) => [key, decodeURIComponent(match[index + 1] ?? "")]));
        if (features.serverAuth && params.projectId && !url.pathname.endsWith("/invitations") && !url.pathname.includes("/access-requests") && !pathAuthorizesIndividually(url.pathname)) {
          const current = auth.principal(request)!;
          authorization.requireProject(current, params.projectId, projectActionFor(url.pathname, request.method));
        }
        const response = withRuntimeHeaders(await route.handler(request, params, url));
        if (!postgresCutover) await persistToPostgres();
        metrics.observe(request.method, url.pathname, response.status);
        void mailDelivery.dispatchPending();
        return response;
      }
      const response = withRuntimeHeaders(await serveWeb(url.pathname));
      metrics.observe(request.method, url.pathname, response.status);
      return response;
    } catch (error) {
      const response = withRuntimeHeaders(errorResponse(error instanceof FastCASError ? new ApiError(error.status, error.code, error.message) : error));
      metrics.observe(request.method, new URL(request.url).pathname, response.status);
      return response;
    }
  };
  void stopCollaborationBus;
  applicationFetch.dispatchMail = () => mailDelivery.dispatchPending();
  applicationFetch.onAuthChange = listener => fastcas?.onRevocation(listener) ?? (() => {});
  return applicationFetch;
}

async function configuredPostgresRepository(initialState: import("./storage/database").DatabaseState): Promise<import("./storage/repository").PostgresRepository | undefined> {
  if (!config.postgresUrl || !["mirror", "cutover"].includes(process.env.FASTWRITE_POSTGRES_MODE ?? "")) return undefined;
  try {
    const pg = await import("pg" as string) as any;
    const client = new pg.Client({ connectionString: config.postgresUrl });
    await client.connect();
    const { SqlPostgresRepository } = await import("./storage/postgres-repository");
    return SqlPostgresRepository.connect(client, initialState);
  } catch (error) {
    if (process.env.FASTWRITE_POSTGRES_REQUIRED === "true") throw error;
    return undefined;
  }
}

function projectActionFor(pathname: string, method: string): ProjectAction {
  if (/\/shares(?:\/|$)/.test(pathname)) return "project:manage";
  if (method === "GET") return "project:read";
  if ((method === "DELETE" || method === "PATCH") && /^\/api\/projects\/[^/]+$/.test(pathname)) return "project:manage";
  if (/\/comments(?:\/|$)/.test(pathname)) return "comment:write";
  if (/\/compile(?:-|$)/.test(pathname)) return "compile:run";
  if (/\/reviews(?:\/|$)|\/review-issues(?:\/|$)/.test(pathname)) return "review:run";
  if (/\/(agent-tasks|revisions|drafts|completions)(?:\/|$)/.test(pathname)) return "agent:propose";
  if (/\/change-sets(?:\/|$)/.test(pathname)) return "changeset:approve";
  if (/\/github-sync(?:\/|$)/.test(pathname)) return "github:sync";
  if (/\/mcp\/call$/.test(pathname)) return "harness:use";
  return "project:write";
}

function pathAuthorizesIndividually(pathname: string): boolean {
  return /\/api\/projects\/[^/]+\/(?:file|asset|files|assets)$/.test(pathname);
}

function buildRoutes({ diagrams, database, workspaces, projectSearch, uploads, github, githubSync, revisions, drafts, reviews, memories, agentTasks, completions, texPackages, latexCompiler, skillRegistry, compliance, latexTemplates, research, claims, alignment, harnessRegistry, mcpRegistry, harnessRuns, harnessSessions, mcpTools, auth, authorization, teams, harnessProfiles, collaboration, comments, mailDelivery, externalAdapters, jobs, experiments, backups }: Services, agentSettings: { status: () => { configured: boolean; source: "runtime" | "environment" | "none"; baseURL?: string; model?: string; wireAPI: AgentWireApi }; configure: (input: AgentSettingsInput) => void; postgresMirror?: () => { configured: boolean; healthy: boolean; failures: number; lastError?: string }; postgresCompare?: () => Promise<{ equal: boolean; legacyHash: string; normalizedHash: string; mismatches: string[] }> }, authEnabled = config.features.serverAuth, oidc?: IdentityProvider, cas?: IdentityProvider, metrics = new MetricsRegistry(), fastcas?: FastCASService): Route[] {
  const presence = new Map<string, Map<string, { clientId: string; name: string; color?: string; path: string; line?: number; updatedAt: string }>>();
  const principal = (request: Request, required = authEnabled): Principal | undefined => auth.principal(request, required);
  const authorize = (request: Request, projectId: string, action: Parameters<AuthorizationService["requireProject"]>[2]) => {
    const current = principal(request);
    if (current) authorization.requireProject(current, projectId, action);
    return current;
  };
  const assignProjectOwner = async (project: { id: string }, current?: Principal, teamId?: string) => {
    if (!current) return;
    if (teamId) authorization.requireTeamRole(current, teamId, ["owner", "admin"]);
    const timestamp = new Date().toISOString();
    await database.mutate((state) => {
      const stored = state.projects.find((item) => item.id === project.id);
      if (stored) { if (teamId) { stored.teamId = teamId; stored.visibility = "team"; } else { stored.personalOwnerUserId = current.user.id; stored.visibility = "private"; } }
      if (!state.projectMembers.some((item) => item.projectId === project.id && item.userId === current.user.id)) state.projectMembers.push({ projectId: project.id, userId: current.user.id, role: "owner", createdAt: timestamp, updatedAt: timestamp });
      state.auditEvents.push({ id: `audit_${crypto.randomUUID()}`, actorUserId: current.user.id, action: "project.create", resourceType: "project", resourceId: project.id, createdAt: timestamp });
    });
  };
  return [
    route("GET", "/api/health", async () => json({ status: "ok", version: "0.1.0" })),
    route("GET", "/api/metrics", async () => new Response(metrics.prometheus(), { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" } })),
    route("POST", "/api/auth/register", async (request) => { const result = await auth.register(await readJson<{ email: string; password: string; displayName?: string }>(request)); await teams.personalWorkspace({ user: result.user, sessionId: "register" }); return authResponse(result, 201); }),
    route("POST", "/api/auth/login", async (request) => authResponse(await auth.login(await readJson<{ email: string; password: string }>(request)))),
    route("GET", "/api/auth/providers", async () => json({ local: true, oidc: Boolean(oidc), cas: Boolean(cas), fastcas: Boolean(fastcas), fastcasSignup: Boolean(fastcas?.configuration.allowRegistration) })),
    route("GET", "/api/auth/fastcas/signup", async (_request, _params, url) => {
      if (!fastcas) throw new ApiError(404, "fastcas_not_configured", "FastCAS is not configured");
      const signup = await fastcas.beginRegistration(url.searchParams.get("returnTo") ?? "/projects");
      return new Response(null, { status: 302, headers: { location: signup.url.href, "set-cookie": loginBindingCookie("fastcas", signup.binding), "cache-control": "no-store" } });
    }),
    route("GET", "/api/auth/fastcas/login", async (_request, _params, url) => {
      if (!fastcas) throw new ApiError(404, "fastcas_not_configured", "FastCAS is not configured");
      const login = await fastcas.beginLogin(url.searchParams.get("returnTo") ?? "/projects");
      return new Response(null, { status: 302, headers: { location: login.url.href, "set-cookie": loginBindingCookie("fastcas", login.binding), "cache-control": "no-store" } });
    }),
    route("POST", "/api/auth/fastcas/link", async request => {
      requireFastCASOrigin(request);
      if (!fastcas) throw new ApiError(404, "fastcas_not_configured", "FastCAS is not configured");
      const actor = principal(request, true)!;
      const body = await readJson<{ password: string; returnTo?: string }>(request);
      const login = await fastcas.beginLink(actor, body.password, body.returnTo);
      return json({ url: login.url.href }, 200, { "set-cookie": loginBindingCookie("fastcas", login.binding), "cache-control": "no-store" });
    }),
    route("GET", "/api/auth/fastcas/callback", async (request, _params, url) => {
      if (!fastcas) throw new ApiError(404, "fastcas_not_configured", "FastCAS is not configured");
      const finished = await fastcas.callback(url, requestCookie(request, "fastwrite.fastcas.login"), requestCookie(request, "fastwrite.refresh"));
      if (finished.result) await teams.personalWorkspace({ user: finished.result.user, sessionId: "fastcas-login" });
      const target = new URL(finished.returnTo, url.origin);
      target.searchParams.set("fastcas", finished.result ? "complete" : "linked");
      const location = target.pathname + target.search + target.hash;
      return finished.result ? externalAuthCallback("fastcas", finished.result, location) : new Response(null, { status: 302, headers: { location, "set-cookie": expiredLoginBindingCookie("fastcas"), "cache-control": "no-store" } });
    }),
    route("GET", "/api/auth/fastcas/status", async request => json(fastcas ? fastcas.status(principal(request, true)!) : { enabled: false, links: [] })),
    route("POST", "/api/auth/fastcas/local-password", async request => {
      requireFastCASOrigin(request);
      if (!fastcas) throw new ApiError(404, "fastcas_not_configured", "FastCAS is not configured");
      const actor = principal(request, true)!;
      const body = await readJson<{ password: string }>(request);
      return json(await fastcas.setLocalPassword(actor, body.password));
    }),
    route("POST", "/api/auth/fastcas/links/:linkId/reconcile", async (request, params) => {
      requireFastCASOrigin(request);
      if (!fastcas) throw new ApiError(404, "fastcas_not_configured", "FastCAS is not configured");
      return json(await fastcas.reconcile(principal(request, true)!, params.linkId!));
    }),
    route("POST", "/api/auth/fastcas/links/:linkId/revoke", async (request, params) => {
      requireFastCASOrigin(request);
      if (!fastcas) throw new ApiError(404, "fastcas_not_configured", "FastCAS is not configured");
      const actor = principal(request, true)!;
      const body = await readJson<{ password: string }>(request);
      return json(await fastcas.revoke(actor, body.password, params.linkId!));
    }),
    route("POST", "/api/auth/fastcas/events", async request => {
      if (!fastcas) throw new ApiError(404, "fastcas_not_configured", "FastCAS is not configured");
      if (request.headers.get("content-type")?.split(";")[0] !== "application/jwt") throw new ApiError(415, "event_type_invalid", "Signed event required");
      const raw = await request.text();
      if (raw.length > 65536) throw new ApiError(413, "event_too_large", "Event exceeds size limit");
      await fastcas.handleEvent(raw);
      return new Response(null, { status: 204 });
    }),
    route("POST", "/api/auth/fastcas/backchannel-logout", async request => {
      if (!fastcas) throw new ApiError(404, "fastcas_not_configured", "FastCAS is not configured");
      if (request.headers.get("content-type")?.split(";")[0] !== "application/x-www-form-urlencoded") throw new ApiError(415, "logout_type_invalid", "Signed logout required");
      const raw = await request.text();
      if (raw.length > 65536) throw new ApiError(413, "logout_too_large", "Logout exceeds size limit");
      const form = new URLSearchParams(raw);
      const tokens = form.getAll("logout_token");
      if (tokens.length !== 1 || Array.from(form.keys()).length !== 1) throw new ApiError(400, "logout_invalid", "Invalid logout form");
      await fastcas.handleLogout(tokens[0]!);
      return new Response(null, { status: 204 });
    }),
    route("GET", "/api/auth/oidc/login", async (_request, _params, url) => { if (!oidc) throw new ApiError(404, "oidc_not_configured", "OIDC is not configured"); const returnTo = url.searchParams.get("returnTo"); const login = await oidc.beginLogin({ ...(returnTo ? { returnTo } : {}) }); if (login.kind !== "redirect" || !login.binding) throw new ApiError(400, "oidc_login_invalid", "The configured identity provider does not return a login binding"); const response = Response.redirect(login.url, 302); response.headers.set("set-cookie", loginBindingCookie("oidc", login.binding)); return response; }),
    route("GET", "/api/auth/oidc/callback", async (request, _params, url) => { if (!oidc) throw new ApiError(404, "oidc_not_configured", "OIDC is not configured"); const code = url.searchParams.get("code"); const state = url.searchParams.get("state"); requireLoginBinding(request, "oidc", state); const returnTo = oidc.loginReturnTo?.(state ?? undefined) ?? "/"; const identity = await oidc.finishLogin({ ...(code ? { code } : {}), ...(state ? { state } : {}) }); const result = await auth.loginExternal(identity); await teams.personalWorkspace({ user: result.user, sessionId: "external-login" }); await teams.syncIdpGroups(result.user, identityGroups(identity.issuer, identity.groups)); return externalAuthCallback("oidc", result, `${returnTo}${returnTo.includes("?") ? "&" : "?"}oidc=complete`); }),
    route("GET", "/api/auth/cas/login", async () => { if (!cas) throw new ApiError(404, "cas_not_configured", "CAS is not configured"); const login = await cas.beginLogin({}); if (login.kind !== "redirect" || !login.binding) throw new ApiError(400, "cas_login_invalid", "The configured identity provider does not return a login binding"); const response = Response.redirect(login.url, 302); response.headers.set("set-cookie", loginBindingCookie("cas", login.binding)); return response; }),
    route("GET", "/api/auth/cas/callback", async (request, _params, url) => { if (!cas) throw new ApiError(404, "cas_not_configured", "CAS is not configured"); const ticket = url.searchParams.get("ticket"); const state = url.searchParams.get("state"); requireLoginBinding(request, "cas", state); const identity = await cas.finishLogin({ ...(ticket ? { ticket } : {}), ...(state ? { state } : {}) }); const result = await auth.loginExternal(identity); await teams.personalWorkspace({ user: result.user, sessionId: "external-login" }); await teams.syncIdpGroups(result.user, identityGroups(identity.issuer, identity.groups)); return externalAuthCallback("cas", result, "/?cas=complete"); }),
    route("GET", "/api/auth/cas/logout", async (request) => { if (!cas) throw new ApiError(404, "cas_not_configured", "CAS is not configured"); const current = principal(request, false); if (current) await auth.logout(request); const target = cas instanceof CasIdentityProvider ? cas.logoutRedirect() : "/"; const response = Response.redirect(target, 302); response.headers.set("set-cookie", expiredRefreshCookie()); return response; }),
    route("POST", "/api/auth/refresh", async (request) => { requireSameOrigin(request); return authResponse(await auth.refresh(request)); }),
    route("POST", "/api/auth/logout", async (request) => { await auth.logout(request); return new Response(null, { status: 204, headers: { "set-cookie": expiredRefreshCookie() } }); }),
    route("GET", "/api/auth/me", async (request) => json(principal(request, true)!.user)),
    route("GET", "/api/admin/health", async (request) => { const actor = principal(request, true)!; requireAdminReadRole(actor.user); const state = database.snapshot(); return json({ users: state.users.length, activeSessions: state.sessions.filter((item) => !item.revokedAt && item.expiresAt > new Date().toISOString()).length, teams: state.teams.length, projects: state.projects.length, collaborationDocuments: state.collaborationDocuments.filter((item) => item.status === "active").length, pendingInvitations: state.invitations.filter((item) => !item.revokedAt && !item.acceptedAt && item.expiresAt > new Date().toISOString()).length, mail: mailDelivery.status(), postgres: agentSettings.postgresMirror?.() ?? { configured: false, healthy: false, failures: 0 }, jobs: { queued: state.jobs.filter((job) => job.status === "queued").length, running: state.jobs.filter((job) => job.status === "running").length, failed: state.jobs.filter((job) => job.status === "failed").length } }); }),
    route("GET", "/api/admin/postgres/compare", async (request) => { const actor = principal(request, true)!; requireAdminReadRole(actor.user); if (!agentSettings.postgresCompare) throw new ApiError(404, "postgres_not_configured", "PostgreSQL is not configured"); return json(await agentSettings.postgresCompare()); }),
    route("GET", "/api/admin/identity-providers", async (request) => { const actor = principal(request, true)!; requireAdminReadRole(actor.user); return json({ oidc: { configured: Boolean(oidc), ...(config.oidc ? { issuer: config.oidc.issuer, redirectUri: config.oidc.redirectUri, clientId: config.oidc.clientId } : {}) }, cas: { configured: Boolean(cas), ...(config.cas ? { serverUrl: config.cas.serverUrl, serviceUrl: config.cas.serviceUrl } : {}) }, local: { configured: true } }); }),
    route("GET", "/api/admin/users", async (request) => { const actor = principal(request, true)!; requireAdminReadRole(actor.user); const state = database.snapshot(); return json(state.users.map((user) => ({ id: user.id, emailNormalized: user.emailNormalized, displayName: user.displayName, platformRole: user.platformRole, status: user.status, createdAt: user.createdAt, updatedAt: user.updatedAt, activeSessionCount: state.sessions.filter((session) => session.userId === user.id && !session.revokedAt && session.expiresAt > new Date().toISOString()).length }))); }),
    route("POST", "/api/admin/users/:userId/disable", async (request, params) => { const body = await readJson<{ reason?: string }>(request); await auth.disable(required(params, "userId"), principal(request, true)!, body.reason ?? ""); return new Response(null, { status: 204 }); }),
    route("POST", "/api/admin/users/:userId/sessions/revoke", async (request, params) => { const body = await readJson<{ reason?: string }>(request); await auth.revokeSessions(required(params, "userId"), principal(request, true)!, body.reason ?? ""); return new Response(null, { status: 204 }); }),
    route("PATCH", "/api/admin/users/:userId/platform-role", async (request, params) => { const body = await readJson<{ role?: "platform_admin" | "support_auditor" | "user"; reason?: string }>(request); if (body.role !== "platform_admin" && body.role !== "support_auditor" && body.role !== "user") throw new ApiError(400, "platform_role_invalid", "A valid platform role is required"); return json(await auth.updatePlatformRole(required(params, "userId"), body.role, principal(request, true)!, body.reason ?? "")); }),
    route("GET", "/api/admin/audit-events", async (request, _params, url) => { const actor = principal(request, true)!; requireAdminReadRole(actor.user); const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10); const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 100; return json(database.snapshot().auditEvents.slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, limit)); }),
    route("GET", "/api/admin/jobs/dead-letters", async (request, _params, url) => { const actor = principal(request, true)!; requireAdminReadRole(actor.user); const kind = url.searchParams.get("kind") ?? undefined; return json(jobs.deadLetters(kind)); }),
    route("POST", "/api/admin/jobs/:jobId/retry", async (request, params) => { const actor = principal(request, true)!; requireRole(actor.user, "platform_admin"); const job = jobs.get(required(params, "jobId")); if (!job) throw new ApiError(404, "job_not_found", "Job not found"); if (!job.deadLetter) throw new ApiError(409, "job_not_dead_letter", "Only dead-letter jobs can be manually retried"); const retried = await database.mutate((state) => { const stored = state.jobs.find((item) => item.id === job.id); if (!stored) throw new ApiError(404, "job_not_found", "Job not found"); stored.status = "queued"; delete stored.deadLetter; delete stored.error; stored.attempts = 0; stored.updatedAt = new Date().toISOString(); return structuredClone(stored); }); return json(retried, 202); }),
    route("POST", "/api/admin/support-access", async (request) => { const actor = principal(request, true)!; requireAdminReadRole(actor.user); const body = await readJson<{ projectId?: string; pathPrefix?: string; ticketId?: string; reason?: string; expiresInMinutes?: number }>(request); if (!body.projectId || !body.ticketId?.trim() || !body.reason?.trim() || body.reason.trim().length < 8) throw new ApiError(400, "support_access_invalid", "projectId, ticketId and a reason of at least 8 characters are required"); const state = database.snapshot(); const project = state.projects.find((item) => item.id === body.projectId); if (!project) throw new ApiError(404, "project_not_found", "Project not found"); const now = new Date().toISOString(); const expiresAt = new Date(Date.now() + Math.min(Math.max(body.expiresInMinutes ?? 60, 5), 24 * 60) * 60_000).toISOString(); const item = { id: `support_${crypto.randomUUID()}`, requesterUserId: actor.user.id, projectId: body.projectId, pathPrefix: body.pathPrefix?.trim() || "", ticketId: body.ticketId.trim().slice(0, 120), reason: body.reason.trim().slice(0, 500), expiresAt, status: "pending" as const, createdAt: now, updatedAt: now }; return json(await database.mutate((current) => { current.supportAccessRequests.push(item); const owners = new Set(current.projectMembers.filter((member) => member.projectId === item.projectId && member.role === "owner").map((member) => member.userId)); if (project.personalOwnerUserId) owners.add(project.personalOwnerUserId); for (const userId of owners) createNotification(current, { userId, type: "access_request", title: "Support access requested", body: `Ticket ${item.ticketId} requires approval.`, projectId: item.projectId }); current.auditEvents.push({ id: `audit_${crypto.randomUUID()}`, actorUserId: actor.user.id, action: "support_access.request", resourceType: "support_access", resourceId: item.id, metadata: { projectId: item.projectId, ticketId: item.ticketId }, createdAt: now }); return item; }), 201); }),
    route("GET", "/api/admin/support-access", async (request) => { const actor = principal(request, true)!; requireAdminReadRole(actor.user); const now = new Date().toISOString(); await database.mutate((state) => { for (const item of state.supportAccessRequests) if (item.status === "approved" && item.expiresAt <= now) { item.status = "expired"; item.updatedAt = now; state.auditEvents.push({ id: `audit_${crypto.randomUUID()}`, action: "support_access.expire", resourceType: "support_access", resourceId: item.id, metadata: { ticketId: item.ticketId }, createdAt: now }); } }); return json(database.snapshot().supportAccessRequests.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))); }),
    route("POST", "/api/admin/support-access/:requestId/revoke", async (request, params) => { const actor = principal(request, true)!; requireRole(actor.user, "platform_admin"); return json(await database.mutate((state) => { const item = state.supportAccessRequests.find((candidate) => candidate.id === required(params, "requestId")); if (!item) throw new ApiError(404, "support_access_not_found", "Support access request not found"); if (item.status !== "approved") throw new ApiError(409, "support_access_not_active", "Only approved support access can be revoked"); item.status = "revoked"; item.updatedAt = new Date().toISOString(); state.auditEvents.push({ id: `audit_${crypto.randomUUID()}`, actorUserId: actor.user.id, action: "support_access.revoke", resourceType: "support_access", resourceId: item.id, metadata: { ticketId: item.ticketId }, createdAt: item.updatedAt }); return item; })); }),
    route("POST", "/api/admin/support-access/:requestId/decision", async (request, params) => { const actor = principal(request, true)!; requireRole(actor.user, "platform_admin"); const body = await readJson<{ approved?: boolean }>(request); if (typeof body.approved !== "boolean") throw new ApiError(400, "support_access_decision_invalid", "approved must be a boolean"); const token = body.approved ? randomBytes(32).toString("base64url") : undefined; const result = await database.mutate((state) => { const item = state.supportAccessRequests.find((candidate) => candidate.id === required(params, "requestId")); if (!item) throw new ApiError(404, "support_access_not_found", "Support access request not found"); if (item.requesterUserId === actor.user.id) throw new ApiError(409, "support_access_self_approval", "A request cannot be approved by its requester"); if (item.status !== "pending") throw new ApiError(409, "support_access_already_decided", "Support access request has already been decided"); item.status = body.approved ? "approved" : "denied"; item.approverUserId = actor.user.id; item.updatedAt = new Date().toISOString(); if (token) item.tokenHash = createHash("sha256").update(token).digest("hex"); const requester = state.users.find((user) => user.id === item.requesterUserId); if (requester) createNotification(state, { userId: requester.id, type: "access_request_decision", title: `Support access ${item.status}`, body: `Ticket ${item.ticketId} was ${item.status}.`, projectId: item.projectId }); state.auditEvents.push({ id: `audit_${crypto.randomUUID()}`, actorUserId: actor.user.id, action: `support_access.${item.status}`, resourceType: "support_access", resourceId: item.id, metadata: { ticketId: item.ticketId }, createdAt: item.updatedAt }); return { item: structuredClone(item), token }; }); return json({ ...result.item, ...(result.token ? { token: result.token } : {}) }); }),
    route("POST", "/api/admin/support-access/:requestId/redeem", async (request, params) => { const actor = principal(request, true)!; const body = await readJson<{ token?: string; path?: string }>(request); if (!body.token || !body.path) throw new ApiError(400, "support_access_token_invalid", "token and path are required"); const now = new Date().toISOString(); const requestId = required(params, "requestId"); const digest = createHash("sha256").update(body.token).digest("hex"); const normalized = normalizeWorkspacePath(body.path); const result = await database.mutate((state) => { const item = state.supportAccessRequests.find((candidate) => candidate.id === requestId && candidate.tokenHash === digest); if (!item || item.status !== "approved" || item.expiresAt <= now) throw new ApiError(403, "support_access_expired", "Support access is invalid or expired"); if (!(item.pathPrefix === "" || normalized === item.pathPrefix || normalized.startsWith(`${item.pathPrefix}/`))) throw new ApiError(403, "support_access_scope_denied", "Path is outside the approved support scope"); const project = state.projects.find((candidate) => candidate.id === item.projectId); if (!project) throw new ApiError(404, "project_not_found", "Project not found"); delete item.tokenHash; item.updatedAt = now; state.auditEvents.push({ id: `audit_${crypto.randomUUID()}`, actorUserId: actor.user.id, action: "support_access.redeem", resourceType: "support_access", resourceId: item.id, metadata: { projectId: item.projectId, path: normalized, ticketId: item.ticketId }, createdAt: now }); return { projectId: item.projectId, path: normalized, userId: actor.user.id, sessionId: actor.sessionId, expiresAt: item.expiresAt, scope: "read" as const, authorized: true, oneTime: true }; }); return json(result); }),
    route("POST", "/api/admin/mail/webhook", async (request) => { const rawBody = await request.text(); let body: { deliveryId?: string; status?: "delivered" | "bounced" | "complained"; error?: string }; try { body = JSON.parse(rawBody) as typeof body; } catch { throw new ApiError(400, "invalid_json", "Request body must be valid JSON"); } const signature = request.headers.get("x-fastwrite-mail-signature"); const secret = config.mail?.webhookSecret; if (!secret) throw new ApiError(503, "mail_webhook_not_configured", "Mail webhook secret is not configured"); const accepted = await mailDelivery.handleWebhook({ ...body, rawBody, ...(signature ? { signature } : {}), secret }); if (!accepted) throw new ApiError(401, "mail_webhook_signature_invalid", "Mail webhook signature is invalid"); return new Response(null, { status: 204 }); }),
    route("POST", "/api/admin/backups", async (request) => { const actor = principal(request, true)!; requireAdminReadRole(actor.user); return json(await backups.create(), 201); }),
    route("POST", "/api/admin/backups/verify", async (request) => { const actor = principal(request, true)!; requireAdminReadRole(actor.user); const body = await readJson<{ path?: string }>(request); if (!body.path) throw new ApiError(400, "backup_path_required", "Backup path is required"); return json(await backups.verify(body.path)); }),
    route("POST", "/api/admin/backups/restore", async (request) => { const actor = principal(request, true)!; requireRole(actor.user, "platform_admin"); const body = await readJson<{ path?: string; confirm?: "replace-database" }>(request); if (!body.path || body.confirm !== "replace-database") throw new ApiError(400, "backup_restore_confirmation_required", "An explicit replace-database confirmation is required"); return json(await backups.restore(body.path, { confirm: body.confirm }), 202); }),
    route("GET", "/api/harness/profiles", async (request) => json(harnessProfiles.list(principal(request, true)!))),
    route("POST", "/api/harness/profiles", async (request) => { const body = await readJson<any>(request); return json(await harnessProfiles.save(principal(request, true)!, body.scope, body, { teamId: body.teamId, profileId: body.profileId }), 201); }),
    route("GET", "/api/harness/effective", async (request, _params, url) => json(harnessProfiles.resolve(principal(request, true)!, url.searchParams.get("projectId") ?? undefined))),
    route("GET", "/api/teams", async (request) => json(teams.list(principal(request, true)!))),
    route("POST", "/api/teams", async (request) => { const body = await readJson<{ name?: string }>(request); return json(await teams.create(principal(request, true)!, body.name ?? ""), 201); }),
    route("GET", "/api/teams/:teamId/members", async (request, params) => json(teams.members(required(params, "teamId"), principal(request)!))),
    route("GET", "/api/teams/:teamId/group-bindings", async (request, params) => json(teams.groupBindings(required(params, "teamId"), principal(request, true)!))),
    route("POST", "/api/teams/:teamId/group-bindings/preview", async (request, params) => { const body = await readJson<{ groups?: string[] }>(request); if (!Array.isArray(body.groups) || body.groups.length > 100) throw new ApiError(400, "team_group_preview_invalid", "Provide up to 100 IdP groups"); return json(teams.previewGroupBindings(required(params, "teamId"), principal(request, true)!, body.groups)); }),
    route("PUT", "/api/teams/:teamId/group-bindings/:bindingId", async (request, params) => { const body = await readJson<{ idpGroup?: string; role?: "admin" | "member" }>(request); if (!body.idpGroup || !body.role) throw new ApiError(400, "team_group_binding_invalid", "idpGroup and role are required"); const bindingId = required(params, "bindingId"); return json(await teams.saveGroupBinding(required(params, "teamId"), principal(request, true)!, { ...(bindingId === "new" ? {} : { id: bindingId }), idpGroup: body.idpGroup, role: body.role })); }),
    route("DELETE", "/api/teams/:teamId/group-bindings/:bindingId", async (request, params) => { await teams.deleteGroupBinding(required(params, "teamId"), required(params, "bindingId"), principal(request, true)!); return new Response(null, { status: 204 }); }),
    route("PATCH", "/api/teams/:teamId/members/:userId", async (request, params) => { const body = await readJson<{ role?: "admin" | "member" }>(request); if (!body.role) throw new ApiError(400, "team_member_role_invalid", "A non-owner team role is required"); return json(await teams.updateTeamMember(required(params, "teamId"), required(params, "userId"), principal(request, true)!, body.role)); }),
    route("DELETE", "/api/teams/:teamId/members/:userId", async (request, params) => { await teams.removeTeamMember(required(params, "teamId"), required(params, "userId"), principal(request, true)!); return new Response(null, { status: 204 }); }),
    route("GET", "/api/teams/:teamId/invitations", async (request, params) => json(teams.teamInvitations(required(params, "teamId"), principal(request, true)!))),
    route("GET", "/api/teams/:teamId/harness-policy", async (request, params) => json(teams.policy(required(params, "teamId"), principal(request, true)!))),
    route("PATCH", "/api/teams/:teamId/harness-policy", async (request, params) => json(await teams.updatePolicy(required(params, "teamId"), principal(request, true)!, await readJson<any>(request)))),
    route("POST", "/api/teams/:teamId/invitations", async (request, params) => { const body = await readJson<{ email?: string; role?: "owner" | "admin" | "member"; expiresAt?: string; message?: string }>(request); if (!body.email || !body.role) throw new ApiError(400, "invitation_invalid", "email and role are required"); return json(await teams.inviteTeam(required(params, "teamId"), principal(request)!, body.email, body.role, { ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}), ...(body.message !== undefined ? { message: body.message } : {}) }), 201); }),
    route("GET", "/api/projects/:projectId/invitations", async (request, params) => json(teams.projectInvitations(required(params, "projectId"), principal(request, true)!))),
    route("POST", "/api/projects/:projectId/invitations", async (request, params) => { const body = await readJson<{ email?: string; role?: "owner" | "maintainer" | "editor" | "commenter" | "viewer"; expiresAt?: string; message?: string }>(request); if (!body.email || !body.role) throw new ApiError(400, "invitation_invalid", "email and role are required"); return json(await teams.inviteProject(required(params, "projectId"), principal(request)!, body.email, body.role, { ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}), ...(body.message !== undefined ? { message: body.message } : {}) }), 201); }),
    route("GET", "/api/projects/:projectId/members", async (request, params) => json(teams.projectMembers(required(params, "projectId"), principal(request, true)!))),
    route("PATCH", "/api/projects/:projectId/members/:userId", async (request, params) => { const body = await readJson<{ role?: "maintainer" | "editor" | "commenter" | "viewer" }>(request); if (!body.role) throw new ApiError(400, "project_member_role_invalid", "A non-owner project role is required"); return json(await teams.updateProjectMember(required(params, "projectId"), required(params, "userId"), principal(request, true)!, body.role)); }),
    route("DELETE", "/api/projects/:projectId/members/:userId", async (request, params) => { await teams.removeProjectMember(required(params, "projectId"), required(params, "userId"), principal(request, true)!); return new Response(null, { status: 204 }); }),
    route("GET", "/api/access-requests/:accessProjectId", async (request, params) => { principal(request, true); const project = database.snapshot().projects.find((item) => item.id === required(params, "accessProjectId")); if (!project) throw new ApiError(404, "project_not_found", "Project not found"); return json({ id: project.id, name: project.name }); }),
    route("POST", "/api/projects/:projectId/access-requests", async (request, params) => { const body = await readJson<{ role?: "maintainer" | "editor" | "commenter" | "viewer"; message?: string }>(request); if (!body.role) throw new ApiError(400, "access_request_role_invalid", "A project role is required"); return json(await teams.requestProjectAccess(required(params, "projectId"), principal(request, true)!, { role: body.role, ...(body.message !== undefined ? { message: body.message } : {}) }), 201); }),
    route("GET", "/api/projects/:projectId/access-requests", async (request, params) => json(teams.accessRequests(required(params, "projectId"), principal(request, true)!))),
    route("POST", "/api/projects/:projectId/access-requests/:requestId/decision", async (request, params) => { const body = await readJson<{ approved?: boolean }>(request); if (typeof body.approved !== "boolean") throw new ApiError(400, "access_request_decision_invalid", "approved must be a boolean"); return json(await teams.decideAccessRequest(required(params, "projectId"), required(params, "requestId"), principal(request, true)!, body.approved)); }),
    route("GET", "/api/projects/:projectId/acl", async (request, params) => json(teams.projectAcl(required(params, "projectId"), principal(request, true)!))),
    route("GET", "/api/projects/:projectId/access-decision", async (request, params, url) => { const path = requiredQuery(url, "path"); const action = url.searchParams.get("action") as ProjectAction | null; if (!action || !PROJECT_ACTIONS.includes(action)) throw new ApiError(400, "project_action_invalid", "A valid project action is required"); return json(authorization.projectPathDecision(principal(request, true)!, required(params, "projectId"), path, action)); }),
    route("PUT", "/api/projects/:projectId/acl/:ruleId", async (request, params) => { const body = await readJson<{ pathPrefix?: string; subjectType?: "user" | "project_role" | "team_role" | "idp_group"; subjectId?: string; action?: import("@fastwrite/shared").ProjectAclAction; effect?: "allow" | "deny" }>(request); if (body.pathPrefix === undefined || !body.subjectType || !body.subjectId || !body.action || !body.effect) throw new ApiError(400, "project_acl_invalid", "pathPrefix, subjectType, subjectId, action, and effect are required"); const ruleId = required(params, "ruleId"); return json(await teams.saveProjectAclRule(required(params, "projectId"), principal(request, true)!, { ...(ruleId === "new" ? {} : { id: ruleId }), pathPrefix: body.pathPrefix, subjectType: body.subjectType, subjectId: body.subjectId, action: body.action, effect: body.effect })); }),
    route("DELETE", "/api/projects/:projectId/acl/:ruleId", async (request, params) => { await teams.deleteProjectAclRule(required(params, "projectId"), required(params, "ruleId"), principal(request, true)!); return new Response(null, { status: 204 }); }),
    route("GET", "/api/notifications", async (request) => json(teams.notifications(principal(request, true)!))),
    route("POST", "/api/notifications/:notificationId/read", async (request, params) => json(await teams.markNotificationRead(required(params, "notificationId"), principal(request, true)!))),
    route("GET", "/api/notification-preferences", async (request) => json(teams.notificationPreferences(principal(request, true)!))),
    route("PUT", "/api/notification-preferences/:type", async (request, params) => json(await teams.updateNotificationPreference(principal(request, true)!, required(params, "type") as import("@fastwrite/shared").UserNotificationType, await readJson<{ inApp?: boolean; email?: boolean }>(request)))),
    route("GET", "/api/projects/:projectId/audit", async (request, params) => { const projectId = required(params, "projectId"); authorization.requireProject(principal(request, true)!, projectId, "project:manage"); return json(database.snapshot().auditEvents.filter((event) => event.resourceId === projectId).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 500)); }),
    route("POST", "/api/invitations/:invitationToken/accept", async (request, params) => json(await teams.accept(required(params, "invitationToken"), principal(request)!))),
    route("POST", "/api/invitations/:invitationId/resend", async (request, params) => json(await teams.resend(required(params, "invitationId"), principal(request, true)!))),
    route("DELETE", "/api/invitations/:invitationId", async (request, params) => { await teams.revoke(required(params, "invitationId"), principal(request)!); return new Response(null, { status: 204 }); }),
    route("POST", "/api/collaboration/tokens", async (request) => { const body = await readJson<{ projectId?: string; path?: string }>(request); if (!body.projectId || !body.path) throw new ApiError(400, "collaboration_room_invalid", "projectId and path are required"); const current = principal(request, true)!; authorization.requireProjectPath(current, body.projectId, body.path, "project:read"); const file = await workspaces.readTextFile(body.projectId, body.path); let scope: "read" | "write" = "read"; try { authorization.requireProjectPath(current, body.projectId, file.file.path, "project:write"); scope = "write"; } catch { /* Read-capable collaborators receive a read-only room. */ } const grant = auth.issueCollaborationRoomToken(current, { projectId: body.projectId, path: file.file.path, scope }); return json({ ...grant, projectId: body.projectId, path: file.file.path, scope }); }),
    route("GET", "/api/collaboration/room-access", async (_request, _params, url) => { const grant = auth.collaborationRoomGrant(requiredQuery(url, "token")); const user = database.snapshot().users.find((item) => item.id === grant.userId)!; const current = { user, sessionId: grant.sessionId }; authorization.requireProjectPath(current, grant.projectId, grant.path, grant.scope === "write" ? "project:write" : "project:read"); await workspaces.readTextFile(grant.projectId, grant.path); const palette = ["#2563eb", "#059669", "#c2410c", "#7c3aed", "#be123c"]; const color = palette[Number.parseInt(user.id.replace(/\D/g, "").slice(-4) || "0", 10) % palette.length]!; return json({ ...grant, displayName: user.displayName, color }); }),
    route("GET", "/api/collaboration/room-state", async (request) => { const grant = auth.collaborationRoomGrant(request.headers.get("x-fastwrite-room-token") ?? ""); const user = database.snapshot().users.find((item) => item.id === grant.userId)!; authorization.requireProjectPath({ user, sessionId: grant.sessionId }, grant.projectId, grant.path, "project:read"); return json(await collaboration.open(grant.projectId, grant.path)); }),
    route("POST", "/api/collaboration/room-update", async (request) => { const grant = auth.collaborationRoomGrant(request.headers.get("x-fastwrite-room-token") ?? ""); if (grant.scope !== "write") throw new ApiError(403, "collaboration_write_denied", "This room is read-only"); const user = database.snapshot().users.find((item) => item.id === grant.userId)!; authorization.requireProjectPath({ user, sessionId: grant.sessionId }, grant.projectId, grant.path, "project:write"); const body = await readJson<{ update?: string }>(request); if (!body.update || body.update.length > 7_000_000) throw new ApiError(400, "collaboration_update_invalid", "A bounded Yjs update is required"); return json(await collaboration.applyLive(grant.projectId, grant.path, body.update)); }),
    route("GET", "/api/collaboration/access", async (request, _params, url) => { const projectId = requiredQuery(url, "projectId"); const path = requiredQuery(url, "path"); const current = principal(request, true)!; authorization.requireProject(current, projectId, "project:write"); await workspaces.readTextFile(projectId, path); const palette = ["#2563eb", "#059669", "#c2410c", "#7c3aed", "#be123c"]; const color = palette[Number.parseInt(current.user.id.replace(/\D/g, "").slice(-4) || "0", 10) % palette.length]!; return json({ projectId, path, userId: current.user.id, displayName: current.user.displayName, color }); }),
    route("GET", "/api/diagrams/schema", () => json(diagramSchema)),
    route("GET", "/api/diagrams", async () => json((await diagrams.list()).map(({scene,...record})=>({...record,title:scene?.title})))),
    route("POST", "/api/diagrams", async request => {const body=await readJson<{scene:unknown;parentId?:string}>(request);return json(await diagrams.save(body.scene,body.parentId),201)}),
    route("POST", "/api/diagrams/generate", async request => json(await diagrams.generate(await readJson(request)),202)),
    route("GET", "/api/diagrams/:diagramId", async (_request,params)=>json(await diagrams.get(required(params,"diagramId")))),
    route("GET", "/api/diagrams/:diagramId/export/:format", async (_request,params)=>{
      const record=await diagrams.get(required(params,"diagramId"));if(!record.scene)throw new ApiError(409,"diagram_not_ready","图尚未生成完成");
      const format=required(params,"format");
      if(format==='svg')return new Response(renderSvg(record.scene),{headers:{'content-type':'image/svg+xml','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'",'content-disposition':'inline; filename="diagram.svg"'}});
      if(format==='drawio')return new Response(renderDrawio(record.scene),{headers:{'content-type':'application/xml','content-disposition':'attachment; filename="diagram.drawio"'}});
      if(format==='pptx')return new Response(await renderPptx(record.scene),{headers:{'content-type':'application/vnd.openxmlformats-officedocument.presentationml.presentation','content-disposition':'attachment; filename="diagram.pptx"'}});
      throw new ApiError(400,'diagram_format_invalid','支持 SVG、draw.io 和 PPTX');
    }),
    route("GET", "/api/harness-settings", async () => json(agentSettings.status())),
    route("PUT", "/api/harness-settings", async (request) => { agentSettings.configure(await readJson<AgentSettingsInput>(request)); return json(agentSettings.status()); }),
    route("GET", "/api/venues", async () => json(await skillRegistry.catalog())),
    route("GET", "/api/skills/workflows", async () => json((await skillRegistry.workflowCatalog()).map(({ instructions: _instructions, ...descriptor }) => descriptor))),
    route("GET", "/api/skills/releases", async () => json(await skillRegistry.publishedCatalog())),
    route("GET", "/api/skills/releases/:skillId", async (_request, params) => { try { return json(await skillRegistry.release(required(params, "skillId"))); } catch (error) { throw new ApiError(404, "skill_release_not_found", error instanceof Error ? error.message : "Skill release not found"); } }),
    route("POST", "/api/skills/releases/:skillId/evaluate", async (request, params) => { const actor = principal(request, authEnabled); if (actor) requireRole(actor.user, "platform_admin"); try { return json(await skillRegistry.evaluate(required(params, "skillId"))); } catch (error) { throw new ApiError(404, "skill_release_not_found", error instanceof Error ? error.message : "Skill release not found"); } }),
    route("POST", "/api/skills/releases/:skillId/rollback", async (request, params) => { const actor = principal(request, authEnabled); if (actor) requireRole(actor.user, "platform_admin"); const body = await readJson<{ reason?: string }>(request); if (!body.reason?.trim()) throw new ApiError(400, "skill_rollback_reason_required", "A rollback reason is required"); try { return json(await skillRegistry.rollback(required(params, "skillId"), body.reason)); } catch (error) { throw new ApiError(404, "skill_release_not_found", error instanceof Error ? error.message : "Skill release not found"); } }),
    route("GET", "/api/agent-skills", async () => json(await skillRegistry.taskCatalog())),
    route("GET", "/api/harnesses", async () => json(await Promise.all(harnessRegistry.list().map(async (adapter) => ({ status: await adapter.getStatus(), capabilities: await adapter.getCapabilities() }))))),
    route("GET", "/api/harness-sessions", async () => json(harnessSessions.list())),
    route("GET", "/api/mcp", async () => json(mcpRegistry.list())),
    route("GET", "/api/mcp/audit", async (_request, params, url) => json(mcpTools.audit(url.searchParams.get("projectId") ?? undefined))),
    route("POST", "/api/projects/:projectId/mcp/call", async (request, params) => { const body = await readJson<{ name?: string; input?: unknown; allow?: string[]; deny?: string[] }>(request); if (!body.name) throw new ApiError(400, "mcp_tool_required", "name is required"); const projectId = required(params, "projectId"); const current = principal(request, false); if (current) await authorizeMcpWorkspaceInput(projectId, current, authorization, body.name, body.input, workspaces); const policy = current ? { allow: harnessProfiles.resolve(current, projectId).allowedTools } : { allow: body.allow ?? [], ...(body.deny ? { deny: body.deny } : {}) }; return json(await mcpTools.call(projectId, body.name, body.input ?? {}, policy)); }),
    route("GET", "/api/harness-runs", async () => json(harnessRuns.list())),
    route("GET", "/api/harness-runs/:runId", async (_request, params) => {
      const run = harnessRuns.get(required(params, "runId"));
      if (!run) throw new ApiError(404, "harness_run_not_found", "Harness run not found");
      return json(run);
    }),
    route("GET", "/api/harness-runs/:runId/events", async (_request, params, url) => {
      const run = harnessRuns.get(required(params, "runId"));
      if (!run) throw new ApiError(404, "harness_run_not_found", "Harness run not found");
      const since = Math.max(0, Number.parseInt(url.searchParams.get("since") ?? "0", 10) || 0);
      const limit = Math.min(2000, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "2000", 10) || 2000));
      return json(run.events.slice(since, since + limit));
    }),
    route("GET", "/api/harness-runs/:runId/approvals", async (_request, params) => json(harnessRuns.listApprovals(required(params, "runId")))),
    route("POST", "/api/harness-approvals/:approvalId", async (request, params) => {
      const body = await readJson<{ decision?: "approved" | "denied" }>(request);
      if (body.decision !== "approved" && body.decision !== "denied") throw new ApiError(400, "approval_decision_invalid", "decision must be approved or denied");
      let approval;
      try { approval = await harnessRuns.resolveApproval(required(params, "approvalId"), body.decision); }
      catch (error) { if (error instanceof Error && error.message === "approval_already_decided") throw new ApiError(409, "approval_already_decided", "Approval has already been decided"); throw error; }
      if (!approval) throw new ApiError(404, "approval_not_found", "Approval not found");
      return json(approval);
    }),
    route("POST", "/api/harness-runs", async (request) => {
      const body = await readJson<{ kind?: "claude" | "codex"; sessionId?: string; cwd?: string; content?: string; model?: string; projectId?: string; skills?: Array<{ id: string; name: string; path: string; version: string }> }>(request);
      if (!body.kind || !body.sessionId || !body.cwd?.trim() || !body.content?.trim()) throw new ApiError(400, "harness_run_invalid", "kind, sessionId, cwd and content are required");
      const actor = body.projectId ? principal(request)! : principal(request, false);
      const resolved = body.projectId && actor ? harnessProfiles.resolve(actor, body.projectId) : undefined;
      if (resolved && resolved.provider !== body.kind) throw new ApiError(409, "harness_profile_provider_mismatch", "The selected Harness profile does not permit this adapter");
      const projectVersion = body.projectId ? workspaces.getProject(body.projectId).version : undefined;
      const events = [];
      for await (const event of harnessRuns.send({ kind: body.kind, session: { harness: body.kind, sessionId: body.sessionId, cwd: body.cwd.trim() }, content: body.content.trim(), ...(body.model?.trim() ? { model: body.model.trim() } : {}), ...(body.skills ? { skills: body.skills } : {}), ...(actor ? { actorUserId: actor.user.id } : {}), ...(body.projectId ? { projectId: body.projectId } : {}), ...(projectVersion !== undefined ? { projectVersion } : {}), ...(resolved ? { resolvedHarnessProfile: { profileId: resolved.profileId, version: resolved.version, fingerprint: resolved.fingerprint, sourceChain: resolved.sourceChain } } : {}), signal: request.signal })) events.push(event);
      return json({ events }, 201);
    }),
    route("POST", "/api/harnesses/:kind/sessions", async (request, params) => {
      const adapter = harnessAdapter(harnessRegistry, required(params, "kind"));
      const body = await readJson<{ cwd?: string; title?: string }>(request);
      if (!body.cwd?.trim()) throw new ApiError(400, "harness_cwd_required", "cwd is required");
      return json(await harnessSessions.create(adapter, { cwd: body.cwd.trim(), ...(body.title?.trim() ? { title: body.title.trim().slice(0, 200) } : {}) }), 201);
    }),
    route("POST", "/api/harnesses/:kind/sessions/:sessionId/resume", async (request, params) => {
      const adapter = harnessAdapter(harnessRegistry, required(params, "kind"));
      const body = await readJson<{ cwd?: string }>(request);
      if (!body.cwd?.trim()) throw new ApiError(400, "harness_cwd_required", "cwd is required");
      return json(await harnessSessions.resume(adapter, { harness: adapter.kind, sessionId: required(params, "sessionId"), cwd: body.cwd.trim() }));
    }),
    route("POST", "/api/harnesses/:kind/sessions/:sessionId/messages", async (request, params) => {
      const adapter = harnessAdapter(harnessRegistry, required(params, "kind"));
      const body = await readJson<{ cwd?: string; content?: string; model?: string; skills?: Array<{ id: string; name: string; path: string; version: string }> }>(request);
      if (!body.cwd?.trim() || !body.content?.trim()) throw new ApiError(400, "harness_message_invalid", "cwd and content are required");
      const events = [];
      for await (const event of adapter.sendMessage({ session: { harness: adapter.kind, sessionId: required(params, "sessionId"), cwd: body.cwd.trim() }, content: body.content.trim(), ...(body.model?.trim() ? { model: body.model.trim() } : {}), ...(body.skills ? { skills: body.skills } : {}), signal: request.signal })) events.push(event);
      return json({ sessionId: required(params, "sessionId"), events });
    }),
    route("GET", "/api/projects/:projectId/collaboration", async (request, params, url) => {
      const projectId = required(params, "projectId"); const path = requiredQuery(url, "path"); const current = principal(request); if (current) authorization.requireProjectPath(current, projectId, path, "project:read"); const opened = await collaboration.open(projectId, path);
      return json({ ...opened, presence: [...(presence.get(projectId)?.values() ?? [])].filter((item) => Date.now() - Date.parse(item.updatedAt) < 45_000 && (!current || canReadProjectPath(current, projectId, item.path, authorization))) });
    }),
    route("POST", "/api/projects/:projectId/collaboration/persist", async (request, params) => {
      const projectId = required(params, "projectId");
      const body = await readJson<Partial<CollaborationPersistRequest>>(request);
      if (typeof body.path !== "string" || !body.path || typeof body.documentId !== "string" || !body.documentId || typeof body.update !== "string" || !body.update) throw new ApiError(400, "collaboration_update_invalid", "path, documentId and update are required");
      const current = principal(request);
      if (current) authorization.requireProjectPath(current, projectId, body.path, "project:write");
      return json(await collaboration.persistSnapshot(projectId, body.path, body.documentId, body.update));
    }),
    route("POST", "/api/projects/:projectId/collaboration/flush", async (request, params) => { const projectId = required(params, "projectId"); const body = await readJson<{ path?: string }>(request); if (!body.path) throw new ApiError(400, "collaboration_path_required", "path is required"); const current = principal(request); if (current) authorization.requireProjectPath(current, projectId, body.path, "project:write"); await collaboration.flushProject(projectId); return json(await workspaces.readTextFile(projectId, body.path)); }),
    route("POST", "/api/projects/:projectId/collaboration", async (request, params) => {
      const projectId = required(params, "projectId"); const body = await readJson<{ path?: string; update?: string; baseVersion?: number; clientId?: string; name?: string; color?: string; line?: number }>(request); if (!body.path || !body.update || !Number.isInteger(body.baseVersion)) throw new ApiError(400, "collaboration_update_invalid", "path, update and baseVersion are required"); const current = principal(request); if (current) authorization.requireProjectPath(current, projectId, body.path, "project:write");
      const saved = await collaboration.apply(projectId, body.path, body.update, body.baseVersion!);
      if (body.clientId && (current || body.name)) { const palette = ["#2563eb", "#059669", "#c2410c", "#7c3aed", "#be123c"]; const color = current ? palette[Number.parseInt(current.user.id.replace(/\D/g, "").slice(-4) || "0", 10) % palette.length]! : body.color?.slice(0, 32); const projectPresence = presence.get(projectId) ?? new Map(); projectPresence.set(body.clientId, { clientId: body.clientId, name: current?.user.displayName ?? body.name!.slice(0, 80), ...(color ? { color } : {}), path: body.path, ...(Number.isInteger(body.line) && body.line! > 0 ? { line: body.line } : {}), updatedAt: new Date().toISOString() }); presence.set(projectId, projectPresence); }
      return json({ ...saved, presence: [...(presence.get(projectId)?.values() ?? [])] });
    }),
    route("POST", "/api/projects/:projectId/collaboration/presence", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, true)!; const body = await readJson<{ clientId?: string; path?: string; line?: number }>(request); if (!body.clientId || !body.path) throw new ApiError(400, "presence_invalid", "clientId and path are required"); authorization.requireProjectPath(current, projectId, body.path, "project:read"); const palette = ["#2563eb", "#059669", "#c2410c", "#7c3aed", "#be123c"]; const color = palette[Number.parseInt(current.user.id.replace(/\D/g, "").slice(-4) || "0", 10) % palette.length]!; const projectPresence = presence.get(projectId) ?? new Map(); projectPresence.set(body.clientId, { clientId: body.clientId, name: current.user.displayName, color, path: body.path, ...(Number.isInteger(body.line) && body.line! > 0 ? { line: body.line } : {}), updatedAt: new Date().toISOString() }); presence.set(projectId, projectPresence); return json([...projectPresence.values()].filter((item) => Date.now() - Date.parse(item.updatedAt) < 45_000 && canReadProjectPath(current, projectId, item.path, authorization))); }),
    route("GET", "/api/projects/:projectId/comments", async (request, params) => json(await comments.list(required(params, "projectId"), principal(request, true)!))),
    route("POST", "/api/projects/:projectId/comments", async (request, params) => { const body = await readJson<{ path: string; from: number; to: number; body: string }>(request); return json(await comments.create(required(params, "projectId"), principal(request, true)!, body), 201); }),
    route("POST", "/api/projects/:projectId/comments/:threadId/messages", async (request, params) => { const body = await readJson<{ body?: string }>(request); return json(await comments.reply(required(params, "projectId"), required(params, "threadId"), principal(request, true)!, body.body?.trim() ?? ""), 201); }),
    route("PATCH", "/api/projects/:projectId/comments/:threadId", async (request, params) => { const body = await readJson<{ status?: "open" | "resolved" }>(request); if (body.status !== "open" && body.status !== "resolved") throw new ApiError(400, "comment_status_invalid", "status must be open or resolved"); return json(await comments.updateStatus(required(params, "projectId"), required(params, "threadId"), principal(request, true)!, body.status)); }),
    route("POST", "/api/projects/:projectId/comments/:threadId/reanchor", async (request, params) => { const body = await readJson<{ path?: string; from?: number; to?: number }>(request); if (!body.path || !Number.isInteger(body.from) || !Number.isInteger(body.to)) throw new ApiError(400, "comment_anchor_invalid", "path, from and to are required"); return json(await comments.reanchor(required(params, "projectId"), required(params, "threadId"), principal(request, true)!, { path: body.path, from: body.from!, to: body.to! })); }),
    route("POST", "/api/projects/:projectId/shares", async (request, params) => {
      const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:manage"); workspaces.getProject(projectId);
      const body = await readJson<{ permission?: "read" | "comment"; label?: string; expiresAt?: string }>(request);
      const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
      const createdAt = new Date().toISOString();
      const share = await database.mutate((state) => { const item = { id: `share_${crypto.randomUUID()}`, projectId, tokenHash: shareTokenHash(token), permission: body.permission === "comment" ? "comment" as const : "read" as const, ...(body.label?.trim() ? { label: body.label.trim().slice(0, 120) } : {}), ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}), createdAt }; state.projectShares.push(item); return item; });
      return json({ id: share.id, token, permission: share.permission, label: share.label, expiresAt: share.expiresAt, createdAt: share.createdAt }, 201);
    }),
    route("GET", "/api/projects/:projectId/shares", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:manage"); workspaces.getProject(projectId); return json(database.snapshot().projectShares.filter((item) => item.projectId === projectId).map(({ tokenHash: _tokenHash, ...item }) => item)); }),
    route("DELETE", "/api/projects/:projectId/shares/:shareId", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:manage"); workspaces.getProject(projectId); await database.mutate((state) => { const share = state.projectShares.find((item) => item.projectId === projectId && item.id === required(params, "shareId")); if (!share) throw new ApiError(404, "share_not_found", "Share link not found"); share.revokedAt = new Date().toISOString(); }); return new Response(null, { status: 204 }); }),
    route("GET", "/api/shared/:token", async (_request, params) => { const share = activeShare(database.snapshot().projectShares, required(params, "token")); const project = workspaces.getProject(share.projectId); return json({ project: { id: project.id, name: project.name, mainDocument: project.mainDocument, version: project.version }, permission: share.permission, tree: await workspaces.tree(project.id), comments: database.snapshot().shareComments.filter((item) => item.shareId === share.id) }); }),
    route("GET", "/api/shared/:token/file", async (_request, params, url) => { const share = activeShare(database.snapshot().projectShares, required(params, "token")); const path = requiredQuery(url, "path"); const file = await workspaces.readTextFile(share.projectId, path); return json({ path, content: file.content, version: file.file.version }); }),
    route("POST", "/api/shared/:token/comments", async (request, params) => { const share = activeShare(database.snapshot().projectShares, required(params, "token")); if (share.permission !== "comment") throw new ApiError(403, "share_read_only", "This share link is read-only"); const body = await readJson<{ path?: string; line?: number; author?: string; body?: string }>(request); if (!body.path || !body.body?.trim() || !body.author?.trim()) throw new ApiError(400, "comment_invalid", "path, author and body are required"); await workspaces.readTextFile(share.projectId, body.path); const createdAt = new Date().toISOString(); return json(await database.mutate((state) => { const comment = { id: `comment_${crypto.randomUUID()}`, shareId: share.id, projectId: share.projectId, path: body.path!, ...(Number.isInteger(body.line) && body.line! > 0 ? { line: body.line } : {}), author: body.author!.trim().slice(0, 80), body: body.body!.trim().slice(0, 4000), status: "open" as const, createdAt, updatedAt: createdAt }; state.shareComments.push(comment); return comment; }), 201); }),
    route("POST", "/api/projects/:projectId/compliance-checks", async (request, params) => {
      const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:read");
      const body = await readJson<{ pdfBase64?: string; renderedPages?: number; mainBodyPages?: number; verifyCitationsOnline?: boolean }>(request);
      return json(await compliance.check(projectId, body), 201);
    }),
    route("POST", "/api/projects/:projectId/research-runs", async (request, params) => {
      const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:read");
      const body = await readJson<{ query?: string }>(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "invalid_research_request", "Research request must be an object");
      return json(await research.search(projectId, typeof body.query === "string" ? body.query : "", request.signal), 201);
    }),
    route("POST", "/api/projects/:projectId/research-runs/:runId/confirm", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:write"); return json(await research.confirm(projectId, required(params, "runId"))); }),
    route("PATCH", "/api/projects/:projectId/research-runs/:runId", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:write"); return json(await research.updatePlan(projectId, required(params, "runId"), await readJson<{ steps: string[]; rationale?: string; inclusionCriteria?: string[]; exclusionCriteria?: string[]; extractionFields?: string[] }>(request))); }),
    route("GET", "/api/projects/:projectId/research-runs/:runId/screening", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:read"); return json(research.listScreening(projectId, required(params, "runId"))); }),
    route("PUT", "/api/projects/:projectId/research-runs/:runId/screening/:workId", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:write"); return json(await research.updateScreening(projectId, required(params, "runId"), required(params, "workId"), await readJson<{ decision: "included" | "excluded" | "uncertain"; reason?: string; extracted?: Record<string, string> }>(request))); }),
    route("POST", "/api/projects/:projectId/research-runs/:runId/cancel", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:write"); return json(await research.cancel(projectId, required(params, "runId"))); }),
    route("GET", "/api/projects/:projectId/research-runs", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:read"); workspaces.getProject(projectId); return json(database.snapshot().researchRuns.filter((item) => item.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))); }),
    route("GET", "/api/projects/:projectId/fastread-bundles", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:read"); return json(await research.listFastReadBundles(projectId)); }),
    route("POST", "/api/projects/:projectId/fastread-bundles/import", async (request, params) => {
      const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:write");
      const body = await readJson<{ manifestPath?: string }>(request);
      return json(await research.importFastReadBundles(projectId, typeof body.manifestPath === "string" ? body.manifestPath : undefined), 201);
    }),
    route("GET", "/api/projects/:projectId/research-works", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:read"); return json(research.listWorks(projectId)); }),
    route("GET", "/api/research-adapters", async () => json(["zotero", "grobid", "pandoc"].map((kind) => ({ kind, ...adapterCapabilities(kind as ExternalAdapterKind) })))),
    route("POST", "/api/projects/:projectId/research-adapters/:kind", async (request, params) => {
      const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:read"); workspaces.getProject(projectId);
      const kind = required(params, "kind") as ExternalAdapterKind;
      if (!["zotero", "grobid", "pandoc"].includes(kind)) throw new ApiError(400, "external_adapter_invalid", "Unsupported research adapter");
      const body = await readJson<{ baseUrl?: string; operation?: "health" | "search" | "parse" | "convert"; input?: unknown; authorized?: boolean }>(request);
      if (!body.baseUrl || !body.operation || body.authorized !== true) throw new ApiError(403, "external_adapter_authorization_required", "baseUrl, operation and explicit authorization are required");
      return json(await externalAdapters.call({ kind, operation: body.operation, input: body.input, authorized: body.authorized }, { kind, baseUrl: body.baseUrl, readOnly: true, allowed: true }, request.signal));
    }),
    route("POST", "/api/projects/:projectId/research-works/import", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:write"); const body = await readJson<Parameters<ResearchService["importWork"]>[1]>(request); if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "invalid_research_request", "Research import must be an object"); return json(await research.importWork(projectId, body), 201); }),
    route("PATCH", "/api/projects/:projectId/research-works/:workId", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:write"); return json(await research.saveWork(projectId, required(params, "workId"), await readJson<{ status?: "candidate" | "saved" | "rejected"; citationKey?: string }>(request))); }),
    route("POST", "/api/projects/:projectId/research-works/:workId/verify-metadata", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:read"); return json(await research.verifyMetadata(projectId, required(params, "workId"))); }),
    route("GET", "/api/projects/:projectId/research-citations/:citationKey", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:read"); return json(await research.citationContext(projectId, required(params, "citationKey"))); }),
    route("POST", "/api/projects/:projectId/research-works/:workId/bibtex-changes", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:write"); const body = await readJson<{ targetBibPath?: string }>(request); if (!body.targetBibPath) throw new ApiError(400, "target_bib_required", "targetBibPath is required"); const changeSet = await research.proposeBibtexChange(projectId, required(params, "workId"), body.targetBibPath); return json(await database.mutate((state) => { state.changeSets.push(changeSet); return changeSet; }), 201); }),
    route("POST", "/api/projects/:projectId/research-works/:workId/pdf-evidence", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:write"); const body = await readJson<{ pdfBase64?: string; authorized?: boolean }>(request); if (!body.pdfBase64 || body.authorized !== true) throw new ApiError(403, "pdf_authorization_required", "Provide bounded PDF data with explicit authorization"); return json(await research.extractPdfEvidence(projectId, required(params, "workId"), body.pdfBase64, body.authorized === true), 201); }),
    route("POST", "/api/projects/:projectId/claim-scans", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) await requireWorkspacePathAccess(projectId, current, authorization, "project:write", workspaces); return json(await claims.scan(projectId), 201); }),
    route("POST", "/api/projects/:projectId/alignment-checks", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:read"); return json(await alignment.check(projectId), 201); }),
    route("POST", "/api/projects/:projectId/writing-checks", async (request, params) => {
      const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) await requireWorkspacePathAccess(projectId, current, authorization, "project:read", workspaces); const project = workspaces.getProject(projectId); const tree = await workspaces.tree(projectId);
      const paths = textPaths(tree).filter((path) => /\.(?:tex|bib)$/i.test(path));
      const documents = await Promise.all(paths.map(async (path) => { const file = await workspaces.readTextFile(projectId, path); return { path, content: file.content, fileVersion: file.file.version }; }));
      const approved = new Set(database.snapshot().sourceEvidence.filter((item) => item.projectId === projectId && item.status === "approved").map((item) => item.citationKey).filter((key): key is string => Boolean(key)));
      return json({ projectId, projectVersion: project.version, findings: writingGuardMany(documents.map((document) => ({ ...document, approvedCitationKeys: approved }))) }, 201);
    }),
    route("GET", "/api/projects/:projectId/claims", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:read"); const ledger = await claims.list(projectId); return json(current ? filterVisibleClaims(ledger, current, projectId, authorization) : ledger); }),
    route("GET", "/api/projects/:projectId/evidence-cockpit", async (request, params) => {
      const projectId = required(params, "projectId");
      const project = workspaces.getProject(projectId);
      const current = principal(request, authEnabled);
      if (current) authorization.requireProject(current, projectId, "project:read");
      const ledger = await claims.list(projectId);
      const visible = current ? filterVisibleClaims(ledger, current, projectId, authorization) : ledger;
      const visibleIds = new Set(visible.map((claim) => claim.id));
      const state = database.snapshot();
      const links = state.claimEvidenceLinks.filter((link) => visibleIds.has(link.claimId));
      const evidenceById = new Map(state.sourceEvidence.filter((item) => item.projectId === projectId).map((item) => [item.id, item]));
      const summaries = visible.map((claim) => {
        const claimLinks = links.filter((link) => link.claimId === claim.id);
        const linkedEvidence = claimLinks.flatMap((link) => link.kind === "literature" ? [evidenceById.get(link.evidenceId)].filter((item): item is SourceEvidence => Boolean(item)) : []);
        const hasValid = claimLinks.some((link) => link.kind === "review-waiver" || (link.kind === "literature" && evidenceById.get(link.evidenceId)?.status === "approved") || (link.kind === "workspace" && !link.stale));
        const support: "supported" | "partial" | "unsupported" | "unresolved" = claim.anchorStatus === "orphaned" || claim.anchorStatus === "stale" ? "unresolved" : claim.reviewStatus === "supported" && hasValid ? "supported" : claim.reviewStatus === "partial" || linkedEvidence.length > 0 ? "partial" : claim.reviewStatus === "unsupported" ? "unsupported" : "unresolved";
        return { claim, links: claimLinks, evidence: linkedEvidence, support };
      });
      const counts = { total: summaries.length, supported: summaries.filter((item) => item.support === "supported").length, partial: summaries.filter((item) => item.support === "partial").length, unsupported: summaries.filter((item) => item.support === "unsupported").length, unresolved: summaries.filter((item) => item.support === "unresolved").length, stale: visible.filter((claim) => claim.anchorStatus === "stale").length, orphaned: visible.filter((claim) => claim.anchorStatus === "orphaned").length };
      const result: EvidenceCockpit = { projectId, projectVersion: project.version, claims: summaries, counts, generatedAt: new Date().toISOString() };
      return json(result);
    }),
    route("GET", "/api/projects/:projectId/citation-reviewer", async (request, params) => {
      const projectId = required(params, "projectId");
      const project = workspaces.getProject(projectId);
      const current = principal(request, authEnabled);
      if (current) authorization.requireProject(current, projectId, "project:read");
      const ledger = await claims.list(projectId);
      const visible = current ? filterVisibleClaims(ledger, current, projectId, authorization) : ledger;
      const state = database.snapshot();
      const links = state.claimEvidenceLinks.filter((link) => visible.some((claim) => claim.id === link.claimId));
      const evidenceById = new Map(state.sourceEvidence.filter((item) => item.projectId === projectId).map((item) => [item.id, item]));
      const worksById = new Map(state.researchWorks.map((work) => [work.id, work]));
      const projectCitationKeys = new Map(state.projectResearchWorks.filter((item) => item.projectId === projectId).map((item) => [item.workId, item.citationKey]));
      const items = visible.map((claim) => {
        const claimLinks = links.filter((link) => link.claimId === claim.id);
        const literature = claimLinks.filter((link): link is Extract<typeof link, { kind: "literature" }> => link.kind === "literature");
        const inlineCitationKeys = [...claim.anchor.exactText.matchAll(/\\(?:cite|citep|citet|autocite)\{([^}]+)\}/g)].flatMap((match) => match[1]!.split(",").map((key) => key.trim())).filter(Boolean);
        const citationKeys = [...new Set([...inlineCitationKeys, ...literature.map((link) => link.citationKey || projectCitationKeys.get(evidenceById.get(link.evidenceId)?.workId ?? "")).filter((key): key is string => Boolean(key))])];
        const linkedEvidence = literature.map((link) => evidenceById.get(link.evidenceId)).filter((item): item is SourceEvidence => Boolean(item));
        const approvedEvidenceCount = linkedEvidence.filter((item) => item.status === "approved").length;
        const metadata = citationKeys.map((key) => [...projectCitationKeys.entries()].find(([, citationKey]) => citationKey === key)?.[0]).map((workId) => workId ? worksById.get(workId) : undefined);
        const metadataVerifiedCount = metadata.filter((work) => work?.metadataStatus === "verified").length;
        const metadataConflictCount = metadata.filter((work) => work?.metadataStatus === "conflicting").length;
        const citationStatus: "cited" | "missing" | "unresolved" = claim.anchorStatus === "orphaned" || claim.anchorStatus === "stale" ? "unresolved" : citationKeys.length ? "cited" : "missing";
        const evidenceStatus: "supported" | "partial" | "unsupported" | "unresolved" = claim.anchorStatus === "orphaned" || claim.anchorStatus === "stale" ? "unresolved" : claim.reviewStatus === "supported" && (approvedEvidenceCount > 0 || claimLinks.some((link) => link.kind === "review-waiver" || (link.kind === "workspace" && !link.stale))) ? "supported" : claim.reviewStatus === "partial" || linkedEvidence.length > 0 ? "partial" : claim.reviewStatus === "unsupported" ? "unsupported" : "unresolved";
        return { claim, citationKeys, linkedEvidenceCount: linkedEvidence.length, approvedEvidenceCount, metadataVerifiedCount, metadataConflictCount, citationStatus, evidenceStatus };
      });
      const counts = { total: items.length, cited: items.filter((item) => item.citationStatus === "cited").length, missing: items.filter((item) => item.citationStatus === "missing").length, unresolved: items.filter((item) => item.citationStatus === "unresolved").length, supported: items.filter((item) => item.evidenceStatus === "supported").length, partial: items.filter((item) => item.evidenceStatus === "partial").length, unsupported: items.filter((item) => item.evidenceStatus === "unsupported").length };
      const result: CitationReviewer = { projectId, projectVersion: project.version, items, counts, generatedAt: new Date().toISOString() };
      return json(result);
    }),
    route("GET", "/api/projects/:projectId/claim-links", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:read"); const visibleIds = current ? new Set(filterVisibleClaims(await claims.list(projectId), current, projectId, authorization).map((claim) => claim.id)) : undefined; return json(claims.links(projectId).filter((link) => !visibleIds || visibleIds.has(link.claimId))); }),
    route("GET", "/api/projects/:projectId/claims/:claimId/links", async (request, params) => { const projectId = required(params, "projectId"); const claimId = required(params, "claimId"); const current = principal(request, authEnabled); if (current) await requireClaimReadAccess(projectId, claimId, current, authorization, claims); if (!(await claims.list(projectId)).some((item) => item.id === claimId)) throw new ApiError(404, "claim_not_found", "Claim not found"); return json(database.snapshot().claimEvidenceLinks.filter((link) => link.claimId === claimId)); }),
    route("GET", "/api/projects/:projectId/argument-graph", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:read"); const ledger = await claims.list(projectId); const visible = current ? filterVisibleClaims(ledger, current, projectId, authorization) : ledger; const visibleIds = new Set(visible.map((claim) => claim.id)); const persisted = database.snapshot().claimRelations.filter((item) => item.projectId === projectId && visibleIds.has(item.fromClaimId) && visibleIds.has(item.toClaimId)); const generated = deriveArgumentGraph(projectId, visible).filter((item) => !persisted.some((saved) => saved.fromClaimId === item.fromClaimId && saved.toClaimId === item.toClaimId)); return json({ projectId, relations: [...persisted, ...generated] }); }),
    route("POST", "/api/projects/:projectId/adversarial-memo", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:read"); const ledger = await claims.list(projectId); return json(buildAdversarialMemo(projectId, ledger, deriveArgumentGraph(projectId, ledger)), 201); }),
    route("POST", "/api/projects/:projectId/argument-graph/confirm", async (request, params) => { const projectId = required(params, "projectId"); const body = await readJson<{ fromClaimId: string; toClaimId: string; type: "motivates" | "addresses" | "implements" | "evaluates" | "supports" | "limits" }>(request); const projectClaims = await claims.list(projectId); if (!projectClaims.some((item) => item.id === body.fromClaimId) || !projectClaims.some((item) => item.id === body.toClaimId)) throw new ApiError(404, "claim_not_found", "Both claims must belong to the project"); const relation = { id: `relation_${crypto.randomUUID()}`, projectId, fromClaimId: body.fromClaimId, toClaimId: body.toClaimId, type: body.type, status: "confirmed" as const, origin: "user" as const }; await database.mutate((state) => { state.claimRelations.push(relation); }); return json(relation, 201); }),
    route("POST", "/api/projects/:projectId/claims/:claimId/reanchor", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) await requireClaimAccess(projectId, required(params, "claimId"), current, authorization, claims); return json(await claims.reanchor(projectId, required(params, "claimId"))); }),
    route("PATCH", "/api/projects/:projectId/claims/:claimId", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) await requireClaimAccess(projectId, required(params, "claimId"), current, authorization, claims); return json(await claims.update(projectId, required(params, "claimId"), await readJson<{ reviewStatus?: "detected" | "needs-review" | "supported" | "partial" | "unsupported" }>(request))); }),
    route("POST", "/api/projects/:projectId/claims/:claimId/links", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) await requireClaimAccess(projectId, required(params, "claimId"), current, authorization, claims); return json(await claims.link(projectId, required(params, "claimId"), await readJson<any>(request)), 201); }),
    route("DELETE", "/api/projects/:projectId/claims/:claimId/links/:linkId", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) await requireClaimAccess(projectId, required(params, "claimId"), current, authorization, claims); await claims.unlink(projectId, required(params, "claimId"), required(params, "linkId")); return new Response(null, { status: 204 }); }),
    route("GET", "/api/projects/:projectId/evidence", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:read"); workspaces.getProject(projectId); return json(database.snapshot().sourceEvidence.filter((item) => item.projectId === projectId)); }),
    route("POST", "/api/projects/:projectId/evidence", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:write"); workspaces.getProject(projectId); const body = await readJson<{ workId?: string; kind?: "background" | "claim" | "method" | "result" | "limitation" | "quote"; content?: string; locatorType?: "page" | "section" | "paragraph" | "abstract"; locator?: string; origin?: "source-text" | "registry-abstract" | "model-extraction" | "user"; representation?: "verbatim" | "paraphrase"; stance?: "supports" | "contradicts" | "mentions" | "unknown" }>(request); if (!body.workId || !body.content?.trim() || !body.locator) throw new ApiError(400, "evidence_invalid", "workId, content and locator are required"); const state = database.snapshot(); if (!state.researchWorks.some((work) => work.id === body.workId)) throw new ApiError(404, "research_work_not_found", "Research work not found"); const timestamp = new Date().toISOString(); return json(await database.mutate((current) => { const evidence = { id: `evidence_${crypto.randomUUID()}`, projectId, workId: body.workId!, kind: body.kind ?? "background", origin: body.origin ?? "user", representation: body.representation ?? "paraphrase", status: "candidate" as const, content: body.content!.trim().slice(0, 4000), locatorType: body.locatorType ?? "abstract", locator: body.locator!.trim().slice(0, 200), ...(body.stance ? { stance: body.stance } : {}), createdAt: timestamp, updatedAt: timestamp }; current.sourceEvidence.push(evidence); return evidence; }), 201); }),
    route("PATCH", "/api/projects/:projectId/evidence/:evidenceId", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:write"); const body = await readJson<{ status?: "candidate" | "approved" | "rejected" | "stale"; stance?: "supports" | "contradicts" | "mentions" | "unknown"; representation?: "verbatim" | "paraphrase" }>(request); return json(await claims.updateEvidence(projectId, required(params, "evidenceId"), body)); }),
    route("GET", "/api/texlive/:packageName", async (_request, params, url) => texPackages.texLiveArchive(required(params, "packageName"), url.searchParams.get("tlYear"))),
    route("GET", "/api/fetch/:packageName", async (_request, params, url) => texPackages.ctanPackage(required(params, "packageName"), url.searchParams.get("tlYear"))),
    route("GET", "/api/ctan-pkg/:packageName", async (_request, params) => texPackages.ctanPackageInfo(required(params, "packageName"))),
    route("GET", "/api/projects", async (request) => {
      const current = principal(request, false);
      return json(!authEnabled ? workspaces.listProjects() : workspaces.listProjects().filter((project) => current && authorization.projectRole(current.user.id, project.id)));
    }),
    route("POST", "/api/projects", async (request) => {
      const body = await readJson<CreateProjectRequest>(request);
      if (body.initializeFromTemplate) {
        if (!body.publicationTarget) throw new ApiError(400, "template_target_required", "Select a conference or journal before using its template");
        const venue = body.venue ?? body.publicationTarget.domain;
        const template = await latexTemplates.materialize(body.name, venue, body.publicationTarget);
        const project = await workspaces.importStagingDirectory({ stagingDirectory: template.stagingDirectory, name: body.name, mainDocument: template.mainDocument, venue, publicationTarget: body.publicationTarget, source: { type: "local", displayName: template.displayName } });
        await assignProjectOwner(project, principal(request, false), body.teamId);
        return json(project, 201);
      }
      const project = await workspaces.createEmpty(body.name, body.mainDocument, body.venue, body.publicationTarget);
      await assignProjectOwner(project, principal(request, false), body.teamId);
      return json(project, 201);
    }),
    route("GET", "/api/projects/:projectId", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:read"); return json(workspaces.getProject(projectId)); }),
    route("POST", "/api/projects/:projectId/transfer", async (request, params) => { const body = await readJson<{ teamId?: string; personalOwnerUserId?: string }>(request); await teams.transferProject(required(params, "projectId"), principal(request)!, body); return json(workspaces.getProject(required(params, "projectId"))); }),
    route("PATCH", "/api/projects/:projectId", async (request, params) => {
      const body = await readJson<{ name?: string; mainDocument?: string; venue?: TargetVenue; publicationTarget?: PublicationTarget | null }>(request);
      return json(await workspaces.updateProject(required(params, "projectId"), body));
    }),
    route("DELETE", "/api/projects/:projectId", async (request, params) => {
      const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:manage");
      await workspaces.deleteProject(projectId);
      return new Response(null, { status: 204 });
    }),
    route("GET", "/api/projects/:projectId/export", async (request, params) => {
      const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) await requireWorkspacePathAccess(projectId, current, authorization, "project:read", workspaces);
      return workspaces.exportProject(projectId);
    }),
    route("POST", "/api/projects/:projectId/history/checkpoint", async (_request, params) => {
      return json(await workspaces.createHistoryCheckpoint(required(params, "projectId")), 201);
    }),
    route("GET", "/api/projects/:projectId/history/working-status", async (_request, params) => {
      return json(await workspaces.workingStatus(required(params, "projectId")));
    }),
    route("POST", "/api/projects/:projectId/history/stage", async (request, params) => {
      const body = await readJson<{ paths?: string[] }>(request);
      await workspaces.stagePaths(required(params, "projectId"), body.paths ?? []);
      return new Response(null, { status: 204 });
    }),
    route("POST", "/api/projects/:projectId/history/unstage", async (request, params) => {
      const body = await readJson<{ paths?: string[] }>(request);
      await workspaces.unstagePaths(required(params, "projectId"), body.paths ?? []);
      return new Response(null, { status: 204 });
    }),
    route("POST", "/api/projects/:projectId/history/discard", async (request, params) => {
      const body = await readJson<{ paths?: string[] }>(request);
      await workspaces.discardPaths(required(params, "projectId"), body.paths ?? []);
      return new Response(null, { status: 204 });
    }),
    route("POST", "/api/projects/:projectId/history/commit", async (request, params) => {
      const body = await readJson<{ message?: string }>(request);
      const message = (body.message ?? "").trim();
      if (!message) throw new ApiError(400, "history_message_required", "A commit message is required");
      return json(await workspaces.commitWorking(required(params, "projectId"), message), 201);
    }),
    route("GET", "/api/projects/:projectId/history", async (request, params) => {
      const limit = Number(new URL(request.url).searchParams.get("limit") ?? "50");
      return json(await workspaces.history(required(params, "projectId"), Number.isFinite(limit) ? limit : 50));
    }),
    route("GET", "/api/projects/:projectId/history-page", async (request, params, url) => {
      const projectId = required(params, "projectId");
      const path = url.searchParams.get("path") ?? undefined;
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const current = principal(request, authEnabled);
      if (current && path) authorization.requireProjectPath(current, projectId, path, "project:read");
      return json(await workspaces.historyPage(projectId, { limit: Number(url.searchParams.get("limit") ?? 50), ...(path ? { path } : {}), ...(cursor ? { cursor } : {}) }));
    }),
    route("GET", "/api/projects/:projectId/history-working-changes", async (request, params, url) => {
      const projectId = required(params, "projectId");
      const current = principal(request, authEnabled);
      const changes = await workspaces.historyWorkingChanges(projectId, requiredQuery(url, "baseRef"));
      if (current) for (const file of changes.files) {
        authorization.requireProjectPath(current, projectId, file.path, "project:read");
        if (file.oldPath) authorization.requireProjectPath(current, projectId, file.oldPath, "project:read");
      }
      return json(changes);
    }),
    route("GET", "/api/projects/:projectId/history-working-compare", async (request, params, url) => {
      const projectId = required(params, "projectId"), path = requiredQuery(url, "path"), baseRef = requiredQuery(url, "baseRef");
      const oldPath = url.searchParams.get("oldPath") ?? undefined;
      const version = Number(requiredQuery(url, "projectVersion"));
      if (!Number.isSafeInteger(version) || version < 0) throw new ApiError(400, "history_version_required", "A projectVersion is required");
      const current = principal(request, authEnabled);
      if (current) { authorization.requireProjectPath(current, projectId, path, "project:read"); if (oldPath) authorization.requireProjectPath(current, projectId, oldPath, "project:read"); }
      return json(await workspaces.historyWorkingComparison(projectId, baseRef, path, version, oldPath));
    }),
    route("GET", "/api/projects/:projectId/history-changes", async (request, params, url) => {
      const projectId = required(params, "projectId");
      const current = principal(request, authEnabled);
      const changes = await workspaces.historyChanges(projectId, requiredQuery(url, "baseRef"), requiredQuery(url, "targetRef"));
      if (current) for (const file of changes.files) {
        authorization.requireProjectPath(current, projectId, file.path, "project:read");
        if (file.oldPath) authorization.requireProjectPath(current, projectId, file.oldPath, "project:read");
      }
      return json(changes);
    }),
    route("GET", "/api/projects/:projectId/history-compare", async (request, params, url) => {
      const projectId = required(params, "projectId");
      const path = url.searchParams.get("path");
      const baseRef = url.searchParams.get("baseRef");
      const targetRef = url.searchParams.get("targetRef");
      const oldPath = url.searchParams.get("oldPath") ?? undefined;
      if (!path || !baseRef || !targetRef) throw new ApiError(400, "history_compare_required", "baseRef, targetRef and path are required");
      const current = principal(request, authEnabled);
      if (current) { authorization.requireProjectPath(current, projectId, path, "project:read"); if (oldPath) authorization.requireProjectPath(current, projectId, oldPath, "project:read"); }
      return json(await workspaces.historyCompare(projectId, baseRef, targetRef, path, oldPath));
    }),
    route("GET", "/api/projects/:projectId/history/:oid", async (request, params) => {
      const projectId = required(params, "projectId");
      const summary = await workspaces.historySummary(projectId, required(params, "oid"));
      const current = principal(request, authEnabled);
      if (current) for (const file of summary.files) {
        authorization.requireProjectPath(current, projectId, file.path, "project:read");
        if (file.oldPath) authorization.requireProjectPath(current, projectId, file.oldPath, "project:read");
      }
      return json(summary);
    }),
    route("GET", "/api/projects/:projectId/history/:oid/tree", async (request, params) => {
      const projectId = required(params, "projectId");
      const tree = await workspaces.historyTree(projectId, required(params, "oid"));
      const current = principal(request, authEnabled);
      if (current) for (const file of tree) authorization.requireProjectPath(current, projectId, file.path, "project:read");
      return json(tree);
    }),
    route("GET", "/api/projects/:projectId/history/:oid/side", async (request, params, url) => {
      const path = url.searchParams.get("path");
      if (!path) throw new ApiError(400, "history_path_required", "path is required");
      const projectId = required(params, "projectId");
      const current = principal(request, authEnabled);
      if (current) authorization.requireProjectPath(current, projectId, path, "project:read");
      return json(await workspaces.historySide(projectId, required(params, "oid"), path));
    }),
    route("GET", "/api/projects/:projectId/history/:oid/file", async (request, params) => {
      const path = new URL(request.url).searchParams.get("path");
      if (!path) throw new ApiError(400, "history_path_required", "path is required");
      const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProjectPath(current, projectId, path, "project:read");
      return json({ path, content: await workspaces.historyFile(projectId, required(params, "oid"), path) });
    }),
    route("POST", "/api/projects/:projectId/history/:oid/restore", async (request, params) => {
      const body = await readJson<{ paths?: string[]; expectedVersion?: number }>(request);
      if (!Array.isArray(body.paths) || !body.paths.length || body.paths.some((path) => typeof path !== "string" || !path.trim())) throw new ApiError(400, "history_paths_required", "Provide one or more workspace-relative paths to restore");
      const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) for (const path of body.paths) authorization.requireProjectPath(current, projectId, path, "project:write");
      if (body.expectedVersion !== undefined && (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1)) throw new ApiError(400, "invalid_version", "expectedVersion must be a positive integer");
      return json(await workspaces.restoreHistoryFiles(projectId, required(params, "oid"), body.paths, body.expectedVersion));
    }),
    route("POST", "/api/projects/:projectId/github-sync", async (request, params) => {
      const projectId = required(params, "projectId"); await collaboration.flushProject(projectId);
      const current = principal(request, authEnabled); if (current) await requireWorkspacePathAccess(projectId, current, authorization, "github:sync", workspaces);
      return json(await githubSync.start(projectId), 201);
    }),
    route("POST", "/api/projects/:projectId/github-sync/:syncId/resolve", async (request, params) => {
      const body = await readJson<{ resolutions: GithubSyncResolution[] }>(request);
      return json(await githubSync.resolve(required(params, "projectId"), required(params, "syncId"), body.resolutions));
    }),
    route("POST", "/api/projects/:projectId/github-sync/:syncId/finalize", async (_request, params) => {
      return json(await githubSync.finalize(required(params, "projectId"), required(params, "syncId")));
    }),
    route("GET", "/api/projects/:projectId/files", async (request, params, url) => {
      const projectId = required(params, "projectId"); const directory = url.searchParams.get("directory"); const current = principal(request, authEnabled); const support = supportGrant(request, projectId, directory ?? "", current);
      if (current) { authorization.requireProject(current, projectId, "project:read"); if (directory !== null) authorization.requireProjectPath(current, projectId, directory, "project:read"); }
      const tree = directory === null ? await workspaces.tree(projectId) : await workspaces.treeLevel(projectId, directory);
      return json(current ? filterVisibleTree(tree, current, projectId, authorization) : support ? filterSupportTree(tree, support.path) : tree);
    }),
    route("GET", "/api/projects/:projectId/file", async (request, params, url) => {
      const projectId = required(params, "projectId"); const path = requiredQuery(url, "path"); const current = principal(request, authEnabled); const support = supportGrant(request, projectId, path, current); if (current) authorization.requireProjectPath(current, projectId, path, "project:read");
      return json(await workspaces.readTextFile(projectId, path));
    }),
    route("GET", "/api/projects/:projectId/asset", async (request, params, url) => {
      const projectId = required(params, "projectId"); const path = requiredQuery(url, "path"); const current = principal(request, authEnabled); const support = supportGrant(request, projectId, path, current); if (current) authorization.requireProjectPath(current, projectId, path, "project:read");
      return workspaces.readAsset(projectId, path);
    }),
    route("PUT", "/api/projects/:projectId/file", async (request, params, url) => {
      const body = await readJson<SaveFileRequest>(request);
      const projectId = required(params, "projectId");
      const path = requiredQuery(url, "path"); const current = principal(request, authEnabled); if (current) authorization.requireProjectPath(current, projectId, path, "project:write");
      const saved = await workspaces.saveTextFile(projectId, path, body);
      await claims.refresh(projectId);
      return json(saved);
    }),
    route("POST", "/api/projects/:projectId/files", async (request, params) => {
      const body = await readJson<{ path: string; content?: string }>(request);
      const projectId = required(params, "projectId");
      const current = principal(request, authEnabled); if (current) authorization.requireProjectPath(current, projectId, body.path, "project:write");
      const created = await workspaces.createFile(projectId, body.path, body.content ?? "");
      if (/^references\/fastread\/[0-9a-f]{24}\/manifest\.json$/.test(created.path)) await research.tryImportFastReadBundle(projectId, created.path);
      return json(created, 201);
    }),
    route("PUT", "/api/projects/:projectId/assets", async (request, params, url) => {
      const projectId = required(params, "projectId"); const path = requiredQuery(url, "path"); const current = principal(request, authEnabled); if (current) authorization.requireProjectPath(current, projectId, path, "project:write");
      return json(await workspaces.addFile(projectId, path, await request.arrayBuffer()), 201);
    }),
    route("PATCH", "/api/projects/:projectId/files", async (request, params) => {
      const body = await readJson<{ from: string; to: string }>(request);
      const projectId = required(params, "projectId");
      const current = principal(request, authEnabled); if (current) { authorization.requireProjectPath(current, projectId, body.from, "project:write"); authorization.requireProjectPath(current, projectId, body.to, "project:write"); }
      await workspaces.renamePath(projectId, body.from, body.to);
      await collaboration.renamePath(projectId, normalizeWorkspacePath(body.from), normalizeWorkspacePath(body.to));
      await claims.renamePath(projectId, body.from, body.to);
      return new Response(null, { status: 204 });
    }),
    route("DELETE", "/api/projects/:projectId/files", async (request, params, url) => {
      const projectId = required(params, "projectId");
      const path = requiredQuery(url, "path");
      const current = principal(request, authEnabled); if (current) authorization.requireProjectPath(current, projectId, path, "project:write");
      await workspaces.deletePath(projectId, path);
      await collaboration.archivePath(projectId, path);
      await claims.deletePath(projectId, path);
      return new Response(null, { status: 204 });
    }),
    route("GET", "/api/projects/:projectId/outline", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:read"); const outline = await workspaces.outline(projectId); return json(current ? filterVisibleOutline(outline, current, projectId, authorization) : outline); }),
    route("GET", "/api/projects/:projectId/search", async (request, params, url) => { const projectId = required(params, "projectId"); const current = principal(request, true)!; return json(await projectSearch.search(projectId, current, url.searchParams.get("query") ?? "")); }),
    route("GET", "/api/projects/:projectId/skills", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:read"); return json(workspaces.getProject(projectId).skill); }),
    route("POST", "/api/projects/:projectId/completions", async (request, params) => {
      const projectId = required(params, "projectId"); const body = await readJson<CompletionRequest>(request); const current = principal(request, authEnabled); if (current) authorization.requireProjectPath(current, projectId, body.path, "agent:propose"); await collaboration.flushProject(projectId);
      return json(await completions.suggest(projectId, body), 201);
    }),
    route("POST", "/api/projects/:projectId/revisions", async (request, params) => {
      const projectId = required(params, "projectId"); const body = await readJson<ReviseRequest>(request); const current = principal(request, authEnabled); if (current) authorization.requireProjectPath(current, projectId, body.selection.path, "agent:propose"); await collaboration.flushProject(projectId);
      return json(await revisions.propose(projectId, body), 201);
    }),
    route("POST", "/api/projects/:projectId/table-equation-candidates", async (request, params) => {
      const projectId = required(params, "projectId");
      const current = principal(request, authEnabled);
      const body = await readJson<{ kind: "table" | "equation"; targetPath: string; sourceFormat: "csv" | "natural-language" | "latex"; source: string; caption?: string; label?: string }>(request);
      if (!new Set(["table", "equation"]).has(body.kind) || !new Set(["csv", "natural-language", "latex"]).has(body.sourceFormat)) throw new ApiError(400, "candidate_invalid", "Candidate kind or source format is invalid");
      const targetPath = normalizeWorkspacePath(body.targetPath);
      if (!/\.tex$/i.test(targetPath) || body.source.length > 100_000) throw new ApiError(400, "candidate_invalid", "Target must be a TeX path and source must be bounded");
      if (current) authorization.requireProjectPath(current, projectId, targetPath, "agent:propose");
      const opened = await workspaces.fileExists(projectId, targetPath) ? await workspaces.readTextFile(projectId, targetPath) : undefined;
      const generated = body.kind === "table" ? tableCandidate(body.source, body.sourceFormat, body.caption, body.label) : equationCandidate(body.source, body.sourceFormat, body.label);
      const change = opened ? { operation: "replace" as const, path: targetPath, from: opened.content.length, to: opened.content.length, before: "", after: `\n${generated.content}`, baseVersion: opened.file.version, baseContent: opened.content } : { operation: "create" as const, path: targetPath, from: 0, to: 0, before: "", after: generated.content, baseVersion: 0, baseContent: "" };
      const changeSet = { id: `change_${crypto.randomUUID()}`, projectId, agentRunId: `assistant_${crypto.randomUUID()}`, status: "proposed" as const, approvalMode: "explicit-finish" as const, summary: `Propose ${body.kind} in ${targetPath}`, rationale: "Generated from bounded user input; review the ChangeSet and compile before applying.", changes: [{ ...change, currentVersion: change.baseVersion }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await database.mutate((state) => state.changeSets.push(changeSet));
      return json({ kind: body.kind, projectId, targetPath, sourceFormat: body.sourceFormat, schema: generated.schema, preview: generated.content.slice(0, 4000), changeSet, compileCheck: { status: "not-run" as const } }, 201);
    }),
    route("POST", "/api/projects/:projectId/table-equation-candidates/:changeSetId/compile-check", async (request, params) => {
      const projectId = required(params, "projectId");
      const changeSetId = required(params, "changeSetId");
      const changeSet = database.snapshot().changeSets.find((candidate) => candidate.projectId === projectId && candidate.id === changeSetId);
      if (!changeSet) throw new ApiError(404, "changeset_not_found", "Candidate ChangeSet not found");
      const change = changeSet.changes[0];
      if (!change) throw new ApiError(400, "candidate_invalid", "Candidate ChangeSet has no file change");
      const result = validateLatexCandidate(change.after);
      return json({ status: result.status, message: result.message, changeSetId });
    }),
    route("GET", "/api/projects/:projectId/drafts", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:read"); return json(drafts.list(projectId)); }),
    route("POST", "/api/projects/:projectId/drafts", async (request, params) => {
      const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) await requireWorkspacePathAccess(projectId, current, authorization, "agent:propose", workspaces); await collaboration.flushProject(projectId);
      return json(await drafts.plan(projectId, await readJson<DraftRequest>(request), request.signal), 201);
    }),
    route("POST", "/api/projects/:projectId/drafts/:draftId/confirm", async (request, params) => {
      const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) await requireWorkspacePathAccess(projectId, current, authorization, "agent:propose", workspaces);
      const body = await readJson<{ outline: DraftOutlineSection[] }>(request);
      return json(await drafts.confirm(projectId, required(params, "draftId"), body.outline, request.signal), 201);
    }),
    route("POST", "/api/projects/:projectId/drafts/:draftId/cancel", async (request, params) => {
      const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:write");
      return json(await drafts.cancel(projectId, required(params, "draftId")));
    }),
    route("GET", "/api/projects/:projectId/reviews", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:read"); const reports = reviews.list(projectId); return json(current ? filterVisibleReviewReports(reports, projectId, current, authorization, database) : reports); }),
    route("GET", "/api/projects/:projectId/reviews/coverage", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:read"); const reports = current ? filterVisibleReviewReports(reviews.list(projectId), projectId, current, authorization, database) : reviews.list(projectId); const latest = reports[0]; const passes = latest?.passes ?? []; return json({ ...reviews.coverage(projectId), inputBoundary: latest?.coverage?.inputBoundary ?? passes.map((pass) => pass.inputBoundary).find(Boolean) }); }),
    route("POST", "/api/projects/:projectId/reviews", async (request, params) => {
      const body = await readJson<{ sourceOnly?: boolean; pageText?: string[] }>(request);
      if (body.pageText !== undefined && (!Array.isArray(body.pageText) || body.pageText.some((item) => typeof item !== "string") || body.pageText.length > 20 || body.pageText.reduce((total, item) => total + item.length, 0) > 200_000)) throw new ApiError(400, "review_pdf_preview_invalid", "PDF preview text exceeds the bounded review input limits");
      const projectId = required(params, "projectId"); const current = principal(request, authEnabled); const visiblePaths = current ? await visibleTextPaths(projectId, current, authorization, "review:run", workspaces) : undefined; await collaboration.flushProject(projectId);
      return json(await reviews.run(projectId, body.sourceOnly === true, request.signal, body.pageText ?? [], visiblePaths), 201);
    }),
    route("PATCH", "/api/projects/:projectId/review-issues/:issueId", async (request, params) => {
      const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) requireReviewIssueAccess(projectId, required(params, "issueId"), current, authorization, database);
      return json(await reviews.updateIssue(projectId, required(params, "issueId"), await readJson<{ status?: ReviewIssueStatus; priority?: number; reason?: string }>(request)));
    }),
    route("POST", "/api/projects/:projectId/review-issues", async (request, params) => { const projectId = required(params, "projectId"); const body = await readJson<Parameters<ReviewService["createIssue"]>[1]>(request); const current = principal(request, authEnabled); if (current) requireReviewReportAccess(projectId, body.reportId ?? reviews.list(projectId)[0]?.id, current, authorization, database); return json(await reviews.createIssue(projectId, body), 201); }),
    route("POST", "/api/projects/:projectId/review-issues/:issueId/merge", async (request, params) => { const projectId = required(params, "projectId"); const body = await readJson<{ duplicateIds: string[]; reason?: string }>(request); const current = principal(request, authEnabled); if (current) for (const issueId of [required(params, "issueId"), ...body.duplicateIds]) requireReviewIssueAccess(projectId, issueId, current, authorization, database); return json(await reviews.mergeIssues(projectId, required(params, "issueId"), body.duplicateIds, body.reason)); }),
    route("GET", "/api/projects/:projectId/memory", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:read"); return json(await memories.get(projectId)); }),
    route("POST", "/api/projects/:projectId/memory/extract", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) await requireWorkspacePathAccess(projectId, current, authorization, "project:read", workspaces); return json(await memories.extract(projectId), 201); }),
    route("POST", "/api/projects/:projectId/memory/apply", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) await requireWorkspacePathAccess(projectId, current, authorization, "project:write", workspaces); return json(await memories.applyReviewed(projectId)); }),
    route("PATCH", "/api/projects/:projectId/memory/overview", async (request, params) => {
      const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:write");
      const body = await readJson<{ content: string; locked?: boolean }>(request);
      return json(await memories.updateOverview(projectId, body.content, body.locked !== false, request.signal));
    }),
    route("POST", "/api/projects/:projectId/memory/overview/accept", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:write"); return json(await memories.acceptOverviewCandidate(projectId)); }),
    route("PATCH", "/api/projects/:projectId/memory/sections/:sectionId", async (request, params) => {
      const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:write");
      const body = await readJson<{ content: string; locked?: boolean }>(request);
      return json(await memories.updateSection(projectId, required(params, "sectionId"), body.content, body.locked !== false, request.signal));
    }),
    route("POST", "/api/projects/:projectId/memory/sections/:sectionId/accept", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:write"); return json(await memories.acceptSectionCandidate(projectId, required(params, "sectionId"))); }),
    route("PATCH", "/api/projects/:projectId/memory/items/:itemId", async (request, params) => {
      const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:write");
      return json(await memories.updateItem(projectId, required(params, "itemId"), await readJson<{ status?: MemoryItemStatus; content?: string; label?: string }>(request), request.signal));
    }),
    route("POST", "/api/projects/:projectId/memory/items/:itemId/accept", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:write"); return json(await memories.acceptItemCandidate(projectId, required(params, "itemId"))); }),
    route("POST", "/api/projects/:projectId/memory/rollback", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:write"); return json(await memories.rollback(projectId)); }),
    route("GET", "/api/projects/:projectId/agent-tasks", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:read"); return json(agentTasks.list(projectId)); }),
    route("GET", "/api/projects/:projectId/agent-runs", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:read"); workspaces.getProject(projectId); return json(database.snapshot().agentRuns.filter((run) => run.projectId === projectId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))); }),
    route("GET", "/api/projects/:projectId/provenance", async (request, params) => {
      const projectId = required(params, "projectId");
      const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:read");
      const project = workspaces.getProject(projectId);
      const state = database.snapshot();
      const runs = state.agentRuns.filter((run) => run.projectId === projectId).map((run) => ({ id: run.id, type: run.type, status: run.status, objective: run.objective, skill: run.skill, publicationTarget: run.publicationTarget, changeSetId: run.changeSetId, createdAt: run.createdAt, updatedAt: run.updatedAt, auditTrail: run.auditTrail ?? [] }));
      const changeSets = state.changeSets.filter((changeSet) => changeSet.projectId === projectId).map((changeSet) => ({ id: changeSet.id, agentRunId: changeSet.agentRunId, status: changeSet.status, summary: changeSet.summary, rationale: changeSet.rationale, baseCheckpointOid: changeSet.baseCheckpointOid, appliedCheckpointOids: changeSet.appliedCheckpointOids, reviewFinishedAt: changeSet.reviewFinishedAt, createdAt: changeSet.createdAt, updatedAt: changeSet.updatedAt, changes: changeSet.changes.map((change) => ({ path: change.path, operation: change.operation, appliedVersion: change.appliedVersion, hunks: (change.hunks ?? []).map((hunk) => ({ id: hunk.id, status: hunk.status, rationale: hunk.rationale, findings: hunk.findings, additions: classifyHunkAdditions(hunk.after) })) })) }));
      const experiments = state.experimentRuns.filter((run) => run.projectId === projectId).map((run) => ({ id: run.id, projectVersion: run.projectVersion, scriptPath: run.scriptPath, status: run.status, authorization: run.authorization, inputSnapshotHash: run.inputSnapshotHash, result: run.result ? { success: run.result.success, exitCode: run.result.exitCode, artifactPaths: run.result.artifactPaths, runId: run.result.runId } : undefined, jobId: run.jobId, createdAt: run.createdAt, updatedAt: run.updatedAt }));
      const aiRuns = runs.filter((run) => run.type !== "review");
      const venueLabel = project.publicationTarget?.venueId ?? project.skill.venue;
      const disclosureDraft = aiRuns.length
        ? `AI usage disclosure (${venueLabel}): During preparation of this manuscript, the authors used FastWrite AI-assisted workflows for ${[...new Set(aiRuns.map((run) => run.type))].join(", ")} operations. All generated changes were reviewed and approved by the authors; the authors remain responsible for the final content, claims, citations, and compliance. This statement should be checked against the selected venue's current author instructions before submission.`
        : "No AI-assisted writing operation is recorded for this project.";
      return json({ project: { id: project.id, version: project.version, mainDocument: project.mainDocument, skill: project.skill, publicationTarget: project.publicationTarget }, generatedAt: new Date().toISOString(), disclosureDraft, runs, changeSets, experiments });
    }),
    route("GET", "/api/projects/:projectId/provenance/export", async (request, params) => {
      const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:read");
      const project = workspaces.getProject(projectId); const state = database.snapshot();
      const runs = state.agentRuns.filter((run) => run.projectId === projectId).map((run) => ({ id: run.id, type: run.type, status: run.status, objective: run.objective, createdAt: run.createdAt, updatedAt: run.updatedAt, skill: run.skill, publicationTarget: run.publicationTarget, auditTrail: run.auditTrail ?? [] }));
      const changeSets = state.changeSets.filter((item) => item.projectId === projectId).map((item) => ({ id: item.id, status: item.status, summary: item.summary, agentRunId: item.agentRunId, changes: item.changes.map((change) => ({ path: change.path, operation: change.operation, hunks: (change.hunks ?? []).map((hunk) => ({ id: hunk.id, status: hunk.status, additions: classifyHunkAdditions(hunk.after) })) })) }));
      const payload = JSON.stringify({ project: { id: project.id, version: project.version, mainDocument: project.mainDocument, skill: project.skill, publicationTarget: project.publicationTarget }, generatedAt: new Date().toISOString(), runs, changeSets }, null, 2);
      return new Response(payload, { headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="fastwrite-provenance-${projectId}.json"` } });
    }),
    route("POST", "/api/projects/:projectId/agent-tasks", async (request, params) => { const projectId = required(params, "projectId"); await collaboration.flushProject(projectId); const current = principal(request, authEnabled); if (current) await requireWorkspacePathAccess(projectId, current, authorization, "agent:propose", workspaces); return json(await agentTasks.plan(projectId, await readJson<AgentTaskRequest>(request), request.signal), 201); }),
    route("POST", "/api/projects/:projectId/agent-tasks/:planId/confirm", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) await requireWorkspacePathAccess(projectId, current, authorization, "agent:propose", workspaces); return json(await agentTasks.confirm(projectId, required(params, "planId"), request.signal), 201); }),
    route("POST", "/api/projects/:projectId/agent-tasks/:planId/cancel", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:write"); return json(await agentTasks.cancel(projectId, required(params, "planId"))); }),
    route("GET", "/api/projects/:projectId/issue-resolutions", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:read"); return json(agentTasks.resolutions(projectId)); }),
    route("POST", "/api/projects/:projectId/issue-resolutions/:resolutionId/rereview", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:write"); return json(await agentTasks.rereview(projectId, required(params, "resolutionId"), request.signal)); }),
    route("POST", "/api/projects/:projectId/issue-resolutions/:resolutionId/reopen", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:write"); return json(await agentTasks.reopen(projectId, required(params, "resolutionId"))); }),
    route("GET", "/api/projects/:projectId/compile-results/latest", async (request, params) => {
      const projectId = required(params, "projectId");
      const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:read");
      workspaces.getProject(projectId);
      return json(database.snapshot().compileRecords.filter((record) => record.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null);
    }),
    route("POST", "/api/projects/:projectId/compile", async (request, params) => { const projectId = required(params, "projectId"); await collaboration.flushProject(projectId); const current = principal(request, authEnabled); if (current) await requireWorkspacePathAccess(projectId, current, authorization, "compile:run", workspaces); const paths = current ? await visibleTextPaths(projectId, current, authorization, "compile:run", workspaces) : []; const job = jobs.enqueue("latex.compile", { projectId }, async ({ projectId: queuedProjectId }) => { const result = await latexCompiler.compile(queuedProjectId); if (current) await requireWorkspacePathAccess(queuedProjectId, current, authorization, "compile:run", workspaces); return result; }, { policy: { ...(current ? { actorUserId: current.user.id, authorizationVersion: current.user.authzVersion, action: "compile:run", paths } : {}), projectId, projectVersion: workspaces.getProject(projectId).version }, recheck: async () => { if (current) await requireWorkspacePathAccess(projectId, current, authorization, "compile:run", workspaces); } }); return json(job, 202); }),
    route("POST", "/api/projects/:projectId/experiments", async (request, params) => {
      const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) await requireWorkspacePathAccess(projectId, current, authorization, "compile:run", workspaces);
      const body = await readJson<{ scriptPath: string; authorization: "user-approved"; timeoutMs?: number; memoryLimitMb?: number; cpuSeconds?: number }>(request);
      if (body.authorization !== "user-approved") throw new ApiError(403, "experiment_authorization_required", "Experiment execution requires explicit user authorization.");
      let job: JobRecord;
      const experimentId = `experiment_${crypto.randomUUID()}`;
      const projectVersion = workspaces.getProject(projectId).version;
      await database.mutate((state) => { state.experimentRuns.push({ id: experimentId, projectId, projectVersion, scriptPath: body.scriptPath, status: "queued", authorization: "user-approved", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); });
      try { job = jobs.enqueue("experiment.run", { experimentId, projectId, scriptPath: body.scriptPath, authorization: body.authorization, timeoutMs: body.timeoutMs, memoryLimitMb: body.memoryLimitMb, cpuSeconds: body.cpuSeconds }, async (input) => { await database.mutate((state) => { const run = state.experimentRuns.find((item) => item.id === experimentId); if (run) { run.status = "running"; run.updatedAt = new Date().toISOString(); } }); try { const result = await experiments.run(input as Parameters<ExperimentRunner["run"]>[0]); await database.mutate((state) => { const run = state.experimentRuns.find((item) => item.id === experimentId); if (run) { run.status = result.success ? "completed" : "failed"; run.inputSnapshotHash = result.inputSnapshotHash; run.result = result; run.updatedAt = new Date().toISOString(); } }); return result; } catch (error) { await database.mutate((state) => { const run = state.experimentRuns.find((item) => item.id === experimentId); if (run) { run.status = "failed"; run.updatedAt = new Date().toISOString(); } }); throw error; } }, { start: process.env.FASTWRITE_JOB_WORKER_MODE !== "external", policy: { ...(current ? { actorUserId: current.user.id, authorizationVersion: current.user.authzVersion, action: "compile:run" } : {}), projectId, projectVersion }, recheck: async () => { if (current) await requireWorkspacePathAccess(projectId, current, authorization, "compile:run", workspaces); } }); await database.mutate((state) => { const run = state.experimentRuns.find((item) => item.id === experimentId); if (run) { run.jobId = job.id; run.updatedAt = new Date().toISOString(); } }); }
      catch (error) { if (error instanceof Error && error.message === "job_quota_exceeded") throw new ApiError(429, "job_quota_exceeded", "Too many active jobs; retry later."); throw error; }
      return json(job, 202);
    }),
    route("GET", "/api/projects/:projectId/experiments", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:read"); workspaces.getProject(projectId); return json(database.snapshot().experimentRuns.filter((run) => run.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))); }),
    route("GET", "/api/jobs/:jobId", async (request, params) => { const job = jobs.get(required(params, "jobId")); if (!job) throw new ApiError(404, "job_not_found", "Job not found"); const current = principal(request, authEnabled); authorizeJob(request, job, current); if (current && job.policy?.projectId) authorization.requireProject(current, job.policy.projectId, "project:read"); return json(job); }),
    route("POST", "/api/jobs/:jobId/progress", async (request, params) => { const job = jobs.get(required(params, "jobId")); if (!job) throw new ApiError(404, "job_not_found", "Job not found"); const current = principal(request, authEnabled); authorizeJob(request, job, current); if (current && job.policy?.projectId) authorization.requireProject(current, job.policy.projectId, "project:write"); const body = await readJson<{ completed: number; total?: number; message?: string }>(request); if (!Number.isFinite(body.completed) || (body.total !== undefined && !Number.isFinite(body.total))) throw new ApiError(400, "job_progress_invalid", "Job progress must contain finite numbers"); try { return json(jobs.updateProgress(job.id, body)); } catch (error) { if (error instanceof Error && error.message === "Job is not active") throw new ApiError(409, "job_not_active", "Job is no longer active"); throw error; } }),
    route("POST", "/api/jobs/:jobId/cancel", async (request, params) => { try { const job = jobs.get(required(params, "jobId")); if (!job) throw new ApiError(404, "job_not_found", "Job not found"); const current = principal(request, authEnabled); authorizeJob(request, job, current); if (current && job.policy?.projectId) authorization.requireProject(current, job.policy.projectId, "project:manage"); return json(jobs.cancel(job.id)); } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(404, "job_not_found", "Job not found"); } }),
    route("POST", "/api/projects/:projectId/compile-results", async (request, params) => {
      const projectId = required(params, "projectId");
      const current = principal(request, authEnabled); if (current) authorization.requireProject(current, projectId, "project:write");
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
          if (run) { run.auditTrail ??= []; run.auditTrail.push({ id: `audit_${crypto.randomUUID()}`, action: "compile", summary: `Local LaTeX compile ${record.status} for project version ${record.projectVersion}`, createdAt: record.createdAt }); run.updatedAt = record.createdAt; }
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
      const projectId = required(params, "projectId");
      const accepted = await revisions.accept(projectId, required(params, "changeSetId"));
      await claims.refresh(projectId);
      return json(accepted);
    }),
    route("POST", "/api/projects/:projectId/change-sets/:changeSetId/decide", async (request, params) => {
      const projectId = required(params, "projectId");
      const decided = await revisions.decide(projectId, required(params, "changeSetId"), await readJson<ChangeSetDecisionRequest>(request));
      await claims.refresh(projectId);
      return json(decided);
    }),
    route("POST", "/api/projects/:projectId/change-sets/:changeSetId/finish", async (_request, params) => {
      const projectId = required(params, "projectId");
      const finished = await revisions.finishReview(projectId, required(params, "changeSetId"));
      await claims.refresh(projectId);
      return json(finished);
    }),
    route("POST", "/api/projects/:projectId/change-sets/:changeSetId/reject", async (_request, params) => {
      return json(await revisions.reject(required(params, "projectId"), required(params, "changeSetId")));
    }),
    route("POST", "/api/projects/:projectId/change-sets/:changeSetId/rollback", async (request, params) => {
      const body = request.headers.get("content-length") === "0" || !request.headers.get("content-type")?.includes("application/json") ? {} : await readJson<{ resolutions?: Array<{ path: string; currentVersion: number; content: string }> }>(request);
      const projectId = required(params, "projectId");
      const rolledBack = await revisions.rollback(projectId, required(params, "changeSetId"), body.resolutions ?? []);
      await claims.refresh(projectId);
      return json(rolledBack);
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

function classifyHunkAdditions(after: string): { claims: boolean; citations: boolean; numbers: boolean; experimentalConclusions: boolean } {
  return { claims: /\b(?:we|our|this work|results? show|demonstrate|achieve)\b/i.test(after), citations: /\\(?:cite|citep|citet|autocite)\b|\[[^\]]*\d{4}[^\]]*\]/i.test(after), numbers: /\b\d+(?:\.\d+)?\s*(?:%|ms|s|m|k|mb|gb|x)?\b/i.test(after), experimentalConclusions: /\b(?:improv|outperform|significant|accuracy|f1|auc|recall|precision)\b/i.test(after) };
}

function tableCandidate(source: string, format: "csv" | "natural-language" | "latex", caption?: string, label?: string): { content: string; schema: { columns?: string[]; rows?: number } } {
  if (format === "latex") {
    if (!/\\begin\{tabular\}/.test(source) || /\\(?:input|include|write18|openin|openout)\b/.test(source)) throw new ApiError(400, "table_source_invalid", "LaTeX table must contain tabular and no file or shell commands");
    return { content: source.trim(), schema: {} };
  }
  const rows = format === "csv" ? source.trim().split(/\r?\n/).filter(Boolean).map((line) => line.split(",").map((cell) => cell.trim())) : [[source.trim()]];
  if (!rows.length || rows.length > 200 || rows.some((row) => row.length > 30)) throw new ApiError(400, "table_source_invalid", "Table input has too many rows or columns");
  const columns = rows[0]!.map((cell, index) => cell || `Column ${index + 1}`);
  const body = rows.slice(1).map((row) => `${row.map((cell) => escapeLatex(cell)).join(" & ")} \\\\`).join("\n");
  const content = `\\begin{table}[t]\n\\centering\n${caption?.trim() ? `\\caption{${escapeLatex(caption.trim())}}\n` : ""}${label?.trim() ? `\\label{${safeLabel(label)} }\n` : ""}\\begin{tabular}{${"l".repeat(columns.length)}}\n${columns.map(escapeLatex).join(" & ")} \\\\ \\hline\n${body}\n\\end{tabular}\n\\end{table}\n`;
  return { content, schema: { columns, rows: Math.max(0, rows.length - 1) } };
}

function equationCandidate(source: string, format: "natural-language" | "latex" | "csv", label?: string): { content: string; schema: { variables?: string[] } } {
  const expression = source.trim();
  if (!expression || expression.length > 4000 || /\\(?:input|include|write18|openin|openout)\b/.test(expression)) throw new ApiError(400, "equation_source_invalid", "Equation input is empty, too large, or contains file commands");
  const content = `\\begin{equation}\n${expression}\n${label?.trim() ? `\\label{${safeLabel(label)}}\n` : ""}\\end{equation}\n`;
  const variables = [...new Set(expression.match(/\\?[A-Za-z][A-Za-z0-9_]*/g) ?? [])].filter((item) => !/^\\?(?:frac|sum|sqrt|text|mathrm|mathbf)$/.test(item)).slice(0, 100);
  return { content, schema: { variables } };
}

function escapeLatex(value: string): string { return value.replace(/[&%$#_{}~^\\]/g, (character) => ({ "&": "\\&", "%": "\\%", "$": "\\$", "#": "\\#", _: "\\_", "{": "\\{", "}": "\\}", "~": "\\textasciitilde{}", "^": "\\textasciicircum{}", "\\": "\\textbackslash{}" }[character] ?? character)); }
function safeLabel(value: string): string { return value.replace(/[^A-Za-z0-9:._-]/g, "-").slice(0, 120); }
function validateLatexCandidate(content: string): { status: "passed" | "failed"; message: string } {
  if (/\\(?:input|include|write18|openin|openout)\b/.test(content)) return { status: "failed", message: "Candidate contains disallowed file or shell commands." };
  const environments = [...content.matchAll(/\\(begin|end)\{([^}]+)\}/g)].map((match) => `${match[1]}:${match[2]}`);
  const stack: string[] = [];
  for (const item of environments) { const [kind, name] = item.split(":"); if (kind === "begin") stack.push(name!); else if (stack.pop() !== name) return { status: "failed", message: `Unbalanced LaTeX environment near ${name}.` }; }
  if (stack.length) return { status: "failed", message: `Unclosed LaTeX environment ${stack.at(-1)}.` };
  return { status: "passed", message: "Balanced environments and no disallowed commands detected. Full project compile is still required." };
}

function shareTokenHash(token: string): string { return new Bun.CryptoHasher("sha256").update(token).digest("hex"); }
function activeShare(shares: Array<{ tokenHash: string; revokedAt?: string; expiresAt?: string }>, token: string) {
  const share = shares.find((item) => item.tokenHash === shareTokenHash(token));
  if (!share || share.revokedAt || (share.expiresAt && Date.parse(share.expiresAt) <= Date.now())) throw new ApiError(404, "share_not_found", "Share link not found or expired");
  return share as typeof share & { id: string; projectId: string; permission: "read" | "comment" };
}

function supportGrant(request: Request, projectId: string, path: string, actor?: Principal): { path: string } | undefined {
  const header = request.headers.get("x-fastwrite-support-grant");
  if (!header) return undefined;
  let grant: { projectId?: string; path?: string; expiresAt?: string; scope?: string; authorized?: boolean; userId?: string; sessionId?: string };
  try { grant = JSON.parse(header); } catch { throw new ApiError(403, "support_grant_invalid", "Support grant is invalid"); }
  if (grant.authorized !== true || grant.scope !== "read" || grant.projectId !== projectId || !grant.path || !grant.expiresAt || !grant.userId || !grant.sessionId || !actor || grant.userId !== actor.user.id || grant.sessionId !== actor.sessionId || Date.parse(grant.expiresAt) <= Date.now()) throw new ApiError(403, "support_grant_expired", "Support grant is invalid or expired");
  const normalized = normalizeWorkspacePath(path);
  const prefix = normalizeWorkspacePath(grant.path);
  if (!(normalized === prefix || normalized.startsWith(`${prefix}/`) || prefix === "")) throw new ApiError(403, "support_grant_scope_denied", "Path is outside the support grant scope");
  return { path: prefix };
}

function textPaths(nodes: any[]): string[] { return nodes.flatMap((node) => node.type === "directory" ? textPaths(node.children) : node.kind === "text" ? [node.path] : []); }

function requiredQuery(url: URL, key: string): string {
  const value = url.searchParams.get(key);
  if (!value) throw new ApiError(400, "missing_parameter", `Missing query parameter '${key}'`);
  return value;
}

function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new ApiError(403, "csrf_origin_invalid", "Cross-origin requests are not allowed");
}

function identityGroups(issuer: string, groups: string[]): string[] {
  const normalizedIssuer = issuer.trim().replace(/\/$/, "");
  if (!normalizedIssuer) return [];
  return [...new Set(groups.filter((group) => typeof group === "string").map((group) => group.trim()).filter((group) => group.length > 0 && group.length <= 256).map((group) => `${normalizedIssuer}:${group}`))];
}

function authResponse(result: AuthResult, status = 200): Response {
  return json({ user: result.user, token: result.token }, status, { "set-cookie": refreshCookie(result.refreshToken) });
}

function refreshCookie(token: string): string {
  return [`fastwrite.refresh=${token}`, "HttpOnly", "SameSite=Lax", "Path=/api/auth", "Max-Age=2592000", ...(process.env.NODE_ENV === "production" ? ["Secure"] : [])].join("; ");
}

function expiredRefreshCookie(): string {
  return [`fastwrite.refresh=`, "HttpOnly", "SameSite=Lax", "Path=/api/auth", "Max-Age=0", ...(process.env.NODE_ENV === "production" ? ["Secure"] : [])].join("; ");
}

function externalAuthCallback(provider: "oidc" | "cas" | "fastcas", result: AuthResult, location: string): Response {
  const headers = new Headers({ location });
  headers.append("set-cookie", refreshCookie(result.refreshToken));
  headers.append("set-cookie", expiredLoginBindingCookie(provider));
  return new Response(null, { status: 302, headers });
}

function loginBindingCookie(provider: "oidc" | "cas" | "fastcas", binding: string): string {
  return [`fastwrite.${provider}.login=${binding}`, "HttpOnly", "SameSite=Lax", `Path=/api/auth/${provider}`, "Max-Age=600", ...(process.env.NODE_ENV === "production" ? ["Secure"] : [])].join("; ");
}

function expiredLoginBindingCookie(provider: "oidc" | "cas" | "fastcas"): string {
  return [`fastwrite.${provider}.login=`, "HttpOnly", "SameSite=Lax", `Path=/api/auth/${provider}`, "Max-Age=0", ...(process.env.NODE_ENV === "production" ? ["Secure"] : [])].join("; ");
}

function requireLoginBinding(request: Request, provider: "oidc" | "cas" | "fastcas", state: string | null): void {
  const stored = request.headers.get("cookie")?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`fastwrite.${provider}.login=`))?.slice(`fastwrite.${provider}.login=`.length);
  if (!stored || !state || !constantTimeEqual(stored, state)) throw new ApiError(403, "identity_login_binding_invalid", "Identity login state does not match this browser session");
}

function constantTimeEqual(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }

function filterVisibleTree(nodes: WorkspaceTreeNode[], principal: Principal, projectId: string, authorization: AuthorizationService): WorkspaceTreeNode[] {
  const visible: WorkspaceTreeNode[] = [];
  for (const node of nodes) {
    try { authorization.requireProjectPath(principal, projectId, node.path, "project:read"); } catch { continue; }
    if (node.type === "file") { visible.push(node); continue; }
    const children = filterVisibleTree(node.children, principal, projectId, authorization);
    if (children.length) visible.push({ ...node, children });
  }
  return visible;
}

function filterSupportTree(nodes: WorkspaceTreeNode[], prefix: string): WorkspaceTreeNode[] {
  const result: WorkspaceTreeNode[] = [];
  for (const node of nodes) {
    if (!(node.path === prefix || prefix === "" || node.path.startsWith(`${prefix}/`) || prefix.startsWith(`${node.path}/`))) continue;
    if (node.type === "file") { result.push(node); continue; }
    const children = filterSupportTree(node.children, prefix);
    if (children.length) result.push({ ...node, children });
  }
  return result;
}

function filterVisibleOutline(items: OutlineItem[], principal: Principal, projectId: string, authorization: AuthorizationService): OutlineItem[] {
  return items.filter((item) => canReadProjectPath(principal, projectId, item.path, authorization)).map((item) => ({ ...item, children: filterVisibleOutline(item.children, principal, projectId, authorization) }));
}

function filterVisibleClaims(claims: PaperClaim[], principal: Principal, projectId: string, authorization: AuthorizationService): PaperClaim[] { return claims.filter((claim) => canReadProjectPath(principal, projectId, claim.anchor.path, authorization)); }

async function requireClaimAccess(projectId: string, claimId: string, principal: Principal, authorization: AuthorizationService, claims: ClaimService): Promise<void> {
  const claim = (await claims.list(projectId)).find((item) => item.id === claimId);
  if (!claim) throw new ApiError(404, "claim_not_found", "Claim was not found");
  authorization.requireProjectPath(principal, projectId, claim.anchor.path, "project:write");
}
async function requireClaimReadAccess(projectId: string, claimId: string, principal: Principal, authorization: AuthorizationService, claims: ClaimService): Promise<void> { const claim = (await claims.list(projectId)).find((item) => item.id === claimId); if (!claim) throw new ApiError(404, "claim_not_found", "Claim was not found"); authorization.requireProjectPath(principal, projectId, claim.anchor.path, "project:read"); }

function canReadProjectPath(principal: Principal, projectId: string, path: string, authorization: AuthorizationService): boolean { try { authorization.requireProjectPath(principal, projectId, path, "project:read"); return true; } catch { return false; } }

function filterVisibleReviewReports(reports: ReviewReport[], projectId: string, principal: Principal, authorization: AuthorizationService, database: JsonDatabase): ReviewReport[] {
  const snapshots = new Map(database.snapshot().reviewSnapshots.filter((snapshot) => snapshot.projectId === projectId).map((snapshot) => [snapshot.id, snapshot]));
  return reports.filter((report) => {
    const snapshot = snapshots.get(report.snapshotId);
    if (!snapshot) return false;
    return snapshot.files.every((file) => {
      try { authorization.requireProjectPath(principal, projectId, file.path, "project:read"); return true; } catch { return false; }
    });
  });
}

function requireReviewIssueAccess(projectId: string, issueId: string, principal: Principal, authorization: AuthorizationService, database: JsonDatabase): void {
  const report = database.snapshot().reviewReports.find((candidate) => candidate.projectId === projectId && candidate.issues.some((issue) => issue.id === issueId));
  if (!report) throw new ApiError(404, "review_issue_not_found", "Review issue was not found");
  requireReviewReportAccess(projectId, report.id, principal, authorization, database);
}

function requireReviewReportAccess(projectId: string, reportId: string | undefined, principal: Principal, authorization: AuthorizationService, database: JsonDatabase): void {
  const state = database.snapshot();
  const report = reportId ? state.reviewReports.find((candidate) => candidate.id === reportId && candidate.projectId === projectId) : undefined;
  const snapshot = report ? state.reviewSnapshots.find((candidate) => candidate.id === report.snapshotId && candidate.projectId === projectId) : undefined;
  if (!report || !snapshot || !snapshot.files.every((file) => { try { authorization.requireProjectPath(principal, projectId, file.path, "project:read"); return true; } catch { return false; } })) throw new ApiError(403, "review_report_access_denied", "You do not have permission to access this review report");
}

function authorizeJob(request: Request, job: import("./jobs/job-queue").JobRecord, current: Principal | undefined): void {
  if (job.policy?.actorUserId && (!current || job.policy.actorUserId !== current.user.id)) throw new ApiError(403, "job_access_denied", "This job belongs to another principal");
}

async function visibleTextPaths(projectId: string, principal: Principal, authorization: AuthorizationService, action: ProjectAction, workspaces: WorkspaceService): Promise<string[]> {
  const paths = textPathsForAuthorization(await workspaces.tree(projectId));
  const visible = paths.filter((path) => { try { authorization.requireProjectPath(principal, projectId, path, action); return true; } catch { return false; } });
  const mainDocument = workspaces.getProject(projectId).mainDocument;
  if (!visible.includes(mainDocument)) throw new ApiError(403, "project_path_access_denied", "You do not have permission to use the main document for this operation");
  return visible;
}

async function requireWorkspacePathAccess(projectId: string, principal: Principal, authorization: AuthorizationService, action: ProjectAction, workspaces: WorkspaceService): Promise<void> {
  for (const path of workspacePathsForAuthorization(await workspaces.tree(projectId))) {
    try { authorization.requireProjectPath(principal, projectId, path, action); }
    catch { throw new ApiError(403, "project_restricted_input", "This operation requires access to every project input"); }
  }
}

async function authorizeMcpWorkspaceInput(projectId: string, principal: Principal, authorization: AuthorizationService, name: string, input: unknown, workspaces: WorkspaceService): Promise<void> {
  if (name === "workspace.read") {
    const path = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>).path : undefined;
    if (typeof path !== "string" || !path.trim()) return;
    authorization.requireProjectPath(principal, projectId, path, "project:read");
    return;
  }
  if (name === "workspace.search") return requireWorkspacePathAccess(projectId, principal, authorization, "project:read", workspaces);
  if (name === "latex.compile") return requireWorkspacePathAccess(projectId, principal, authorization, "compile:run", workspaces);
}

function textPathsForAuthorization(nodes: WorkspaceTreeNode[]): string[] { return nodes.flatMap((node) => node.type === "directory" ? textPathsForAuthorization(node.children) : node.kind === "text" ? [node.path] : []); }
function workspacePathsForAuthorization(nodes: WorkspaceTreeNode[]): string[] { return nodes.flatMap((node) => node.type === "directory" ? workspacePathsForAuthorization(node.children) : [node.path]); }

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

function requestCookie(request: Request, name: string): string { return request.headers.get("cookie")?.split(";").map(item => item.trim()).find(item => item.startsWith(name + "="))?.slice(name.length + 1) ?? ""; }
function requireFastCASOrigin(request: Request): void { if (request.headers.get("origin") !== new URL(request.url).origin) throw new ApiError(403, "csrf_origin_invalid", "Same-origin request required"); }
