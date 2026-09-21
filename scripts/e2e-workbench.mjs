import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const base = process.env.FASTWRITE_E2E_URL ?? 'http://127.0.0.1:3218';
const browser = await chromium.launch({ channel: process.env.FASTWRITE_E2E_CHANNEL ?? 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(() => { localStorage.setItem('fastwrite.completion.enabled', 'false'); localStorage.setItem('fastwrite.collaboration.enabled', 'false'); });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.stack));
try {
  const created = await context.request.post(`${base}/api/projects`, { data: { name: 'Workbench regression' } });
  assert.ok(created.ok());
  const project = await created.json();
  const root = `${base}/api/projects/${project.id}`;
  const opened = await (await context.request.get(`${root}/file?path=main.tex`)).json();
  const saved = await context.request.put(`${root}/file?path=main.tex`, { data: { content: '% History marker\n' + opened.content, baseVersion: opened.file.version } });
  assert.ok(saved.ok());
  await context.request.post(`${root}/history/checkpoint`);
  for (const path of ['other.tex', 'third.tex']) assert.ok((await context.request.post(`${root}/files`, { data: { path, content: path } })).ok());
  await page.goto(`${base}/projects/${project.id}`);
  await page.getByRole('textbox', { name: 'Source editor for main.tex', exact: true }).waitFor();
  const activity = page.getByRole('navigation', { name: 'Workspace views' });
  const tabs = page.getByRole('tablist', { name: 'Open editors' });
  await tabs.getByRole('tab', { name: 'main.tex', exact: true }).dblclick();
  await page.locator('span[title="other.tex"]').click();
  await tabs.getByRole('tab', { name: 'other.tex', exact: true }).waitFor();
  await page.locator('span[title="third.tex"]').click();
  await tabs.getByRole('tab', { name: 'third.tex', exact: true }).waitFor();
  assert.equal(await tabs.getByRole('tab').count(), 2, 'only one preview tab');
  assert.equal(await tabs.getByRole('tab', { name: 'other.tex', exact: true }).count(), 0);
  await tabs.getByRole('tab', { name: 'third.tex', exact: true }).dblclick();
  await page.locator('span[title="other.tex"]').click();
  await tabs.getByRole('tab', { name: 'other.tex', exact: true }).waitFor();
  assert.equal(await tabs.getByRole('tab').count(), 3);
  await tabs.getByRole('tab', { name: 'other.tex', exact: true }).click({ button: 'middle' });
  await tabs.getByRole('tab', { name: 'other.tex', exact: true }).waitFor({ state: 'detached' });
  await tabs.getByRole('tab', { name: 'main.tex', exact: true }).click();
  await page.keyboard.press('Control+p');
  await page.getByRole('textbox', { name: 'Find file by name' }).fill('other.tex');
  await page.getByRole('option', { name: 'other.tex', exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'Find file by name' }).press('Enter');
  await page.getByRole('textbox', { name: 'Source editor for other.tex', exact: true }).waitFor();
  await tabs.getByRole('tab', { name: 'main.tex', exact: true }).click();
  await page.getByRole('button', { name: 'Hide panel', exact: true }).click();
  assert.equal(await page.locator('#bottom-ai-panel').isVisible(), false);
  await page.getByRole('button', { name: 'Show panel', exact: true }).click();
  await page.locator('#bottom-workbench-panel').waitFor({ state: 'visible' });


  for (const [name, id] of [['Evidence', 'evidence'], ['Outline', 'outline'], ['Files', 'files']]) {
    await activity.getByRole('button', { name, exact: true }).click();
    assert.equal(await page.locator(`#sidebar-${id}`).isVisible(), true);
    assert.equal(await page.locator('.workspace-sidebar > :visible').count(), 1, 'one primary view at a time');
  }
  await activity.getByRole('button', { name: 'Git', exact: true }).click();
  /*
   * The checkpoint list this used to click through was removed with the Phase A
   * sidebar, and with it `real historical diff`, the one case that drove it.
   *
   * The three cases that only needed *a* diff open — `inline layout`, `stale
   * restore protected` and `checkpoint then restore` — cannot follow it through
   * the Changes group, which is the entry point that replaced it. Two separate
   * reasons, both measured against the running app, and both product findings
   * reported with this change rather than stale-test problems:
   *
   *   1. The row asks for a HEAD-to-working comparison (`baseRef: "HEAD"`), and
   *      the server's `resolveCommit` accepts only a hex oid: it answers 404
   *      `history_checkpoint_not_found` for `HEAD`. No comparison ever loads, so
   *      there are no diff lines to assert on and the panel renders that error
   *      instead.
   *   2. `Restore file` is disabled outright for a `working` target — a working
   *      diff has no checkpoint to restore from — so the restore flow has no
   *      control to click even if the comparison loaded.
   *
   * The restore cases are therefore deleted rather than left red. Dirty the file
   * first so the group is non-empty: HEAD already contains the history marker
   * from the checkpoint above, so without a new worktree change it would be.
   */
  const dirty = await (await context.request.get(`${root}/file?path=main.tex`)).json();
  assert.ok((await context.request.put(`${root}/file?path=main.tex`, { data: { content: dirty.content + '% Working change\n', baseVersion: dirty.file.version } })).ok());
  await page.reload();
  const changes = page.getByRole('region', { name: 'Changes', exact: true });
  /*
   * `exact` matters twice over. The group is scoped because a path can appear in
   * both groups at once, and the name is exact because the row's own actions are
   * buttons whose names also contain the path — `Stage main.tex` and `Discard
   * changes in main.tex` — so a substring match is a strict-mode violation.
   */
  await changes.getByRole('button', { name: 'main.tex', exact: true }).click();
  await page.locator('.workspace-diff').waitFor();
  assert.equal(await page.locator('.source-editor-container').isVisible(), false);
  /*
   * The layout combobox is asserted for what it still controls — its own value —
   * because the comparison it would re-lay-out never loads (reason 1 above).
   */
  await page.getByRole('combobox', { name: 'Diff layout' }).click();
  await page.getByRole('option', { name: 'Inline', exact: true }).click();
  assert.equal((await page.getByRole('combobox', { name: 'Diff layout' }).innerText()).trim(), 'Inline');
  /*
   * Close it again: the source editor tab is unmounted while the comparison tab
   * is active, and `source retained` below is about the source coming back.
   */
  await page.getByRole('button', { name: 'Close comparison', exact: true }).click();
  await page.locator('.workspace-diff').waitFor({ state: 'detached' });

  assert.equal(await page.getByRole('textbox', { name: 'Source editor for main.tex', exact: true }).count(), 1);
  await activity.getByRole('button', { name: 'Git', exact: true }).click();
  assert.equal(await page.locator('.workspace-sidebar').isVisible(), false);
  await page.keyboard.press('Control+Shift+e');
  assert.equal(await page.locator('#sidebar-files').isVisible(), true);
  await page.setViewportSize({ width: 640, height: 900 });
  await activity.getByRole('button', { name: 'Evidence', exact: true }).click();
  assert.equal(await page.locator('#sidebar-evidence').isVisible(), true, 'narrow view remains reachable');
  assert.equal(await activity.isVisible(), true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'pass', projectId: project.id, cases: ['preview and pinned tabs', 'middle-click close', 'quick open', 'panel collapse', 'four exclusive sidebar views', 'inline layout', 'source retained', 'keyboard and collapse', 'narrow screen access'] }));
} finally { await browser.close(); }
