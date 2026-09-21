import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const base = process.env.FASTWRITE_E2E_URL ?? 'http://127.0.0.1:3223';
const browser = await chromium.launch({ channel: process.env.FASTWRITE_E2E_CHANNEL ?? 'chrome', headless: true });
const results = [];
try {
  for (const dpr of [1, 1.5, 2, 3]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: dpr });
    await context.addInitScript(() => {
      localStorage.setItem('fastwrite.completion.enabled', 'false');
      localStorage.setItem('fastwrite.collaboration.enabled', 'false');
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack ?? error.message));
    try {
      const created = await context.request.post(`${base}/api/projects`, { data: { name: `Editor matrix DPR ${dpr}` } });
      assert.ok(created.ok(), await created.text());
      const project = await created.json();
      await page.goto(`${base}/projects/${project.id}`);
      const editor = page.getByRole('textbox', { name: 'Source editor for main.tex', exact: true });
      await editor.waitFor();
      assert.equal(await page.evaluate(() => window.devicePixelRatio), dpr, `DPR ${dpr} applied`);
      for (const zoom of [80, 100, 125, 150]) {
        await page.evaluate(value => { document.documentElement.style.zoom = `${value}%`; }, zoom);
        await page.waitForTimeout(120);
        assert.equal(await editor.isVisible(), true, `editor visible at DPR ${dpr}, zoom ${zoom}%`);
        assert.ok(await page.locator('.line-numbers').count() > 0, `line numbers at DPR ${dpr}, zoom ${zoom}%`);
      }
      await editor.focus();
      await page.evaluate(() => {
        window.__fastwriteCompositionEvents = [];
        for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) {
          document.querySelector('[aria-label^="Source editor"]')?.addEventListener(type, event => window.__fastwriteCompositionEvents.push(`${type}:${event.data}`), true);
        }
      });
      await page.evaluate(() => {
        const target = document.querySelector('[aria-label^="Source editor"]');
        target?.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
        target?.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: '中文组合' }));
        target?.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文组合输入' }));
      });
      await page.keyboard.insertText('中文组合输入');
      await page.locator('.view-lines').getByText('中文组合输入').waitFor();
      const compositionEvents = await page.evaluate(() => window.__fastwriteCompositionEvents);
      assert.ok(compositionEvents.some(event => event.startsWith('compositionstart:')), `composition start at DPR ${dpr}`);
      assert.ok(compositionEvents.some(event => event.startsWith('compositionupdate:中文组合')), `composition update at DPR ${dpr}`);
      assert.ok(compositionEvents.some(event => event.startsWith('compositionend:')), `composition end at DPR ${dpr}`);
      await page.keyboard.press('Control+P');
      assert.equal(await page.getByRole('dialog').count(), 1, `quick open at DPR ${dpr}`);
      assert.deepEqual(errors, [], `no browser errors at DPR ${dpr}`);
      results.push({ dpr, compositionEvents });
    } finally {
      await context.close();
    }
  }
  console.log(JSON.stringify({ result: 'pass', cases: ['80/100/125/150 percent zoom', 'DPR 1/1.5/2/3', 'line numbers', 'composition lifecycle', 'quick open shortcut'], results }));
} finally {
  await browser.close();
}
