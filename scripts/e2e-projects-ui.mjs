import { expect } from '@playwright/test';
import { startTestServer, launchTestBrowser } from './fixtures/browser-test.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const report = join(root, 'output/ui-projects');
await mkdir(report, { recursive: true });
const setup = process.env.FASTWRITE_E2E_URL ? null : await startTestServer();
const base = process.env.FASTWRITE_E2E_URL ?? setup.origin;
let browser;
const errors = [], cases = [], layouts = [];
let page;
try {
  browser = await launchTestBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.addInitScript(() => {
    localStorage.setItem('fastwrite.session-token', 'project-ui-fixture');
    if (!localStorage.getItem('fastwrite.theme')) localStorage.setItem('fastwrite.theme', 'light');
  });
  const names = ['面向学术写作的检索增强生成', 'Efficient Reasoning with Structured Memory', '隐私保护联邦学习研究', 'A Very Long Project Name for Reliable Layout and Ellipsis in the Project List', '多模态模型的可解释性分析', 'Research Notes — 实验与讨论'];
  const fixtureProjects = Array.from({ length: 36 }, (_, index) => ({
    id: `project-${index}`, name: `${names[index % names.length]}${index >= names.length ? ` ${index}` : ''}`,
    mainDocument: index === 3 ? 'paper/chapters/a-very-long-main-document-name.tex' : 'main.tex',
    skill: { id: 'artificial-intelligence', version: '1' },
    publicationTarget: { venueId: ['neurips', 'icml', 'ccs'][index % 3] },
    source: index % 2 ? { type: 'github', repository: 'FastR-D/research-paper', ref: 'main', commit: 'a'.repeat(40) } : { type: 'local', displayName: 'research-paper' },
    createdAt: new Date(Date.now() - (index + 1) * 86400000).toISOString(),
    updatedAt: new Date(Date.now() - index * 86400000).toISOString(), version: 1,
  }));
  let projects = [...fixtureProjects], failList = false, holdList = null;
  const deleted = [];
  await context.route(`${base}/api/**`, async route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/api/auth/me') return route.fulfill({ json: { id: 'fixture-user', displayName: '研究者', emailNormalized: 'research@example.test', platformRole: 'user' } });
    if (pathname === '/api/auth/dev-session') return route.fulfill({ json: { token: 'project-ui-fixture' } });
    if (pathname === '/api/projects' && route.request().method() === 'GET') {
      if (holdList) await holdList;
      return failList ? route.fulfill({ status: 503, json: { error: '项目服务暂不可用' } }) : route.fulfill({ json: projects });
    }
    if (/^\/api\/projects\/project-\d+$/.test(pathname) && route.request().method() === 'DELETE') {
      const id = pathname.split('/').at(-1);
      deleted.push(id); projects = projects.filter(project => project.id !== id);
      return route.fulfill({ json: { success: true } });
    }
    if (pathname === '/api/auth/providers') return route.fulfill({ json: { oidc: false, cas: false, fastcas: false } });
    return route.fulfill({ json: [] });
  });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/projects/`);
  const table = page.getByRole('table', { name: '项目列表', exact: true });
  const rows = table.locator('tbody tr');
  const nav = page.getByRole('navigation', { name: '项目来源' });
  const search = page.getByRole('searchbox', { name: '搜索项目' });
  await expect(rows).toHaveCount(36);
  await expect(rows.first()).toContainText(names[0]);
  assert.equal(await page.locator('.project-card').count(), 0);
  cases.push('projects render as a single aligned table with native project links');

  await search.fill('STRUCTURED');
  await expect(rows).toHaveCount(6);
  await nav.getByRole('button', { name: /本地项目/ }).click();
  await expect(page.getByRole('heading', { name: '没有匹配的项目', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(rows).toHaveCount(36);
  await nav.getByRole('button', { name: /GitHub 项目/ }).click();
  await expect(rows).toHaveCount(18);
  await expect(nav.getByRole('button', { name: /GitHub 项目/ })).toHaveAttribute('aria-current', 'page');
  await search.fill('research-paper');
  await expect(rows).toHaveCount(18);
  await search.fill('NeurIPS');
  await expect(rows).toHaveCount(6);
  await search.fill('');
  await nav.getByRole('button', { name: /全部项目/ }).click();
  const sort = page.getByRole('combobox', { name: '项目排序' });
  await sort.click();
  await page.getByRole('option', { name: '最早修改', exact: true }).click();
  await expect(rows.first().getByRole('link')).toHaveAttribute('href', '/projects/project-35');
  await sort.click();
  await page.getByRole('option', { name: '项目名称 A–Z', exact: true }).click();
  const actualNames = await rows.locator('td:first-child a').evaluateAll(nodes => nodes.map(node => node.title));
  assert.deepEqual(actualNames, [...fixtureProjects].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true })).map(project => project.name));
  await sort.click();
  await page.getByRole('option', { name: '最近修改', exact: true }).click();
  cases.push('search matches names, venue and repository; source filters combine with search; all sort choices work');

  await page.getByRole('button', { name: '新建论文', exact: true }).first().click();
  await expect(page.getByRole('dialog', { name: '创建新论文', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '导入论文', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '团队与协作', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  const firstLink = rows.first().getByRole('link');
  await firstLink.focus();
  assert.notEqual(await firstLink.evaluate(node => getComputedStyle(node).outlineStyle), 'none');
  await context.route(`${base}/projects/project-*`, route => route.request().isNavigationRequest() ? route.fulfill({ contentType: 'text/html', body: '<title>Project destination</title>' }) : route.continue());
  const [destination] = await Promise.all([context.waitForEvent('page'), firstLink.click({ button: 'middle' })]);
  await destination.waitForLoadState();
  assert.equal(new URL(destination.url()).pathname, '/projects/project-0');
  await destination.close();
  assert.equal(new URL(page.url()).pathname, '/projects/');
  cases.push('new/import/team dialogs and keyboard focus remain usable; middle click opens the project in a new tab');

  const axe = await readFile(join(root, 'node_modules/axe-core/axe.min.js'), 'utf8');
  await page.route('**/__projects-axe.js', route => route.fulfill({ contentType: 'application/javascript', body: axe }));
  await page.addScriptTag({ url: '/__projects-axe.js' });
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await page.getByRole('button', { name: '切换深色主题', exact: true }).click();
    for (const width of [1440, 1024, 720, 390, 320]) {
      await page.setViewportSize({ width, height: 960 });
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await table.locator('..').evaluate(node => { node.scrollTop = 0; });
      const geometry = await page.evaluate(() => {
        const table = document.querySelector('table');
        const scroll = table.parentElement;
        const heading = document.querySelector('h1').getBoundingClientRect();
        const header = table.querySelector('thead th').getBoundingClientRect();
        const firstRow = table.querySelector('tbody tr').getBoundingClientRect();
        return { pageOverflow: document.documentElement.scrollWidth > innerWidth, tableOverflow: scroll.scrollWidth > scroll.clientWidth + 1, headingY: heading.y, headerY: header.y, rowHeight: firstRow.height, scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight };
      });
      assert.equal(geometry.pageOverflow, false, `${theme} ${width}: page fits`);
      assert.equal(geometry.tableOverflow, false, `${theme} ${width}: table fits`);
      assert.ok(geometry.rowHeight <= 68, 'compact rows');
      assert.ok(geometry.scrollHeight > geometry.clientHeight, 'long list scrolls inside the table');
      await table.locator('..').evaluate(node => { node.scrollTop = 720; });
      assert.equal(await page.locator('h1').evaluate(node => node.getBoundingClientRect().y), geometry.headingY, 'page heading stays pinned');
      const currentHeaderY = await table.locator('th').first().evaluate(node => node.getBoundingClientRect().y);
      assert.ok(Math.abs(currentHeaderY - geometry.headerY) <= 1, `${theme} ${width}: column heading stays pinned (${geometry.headerY} → ${currentHeaderY})`);
      await table.locator('..').evaluate(node => { node.scrollTop = 0; });
      await page.screenshot({ path: join(report, `projects-${theme}-${width}.png`), animations: 'disabled' });
      const violations = await page.evaluate(async () => (await window.axe.run(document.querySelector('main'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.filter(v => ['critical', 'serious'].includes(v.impact)).map(v => ({ id: v.id, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) })));
      assert.deepEqual(violations, [], `${theme} ${width}: accessibility`);
      await page.getByRole('button', { name: '导入论文', exact: true }).click();
      const dropzone = page.locator('.directory-dropzone');
      const picker = await dropzone.evaluate(node => {
        const icon = node.querySelector('.directory-dropzone__icon').getBoundingClientRect();
        const title = node.querySelector('strong').getBoundingClientRect();
        const description = node.querySelector('.directory-dropzone__description').getBoundingClientRect();
        return { icon: icon.toJSON(), title: title.toJSON(), description: description.toJSON(), overflow: node.scrollWidth > node.clientWidth };
      });
      assert.equal(picker.icon.width, 48, 'folder icon keeps its square width');
      assert.equal(picker.icon.height, 48, 'folder icon keeps its square height');
      assert.ok(picker.title.top > picker.icon.bottom, 'title sits below the icon');
      assert.ok(picker.description.top > picker.title.bottom, 'description sits below the title');
      assert.equal(picker.overflow, false, 'directory picker does not overflow');
      if (width === 1440 || width === 320) await page.getByRole('dialog').screenshot({ path: join(report, `import-${theme}-${width}.png`) });
      await page.keyboard.press('Escape');
      layouts.push({ theme, width, ...geometry });
    }
  }
  cases.push('light/dark at 1440/1024/720/390/320px: no horizontal overflow, pinned toolbar/column headings, independent list scroll, accessibility passes');
  cases.push('directory picker keeps a 48px square icon above separate title and description lines in both themes and at every viewport');

  await page.setViewportSize({ width: 1440, height: 960 });
  const deleteButton = rows.first().getByRole('button', { name: /^删除 / });
  page.once('dialog', dialog => dialog.dismiss());
  await deleteButton.click();
  assert.deepEqual(deleted, []);
  page.once('dialog', dialog => dialog.accept());
  await deleteButton.click();
  await expect(rows).toHaveCount(35);
  assert.deepEqual(deleted, ['project-0']);
  cases.push('deletion still requires confirmation and refreshes the list without opening the project');

  let release;
  holdList = new Promise(resolve => { release = resolve; });
  await page.getByRole('button', { name: '刷新项目列表', exact: true }).click();
  await expect(page.getByRole('status', { name: '正在加载项目', exact: true })).toBeVisible();
  await page.screenshot({ path: join(report, 'loading.png') });
  release(); holdList = null;
  await expect(rows).toHaveCount(35);
  failList = true;
  await page.getByRole('button', { name: '刷新项目列表', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('无法加载项目');
  await expect(rows).toHaveCount(35);
  failList = false;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  projects = [];
  await page.getByRole('button', { name: '刷新项目列表', exact: true }).click();
  await expect(page.getByRole('heading', { name: '开始你的第一篇论文', exact: true })).toBeVisible();
  await page.screenshot({ path: join(report, 'empty.png') });
  cases.push('loading, retryable failure retaining existing projects and first-project empty states render correctly');
  assert.deepEqual(errors, []);
  const result = { result: 'pass', cases, layouts, pageErrors: errors };
  await writeFile(join(report, 'checks.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  console.error({ pageErrors: errors });
  await page?.screenshot({ path: join(report, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally { await browser?.close();
  await setup?.close(); }
