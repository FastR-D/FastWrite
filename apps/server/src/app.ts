import { existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { DiagramService } from "./diagrams/service";
import { diagramProvider } from "./diagrams/provider";
import { diagramSchema } from "./diagrams/scene";
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
  ReviewReport
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
import { MailDeliveryService, SmtpMailTransport, type MailTransport } from "./notifications/mail-delivery-service";

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
}

type Handler = (request: Request, params: Record<string, string>, url: URL) => Promise<Response> | Response;
export type ApplicationFetch = ((request: Request) => Promise<Response>) & { dispatchMail(): Promise<void> };

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
  mailTransport?: MailTransport;
}

import { apiAgentProvider, operationPrompt, structuredProvider } from "./agent/structured-provider";

function providerFor(configuration: AgentProviderConfiguration): AgentProvider | undefined { return apiAgentProvider(configuration); }

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
    const content = operationPrompt(method, input);
    const chunks: string[] = [];
    for await (const event of runs.send({ kind, session, content, ...(model ? { model } : {}), ...(signal ? { signal } : {}) })) { if (event.type === "assistant.delta") chunks.push(event.text); if (event.type === "run.failed") throw new Error(event.error); }
    const text = chunks.join("").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    try { return JSON.parse(text); } catch {
      const candidates: string[] = []; let depth = 0; let start = -1; let quoted = false; let escaped = false;
      for (let index = 0; index < text.length; index++) { const character = text[index]!; if (quoted) { if (escaped) escaped = false; else if (character === "\\") escaped = true; else if (character === '"') quoted = false; continue; } if (character === '"') { quoted = true; continue; } if (character === "{") { if (depth === 0) start = index; depth++; } else if (character === "}" && depth > 0) { depth--; if (depth === 0 && start >= 0) candidates.push(text.slice(start, index + 1)); } }
      for (const candidate of candidates.reverse()) { try { return JSON.parse(candidate); } catch { /* try an earlier complete object */ } }
      const truncated = text.length > 0 && !text.endsWith("}");
      throw new ApiError(502, truncated ? "harness_response_truncated" : "harness_response_invalid", `Harness returned ${truncated ? "truncated" : "invalid"} JSON for ${method}`);
    }
  };
  return structuredProvider(request);
}

