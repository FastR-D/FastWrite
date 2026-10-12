import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthService } from "./auth-service";
import { JsonDatabase } from "../storage/database";
import { createApplication } from "../app";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "fastwrite-bootstrap-"));
  directories.push(directory);
  const database = new JsonDatabase(directory);
  await database.initialize();
  return { directory, database, auth: new AuthService(database) };
}
const credentials = { email: "chosen-admin@example.test", password: "unique-test-password-42" };

test("public registration never claims administrator, even on an empty database", async () => {
  const { auth } = await fixture();
  const users = await Promise.all(["first", "second"].map(name => auth.register({ email: `${name}@example.test`, password: credentials.password })));
  expect(users.map(result => result.user.platformRole)).toEqual(["user", "user"]);
});

test("authenticated startup refuses an unconfigured administrator", async () => {
  const { directory } = await fixture();
  await expect(createApplication(directory, { features: { serverAuth: true } })).rejects.toThrow("No active administrator exists");
});

test("explicit bootstrap is atomic, hashed and usable for login", async () => {
  const { auth, database } = await fixture();
  const results = await Promise.all([auth.ensureBootstrapAdmin(credentials), auth.ensureBootstrapAdmin(credentials)]);
  expect(results.sort()).toEqual([false, true]);
  expect(database.snapshot().users).toHaveLength(1);
  expect(database.snapshot().localCredentials[0]?.passwordHash).not.toBe(credentials.password);
  expect((await auth.login(credentials)).user.platformRole).toBe("platform_admin");
  await expect(auth.login({ email: "admin@qq.com", password: "admin123456789" })).rejects.toMatchObject({ code: "login_invalid" });
});

test("restarts do not reset credentials or create extra administrators", async () => {
  const { auth, database, directory } = await fixture();
  await auth.ensureBootstrapAdmin(credentials);
  const reloaded = new JsonDatabase(directory);
  await reloaded.initialize();
  const restarted = new AuthService(reloaded);
  expect(await restarted.ensureBootstrapAdmin()).toBe(false);
  expect(await restarted.ensureBootstrapAdmin({ email: "another@example.test", password: "another-test-password" })).toBe(false);
  expect((await restarted.login(credentials)).user.id).toBe(database.snapshot().users[0]!.id);
  expect(reloaded.snapshot().users).toHaveLength(1);
});

test("bootstrap does not take over an existing ordinary account", async () => {
  const { auth } = await fixture();
  await auth.register(credentials);
  await expect(auth.ensureBootstrapAdmin(credentials)).rejects.toThrow("already in use");
  expect((await auth.login(credentials)).user.platformRole).toBe("user");
});
