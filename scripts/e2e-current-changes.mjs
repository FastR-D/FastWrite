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
  const source = page.getByRole('textbox', { name: "源文件编辑器： main.tex", exact: true }); await source.waitFor();
  await page.getByRole('navigation', { name: "工作区视图" }).getByRole('button', { name: 'Git', exact: true }).click();
  /*
   * The list is now the sidebar's `Changes` group, not the old
   * `CurrentChangesView` list, and there is no baseline picker to set: the
   * server compares against HEAD, which is the base the checkpoint above
   * created. `exact` on the group name is load-bearing — `getByLabel('Changes')`
   * substring-matches `Staged Changes` and is a strict-mode violation as soon as
   * both groups are populated.
   */
  const panel = page.getByRole('region', { name: "当前更改" });
  await panel.waitFor();
  const changes = page.getByRole('region', { name: "更改", exact: true });
  const staged = page.getByRole('region', { name: "已暂存更改", exact: true });
  await until(async () => { const text = await changes.innerText(); return ['main.tex', 'rename-old.tex', 'rename-new.tex', 'delete.tex', 'added.tex'].every(path => text.includes(path)); }, 'saved working tree change list');
  const statusOf = (path, marker) => changes.getByRole('listitem').filter({ has: page.getByRole('button', { name: path, exact: true }) }).getByText(marker, { exact: true });
  assert.ok(await statusOf('main.tex', 'M').isVisible());
  assert.ok(await statusOf('delete.tex', 'D').isVisible());
  assert.ok(await statusOf('added.tex', 'U').isVisible());
  /*
   * git status does not pair an unstaged `mv`: it reports a delete plus an
   * untracked add. Staging both paths resolves it, because status detects staged
   * renames — which is what the stage-all below does, and why this case stages
   * first rather than expecting the pairing straight from the worktree.
   */
  assert.ok(await statusOf('rename-old.tex', 'D').isVisible());
  assert.ok(await statusOf('rename-new.tex', 'U').isVisible());
  const disclosure = changes.getByRole('button', { name: '更改', exact: true });
  await disclosure.click();
  assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
  assert.equal(await statusOf('main.tex', 'M').isVisible(), false);
  await disclosure.click();
  assert.equal(await staged.count(), 0, 'nothing is staged before the stage-all');

  const beforeStage = await head();
  await changes.getByRole('button', { name: "暂存全部更改", exact: true }).click();
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
  await save('main.tex', `% UNSTAGED_AFTER_STAGE\n% SAVED_CURRENT\n${initial.content}`);
  await page.reload();
  await page.getByRole('textbox', { name: "源文件编辑器： main.tex", exact: true }).waitFor();
  const reloaded = page.getByRole('region', { name: "已暂存更改", exact: true });
  await until(async () => (await reloaded.innerText()).includes('rename-old.tex → rename-new.tex'), 'the index survives the reload');
  assert.equal(await head(), beforeReload, 're-reading the panel does not create or move a managed checkpoint');

  await reloaded.getByRole('button', { name: 'main.tex', exact: true }).click();
  const indexDiff = page.locator('.workspace-diff[data-diff-target="index"]:visible');
  await until(async () => (await indexDiff.locator('.view-lines').allTextContents()).join('\n').includes('SAVED_CURRENT'), 'staged diff opens the index content');
  assert.ok(!(await indexDiff.locator('.view-lines').allTextContents()).join('\n').includes('UNSTAGED_AFTER_STAGE'));
  assert.equal(await indexDiff.getByRole('button', { name: '恢复文件', exact: true }).isEnabled(), false);
  await changes.getByRole('button', { name: 'main.tex', exact: true }).click();
  const workingDiff = page.locator('.workspace-diff[data-diff-target="working"]:visible');
  await until(async () => (await workingDiff.locator('.view-lines').allTextContents()).join('\n').includes('UNSTAGED_AFTER_STAGE'), 'working diff opens the later edit');

  await page.getByRole('textbox', { name: '提交说明', exact: true }).fill('Git sidebar regression');
  await page.getByRole('button', { name: '提交', exact: true }).click();
  const history = page.getByRole('region', { name: '提交历史', exact: true });
  await history.getByRole('button', { name: /Git sidebar regression/ }).click();
  await history.getByRole('list', { name: '提交的文件' }).getByRole('button', { name: 'main.tex', exact: true }).click();
  await until(async () => (await page.locator('.workspace-diff:visible .view-lines').allTextContents()).join('\n').includes('SAVED_CURRENT'), 'commit timeline opens the file at that commit');
  assert.equal(await changes.getByRole('button', { name: 'main.tex', exact: true }).isVisible(), true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'pass', projectId: project.id, baseOid, cases: ['saved worktree A/M/D/R', 'collapsible groups', 'staged rename', 'read-only refresh', 'separate index and working diffs', 'commit timeline'] }));
} finally { await browser.close(); }