export async function createApplication(dataDirectory = config.dataDirectory, options: ApplicationOptions = {}) {
  const features = { ...config.features, ...options.features };
  const database = new JsonDatabase(dataDirectory);
  await database.initialize();
  const auth = new AuthService(database, config.collaborationRoomTokenSecret);
  const bootstrapRequested = config.features.serverAuth || process.env.FASTWRITE_BOOTSTRAP_ADMIN_EMAIL || process.env.FASTWRITE_BOOTSTRAP_ADMIN_PASSWORD;
  if (bootstrapRequested) {
    const bootstrapCreated = await auth.ensureBootstrapAdmin(config.bootstrapAdmin);
    if (bootstrapCreated) console.warn(`FastWrite bootstrap admin created: ${config.bootstrapAdmin.email} (change FASTWRITE_BOOTSTRAP_ADMIN_PASSWORD after first login)`);
  }
  const oidc = options.oidcProvider ?? (config.oidc ? new OidcIdentityProvider(config.oidc) : undefined);
  const cas = options.casProvider ?? (config.cas ? new CasIdentityProvider(config.cas) : undefined);
  const authorization = new AuthorizationService(database);
  const teams = new TeamService(database, authorization);
  const harnessProfiles = new HarnessProfileService(database, authorization);
  const workspaces = new WorkspaceService(dataDirectory, database);
  await workspaces.initialize();
  const collaboration = new CollaborationService(database, workspaces);
  const comments = new CommentService(database, collaboration, authorization);
  const mailDelivery = new MailDeliveryService(database, options.mailTransport ?? (config.mail ? new SmtpMailTransport(config.mail.smtpUrl, config.mail.from) : undefined));
  const uploads = new UploadService(dataDirectory, database, workspaces);
  await uploads.initialize();
  const texPackages = options.texPackages ?? new TexPackageService(dataDirectory);
  await texPackages.initialize();
  const defaultProvider = options.agentProvider;
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
    if (input.harness && input.harness !== config.harness) throw new ApiError(400, "harness_runtime_switch_unsupported", "Restart the server to switch Harness implementations");
    runtimeConfiguration = { apiKey, ...(baseURL ? { baseURL } : {}), ...(boundedSetting(input.model, 256) ? { model: boundedSetting(input.model, 256) } : {}), wireAPI: input.wireAPI ?? (baseURL ? "chat" : "responses") };
    runtimeProvider = providerFor(runtimeConfiguration);
  };
  const skillRegistry = new SkillRegistry(config.skillsDirectory);
  const harnessRegistry = new HarnessRegistry();
  harnessRegistry.register(new CodexHarnessAdapter());
  harnessRegistry.register(new ClaudeHarnessAdapter());
  const mcpRegistry = new McpRegistry();
  for (const server of defaultMcpServers()) mcpRegistry.register(server);
  const harnessRuns = new HarnessRunService(harnessRegistry, database);
  const harnessProviderInstance = harnessProvider(harnessRuns, config.harness, process.cwd(), config.harnessModel);
  const environmentProvider = providerFor(config.agentProviders.agent);
  const activeProvider = runtimeAgentProvider(() => runtimeProvider ?? defaultProvider ?? environmentProvider ?? harnessProviderInstance);
  const providers = { completion: activeProvider, agent: activeProvider, revise: activeProvider, review: activeProvider, memory: activeProvider };
  const harnessSessions = new HarnessSessionService(database);
  const latexCompiler = new LatexCompileService(dataDirectory, workspaces);
  const mcpTools = new McpToolService(mcpRegistry, workspaces, latexCompiler, database);
  const latexTemplates = new LatexTemplateService(dataDirectory, fetch, config.templateDirectory);
  const memories = new MemoryService(database, workspaces, skillRegistry, asGateway(providers.memory));
  const revisions = new ReviseService(database, workspaces, skillRegistry, asGateway(providers.revise), memories);
  const drafts = new DraftService(database, workspaces, skillRegistry, asGateway(providers.agent));
  const reviews = new ReviewService(database, workspaces, skillRegistry, asGateway(providers.review));
  const compliance = new ComplianceService(workspaces, skillRegistry);
  const research = new ResearchService(database, workspaces);
  const claims = new ClaimService(database, workspaces);
  const alignment = new AlignmentService(workspaces);
  const agentTasks = new AgentTaskService(database, workspaces, skillRegistry, asGateway(providers.agent), memories, asGateway(providers.review), compliance);
  const completions = new CompletionService(workspaces, skillRegistry, asGateway(providers.completion), memories);
  const diagrams = new DiagramService(dataDirectory, options.agentProvider?.generateDiagram ? options.agentProvider : diagramProvider(dataDirectory));
  await diagrams.initialize();
  const services: Services = { diagrams, database, workspaces, projectSearch: new ProjectSearchService(workspaces, authorization), uploads, github: new GithubService(dataDirectory, workspaces), githubSync: new GithubSyncService(dataDirectory, database, workspaces), revisions, drafts, reviews, memories, agentTasks, completions, texPackages, latexCompiler, skillRegistry, compliance, latexTemplates, research, claims, alignment, harnessRegistry, mcpRegistry, harnessRuns, harnessSessions, mcpTools, auth, authorization, teams, harnessProfiles, collaboration, comments, mailDelivery };
  const routes = buildRoutes(services, {
    status: async () => {
      const activeConfiguration = runtimeConfiguration ?? config.agentProviders.agent;
      const discovered = discoverHarnessConfiguration(config.harness);
      const apiConfigured = Boolean(runtimeProvider ?? defaultProvider ?? environmentProvider);
      const cliStatus = apiConfigured ? undefined : await harnessRegistry.get(config.harness)?.getStatus();
      const configured = apiConfigured || (discovered.configured && cliStatus?.state === "ready");
      return { configured, harness: config.harness, transport: apiConfigured ? "api" : "cli", source: runtimeProvider ? "runtime" : environmentProvider || defaultProvider ? "environment" : configured ? "user-config" : "none", ...(activeConfiguration.baseURL ? { baseURL: activeConfiguration.baseURL } : discovered.baseURL ? { baseURL: discovered.baseURL } : {}), ...(activeConfiguration.model ? { model: activeConfiguration.model } : discovered.model ? { model: discovered.model } : {}), wireAPI: activeConfiguration.wireAPI ?? (activeConfiguration.baseURL ? "chat" : "responses") };
    },
    configure: configureAgent
  }, features.serverAuth, oidc, cas);

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
        void mailDelivery.dispatchPending();
        return response;
      }
      return withRuntimeHeaders(await serveWeb(url.pathname));
    } catch (error) {
      return withRuntimeHeaders(errorResponse(error));
    }
  };
  applicationFetch.dispatchMail = () => mailDelivery.dispatchPending();
  return applicationFetch;
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

