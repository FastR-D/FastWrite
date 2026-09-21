import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const base = process.env.FASTWRITE_E2E_URL ?? 'http://127.0.0.1:3223';
const browser = await chromium.launch({ channel: process.env.FASTWRITE_E2E_CHANNEL ?? 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1050 } });
await context.addInitScript(() => { localStorage.setItem('fastwrite.completion.enabled', 'false'); localStorage.setItem('fastwrite.collaboration.enabled', 'false'); });
const page = await context.newPage(), errors = [];
page.on('pageerror', error => errors.push(error.stack));
const until = async (predicate, label) => { const end = Date.now() + 20000; while (!(await predicate())) { assert.ok(Date.now() < end, label); await page.waitForTimeout(40); } };
try {
  const project = await (await context.request.post(`${base}/api/projects`, { data: { name: 'Current changes regression' } })).json();
  const root = `${base}/api/projects/${project.id}`;
  const read = async path => (await (await context.request.get(`${root}/file?path=${encodeURIComponent(path)}`)).json());
  const save = async (path, content) => { const current = await read(path); assert.ok((await context.request.put(`${root}/file?path=${encodeURIComponent(path)}`, { data: { content, baseVersion: current.file.version } })).ok()); };
  const checkpoint = async () => { assert.ok((await context.request.post(`${root}/history/checkpoint`)).ok()); return (await (await context.request.get(`${root}/history-page`)).json()).commits[0].oid; };
  const head = async () => (await (await context.request.get(`${root}/history-page`)).json()).commits[0].oid;
  const initial = await read('main.tex');
  for (const [path, content] of [['rename-old.tex', 'rename baseline\n'.repeat(10)], ['delete.tex', 'delete baseline\n'], ['unchanged.tex', 'unchanged\n']]) assert.ok((await context.request.post(`${root}/files`, { data: { path, content } })).ok());
  const baseOid = await checkpoint();
  await save('main.tex', `% SAVED_CURRENT\n${initial.content}`);
  assert.ok((await context.request.patch(`${root}/files`, { data: { from: 'rename-old.tex', to: 'rename-new.tex' } })).ok());
  assert.ok((await context.request.delete(`${root}/files?path=delete.tex`)).ok());
  assert.ok((await context.request.post(`${root}/files`, { data: { path: 'added.tex', content: 'added current\n' } })).ok());
  await page.goto(`${base}/projects/${project.id}`);
  const source = page.getByRole('textbox', { name: 'Source editor for main.tex', exact: true }); await source.waitFor();
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Git', exact: true }).click();
  /*
   * The list is now the sidebar's `Changes` group, not the old
   * `CurrentChangesView` list, and there is no baseline picker to set: the
   * server compares against HEAD, which is the base the checkpoint above
   * created. `exact` on the group name is load-bearing — `getByLabel('Changes')`
   * substring-matches `Staged Changes` and is a strict-mode violation as soon as
   * both groups are populated.
   */
  const panel = page.getByRole('region', { name: 'Working changes' });
  await panel.waitFor();
  const changes = page.getByRole('region', { name: 'Changes', exact: true });
  const staged = page.getByRole('region', { name: 'Staged Changes', exact: true });
  await until(async () => { const text = await changes.innerText(); return ['main.tex', 'rename-old.tex', 'rename-new.tex', 'delete.tex', 'added.tex'].every(path => text.includes(path)); }, 'saved working tree change list');
  const unstaged = await changes.innerText();
  assert.match(unstaged, /M\s+main\.tex/);
  assert.match(unstaged, /D\s+delete\.tex/);
  assert.match(unstaged, /U\s+added\.tex/);
  /*
   * git status does not pair an unstaged `mv`: it reports a delete plus an
   * untracked add. Staging both paths resolves it, because status detects staged
   * renames — which is what the stage-all below does, and why this case stages
   * first rather than expecting the pairing straight from the worktree.
   */
  assert.match(unstaged, /D\s+rename-old\.tex/);
  assert.match(unstaged, /U\s+rename-new\.tex/);
  assert.equal(await staged.count(), 0, 'nothing is staged before the stage-all');

  const beforeStage = await head();
  await changes.getByRole('button', { name: 'Stage all changes', exact: true }).click();
  await until(async () => (await staged.innerText()).includes('rename-old.tex → rename-new.tex'), 'staged rename pairs the old and new paths');
  const stagedText = await staged.innerText();
  assert.match(stagedText, /rename-old\.tex → rename-new\.tex/);
  assert.match(stagedText, /main\.tex/);
  assert.match(stagedText, /added\.tex/);
  assert.match(stagedText, /delete\.tex/);
  assert.equal(await changes.count(), 0, 'staging every change empties the Changes group');

  /*
   * `read-only refresh`: re-reading the panel must not create or move a managed
   * checkpoint. Staging is a mutation of the index only, and the reload is a
   * fresh mount for every view, so HEAD is the same oid before and after both.
   */
  const beforeReload = await head();
  assert.equal(beforeReload, beforeStage, 'staging does not move HEAD');
  await page.reload();
  await page.getByRole('textbox', { name: 'Source editor for main.tex', exact: true }).waitFor();
  const reloaded = page.getByRole('region', { name: 'Staged Changes', exact: true });
  await until(async () => (await reloaded.innerText()).includes('rename-old.tex → rename-new.tex'), 'the index survives the reload');
  assert.equal(await head(), beforeReload, 're-reading the panel does not create or move a managed checkpoint');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'pass', projectId: project.id, baseOid, cases: ['saved worktree A/M/D/R', 'staged rename pairs old and new path', 'read-only refresh'] }));
} finally { await browser.close(); }
