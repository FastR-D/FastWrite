import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const base = process.env.FASTWRITE_E2E_URL ?? 'http://127.0.0.1:3217';
const browser = await chromium.launch({ channel: process.env.FASTWRITE_E2E_CHANNEL ?? 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(() => {
  localStorage.setItem('fastwrite.completion.enabled', 'false');
  localStorage.setItem('fastwrite.collaboration.enabled', 'false');
});
const page = await context.newPage();
const failures = [];
page.on('pageerror', error => failures.push(error.stack ?? error.message));
const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 15000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, label);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};
try {
  const created = await context.request.post(`${base}/api/projects`, { data: { name: 'Editor reliability', mainDocument: 'main.tex' } });
  assert.ok(created.ok(), await created.text());
  const project = await created.json();
  const root = `${base}/api/projects/${project.id}`;
  for (const [path, content] of [['other.tex', 'other'], ['sections/note.tex', 'note']]) {
    const result = await context.request.post(`${root}/files`, { data: { path, content } });
    assert.ok(result.ok(), await result.text());
  }
  await page.goto(`${base}/projects/${project.id}`);
  const editor = () => page.getByRole('textbox', { name: 'Source editor for main.tex', exact: true });
  await editor().waitFor();
  await editor().focus();
  await page.keyboard.press('Control+Home');
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  let inFlight = false;
  let intercepted = false;
  let reads = 0;
  page.on('request', request => {
    if (request.method() === 'GET' && request.url().includes('/file?path=main.tex')) reads++;
  });
  await page.route('**/file?path=main.tex', async route => {
    if (route.request().method() !== 'PUT' || intercepted) return route.continue();
    intercepted = true;
    const response = await route.fetch();
    inFlight = true;
    await barrier;
    await route.fulfill({ response });
  });
  await page.keyboard.insertText('SAVE_A');
  await waitFor(() => inFlight, 'first save started');
  await page.keyboard.insertText('_B');
  await page.getByRole('treeitem', { name: 'sections', exact: true }).click();
  await page.waitForTimeout(150);
  assert.equal(reads, 0, 'tree expansion must not read active text');
  await page.waitForTimeout(2000);
  release();
  const read = async path => (await (await context.request.get(`${root}/file?path=${encodeURIComponent(path)}`)).json()).content;
  await waitFor(async () => (await read('main.tex')).startsWith('SAVE_A_B'), 'new text survives old ACK');
  await page.locator('.save-indicator--saved').waitFor();
  assert.match(await page.locator('.view-lines').innerText(), /SAVE_A_B/, 'ACK must not overwrite the rendered model');
  assert.equal(reads, 0, 'save metadata refresh must not read active text');
  await editor().focus();
  await page.keyboard.insertText('_FAST');
  await page.locator('span[title="other.tex"]').click();
  await page.getByRole('textbox', { name: 'Source editor for other.tex', exact: true }).waitFor();
  await page.locator('span[title="main.tex"]').click();
  await editor().waitFor();
  await waitFor(async () => (await read('main.tex')).startsWith('SAVE_A_B_FAST'), 'fast file switch preserves queued save');
  await editor().focus();
  await page.keyboard.press('Control+z');
  await waitFor(async () => !(await read('main.tex')).includes('_FAST'), 'undo stack survives file switch');
  assert.equal(await read('other.tex'), 'other', 'no cross-file write');
  await page.unroute('**/file?path=main.tex');
  let failedSave = false;
  await page.route('**/file?path=main.tex', async route => {
    if (route.request().method() === 'PUT' && !failedSave) {
      failedSave = true;
      await route.abort('internetdisconnected');
    } else await route.continue();
  });
  await editor().focus();
  await page.keyboard.press('Control+Home');
  await page.keyboard.insertText('RETRY_');
  await page.locator('.save-indicator--offline').waitFor();
  assert.match(await page.locator('.view-lines').innerText(), /RETRY_/, 'failed save retains visible text');
  assert.ok(!(await read('main.tex')).startsWith('RETRY_'), 'failed save must not claim persistence');
  await page.keyboard.press('Control+s');
  await waitFor(async () => (await read('main.tex')).startsWith('RETRY_'), 'explicit retry persists retained text');
  await page.locator('.save-indicator--saved').waitFor();
  const sourceEditorCountBeforeStress = await page.locator('.source-editor-container .monaco-editor').count();
  for (let index = 0; index < 25; index++) {
    await editor().focus();
    await page.locator('span[title="other.tex"]').click();
    const other = page.getByRole('textbox', { name: 'Source editor for other.tex', exact: true });
    await other.waitFor();
    await other.focus();
    await page.locator('span[title="main.tex"]').click();
    await editor().waitFor();
  }
  await page.waitForTimeout(100);
  const sourceEditorCountAfterStress = await page.locator('.source-editor-container .monaco-editor').count();
  assert.equal(sourceEditorCountAfterStress, sourceEditorCountBeforeStress, 'source switches must not accumulate Monaco editor instances');
  assert.deepEqual(failures, [], 'no browser exceptions');
  console.log(JSON.stringify({ result: 'pass', cases: ['delayed ACK', 'tree does not reload text', 'switch before debounce', 'undo retained', 'no cross-file write', 'failed save retained and retried', '50 source switches without browser exceptions', 'stable source Monaco instance count'], sourceEditorCount: sourceEditorCountAfterStress, projectId: project.id }));
} finally {
  await browser.close();
}
