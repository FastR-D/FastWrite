import { chromium, expect } from '@playwright/test';
import { preview } from 'vite';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

// Production route and components; the service is substituted at its HTTP boundary.
const artifacts = 'test-results/fastui';
await mkdir(artifacts, { recursive: true });
const server = await preview({ configFile: false, preview: { host: '127.0.0.1', port: 0 } });
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', colorScheme: 'light' });
let project = { id: 'ui-project', name: 'FastUI project', mainDocument: 'main.tex', skill: { id: 'network-information-security', name: '网络与信息安全', venue: 'network-information-security', version: '2.0.0' }, source: { type: 'local', displayName: 'Workspace' }, version: 1, createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z' };
const file = { name: 'main.tex', path: 'main.tex', kind: 'text', size: 64, version: 1, updatedAt: project.updatedAt };
const writes = [], errors = [], scenarios = [];
await context.addInitScript(() => {
  localStorage.setItem('fastwrite.completion.enabled', 'false');
  localStorage.setItem('fastwrite.collaboration.enabled', 'false');
});
await context.route('**/api/**', async route => {
  const request = route.request(), path = new URL(request.url()).pathname;
  let value = [], status = 200;
  if (request.method() !== 'GET') writes.push({ path, method: request.method(), body: request.postDataJSON() });
  if (path === '/api/projects/ui-project') {
    if (request.method() === 'PATCH') { project = { ...project, ...request.postDataJSON(), version: project.version + 1 }; }
    value = project;
  } else if (path === '/api/projects/ui-project/files') value = [{ ...file, type: 'file' }];
  else if (path === '/api/projects/ui-project/file') value = { file, content: '\\documentclass{article}\n\\begin{document}\nDraft\n\\end{document}\n' };
  else if (path === '/api/projects/ui-project/access') value = { role: 'owner', userId: 'writer', canWrite: true, canComment: true, canInvite: true, canManage: true, realtime: false, canCompile: true };
  else if (path === '/api/projects/ui-project/evidence-cockpit') value = { counts: { total: 0, supported: 0, unresolved: 0 }, claims: [] };
  else if (path.includes('/compile-results/')) value = null;
  else if (path === '/api/harness-settings') {
    assert.equal(request.method(), 'GET', 'saving general settings must not overwrite model credentials');
    value = { configured: false, source: 'none', wireAPI: 'chat' };
  } else if (path === '/api/auth/me') value = { id: 'writer', displayName: 'Writer', platformRole: 'user' };
  else if (path.endsWith('/history/working-status')) value = { staged: [], unstaged: [], untracked: [], branch: 'main' };
  else if (path.endsWith('/reference-selections')) value = { revision: 1, selections: [] };
  else if (path === '/api/harnesses') value = [];
  await route.fulfill({ status, json: value });
});
try {
  const page = await context.newPage();
  page.on('pageerror', error => { errors.push(error.message); console.error(error.stack); });
  await page.goto(`${base}/projects/ui-project`);
  await page.getByRole('button', { name: '工作区设置', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: '设置', exact: true });
  const name = panel.getByLabel('项目名称', { exact: true });
  await expect(name).toHaveClass(/fastui-input/);
  await name.fill(' ');
  await expect(panel.getByRole('button', { name: '保存更改', exact: true })).toBeDisabled();
  await name.fill('设置草稿保持');
  await name.focus();
  const original = await name.elementHandle();
  const peer = await context.newPage();
  await peer.goto(base);
  await peer.evaluate(() => localStorage.setItem('fastwrite.theme', 'dark'));
  await expect(page.locator('html')).toHaveAttribute('data-fastui-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(name).toBeFocused();
  await expect(name).toHaveValue('设置草稿保持');
  assert.equal(await original.evaluate(el => el.isConnected), true);
  await expect(name).toHaveCSS('background-color', 'rgb(23, 30, 39)');
  scenarios.push('real settings tab consumes ui-react; cross-tab theme preserves input node, focus and draft');
  const navigation = panel.getByRole('navigation', { name: '设置类别' });
  await navigation.getByRole('button', { name: 'AI 与模型配置', exact: true }).click();
  const key = panel.getByLabel('API 密钥', { exact: true });
  await key.fill('model-key-draft');
  await key.press('Tab');
  await expect(panel.getByLabel('服务地址', { exact: true })).toBeFocused();
  await panel.getByRole('searchbox', { name: '搜索设置' }).fill('名称');
  await expect(name).toHaveValue('设置草稿保持');
  await navigation.getByRole('button', { name: '常规', exact: true }).click();
  // Leave the model draft empty to exercise the existing unchanged-model save decision.
  await navigation.getByRole('button', { name: 'AI 与模型配置', exact: true }).click();
  await key.fill('');
  await navigation.getByRole('button', { name: '常规', exact: true }).click();
  await panel.getByRole('button', { name: '保存更改', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('设置已保存');
  const saved = writes.find(write => write.path === '/api/projects/ui-project' && write.method === 'PATCH');
  assert.equal(saved.body.name, '设置草稿保持');
  assert.equal(writes.some(write => write.path === '/api/harness-settings'), false);
  scenarios.push('label wiring, keyboard Tab, category/search retain drafts, controlled save retains model settings');
  // Use the existing workbench pane controls before checking the compact settings surface.
  await page.getByRole('button', { name: '隐藏面板', exact: true }).click();
  await page.getByRole('button', { name: '收起 PDF 预览', exact: true }).click();
  await page.getByRole('button', { name: '收起文件面板', exact: true }).click();
  for (const width of [1440, 1024, 390]) for (const mode of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 1000 });
    await peer.evaluate(mode => localStorage.setItem('fastwrite.theme', mode), mode);
    await expect(page.locator('html')).toHaveAttribute('data-fastui-theme', mode);
    await expect(name).toHaveValue('设置草稿保持');
    assert.ok(await panel.evaluate(el => [...el.querySelectorAll('input')].filter(input => input.getClientRects().length).every(input => input.getBoundingClientRect().right <= el.getBoundingClientRect().right + 1)));
    await page.screenshot({ path: `${artifacts}/${mode}-${width}.png` });
  }
  assert.deepEqual(errors, []);
  await writeFile(`${artifacts}/results.json`, JSON.stringify({ status: 'passed', scenarios, viewports: [1440, 1024, 390] }, null, 2));
  console.log('PASS FastWrite FastUI production settings browser scenarios');
} finally {
  await browser.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
