import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { rm, readFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";

const child = spawn(process.env.FASTWRITE_E2E_BUN || "bun", ["scripts/fixtures/authenticated-server.ts"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
let browser, setup, page;
try {
  setup = await new Promise((resolveReady, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Startup timeout")), 20_000);
    child.on("error", reject);
    child.stdout.on("data", data => { output += data; const line = output.split("\n").find(value => value.startsWith('{"origin":')); if (line) { clearTimeout(timer); resolveReady(JSON.parse(line)); } });
    child.stderr.on("data", data => process.stderr.write(data));
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Server exited ${code}`)); });
  });
  browser = await chromium.launch({ ...(process.env.FASTWRITE_E2E_BROWSER_PATH ? { executablePath: process.env.FASTWRITE_E2E_BROWSER_PATH } : {}), headless: true });
  const context = await browser.newContext(); page = await context.newPage();
  await page.goto(setup.origin + "/projects");
  await page.getByRole("button", { name: "Sign in", exact: true }).first().click();
  const login = page.getByRole("dialog", { name: "Sign in", exact: true });
  await login.getByLabel("Email", { exact: true }).fill("e2e-admin@example.test");
  await login.getByLabel("Password", { exact: true }).fill("fastwrite-e2e-only-password");
  await login.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "New paper", exact: true }).click();
  await page.getByRole("textbox", { name: "Project name" }).fill("Authenticated regression");
  await page.getByRole("button", { name: "Create paper", exact: true }).click();
  await page.waitForURL(/\/projects\/paper_/);
  const projectId = page.url().split("/").pop(); const projectUrl = page.url();
  const api = async (suffix, method = "GET", data) => {
    const token = await page.evaluate(() => localStorage.getItem("fastwrite.session-token"));
    const response = await context.request.fetch(`${setup.origin}/api/projects/${projectId}${suffix}`, { method, headers: { authorization: `Bearer ${token}` }, ...(data === undefined ? {} : { data }) });
    assert.ok(response.ok(), `${method} ${suffix}: ${response.status()} ${await response.text()}`);
    return response.status() === 204 ? undefined : response.json();
  };
  const editor = () => page.getByRole("textbox", { name: "Source editor for main.tex" });
  await editor().waitFor({ state: "attached" });
  console.log("PASS: fresh database UI login creates an owned, accessible project");

  const original = await api("/file?path=main.tex");
  await editor().focus(); await editor().press("ControlOrMeta+End"); await editor().press("Enter"); await page.keyboard.type("% DISCARD_REGRESSION_MARKER");
  await expect.poll(async () => (await api("/file?path=main.tex")).content).toContain("DISCARD_REGRESSION_MARKER");
  await page.getByRole("button", { name: "Git", exact: true }).click();
  await page.getByRole("button", { name: "Discard changes in main.tex", exact: true }).click();
  await expect.poll(async () => (await api("/file?path=main.tex")).content).toBe(original.content);
  await expect(page.locator(".monaco-editor .view-lines")).not.toContainText("DISCARD_REGRESSION_MARKER");
  await editor().focus(); await editor().press("ControlOrMeta+End"); await editor().press("Enter"); await page.keyboard.type("% AFTER_DISCARD");
  await expect.poll(async () => (await api("/file?path=main.tex")).content).toContain("AFTER_DISCARD");
  assert.ok(!(await api("/file?path=main.tex")).content.includes("DISCARD_REGRESSION_MARKER"));
  console.log("PASS: discard updates the visible editor and subsequent saves preserve restored text");

  await page.getByRole("button", { name: "Provenance", exact: true }).click();
  const dossier = page.getByRole("dialog", { name: "AI provenance dossier", exact: true });
  const provenanceDownload = page.waitForEvent("download"); await dossier.getByRole("button", { name: "Export dossier", exact: true }).click();
  JSON.parse(await readFile(await (await provenanceDownload).path(), "utf8"));
  await dossier.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Project settings", exact: true }).click();
  await page.getByRole("button", { name: "History & Export", exact: true }).click();
  const archiveDownload = page.waitForEvent("download"); await page.getByRole("button", { name: "Export", exact: true }).click();
  const archive = await readFile(await (await archiveDownload).path()); assert.deepEqual([...archive.subarray(0, 2)], [31, 139]);
  console.log("PASS: authenticated provenance and workspace downloads produce valid files");

  const editorTabs = page.getByRole("group", { name: "Open editors controls", exact: true });
  await editorTabs.getByRole("tab", { name: "Settings", exact: true }).focus();
  await page.keyboard.press("Home"); await editor().waitFor({ state: "attached" });
  await page.keyboard.press("End"); await page.getByRole("button", { name: "Export", exact: true }).waitFor();
  await editorTabs.getByRole("button", { name: "Close Settings", exact: true }).click();
  await expect(editorTabs.getByRole("tab", { name: "Settings", exact: true })).toHaveCount(0);
  console.log("PASS: editor tabs retain keyboard navigation and accessible close controls");

  const oldToken = await page.evaluate(() => localStorage.getItem("fastwrite.session-token")); let refreshCalls = 0;
  context.on("request", request => { if (new URL(request.url()).pathname === "/api/auth/refresh") refreshCalls++; });
  await context.route("**/api/**", async route => {
    if (new URL(route.request().url()).pathname !== "/api/auth/refresh" && route.request().headers().authorization === `Bearer ${oldToken}`) return route.fulfill({ status: 401, contentType: "application/json", body: '{"error":{"code":"expired","message":"Expired test access token"}}' });
    return route.continue();
  });
  const second = await context.newPage();
  await Promise.all([page.goto(projectUrl), second.goto(projectUrl)]);
  await editor().waitFor({ state: "attached" }); await second.getByRole("textbox", { name: "Source editor for main.tex" }).waitFor({ state: "attached" });
  assert.equal(refreshCalls, 1); await context.unroute("**/api/**"); await second.close();
  console.log("PASS: parallel requests in two tabs rotate the refresh cookie exactly once");

  await page.waitForFunction(id => Object.keys(localStorage).some(key => key.startsWith("fastwrite.workspace-file:v2:") && key.endsWith(`:${id}:main.tex`)), projectId);
  await page.route("**/api/**", route => route.abort("internetdisconnected")); await page.reload();
  await page.getByText("Offline workspace snapshot loaded.", { exact: false }).waitFor(); await editor().waitFor({ state: "attached" });
  assert.equal(await page.getByText("Could not open this paper", { exact: true }).count(), 0);
  await page.unroute("**/api/**");
  await page.route("**/api/projects/**", route => route.fulfill({ status: 403, contentType: "application/json", body: '{"error":{"code":"denied","message":"Access denied"}}' })); await page.reload();
  await page.getByText("Could not open this paper", { exact: true }).waitFor(); assert.equal(await editor().count(), 0);
  console.log("PASS: offline cache renders on network failure and stays hidden on access denial");
} catch (error) {
  await mkdir("output/playwright", { recursive: true });
  await page?.screenshot({ path: "output/playwright/authenticated-regression-failure.png", fullPage: true }).catch(() => undefined);
  throw error;
} finally {
  await browser?.close();
  if (child.exitCode === null && child.pid) { const done = once(child, "exit"); child.stdin.write("stop\n"); await done; }
  if (setup?.directory) { assert.ok(resolve(setup.directory).startsWith(resolve(tmpdir()) + sep)); await rm(setup.directory, { recursive: true, force: true }); }
}
