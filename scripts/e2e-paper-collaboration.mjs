import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const base = process.env.FASTWRITE_E2E_URL ?? 'http://127.0.0.1:3221';
const browser = await chromium.launch({ channel: process.env.FASTWRITE_E2E_CHANNEL ?? 'chrome', headless: true });
const errors = [];
const until = async (predicate, label) => { const end = Date.now() + 25_000; while (!await predicate()) { assert.ok(Date.now() < end, label); await new Promise(resolve => setTimeout(resolve, 80)); } };
const select = async (page, name, option) => { if (name === '写作模式') { const button = page.getByRole('navigation', { name: '工作区视图' }).getByRole('button', { name: '协作', exact: true }); if (await button.getAttribute('aria-pressed') !== 'true') await button.click(); } await page.getByRole('combobox', { name, exact: true }).click(); await page.getByRole('option', { name: option, exact: true }).click(); };
const source = page => page.getByRole('textbox', { name: '源文件编辑器： main.tex', exact: true });
const visible = page => page.locator('.source-editor .view-lines').allTextContents().then(lines => lines.join('\n').replaceAll('\u00a0', ' '));
const contexts = [];
const users = [];
try {
  for (const name of ['Author', 'Reviewer', 'Reader']) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); contexts.push(context);
    const email = `${name}-${crypto.randomUUID()}@example.test`;
    const result = await context.request.post(`${base}/api/auth/register`, { data: { email, password: 'collaboration-browser-test-password', displayName: name } });
    assert.ok(result.ok(), await result.text());
    const { token, user } = await result.json();
    await context.addInitScript(token => { localStorage.setItem('fastwrite.session-token', token); localStorage.setItem('fastwrite.completion.enabled', 'false'); }, token);
    const page = await context.newPage(); const compileRequests = []; page.on('request', request => { if (request.method() === 'POST' && /\/compile$/.test(request.url())) compileRequests.push(request.url()); }); const sockets = []; await page.routeWebSocket("**/api/collaboration/socket?*", socket => { const server = socket.connectToServer(); sockets.push({ socket, server }); }); page.on('pageerror', error => errors.push(error.stack));
    users.push({ context, page, token, user, email, headers: { authorization: `Bearer ${token}` }, sockets, compileRequests });
  }
  const [owner, reviewer, reader] = users;
  const project = await (await owner.context.request.post(`${base}/api/projects`, { headers: owner.headers, data: { name: '多人论文合作验收' } })).json();
  const root = `${base}/api/projects/${project.id}`;
  const file = await (await owner.context.request.get(`${root}/file?path=main.tex`, { headers: owner.headers })).json();
  const paper = '\\documentclass{article}\n\\begin{document}\nIntroduction\nOriginal result.\n\\end{document}\n';
  assert.ok((await owner.context.request.put(`${root}/file?path=main.tex`, { headers: owner.headers, data: { content: paper, baseVersion: file.file.version } })).ok());
  for (const [account, role] of [[reviewer, 'commenter'], [reader, 'viewer']]) {
    const invite = await (await owner.context.request.post(`${root}/invitations`, { headers: owner.headers, data: { email: account.email, role } })).json();
    assert.ok((await account.context.request.post(`${base}/api/invitations/${invite.token}/accept`, { headers: account.headers })).ok());
  }
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await owner.page.route('**/collaboration?path=main.tex', async route => { await gate; await route.continue(); });
  await owner.page.goto(`${base}/projects/${project.id}`); await source(owner.page).waitFor();
  await until(async () => !(await owner.page.locator('.editor-readonly-notice').count()), 'writer permissions load');
  await source(owner.page).focus(); await owner.page.keyboard.press('Control+Home'); await owner.page.keyboard.insertText('% BEFORE_SYNC\n');
  release();
  await until(async () => (await (await owner.context.request.get(`${root}/file?path=main.tex`, { headers: owner.headers })).json()).content.includes('BEFORE_SYNC'), 'typing during initialization persists');
  await owner.page.unroute('**/collaboration?path=main.tex');
  await Promise.all(users.slice(1).map(async account => { await account.page.goto(`${base}/projects/${project.id}`); if (account === reviewer) { await account.page.getByRole("textbox", { name: "修订编辑器： main.tex", exact: true }).waitFor(); await select(account.page, "写作模式", "查看"); } await source(account.page).waitFor(); }));
  await until(async () => (await owner.page.locator('.workspace-topbar__right').innerText()).includes('协作已开启 · 2'), 'all roles connect to live room automatically');
  for (const account of users) { const button = account.page.getByRole('navigation', { name: '工作区视图' }).getByRole('button', { name: '协作', exact: true }); if (await button.getAttribute('aria-pressed') !== 'true') await button.click(); }
  const beforeViewing = (await (await owner.context.request.get(`${root}/file?path=main.tex`, { headers: owner.headers })).json()).content;
  await select(owner.page, '写作模式', '查看'); await source(owner.page).focus(); await owner.page.keyboard.press('Control+z');
  assert.ok((await visible(owner.page)).includes('BEFORE_SYNC'), 'viewing mode retains the last local edit');
  await owner.page.waitForTimeout(700);
  assert.equal((await (await owner.context.request.get(`${root}/file?path=main.tex`, { headers: owner.headers })).json()).content, beforeViewing, 'viewing mode cannot mutate through collaborative undo');
  await select(owner.page, '写作模式', '编辑');

  await source(reviewer.page).focus(); await reviewer.page.keyboard.press('Control+Home'); await reviewer.page.keyboard.insertText('FORBIDDEN');
  assert.ok(!(await visible(reviewer.page)).includes('FORBIDDEN'), 'reviewer editor is read-only');
  assert.equal(await reader.page.getByRole('textbox', { name: '新评论', exact: true }).count(), 0, 'reader has no comment composer');
  await source(reviewer.page).focus(); await reviewer.page.keyboard.press('Control+Home'); await reviewer.page.keyboard.press('ArrowDown'); await reviewer.page.keyboard.press('ArrowDown'); await reviewer.page.keyboard.press('ArrowDown'); await reviewer.page.keyboard.press('Home'); await reviewer.page.keyboard.press('Shift+End');
  await select(reviewer.page, '讨论类型', '建议修改');
  await reviewer.page.getByRole('textbox', { name: '建议替换内容', exact: true }).fill('Background');
  await reviewer.page.getByRole('textbox', { name: '新评论', exact: true }).fill('Clarify the framing.');
  await reviewer.page.getByRole('button', { name: '提交建议', exact: true }).click();
  await until(async () => (await owner.page.locator('#sidebar-collaboration').innerText()).includes('Clarify the framing.'), 'new suggestion appears for the author without reload');
  assert.equal(await reviewer.page.getByRole('button', { name: '接受建议', exact: true }).count(), 0, 'reviewer cannot decide suggestions');
  await source(owner.page).focus(); await owner.page.keyboard.press('Control+Home'); await owner.page.keyboard.insertText('% another edit\n');
  await until(async () => (await visible(reader.page)).includes('another edit'), 'reader receives live edits');
  await owner.page.getByRole('button', { name: '接受建议', exact: true }).click();
  await until(async () => (await visible(reader.page)).includes('Background'), 'accepted suggestion broadcasts to read-only peers');
  assert.ok((await visible(reader.page)).includes('another edit'), 'suggestion retains concurrent content');
  await select(owner.page, '讨论状态', '已处理');
  await until(async () => (await owner.page.locator('#sidebar-collaboration').innerText()).includes('已接受'), 'accepted suggestion moves to history');
  // Reviewers type directly into an isolated draft, autosaved as tracked changes.
  await select(reviewer.page, '写作模式', '审阅 · 跟踪修订');
  const reviewEditor = reviewer.page.getByRole('textbox', { name: '修订编辑器： main.tex', exact: true });
  await reviewEditor.waitFor(); await reviewEditor.focus(); await reviewer.page.keyboard.press('Control+Home');
  for (let index = 0; index < 4; index++) await reviewer.page.keyboard.press('ArrowDown');
  await reviewer.page.keyboard.press('Home'); await reviewer.page.keyboard.press('Shift+End'); await reviewer.page.keyboard.insertText('Improved result.');
  await select(owner.page, '讨论状态', '修改建议');
  await until(async () => (await owner.page.locator('#sidebar-collaboration').innerText()).includes('Improved'), 'native reviewing creates tracked proposals automatically');
  assert.ok(!(await visible(reader.page)).includes('Improved result.'), 'unaccepted tracked edits do not alter canonical source');
  await source(owner.page).focus(); await owner.page.keyboard.press('Control+Home'); await owner.page.keyboard.insertText('% LIVE_DURING_REVIEW\n');
  await until(async () => (await reviewer.page.locator('.monaco-diff-editor .editor.modified .view-lines').allTextContents()).join('\n').includes('LIVE_DURING_REVIEW'), 'active review buffer receives accepted edits without dropping proposals');
  await reviewEditor.focus(); await reviewer.page.keyboard.insertText(' [continued review]');
  await until(async () => (await owner.page.locator('#sidebar-collaboration').innerText()).includes('[continued review]'), 'caret remains at the reviewed text after live rebase');
  await mkdir('output/playwright', { recursive: true });
  await reviewer.page.screenshot({ path: 'output/playwright/paper-collaboration-tracked-editing.png' });


  await owner.page.getByRole('button', { name: '接受建议', exact: true }).click();
  await until(async () => (await visible(reader.page)).includes('Improved result. [continued review]'), 'accepted tracked edits reach readers at the intended caret position');
  await select(reviewer.page, '讨论类型', '项目讨论');
  await reviewer.page.getByRole('textbox', { name: '新评论', exact: true }).fill('Please check the submission checklist.');
  await reviewer.page.getByRole('button', { name: '发表评论', exact: true }).click();
  await select(owner.page, '讨论状态', '全部讨论');
  await until(async () => (await owner.page.locator('#sidebar-collaboration').innerText()).includes('Please check the submission checklist.'), 'project discussion works without a source selection');
  // Approved external edits must update existing rooms without replacing document identity.
  const current = await (await owner.context.request.get(`${root}/file?path=main.tex`, { headers: owner.headers })).json();
  const external = await owner.context.request.put(`${root}/file?path=main.tex`, { headers: owner.headers, data: { content: `${current.content}\n% APPROVED_EXTERNAL\n`, baseVersion: current.file.version } });
  assert.ok(external.ok(), await external.text());
  await until(async () => (await visible(reader.page)).includes('APPROVED_EXTERNAL'), 'external file mutation broadcasts to read-only room');
  // Elevate a reviewer to editor, then exercise offline edits against a concurrent online writer.
  assert.ok((await owner.context.request.patch(`${root}/members/${reviewer.user.id}`, { headers: owner.headers, data: { role: 'editor' } })).ok());
  await reviewer.page.reload(); await source(reviewer.page).waitFor();
  await until(async () => !(await reviewer.page.locator('.editor-readonly-notice').count()), 'updated role enables editor');
  await until(async () => (await reviewer.page.locator('.workspace-topbar__right').innerText()).includes('协作已开启 · 2'), 'editor rejoins live room');
  await reviewer.context.setOffline(true);
  for (const { socket, server } of reviewer.sockets) { socket.close(); server.close(); }
  await source(reviewer.page).focus(); await reviewer.page.keyboard.press('Control+Home'); await reviewer.page.keyboard.insertText('% OFFLINE_REVIEWER\n');
  await source(owner.page).focus(); await owner.page.keyboard.press('Control+Home'); await owner.page.keyboard.insertText('% ONLINE_AUTHOR\n');
  await until(async () => (await visible(reader.page)).includes('ONLINE_AUTHOR'), 'online writer continues during peer outage');
  await reviewer.context.setOffline(false);
  await until(async () => (await visible(reader.page)).includes('OFFLINE_REVIEWER'), 'offline changes merge after reconnect');
  const merged = await (await owner.context.request.get(`${root}/file?path=main.tex`, { headers: owner.headers })).json();
  assert.ok(merged.content.includes('ONLINE_AUTHOR') && merged.content.includes('OFFLINE_REVIEWER') && merged.content.includes('Background'));
  const share = await (await owner.context.request.post(`${root}/shares`, { headers: owner.headers, data: { permission: 'comment' } })).json();
  assert.ok((await reader.context.request.post(`${base}/api/shared/${share.token}/comments`, { data: { path: 'main.tex', line: 4, author: 'Guest reviewer', body: 'Explain the main contribution.' } })).ok());
  await until(async () => (await owner.page.locator('#sidebar-collaboration').innerText()).includes('外部反馈 1'), 'external review feedback arrives in project');
  await owner.page.getByRole('tab', { name: '外部反馈 1', exact: true }).click();
  await owner.page.getByText('Explain the main contribution.', { exact: true }).waitFor();
  await owner.page.getByRole('button', { name: '解决反馈', exact: true }).click();
  await until(async () => (await owner.page.locator('#sidebar-collaboration').innerText()).includes('已解决'), 'owner resolves guest feedback');
  await owner.page.getByRole('tab', { name: '成员', exact: true }).click();
  await until(async () => (await owner.page.locator('#sidebar-collaboration').innerText()).includes('Reader'), 'online roster shows collaborators');
  assert.equal(await owner.page.getByRole('button', { name: '邀请与权限', exact: true }).count(), 1);
  await owner.page.screenshot({ path: 'output/playwright/paper-collaboration-members.png' });
  await until(async () => (await reader.page.locator('.react-pdf__Page').count()) > 0, 'readers see the shared compiled PDF');
  assert.equal(reader.compileRequests.length, 0, 'reader never starts a compile job');
  await owner.page.getByRole('tab', { name: '历史', exact: true }).click();
  await owner.page.getByRole('textbox', { name: '版本名称', exact: true }).fill('协作验收版本');
  await owner.page.getByRole('button', { name: '保存版本', exact: true }).click();
  const versionButton = owner.page.locator('#sidebar-collaboration').getByRole('button').filter({ hasText: '协作验收版本' }).first();
  await versionButton.waitFor();
  assert.ok((await owner.context.request.post(`${root}/files`, { headers: owner.headers, data: { path: 'after-checkpoint.txt', content: 'New file after saved version' } })).ok());
  await source(owner.page).focus(); await owner.page.keyboard.press('Control+End'); await owner.page.keyboard.insertText('\n% AFTER_NAMED_VERSION\n');
  await until(async () => (await (await owner.context.request.get(`${root}/file?path=main.tex`, { headers: owner.headers })).json()).content.includes('AFTER_NAMED_VERSION'), 'late source edit persists before restore');
  await versionButton.click();
  await owner.page.getByRole('button', { name: '恢复整个项目到此版本', exact: true }).click();
  const restoreDialog = owner.page.getByRole('dialog', { name: '恢复整个项目？', exact: true });
  await restoreDialog.getByRole('button', { name: '确认恢复', exact: true }).click();
  await restoreDialog.waitFor({ state: 'hidden' });
  await owner.page.getByText('已恢复；恢复前的状态已自动保存在历史中。', { exact: true }).waitFor();
  await until(async () => !(await visible(reader.page)).includes('AFTER_NAMED_VERSION'), 'whole project restoration broadcasts to readers');
  assert.equal((await owner.context.request.get(`${root}/file?path=after-checkpoint.txt`, { headers: owner.headers })).status(), 404, 'whole project restore removes later files');
  assert.ok((await visible(reader.page)).includes('Improved result.'), 'accepted tracked content survives restoring the saved version');
  await mkdir('output/playwright', { recursive: true });
  await owner.page.screenshot({ path: 'output/playwright/paper-collaboration-history.png' });
  await owner.page.getByRole('tab', { name: /^讨论/ }).click();
  await owner.page.screenshot({ path: 'output/playwright/paper-collaboration-review.png' });
  await owner.page.getByRole('tab', { name: '成员', exact: true }).click();
  await owner.page.getByRole('button', { name: '邀请与权限', exact: true }).click();
  const inviteDialog = owner.page.getByRole('dialog', { name: '邀请协作者', exact: true });
  await inviteDialog.getByRole('combobox', { name: '新所有者', exact: true }).click();
  await inviteDialog.getByRole('option', { name: new RegExp('^Reviewer ') }).click();
  await inviteDialog.getByRole('checkbox', { name: '确认将管理权限移交给所选协作者', exact: true }).check();
  await inviteDialog.getByRole('button', { name: '转移所有权', exact: true }).click();
  await inviteDialog.waitFor({ state: 'hidden' });
  const previousOwnerAccess = await (await owner.context.request.get(`${root}/access?path=main.tex`, { headers: owner.headers })).json();
  const newOwnerAccess = await (await reviewer.context.request.get(`${root}/access?path=main.tex`, { headers: reviewer.headers })).json();
  assert.equal(previousOwnerAccess.canManage, false); assert.equal(previousOwnerAccess.canWrite, true); assert.equal(newOwnerAccess.canManage, true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'pass', projectId: project.id, cases: ['typing before synchronization', 'automatic live collaboration for three roles', 'reviewer read-only editor', 'viewer live updates', 'inline selection proposal', 'cross-user discussion refresh', 'writer-only approval', 'CRDT anchor survives concurrent insert', 'accepted changes broadcast', 'resolved review history', 'online members and invitation entry', 'external edits update live rooms', 'permission upgrade', 'offline and online edits merge', 'external review feedback and resolution', 'native tracked editing autosaves isolated changes', 'tracked edits require acceptance', 'project discussions without selection', 'read-only shared PDF without compile jobs', 'named version creation and whole project restore UI', 'restored sources broadcast to all roles', 'live accepted edits merge into active review buffer', 'ownership transfer UI demotes previous owner to editor', 'review caret survives a concurrent source insertion', 'viewing mode blocks undo mutations'] }));
} catch (error) {
  await mkdir('output/playwright', { recursive: true });
  for (const [index, account] of users.entries()) {
    console.error('BROWSER', index, await account.page.locator('.workspace-topbar__right').innerText().catch(() => ''), await visible(account.page).catch(() => ''), await account.page.locator('.editor-message').allTextContents());
    await account.page.screenshot({ path: `output/playwright/collaboration-failure-${index}.png` });
  }
  console.error('PAGE ERRORS', errors); throw error;
} finally { await browser.close(); }
