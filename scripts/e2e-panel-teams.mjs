import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { startTestServer, launchTestBrowser } from './fixtures/browser-test.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'output/ui-panel-teams');
await mkdir(output, { recursive: true });
const setup = process.env.FASTWRITE_E2E_URL ? null : await startTestServer();
const base = process.env.FASTWRITE_E2E_URL ?? setup.origin;
const browser = await launchTestBrowser();
const errors = [], requests = [], layouts = [];
let page;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.addInitScript(() => {
    localStorage.setItem('fastwrite.session-token', 'team-ui-fixture');
    localStorage.setItem('fastwrite.theme', 'light');
  });
  let teams = [
    { id: 'personal', name: '个人工作区', slug: 'personal', personalUserId: 'user', role: 'owner', memberCount: 1, projectCount: 2 },
    { id: 'lab', name: '应用密码学实验室', slug: 'applied-cryptography-lab', role: 'owner', memberCount: 2, projectCount: 8 },
    { id: 'admin-lab', name: '多模态研究小组', slug: 'multimodal-research', role: 'admin', memberCount: 12, projectCount: 4 },
    { id: 'member-lab', name: 'Research Collaboration with a Very Long Team Name', slug: 'research-collaboration', role: 'member', memberCount: 24, projectCount: 15 },
  ];
  let members = [
    { userId: 'user', role: 'owner', user: { id: 'user', displayName: '研究者', emailNormalized: 'owner@example.test' } },
    { userId: 'colleague', role: 'member', user: { id: 'colleague', displayName: '团队成员', emailNormalized: 'member@example.test' } },
  ];
  let invitations = [], bindings = [], failTeams = false;
  let policy = { personalHarness: false };
  await context.route(`${base}/api/**`, async route => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    const body = method === 'POST' || method === 'PATCH' || method === 'PUT' ? route.request().postDataJSON() : null;
    requests.push({ pathname, method, body });
    if (pathname === '/api/auth/me') return route.fulfill({ json: { id: 'user', displayName: '研究者', emailNormalized: 'owner@example.test' } });
    if (pathname === '/api/auth/dev-session') return route.fulfill({ json: { token: 'team-ui-fixture' } });
    if (pathname === '/api/teams') {
      if (method === 'POST') {
        teams.push({ id: 'new-lab', name: body.name, slug: 'new-lab', role: 'owner', memberCount: 1, projectCount: 0 });
        return route.fulfill({ status: 201, json: teams.at(-1) });
      }
      return failTeams ? route.fulfill({ status: 503, json: { error: '团队服务暂不可用' } }) : route.fulfill({ json: teams });
    }
    const teamMatch = pathname.match(/^\/api\/teams\/([^/]+)\/(.+)$/);
    if (teamMatch) {
      const [, teamId, action] = teamMatch;
      const team = teams.find(team => team.id === teamId);
      if (action === 'members') return route.fulfill({ json: { members, canManage: team.role === 'owner', canManageInvitations: team.role !== 'member' } });
      if (action.startsWith('members/')) {
        const memberId = action.split('/')[1];
        if (method === 'PATCH') members = members.map(member => member.userId === memberId ? { ...member, role: body.role } : member);
        if (method === 'DELETE') { members = members.filter(member => member.userId !== memberId); team.memberCount = members.length; }
        return route.fulfill({ json: {} });
      }
      if (action === 'invitations') {
        if (team.role === 'member') return route.fulfill({ status: 403, json: { error: 'No access' } });
        if (method === 'POST') {
          const invitation = { id: 'invite-1', emailNormalized: body.email, role: body.role, message: body.message, expiresAt: new Date(Date.now() + 86400000).toISOString() };
          invitations.push(invitation);
          return route.fulfill({ status: 201, json: { token: 'test-invitation', invitation } });
        }
        return route.fulfill({ json: invitations });
      }
      if (action === 'harness-policy') { if (method === 'PATCH') policy = body; return route.fulfill({ json: policy }); }
      if (action === 'group-bindings' || action.startsWith('group-bindings/')) {
        if (team.role !== 'owner') return route.fulfill({ status: 403, json: { error: 'Owner only' } });
        if (action.endsWith('/preview')) return route.fulfill({ json: bindings.filter(binding => body.groups.includes(binding.idpGroup)) });
        if (method === 'PUT') bindings.push({ id: 'binding-1', ...body });
        if (method === 'DELETE') bindings = [];
        return route.fulfill({ json: bindings });
      }
    }
    if (pathname === '/api/invitations/invite-1/resend') return route.fulfill({ json: { token: 'regenerated-invitation' } });
    if (pathname === '/api/invitations/invite-1' && method === 'DELETE') { invitations[0].revokedAt = new Date().toISOString(); return route.fulfill({ json: {} }); }
    if (pathname.startsWith('/api/invitations/') && pathname.endsWith('/accept')) return route.fulfill({ json: {} });
    return route.fulfill({ json: [] });
  });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/projects/?invite=legacy-invitation`);
  await expect(page).toHaveURL(`${base}/panel`);
  assert.ok(requests.some(request => request.pathname === '/api/invitations/legacy-invitation/accept'));
  await expect(page.getByText('FastWrite 工作区', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/显示 \d+ 个项目/)).toHaveCount(0);
  await expect(page.locator('.projects-topbar').getByRole('button', { name: '团队', exact: true })).toHaveCount(0);
  const nav = page.getByRole('navigation', { name: '项目来源' });
  await nav.getByRole('button', { name: '团队与协作', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的团队', exact: true })).toBeVisible();
  const table = page.getByRole('table', { name: '团队列表' });
  await expect(table.locator('tbody tr')).toHaveCount(3);
  await expect(page.getByLabel('3 个团队', { exact: true })).toBeVisible();
  const row = table.getByRole('row').filter({ hasText: '应用密码学实验室' });
  await expect(row).toContainText('2 人'); await expect(row).toContainText('8 篇');
  await expect(table.getByRole('row').filter({ hasText: 'Research Collaboration' }).getByRole('button', { name: '邀请', exact: true })).toBeDisabled();
  const sidebarPlacement = await nav.getByRole('button', { name: '团队与协作', exact: true }).boundingBox();
  assert.ok(sidebarPlacement.y < 450, 'team navigation is near the project filters');
  await page.screenshot({ path: join(output, 'teams-light-1440.png') });

  await page.getByRole('button', { name: '创建团队', exact: true }).click();
  const create = page.getByRole('dialog', { name: '创建团队', exact: true });
  await create.getByRole('textbox', { name: '团队名称' }).fill('新研究团队');
  await create.getByRole('textbox', { name: '团队名称' }).press('Enter');
  await expect(create).toHaveCount(0);
  await expect(table.locator('tbody tr')).toHaveCount(4);
  await row.getByRole('button', { name: '邀请', exact: true }).click();
  const invite = page.getByRole('dialog', { name: '邀请团队成员', exact: true });
  await invite.getByRole('textbox', { name: '成员邮箱' }).fill('new-member@example.test');
  await invite.getByRole('textbox', { name: '邀请留言' }).fill('一起完成实验');
  await invite.getByRole('button', { name: '创建邀请', exact: true }).click();
  await expect(invite.getByRole('textbox', { name: '邀请链接', exact: true })).toHaveValue(`${base}/panel?invite=test-invitation`);
  await expect(invite.getByRole('status')).toContainText('邀请已创建');
  await invite.screenshot({ path: join(output, 'invite-light-1440.png') });
  await page.keyboard.press('Escape');
  await row.getByRole('button', { name: '管理', exact: true }).click();
  const manage = page.getByRole('dialog', { name: '管理团队', exact: true });
  await expect(manage.getByRole('region', { name: '团队成员' }).locator('> div')).toHaveCount(2);
  await manage.getByRole('combobox', { name: '成员角色： 团队成员' }).click();
  await manage.getByRole('option', { name: '管理员', exact: true }).click();
  await expect(manage.getByRole('status')).toContainText('成员角色已更新');
  await manage.getByRole('tab', { name: '邀请记录', exact: true }).click();
  await expect(manage.getByRole('region', { name: '团队邀请' })).toContainText('new-member@example.test');
  await manage.getByRole('button', { name: '重新发送', exact: true }).click();
  await expect(manage.getByRole('textbox', { name: '邀请链接', exact: true })).toHaveValue(`${base}/panel?invite=regenerated-invitation`);
  await manage.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(manage.getByRole('region', { name: '团队邀请' })).toContainText('已撤销');
  await manage.getByRole('tab', { name: '模型策略', exact: true }).click();
  await manage.getByRole('checkbox', { name: '允许个人模型配置', exact: true }).check();
  await manage.getByRole('button', { name: '保存模型策略', exact: true }).click();
  await expect(manage.getByRole('status')).toContainText('模型策略已保存');
  assert.equal(policy.personalHarness, true);
  await manage.getByRole('tab', { name: '用户组绑定', exact: true }).click();
  await manage.getByRole('textbox', { name: '身份服务用户组' }).fill('https://idp.example:lab-members');
  await manage.getByRole('button', { name: '预览', exact: true }).click();
  await expect(manage.getByText('暂无匹配的用户组绑定', { exact: true })).toBeVisible();
  await manage.getByRole('button', { name: '添加绑定', exact: true }).click();
  await expect(manage.getByText('https://idp.example:lab-members', { exact: true })).toBeVisible();
  await manage.getByRole('button', { name: '关闭', exact: true }).click();

  // Permission-sensitive endpoints are never requested for ordinary members or admins.
  const marker = requests.length;
  await table.getByRole('row').filter({ hasText: 'Research Collaboration' }).getByRole('button', { name: '管理', exact: true }).click();
  await expect(manage.getByRole('tab', { name: /成员/ })).toBeVisible();
  await expect(manage.getByRole('tab', { name: '模型策略' })).toHaveCount(0);
  await expect(manage.getByRole('alert')).toHaveCount(0);
  assert.equal(requests.slice(marker).some(request => /invitations|group-bindings/.test(request.pathname)), false);
  await page.keyboard.press('Escape');
  await table.getByRole('row').filter({ hasText: '多模态研究小组' }).getByRole('button', { name: '管理', exact: true }).click();
  await expect(manage.getByRole('tab', { name: '模型策略' })).toBeVisible();
  await expect(manage.getByRole('tab', { name: '用户组绑定' })).toHaveCount(0);
  await expect(manage.getByRole('alert')).toHaveCount(0);
  await page.keyboard.press('Escape');

  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await page.getByRole('button', { name: '切换深色主题', exact: true }).click();
    for (const [width, height] of [[1440, 960], [1024, 800], [720, 780], [390, 700], [320, 568]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: join(output, `teams-${theme}-${width}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${theme} ${width}: page fits`);
      assert.equal(await table.locator('..').evaluate(node => node.scrollWidth > node.clientWidth + 1), false, `${theme} ${width}: team list fits`);
      await row.getByRole('button', { name: '管理', exact: true }).click();
      await manage.getByRole('tab', { name: '用户组绑定', exact: true }).click();
      await manage.getByRole('textbox', { name: '身份服务用户组' }).fill('https://idp.example:another-group');
      const select = manage.getByRole('combobox', { name: '映射角色', exact: true });
      await select.click();
      const listbox = manage.getByRole('listbox');
      await expect(listbox).toBeVisible();
      const optionBounds = await listbox.boundingBox();
      const triggerBounds = await select.boundingBox();
      assert.ok(optionBounds.y >= triggerBounds.y + triggerBounds.height, 'role list expands downward');
      for (const name of ['预览', '添加绑定']) {
        const button = manage.getByRole('button', { name, exact: true });
        await expect(button).toBeInViewport();
        const bounds = await button.boundingBox();
        assert.ok(optionBounds.y + optionBounds.height <= bounds.y || optionBounds.y >= bounds.y + bounds.height, `${theme} ${width}: dropdown does not cover ${name}`);
      }
      await manage.screenshot({ path: join(output, `groups-expanded-${theme}-${width}.png`) });
      await manage.getByRole('option', { name: '管理员', exact: true }).click();
      const geometry = await manage.evaluate(node => ({ height: node.getBoundingClientRect().height, overflow: node.scrollWidth > node.clientWidth + 1 }));
      assert.equal(geometry.overflow, false, `${theme} ${width}: modal fits`);
      assert.ok(geometry.height <= Math.min(720, height - 48) + 1);
      layouts.push({ theme, width, ...geometry });
      await page.keyboard.press('Escape');
      await row.getByRole('button', { name: '邀请', exact: true }).click();
      await expect(invite.getByRole('textbox', { name: '成员邮箱' })).toBeVisible();
      assert.equal(await invite.evaluate(node => node.scrollWidth > node.clientWidth + 1), false, `${theme} ${width}: invitation modal fits`);
      if (width === 320) await invite.screenshot({ path: join(output, `invite-${theme}-${width}.png`) });
      await page.keyboard.press('Escape');
    }
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  failTeams = true;
  await page.getByRole('button', { name: '刷新团队列表', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(table.locator('tbody tr')).toHaveCount(4);
  failTeams = false;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await row.getByRole('button', { name: '管理', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await manage.getByRole('button', { name: '移除', exact: true }).click();
  await expect(manage.getByRole('status')).toContainText('成员已移除');
  await page.keyboard.press('Escape');
  await expect(row).toContainText('1 人');
  await nav.getByRole('button', { name: /全部项目/ }).click();
  await expect(page.getByRole('heading', { name: '全部项目', exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'checks.json'), JSON.stringify({ result: 'pass', layouts, pageErrors: errors }, null, 2));
  console.log(JSON.stringify({ result: 'pass', layouts, pageErrors: errors }));
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await setup?.close();
}
