import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const base = process.env.FASTWRITE_E2E_URL ?? 'http://127.0.0.1:3218';
const browser = await chromium.launch({ channel: process.env.FASTWRITE_E2E_CHANNEL ?? 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(() => {
  localStorage.setItem('fastwrite.completion.enabled', 'false');
  localStorage.setItem('fastwrite.collaboration.enabled', 'false');
});
const page = await context.newPage();
try {
  const response = await context.request.post(`${base}/api/projects`, { data: { name: 'Snapshot regression', mainDocument: 'main.tex' } });
  assert.ok(response.ok(), await response.text());
  const project = await response.json();
  const root = `${base}/api/projects/${project.id}`;
  await page.goto(`${base}/projects/${project.id}`);
  const editor = page.getByRole('textbox', { name: 'Source editor for main.tex', exact: true });
  await editor.waitFor();
  await page.getByText('Compiled successfully', { exact: true }).waitFor({ timeout: 90000 });
  await page.locator('.react-pdf__Page__canvas').first().waitFor({ timeout: 90000 });
  const locate = page.getByRole('button', { name: 'Locate editor selection in PDF', exact: true });
  await editor.focus();
  await page.keyboard.press('Control+Home');
  assert.equal(await locate.isEnabled(), true, 'clean matching snapshot permits SyncTeX');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let saveStarted = false;
  let compileRequests = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url() === `${root}/compile`) compileRequests++; });
  await page.route('**/file?path=main.tex', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    const saved = await route.fetch();
    saveStarted = true;
    await gate;
    await route.fulfill({ response: saved });
  });
  await page.keyboard.insertText('% Snapshot barrier test\n');
  assert.equal(await locate.isDisabled(), true, 'dirty buffers block old mappings before server version changes');
  await page.getByRole('button', { name: 'Save and compile', exact: true }).click();
  const deadline = Date.now() + 10000;
  while (!saveStarted) {
    assert.ok(Date.now() < deadline, 'flush starts a save');
    await page.waitForTimeout(25);
  }
  await page.waitForTimeout(500);
  assert.equal(compileRequests, 0, 'compile must await the save ACK');
  const completed = page.waitForResponse(result => result.url() === `${root}/compile` && result.request().method() === 'POST');
  release();
  const compiled = await (await completed).json();
  const current = await (await context.request.get(root)).json();
  const file = await (await context.request.get(`${root}/file?path=main.tex`)).json();
  assert.ok(compiled.success, compiled.error);
  assert.equal(compiled.projectVersion, current.version);
  assert.equal(typeof compiled.snapshotId, 'string');
  assert.ok(file.content.startsWith('% Snapshot barrier test\n'));
  await page.getByText('Compiled successfully', { exact: true }).waitFor();
  await page.locator('.react-pdf__Page__canvas').first().waitFor({ timeout: 90000 });
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Locate editor selection in PDF"]')?.disabled);
  console.log(JSON.stringify({ result: 'pass', projectId: project.id, projectVersion: compiled.projectVersion, snapshotId: compiled.snapshotId, cases: ['dirty SyncTeX gate', 'flush before compile', 'server snapshot identity', 'new mapping enabled'] }));
} finally {
  await browser.close();
}
