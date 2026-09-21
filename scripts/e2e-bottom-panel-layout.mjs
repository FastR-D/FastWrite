import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const base = process.env.FASTWRITE_E2E_URL ?? 'http://127.0.0.1:3218';
const browser = await chromium.launch({ channel: process.env.FASTWRITE_E2E_CHANNEL ?? 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(() => { localStorage.setItem('fastwrite.completion.enabled', 'false'); localStorage.setItem('fastwrite.collaboration.enabled', 'false'); });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.stack ?? error.message));
try {
  const created = await context.request.post(`${base}/api/projects`, { data: { name: 'Bottom panel layout regression' } });
  assert.ok(created.ok(), await created.text());
  const project = await created.json();
  await page.goto(`${base}/projects/${project.id}`);
  await page.getByRole('textbox', { name: 'Source editor for main.tex', exact: true }).waitFor();
  const tabs = page.getByRole('tablist', { name: 'Bottom panel' });
  await tabs.getByRole('tab', { name: 'Output', exact: true }).click();
  assert.equal(await page.locator('.bottom-panel-output').getAttribute('hidden'), null);
  await tabs.getByRole('tab', { name: 'Problems', exact: true }).click();
  assert.equal(await page.locator('.bottom-panel-problems').getAttribute('hidden'), null);
  await page.getByRole('button', { name: 'Hide panel', exact: true }).click();
  assert.equal(await page.locator('#bottom-workbench-panel').isVisible(), false);
  await page.getByRole('button', { name: 'Show panel', exact: true }).click();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'Git', exact: true }).click();
  await page.setViewportSize({ width: 640, height: 900 });
  assert.equal(await page.getByRole('navigation', { name: 'Workspace views' }).isVisible(), true);
  await page.getByRole('button', { name: 'Evidence', exact: true }).click();
  assert.equal(await page.locator('#sidebar-evidence').isVisible(), true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.getByRole('textbox', { name: 'Source editor for main.tex', exact: true }).waitFor();
  assert.equal(await page.getByRole('tab', { name: 'Problems', exact: true }).getAttribute('aria-selected'), 'true');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'pass', projectId: project.id, cases: ['bottom tabs', 'collapse and restore', 'project-scoped active tab', 'narrow activity bar', 'narrow evidence access'] }));
} finally { await browser.close(); }
