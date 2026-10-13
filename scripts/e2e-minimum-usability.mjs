import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';

const base = (process.env.FASTWRITE_E2E_URL ?? 'http://127.0.0.1:3003').replace(/\/$/, '');
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'This regression creates accounts and papers: use an isolated local server');
const out = resolve(process.env.FASTWRITE_E2E_OUTPUT ?? `output/minimum-usability-${Date.now()}`);
const fixture = resolve(out, 'fixture');
mkdirSync(fixture, { recursive: true });
const source = '\\documentclass{article}\n\\usepackage{graphicx}\n\\title{Minimum usability regression}\n\\begin{document}\n\\maketitle\n\\input{section}\n\\includegraphics[width=1cm]{figure.png}\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n';
writeFileSync(resolve(fixture, 'main.tex'), source);
writeFileSync(resolve(fixture, 'section.tex'), '\\section{Introduction}\nPersisted multi-file paper with citation~\\cite{audit}.\n');
writeFileSync(resolve(fixture, 'refs.bib'), '@article{audit,title={Local test fixture},author={Test, Author},journal={Fixture},year={2026}}\n');
// A deterministic valid PNG keeps image loading independent of external assets.
function crc32(bytes) { let n = 0xffffffff; for (const byte of bytes) { n ^= byte; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; }
function chunk(name, data) { const type = Buffer.from(name), size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([type, data]))); return Buffer.concat([size, type, data, crc]); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
writeFileSync(resolve(fixture, 'figure.png'), Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0,21,87,176]))), chunk('IEND', Buffer.alloc(0))]));

