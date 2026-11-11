import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const report = join(root, 'output/ui-refresh-phase2');
await mkdir(report, { recursive: true });
const data = await mkdtemp(join(tmpdir(), 'fastwrite-ai-workspace-'));
const server = spawn('bun', ['--no-env-file', 'scripts/e2e-reference-fixture.ts'], {
  cwd: root,
  env: { ...process.env, FASTWRITE_DATA_DIR: data, FASTWRITE_PORT: '0', FASTWRITE_POSTGRES_URL: '', FASTWRITE_REDIS_URL: '', FASTWRITE_WEB_DIR: join(root, 'apps/web/dist') },
  stdio: ['ignore', 'pipe', 'pipe']
});
let logs = '';
let browser;
let page;
let releasePending;
const errors = [];
const cases = [];
const within = (promise, label) => Promise.race([promise, new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timed out`)), 20000);
  timer.unref();
})]);
try {
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fixture startup timed out: ${logs}`)), 20000);
    server.stderr.on('data', chunk => { logs += chunk; });
    server.stdout.on('data', chunk => {
      logs += chunk;
      const match = logs.match(/REFERENCE_E2E_URL=(http:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
  });
  browser = await chromium.launch({ channel: process.env.FASTWRITE_E2E_CHANNEL ?? 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  const web = process.env.FASTWRITE_AI_E2E_WEB_URL ?? base;
  if (web !== base) await context.route(`${web}/api/**`, async route => {
    const response = await route.fetch({ url: base + new URL(route.request().url()).pathname + new URL(route.request().url()).search });
    await route.fulfill({ response });
  });
  const created = await context.request.post(`${base}/api/projects`, { data: { name: 'AI 工作区回归验收' } });
  assert.ok(created.ok());
  const project = await created.json();
  const api = `${base}/api/projects/${project.id}`;
  const source = '\\documentclass{article}\n\\begin{document}\n\\section{Introduction}\n\nOriginal statement. Our protocol preserves 17 observations.\n\n\\section{Conclusion}\n\nUnrelated conclusion.\n\n\\end{document}\n';
  const opened = await (await context.request.get(`${api}/file?path=main.tex`)).json();
  const saved = await context.request.put(`${api}/file?path=main.tex`, { data: { content: source, baseVersion: opened.file.version } });
  assert.ok(saved.ok());
  const { file } = await saved.json();
  const makeSelection = (text, line) => ({ path: 'main.tex', text, from: source.indexOf(text), to: source.indexOf(text) + text.length, startLine: line, endLine: line, fileVersion: file.version });
  const firstSelection = makeSelection('Original statement. Our protocol preserves 17 observations.', 5);
  const secondSelection = makeSelection('Unrelated conclusion.', 9);
  const keyOf = selection => `${selection.path}:${selection.from}:${selection.to}:${selection.fileVersion}:${selection.text}`;
  const storageOf = selection => `fastwrite.revise.${project.id}.${encodeURIComponent(keyOf(selection))}`;
  const history = Array.from({ length: 30 }, (_, index) => ({ id: `history-${index}`, role: index % 2 ? 'assistant' : 'user', content: `历史消息 ${index + 1}\n` + '保留事实与引用，调整论述顺序。\n'.repeat(5) }));
  await context.addInitScript(({ projectId, firstSelection, secondSelection, firstKey, secondKey, firstStorage, secondStorage, history }) => {
    localStorage.setItem('fastwrite.completion.enabled', 'false');
    localStorage.setItem('fastwrite.collaboration.enabled', 'false');
    localStorage.setItem('fastwrite.theme', 'light');
    // Seed once so reload exercises the application's persisted edits.
    if (!localStorage.getItem(firstStorage)) {
      localStorage.setItem(firstStorage, JSON.stringify({ selection: firstSelection, messages: history, changeSet: null, workingText: '', instruction: '尚未发送的修改草稿' }));
      localStorage.setItem(secondStorage, JSON.stringify({ selection: secondSelection, messages: [{ id: 'second-thread', role: 'user', content: '另一个选区的历史消息' }], changeSet: null, workingText: '', instruction: '另一选区的独立草稿' }));
      localStorage.setItem(`fastwrite.revise.${projectId}.latest`, firstKey);
    }
  }, { projectId: project.id, firstSelection, secondSelection, firstKey: keyOf(firstSelection), secondKey: keyOf(secondSelection), firstStorage: storageOf(firstSelection), secondStorage: storageOf(secondSelection), history });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  let revisionCalls = 0;
  let nextGate;
  await page.route('**/api/projects/*/revisions', async route => {
    revisionCalls++;
    const gate = nextGate;
    nextGate = undefined;
    const response = await route.fetch({ url: `${api}/revisions` });
    if (gate) {
      gate.started.resolve();
      await gate.release.promise;
    }
    try { await route.fulfill({ response }); }
    catch (error) { if (!gate) throw error; }
    finally { gate?.finished.resolve(); }
  });
  const holdNext = () => {
    const gate = { started: Promise.withResolvers(), release: Promise.withResolvers(), finished: Promise.withResolvers() };
    nextGate = gate;
    releasePending = () => gate.release.resolve();
    return gate;
  };
  const readSource = async () => (await (await context.request.get(`${api}/file?path=main.tex`)).json()).content;
  await page.goto(`${web}/projects/${project.id}`);
  const editor = page.getByRole('textbox', { name: '源文件编辑器： main.tex', exact: true });
  const input = page.getByRole('textbox', { name: '修改要求', exact: true });
  await editor.waitFor();
  await expect(input).toHaveValue('尚未发送的修改草稿');
  await expect(page.locator('.revise-message')).toHaveCount(30);
  cases.push('selection, conversation and unsent draft restore');

  const viewport = page.getByRole('log', { name: '修改对话', exact: true });
  await expect.poll(() => viewport.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(41);
  await viewport.evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
  await page.getByRole('button', { name: '回到最新消息', exact: true }).waitFor();
  await input.fill('请保留事实，改进这一段。');
  const beforeIme = revisionCalls;
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229 });
  await input.press('Shift+Enter');
  assert.equal(revisionCalls, beforeIme, 'IME confirmation and Shift+Enter must not send');
  assert.ok((await input.inputValue()).includes('\n'));
  cases.push('Chinese IME and Shift+Enter do not submit');

  await input.fill('停止后保留这条修改要求');
  const stopped = holdNext();
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await within(stopped.started.promise, 'stopped request');
  assert.ok(await viewport.evaluate(node => node.scrollTop < 10), 'new messages do not pull a reader to the bottom');
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await expect(input).toHaveValue('停止后保留这条修改要求');
  stopped.release.resolve();
  await within(stopped.finished.promise, 'late response');
  await expect(page.getByRole('region', { name: '修改候选', exact: true })).toHaveCount(0);
  assert.equal(await readSource(), source);
  await page.getByRole('button', { name: '回到最新消息', exact: true }).click();
  await expect.poll(() => viewport.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(41);
  cases.push('reading position stays stable; stop ignores the late response and restores the prompt');

  const chooseParagraph = async line => {
    await page.getByRole('button', { name: '清除所选上下文', exact: true }).click();
    await editor.focus();
    await editor.press('Control+Home');
    for (let index = 1; index < line; index++) await editor.press('ArrowDown');
    await page.getByRole('button', { name: '使用当前段落', exact: true }).click();
  };
  await chooseParagraph(9);
  await expect(input).toHaveValue('另一选区的独立草稿');
  await expect(page.locator('.revise-message')).toHaveCount(1);
  await chooseParagraph(5);
  await expect(input).toHaveValue('停止后保留这条修改要求');
  cases.push('switching selections restores separate drafts and conversation history');

  const switched = holdNext();
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await within(switched.started.promise, 'mode switch request');
  await page.getByRole('group', { name: 'AI 写作模式', exact: true }).getByRole('button', { name: '智能助手', exact: true }).click();
  switched.release.resolve();
  await within(switched.finished.promise, 'mode switch response');
  await page.getByRole('group', { name: 'AI 写作模式', exact: true }).getByRole('button', { name: '修改', exact: true }).click();
  await expect(page.getByRole('region', { name: '修改候选', exact: true })).toHaveCount(0);
  await expect(input).toHaveValue('停止后保留这条修改要求');
  cases.push('switching modes cancels the request without mixing results');

  await input.fill('润色当前段落并保留观测数量');
  await input.press('Enter');
  const candidate = page.getByRole('region', { name: '修改候选', exact: true });
  await candidate.waitFor();
  assert.equal(await readSource(), source, 'a proposal never writes the manuscript');
  await candidate.getByRole('button', { name: '编辑', exact: true }).click();
  const authored = 'Revised statement. Our protocol preserves 17 observations. Author-reviewed wording.';
  await page.getByRole('textbox', { name: '可编辑的修改文本', exact: true }).fill(authored);
  await expect.poll(async () => page.evaluate(key => JSON.parse(localStorage.getItem(key)).workingText, storageOf(firstSelection))).toBe(authored);
  await page.reload();
  await editor.waitFor();
  await expect(page.getByRole('textbox', { name: '可编辑的修改文本', exact: true })).toHaveValue(authored);
  cases.push('manual candidate edits survive reload');

  await input.fill('停止重试时保留现有候选');
  const retry = holdNext();
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await within(retry.started.promise, 'candidate retry');
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  retry.release.resolve();
  await within(retry.finished.promise, 'candidate retry late response');
  await expect(page.getByRole('textbox', { name: '可编辑的修改文本', exact: true })).toHaveValue(authored);
  assert.equal(await readSource(), source);
  cases.push('stopping a retry keeps the previous candidate and manual edits available');

  await candidate.getByRole('button', { name: '保存并接受', exact: true }).click();
  await expect.poll(readSource).toContain(authored);
  assert.ok((await readSource()).includes('Unrelated conclusion.'));
  await candidate.getByRole('button', { name: '回滚', exact: true }).waitFor();
  const axe = await readFile(join(root, 'node_modules/axe-core/axe.min.js'), 'utf8');
  await page.route('**/__ai-test-axe.js', route => route.fulfill({ contentType: 'application/javascript', body: axe }));
  await page.addScriptTag({ url: '/__ai-test-axe.js' });
  const layout = [];
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await page.getByRole('button', { name: '切换深色主题', exact: true }).click();
    for (const width of [1440, 720]) {
      await page.setViewportSize({ width, height: 1000 });
      const latest = page.getByRole('button', { name: '回到最新消息', exact: true });
      if (await latest.isVisible()) await latest.click();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false, `${theme} ${width}: no page overflow`);
      layout.push({ theme, width, overflow });
      await page.screenshot({ path: join(report, `ai-workspace-${theme}-${width}.png`), animations: 'disabled' });
      const service = page.getByRole('combobox', { name: '智能助手服务', exact: true });
      await service.click();
      const choices = page.getByRole('listbox', { name: '智能助手服务', exact: true });
      await expect(choices.getByRole('option', { name: 'Codex', exact: true })).toHaveAttribute('aria-selected', 'true');
      assert.equal(await choices.evaluate(node => {
        const box = node.getBoundingClientRect();
        const x = box.x + box.width / 2;
        return [box.y + 3, box.bottom - 3].every(y => node.contains(document.elementFromPoint(x, y)));
      }), true, `${theme} ${width}: service menu is visible and clickable`);
      await page.locator('.ai-workspace').screenshot({ path: join(report, `service-picker-${theme}-${width}.png`), animations: 'disabled' });
      if (width === 1440) {
        const triggerBox = await page.locator('.ai-workspace__harness').boundingBox();
        const menuBox = await choices.boundingBox();
        const x = Math.min(triggerBox.x, menuBox.x) - 8;
        const y = triggerBox.y - 6;
        await page.screenshot({ path: join(report, `service-picker-${theme}.png`), animations: 'disabled', clip: {
          x, y, width: Math.max(triggerBox.x + triggerBox.width, menuBox.x + menuBox.width) - x + 8,
          height: menuBox.y + menuBox.height - y + 12
        } });
      }
      const menuViolations = await page.evaluate(async () => (await window.axe.run(document.querySelector('.ai-workspace__harness'))).violations.filter(item => ['critical', 'serious'].includes(item.impact)).map(item => ({ id: item.id, nodes: item.nodes.map(node => ({ target: node.target, summary: node.failureSummary })) })));
      assert.deepEqual(menuViolations, [], `${theme} ${width}: expanded service menu accessibility`);
      await page.keyboard.press('Escape');
    }
    const violations = await page.evaluate(async () => {
      const result = await window.axe.run(document.querySelector('.ai-workspace'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } });
      return result.violations.filter(item => ['critical', 'serious'].includes(item.impact)).map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) }));
    });
    assert.deepEqual(violations, [], `${theme}: AI workspace axe violations`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await candidate.getByRole('button', { name: '回滚', exact: true }).click();
  await expect.poll(readSource).toBe(source);
  cases.push('only accepted edited text is written; rollback preserves the rest of the manuscript');
  assert.deepEqual(errors, []);
  const result = { result: 'pass', cases, layout, revisionCalls, pageErrors: errors };
  await writeFile(join(report, 'checks.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  await page?.screenshot({ path: join(report, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(join(report, 'fixture.log'), logs);
  throw error;
} finally {
  releasePending?.();
  await browser?.close();
  server.kill('SIGTERM');
  if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
  await rm(data, { recursive: true, force: true });
}
