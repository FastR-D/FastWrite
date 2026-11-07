import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const integrations = (await Promise.all(['agent-writing-skills', 'social-research-skills'].map(async directory => JSON.parse(await readFile(join(root, `evaluation/${directory}/integrations.json`), 'utf8'))))).flat();
const data = await mkdtemp(join(tmpdir(), 'fastwrite-skills-browser-'));
// This existing fixture records Agent inputs and never invokes a live model.
const server = spawn('bun', ['scripts/e2e-reference-fixture.ts'], { cwd: root, env: { ...process.env, FASTWRITE_DATA_DIR: data, FASTWRITE_PORT: '0', FASTWRITE_WEB_DIR: join(root, 'apps/web/dist'), FASTWRITE_DEVELOPMENT_ADMIN: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', browser;
server.stderr.on('data', chunk => { logs += chunk; });
try {
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fixture server timed out: ${logs}`)), 20000);
    server.stdout.on('data', chunk => { logs += chunk; const match = logs.match(/REFERENCE_E2E_URL=(http:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    server.on('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
  });
  browser = await chromium.launch({ channel: process.env.FASTWRITE_E2E_CHANNEL ?? 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 720 } });
  await context.addInitScript(() => { localStorage.setItem('fastwrite.completion.enabled', 'false'); localStorage.setItem('fastwrite.collaboration.enabled', 'false'); });
  await context.route('**/api/projects/*/compile', route => route.fulfill({ status: 503, json: { error: { code: 'fixture_compile_disabled', message: 'Compilation is outside this Skill acceptance.' } } }));
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const create = async name => {
    const response = await context.request.post(`${base}/api/projects`, { data: { name } });
    assert.ok(response.ok());
    const project = await response.json();
    const file = await (await context.request.get(`${base}/api/projects/${project.id}/file?path=main.tex`)).json();
    assert.ok((await context.request.put(`${base}/api/projects/${project.id}/file?path=main.tex`, { data: { baseVersion: file.file.version, content: '\\documentclass{article}\n\\begin{document}\n\\section{Method}\nOriginal statement. The protocol preserves the supplied observations.\n\\end{document}\n' } })).ok());
    return project;
  };
  const first = await create('Builtin Skill selection'), second = await create('Independent Skill selection');
  const catalogResponse = await context.request.get(`${base}/api/agent-skills`);
  assert.ok(catalogResponse.ok());
  const catalog = await catalogResponse.json();
  for (const skill of integrations) assert.ok(catalog.some(item => item.id === skill.id && item.version === skill.version));
  const open = async project => {
    await page.goto(`${base}/projects/${project.id}`);
    const tab = page.getByRole('navigation', { name: '工作区视图' }).getByRole('button', { name: 'Skill', exact: true });
    await expect(tab).toBeVisible();
    if (await tab.getAttribute('aria-pressed') !== 'true') await tab.click();
    await expect(page.locator('#sidebar-skills').getByRole('checkbox')).toHaveCount(catalog.length);
  };
  const panel = page.locator('#sidebar-skills');
  const skill = name => panel.getByRole('checkbox', { name: new RegExp(name) });
  await open(first);
  const scrollArea = panel.getByRole('region', { name: 'Skill 列表', exact: true });
  assert.ok(await scrollArea.evaluate(element => element.scrollHeight > element.clientHeight), 'Skill content overflows its bounded sidebar region');
  const headerTop = (await panel.locator('header').boundingBox()).y;
  await scrollArea.hover();
  await page.mouse.wheel(0, 500);
  await expect.poll(() => scrollArea.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  assert.equal((await panel.locator('header').boundingBox()).y, headerTop, 'Skill header stays visible while its content scrolls');
  await scrollArea.evaluate(element => { element.scrollTop = 0; });
  await scrollArea.focus();
  await scrollArea.press('PageDown');
  await expect.poll(() => scrollArea.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await skill('反防御性写作（中文）').check();
  await page.reload();
  await expect(skill('反防御性写作（中文）')).toBeChecked();
  await open(second);
  await expect(panel.locator('input:checked')).toHaveCount(0);
  // Stage shortcuts replace the selection, persist it and remain isolated per project.
  for (const [label, ids] of [
    ['文献入稿', ['paper-reading-notes', 'literature-synthesis']],
    ['搭建主线', ['evidence-storyline', 'scientific-writing']],
    ['撰写实验', ['experiment-reporting']],
    ['解读结果', ['results-discussion']],
    ['核对图注', ['figure-caption-audit']],
    ['全文复核', ['manuscript-consistency', 'academic-prose-polish']],
  ]) {
    const preset = panel.getByRole('button', { name: label, exact: true });
    await preset.click();
    await expect(preset).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.locator('input:checked')).toHaveCount(ids.length);
    assert.deepEqual(JSON.parse(await page.evaluate(key => localStorage.getItem(key), `fastwrite.task-skills:${second.id}`)), ids);
  }
  await page.reload();
  await expect(panel.getByRole('button', { name: '全文复核', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await panel.getByRole('button', { name: '清空选择' }).click();
  await open(first);
  await expect(skill('反防御性写作（中文）')).toBeChecked();
  for (const name of ['反防御性写作（英文）', '论断与证据核查', 'LaTeX 结构优化', '实验设计']) await skill(name).check();
  await expect(skill('威胁模型')).toBeDisabled();
  await panel.getByRole('button', { name: '清空选择' }).click();
  await skill('反防御性写作（中文）').check();
  await panel.getByRole('button', { name: '用于智能助手' }).click();
  const agent = page.getByRole('region', { name: '智能助手工作区' });
  await agent.getByLabel('希望智能助手做什么？').fill('Improve the wording while preserving the evidence.');
  const planned = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/api/projects/${first.id}/agent-tasks`));
  await agent.getByRole('button', { name: '创建计划' }).click();
  const response = await planned;
  assert.equal(response.status(), 201, await response.text());
  assert.deepEqual(response.request().postDataJSON().taskSkillIds, ['anti-defensive-writing']);
  assert.deepEqual((await response.json()).plan.taskSkills.map(item => item.id), ['anti-defensive-writing']);
  const confirmed = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/confirm'));
  await agent.getByRole('button', { name: '确认计划' }).click();
  const generated = await confirmed;
  assert.equal(generated.status(), 201, await generated.text());
  const calls = await (await context.request.get(`${base}/__reference_e2e__/calls`)).json();
  for (const operation of ['plan', 'generate']) {
    assert.ok(calls.find(call => call.operation === operation).input.skillInstructions.includes('# Task Skill: anti-defensive-writing v1.0.0'));
  }

  // Each imported adaptation must reach both real application stages, not just the catalog.
  for (const skill of integrations) {
    await open(first);
    await panel.getByRole('button', { name: '清空选择' }).click();
    await panel.getByRole('checkbox', { name: new RegExp(skill.label) }).check();
    const planResponse = await context.request.post(`${base}/api/projects/${first.id}/agent-tasks`, { data: {
      objective: 'Revise main.tex using the selected Skill while preserving the supplied observations.',
      scope: { type: 'project' }, intent: 'revise', taskSkillIds: [skill.id]
    } });
    assert.equal(planResponse.status(), 201, await planResponse.text());
    const plan = (await planResponse.json()).plan;
    assert.deepEqual(plan.taskSkills.map(item => ({ id: item.id, version: item.version })), [{ id: skill.id, version: skill.version }]);
    const generated = await context.request.post(`${base}/api/projects/${first.id}/agent-tasks/${plan.id}/confirm`);
    assert.equal(generated.status(), 201, await generated.text());
    const recorded = await (await context.request.get(`${base}/__reference_e2e__/calls`)).json();
    for (const operation of ['plan', 'generate']) {
      assert.ok(recorded.some(call => call.operation === operation && call.input.skillInstructions.includes(`# Task Skill: ${skill.id} v${skill.version}`)));
    }
  }

  await open(second);
  await skill('威胁模型').check();
  await expect(panel.getByRole('button', { name: '用于智能助手' })).toBeDisabled();
  const editor = page.getByRole('textbox', { name: '源文件编辑器： main.tex', exact: true });
  await editor.focus(); await editor.press('Control+Home'); await editor.press('ArrowDown'); await editor.press('ArrowDown'); await editor.press('ArrowDown');
  await expect(panel.getByRole('button', { name: '用于智能助手' })).toBeEnabled();
  await panel.getByRole('button', { name: '用于智能助手' }).click();
  await agent.getByLabel('希望智能助手做什么？').fill('Clarify the threat model for this section.');
  const sectionPlan = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/api/projects/${second.id}/agent-tasks`));
  await agent.getByRole('button', { name: '创建计划' }).click();
  const scoped = await sectionPlan;
  assert.equal(scoped.status(), 201, await scoped.text());
  assert.equal(scoped.request().postDataJSON().scope.type, 'section');
  assert.equal(scoped.request().postDataJSON().scope.path, 'main.tex');
  assert.deepEqual(scoped.request().postDataJSON().taskSkillIds, ['threat-model']);
  await mkdir(join(root, 'output/skills'), { recursive: true });
  await page.screenshot({ path: join(root, 'output/skills/sidebar.png'), fullPage: true });
  await open(first);
  await panel.getByRole('button', { name: '搭建主线', exact: true }).click();
  await scrollArea.evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: join(root, 'output/skills/writing-stages.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(`PASS: ${integrations.length} writing Skills selected in UI and loaded into application planning/generation; scrolling, persistence/isolation, five-Skill limit and section scope`);
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill('SIGTERM');
    await exited;
  }
  await rm(data, { recursive: true, force: true });
}
