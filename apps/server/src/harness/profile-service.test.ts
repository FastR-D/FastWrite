import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonDatabase } from "../storage/database";
import { AuthService } from "../auth/auth-service";
import { AuthorizationService } from "../auth/authorization-service";
import { TeamService } from "../teams/team-service";
import { HarnessProfileService } from "./profile-service";

test("a caller cannot claim a team profile by changing its scope or supplying its team ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fastwrite-profile-owner-"));
  try {
    const database = new JsonDatabase(directory); await database.initialize();
    const auth = new AuthService(database);
    const owner = { user: (await auth.register({ email: "owner@example.test", password: "fixture-password-long-enough" })).user, sessionId: "fixture" };
    const attacker = { user: (await auth.register({ email: "member@example.test", password: "fixture-password-long-enough" })).user, sessionId: "fixture" };
    const authorization = new AuthorizationService(database);
    const teams = new TeamService(database, authorization);
    const team = await teams.create(owner, "Fixture team");
    const profiles = new HarnessProfileService(database, authorization, "fixture-master-key");
    const input = { name: "Team profile", provider: "codex" as const, wireApi: "responses" as const, allowedTools: ["workspace.read"], maxConcurrentRuns: 1, apiKey: "synthetic-secret" };
    const profile = await profiles.save(owner, "team", input, { teamId: team.id });
    const secretCount = database.snapshot().encryptedSecrets.length;
    await expect(profiles.save(attacker, "user", { ...input, name: "Claimed" }, { profileId: profile.id, teamId: team.id })).rejects.toBeDefined();
    await expect(profiles.save(attacker, "team", input, { profileId: profile.id, teamId: team.id })).rejects.toBeDefined();
    await expect(profiles.save(owner, "user", input, { profileId: profile.id, teamId: team.id })).rejects.toBeDefined();
    await expect(profiles.save(attacker, "invalid" as any, input)).rejects.toBeDefined();
    await expect(profiles.save(owner, "team", input, { teamId: team.id, profileId: "missing" })).rejects.toBeDefined();
    expect(database.snapshot().encryptedSecrets).toHaveLength(secretCount);
    expect(database.snapshot().harnessProfiles[0]).toMatchObject({ id: profile.id, scope: "team", teamId: team.id, version: 1 });
    expect(profiles.secret(profile.id)).toBe("synthetic-secret");
    const saved = await profiles.save(owner, "team", { ...input, apiKey: "rotated-synthetic-secret", name: "Updated" }, { teamId: team.id, profileId: profile.id });
    expect(saved.version).toBe(2);
    expect(profiles.secret(profile.id)).toBe("rotated-synthetic-secret");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
