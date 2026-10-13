import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const base = `${(process.env.FASTWRITE_E2E_URL ?? 'http://127.0.0.1:3712').replace(/\/$/, '')}/`;
const output = resolve(process.env.FASTWRITE_E2E_OUTPUT ?? '../startup-validation');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true, ...(process.env.FASTWRITE_E2E_EXECUTABLE ? { executablePath: process.env.FASTWRITE_E2E_EXECUTABLE } : {}) });
const results = [];
const heavy = /\/(?:monaco(?:Worker)?|pdf(?:\.worker)?|latex-engine|(?:css|html|json|ts)\.worker)[^/]*\.(?:js|mjs|wasm)(?:\?|$)|\/bundles\/|\/busytex\.wasm/;

try {
  for (const signedIn of [false, true]) {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
    if (signedIn) {
      await context.addInitScript(() => localStorage.setItem('fastwrite.session-token', 'startup-test-fixture'));
      await context.route('**/api/auth/me', route => route.fulfill({ json: { displayName: 'Startup fixture', emailNormalized: 'fixture@example.test' } }));
      await context.route('**/api/projects', route => route.fulfill({ json: [] }));
    }
    const page = await context.newPage();
    const requests = [];
    const errors = [];
    page.on('request', request => requests.push(request.url()));
    page.on('pageerror', error => errors.push(error.message));
    const start = Date.now();
    await page.goto(base);
    await page.locator(signedIn ? '.projects-page' : '.product-landing').waitFor({ timeout: 15000 });
    const visibleMs = Date.now() - start;
    assert.deepEqual(requests.filter(url => heavy.test(url)), [], 'the home/project list must not fetch editor/compiler resources');
    assert.deepEqual(errors, [], 'no startup browser exceptions');
    await page.screenshot({ path: resolve(output, signedIn ? 'project-list.png' : 'home.png') });
    results.push({ case: signedIn ? 'project-list' : 'home', visibleMs, scriptRequests: requests.filter(url => /\.(?:js|mjs)(?:\?|$)/.test(url)) });
    await context.close();
  }

  const delayed = await browser.newContext({ serviceWorkers: 'block' });
  let release;
  const gate = new Promise(resolveGate => { release = resolveGate; });
  await delayed.route('**/assets/*.js', async route => { await gate; await route.continue(); });
  const delayedPage = await delayed.newPage();
  await delayedPage.goto(base, { waitUntil: 'commit' });
  await delayedPage.locator('#fastwrite-boot').waitFor({ state: 'visible' });
  await delayedPage.getByText('Loading your writing workspace…', { exact: true }).waitFor();
  await delayedPage.screenshot({ path: resolve(output, 'html-before-bundles.png') });
  release();
  await delayedPage.locator('.product-landing').waitFor();
  results.push({ case: 'HTML shell visible before application JavaScript', pass: true });
  await delayed.close();

  for (const lazyFailure of [false, true]) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const pattern = lazyFailure ? '**/assets/ProjectsPage-*.js' : '**/assets/index-*.js';
    await context.route(pattern, route => route.abort('failed'));
    const page = await context.newPage();
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    const retry = page.getByRole('button', { name: 'Reload FastWrite', exact: true });
    await retry.waitFor({ state: 'visible', timeout: 18000 });
    await page.screenshot({ path: resolve(output, lazyFailure ? 'lazy-chunk-recovery.png' : 'entry-bundle-recovery.png') });
    await context.unroute(pattern);
    await retry.click();
    await page.locator('.product-landing').waitFor();
    results.push({ case: lazyFailure ? 'lazy route failure and reload recovery' : 'entry bundle failure and reload recovery', pass: true });
    await context.close();
  }
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ browser: 'Microsoft Edge via Playwright', base, results }, null, 2));
  console.log(JSON.stringify({ result: 'pass', base, results, output }, null, 2));
} finally {
  await browser.close();
}
