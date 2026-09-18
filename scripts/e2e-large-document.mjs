import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const base = process.env.FASTWRITE_E2E_URL ?? 'http://127.0.0.1:3223';
const browser = await chromium.launch({ channel: process.env.FASTWRITE_E2E_CHANNEL ?? 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(() => {
  localStorage.setItem('fastwrite.completion.enabled', 'false');
  localStorage.setItem('fastwrite.collaboration.enabled', 'false');
});
const page = await context.newPage();
const now = () => performance.now();
const line = index => `\\section{Large document line ${String(index).padStart(5, '0')}} ${'x'.repeat(80)}\n`;
const content = Array.from({ length: 10_000 }, (_, index) => line(index + 1)).join();
assert.ok(Buffer.byteLength(content) >= 1_000_000, 'fixture must be at least 1MB');
try {
  const created = await context.request.post(`${base}/api/projects`, { data: { name: 'Large document performance' } });
  assert.ok(created.ok(), await created.text());
  const project = await created.json();
  const root = `${base}/api/projects/${project.id}`;
  for (const [path, fileContent] of [['large.tex', content], ['small.tex', '\\section{Small}\n']]) {
    const response = await context.request.post(`${root}/files`, { data: { path, content: fileContent } });
    assert.ok(response.ok(), await response.text());
  }
  const openedAt = now();
  await page.goto(`${base}/projects/${project.id}`);
  await page.getByRole('textbox', { name: 'Source editor for main.tex', exact: true }).waitFor();
  const largeAt = now();
  await page.locator('span[title="large.tex"]').click();
  const editor = page.getByRole('textbox', { name: 'Source editor for large.tex', exact: true });
  await editor.waitFor();
  const openMs = now() - largeAt;
  await editor.focus();
  await page.keyboard.press('Control+End');
  const inputAt = now();
  await page.keyboard.insertText('% large-document-edit');
  await page.locator('.view-lines').getByText('% large-document-edit').waitFor();
  const inputMs = now() - inputAt;
  const switchAt = now();
  await page.locator('span[title="small.tex"]').click();
  await page.getByRole('textbox', { name: 'Source editor for small.tex', exact: true }).waitFor();
  const switchMs = now() - switchAt;
  assert.ok(openMs < 5000, `large document open ${openMs.toFixed(1)}ms exceeded 5s smoke threshold`);
  assert.ok(inputMs < 1000, `large document input ${inputMs.toFixed(1)}ms exceeded 1s smoke threshold`);
  assert.ok(switchMs < 1000, `large document switch ${switchMs.toFixed(1)}ms exceeded 1s smoke threshold`);
  console.log(JSON.stringify({ result: 'pass', projectId: project.id, bytes: Buffer.byteLength(content), lines: 10_000, initialOpenMs: Number((largeAt - openedAt).toFixed(1)), largeOpenMs: Number(openMs.toFixed(1)), inputMs: Number(inputMs.toFixed(1)), switchMs: Number(switchMs.toFixed(1)) }));
} finally {
  await browser.close();
}
