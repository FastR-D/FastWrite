import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const root = await mkdtemp(join(tmpdir(), "fastwrite-latex-e2e-"));
const port = 3248;
const base = `http://127.0.0.1:${port}`;
const server = spawn("bun", ["scripts/fixtures/latex-services-server.ts"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    FASTWRITE_DATA_DIR: root,
    FASTWRITE_PORT: String(port),
    FASTWRITE_SERVER_AUTH: "false",
    FASTWRITE_DEVELOPMENT_ADMIN: "false",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (data) => (serverLog += data));
server.stderr.on("data", (data) => (serverLog += data));
let browser;
const errors = [];
try {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (
      await fetch(`${base}/api/health`)
        .then((res) => res.ok)
        .catch(() => false)
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(await fetch(`${base}/api/health`).then((res) => res.ok), serverLog);
  browser = await chromium.launch({
    channel: process.env.FASTWRITE_E2E_CHANNEL ?? "chrome",
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1500, height: 1000 },
  });
  const user = await (
    await context.request.post(`${base}/api/auth/register`, {
      data: {
        email: "latex-e2e@example.test",
        password: "latex-browser-test-password",
      },
    })
  ).json();
  await context.addInitScript((token) => {
    localStorage.setItem("fastwrite.session-token", token);
    localStorage.setItem("fastwrite.completion.enabled", "false");
    localStorage.setItem("fastwrite.collaboration.enabled", "false");
  }, user.token);
  await context.setExtraHTTPHeaders({ authorization: `Bearer ${user.token}` });
  const project = await (
    await context.request.post(`${base}/api/projects`, {
      data: { name: "LaTeX browser services" },
    })
  ).json();
  const api = `${base}/api/projects/${project.id}`;
  const read = async (path) =>
    await (
      await context.request.get(`${api}/file?path=${encodeURIComponent(path)}`)
    ).json();
  const original = await read("main.tex");
  const source = String.raw`\documentclass{article}
\usepackage{amsmath}
\newcommand{\projectmacro}[1]{#1}
\begin{document}
\section{Test}\label{sec:result}
A result. \fixturebroken
\end{document}
`;
  assert.ok(
    (
      await context.request.put(`${api}/file?path=main.tex`, {
        data: { content: source, baseVersion: original.file.version },
      })
    ).ok(),
  );
  assert.ok(
    (
      await context.request.post(`${api}/files`, {
        data: {
          path: "refs.bib",
          content:
            "@article{Smith2026, title={Reliable Citation Test}, author={Smith, Alice}, year={2026}, doi={10.123/test}}\n@book{Doe2025, title={Another Reference}, author={Doe, Bob}, year={2025}}",
        },
      })
    ).ok(),
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/projects/${project.id}`);
  const editor = page.getByRole("textbox", {
    name: "源文件编辑器： main.tex",
    exact: true,
  });
  await editor.waitFor();
  await editor.focus();
  await page.keyboard.press("Control+End");
  assert.equal(await page.getByLabel("LaTeX 写作工具").count(), 0);
  await page.screenshot({ path: "/tmp/fastwrite-editor-spacing-ui.png" });
  await page.keyboard.press("Control+Shift+C");
  const citation = page.getByRole("dialog", { name: "插入或编辑引用" });
  await citation.getByRole("textbox", { name: "检索文献" }).fill("no-such-citation");
  await citation.getByText("没有匹配的文献", { exact: true }).waitFor();
  assert.ok(await citation.getByRole("button", { name: "插入所选引用" }).isDisabled());
  await citation.getByRole("textbox", { name: "检索文献" }).fill("Smith 2026");
  await citation
    .getByRole("checkbox", { name: "Reliable Citation Test" })
    .check();
  await page.screenshot({ path: "/tmp/fastwrite-citation-ui.png" });
  await citation.getByRole("button", { name: "插入所选引用" }).click();
  await citation.waitFor({ state: "hidden" });
  await page.waitForTimeout(1200);
  assert.ok((await read("main.tex")).content.includes("\\cite{Smith2026}"));
  // The project macro is deterministic and works while AI completion is disabled.
  await editor.focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\\projectm");
  await page.keyboard.press("Control+Space");
  await page.getByRole("option", { name: /projectmacro/ }).waitFor();
  await page.keyboard.press("Escape");
  // Remove the deliberately partial command before checking the compiler.
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  // Replacing text through the API also exercises refresh and server version checking.
  let current = await read("main.tex");
  await context.request.put(`${api}/file?path=main.tex`, {
    data: { content: source, baseVersion: current.file.version },
  });
  await page.reload();
  await editor.waitFor();
  await page
    .getByRole("button", { name: "编译助手与待审核修改", exact: true })
    .click();
  const assistant = page.getByRole("dialog", { name: "编译助手与待审核修改" });
  await assistant.getByRole("checkbox", { name: /单条错误最小修复/ }).check();
  await assistant.getByRole("button", { name: "检查并生成候选" }).click();
  await assistant
    .getByText("候选已在当前项目快照中编译通过", { exact: false })
    .waitFor({ timeout: 90_000 });
  assert.ok(
    (await read("main.tex")).content.includes("\\fixturebroken"),
    "candidate must not modify source before approval",
  );
  const diff = assistant.locator(".text-model-comparison__editor");
  await diff.waitFor();
  assert.ok((await diff.boundingBox()).height >= 200, "candidate diff must have a readable height");
  await diff.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/fastwrite-compile-review-ui.png" });
  const accept = assistant.getByRole("button", { name: "接受修改", exact: true });
  const acceptBox = await accept.boundingBox();
  assert.ok(acceptBox.y + acceptBox.height <= 1000, "review action must stay visible while the diff scrolls");
  await accept.click();
  await page.waitForTimeout(1000);
  assert.ok(!(await read("main.tex")).content.includes("\\fixturebroken"));
  await page.screenshot({
    path: "/tmp/fastwrite-latex-services-e2e.png",
    fullPage: true,
  });
  await assistant.getByRole("button", { name: "关闭对话框" }).click();
  await page.getByRole("button", { name: "项目设置", exact: true }).click();
  const settings = page.getByRole("tabpanel", { name: "设置", exact: true });
  await settings.getByRole("button", { name: "编译环境", exact: true }).click();
  await settings.getByRole("combobox", { name: "TeX 引擎" }).click();
  await settings.getByRole("option", { name: "xelatex", exact: true }).click();
  await settings.getByRole("button", { name: "保存更改", exact: true }).click();
  await settings.getByText("设置已保存", { exact: true }).waitFor();
  assert.equal(
    (await (await context.request.get(api)).json()).compilation.engine,
    "xelatex",
  );
  await settings.getByRole("table", { name: "TeX 引擎安装状态" }).waitFor();
  await page.screenshot({ path: "/tmp/fastwrite-compile-environment-ui.png" });
  await page.route("**/api/tex-environments", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "environment_unavailable", message: "环境检查暂时不可用" } }) }));
  await settings.getByRole("button", { name: "重新检查环境", exact: true }).click();
  await settings.getByRole("alert").getByText("环境检查暂时不可用").waitFor();
  await page.unroute("**/api/tex-environments");
  await settings.getByRole("button", { name: "重新检查环境", exact: true }).click();
  await settings.getByRole("button", { name: "检查已保存项目的宏包依赖" }).click();
  await settings.getByRole("region", { name: "项目依赖", exact: true }).waitFor();
  await settings.getByRole("button", { name: "外部 MCP", exact: true }).click();
  await settings.getByRole("button", { name: "创建 30 天连接令牌" }).click();
  await settings.getByRole("textbox", { name: "Bearer 令牌" }).waitFor();
  const token = await settings
    .getByRole("textbox", { name: "Bearer 令牌" })
    .inputValue();
  assert.ok(token.startsWith("fw_mcp_"));
  await settings.getByRole("button", { name: "隐藏令牌" }).click();
  await settings.getByRole("button", { name: "撤销", exact: true }).click();
  await settings.getByText("已撤销", { exact: true }).waitFor();
  await page.evaluate(() => document.documentElement.dataset.theme = "dark");
  await page.screenshot({ path: "/tmp/fastwrite-mcp-dark-ui.png" });
  const duplicateControlIds = await settings.evaluate(element => {
    const ids = Array.from(element.querySelectorAll("input[id], textarea[id], button[id]")).map(control => control.id);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  });
  assert.deepEqual(duplicateControlIds, []);
  assert.deepEqual(errors, []);
  console.log(
    "LaTeX browser checks passed: reference search/insertion, deterministic project macro completion, isolated compiler repair and explicit acceptance, environment settings and revocable MCP credentials.",
  );
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  await rm(root, { recursive: true, force: true });
}