const browser = await chromium.launch({ channel: 'msedge', headless: true, ...(process.env.FASTWRITE_E2E_EXECUTABLE ? { executablePath: process.env.FASTWRITE_E2E_EXECUTABLE } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, serviceWorkers: 'block' });
const page = await context.newPage();
const cases = [], errors = [], apiFailures = [];
let token, projectId;
const api = async (path, options = {}) => {
  const response = await context.request.fetch(`${base}/api${path}`, { ...options, headers: { authorization: `Bearer ${token}`, ...options.headers } });
  assert.ok(response.ok(), `API ${path}: ${response.status()} ${await response.text()}`);
  return response;
};
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => { if (response.status() >= 400 && response.url().includes('/api/')) apiFailures.push({ status: response.status(), url: response.url() }); });
const edit = async text => { await page.locator('.monaco-editor .view-lines').first().click(); await page.keyboard.press('Control+a'); await page.keyboard.insertText(text); };
const compiled = async () => {
  try {
    await expect(page.getByText('Compiled successfully', { exact: true }).last()).toBeVisible({ timeout: 90000 });
  } catch (error) {
    await page.getByRole('tab', { name: 'Output', exact: true }).click().catch(() => {});
    throw new Error(`Compilation did not recover:\n${await page.locator('body').innerText()}`, { cause: error });
  }
  await expect(page.locator('.react-pdf__Page')).toBeVisible({ timeout: 30000 });
};
try {
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  const unique = Date.now(), email = `usability-${unique}@example.invalid`, password = `Local-Only-${unique}-aA!`;
  await page.locator('input[name=name]').fill('Local usability regression');
  await page.locator('input[name=email]').fill(email);
  await page.locator('input[name=password]').fill(password);
  await page.getByRole('dialog').getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Import paper', exact: true })).toBeVisible();
  token = await page.evaluate(() => localStorage.getItem('fastwrite.session-token'));
  cases.push('register and open personal workspace');
  console.log('REGISTERED');
  await page.getByRole('button', { name: 'Import paper', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles(fixture);
  await expect(page.getByRole('dialog').getByText('4 files', { exact: false })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Import paper', exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname.startsWith(`${new URL(base).pathname.replace(/\/$/, '')}/projects/paper_`));
  await compiled();
  console.log('IMPORTED_AND_COMPILED');
  projectId = page.url().split('/').at(-1);
  const projects = await (await api('/projects')).json();
  assert.ok(projects.some(project => project.id === projectId), 'Imported paper belongs to its creator and is listed');
  cases.push('import four files, creator can list/open/compile');
  await page.screenshot({ path: resolve(out, '01-imported.png') });

  await page.locator('span[title="figure.png"]').click();
  const image = page.getByRole('img', { name: 'figure.png', exact: true });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(element => element.complete && element.naturalWidth > 0)).toBe(true);
  cases.push('authenticated imported image preview');
  await page.locator('span[title="main.tex"]').click();
  const updated = source.replace('\\maketitle', '\\maketitle\nLatest unsaved export marker.');
  await edit(updated);
  // Export immediately: its barrier must flush the editor debounce.
  const [archive] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export source', exact: true }).click()]);
  const archivePath = resolve(out, 'source.tar.gz'); await archive.saveAs(archivePath);
  const extracted = resolve(out, 'roundtrip'); mkdirSync(extracted);
  execFileSync('tar', ['-xzf', archivePath, '-C', extracted]);
  assert.ok(readFileSync(resolve(extracted, 'main.tex'), 'utf8').includes('Latest unsaved export marker.'));
  assert.deepEqual(readFileSync(resolve(extracted, 'figure.png')), readFileSync(resolve(fixture, 'figure.png')));
  cases.push('authenticated source download flushes latest edit and retains binary');
  await page.reload(); await compiled();
  assert.ok((await (await api(`/projects/${projectId}/file?path=main.tex`)).json()).content.includes('Latest unsaved export marker.'));
  const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download PDF', exact: true }).click()]);
  await pdf.saveAs(resolve(out, 'paper.pdf'));
  assert.equal(readFileSync(resolve(out, 'paper.pdf')).subarray(0, 4).toString(), '%PDF');
  cases.push('refresh restores document, PDF preview and download');

  const other = await context.request.post(`${base}/api/auth/register`, { data: { email: `other-${unique}@example.invalid`, password, displayName: 'Other user' } });
  assert.ok(other.ok()); const otherToken = (await other.json()).token;
  const denied = await context.request.get(`${base}/api/projects/${projectId}`, { headers: { authorization: `Bearer ${otherToken}` } });
  assert.equal(denied.status(), 403);
  cases.push('another account cannot open imported private paper');

  await edit(updated.replace('\\begin{document}', '\\begin{document}\n\\undefinedAuditCommand'));
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('button', { name: /^(Recompile|Save and compile|Compile)$/ })).toBeVisible();
  await page.getByRole('button', { name: /^(Recompile|Save and compile|Compile)$/ }).click();
  await page.getByRole('tab', { name: /^Problems/ }).click();
  await expect(page.locator('.bottom-panel-problems')).toContainText('Compilation failed', { timeout: 90000 });
  await page.screenshot({ path: resolve(out, '02-compile-error.png') });
  await edit(updated); await page.keyboard.press('Control+s');
  await page.getByRole('button', { name: /^(Recompile|Save and compile|Compile)$/ }).click();
  await compiled(); cases.push('compile error is visible and corrected document recompiles');
  await page.screenshot({ path: resolve(out, '03-recovered.png') });

  await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
  await page.getByRole('button', { name: 'Import paper', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles(extracted);
  await expect(page.getByRole('dialog').getByText('4 files', { exact: false })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Import paper', exact: true }).click();
  await compiled(); cases.push('exported source can be reimported and compiled');
  assert.deepEqual(errors, []);
  writeFileSync(resolve(out, 'result.json'), JSON.stringify({ result: 'pass', base, cases, apiFailures, pageErrors: errors }, null, 2));
  console.log(JSON.stringify({ result: 'pass', cases, artifacts: out }));
} catch (error) {
  await context.storageState({ path: resolve(out, 'session.json') }).catch(() => {});
  await page.screenshot({ path: resolve(out, 'failure.png') }).catch(() => {});
  writeFileSync(resolve(out, 'failure.txt'), `${error.stack}\n\n${await page.locator('body').innerText().catch(() => '')}`);
  throw error;
} finally { await browser.close(); }
