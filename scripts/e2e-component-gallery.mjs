import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const base = process.env.FASTWRITE_E2E_URL ?? 'http://127.0.0.1:3218';
// Resolved from this file rather than the cwd: the npm script runs with the
// workspace directory as cwd, where axe-core is not installed (it is hoisted
// to the repo root).
const axePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'axe-core', 'axe.min.js');
const axeSource = readFileSync(axePath, 'utf8');
const browser = await chromium.launch({ channel: process.env.FASTWRITE_E2E_CHANNEL ?? 'chrome', headless: true });
// `serviceWorkers: 'block'`: once the app's service worker is controlling the
// page it performs the fetches itself, and those requests bypass Playwright's
// routing, so the same-origin axe injection below could never be intercepted
// and the server's SPA fallback would hand back text/html.
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.stack));

const cases = [];
try {
  await page.goto(`${base}/components`);
  await page.getByRole('heading', { name: 'FastWrite UI' }).waitFor();

  /*
   * All four Button variants must render the same metrics. vscrui styles
   * primary/secondary at runtime under compound selectors, which outrank the
   * module's single classes, so anything NOT owned by vscrui (ghost, danger) has
   * to copy those numbers — this is what stops them drifting apart again.
   */
  const buttonMetrics = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('section button')];
    const pick = (text) => buttons.find((button) => button.textContent.trim() === text);
    const read = (element) => {
      const style = getComputedStyle(element);
      const wasDisabled = element.disabled;
      element.disabled = true;
      const disabledOpacity = getComputedStyle(element).opacity;
      element.disabled = wasDisabled;
      return { radius: style.borderRadius, padding: style.padding, fontSize: style.fontSize, disabledOpacity };
    };
    const seed = {
      primary: pick('Primary'),
      secondary: pick('Secondary'),
      ghost: pick('Ghost'),
      danger: pick('Destructive')
    };
    return Object.fromEntries(Object.entries(seed).map(([name, element]) => [name, read(element)]));
  });
  for (const name of ['secondary', 'ghost', 'danger']) {
    assert.deepEqual(buttonMetrics[name], buttonMetrics.primary, `${name} must render primary's metrics, got ${JSON.stringify(buttonMetrics[name])}`);
  }
  cases.push('all Button variants render the same metrics');

  // The combobox exposes its expanded state and its active option.
  const project = page.getByRole('combobox', { name: 'Project', exact: true });
  await project.waitFor();
  assert.equal(await project.getAttribute('aria-expanded'), 'false', 'starts collapsed');
  await project.click();
  assert.equal(await project.getAttribute('aria-expanded'), 'true', 'expands on click');
  assert.ok(await project.getAttribute('aria-activedescendant'), 'exposes an active option');
  cases.push('combobox expands and exposes aria-activedescendant');

  // Arrow keys move the active option; Enter commits it.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.equal(await project.textContent().then(text => text.trim()), 'Beta', 'arrow+enter selects Beta');
  cases.push('arrow keys and Enter select');

  // Escape closes without changing the value.
  await project.click();
  await page.keyboard.press('Escape');
  assert.equal(await project.getAttribute('aria-expanded'), 'false', 'escape closes');
  assert.equal(await project.textContent().then(text => text.trim()), 'Beta', 'escape keeps value');
  cases.push('escape closes without committing');

  // Typeahead jumps to a matching option.
  await project.click();
  await page.keyboard.press('g');
  const active = await page.evaluate(() => document.activeElement?.getAttribute('aria-activedescendant'));
  const activeText = await page.locator(`#${active}`).textContent();
  assert.equal(activeText?.trim(), 'Gamma', 'typeahead jumps to Gamma');
  await page.keyboard.press('Escape');
  cases.push('typeahead jumps by first letter');

  /*
   * A disabled option must look dead and stay dead. The styling rule used to be
   * `:disabled`, which matches form controls only — an option is a <div>, so the
   * rule never matched: full opacity, clickable-looking, click silently ignored.
   */
  await project.click();
  const disabledOption = page.getByRole('option', { name: 'Archived (read-only)' });
  await disabledOption.waitFor();
  assert.equal(await disabledOption.getAttribute('aria-disabled'), 'true', 'disabled option exposes aria-disabled');
  assert.equal(await disabledOption.evaluate((el) => getComputedStyle(el).opacity), '0.4', 'disabled option is visibly dimmed');
  await disabledOption.click({ force: true });
  assert.equal(await project.getAttribute('aria-expanded'), 'true', 'clicking a disabled option leaves the list open');
  assert.equal(await project.textContent().then((text) => text.trim()), 'Beta', 'clicking a disabled option commits nothing');
  // Clicking a <div> option moves focus off the trigger, so close by pointer.
  await project.click();
  assert.equal(await project.getAttribute('aria-expanded'), 'false', 'the list can still be dismissed');
  cases.push('disabled options are dimmed and cannot be committed');

  // Grouped options render as labelled groups.
  const venue = page.getByRole('combobox', { name: 'Publication target', exact: true });
  await venue.click();
  const groups = page.getByRole('group');
  assert.ok(await groups.count() >= 2, 'optgroup equivalents render as role=group');
  await page.keyboard.press('Escape');
  cases.push('option groups expose role=group');

  /*
   * The editable-combobox path (>10 options gains a filter field). The whole
   * point is that the element holding focus is the combobox — the trigger is a
   * plain button while the list is open, and the input carries the role and the
   * active option. Asserting on the focused element, not on a stored locator,
   * is what makes this test able to fail if the role moves back.
   */
  const longList = page.getByRole('combobox', { name: 'Long list', exact: true });
  await longList.waitFor();
  assert.equal(await longList.getAttribute('aria-expanded'), 'false', 'long list starts collapsed');
  await longList.click();
  const openState = await page.evaluate(() => {
    const active = document.activeElement;
    return {
      tag: active?.tagName,
      role: active?.getAttribute('role'),
      expanded: active?.getAttribute('aria-expanded'),
      haspopup: active?.getAttribute('aria-haspopup'),
      controls: active?.getAttribute('aria-controls'),
      activeDescendant: active?.getAttribute('aria-activedescendant')
    };
  });
  assert.equal(openState.tag, 'INPUT', 'the filter field takes focus on open');
  assert.equal(openState.role, 'combobox', 'the filter field is the combobox');
  assert.equal(openState.expanded, 'true', 'the focused combobox reports expanded');
  assert.equal(openState.haspopup, 'listbox', 'the focused combobox has a listbox popup');
  assert.ok(openState.controls, 'the focused combobox controls the listbox');
  const controlled = await page.locator(`#${openState.controls}`).getAttribute('role');
  assert.equal(controlled, 'listbox', 'aria-controls resolves to the listbox');
  assert.ok(openState.activeDescendant, 'the focused combobox exposes an active option');
  cases.push('filter field is the focused combobox and owns aria-activedescendant');

  // Arrow keys move the active option on the focused element.
  const firstActive = openState.activeDescendant;
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const movedTo = await page.evaluate(() => {
    const active = document.activeElement;
    const id = active?.getAttribute('aria-activedescendant');
    return { id, text: id ? document.getElementById(id)?.textContent?.trim() : null };
  });
  assert.notEqual(movedTo.id, firstActive, 'arrow keys move the active option');
  assert.equal(movedTo.text, 'Chicago', 'two ArrowDowns land on the third option');
  cases.push('arrow keys move the active option on the focused combobox');

  /*
   * Home/End belong to the caret once the input is the combobox: the APG
   * editable-combobox pattern leaves caret movement to the textbox, so Home must
   * not be consumed as "jump to the first option".
   */
  await page.keyboard.type('berlin');
  await page.keyboard.press('Home');
  const afterHome = await page.evaluate(() => {
    const active = document.activeElement;
    return { value: active?.value, selectionStart: active?.selectionStart };
  });
  assert.equal(afterHome.value, 'berlin', 'typing filters the list');
  assert.equal(afterHome.selectionStart, 0, 'Home moves the caret rather than jumping the list');
  cases.push('typing filters and Home moves the caret, not the highlight');

  // Enter commits the filtered option and hands focus back to the trigger.
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  assert.equal(await longList.textContent().then((text) => text.trim()), 'Berlin', 'Enter commits the filtered option');
  assert.equal(await longList.getAttribute('aria-expanded'), 'false', 'committing closes the list');
  const focusAfterCommit = await page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    role: document.activeElement?.getAttribute('role')
  }));
  assert.equal(focusAfterCommit.tag, 'BUTTON', 'focus returns to the trigger after committing');
  assert.equal(focusAfterCommit.role, 'combobox', 'the trigger is the combobox again once closed');
  cases.push('Enter commits the filter result and restores focus to the trigger');

  // Escape from the filter field also restores focus to the trigger.
  await longList.click();
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'BUTTON', 'escape restores focus to the trigger');
  cases.push('escape from the filter field restores focus');

  /*
   * Every field primitive must render an invalid border, not just the ones the
   * migration happened to wire first. The three expected here are TextField,
   * NumberField and FileField, each driven by Field's `invalid` render prop.
   */
  const invalidBorders = await page.evaluate(() => {
    const red = (el) => getComputedStyle(el).borderTopColor;
    const text = [...document.querySelectorAll('input[type="text"][aria-invalid="true"], textarea[aria-invalid="true"]')];
    const number = document.querySelector('input[type="number"][aria-invalid="true"]');
    const file = document.querySelector('input[type="file"][aria-invalid="true"]');
    return {
      text: text.map(red),
      number: number ? red(number) : null,
      file: file ? red(file) : null
    };
  });
  assert.ok(invalidBorders.text.length >= 1, 'the invalid TextField is present');
  assert.equal(invalidBorders.number, 'rgb(201, 54, 54)', 'an invalid NumberField draws the error border');
  assert.equal(invalidBorders.file, 'rgb(201, 54, 54)', 'an invalid FileField draws the error border');
  for (const color of invalidBorders.text) {
    assert.equal(color, 'rgb(201, 54, 54)', 'an invalid TextField draws the same error border');
  }
  cases.push('invalid fields share one border treatment');

  // The multi-select is a checkbox group, not a dropdown.
  const skills = page.getByRole('group', { name: 'Task Skills' });
  await skills.getByRole('checkbox', { name: /continue/ }).check();
  assert.ok(await skills.getByRole('checkbox', { name: /continue/ }).isChecked(), 'checkbox list toggles');
  cases.push('multi-select toggles by checkbox');

  /*
   * Field keeps the hint out of the control's accessible name: the name is
   * exactly the label text, and the hint is only a description. An exact match
   * here fails if the hint leaks back into the label.
   */
  assert.equal(
    await page.getByRole('textbox', { name: 'Project name', exact: true }).count(),
    1,
    'the hint does not join the accessible name'
  );
  cases.push('Field keeps the hint out of the accessible name');

  /*
   * The two controls that used to be unable to carry a Field error — a checkbox
   * and a role=group — now take both attributes, and on the group it lands on
   * the group element rather than on each checkbox.
   */
  const described = await page.evaluate(() => {
    const checkbox = [...document.querySelectorAll('input[type="checkbox"]')].find((el) => el.getAttribute('aria-describedby'));
    const group = document.querySelector('[role="group"][aria-describedby]');
    const groupCheckbox = group ? group.querySelector('input[type="checkbox"]') : null;
    return {
      checkboxDescribedBy: checkbox?.getAttribute('aria-describedby') ?? null,
      checkboxInvalid: checkbox?.getAttribute('aria-invalid') ?? null,
      checkboxDescription: checkbox ? document.getElementById(checkbox.getAttribute('aria-describedby'))?.textContent ?? null : null,
      groupDescribedBy: group?.getAttribute('aria-describedby') ?? null,
      groupDescription: group ? document.getElementById(group.getAttribute('aria-describedby'))?.textContent ?? null : null,
      groupCheckboxDescribedBy: groupCheckbox?.getAttribute('aria-describedby') ?? null
    };
  });
  assert.ok(described.checkboxDescribedBy, 'a checkbox carries aria-describedby from Field');
  assert.equal(described.checkboxInvalid, 'true', 'and aria-invalid while its Field has an error');
  assert.equal(described.checkboxDescription, 'Accept the venue rules before compiling.', 'pointing at the Field error');
  assert.ok(described.groupDescribedBy, 'the MultiSelect group carries aria-describedby from Field');
  assert.equal(described.groupDescription, 'Applies to the next skill run.', 'pointing at the Field hint');
  assert.equal(described.groupCheckboxDescribedBy, null, 'the description stays on the group, not on each checkbox');
  cases.push('Field error and description reach a checkbox and a group');

  // Alerts are announced.
  await page.getByRole('alert').first().waitFor();
  cases.push('alerts carry role=alert');

  /*
   * Tooltips must not cover the control they describe. The transform used to be
   * chosen from the numeric `top` (`top < 100 ? 0 : -100%`), so a side="bottom"
   * tooltip anywhere below y=100 was shifted up by its own height and landed on
   * its trigger.
   */
  await page.getByRole('button', { name: 'Hover or focus me' }).hover();
  await page.getByRole('tooltip').waitFor();
  const bottomTooltip = await page.evaluate(() => {
    const tooltip = document.querySelector('[role="tooltip"]').getBoundingClientRect();
    const anchor = [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Hover or focus me')).getBoundingClientRect();
    return { tooltipTop: tooltip.top, tooltipBottom: tooltip.bottom, tooltipLeft: tooltip.left, tooltipRight: tooltip.right, anchorTop: anchor.top, anchorBottom: anchor.bottom };
  });
  assert.ok(bottomTooltip.tooltipTop >= bottomTooltip.anchorBottom, `a bottom tooltip must clear its trigger: ${JSON.stringify(bottomTooltip)}`);
  assert.ok(bottomTooltip.tooltipLeft >= 0 && bottomTooltip.tooltipRight <= 1280, 'the tooltip stays inside the viewport horizontally');
  await page.mouse.move(0, 0);
  await page.getByRole('tooltip').waitFor({ state: 'detached' });
  cases.push('tooltips never cover their trigger');

  // Progress bars are named and valued.
  const bar = page.getByRole('progressbar', { name: 'Loading TeX bundles' });
  assert.equal(await bar.getAttribute('aria-valuenow'), '68', 'determinate bar reports value');
  cases.push('progress bar exposes aria-valuenow');

  // Disclosure is a native details element: open state is the platform's.
  // Located by its summary text rather than a role — the enclosing <section>
  // has no group role, so there is no accessible name to query by.
  await page.getByText('Pass coverage · 3 providers').click();
  assert.ok(await page.locator('details[open]').count() >= 1, 'disclosure opens');
  cases.push('disclosure toggles');

  // Segmented controls keep button semantics with aria-pressed.
  const outline = page.getByRole('group', { name: 'Outline source' });
  await outline.getByRole('button', { name: 'Project structure' }).click();
  assert.equal(await outline.getByRole('button', { name: 'Project structure' }).getAttribute('aria-pressed'), 'true', 'pressed state follows the click');
  cases.push('segmented control toggles aria-pressed');

  // The list renders real list semantics.
  assert.ok(await page.getByRole('list', { name: 'Current changed files' }).count() === 1, 'list is labelled');
  cases.push('list exposes an accessible name');

  // The status bar keeps the stable hook the workbench assertions depend on.
  await page.locator('.workbench-status').waitFor();
  cases.push('status bar keeps the workbench-status hook');

  // Accessibility gate over the whole catalogue.
  //
  // The server sends `default-src 'self'` with no script-src allowance, so
  // addScriptTag with inline content is refused by the page's own CSP. Serve
  // axe from the same origin instead and inject it as a <script src>, which
  // the policy permits.
  await page.route(/axe\.min\.js/, route => route.fulfill({ contentType: 'application/javascript', body: axeSource }));
  await page.addScriptTag({ url: '/axe.min.js' });
  const violations = await page.evaluate(async () => {
    const result = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } });
    return result.violations
      .filter(item => item.impact === 'critical' || item.impact === 'serious')
      .map(item => `${item.id}: ${item.nodes.map(node => node.target.join(' ')).join(', ')}`);
  });
  assert.deepEqual(violations, [], `axe violations:\n${violations.join('\n')}`);
  cases.push('axe wcag2a/2aa/21aa clean');

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'pass', cases }));
} finally {
  await browser.close();
}
