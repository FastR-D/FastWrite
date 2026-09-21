import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';

const base = process.env.FASTWRITE_E2E_URL ?? 'http://127.0.0.1:3002';
const browser = await chromium.launch({ channel: process.env.FASTWRITE_E2E_CHANNEL ?? 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
let project;
try {
  const response = await context.request.post(`${base}/api/projects`, { data: { name: 'Settings editor regression' } });
  assert.ok(response.ok());
  project = await response.json();
  await context.addInitScript(() => {
    localStorage.setItem('fastwrite.completion.enabled', 'false');
    localStorage.setItem('fastwrite.collaboration.enabled', 'false');
  });
  // Keep this layout/save regression independent of the server's model credentials.
  await context.route('**/api/harness-settings', route => {
    assert.equal(route.request().method(), 'GET', 'project changes must not overwrite model settings');
    return route.fulfill({ json: { configured: false, source: 'none', wireAPI: 'chat' } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/projects/${project.id}`);
  const source = page.getByRole('textbox', { name: 'Source editor for main.tex', exact: true });
  await expect(source).toBeVisible();
  const tabs = page.getByRole('tablist', { name: 'Open editors' });
  const settingsTab = tabs.getByRole('tab', { name: 'Settings', exact: true });
  const panel = page.getByRole('tabpanel', { name: 'Settings', exact: true });
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  await expect(settingsTab).toHaveAttribute('aria-selected', 'true');
  await expect(panel).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Project settings' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Project settings', exact: true }).click();
  await expect(settingsTab).toHaveCount(1);

  const name = panel.getByRole('textbox', { name: 'Project name', exact: true });
  await name.fill('Settings draft preserved');
  await tabs.getByRole('tab', { name: 'main.tex', exact: true }).click();
  await expect(source).toBeVisible();
  await settingsTab.click();
  await expect(name).toHaveValue('Settings draft preserved');
  // Opening the already-selected source from the tree must also leave Settings.
  await page.locator('span[title="main.tex"]').click();
  await expect(source).toBeVisible();
  await settingsTab.click();
  await expect(name).toHaveValue('Settings draft preserved');

  const navigation = panel.getByRole('navigation', { name: 'Settings categories' });
  await navigation.getByRole('button', { name: 'Writing', exact: true }).click();
  await expect(panel.getByRole('combobox', { name: 'Research domain', exact: true })).toBeVisible();
  await panel.getByRole('searchbox', { name: 'Search settings' }).fill('api key');
  await expect(panel.getByLabel('API key', { exact: true })).toBeVisible();
  await expect(name).toBeHidden();
  await panel.getByRole('searchbox', { name: 'Search settings' }).fill('no-such-setting');
  await expect(panel.getByRole('heading', { name: 'No settings found' })).toBeVisible();
  await navigation.getByRole('button', { name: 'General', exact: true }).click();
  await panel.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Settings saved');
  await expect(settingsTab).toHaveAttribute('aria-selected', 'true');
  assert.equal((await (await context.request.get(`${base}/api/projects/${project.id}`)).json()).name, 'Settings draft preserved');
  await name.fill('Settings keyboard save');
  await name.press('Control+s');
  await expect(panel.getByRole('status')).toHaveText('Settings saved');
  assert.equal((await (await context.request.get(`${base}/api/projects/${project.id}`)).json()).name, 'Settings keyboard save');

  await tabs.getByRole('button', { name: 'Close Settings', exact: true }).click();
  await expect(settingsTab).toHaveCount(0);
  await expect(source).toBeVisible();
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  await expect(name).toHaveValue('Settings keyboard save');
  await page.getByRole('button', { name: 'Hide panel', exact: true }).click();
  mkdirSync('output/settings-editor', { recursive: true });
  await page.screenshot({ path: 'output/settings-editor/light.png' });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({ path: 'output/settings-editor/dark.png' });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.setViewportSize({ width: 760, height: 900 });
  for (const category of ['General', 'Writing', 'AI & Harness', 'History & Export']) {
    await navigation.getByRole('button', { name: category, exact: true }).click();
    const fits = await panel.evaluate(element => [...element.querySelectorAll('input, [role="combobox"], footer')].filter(el => el.getClientRects().length).every(el => {
      const box = el.getBoundingClientRect(), parent = element.getBoundingClientRect();
      return box.left >= parent.left && box.right <= parent.right + 1;
    }));
    assert.ok(fits, `${category} controls fit the narrow editor`);
  }
  await navigation.getByRole('button', { name: 'General', exact: true }).click();
  await page.screenshot({ path: 'output/settings-editor/narrow.png' });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'pass', cases: ['single editor tab', 'draft survives source navigation', 'category and search', 'save stays open', 'keyboard save', 'close and reopen', 'narrow layout'], screenshots: 'output/settings-editor' }));
} finally {
  if (project) await context.request.delete(`${base}/api/projects/${project.id}`);
  await browser.close();
}
