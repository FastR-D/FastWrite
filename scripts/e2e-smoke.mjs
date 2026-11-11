import { expect } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { startTestServer, launchTestBrowser } from "./fixtures/browser-test.mjs";

const setup = await startTestServer();
let browser, page;
const errors = [];
try {
  browser = await launchTestBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } }); page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  const accessibility = async () => {
    const url = setup.origin + "/__e2e__/axe.min.js";
    await page.route(url, route => route.fulfill({ path: "node_modules/axe-core/axe.min.js", contentType: "application/javascript" }));
    try { await page.addScriptTag({ url }); } finally { await page.unroute(url); }
    const violations = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } })).violations.filter(item => ["critical", "serious"].includes(item.impact)));
    assert.deepEqual(violations.map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) })), []);
  };
  await page.goto(setup.origin + "/projects");
  await accessibility();
  await page.getByRole("button", { name: "登录", exact: true }).first().click();
  const login = page.getByRole("dialog", { name: "登录", exact: true });
  await login.getByLabel("邮箱", { exact: true }).fill("e2e-admin@example.test");
  await login.getByLabel("密码", { exact: true }).fill("fastwrite-e2e-only-password");
  await login.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("complementary", { name: "项目导航" }).getByRole("button", { name: "新建论文", exact: true }).click();
  await page.getByRole("textbox", { name: "项目名称" }).fill("Authenticated regression");
  await page.getByRole("button", { name: "创建论文", exact: true }).click();
  await page.waitForURL(/\/projects\/paper_/);
  const projectId = page.url().split("/").pop(); const projectUrl = page.url();
  const api = async (suffix, method = "GET", data) => {
    const token = await page.evaluate(() => localStorage.getItem("fastwrite.session-token"));
    const response = await context.request.fetch(`${setup.origin}/api/projects/${projectId}${suffix}`, { method, headers: { authorization: `Bearer ${token}` }, ...(data === undefined ? {} : { data }) });
    assert.ok(response.ok(), `${method} ${suffix}: ${response.status()} ${await response.text()}`);
    return response.status() === 204 ? undefined : response.json();
  };
  const editor = () => page.getByRole("textbox", { name: "源文件编辑器： main.tex" });
  await editor().waitFor({ state: "attached" });
  console.log("PASS: fresh database UI login creates an owned, accessible project");

  const original = await api("/file?path=main.tex");
  await editor().focus(); await editor().press("ControlOrMeta+End"); await editor().press("Enter"); await page.keyboard.type("% DISCARD_REGRESSION_MARKER");
  await expect.poll(async () => (await api("/file?path=main.tex")).content).toContain("DISCARD_REGRESSION_MARKER");
  await page.getByRole("button", { name: "Git", exact: true }).click();
  await page.getByRole("button", { name: "放弃文件更改： main.tex", exact: true }).click();
  await expect.poll(async () => (await api("/file?path=main.tex")).content).toBe(original.content);
  await expect(page.locator(".monaco-editor .view-lines")).not.toContainText("DISCARD_REGRESSION_MARKER");
  await editor().focus(); await editor().press("ControlOrMeta+End"); await editor().press("Enter"); await page.keyboard.type("% AFTER_DISCARD");
  await expect.poll(async () => (await api("/file?path=main.tex")).content).toContain("AFTER_DISCARD");
  assert.ok(!(await api("/file?path=main.tex")).content.includes("DISCARD_REGRESSION_MARKER"));
  console.log("PASS: discard updates the visible editor and subsequent saves preserve restored text");

  await page.getByRole("button", { name: "溯源记录", exact: true }).click();
  const dossier = page.getByRole("dialog", { name: "AI 写作溯源档案", exact: true });
  const provenanceDownload = page.waitForEvent("download"); await dossier.getByRole("button", { name: "导出档案", exact: true }).click();
  JSON.parse(await readFile(await (await provenanceDownload).path(), "utf8"));
  await dossier.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "项目设置", exact: true }).click();
  await page.getByRole("button", { name: "历史与导出", exact: true }).click();
  const archiveDownload = page.waitForEvent("download"); await page.getByRole("button", { name: "导出", exact: true }).click();
  const archive = await readFile(await (await archiveDownload).path()); assert.deepEqual([...archive.subarray(0, 2)], [31, 139]);
  console.log("PASS: authenticated provenance and workspace downloads produce valid files");

  const editorTabs = page.getByRole("group", { name: "已打开的编辑器 controls", exact: true });
  await editorTabs.getByRole("tab", { name: "设置", exact: true }).focus();
  await page.keyboard.press("Home"); await editor().waitFor({ state: "attached" });
  await page.keyboard.press("End"); await page.getByRole("button", { name: "导出", exact: true }).waitFor();
  await editorTabs.getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(editorTabs.getByRole("tab", { name: "设置", exact: true })).toHaveCount(0);
  console.log("PASS: editor tabs retain keyboard navigation and accessible close controls");

  const replaceSource = async content => {
    await editor().focus(); await editor().press("ControlOrMeta+A"); await page.keyboard.insertText(content);
    await expect.poll(async () => (await api("/file?path=main.tex")).content).toBe(content);
  };
  await api("/files", "POST", { path: "sections/method.tex", content: "\\section{Method}\nA reproducible browser smoke test." });
  const validSource = "\\documentclass{article}\n\\begin{document}\n\\input{sections/method}\n\\end{document}";
  await replaceSource(validSource);
  await page.locator(".compile-strip--success").waitFor({ timeout: 90_000 });
  await page.locator(".react-pdf__Page__canvas").first().waitFor({ timeout: 30_000 });
  await replaceSource(validSource.replace("\\input{sections/method}", "\\undefinedFastWriteCommand"));
  await page.locator(".compile-status-icon--error").waitFor({ timeout: 90_000 });
  assert.ok(await page.locator(".react-pdf__Page__canvas").count(), "failed compilation retains the previous PDF");
  await page.locator(".pdf-pane").getByRole("button", { name: "使用智能助手修复", exact: true }).click();
  const assistant = page.getByRole("dialog", { name: "编译助手与待审核修改", exact: true });
  await expect(assistant.getByRole("checkbox", { name: /单条错误最小修复/ })).toBeChecked();
  await assistant.getByRole("combobox", { name: "错误定位", exact: true }).click();
  await page.getByRole("option", { name: /main\.tex:3.*Undefined control sequence/ }).click();
  const brokenSource = (await api("/file?path=main.tex")).content;
  await assistant.getByRole("button", { name: "关闭对话框", exact: true }).click();
  assert.equal((await api("/file?path=main.tex")).content, brokenSource, "opening and dismissing repair cannot change the manuscript");
  await replaceSource(validSource);
  await page.locator(".compile-strip--success").waitFor({ timeout: 90_000 });
  await accessibility();
  console.log("PASS: real multi-file compilation, error feedback, retained PDF and repair approval boundary");

  const oldToken = await page.evaluate(() => localStorage.getItem("fastwrite.session-token")); let refreshCalls = 0;
  context.on("request", request => { if (new URL(request.url()).pathname === "/api/auth/refresh") refreshCalls++; });
  await context.route("**/api/**", async route => {
    if (new URL(route.request().url()).pathname !== "/api/auth/refresh" && route.request().headers().authorization === `Bearer ${oldToken}`) return route.fulfill({ status: 401, contentType: "application/json", body: '{"error":{"code":"expired","message":"Expired test access token"}}' });
    return route.continue();
  });
  const second = await context.newPage();
  await Promise.all([page.goto(projectUrl), second.goto(projectUrl)]);
  await editor().waitFor({ state: "attached" }); await second.getByRole("textbox", { name: "源文件编辑器： main.tex" }).waitFor({ state: "attached" });
  assert.equal(refreshCalls, 1); await context.unroute("**/api/**"); await second.close();
  console.log("PASS: parallel requests in two tabs rotate the refresh cookie exactly once");

  await page.waitForFunction(id => Object.keys(localStorage).some(key => key.startsWith("fastwrite.workspace-file:v2:") && key.endsWith(`:${id}:main.tex`)), projectId);
  await page.route("**/api/**", route => route.abort("internetdisconnected")); await page.reload();
  await page.getByText("已加载离线工作区快照", { exact: false }).waitFor(); await editor().waitFor({ state: "attached" });
  assert.equal(await page.getByText("无法打开此论文", { exact: true }).count(), 0);
  await page.unroute("**/api/**");
  await page.route("**/api/projects/**", route => route.fulfill({ status: 403, contentType: "application/json", body: '{"error":{"code":"denied","message":"Access denied"}}' })); await page.reload();
  await page.getByText("无法打开此论文", { exact: true }).waitFor(); assert.equal(await editor().count(), 0);
  console.log("PASS: offline cache renders on network failure and stays hidden on access denial");
  await page.unroute("**/api/projects/**");
  await page.goto(setup.origin + "/projects");
  await page.getByRole("complementary", { name: "项目导航" }).getByRole("button", { name: "导入论文", exact: true }).click();
  const importDialog = page.getByRole("dialog", { name: "导入论文", exact: true });
  await importDialog.getByRole("tab", { name: "GitHub 仓库", exact: true }).click();
  let importRequest;
  await page.route("**/api/project-imports/github", route => {
    importRequest = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { id: projectId } });
  });
  await importDialog.getByLabel("仓库地址").fill("https://github.com/example/paper");
  await importDialog.getByLabel(/分支、标签或提交/).fill("camera-ready");
  await importDialog.getByLabel(/项目名称/).fill("Imported paper");
  await importDialog.getByLabel(/主文档/).fill("paper.tex");
  await importDialog.getByRole("button", { name: "导入论文", exact: true }).click();
  await page.waitForURL(projectUrl);
  await expect(editor()).toBeAttached();
  assert.equal(importRequest.repository, "https://github.com/example/paper");
  assert.equal(importRequest.ref, "camera-ready");
  assert.equal(importRequest.mainDocument, "paper.tex");
  assert.equal(importRequest.name, "Imported paper");
  assert.deepEqual(errors, []);
  console.log("PASS: GitHub import submits configured source and opens the imported workspace");
} catch (error) {
  await mkdir("output/playwright", { recursive: true });
  await page?.screenshot({ path: "output/playwright/authenticated-regression-failure.png", fullPage: true }).catch(() => undefined);
  throw error;
} finally {
  await browser?.close();
  await setup.close();
}
