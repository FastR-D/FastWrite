import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const base = process.env.FASTWRITE_E2E_URL ?? 'http://127.0.0.1:3223';
const browser = await chromium.launch({ channel: process.env.FASTWRITE_E2E_CHANNEL ?? 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(() => { localStorage.setItem('fastwrite.completion.enabled', 'false'); localStorage.setItem('fastwrite.collaboration.enabled', 'false'); });
const page = await context.newPage();
try {
  const created = await context.request.post(`${base}/api/projects`, { data: { name: 'Workbench performance baseline' } });
  assert.ok(created.ok(), await created.text());
  const project = await created.json();
  const root = `${base}/api/projects/${project.id}`;
  for (let index = 1; index <= 20; index++) {
    const response = await context.request.post(`${root}/files`, { data: { path: `perf-${index}.tex`, content: `\\section{Performance ${index}}\ncontent ${index}` } });
    assert.ok(response.ok(), await response.text());
  }
  await page.goto(`${base}/projects/${project.id}`);
  await page.getByRole('textbox', { name: 'Source editor for main.tex', exact: true }).waitFor();
  await page.locator('span[title="perf-1.tex"]').waitFor();
  const samples = [];
  for (let index = 1; index <= 20; index++) {
    const item = page.locator(`span[title="perf-${index}.tex"]`);
    const started = performance.now();
    await item.click();
    await page.getByRole('textbox', { name: `Source editor for perf-${index}.tex`, exact: true }).waitFor();
    samples.push(performance.now() - started);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * .95) - 1)];
  assert.ok(p95 < 1000, `cached tab switch p95 ${p95.toFixed(1)}ms exceeded smoke threshold`);
  console.log(JSON.stringify({ result: 'pass', projectId: project.id, tabs: 20, p95Ms: Number(p95.toFixed(1)), maxMs: Number(Math.max(...samples).toFixed(1)) }));
} finally { await browser.close(); }
