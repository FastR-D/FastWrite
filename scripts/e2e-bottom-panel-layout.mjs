import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';

const base = process.env.FASTWRITE_E2E_URL ?? 'http://127.0.0.1:3218';
const browser = await chromium.launch({ channel: process.env.FASTWRITE_E2E_CHANNEL ?? 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(() => { localStorage.setItem('fastwrite.completion.enabled', 'false'); localStorage.setItem('fastwrite.collaboration.enabled', 'false'); });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.stack ?? error.message));
try {
  const registered = await context.request.post(`${base}/api/auth/register`, { data: { email: `layout-${crypto.randomUUID()}@example.test`, password: 'workbench-layout-regression' } });
  assert.ok(registered.ok(), await registered.text());
  const { token } = await registered.json();
  const headers = { authorization: `Bearer ${token}` };
  await context.addInitScript(token => localStorage.setItem('fastwrite.session-token', token), token);
  const created = await context.request.post(`${base}/api/projects`, { headers, data: { name: 'Bottom panel layout regression' } });
  assert.ok(created.ok(), await created.text());
  const project = await created.json();
  await page.goto(`${base}/projects/${project.id}`);
  await page.getByRole('textbox', { name: "源文件编辑器： main.tex", exact: true }).waitFor();
  assert.equal(await page.locator('.editor-toolbar, .workbench-status').count(), 0);
  assert.equal(await page.getByRole('button', { name: /比较与恢复/ }).count(), 0);
  assert.equal(await page.getByRole('link', { name: '科研绘图', exact: true }).count(), 0);
  const completion = page.locator('.ai-workspace__tools').getByRole('button', { name: '补全', exact: true });
  await expect(completion).toHaveAttribute('aria-pressed', 'false');
  await completion.click();
  await expect(completion).toHaveAttribute('aria-pressed', 'true');
  assert.equal(await page.evaluate(() => localStorage.getItem('fastwrite.completion.enabled')), 'true');
  let completionRequests = 0;
  await page.route('**/completions', async route => {
    completionRequests++;
    await route.fulfill({ json: { ...route.request().postDataJSON(), suggestion: 'COMPLETION_ACCEPTED' } });
  });
  const source = page.getByRole('textbox', { name: '源文件编辑器： main.tex', exact: true });
  const read = async () => (await (await context.request.get(`${base}/api/projects/${project.id}/file?path=main.tex`, { headers })).json()).content;
  await source.focus();
  await source.press('Control+End');
  await page.keyboard.insertText('\n% CONTROL_TRIGGER ');
  await page.locator('.fastwrite-monaco-completion').first().waitFor({ timeout: 10000 }).catch(async failure => {
    console.error({ completionRequests, errors, editor: await page.locator('.source-editor').innerText(), metrics: await page.evaluate(() => localStorage.getItem('fastwrite.completion.metrics.v1')) });
    await page.screenshot({ path: 'output/playwright/workspace-controls-failure.png', fullPage: true });
    throw failure;
  });
  await source.press('Tab');
  await expect.poll(read).toContain('COMPLETION_ACCEPTED');
  await completion.click();
  const requestCount = completionRequests;
  await source.focus();
  await page.keyboard.insertText(' COMPLETION_DISABLED');
  await expect.poll(read).toContain('COMPLETION_DISABLED');
  await page.waitForTimeout(800);
  assert.equal(completionRequests, requestCount, 'disabled completion does not request suggestions');
  const collaboration = page.locator('.workspace-topbar__right').getByRole('button', { name: '启用协作', exact: true });
  await expect(collaboration).toBeEnabled();
  await collaboration.click();
  const collaborationOn = page.locator('.workspace-topbar__right').getByRole('button', { name: /协作已开启/ });
  await expect(collaborationOn).toHaveAttribute('aria-pressed', 'true');
  await expect(collaborationOn).toHaveAttribute('title', /已连接|已写入文件/);
  await source.focus();
  await source.press('Control+End');
  await page.keyboard.insertText('\n% COLLABORATION_SAVED');
  await source.press('Control+s');
  await expect.poll(read).toContain('COLLABORATION_SAVED');
  await collaborationOn.click();
  await expect(collaboration).toHaveAttribute('aria-pressed', 'false');
  const tabs = page.getByRole('group', { name: "底部面板 controls" });
  const panel = page.locator('#bottom-workbench-panel');
  const initialHeight = (await panel.boundingBox()).height;
  const assertHeight = async height => assert.equal((await panel.boundingBox()).height, height, 'tab changes preserve panel height');
  await tabs.getByRole('tab', { name: "输出", exact: true }).click();
  assert.equal(await page.locator('.bottom-panel-output').getAttribute('hidden'), null);
  await assertHeight(initialHeight);
  await page.locator('.bottom-panel-output > pre').evaluate(node => { node.textContent = 'Compile output\n'.repeat(1000); });
  const assertInternalScroll = async selector => {
    const scroll = await page.locator(selector).evaluate(node => {
      node.scrollTop = 100;
      return { top: node.scrollTop, height: node.clientHeight, contentHeight: node.scrollHeight };
    });
    assert.ok(scroll.contentHeight > scroll.height && scroll.top > 0, `${selector} scrolls internally`);
    await assertHeight(initialHeight);
  };
  await assertInternalScroll('.bottom-panel-output > pre');
  await tabs.getByRole('tab', { name: "问题", exact: true }).click();
  assert.equal(await page.locator('.bottom-panel-problems').getAttribute('hidden'), null);
  await assertHeight(initialHeight);
  await page.locator('.bottom-panel-problems').evaluate(node => {
    node.querySelector('.bottom-panel-empty')?.remove();
    const list = document.createElement('div');
    list.className = 'diagnostic-list';
    for (let i = 0; i < 100; i++) {
      const row = document.createElement('div');
      row.className = 'diagnostic-row';
      row.textContent = `Diagnostic ${i}`;
      row.style.minHeight = '40px';
      list.append(row);
    }
    node.append(list);
  });
  await assertInternalScroll('.bottom-panel-problems .diagnostic-list');
  await tabs.getByRole('tab', { name: "AI", exact: true }).click();
  await assertHeight(initialHeight);
  await page.locator('.revise-chat__messages').evaluate(node => {
    const message = document.createElement('div');
    message.textContent = 'Long conversation\n'.repeat(500);
    message.style.whiteSpace = 'pre-wrap';
    node.append(message);
  });
  await assertInternalScroll('.revise-chat__messages');
  const resize = page.getByRole('separator', { name: '调整底部面板大小', exact: true });
  await resize.focus();
  await resize.press('ArrowUp');
  const resizedHeight = (await panel.boundingBox()).height;
  assert.ok(resizedHeight > initialHeight, 'panel resizes');
  for (const name of ['问题', '输出', 'AI']) {
    await tabs.getByRole('tab', { name, exact: true }).click();
    await assertHeight(resizedHeight);
  }
  await tabs.getByRole('tab', { name: "问题", exact: true }).click();
  await page.getByRole('button', { name: "隐藏面板", exact: true }).click();
  assert.equal(await page.locator('#bottom-workbench-panel').isVisible(), false);
  await page.getByRole('button', { name: "显示面板", exact: true }).click();
  await page.getByRole('button', { name: "文件", exact: true }).click();
  await page.getByRole('button', { name: 'Git', exact: true }).click();
  await page.setViewportSize({ width: 640, height: 900 });
  assert.equal(await page.getByRole('navigation', { name: "工作区视图" }).isVisible(), true);
  await page.getByRole('button', { name: "证据", exact: true }).click();
  assert.equal(await page.locator('#sidebar-evidence').isVisible(), true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.getByRole('textbox', { name: "源文件编辑器： main.tex", exact: true }).waitFor();
  assert.equal(await page.getByRole('tab', { name: "问题", exact: true }).getAttribute('aria-selected'), 'true');
  await assertHeight(resizedHeight);
  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  await page.screenshot({ path: 'output/playwright/workspace-cleanup.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'pass', projectId: project.id, cases: ['removed toolbar and footer', 'relocated completion and collaboration', 'equal tab heights', 'internal scrolling for all tabs', 'resize persists across tabs and reload', 'collapse and restore', 'project-scoped active tab', 'narrow activity bar', 'narrow evidence access'] }));
} finally { await browser.close(); }
