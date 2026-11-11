import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const report = join(root, 'output/ui-typography');
await mkdir(report, { recursive: true });
const base = process.env.FASTWRITE_E2E_URL ?? 'http://127.0.0.1:3218';
const browser = await chromium.launch({ channel: process.env.FASTWRITE_E2E_CHANNEL ?? 'chrome', headless: true });
let page;
const errors = [], fontFailures = [], cases = [], layout = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => { if (/\.woff2(?:\?|$)/.test(request.url())) fontFailures.push(request.url()); });
  await page.goto(`${base}/components`);
  const comparison = page.getByRole('region', { name: '中英文字体试用', exact: true });
  await comparison.waitFor();
  await page.evaluate(() => document.fonts.ready);
  const cdp = await context.newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const fontsFor = async selector => {
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    return (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
  };
  const inputSelector = 'article[aria-label="IBM Plex Sans + Noto Sans SC"] input';
  const inputFonts = await fontsFor(inputSelector);
  assert.ok(inputFonts.some(font => font.isCustomFont && /IBM Plex Sans/.test(font.familyName)), 'English actually uses the self-hosted Plex face');
  assert.ok(inputFonts.some(font => font.isCustomFont && /Noto Sans SC/.test(font.familyName)), 'Chinese actually uses the self-hosted SC face');
  assert.equal(await page.locator(inputSelector).evaluate(node => getComputedStyle(node).fontWeight), '500');
  const codeFonts = await fontsFor('article[aria-label="IBM Plex Sans + Noto Sans SC"] pre code');
  assert.ok(codeFonts.some(font => font.isCustomFont && /JetBrains Mono/.test(font.familyName)));
  const externalFonts = await page.evaluate(() => performance.getEntriesByType('resource').filter(entry => /\.woff2(?:\?|$)/.test(entry.name) && new URL(entry.name).origin !== location.origin).map(entry => entry.name));
  assert.deepEqual(externalFonts, []);
  assert.deepEqual(fontFailures, []);
  cases.push('actual Chinese, English and monospaced webfonts load from this origin at the intended weight');

  const choices = page.getByRole('group', { name: '字体预览方案', exact: true });
  for (const [label, expected] of [['Geist', 'Geist Variable'], ['系统字体', 'system-ui'], ['Plex', 'IBM Plex Sans Variable']]) {
    await choices.getByRole('button', { name: label, exact: true }).click();
    await expect.poll(() => page.locator('h1').evaluate(node => getComputedStyle(node).fontFamily)).toContain(expected);
    await page.evaluate(() => document.fonts.ready);
  }
  cases.push('font previews update the whole catalogue and return to the default');

  const axe = await readFile(join(root, 'node_modules/axe-core/axe.min.js'), 'utf8');
  await page.route('**/__type-axe.js', route => route.fulfill({ contentType: 'application/javascript', body: axe }));
  await page.addScriptTag({ url: '/__type-axe.js' });
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await page.getByRole('button', { name: '切换深色主题', exact: true }).click();
    for (const width of [1440, 1024, 720, 320]) {
      await page.setViewportSize({ width, height: 1100 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${theme} ${width}: no page overflow`);
      const sample = page.getByRole('textbox', { name: 'plex 字体示例', exact: true });
      await sample.fill('研究方法 Research methods · 修改后的长中文与 0123456789');
      await expect(sample).toHaveValue('研究方法 Research methods · 修改后的长中文与 0123456789');
      await page.evaluate(() => document.fonts.ready);
      await comparison.screenshot({ path: join(report, `comparison-${theme}-${width}.png`), animations: 'disabled' });
      layout.push({ theme, width, overflow: false });
    }
    const violations = await comparison.evaluate(async node => (await window.axe.run(node, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.filter(v => ['critical', 'serious'].includes(v.impact)).map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })));
    assert.deepEqual(violations, [], `${theme}: typography accessibility`);
  }
  cases.push('light/dark layouts and editable mixed-language text remain usable down to 320px');

  await page.setViewportSize({ width: 1440, height: 1100 });
  await choices.getByRole('button', { name: 'Geist', exact: true }).click();
  await page.getByRole('button', { name: '返回项目列表', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.fontPreview ?? null)).toBe(null);
  await expect.poll(() => page.locator('body').evaluate(node => getComputedStyle(node).fontFamily)).toContain('IBM Plex Sans Variable');
  cases.push('leaving the gallery restores the application default');

  const fallback = await context.newPage();
  await fallback.route('**/*.woff2', route => route.abort());
  await fallback.goto(`${base}/components`);
  await expect(fallback.getByRole('heading', { name: 'FastUI 组件目录', exact: true })).toBeVisible();
  await fallback.getByRole('textbox', { name: 'plex 字体示例', exact: true }).fill('字体不可用时仍可编辑');
  await expect(fallback.getByRole('textbox', { name: 'plex 字体示例', exact: true })).toHaveValue('字体不可用时仍可编辑');
  await fallback.evaluate(() => document.fonts.ready);
  assert.equal(await fallback.evaluate(() => document.fonts.check('500 12px "IBM Plex Sans Variable"', 'Research')), false);
  cases.push('system fallback keeps the UI readable and editable when webfonts fail');
  assert.deepEqual(errors, []);
  const result = { result: 'pass', cases, layout, inputFonts, codeFonts, fontFailures, pageErrors: errors };
  await writeFile(join(report, 'checks.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  await page?.screenshot({ path: join(report, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally { await browser.close(); }
