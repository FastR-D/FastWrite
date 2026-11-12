import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FastCASError, type Identity, type LoginResult, type Transaction } from "@fastrd/fastcas/server";
import { JsonDatabase } from "../storage/database";
import { AuthService } from "./auth-service";
import { FastCASService, FastCASTransactions } from "./fastcas-service";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const configuration = { issuer: "https://cas.test", clientId: "write", redirectUri: "https://write.test/api/auth/fastcas/callback", allowRegistration: true };
const profile = { email: "new@example.test", displayName: "新用户", password: "registration-test-password" };
const binding = "a-secure-browser-binding-at-least-32-characters";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture(emailVerified = true) {
  const path = await mkdtemp(join(tmpdir(), "fastwrite-cas-signup-")); directories.push(path);
  const database = new JsonDatabase(path); await database.initialize();
  const auth = new AuthService(database), service = new FastCASService(configuration, database, auth);
  const identity: Identity = { issuer: configuration.issuer, subject: "cas-subject", email: profile.email, name: profile.displayName, emailVerified };
  let counter = 0;
  const transaction = async (purpose: Transaction["purpose"], browserBinding: string, localAccountRef?: string) => {
    const tx: Transaction = { state: `state-${++counter}`, nonce: "nonce", verifier: "verifier", bindingHash: digest(browserBinding), expiresAt: Date.now() + 300000, purpose, returnTo: "/panel?view=recent", ...(localAccountRef ? { localAccountRef, intent: { id: "intent", client_id: "write", local_account_ref: localAccountRef, nonce: "nonce", state: "prepared", expires_at: new Date(Date.now() + 300000).toISOString() } } : {}) };
    await new FastCASTransactions(database).put(tx); return tx;
  };
  spyOn(service.sdk, "finishLogin").mockImplementation(async (url, options) => {
    const tx = await new FastCASTransactions(database).take(url.searchParams.get("state")!);
    if (!tx || tx.bindingHash !== digest(options.browserBinding)) throw new FastCASError("transaction_invalid", "Invalid transaction", 401);
    return { identity, transaction: tx, tokens: { access_token: "never-persist-this-token", token_type: "Bearer" } } as LoginResult;
  });
  spyOn(service.sdk, "resolveLink").mockRejectedValue(new FastCASError("authentication_required", "Please sign in again", 401));
  spyOn(service.sdk, "beginRegistration").mockImplementation(async options => {
    const tx = await transaction("register", options.browserBinding, options.newLocalAccountRef);
    return new URL(`https://cas.test/authorize?state=${tx.state}`);
  });
  spyOn(service.sdk, "prepareLink").mockImplementation(async result => ({ id: "new-link", client_id: "write", subject: result.identity.subject, local_account_ref: result.transaction.localAccountRef!, state: "prepared", version: 1, verified_at: new Date().toISOString() }));
  spyOn(service.sdk, "activateLink").mockImplementation(async () => ({ ...database.snapshot().fastcasLinks[0]!.link, state: "active", version: 2 }));
  const start = async () => { const tx = await transaction("login", binding); return service.callback(new URL(`${configuration.redirectUri}?state=${tx.state}`), binding, ""); };
  return { path, database, auth, service, identity, start };
}
test("unlinked verified identity prompts for profile, survives restart and creates a password account with an active link", async () => {
  const { path, database, service, auth, start } = await fixture();
  expect(await start()).toMatchObject({ registrationRequired: true });
  expect(database.snapshot().users).toHaveLength(0);
  expect(service.registrationStatus(binding)).toEqual({ email: profile.email, displayName: profile.displayName });
  const restarted = new JsonDatabase(path); await restarted.initialize();
  expect(new FastCASService(configuration, restarted, new AuthService(restarted)).registrationStatus(binding).email).toBe(profile.email);
  expect(() => service.registrationStatus("wrong-browser")).toThrow();
  const signup = await service.beginRegistration(binding, profile);
  expect(() => service.registrationStatus(binding)).toThrow();
  const tx = database.snapshot().fastcasTransactions[0]!;
  const result = await service.callback(new URL(`${configuration.redirectUri}?state=${tx.state}`), signup.binding, "");
  expect(result.result?.user).toMatchObject({ emailNormalized: profile.email, displayName: profile.displayName, platformRole: "user" });
  expect((await auth.login(profile)).user.id).toBe(result.result!.user.id);
  expect(database.snapshot().fastcasLinks[0]?.link.state).toBe("active");
  expect(database.snapshot().fastcasSignups).toHaveLength(0);
  expect(JSON.stringify(database.snapshot())).not.toContain("never-persist-this-token");
  await expect(service.callback(new URL(`${configuration.redirectUri}?state=${tx.state}`), signup.binding, "")).rejects.toMatchObject({ code: "fastcas_transaction_invalid" });
});
test("unverified or manually changed email is a local login ID without inheriting email-based invitations", async () => {
  const { database, service, auth, start } = await fixture(false);
  await start(); expect(service.registrationStatus(binding).email).toBe("");
  const signup = await service.beginRegistration(binding, profile);
  const tx = database.snapshot().fastcasTransactions[0]!;
  const result = await service.callback(new URL(`${configuration.redirectUri}?state=${tx.state}`), signup.binding, "");
  expect(result.result!.user.emailNormalized).toEndWith("@identity.invalid");
  expect((await auth.login(profile)).user.id).toBe(result.result!.user.id);
});
test("signup rejects duplicate email and expired proof without creating or merging users", async () => {
  const { database, service, auth, start } = await fixture(); await start();
  const existing = await auth.register(profile);
  await expect(service.beginRegistration(binding, profile)).rejects.toMatchObject({ code: "account_exists" });
  expect(database.snapshot().users.map(user => user.id)).toEqual([existing.user.id]);
  await database.mutate(state => { state.fastcasSignups[0]!.expiresAt = Date.now() - 1; });
  await expect(service.beginRegistration(binding, { ...profile, email: "another@example.test" })).rejects.toMatchObject({ code: "fastcas_signup_expired" });
});
test("registration callback refuses an identity switch and rechecks signup policy", async () => {
  const { database, service, identity, start } = await fixture(); await start();
  const signup = await service.beginRegistration(binding, profile), tx = database.snapshot().fastcasTransactions[0]!;
  service.configuration.allowRegistration = false;
  await expect(service.callback(new URL(`${configuration.redirectUri}?state=${tx.state}`), signup.binding, "")).rejects.toMatchObject({ code: "fastcas_signup_disabled" });
  service.configuration.allowRegistration = true; identity.subject = "different-identity";
  await expect(service.callback(new URL(`${configuration.redirectUri}?state=${tx.state}`), signup.binding, "")).rejects.toMatchObject({ code: "fastcas_signup_identity_changed" });
  expect(database.snapshot().users).toHaveLength(0); expect(database.snapshot().fastcasLinks).toHaveLength(0);
});
test("provider failure never becomes a signup invitation", async () => {
  const { database, service, start } = await fixture();
  spyOn(service.sdk, "resolveLink").mockRejectedValue(new FastCASError("provider_unavailable", "Unavailable", 503));
  await expect(start()).rejects.toMatchObject({ status: 503 }); expect(database.snapshot().fastcasSignups).toHaveLength(0);
});

