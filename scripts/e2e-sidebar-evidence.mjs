import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const report = join(root, 'output/ui-layout-fixes');
await mkdir(report, { recursive: true });
const data = await mkdtemp(join(tmpdir(), 'fastwrite-layout-fixes-'));
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
  const main = await (await context.request.get(`${api}/file?path=main.tex`)).json();
  const method = await context.request.post(`${api}/files`, { data: { path: 'method.tex', content: 'A second evidence source.\n' } });
  assert.ok(method.ok());
  const methodFile = await (await context.request.get(`${api}/file?path=method.tex`)).json();
  const now = new Date().toISOString();
  const claims = Array.from({ length: 72 }, (_, index) => {
    const file = index % 2 ? methodFile : main;
    const exactText = file.content.split('\n').find(line => line.trim()) ?? file.content;
    return { id: `layout-claim-${index}`, projectId: project.id,
      anchor: { path: index % 2 ? 'method.tex' : 'main.tex', fileVersion: file.file.version, startOffset: file.content.indexOf(exactText), endOffset: file.content.indexOf(exactText) + exactText.length, exactText, prefix: '', suffix: '' },
      type: 'result', semanticType: 'result', reviewStatus: index % 3 ? 'needs-review' : 'supported', anchorStatus: 'current', createdBy: 'scanner', createdAt: now, updatedAt: now };
  });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/projects/*/claims', route => route.fulfill({ json: claims }));
  await page.route('**/api/projects/*/evidence-cockpit', route => route.fulfill({ json: { projectId: project.id, projectVersion: project.version, claims: [], counts: { total: 72, supported: 24, partial: 0, unsupported: 0, unresolved: 48, stale: 0, orphaned: 0 }, generatedAt: now } }));
  await page.route('**/api/projects/*/claim-scans', route => route.fulfill({ json: claims }));
  // Compilation is unrelated to this layout check; keep it deterministic and idle.
  await page.route('**/api/projects/*/compile', route => route.fulfill({ json: { id: 'layout-job', status: 'queued', kind: 'latex.compile' } }));
  await page.route('**/api/jobs/layout-job', route => route.fulfill({ json: { id: 'layout-job', status: 'running', attempts: 1, kind: 'latex.compile' } }));
  await page.goto(`${web}/projects/${project.id}`);
  await page.getByRole('textbox', { name: '源文件编辑器： main.tex', exact: true }).waitFor();
  await page.getByRole('navigation', { name: '工作区视图', exact: true }).getByRole('button', { name: '证据', exact: true }).click();
  const panel = page.locator('#sidebar-evidence');
  const list = page.getByRole('region', { name: '论断列表', exact: true });
  const filter = page.getByRole('group', { name: '证据筛选', exact: true });
  const status = page.getByRole('combobox', { name: '证据状态', exact: true });
  const source = page.getByRole('combobox', { name: '证据来源', exact: true });
  await expect(list.getByRole('button')).toHaveCount(72);
  const axe = await readFile(join(root, 'node_modules/axe-core/axe.min.js'), 'utf8');
  await page.route('**/__layout-axe.js', route => route.fulfill({ contentType: 'application/javascript', body: axe }));
  await page.addScriptTag({ url: '/__layout-axe.js' });
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await page.getByRole('button', { name: '切换深色主题', exact: true }).click();
    for (const [width, height] of [[1440, 1000], [720, 650]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => document.fonts.ready);
      const before = { header: await panel.locator('header').boundingBox(), filter: await filter.boundingBox() };
      const area = await list.boundingBox();
      await page.mouse.move(area.x + area.width / 2, area.y + Math.min(100, area.height / 2));
      await page.mouse.wheel(0, 900);
      await expect.poll(() => list.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
      const after = { header: await panel.locator('header').boundingBox(), filter: await filter.boundingBox() };
      assert.equal(after.header.y, before.header.y, 'heading stays pinned');
      assert.equal(after.filter.y, before.filter.y, 'status and source stay pinned');
      assert.equal(await panel.evaluate(node => node.scrollTop), 0, 'outer evidence panel does not scroll');
      assert.ok((await panel.boundingBox()).height > 360, 'evidence fills the sidebar rather than its former 360px cap');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await status.click();
      const supported = page.getByRole('option', { name: '已获支持', exact: true });
      await supported.click();
      await expect(list.getByRole('button')).toHaveCount(24);
      await source.click();
      await page.getByRole('option', { name: 'method.tex', exact: true }).click();
      await expect(list.getByRole('button')).toHaveCount(12);
      await source.click(); await page.getByRole('option', { name: '全部文件', exact: true }).click();
      await status.click(); await page.getByRole('option', { name: '全部', exact: true }).click();
      await expect(list.getByRole('button')).toHaveCount(72);
      await list.focus(); await page.keyboard.press('Control+Home'); await page.keyboard.press('PageDown');
      await expect.poll(() => list.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
      const violations = await panel.evaluate(async node => (await window.axe.run(node, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.filter(v => ['critical', 'serious'].includes(v.impact)).map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })));
      assert.deepEqual(violations, []);
      await panel.screenshot({ path: join(report, `evidence-${theme}-${width}.png`), animations: 'disabled' });
      layout.push({ theme, width, height, headingPinned: true, filtersPinned: true, internalScroll: true });
    }
  }
  cases.push('full-height evidence panel pins heading/status/source; only the ledger scrolls by pointer and keyboard');
  cases.push('status and source filters remain usable after scrolling in light/dark narrow layouts');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await list.getByRole('button').first().click();
  await expect(page.getByRole('button', { name: '清除所选上下文', exact: true })).toBeVisible();
  cases.push('claim activation still locates the saved source selection');

  const lines = Array.from({ length: 1105 }, (_, index) => index === 331 ? 'Leave a comfortable inset before this sentence.' : `% Line ${index + 1}`);
  assert.ok((await context.request.post(`${api}/files`, { data: { path: 'gutter.tex', content: lines.join('\n') } })).ok());
  await page.reload();
  await page.getByRole('navigation', { name: '工作区视图', exact: true }).getByRole('button', { name: '文件', exact: true }).click();
  await page.locator('span[title="gutter.tex"]').click();
  const editor = page.getByRole('textbox', { name: '源文件编辑器： gutter.tex', exact: true });
  await editor.waitFor();
  await page.evaluate(() => document.fonts.ready);
  const jump = async line => {
    await editor.focus(); await editor.press('Control+g');
    const input = page.locator('.quick-input-widget input');
    await input.fill(`:${line}`); await input.press('Enter');
    const number = page.locator('.monaco-editor-host .line-numbers').filter({ hasText: new RegExp(`^${line}$`) });
    await number.waitFor();
    // Go-to-line uses Monaco's own smooth scrolling, outside CSS animation control.
    let previous = null, stable = 0;
    await expect.poll(async () => {
      const y = (await number.boundingBox()).y;
      stable = previous !== null && Math.abs(y - previous) < 0.5 ? stable + 1 : 0;
      previous = y;
      return stable;
    }, { intervals: [50, 100, 100] }).toBeGreaterThanOrEqual(2);
  };
  const measure = async line => page.locator('.monaco-editor-host .monaco-editor').evaluate((node, line) => {
    const margin = node.querySelector('.margin');
    const digits = [...node.querySelectorAll('.line-numbers')].find(item => item.textContent === String(line));
    const range = document.createRange(); range.selectNodeContents(digits);
    const number = range.getBoundingClientRect(), box = margin.getBoundingClientRect();
    const inset = parseFloat(getComputedStyle(margin, '::after').right);
    const divider = box.right - inset;
    const textLeft = node.querySelector('.view-lines').getBoundingClientRect().left;
    return { numberToDivider: divider - number.right, textInset: textLeft - divider, numberLeft: number.left - box.left, textLeft, lineTop: digits.getBoundingClientRect().top, lineHeight: digits.getBoundingClientRect().height };
  }, line);
  await jump(332);
  const gutter = await measure(332);
  assert.ok(gutter.numberToDivider >= 12 && gutter.numberToDivider <= 18, JSON.stringify(gutter));
  assert.ok(gutter.textInset >= 7 && gutter.textInset <= 9, JSON.stringify(gutter));
  assert.ok(gutter.numberLeft >= 0);
  await page.locator('.monaco-editor-host').screenshot({ path: join(report, 'gutter-three-digits.png'), animations: 'disabled' });
  await page.mouse.click(gutter.textLeft + 1, gutter.lineTop + gutter.lineHeight / 2);
  await page.keyboard.insertText('% '); await editor.press('Control+s');
  const read = async () => (await (await context.request.get(`${api}/file?path=gutter.tex`)).json()).content;
  await expect.poll(async () => (await read()).split('\n')[331]).toBe('% Leave a comfortable inset before this sentence.');
  await jump(1100);
  const fourDigits = await measure(1100);
  assert.ok(fourDigits.numberLeft >= 0);
  assert.ok(fourDigits.textInset >= 7 && fourDigits.textInset <= 9);
  await page.locator('.monaco-editor-host').screenshot({ path: join(report, 'gutter-four-digits.png'), animations: 'disabled' });
  cases.push('three/four-digit gutters leave an 8px text inset; clicking the first column still edits the correct position');
  assert.deepEqual(errors, []);
  const result = { result: 'pass', cases, layout, gutter, fourDigits, pageErrors: errors };
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