function buildRoutes({ diagrams, database, workspaces, projectSearch, uploads, github, githubSync, revisions, drafts, reviews, memories, agentTasks, completions, texPackages, latexCompiler, skillRegistry, compliance, latexTemplates, research, claims, alignment, harnessRegistry, mcpRegistry, harnessRuns, harnessSessions, mcpTools, auth, authorization, teams, harnessProfiles, collaboration, comments }: Services, agentSettings: { status: () => Promise<{ configured: boolean; source: string; baseURL?: string; model?: string; wireAPI: AgentWireApi }>; configure: (input: AgentSettingsInput) => void }, authEnabled = config.features.serverAuth, oidc?: IdentityProvider, cas?: IdentityProvider): Route[] {
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
    route("GET", "/api/health", async () => json({ status: "ok" })),
    route("POST", "/api/auth/register", async (request) => { const result = await auth.register(await readJson<{ email: string; password: string; displayName?: string }>(request)); await teams.personalWorkspace({ user: result.user, sessionId: "register" }); return authResponse(result, 201); }),
    route("POST", "/api/auth/login", async (request) => authResponse(await auth.login(await readJson<{ email: string; password: string }>(request)))),
    route("GET", "/api/auth/providers", async () => json({ local: true, oidc: Boolean(oidc), cas: Boolean(cas) })),
    route("GET", "/api/auth/oidc/login", async (_request, _params, url) => { if (!oidc) throw new ApiError(404, "oidc_not_configured", "OIDC is not configured"); const returnTo = url.searchParams.get("returnTo"); const login = await oidc.beginLogin({ ...(returnTo ? { returnTo } : {}) }); if (login.kind !== "redirect" || !login.binding) throw new ApiError(400, "oidc_login_invalid", "The configured identity provider does not return a login binding"); const response = Response.redirect(login.url, 302); response.headers.set("set-cookie", loginBindingCookie("oidc", login.binding)); return response; }),
    route("GET", "/api/auth/oidc/callback", async (request, _params, url) => { if (!oidc) throw new ApiError(404, "oidc_not_configured", "OIDC is not configured"); const code = url.searchParams.get("code"); const state = url.searchParams.get("state"); requireLoginBinding(request, "oidc", state); const returnTo = oidc.loginReturnTo?.(state ?? undefined) ?? "/"; const identity = await oidc.finishLogin({ ...(code ? { code } : {}), ...(state ? { state } : {}) }); const result = await auth.loginExternal(identity); await teams.personalWorkspace({ user: result.user, sessionId: "external-login" }); await teams.syncIdpGroups(result.user, identityGroups(identity.issuer, identity.groups)); return externalAuthCallback("oidc", result, `${returnTo}${returnTo.includes("?") ? "&" : "?"}oidc=complete`); }),
    route("GET", "/api/auth/cas/login", async () => { if (!cas) throw new ApiError(404, "cas_not_configured", "CAS is not configured"); const login = await cas.beginLogin({}); if (login.kind !== "redirect" || !login.binding) throw new ApiError(400, "cas_login_invalid", "The configured identity provider does not return a login binding"); const response = Response.redirect(login.url, 302); response.headers.set("set-cookie", loginBindingCookie("cas", login.binding)); return response; }),
    route("GET", "/api/auth/cas/callback", async (request, _params, url) => { if (!cas) throw new ApiError(404, "cas_not_configured", "CAS is not configured"); const ticket = url.searchParams.get("ticket"); const state = url.searchParams.get("state"); requireLoginBinding(request, "cas", state); const identity = await cas.finishLogin({ ...(ticket ? { ticket } : {}), ...(state ? { state } : {}) }); const result = await auth.loginExternal(identity); await teams.personalWorkspace({ user: result.user, sessionId: "external-login" }); await teams.syncIdpGroups(result.user, identityGroups(identity.issuer, identity.groups)); return externalAuthCallback("cas", result, "/?cas=complete"); }),
    route("POST", "/api/auth/refresh", async (request) => { requireSameOrigin(request); return authResponse(await auth.refresh(request)); }),
    route("POST", "/api/auth/logout", async (request) => { await auth.logout(request); return new Response(null, { status: 204, headers: { "set-cookie": expiredRefreshCookie() } }); }),
    route("GET", "/api/auth/me", async (request) => json(principal(request, true)!.user)),
    route("GET", "/api/admin/health", async (request) => { const actor = principal(request, true)!; requireAdminReadRole(actor.user); const state = database.snapshot(); return json({ users: state.users.length, activeSessions: state.sessions.filter((item) => !item.revokedAt && item.expiresAt > new Date().toISOString()).length, teams: state.teams.length, projects: state.projects.length, collaborationDocuments: state.collaborationDocuments.filter((item) => item.status === "active").length, pendingInvitations: state.invitations.filter((item) => !item.revokedAt && !item.acceptedAt && item.expiresAt > new Date().toISOString()).length }); }),
    route("GET", "/api/admin/identity-providers", async (request) => { const actor = principal(request, true)!; requireAdminReadRole(actor.user); return json({ oidc: { configured: Boolean(oidc), ...(config.oidc ? { issuer: config.oidc.issuer, redirectUri: config.oidc.redirectUri, clientId: config.oidc.clientId } : {}) }, cas: { configured: Boolean(cas), ...(config.cas ? { serverUrl: config.cas.serverUrl, serviceUrl: config.cas.serviceUrl } : {}) }, local: { configured: true } }); }),
    route("GET", "/api/admin/users", async (request) => { const actor = principal(request, true)!; requireAdminReadRole(actor.user); const state = database.snapshot(); return json(state.users.map((user) => ({ id: user.id, emailNormalized: user.emailNormalized, displayName: user.displayName, platformRole: user.platformRole, status: user.status, createdAt: user.createdAt, updatedAt: user.updatedAt, activeSessionCount: state.sessions.filter((session) => session.userId === user.id && !session.revokedAt && session.expiresAt > new Date().toISOString()).length }))); }),
    route("POST", "/api/admin/users/:userId/disable", async (request, params) => { const body = await readJson<{ reason?: string }>(request); await auth.disable(required(params, "userId"), principal(request, true)!, body.reason ?? ""); return new Response(null, { status: 204 }); }),
    route("POST", "/api/admin/users/:userId/sessions/revoke", async (request, params) => { const body = await readJson<{ reason?: string }>(request); await auth.revokeSessions(required(params, "userId"), principal(request, true)!, body.reason ?? ""); return new Response(null, { status: 204 }); }),
    route("PATCH", "/api/admin/users/:userId/platform-role", async (request, params) => { const body = await readJson<{ role?: "platform_admin" | "support_auditor" | "user"; reason?: string }>(request); if (body.role !== "platform_admin" && body.role !== "support_auditor" && body.role !== "user") throw new ApiError(400, "platform_role_invalid", "A valid platform role is required"); return json(await auth.updatePlatformRole(required(params, "userId"), body.role, principal(request, true)!, body.reason ?? "")); }),
    route("GET", "/api/admin/audit-events", async (request, _params, url) => { const actor = principal(request, true)!; requireAdminReadRole(actor.user); const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10); const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 100; return json(database.snapshot().auditEvents.slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, limit)); }),
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
    route("GET", "/api/harness-settings", async () => json(await agentSettings.status())),
    route("PUT", "/api/harness-settings", async (request) => { agentSettings.configure(await readJson<AgentSettingsInput>(request)); return json(await agentSettings.status()); }),
    route("GET", "/api/venues", async () => json(await skillRegistry.catalog())),
    route("GET", "/api/skills/workflows", async () => json((await skillRegistry.workflowCatalog()).map(({ instructions: _instructions, ...descriptor }) => descriptor))),
    route("GET", "/api/skills/releases", async () => json(await skillRegistry.publishedCatalog())),
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
      const projectId = required(params, "projectId"); workspaces.getProject(projectId);
      const body = await readJson<{ permission?: "read" | "comment"; label?: string; expiresAt?: string }>(request);
      const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
      const createdAt = new Date().toISOString();
      const share = await database.mutate((state) => { const item = { id: `share_${crypto.randomUUID()}`, projectId, tokenHash: shareTokenHash(token), permission: body.permission === "comment" ? "comment" as const : "read" as const, ...(body.label?.trim() ? { label: body.label.trim().slice(0, 120) } : {}), ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}), createdAt }; state.projectShares.push(item); return item; });
      return json({ id: share.id, token, permission: share.permission, label: share.label, expiresAt: share.expiresAt, createdAt: share.createdAt }, 201);
    }),
    route("GET", "/api/projects/:projectId/shares", async (_request, params) => { const projectId = required(params, "projectId"); workspaces.getProject(projectId); return json(database.snapshot().projectShares.filter((item) => item.projectId === projectId).map(({ tokenHash: _tokenHash, ...item }) => item)); }),
    route("DELETE", "/api/projects/:projectId/shares/:shareId", async (_request, params) => { const projectId = required(params, "projectId"); workspaces.getProject(projectId); await database.mutate((state) => { const share = state.projectShares.find((item) => item.projectId === projectId && item.id === required(params, "shareId")); if (!share) throw new ApiError(404, "share_not_found", "Share link not found"); share.revokedAt = new Date().toISOString(); }); return new Response(null, { status: 204 }); }),
    route("GET", "/api/shared/:token", async (_request, params) => { const share = activeShare(database.snapshot().projectShares, required(params, "token")); const project = workspaces.getProject(share.projectId); return json({ project: { id: project.id, name: project.name, mainDocument: project.mainDocument, version: project.version }, permission: share.permission, tree: await workspaces.tree(project.id), comments: database.snapshot().shareComments.filter((item) => item.shareId === share.id) }); }),
    route("GET", "/api/shared/:token/file", async (_request, params, url) => { const share = activeShare(database.snapshot().projectShares, required(params, "token")); const path = requiredQuery(url, "path"); const file = await workspaces.readTextFile(share.projectId, path); return json({ path, content: file.content, version: file.file.version }); }),
    route("POST", "/api/shared/:token/comments", async (request, params) => { const share = activeShare(database.snapshot().projectShares, required(params, "token")); if (share.permission !== "comment") throw new ApiError(403, "share_read_only", "This share link is read-only"); const body = await readJson<{ path?: string; line?: number; author?: string; body?: string }>(request); if (!body.path || !body.body?.trim() || !body.author?.trim()) throw new ApiError(400, "comment_invalid", "path, author and body are required"); await workspaces.readTextFile(share.projectId, body.path); const createdAt = new Date().toISOString(); return json(await database.mutate((state) => { const comment = { id: `comment_${crypto.randomUUID()}`, shareId: share.id, projectId: share.projectId, path: body.path!, ...(Number.isInteger(body.line) && body.line! > 0 ? { line: body.line } : {}), author: body.author!.trim().slice(0, 80), body: body.body!.trim().slice(0, 4000), status: "open" as const, createdAt, updatedAt: createdAt }; state.shareComments.push(comment); return comment; }), 201); }),
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
    route("GET", "/api/projects/:projectId/fastread-bundles", async (_request, params) => json(await research.listFastReadBundles(required(params, "projectId")))),
    route("POST", "/api/projects/:projectId/fastread-bundles/import", async (request, params) => {
      const body = await readJson<{ manifestPath?: string }>(request);
      return json(await research.importFastReadBundles(required(params, "projectId"), typeof body.manifestPath === "string" ? body.manifestPath : undefined), 201);
    }),
    route("GET", "/api/projects/:projectId/research-works", async (_request, params) => json(research.listWorks(required(params, "projectId")))),
    route("POST", "/api/projects/:projectId/research-works/import", async (request, params) => { const body = await readJson<Parameters<ResearchService["importWork"]>[1]>(request); if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "invalid_research_request", "Research import must be an object"); return json(await research.importWork(required(params, "projectId"), body), 201); }),
    route("PATCH", "/api/projects/:projectId/research-works/:workId", async (request, params) => json(await research.saveWork(required(params, "projectId"), required(params, "workId"), await readJson<{ status?: "candidate" | "saved" | "rejected"; citationKey?: string }>(request)))),
    route("POST", "/api/projects/:projectId/research-works/:workId/verify-metadata", async (_request, params) => json(await research.verifyMetadata(required(params, "projectId"), required(params, "workId")))),
    route("GET", "/api/projects/:projectId/research-citations/:citationKey", async (_request, params) => json(await research.citationContext(required(params, "projectId"), required(params, "citationKey")))),
    route("POST", "/api/projects/:projectId/research-works/:workId/bibtex-changes", async (request, params) => { const body = await readJson<{ targetBibPath?: string }>(request); if (!body.targetBibPath) throw new ApiError(400, "target_bib_required", "targetBibPath is required"); const changeSet = await research.proposeBibtexChange(required(params, "projectId"), required(params, "workId"), body.targetBibPath); return json(await database.mutate((state) => { state.changeSets.push(changeSet); return changeSet; }), 201); }),
    route("POST", "/api/projects/:projectId/research-works/:workId/pdf-evidence", async (request, params) => { const body = await readJson<{ pdfBase64?: string; authorized?: boolean }>(request); if (!body.pdfBase64 || body.authorized !== true) throw new ApiError(403, "pdf_authorization_required", "Provide bounded PDF data with explicit authorization"); return json(await research.extractPdfEvidence(required(params, "projectId"), required(params, "workId"), body.pdfBase64, body.authorized === true), 201); }),
    route("POST", "/api/projects/:projectId/claim-scans", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) await requireWorkspacePathAccess(projectId, current, authorization, "project:write", workspaces); return json(await claims.scan(projectId), 201); }),
    route("POST", "/api/projects/:projectId/alignment-checks", async (_request, params) => json(await alignment.check(required(params, "projectId")), 201)),
    route("POST", "/api/projects/:projectId/writing-checks", async (request, params) => {
      const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) await requireWorkspacePathAccess(projectId, current, authorization, "project:read", workspaces); const project = workspaces.getProject(projectId); const tree = await workspaces.tree(projectId);
      const paths = textPaths(tree).filter((path) => /\.(?:tex|bib)$/i.test(path));
      const documents = await Promise.all(paths.map(async (path) => { const file = await workspaces.readTextFile(projectId, path); return { path, content: file.content, fileVersion: file.file.version }; }));
      const approved = new Set(database.snapshot().sourceEvidence.filter((item) => item.projectId === projectId && item.status === "approved").map((item) => item.citationKey).filter((key): key is string => Boolean(key)));
      return json({ projectId, projectVersion: project.version, findings: writingGuardMany(documents.map((document) => ({ ...document, approvedCitationKeys: approved }))) }, 201);
    }),
    route("GET", "/api/projects/:projectId/claims", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); const ledger = await claims.list(projectId); return json(current ? filterVisibleClaims(ledger, current, projectId, authorization) : ledger); }),
    route("GET", "/api/projects/:projectId/claim-links", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); const visibleIds = current ? new Set(filterVisibleClaims(await claims.list(projectId), current, projectId, authorization).map((claim) => claim.id)) : undefined; return json(claims.links(projectId).filter((link) => !visibleIds || visibleIds.has(link.claimId))); }),
    route("GET", "/api/projects/:projectId/claims/:claimId/links", async (_request, params) => { const projectId = required(params, "projectId"); const claimId = required(params, "claimId"); if (!(await claims.list(projectId)).some((item) => item.id === claimId)) throw new ApiError(404, "claim_not_found", "Claim not found"); return json(database.snapshot().claimEvidenceLinks.filter((link) => link.claimId === claimId)); }),
    route("GET", "/api/projects/:projectId/argument-graph", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); const ledger = await claims.list(projectId); const visible = current ? filterVisibleClaims(ledger, current, projectId, authorization) : ledger; const visibleIds = new Set(visible.map((claim) => claim.id)); const persisted = database.snapshot().claimRelations.filter((item) => item.projectId === projectId && visibleIds.has(item.fromClaimId) && visibleIds.has(item.toClaimId)); const generated = deriveArgumentGraph(projectId, visible).filter((item) => !persisted.some((saved) => saved.fromClaimId === item.fromClaimId && saved.toClaimId === item.toClaimId)); return json({ projectId, relations: [...persisted, ...generated] }); }),
    route("POST", "/api/projects/:projectId/adversarial-memo", async (_request, params) => { const projectId = required(params, "projectId"); const ledger = await claims.list(projectId); return json(buildAdversarialMemo(projectId, ledger, deriveArgumentGraph(projectId, ledger)), 201); }),
    route("POST", "/api/projects/:projectId/argument-graph/confirm", async (request, params) => { const projectId = required(params, "projectId"); const body = await readJson<{ fromClaimId: string; toClaimId: string; type: "motivates" | "addresses" | "implements" | "evaluates" | "supports" | "limits" }>(request); const projectClaims = await claims.list(projectId); if (!projectClaims.some((item) => item.id === body.fromClaimId) || !projectClaims.some((item) => item.id === body.toClaimId)) throw new ApiError(404, "claim_not_found", "Both claims must belong to the project"); const relation = { id: `relation_${crypto.randomUUID()}`, projectId, fromClaimId: body.fromClaimId, toClaimId: body.toClaimId, type: body.type, status: "confirmed" as const, origin: "user" as const }; await database.mutate((state) => { state.claimRelations.push(relation); }); return json(relation, 201); }),
    route("POST", "/api/projects/:projectId/claims/:claimId/reanchor", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) await requireClaimAccess(projectId, required(params, "claimId"), current, authorization, claims); return json(await claims.reanchor(projectId, required(params, "claimId"))); }),
    route("PATCH", "/api/projects/:projectId/claims/:claimId", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) await requireClaimAccess(projectId, required(params, "claimId"), current, authorization, claims); return json(await claims.update(projectId, required(params, "claimId"), await readJson<{ reviewStatus?: "detected" | "needs-review" | "supported" | "partial" | "unsupported" }>(request))); }),
    route("POST", "/api/projects/:projectId/claims/:claimId/links", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) await requireClaimAccess(projectId, required(params, "claimId"), current, authorization, claims); return json(await claims.link(projectId, required(params, "claimId"), await readJson<any>(request)), 201); }),
    route("DELETE", "/api/projects/:projectId/claims/:claimId/links/:linkId", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) await requireClaimAccess(projectId, required(params, "claimId"), current, authorization, claims); await claims.unlink(projectId, required(params, "claimId"), required(params, "linkId")); return new Response(null, { status: 204 }); }),
    route("GET", "/api/projects/:projectId/evidence", async (_request, params) => { const projectId = required(params, "projectId"); workspaces.getProject(projectId); return json(database.snapshot().sourceEvidence.filter((item) => item.projectId === projectId)); }),
    route("POST", "/api/projects/:projectId/evidence", async (request, params) => { const projectId = required(params, "projectId"); workspaces.getProject(projectId); const body = await readJson<{ workId?: string; kind?: "background" | "claim" | "method" | "result" | "limitation" | "quote"; content?: string; locatorType?: "page" | "section" | "paragraph" | "abstract"; locator?: string; origin?: "source-text" | "registry-abstract" | "model-extraction" | "user"; representation?: "verbatim" | "paraphrase" }>(request); if (!body.workId || !body.content?.trim() || !body.locator) throw new ApiError(400, "evidence_invalid", "workId, content and locator are required"); const state = database.snapshot(); if (!state.researchWorks.some((work) => work.id === body.workId)) throw new ApiError(404, "research_work_not_found", "Research work not found"); const timestamp = new Date().toISOString(); return json(await database.mutate((current) => { const evidence = { id: `evidence_${crypto.randomUUID()}`, projectId, workId: body.workId!, kind: body.kind ?? "background", origin: body.origin ?? "user", representation: body.representation ?? "paraphrase", status: "candidate" as const, content: body.content!.trim().slice(0, 4000), locatorType: body.locatorType ?? "abstract", locator: body.locator!.trim().slice(0, 200), createdAt: timestamp, updatedAt: timestamp }; current.sourceEvidence.push(evidence); return evidence; }), 201); }),
    route("PATCH", "/api/projects/:projectId/evidence/:evidenceId", async (request, params) => { const body = await readJson<{ status?: "candidate" | "approved" | "rejected" | "stale" }>(request); return json(await claims.updateEvidence(required(params, "projectId"), required(params, "evidenceId"), body.status)); }),
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
    route("GET", "/api/projects/:projectId", async (_request, params) => json(workspaces.getProject(required(params, "projectId")))),
    route("POST", "/api/projects/:projectId/transfer", async (request, params) => { const body = await readJson<{ teamId?: string; personalOwnerUserId?: string }>(request); await teams.transferProject(required(params, "projectId"), principal(request)!, body); return json(workspaces.getProject(required(params, "projectId"))); }),
    route("PATCH", "/api/projects/:projectId", async (request, params) => {
      const body = await readJson<{ name?: string; mainDocument?: string; venue?: TargetVenue; publicationTarget?: PublicationTarget | null }>(request);
      return json(await workspaces.updateProject(required(params, "projectId"), body));
    }),
    route("DELETE", "/api/projects/:projectId", async (_request, params) => {
      await workspaces.deleteProject(required(params, "projectId"));
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
      const projectId = required(params, "projectId"); const directory = url.searchParams.get("directory"); const current = principal(request, authEnabled);
      if (current) { authorization.requireProject(current, projectId, "project:read"); if (directory !== null) authorization.requireProjectPath(current, projectId, directory, "project:read"); }
      const tree = directory === null ? await workspaces.tree(projectId) : await workspaces.treeLevel(projectId, directory);
      return json(current ? filterVisibleTree(tree, current, projectId, authorization) : tree);
    }),
    route("GET", "/api/projects/:projectId/file", async (request, params, url) => {
      const projectId = required(params, "projectId"); const path = requiredQuery(url, "path"); const current = principal(request, authEnabled); if (current) authorization.requireProjectPath(current, projectId, path, "project:read");
      return json(await workspaces.readTextFile(projectId, path));
    }),
    route("GET", "/api/projects/:projectId/asset", async (request, params, url) => {
      const projectId = required(params, "projectId"); const path = requiredQuery(url, "path"); const current = principal(request, authEnabled); if (current) authorization.requireProjectPath(current, projectId, path, "project:read");
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
      await collaboration.archivePath(projectId, body.from);
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
    route("GET", "/api/projects/:projectId/outline", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); const outline = await workspaces.outline(projectId); return json(current ? filterVisibleOutline(outline, current, projectId, authorization) : outline); }),
    route("GET", "/api/projects/:projectId/search", async (request, params, url) => { const projectId = required(params, "projectId"); const current = principal(request, true)!; return json(await projectSearch.search(projectId, current, url.searchParams.get("query") ?? "")); }),
    route("GET", "/api/projects/:projectId/skills", async (_request, params) => json(workspaces.getProject(required(params, "projectId")).skill)),
    route("POST", "/api/projects/:projectId/completions", async (request, params) => {
      const projectId = required(params, "projectId"); const body = await readJson<CompletionRequest>(request); const current = principal(request, authEnabled); if (current) authorization.requireProjectPath(current, projectId, body.path, "agent:propose"); await collaboration.flushProject(projectId);
      return json(await completions.suggest(projectId, body), 201);
    }),
    route("POST", "/api/projects/:projectId/revisions", async (request, params) => {
      const projectId = required(params, "projectId"); const body = await readJson<ReviseRequest>(request); const current = principal(request, authEnabled); if (current) authorization.requireProjectPath(current, projectId, body.selection.path, "agent:propose"); await collaboration.flushProject(projectId);
      return json(await revisions.propose(projectId, body), 201);
    }),
    route("GET", "/api/projects/:projectId/drafts", async (_request, params) => json(drafts.list(required(params, "projectId")))),
    route("POST", "/api/projects/:projectId/drafts", async (request, params) => {
      const projectId = required(params, "projectId"); await collaboration.flushProject(projectId);
      return json(await drafts.plan(projectId, await readJson<DraftRequest>(request), request.signal), 201);
    }),
    route("POST", "/api/projects/:projectId/drafts/:draftId/confirm", async (request, params) => {
      const body = await readJson<{ outline: DraftOutlineSection[] }>(request);
      return json(await drafts.confirm(required(params, "projectId"), required(params, "draftId"), body.outline, request.signal), 201);
    }),
    route("POST", "/api/projects/:projectId/drafts/:draftId/cancel", async (_request, params) => {
      return json(await drafts.cancel(required(params, "projectId"), required(params, "draftId")));
    }),
    route("GET", "/api/projects/:projectId/reviews", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); const reports = reviews.list(projectId); return json(current ? filterVisibleReviewReports(reports, projectId, current, authorization, database) : reports); }),
    route("POST", "/api/projects/:projectId/reviews", async (request, params) => {
      const body = await readJson<{ sourceOnly?: boolean; pageText?: string[]; projectVersion?: number }>(request);
      if (body.pageText !== undefined && (!Array.isArray(body.pageText) || body.pageText.some((item) => typeof item !== "string") || body.pageText.length > 20 || body.pageText.reduce((total, item) => total + item.length, 0) > 200_000)) throw new ApiError(400, "review_pdf_preview_invalid", "PDF preview text exceeds the bounded review input limits");
      const projectId = required(params, "projectId"); const current = principal(request, authEnabled); const visiblePaths = current ? await visibleTextPaths(projectId, current, authorization, "review:run", workspaces) : undefined; await collaboration.flushProject(projectId);
      if (body.pageText?.length && (body.sourceOnly === true || body.projectVersion !== workspaces.getProject(projectId).version)) throw new ApiError(409, "review_pdf_stale", "PDF text must belong to the current compiled project version.");
      return json(await reviews.run(projectId, body.sourceOnly === true, request.signal, body.pageText ?? [], visiblePaths), 201);
    }),
    route("PATCH", "/api/projects/:projectId/review-issues/:issueId", async (request, params) => {
      const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) requireReviewIssueAccess(projectId, required(params, "issueId"), current, authorization, database);
      return json(await reviews.updateIssue(projectId, required(params, "issueId"), await readJson<{ status?: ReviewIssueStatus; priority?: number; reason?: string }>(request)));
    }),
    route("POST", "/api/projects/:projectId/review-issues", async (request, params) => { const projectId = required(params, "projectId"); const body = await readJson<Parameters<ReviewService["createIssue"]>[1]>(request); const current = principal(request, authEnabled); if (current) requireReviewReportAccess(projectId, body.reportId ?? reviews.list(projectId)[0]?.id, current, authorization, database); return json(await reviews.createIssue(projectId, body), 201); }),
    route("POST", "/api/projects/:projectId/review-issues/:issueId/merge", async (request, params) => { const projectId = required(params, "projectId"); const body = await readJson<{ duplicateIds: string[]; reason?: string }>(request); const current = principal(request, authEnabled); if (current) for (const issueId of [required(params, "issueId"), ...body.duplicateIds]) requireReviewIssueAccess(projectId, issueId, current, authorization, database); return json(await reviews.mergeIssues(projectId, required(params, "issueId"), body.duplicateIds, body.reason)); }),
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
    route("GET", "/api/projects/:projectId/provenance", async (_request, params) => {
      const projectId = required(params, "projectId");
      const project = workspaces.getProject(projectId);
      const state = database.snapshot();
      const runs = state.agentRuns.filter((run) => run.projectId === projectId).map((run) => ({ id: run.id, type: run.type, status: run.status, objective: run.objective, skill: run.skill, publicationTarget: run.publicationTarget, changeSetId: run.changeSetId, createdAt: run.createdAt, updatedAt: run.updatedAt, auditTrail: run.auditTrail ?? [] }));
      const changeSets = state.changeSets.filter((changeSet) => changeSet.projectId === projectId).map((changeSet) => ({ id: changeSet.id, agentRunId: changeSet.agentRunId, status: changeSet.status, summary: changeSet.summary, rationale: changeSet.rationale, baseCheckpointOid: changeSet.baseCheckpointOid, appliedCheckpointOids: changeSet.appliedCheckpointOids, reviewFinishedAt: changeSet.reviewFinishedAt, createdAt: changeSet.createdAt, updatedAt: changeSet.updatedAt, changes: changeSet.changes.map((change) => ({ path: change.path, operation: change.operation, appliedVersion: change.appliedVersion, hunks: (change.hunks ?? []).map((hunk) => ({ id: hunk.id, status: hunk.status, rationale: hunk.rationale, findings: hunk.findings, additions: classifyHunkAdditions(hunk.after) })) })) }));
      const aiRuns = runs.filter((run) => run.type !== "review");
      const venueLabel = project.publicationTarget?.venueId ?? project.skill.venue;
      const disclosureDraft = aiRuns.length
        ? `AI usage disclosure (${venueLabel}): During preparation of this manuscript, the authors used FastWrite AI-assisted workflows for ${[...new Set(aiRuns.map((run) => run.type))].join(", ")} operations. All generated changes were reviewed and approved by the authors; the authors remain responsible for the final content, claims, citations, and compliance. This statement should be checked against the selected venue's current author instructions before submission.`
        : "No AI-assisted writing operation is recorded for this project.";
      return json({ project: { id: project.id, version: project.version, mainDocument: project.mainDocument, skill: project.skill, publicationTarget: project.publicationTarget }, generatedAt: new Date().toISOString(), disclosureDraft, runs, changeSets });
    }),
    route("POST", "/api/projects/:projectId/agent-tasks", async (request, params) => { const projectId = required(params, "projectId"); await collaboration.flushProject(projectId); const current = principal(request, authEnabled); if (current) await requireWorkspacePathAccess(projectId, current, authorization, "agent:propose", workspaces); return json(await agentTasks.plan(projectId, await readJson<AgentTaskRequest>(request), request.signal), 201); }),
    route("POST", "/api/projects/:projectId/agent-tasks/:planId/confirm", async (request, params) => { const projectId = required(params, "projectId"); const current = principal(request, authEnabled); if (current) await requireWorkspacePathAccess(projectId, current, authorization, "agent:propose", workspaces); return json(await agentTasks.confirm(projectId, required(params, "planId"), request.signal), 201); }),
    route("POST", "/api/projects/:projectId/agent-tasks/:planId/cancel", async (_request, params) => json(await agentTasks.cancel(required(params, "projectId"), required(params, "planId")))),
    route("GET", "/api/projects/:projectId/issue-resolutions", async (_request, params) => json(agentTasks.resolutions(required(params, "projectId")))),
    route("POST", "/api/projects/:projectId/issue-resolutions/:resolutionId/rereview", async (request, params) => json(await agentTasks.rereview(required(params, "projectId"), required(params, "resolutionId"), request.signal))),
    route("POST", "/api/projects/:projectId/issue-resolutions/:resolutionId/reopen", async (_request, params) => json(await agentTasks.reopen(required(params, "projectId"), required(params, "resolutionId")))),
    route("GET", "/api/projects/:projectId/compile-results/latest", async (_request, params) => {
      const projectId = required(params, "projectId");
      workspaces.getProject(projectId);
      return json(database.snapshot().compileRecords.filter((record) => record.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null);
    }),
    route("POST", "/api/projects/:projectId/compile", async (request, params) => { const projectId = required(params, "projectId"); await collaboration.flushProject(projectId); const current = principal(request, authEnabled); if (current) await requireWorkspacePathAccess(projectId, current, authorization, "compile:run", workspaces); const result = await latexCompiler.compile(projectId); if (current) await requireWorkspacePathAccess(projectId, current, authorization, "compile:run", workspaces); return json(result); }),
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

function shareTokenHash(token: string): string { return new Bun.CryptoHasher("sha256").update(token).digest("hex"); }
function activeShare(shares: Array<{ tokenHash: string; revokedAt?: string; expiresAt?: string }>, token: string) {
  const share = shares.find((item) => item.tokenHash === shareTokenHash(token));
  if (!share || share.revokedAt || (share.expiresAt && Date.parse(share.expiresAt) <= Date.now())) throw new ApiError(404, "share_not_found", "Share link not found or expired");
  return share as typeof share & { id: string; projectId: string; permission: "read" | "comment" };
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

function externalAuthCallback(provider: "oidc" | "cas", result: AuthResult, location: string): Response {
  const headers = new Headers({ location });
  headers.append("set-cookie", refreshCookie(result.refreshToken));
  headers.append("set-cookie", expiredLoginBindingCookie(provider));
  return new Response(null, { status: 302, headers });
}

function loginBindingCookie(provider: "oidc" | "cas", binding: string): string {
  return [`fastwrite.${provider}.login=${binding}`, "HttpOnly", "SameSite=Lax", `Path=/api/auth/${provider}`, "Max-Age=600", ...(process.env.NODE_ENV === "production" ? ["Secure"] : [])].join("; ");
}

function expiredLoginBindingCookie(provider: "oidc" | "cas"): string {
  return [`fastwrite.${provider}.login=`, "HttpOnly", "SameSite=Lax", `Path=/api/auth/${provider}`, "Max-Age=0", ...(process.env.NODE_ENV === "production" ? ["Secure"] : [])].join("; ");
}

function requireLoginBinding(request: Request, provider: "oidc" | "cas", state: string | null): void {
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

function filterVisibleOutline(items: OutlineItem[], principal: Principal, projectId: string, authorization: AuthorizationService): OutlineItem[] {
  return items.filter((item) => canReadProjectPath(principal, projectId, item.path, authorization)).map((item) => ({ ...item, children: filterVisibleOutline(item.children, principal, projectId, authorization) }));
}

function filterVisibleClaims(claims: PaperClaim[], principal: Principal, projectId: string, authorization: AuthorizationService): PaperClaim[] { return claims.filter((claim) => canReadProjectPath(principal, projectId, claim.anchor.path, authorization)); }

async function requireClaimAccess(projectId: string, claimId: string, principal: Principal, authorization: AuthorizationService, claims: ClaimService): Promise<void> {
  const claim = (await claims.list(projectId)).find((item) => item.id === claimId);
  if (!claim) throw new ApiError(404, "claim_not_found", "Claim was not found");
  authorization.requireProjectPath(principal, projectId, claim.anchor.path, "project:write");
}

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