test("missing-link 404 remains compatible with providers using an explicit not-found response", async () => {
  const { service, start } = await fixture();
  spyOn(service.sdk, "resolveLink").mockRejectedValue(new FastCASError("link_not_found", "No link", 404));
  expect(await start()).toMatchObject({ registrationRequired: true });
});
test("an inactive existing local mapping never becomes a new signup after upstream 401", async () => {
  const { database, service, start } = await fixture();
  await database.mutate(state => { state.fastcasLinks.push({ issuer: configuration.issuer, userId: "existing-user", link: { id: "existing-link", client_id: "write", local_account_ref: "existing-user", subject: "cas-subject", state: "revoked", version: 3, verified_at: new Date().toISOString() } }); });
  await expect(start()).rejects.toMatchObject({ code: "fastcas_not_linked" });
  expect(database.snapshot().fastcasSignups).toHaveLength(0);
});
test("signup policy and unrelated unauthorized responses remain closed", async () => {
  const { database, service, start } = await fixture();
  service.configuration.allowRegistration = false;
  await expect(start()).rejects.toMatchObject({ status: 401, code: "authentication_required" });
  service.configuration.allowRegistration = true;
  spyOn(service.sdk, "resolveLink").mockRejectedValue(new FastCASError("invalid_client", "Invalid client", 401));
  await expect(start()).rejects.toMatchObject({ status: 401, code: "invalid_client" });
  expect(database.snapshot().fastcasSignups).toHaveLength(0);
});
