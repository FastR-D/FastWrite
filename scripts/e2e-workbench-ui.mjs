import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const report = join(root, 'output/ui-refresh-phase3');
await mkdir(report, { recursive: true });
const data = await mkdtemp(join(tmpdir(), 'fastwrite-workbench-ui-'));
const fixture = spawn('bun', ['--no-env-file', 'scripts/e2e-reference-fixture.ts'], {
  cwd: root, env: { ...process.env, FASTWRITE_DATA_DIR: data, FASTWRITE_PORT: '0', FASTWRITE_POSTGRES_URL: '', FASTWRITE_REDIS_URL: '', FASTWRITE_WEB_DIR: join(root, 'apps/web/dist') }, stdio: ['ignore', 'pipe', 'pipe']
});
let logs = '', browser, page;
const errors = [], cases = [], layout = [];
try {
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fixture startup timed out: ${logs}`)), 20000);
    fixture.stderr.on('data', chunk => { logs += chunk; });
    fixture.stdout.on('data', chunk => {
      logs += chunk;
      const match = logs.match(/REFERENCE_E2E_URL=(http:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    fixture.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
  });
  browser = await chromium.launch({ channel: process.env.FASTWRITE_E2E_CHANNEL ?? 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  const web = process.env.FASTWRITE_UI_E2E_WEB_URL ?? base;
  if (web !== base) await context.route(`${web}/api/**`, async route => {
    const url = new URL(route.request().url());
    await route.fulfill({ response: await route.fetch({ url: base + url.pathname + url.search }) });
  });
  await context.addInitScript(() => {
    localStorage.setItem('fastwrite.completion.enabled', 'false');
    localStorage.setItem('fastwrite.collaboration.enabled', 'false');
    if (!localStorage.getItem('fastwrite.theme')) localStorage.setItem('fastwrite.theme', 'light');
  });
  const created = await context.request.post(`${base}/api/projects`, { data: { name: '工作台 UI 验收' } });
  assert.ok(created.ok());
  const project = await created.json();
  const api = `${base}/api/projects/${project.id}`;
  const original = await (await context.request.get(`${api}/file?path=main.tex`)).json();
  const source = '\\documentclass{article}\n\\begin{document}\n\\section{Introduction}\n\nA bounded statement with 17 observations.\n\n\\end{document}\n';
  assert.ok((await context.request.put(`${api}/file?path=main.tex`, { data: { content: source, baseVersion: original.file.version } })).ok());
  const longName = 'a-long-file-name-for-preview-tab-layout-and-close-actions.tex';
  for (const path of ['method.tex', longName]) assert.ok((await context.request.post(`${api}/files`, { data: { path, content: `% ${path}\n` } })).ok());
  const pdf = Buffer.from(await (await context.request.get(`${base}/__reference_e2e__/pdf`)).body()).toString('base64');
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  let mode = 'success', held = true, compileCalls = 0;
  const jobs = new Map();
  await page.route('**/api/projects/*/compile', async route => {
    if (mode === 'network') { await route.abort('internetdisconnected'); return; }
    const snapshot = await (await context.request.get(api)).json();
    const id = `ui-fixture-${++compileCalls}`;
    jobs.set(id, { mode, version: snapshot.version });
    await route.fulfill({ json: { id, kind: 'latex.compile', status: 'queued' } });
  });
  await page.route('**/api/jobs/ui-fixture-*', async route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    const job = jobs.get(id);
    if (held) { await route.fulfill({ json: { id, kind: 'latex.compile', status: 'running', attempts: 1 } }); return; }
    const failed = job.mode === 'error';
    await route.fulfill({ json: { id, kind: 'latex.compile', status: 'completed', attempts: 1, output: {
      success: !failed, projectVersion: job.version, snapshotId: id, workspacePaths: ['main.tex'],
      log: failed ? './main.tex:5: Undefined control sequence.\nl.5 \\brokencommand\n! Emergency stop.' : 'Output written on main.pdf (1 page).',
      ...(failed ? { error: 'Undefined control sequence at main.tex:5' } : { pdfBase64: pdf })
    } } });
  });
  await page.goto(`${web}/projects/${project.id}`);
  const editor = page.getByRole('textbox', { name: '源文件编辑器： main.tex', exact: true });
  await editor.waitFor();
  const strip = page.locator('.compile-strip');
  await expect(strip).toContainText('正在编译');
  await page.screenshot({ path: join(report, 'workbench-loading.png'), animations: 'disabled' });
  await strip.getByRole('button', { name: '取消', exact: true }).click();
  await expect(strip).toContainText('已取消编译');
  held = false;
  await strip.getByRole('button', { name: '编译', exact: true }).click();
  await expect(strip).toContainText('编译成功');
  await page.locator('.react-pdf__Page__canvas').first().waitFor();
  cases.push('loading and cancellation show real state; successful PDF renders');

  const tabs = page.getByRole('group', { name: '已打开的编辑器 controls', exact: true });
  await tabs.getByRole('tab', { name: 'main.tex', exact: true }).dblclick();
  await page.locator('span[title="method.tex"]').click();
  await tabs.getByRole('tab', { name: 'method.tex', exact: true }).waitFor();
  await page.locator(`span[title="${longName}"]`).click();
  await tabs.getByRole('tab', { name: longName, exact: true }).waitFor();
  assert.equal(await tabs.getByRole('tab').count(), 2, 'one preview tab');
  await tabs.getByRole('tab', { name: longName, exact: true }).dblclick();
  await page.locator('span[title="method.tex"]').click();
  await tabs.getByRole('tab', { name: 'method.tex', exact: true }).focus();
  await page.keyboard.press('Home');
  await expect(tabs.getByRole('tab', { name: 'main.tex', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(tabs.getByRole('tab', { name: 'method.tex', exact: true })).toHaveAttribute('aria-selected', 'true');
  await tabs.getByRole('tab', { name: 'method.tex', exact: true }).click({ button: 'middle' });
  await expect(tabs.getByRole('tab', { name: 'method.tex', exact: true })).toHaveCount(0);
  await tabs.getByRole('button', { name: `关闭 ${longName}`, exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(tabs.getByRole('tab')).toHaveCount(1);
  cases.push('preview replacement, pinning, Home/End, middle-click and keyboard close retain editor behavior');

  const axe = await readFile(join(root, 'node_modules/axe-core/axe.min.js'), 'utf8');
  await page.route('**/__ui-axe.js', route => route.fulfill({ contentType: 'application/javascript', body: axe }));
  await page.addScriptTag({ url: '/__ui-axe.js' });
  const accessible = async selector => {
    const violations = await page.evaluate(async selector => (await window.axe.run(document.querySelector(selector), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.filter(v => ['critical', 'serious'].includes(v.impact)).map(v => ({ id: v.id, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) })), selector);
    assert.deepEqual(violations, [], `${selector}: axe violations`);
  };
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await page.getByRole('button', { name: '切换深色主题', exact: true }).click();
    for (const width of [1440, 1280, 1024, 720]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${theme} ${width}: no page overflow`);
      const activity = page.getByRole('navigation', { name: '工作区视图', exact: true });
      await activity.getByRole('button', { name: '大纲', exact: true }).click();
      await expect(page.locator('#sidebar-outline')).toBeVisible();
      await activity.getByRole('button', { name: '文件', exact: true }).click();
      await expect(page.locator('#sidebar-files')).toBeVisible();
      if (await page.locator('.pdf-pane').isVisible()) await page.locator('.react-pdf__Page__canvas').first().waitFor();
      const panelTabs = page.getByRole('group', { name: '底部面板 controls', exact: true });
      const metrics = await panelTabs.evaluate(node => {
        const strip = node.getBoundingClientRect();
        return [...node.querySelectorAll('[role="tab"]')].map(tab => {
          const box = tab.getBoundingClientRect(), label = tab.firstElementChild.getBoundingClientRect(), style = getComputedStyle(tab);
          return { radius: style.borderRadius, contained: box.top >= strip.top && box.bottom <= strip.bottom,
            xOffset: Math.abs(label.x + label.width / 2 - box.x - box.width / 2), yOffset: Math.abs(label.y + label.height / 2 - box.y - box.height / 2) };
        });
      });
      for (const metric of metrics) {
        assert.equal(metric.radius, '0px', 'panel tabs use a flat IDE surface');
        assert.equal(metric.contained, true, 'panel tabs fit their heading');
        assert.ok(metric.xOffset <= 1 && metric.yOffset <= 1, `panel labels are centered: ${JSON.stringify(metric)}`);
      }
      await page.locator('.bottom-panel-heading').screenshot({ path: join(report, `panel-tabs-${theme}-${width}.png`), animations: 'disabled' });
      layout.push({ theme, width, overflow: false });
      await page.screenshot({ path: join(report, `workbench-${theme}-${width}.png`), animations: 'disabled' });
      await accessible('.activity-bar');
      await accessible('.editor-tabs');
      if (await page.locator('.pdf-pane').isVisible()) await accessible('.pdf-pane');
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const divider = page.getByRole('separator', { name: '调整 PDF 预览大小', exact: true });
  await divider.focus();
  for (let step = 0; step < 40 && Number(await divider.getAttribute('aria-valuenow')) > 330; step++) await page.keyboard.press('ArrowRight');
  assert.ok(Number(await divider.getAttribute('aria-valuenow')) <= 330);
  await expect(page.locator('.pdf-pane')).toBeVisible();
  await page.locator('.react-pdf__Page__canvas').first().waitFor();
  assert.equal(await page.locator('.pdf-toolbar').evaluate(node => node.scrollWidth > node.clientWidth), false, 'narrow PDF toolbar wraps its controls');
  await page.screenshot({ path: join(report, 'workbench-narrow-pdf.png'), animations: 'disabled' });
  for (let step = 0; step < 40 && Number(await divider.getAttribute('aria-valuenow')) < 440; step++) await page.keyboard.press('ArrowLeft');
  assert.ok(Number(await divider.getAttribute('aria-valuenow')) >= 440);
  cases.push('light/dark layouts, activity navigation, toolbar wrapping and accessibility');

  held = true;
  const previousCalls = compileCalls;
  await editor.focus();
  await editor.press('Control+End');
  await page.keyboard.insertText('\n% saved UI regression marker\n');
  await editor.press('Control+s');
  await expect.poll(() => compileCalls).toBeGreaterThan(previousCalls);
  await strip.getByRole('button', { name: '取消', exact: true }).click();
  await expect(strip).toContainText('源文件已更新 · PDF 待更新');
  await page.screenshot({ path: join(report, 'workbench-outdated.png'), animations: 'disabled' });
  held = false;
  await strip.getByRole('button', { name: '重新编译', exact: true }).click();
  await expect(strip).toContainText('编译成功');
  cases.push('a saved newer version remains outdated after cancellation until recompiled');

  mode = 'error';
  await strip.getByRole('button', { name: '重新编译', exact: true }).click();
  await expect(strip).toContainText('编译失败 · 显示上次 PDF');
  assert.equal(await strip.getByText('Undefined control sequence', { exact: false }).count(), 0, 'long compiler detail stays in the problem/output panels');
  await expect(page.locator('.react-pdf__Page__canvas').first()).toBeVisible();
  await strip.getByRole('button', { name: '查看编译问题', exact: true }).click();
  await expect(page.locator('.bottom-panel-problems')).toBeVisible();
  const diagnostic = page.locator('.diagnostic-row__location').first();
  await expect(diagnostic).toContainText('main.tex:5');
  await diagnostic.click();
  await expect(editor).toBeFocused();
  for (const theme of ['dark', 'light']) {
    if (theme === 'light') await page.getByRole('button', { name: '切换浅色主题', exact: true }).click();
    await accessible('.bottom-panel-problems');
    await accessible('.pdf-pane');
    await page.screenshot({ path: join(report, `workbench-error-${theme}.png`), animations: 'disabled' });
  }
  const bottomTabs = page.getByRole('group', { name: '底部面板 controls', exact: true });
  await bottomTabs.getByRole('tab', { name: '输出', exact: true }).click();
  await expect(page.locator('.bottom-panel-output > pre')).toContainText('Undefined control sequence');
  const resize = page.getByRole('separator', { name: '调整底部面板大小', exact: true });
  const initialPanelHeight = (await page.locator('#bottom-workbench-panel').boundingBox()).height;
  await resize.focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await page.locator('#bottom-workbench-panel').boundingBox()).height).toBeGreaterThan(initialPanelHeight);
  const panelHeight = (await page.locator('#bottom-workbench-panel').boundingBox()).height;
  await bottomTabs.getByRole('tab', { name: /^问题/ }).click();
  assert.equal((await page.locator('#bottom-workbench-panel').boundingBox()).height, panelHeight);
  await page.getByRole('button', { name: '隐藏面板', exact: true }).click();
  await page.getByRole('button', { name: '显示面板', exact: true }).click();
  assert.equal((await page.locator('#bottom-workbench-panel').boundingBox()).height, panelHeight);
  cases.push('failure preserves the previous PDF; problem action opens diagnostics and navigates to source; panel resize/collapse persists');

  mode = 'network';
  await strip.getByRole('button', { name: '重新编译', exact: true }).click();
  const notification = page.getByRole('complementary', { name: '工作区通知', exact: true });
  await expect(notification).toContainText('无法连接到服务器');
  await accessible('[aria-label="工作区通知"]');
  await page.screenshot({ path: join(report, 'workbench-network.png'), animations: 'disabled' });
  await notification.getByRole('button', { name: '关闭通知', exact: true }).click();
  await expect(notification.getByRole('alert')).toHaveCount(0);
  cases.push('network failures use a dismissible notification without repeating details in preview');
  assert.deepEqual(errors, []);
  const result = { result: 'pass', cases, layout, compileCalls, pageErrors: errors };
  await writeFile(join(report, 'checks.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  await page?.screenshot({ path: join(report, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(join(report, 'fixture.log'), logs);
  throw error;
} finally {
  await browser?.close();
  fixture.kill('SIGTERM');
  if (fixture.exitCode === null) await new Promise(resolve => fixture.once('exit', resolve));
  await rm(data, { recursive: true, force: true });
}
