import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { HarnessProfile, ResolvedHarnessProfile } from "@fastwrite/shared";
import { ApiError } from "../http";
import type { JsonDatabase } from "../storage/database";
import type { Principal } from "../auth/auth-service";
import { AuthorizationService } from "../auth/authorization-service";

type ProfileInput = Pick<HarnessProfile, "name" | "provider" | "model" | "baseUrl" | "wireApi" | "allowedTools" | "maxConcurrentRuns" | "dailyBudgetUsd"> & { apiKey?: string };

export class HarnessProfileService {
  private readonly key: Buffer;
  constructor(private readonly database: JsonDatabase, private readonly authorization: AuthorizationService, masterKey = process.env.FASTWRITE_SECRETS_MASTER_KEY ?? "fastwrite-development-key") {
    this.key = createHash("sha256").update(masterKey).digest();
  }
  list(principal: Principal): HarnessProfile[] { return this.database.snapshot().harnessProfiles.filter((profile) => profile.scope === "system" ? principal.user.platformRole === "platform_admin" : profile.scope === "team" ? Boolean(profile.teamId && this.database.snapshot().teamMembers.some((member) => member.teamId === profile.teamId && member.userId === principal.user.id)) : profile.userId === principal.user.id).map(publicProfile); }
  async save(principal: Principal, scope: HarnessProfile["scope"], input: ProfileInput, target?: { teamId?: string; profileId?: string }): Promise<HarnessProfile> {
    this.assertScope(principal, scope, target?.teamId);
    const normalized = normalize(input); const timestamp = new Date().toISOString(); const teamId = target?.teamId; let secretId: string | undefined;
    if (input.apiKey?.trim()) secretId = await this.storeSecret(input.apiKey.trim());
    return this.database.mutate((state) => {
      const existing = target?.profileId ? state.harnessProfiles.find((profile) => profile.id === target.profileId) : undefined;
      if (existing && !owns(existing, principal.user.id, target?.teamId, principal.user.platformRole === "platform_admin")) throw new ApiError(403, "harness_profile_denied", "You cannot modify this Harness profile");
      const profile: HarnessProfile = { id: existing?.id ?? `harness_${crypto.randomUUID()}`, scope, ...(scope === "team" && teamId ? { teamId } : {}), ...(scope === "user" ? { userId: principal.user.id } : {}), ...normalized, ...(secretId ? { secretId } : existing?.secretId ? { secretId: existing.secretId } : {}), version: (existing?.version ?? 0) + 1, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp };
      if (existing) Object.assign(existing, profile); else state.harnessProfiles.push(profile);
      state.auditEvents.push({ id: `audit_${crypto.randomUUID()}`, actorUserId: principal.user.id, action: existing ? "harness.profile.update" : "harness.profile.create", resourceType: "harness_profile", resourceId: profile.id, createdAt: timestamp });
      return publicProfile(profile);
    });
  }
  resolve(principal: Principal, projectId?: string): ResolvedHarnessProfile {
    const state = this.database.snapshot(); const project = projectId ? state.projects.find((item) => item.id === projectId) : undefined;
    if (projectId && !project) throw new ApiError(404, "project_not_found", "Project not found");
    if (projectId) this.authorization.requireProject(principal, projectId, "harness:use");
    const system = state.harnessProfiles.find((profile) => profile.scope === "system" && !profile.revokedAt);
    const teamOwner = project?.teamId ? state.teams.find((item) => item.id === project.teamId) : undefined;
    const team = project?.teamId ? state.harnessProfiles.find((profile) => profile.scope === "team" && profile.teamId === project.teamId && !profile.revokedAt) : undefined;
    const personal = state.harnessProfiles.find((profile) => profile.scope === "user" && profile.userId === principal.user.id && !profile.revokedAt);
    const personalAllowed = !project?.teamId || teamOwner?.harnessPolicy?.personalHarness === true;
    const chosen = personalAllowed ? personal ?? team ?? system : team ?? system;
    if (chosen?.provider === "openai-compatible" && !chosen.baseUrl) throw new ApiError(409, "harness_profile_invalid", "An openai-compatible Harness profile requires baseUrl");
    if (!chosen) throw new ApiError(409, "harness_profile_missing", "No permitted Harness profile is configured");
    const policy = teamOwner?.harnessPolicy;
    if (policy?.allowedProviders?.length && !policy.allowedProviders.includes(chosen.provider)) throw new ApiError(403, "harness_profile_policy_denied", "The selected Harness provider is not permitted by the team policy");
    if (policy?.allowedModels?.length && (!chosen.model || !policy.allowedModels.includes(chosen.model))) throw new ApiError(403, "harness_profile_policy_denied", "The selected Harness model is not permitted by the team policy");
    const allowedTools = policy?.allowedTools ? chosen.allowedTools.filter((tool) => policy.allowedTools!.includes(tool)) : [...chosen.allowedTools];
    const sourceChain = [system, team, personal].filter((item): item is HarnessProfile => Boolean(item)).map((item) => ({ scope: item.scope, profileId: item.id, version: item.version }));
    return { profileId: chosen.id, version: chosen.version, provider: chosen.provider, ...(chosen.model ? { model: chosen.model } : {}), ...(chosen.baseUrl ? { baseUrl: chosen.baseUrl } : {}), wireApi: chosen.wireApi, allowedTools, sourceChain, hasSecret: Boolean(chosen.secretId), fingerprint: fingerprint(chosen) };
  }
  secret(profileId: string): string | undefined { const profile = this.database.snapshot().harnessProfiles.find((item) => item.id === profileId); const stored = profile?.secretId && this.database.snapshot().encryptedSecrets.find((item) => item.id === profile.secretId); return stored ? decrypt(stored, this.key) : undefined; }
  private async storeSecret(value: string): Promise<string> { const id = `secret_${crypto.randomUUID()}`; const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.key, iv); const cipherText = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); const authTag = cipher.getAuthTag(); const now = new Date().toISOString(); await this.database.mutate((state) => { state.encryptedSecrets.push({ id, cipherText: cipherText.toString("base64"), iv: iv.toString("base64"), authTag: authTag.toString("base64"), fingerprint: createHash("sha256").update(value).digest("hex").slice(-12), createdAt: now }); }); return id; }
  private assertScope(principal: Principal, scope: HarnessProfile["scope"], teamId?: string) { if (scope === "system" && principal.user.platformRole !== "platform_admin") throw new ApiError(403, "harness_profile_denied", "System Harness profiles require platform administrator access"); if (scope === "team") { if (!teamId) throw new ApiError(400, "team_id_required", "teamId is required for a team Harness profile"); this.authorization.requireTeamRole(principal, teamId, ["owner", "admin"]); } }
}
function normalize(input: ProfileInput) { if (!input.name?.trim()) throw new ApiError(400, "harness_profile_invalid", "Profile name is required"); if (!["codex", "claude", "openai-compatible"].includes(input.provider)) throw new ApiError(400, "harness_profile_invalid", "Unsupported provider"); if (!["responses", "chat"].includes(input.wireApi)) throw new ApiError(400, "harness_profile_invalid", "Unsupported wire API"); if (!Number.isInteger(input.maxConcurrentRuns) || input.maxConcurrentRuns < 1 || input.maxConcurrentRuns > 100) throw new ApiError(400, "harness_profile_invalid", "maxConcurrentRuns must be between 1 and 100"); if (input.baseUrl) { let parsed: URL; try { parsed = new URL(input.baseUrl); } catch { throw new ApiError(400, "harness_profile_invalid", "baseUrl must be an absolute URL"); } if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new ApiError(400, "harness_profile_invalid", "baseUrl must use HTTP(S)"); } return { name: input.name.trim().slice(0, 120), provider: input.provider, ...(input.model?.trim() ? { model: input.model.trim().slice(0, 256) } : {}), ...(input.baseUrl?.trim() ? { baseUrl: input.baseUrl.trim() } : {}), wireApi: input.wireApi, allowedTools: [...new Set(input.allowedTools.filter((item) => /^[a-z0-9._-]{1,120}$/i.test(item)))], maxConcurrentRuns: input.maxConcurrentRuns, ...(typeof input.dailyBudgetUsd === "number" && input.dailyBudgetUsd >= 0 ? { dailyBudgetUsd: input.dailyBudgetUsd } : {}) }; }
function publicProfile(profile: HarnessProfile): HarnessProfile { return structuredClone(profile); }
function owns(profile: HarnessProfile, userId: string, teamId: string | undefined, admin: boolean) { return admin || (profile.scope === "user" && profile.userId === userId) || (profile.scope === "team" && profile.teamId === teamId); }
function fingerprint(profile: HarnessProfile) { return createHash("sha256").update(JSON.stringify({ id: profile.id, version: profile.version, provider: profile.provider, model: profile.model, baseUrl: profile.baseUrl, wireApi: profile.wireApi, tools: profile.allowedTools, secretId: profile.secretId })).digest("hex"); }
function decrypt(stored: { cipherText: string; iv: string; authTag: string }, key: Buffer) { const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(stored.iv, "base64")); decipher.setAuthTag(Buffer.from(stored.authTag, "base64")); return Buffer.concat([decipher.update(Buffer.from(stored.cipherText, "base64")), decipher.final()]).toString("utf8"); }
