import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

/*
 * Captures rendered screenshots for each route in light and dark themes.
 *
 * Run with UPDATE_VISUAL_BASELINE=1 to (re)write the baseline. Without it the
 * script compares against the stored baseline and exits non-zero on any diff.
 *
 * Baseline images live in apps/web/visual-baseline/ and are committed.
 * They cannot live under output/, which .gitignore excludes as a local artifact.
 */

const base = process.env.FASTWRITE_E2E_URL ?? 'http://127.0.0.1:3218';
const updating = process.env.UPDATE_VISUAL_BASELINE === '1';

/* Per-channel delta at or below this is antialiasing noise. */
const PIXEL_TOLERANCE = 8;
/*
 * Any single pixel this far from the baseline fails the run, whatever the
 * count. This is the threshold that actually does the work, and it was
 * calibrated by measurement in both directions:
 *
 *   glyph antialiasing noise  → 25 pixels, peak  6/255
 *   a real small regression   → 584 pixels, peak 236/255   (a colour change on
 *                               a 14px mark, which must not be tolerated)
 *
 * An earlier draft used a pixel COUNT budget alone at 720, and the 584-pixel
 * regression slipped through it. Counting cannot separate them; magnitude can,
 * with an order of magnitude of headroom on either side.
 */
const PIXEL_NOISE_CEILING = 16;
/* Diffuse drift: many small deltas that individually clear the noise floor. */
const PIXEL_BUDGET_RATIO = 0.0002;
/*
 * Resolve from this script's location, not process.cwd(). Invoked as
 * `bun run --filter @fastwrite/web e2e:visual` the cwd is apps/web, and a
 * cwd-relative path silently lands on apps/web/apps/web/visual-baseline/ —
 * where it would find no baselines, create a stray directory, and report
 * spurious failures.
 */
const repositoryRoot = resolve(import.meta.dirname, '..');
const baselineDir = join(repositoryRoot, 'apps', 'web', 'visual-baseline');
mkdirSync(baselineDir, { recursive: true });
/*
 * Where a failing capture is written for inspection. A boolean "differs" tells
 * a human nothing about WHAT moved, and the alternative — re-running by hand
 * and guessing — is what makes people rubber-stamp UPDATE_VISUAL_BASELINE. The
 * path is under output/, which .gitignore excludes, so a stale dump can never
 * be committed by accident.
 */
const actualDir = join(repositoryRoot, 'output', 'visual-actual');

/*
 * The server seeds main.tex with \maketitle and no \date{}
 * (apps/server/src/workspace/workspace-service.ts), so LaTeX renders \today
 * and the PDF pane — which is inside the workspace screenshot — changes with
 * the calendar. A byte-compared PNG that fails the next morning is worse than
 * no baseline at all, so overwrite the document with a literal date before the
 * route is captured.
 */
const mainDocument = String.raw`\documentclass{article}
\title{Visual baseline}
\author{}
\date{1 January 2000}
\begin{document}
\maketitle

\section{Introduction}

\end{document}
`;

/*
 * Grayscale antialiasing instead of LCD subpixel rendering.
 *
 * Not cosmetic: Chrome's subpixel text rasterization is not bit-deterministic
 * across runs — consecutive captures of the same unchanged page differ by 1-5
 * units of RGB on glyph edges. That was invisible while every icon was a lucide
 * <svg> path, which rasterizes deterministically, but the codicon migration
 * made icons font glyphs, and the baseline started failing roughly two runs in
 * three for no reason connected to the code.
 *
 * Without the flag a flaky baseline is worse than none: it trains people to
 * re-run until green, which is exactly how a real regression gets waved
 * through. Measured stable over three consecutive captures with it; verified
 * that the other candidate flags (--font-render-hinting, --force-color-profile,
 * --disable-gpu) are all unnecessary on their own.
 */
const browser = await chromium.launch({
  channel: process.env.FASTWRITE_E2E_CHANNEL ?? 'chrome',
  headless: true,
  args: ['--disable-lcd-text']
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });

/*
 * Pin the moving parts so screenshots are deterministic: disable completion and
 * collaboration (they mount async work), freeze animations, and select a fixed
 * harness so the workspace chips do not depend on this machine's session.
 */
await context.addInitScript(() => {
  localStorage.setItem('fastwrite.completion.enabled', 'false');
  localStorage.setItem('fastwrite.collaboration.enabled', 'false');
  localStorage.setItem('fastwrite.selected-harness', 'codex');
});

