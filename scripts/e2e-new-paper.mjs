import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { startTestServer, launchTestBrowser } from './fixtures/browser-test.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'output/ui-new-paper');
await mkdir(output, { recursive: true });
const setup = process.env.FASTWRITE_E2E_URL ? null : await startTestServer();
const base = process.env.FASTWRITE_E2E_URL ?? setup.origin;
let browser, page;
const errors = [], layouts = [], submissions = [];
try {
  browser = await launchTestBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.addInitScript(() => { localStorage.setItem('fastwrite.session-token', 'new-paper-fixture'); localStorage.setItem('fastwrite.theme', 'light'); });
  const security = Array.from({ length: 18 }, (_, i) => ({ value: i ? `security-${i}` : 'ccs', label: i ? `Security Conference ${i}` : 'ACM CCS', domain: 'network-information-security', kind: 'conference', edition: '2027', verifiedAt: '2026-11-11', sourceUrl: 'https://example.test/conference' }));
  const ai = { value: 'neurips', label: 'NeurIPS', kind: 'conference', domain: 'artificial-intelligence', edition: '2027', verifiedAt: '2026-11-11', sourceUrl: 'https://example.test/neurips', tracks: [{ value: 'main', label: '主会论文' }, { value: 'datasets', label: '数据集论文' }], template: { id: 'neurips-template', label: 'NeurIPS 官方模板', trust: 'official', sourceUrl: 'https://example.test/template', years: [2026, 2027], venueSpecific: true, verifiedAt: '2026-11-11' } };
  let failCatalog = false;
  await context.route(`${base}/api/**`, async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/auth/me') return route.fulfill({ json: { id: 'user', displayName: '研究者', emailNormalized: 'research@example.test' } });
    if (pathname === '/api/auth/dev-session') return route.fulfill({ json: { token: 'new-paper-fixture' } });
    if (pathname === '/api/teams') return route.fulfill({ json: [
      { id: 'personal', name: '个人工作区', personalUserId: 'user', role: 'owner' },
      { id: 'lab', name: '密码学实验室', role: 'owner' },
      { id: 'admin-lab', name: '研究团队', role: 'admin' },
      { id: 'member-lab', name: '普通成员团队', role: 'member' },
    ] });
    if (pathname === '/api/venues') return failCatalog ? route.fulfill({ status: 503, json: { error: '目录暂不可用' } }) : route.fulfill({ json: [...security, ai] });
    if (pathname === '/api/projects' && route.request().method() === 'POST') {
      submissions.push(route.request().postDataJSON());
      return route.fulfill({ status: 503, json: { error: '测试中保留表单' } });
    }
    return route.fulfill({ json: [] });
  });
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/panel`);
  const dialog = page.getByRole('dialog', { name: '创建新论文', exact: true });
  await page.getByRole('button', { name: '新建论文', exact: true }).first().click();
  await expect(dialog.getByText('使用可编译的最简 LaTeX 文档开始写作。', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('combobox', { name: '工作区', exact: true })).toHaveCount(0);
  await dialog.getByRole('combobox', { name: '所属团队', exact: true }).click();
  await expect(dialog.getByRole('option')).toHaveCount(3);
  await dialog.getByRole('option', { name: '密码学实验室', exact: true }).click();
  await dialog.getByRole('textbox', { name: '项目名称', exact: true }).fill('面包屑选择测试论文');
  const body = dialog.locator('.dialog__body');
  const bodyState = await body.evaluate(node => ({ top: node.scrollTop, height: node.scrollHeight }));
  await dialog.getByRole('combobox', { name: '研究领域', exact: true }).click();
  await expect(dialog.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('listbox')).toHaveCount(0);
  await dialog.getByRole('combobox', { name: '目标会议或期刊', exact: true }).click();
  const search = dialog.getByRole('combobox', { name: '目标会议或期刊', exact: true });
  await search.fill('CCS');
  await dialog.getByRole('option', { name: /ACM CCS/ }).click();
  await expect(dialog.getByRole('combobox', { name: '稿件阶段', exact: true })).toContainText('匿名投稿');
  await expect(body).toHaveJSProperty('scrollTop', bodyState.top);
  await dialog.getByRole('combobox', { name: '研究领域', exact: true }).click();
  await dialog.getByRole('option', { name: '人工智能', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: '目标会议或期刊', exact: true })).toContainText('通用领域指导');
  await expect(dialog.getByRole('combobox', { name: '稿件阶段', exact: true })).toHaveCount(0);
  await dialog.getByRole('combobox', { name: '目标会议或期刊', exact: true }).click();
  await dialog.getByRole('option', { name: /NeurIPS/ }).click();
  await expect(dialog.getByRole('combobox', { name: '模板年份', exact: true })).toContainText('2027 年');
  await expect(dialog.getByRole('combobox', { name: '论文类别', exact: true })).toContainText('主会论文');
  await dialog.getByRole('combobox', { name: '模板年份', exact: true }).click();
  await dialog.getByRole('option', { name: '2026 年', exact: true }).click();
  await dialog.getByRole('combobox', { name: '稿件阶段', exact: true }).click();
  await dialog.getByRole('option', { name: '终稿', exact: true }).click();
  await dialog.getByRole('combobox', { name: '论文类别', exact: true }).click();
  await dialog.getByRole('option', { name: '数据集论文', exact: true }).click();
  await dialog.getByRole('button', { name: '创建论文', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  assert.deepEqual(submissions.at(-1), { name: '面包屑选择测试论文', mainDocument: 'main.tex', venue: 'artificial-intelligence', teamId: 'lab', initializeFromTemplate: true, publicationTarget: { domain: 'artificial-intelligence', venueId: 'neurips', year: 2026, stage: 'camera-ready', track: 'datasets' } });
  await expect(dialog.getByRole('textbox', { name: '项目名称' })).toHaveValue('面包屑选择测试论文');
  await page.keyboard.press('Escape');
  // Reopen with a clean component mount to exercise a failed catalog and retry.
  await page.reload(); failCatalog = true;
  await page.getByRole('button', { name: '新建论文', exact: true }).first().click();
  await dialog.getByRole('combobox', { name: '目标会议或期刊', exact: true }).click();
  failCatalog = false;
  await dialog.getByRole('option', { name: '加载失败，点击重试', exact: true }).click();
  await dialog.getByRole('combobox', { name: '目标会议或期刊', exact: true }).click();
  await dialog.getByRole('combobox', { name: '目标会议或期刊', exact: true }).fill('CCS');
  await dialog.getByRole('option', { name: /ACM CCS/ }).click();
  await page.keyboard.press('Escape');
  const axe = await readFile(join(root, 'node_modules/axe-core/axe.min.js'), 'utf8');
  await page.route('**/__new-paper-axe.js', route => route.fulfill({ contentType: 'application/javascript', body: axe }));
  await page.addScriptTag({ url: '/__new-paper-axe.js' });
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await page.getByRole('button', { name: '切换深色主题', exact: true }).click();
    for (const [width, height] of [[1440, 960], [720, 800], [390, 700], [320, 568]]) {
      await page.setViewportSize({ width, height });
      await page.getByRole('button', { name: '新建论文', exact: true }).first().click();
      await dialog.getByRole('combobox', { name: '研究领域', exact: true }).click();
      await dialog.getByRole('option', { name: '人工智能', exact: true }).click();
      await dialog.getByRole('combobox', { name: '目标会议或期刊', exact: true }).click();
      await dialog.getByRole('option', { name: /NeurIPS/ }).click();
      await page.evaluate(() => document.fonts.ready);
      const layout = await body.evaluate(node => ({ scrollTop: node.scrollTop, height: node.clientHeight, contentHeight: node.scrollHeight }));
      assert.equal(layout.scrollTop, 0, 'selector can be used from the initial form position');
      assert.equal(await dialog.evaluate(node => node.scrollWidth > node.clientWidth + 1), false, `${theme} ${width}: modal fits`);
      await dialog.screenshot({ path: join(output, `new-paper-${theme}-${width}.png`) });
      for (const label of ['所属团队', '研究领域', '目标会议或期刊', '模板年份', '稿件阶段', '论文类别']) {
        const scrollBefore = await body.evaluate(node => node.scrollTop);
        await dialog.getByRole('combobox', { name: label, exact: true }).click();
        const list = dialog.getByRole('listbox');
        await expect(list).toBeVisible();
        const panel = list.locator('..');
        const popup = await panel.boundingBox();
        const footer = await dialog.locator('.dialog__footer').boundingBox();
        assert.ok(popup.y + popup.height <= footer.y + 1, `${label} ${theme} ${width}: menu stays above footer`);
        assert.ok(popup.x >= 0 && popup.x + popup.width <= width, `${label} ${theme} ${width}: menu fits width`);
        assert.equal(await body.evaluate(node => node.scrollTop), scrollBefore, `${label}: opening does not scroll form`);
        await expect(dialog.getByRole('button', { name: '创建论文', exact: true })).toBeInViewport();
        if (label === '研究领域' || label === '目标会议或期刊') await dialog.screenshot({ path: join(output, `${label}-${theme}-${width}.png`) });
        await page.keyboard.press('Escape');
        await expect(dialog).toBeVisible();
      }
      const violations = await page.evaluate(async () => (await window.axe.run(document.querySelector('[role="dialog"]'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.filter(item => ['critical', 'serious'].includes(item.impact)).map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) })));
      assert.deepEqual(violations, []);
      layouts.push({ theme, width, ...layout });
      await page.keyboard.press('Escape');
    }
  }
  await page.goto(`${base}/components`);
  const example = page.getByRole('group', { name: '面包屑选择示例', exact: true });
  await example.getByRole('combobox', { name: '示例领域', exact: true }).click();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(example.getByRole('combobox', { name: '示例领域', exact: true })).toContainText('人工智能');
  await example.getByRole('combobox', { name: '示例投稿目标', exact: true }).click();
  await page.getByRole('option', { name: 'ICML', exact: true }).click();
  await expect(example.getByRole('combobox', { name: '示例投稿目标', exact: true })).toContainText('ICML');
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'checks.json'), JSON.stringify({ result: 'pass', layouts, pageErrors: errors }, null, 2));
  console.log(JSON.stringify({ result: 'pass', layouts, pageErrors: errors }));
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally { await browser?.close(); await setup?.close(); }