const failures = [];
let project;
try {
  const created = await context.request.post(`${base}/api/projects`, { data: { name: 'Visual baseline' } });
  if (!created.ok()) throw new Error(`project creation failed: ${created.status()}`);
  project = await created.json();

  const fileUrl = `${base}/api/projects/${project.id}/file?path=main.tex`;
  const opened = await context.request.get(fileUrl);
  if (!opened.ok()) throw new Error(`main.tex fetch failed: ${opened.status()}`);
  const current = await opened.json();
  const saved = await context.request.put(fileUrl, { data: { content: mainDocument, baseVersion: current.file.version } });
  if (!saved.ok()) throw new Error(`main.tex update failed: ${saved.status()}`);

  const routes = [
    { id: 'projects', path: '/' },
    { id: 'workspace', path: `/projects/${project.id}`, ready: waitForCompiledPdf },
    { id: 'admin', path: '/admin' },
    { id: 'diagrams', path: '/diagrams' },
    { id: 'components', path: '/components' }
  ];

  for (const route of routes) {
    for (const theme of ['light', 'dark']) {
      const page = await context.newPage();
      await page.addInitScript((value) => localStorage.setItem('fastwrite.theme', value), theme);
      await page.goto(`${base}${route.path}`, { waitUntil: 'networkidle' });
      if (route.ready) await route.ready(page);
      /*
       * Freeze animations so nothing is captured mid-transition, and take the
       * harness status chips out of the layout entirely.
       *
       * The chips report server-side CLI detection, so a host with one CLI
       * installed renders one chip where this one renders two. Masking them is
       * not enough: the status div is `display: inline-flex`, so it is
       * content-sized — measured at 197px for two chips and 93px for one — and
       * that moves every sibling to its right (Memory, Research, Review), which
       * a mask cannot cover because the mask is sized to the element it hides.
       * `display: none` removes the region from flow, so neither the chip count
       * nor its label ("Ready" / "Unavailable") can reach a captured pixel.
       *
       * Selected by accessibility label, not class name: the chips are
       * server-dependent and the component migration renames CSS classes, so a
       * class-based selector would quietly stop hiding anything and reintroduce
       * exactly the drift this avoids.
       */
      await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}[aria-label="Harness status"]{display:none!important}' });
      await page.waitForTimeout(300);

      const name = `${route.id}-${theme}.png`;
      const target = join(baselineDir, name);
      const shot = await page.screenshot({ fullPage: true });

      if (updating) {
        writeFileSync(target, shot);
        console.log(`baseline written: ${name}`);
      } else {
        const previous = readBaseline(target);
        if (!previous) failures.push(`${name}: no baseline (run with UPDATE_VISUAL_BASELINE=1)`);
        else {
          const delta = comparePng(previous, shot);
          if (delta.worst > PIXEL_NOISE_CEILING || delta.changed > delta.budget) {
            mkdirSync(actualDir, { recursive: true });
            writeFileSync(join(actualDir, name), shot);
            failures.push(`${name}: ${delta.changed} pixels differ beyond tolerance (peak ${delta.worst}/255) — review output/visual-actual/${name}`);
          } else if (delta.changed > 0) {
            // Within budget: tolerated glyph antialiasing, not a regression.
            console.log(`ok: ${name} (${delta.changed}px within tolerance, peak ${delta.worst}/255)`);
          } else console.log(`ok: ${name}`);
        }
      }
      await page.close();
    }
  }
} finally {
  /*
   * The project exists only to give the workspace route something to render.
   * Leaving it behind grows the projects list, so the `/` screenshot drifts
   * further from the baseline on every run against a long-lived server.
   * Cleanup must never mask a real comparison failure, so a failed delete is
   * reported and swallowed rather than thrown.
   */
  if (project) {
    try {
      const removed = await context.request.delete(`${base}/api/projects/${project.id}`);
      if (!removed.ok()) console.warn(`cleanup: could not delete project ${project.id}: ${removed.status()}`);
    } catch (error) {
      console.warn(`cleanup: could not delete project ${project.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await browser.close();
}

if (failures.length && !updating) {
  console.error(failures.map((failure) => `  ${failure}`).join('\n'));
  process.exit(1);
}
console.log(JSON.stringify({ result: updating ? 'baseline-updated' : 'pass' }));

/*
 * Wait for the workspace to finish typesetting instead of sleeping a guessed
 * interval. PdfPane publishes the outcome of each compile in an aria-live strip
 * ("Compiled successfully", PdfPane.tsx), and react-pdf then rasterises the
 * result into a canvas inside the PDF preview region; waiting on both means the
 * capture cannot race the LaTeX run or catch a half-painted first page. Every
 * locator is scoped to the pane by its accessibility label — a bare `canvas`
 * also matches Monaco's hidden decorations ruler, and CSS classes are exactly
 * what this migration renames.
 */
async function waitForCompiledPdf(page) {
  const pdfPreview = page.locator('section[aria-label="PDF preview"]');
  await pdfPreview.getByText('Compiled successfully').waitFor({ timeout: 120_000 });
  await pdfPreview.locator('canvas').first().waitFor({ state: 'visible', timeout: 30_000 });
}

function readBaseline(target) {
  try {
    return readFileSync(target);
  } catch (error) {
    /*
     * A missing baseline is the expected first-run state and is reported as
     * such. Anything else — EACCES, EISDIR — is a real problem: swallowing it
     * would report "no baseline" and invite someone to overwrite a file they
     * cannot even read.
     */
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/*
 * Pixel comparison with a tolerance, rather than byte equality.
 *
 * Byte equality is too strict once icons are font glyphs. Chrome's text
 * rasterization is not bit-deterministic: consecutive captures of an unchanged
 * page differ by a handful of RGB units on glyph edges. Measured on the admin
 * route, that residual was 25 pixels out of 1.44M at a peak of 6/255 — enough
 * to fail a byte compare, far too little to be a regression.
 *
 * The thresholds are chosen so noise passes and structure fails. A real
 * regression from a component migration moves elements: hundreds or thousands
 * of pixels, at deltas far above 8/255. Anything that clears both the per-pixel
 * threshold and the budget is a genuine change, and the failure message says
 * how many pixels and how strong, so the number itself is diagnosable.
 *
 * `--disable-lcd-text` (above) removes most of the noise; this absorbs the
 * rest. Both are needed: the flag alone still flaked on one run in six.
 */

function comparePng(baselineBuffer, actualBuffer) {
  const [w, h, a] = decodePng(baselineBuffer);
  const [w2, h2, b] = decodePng(actualBuffer);
  const budget = Math.round(w * h * PIXEL_BUDGET_RATIO);
  if (w !== w2 || h !== h) {
    // A size change is structural, never antialiasing — fail without pretending
    // to count pixels.
    return { changed: Number.MAX_SAFE_INTEGER, worst: 255, budget, width: w, height: h };
  }
  let changed = 0;
  let worst = 0;
  for (let i = 0; i < a.length; i += 4) {
    const delta = Math.max(
      Math.abs(a[i] - b[i]),
      Math.abs(a[i + 1] - b[i + 1]),
      Math.abs(a[i + 2] - b[i + 2]),
      Math.abs(a[i + 3] - b[i + 3])
    );
    if (delta > PIXEL_TOLERANCE) {
      changed += 1;
      if (delta > worst) worst = delta;
    }
  }
  return { changed, worst, budget, width: w, height: h };
}

/*
 * Minimal PNG decoder: 8-bit RGB/RGBA, non-interlaced, which is what Chrome's
 * screenshot produces. Written rather than imported because the project has no
 * image dependency and adding one for a test harness is not worth it — zlib and
 * the five PNG filter types are the whole of it.
 */
function decodePng(buffer) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let colourType = 0;
  let bitDepth = 0;
  const chunks = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colourType = data[9];
      if (bitDepth !== 8 || data[12] !== 0) throw new Error(`unsupported PNG: depth ${bitDepth}, interlace ${data[12]}`);
    } else if (type === 'IDAT') chunks.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const channels = colourType === 6 ? 4 : colourType === 2 ? 3 : 0;
  if (channels === 0) throw new Error(`unsupported PNG colour type ${colourType}`);

  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  let position = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[position];
    position += 1;
    const line = Buffer.from(raw.subarray(position, position + stride));
    position += stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? line[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      if (filter === 1) line[x] = (line[x] + left) & 0xff;
      else if (filter === 2) line[x] = (line[x] + up) & 0xff;
      else if (filter === 3) line[x] = (line[x] + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 0xff;
      }
    }
    for (let x = 0; x < width; x++) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      out[to] = line[from];
      out[to + 1] = line[from + 1];
      out[to + 2] = line[from + 2];
      out[to + 3] = channels === 4 ? line[from + 3] : 255;
    }
    previous = line;
  }
  return [width, height, out];
}
