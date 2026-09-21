import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SOURCE_ROOT = join(import.meta.dir, "..", "..");
const COMPONENT_ROOT = "components/ui";

/*
 * The exemption is for component IMPLEMENTATIONS, not for a directory. The
 * library legitimately renders the raw elements, so these paths need no
 * ALLOWLIST entry — but a file that merely sits under components/ui and is
 * imported as business code is checked like anything else, or un-migrated code
 * could hide behind the exemption indefinitely.
 *
 * Only the barrel and the icon table are left. The pre-migration Button had an
 * entry here too; it was deleted once its call sites had moved to the library,
 * and the entry went with it.
 */
const EXEMPT_FILES = new Set<string>([
  `${COMPONENT_ROOT}/index.ts`,
  `${COMPONENT_ROOT}/icons.ts`
]);
const EXEMPT_DIRECTORIES = ["primitives/", "controls/", "feedback/", "chrome/"].map((directory) => `${COMPONENT_ROOT}/${directory}`);

function isExempt(key: string): boolean {
  return EXEMPT_FILES.has(key) || EXEMPT_DIRECTORIES.some((prefix) => key.startsWith(prefix));
}

/**
 * Controls and structural elements that must come from components/ui.
 * Text-semantics elements (p, h1-h6, strong, em, code, ...) are deliberately
 * absent: they carry document structure, not interaction, and wrapping them
 * produces empty shells. See spec section 5.5.
 */
const FORBIDDEN = [
  "button", "input", "select", "textarea", "label", "fieldset", "legend",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th",
  "ul", "ol", "li", "a", "details", "summary", "hr", "dialog", "progress", "meter"
];
/*
 * Matches the opening of a raw control element anywhere in a file's source.
 *
 * The lookahead is what keeps `<Button>` and `inputMode` from matching while
 * still catching every way a JSX opening tag can begin: whitespace, a
 * self-closing `/>`, or a spread brace. The brace matters — `<input{...rest}>`
 * is idiomatic and has no space after the tag name, so without it the guard
 * would silently pass over the most common way to forward props.
 *
 * The scan runs over the whole file rather than line by line, so a tag broken
 * across lines is still seen.
 */
const FORBIDDEN_PATTERN = new RegExp(`<(?:${FORBIDDEN.join("|")})(?=[\\s/>{}])`);

/**
 * Offsets of every raw control opening tag in `content`. Exported so the
 * matcher itself can be tested: the file scan below only ever asserts "nothing
 * found" on real sources, which cannot tell a working matcher from a broken one.
 */
export function rawControlMatches(content: string): number[] {
  const pattern = new RegExp(FORBIDDEN_PATTERN.source, "g");
  const offsets: number[] = [];
  for (let match = pattern.exec(content); match !== null; match = pattern.exec(content)) offsets.push(match.index);
  return offsets;
}

/**
 * Files exempt from the scan below.
 *
 * This held 36 files and 443 raw controls at the start of the migration, with a
 * per-file count that made it monotone — a file could only improve — and a
 * pinned grand total. Both were the burn-down metric, and both are meaningless
 * over an empty object, so they were replaced by the "stays empty" test rather
 * than left in place asserting nothing.
 *
 * Keep it empty. An entry here is skipped by the scan, so re-adding one would
 * pass every other test in this file.
 */
const ALLOWLIST: Record<string, number> = {};

function tsxFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...tsxFiles(full));
    else if (entry.name.endsWith(".tsx")) found.push(full);
  }
  return found;
}

function violations(): { file: string; line: number; text: string }[] {
  const found: { file: string; line: number; text: string }[] = [];
  for (const absolute of tsxFiles(SOURCE_ROOT)) {
    const key = relative(SOURCE_ROOT, absolute).split(sep).join("/");
    if (isExempt(key)) continue;
    if (key in ALLOWLIST) continue;
    const content = readFileSync(absolute, "utf8");
    const lines = content.split("\n");
    for (const index of rawControlMatches(content)) {
      const line = content.slice(0, index).split("\n").length;
      found.push({ file: key, line, text: (lines[line - 1] ?? "").trim() });
    }
  }
  return found;
}

/*
 * The actionable part of a hit is `file:line`; the rest is context. This
 * codebase has single-line JSX blocks over 1200 characters, and printing them
 * whole buries every other finding in the report.
 */
function reportLine(hit: { file: string; line: number; text: string }): string {
  return `${hit.file}:${hit.line}  ${hit.text.slice(0, 120)}`;
}

describe("raw control guard", () => {
  /*
   * Pins the exemption boundary from both sides. The scans below only ever
   * assert that a real source tree is clean, which a future edit to
   * EXEMPT_DIRECTORIES can quietly make true everywhere — dropping a prefix
   * would surface as a wave of unrelated failures, but widening one would
   * un-exempt nothing and stay green.
   *
   * chrome/ belongs on the exempt side for the same reason as the other three:
   * it holds implementations. TabBar emits role="tab" buttons, Disclosure must
   * render real <details>/<summary>, ListRow emits ul/li.
   */
  test("exempts component implementations, not a directory", () => {
    // Implementations legitimately render raw controls.
    expect(isExempt("components/ui/chrome/TabBar.tsx")).toBe(true);
    expect(isExempt("components/ui/primitives/Button.tsx")).toBe(true);
    expect(isExempt("components/ui/controls/Select.tsx")).toBe(true);
    expect(isExempt("components/ui/feedback/Alert.tsx")).toBe(true);
    // Business code is checked even when it sits under components/ui.
    expect(isExempt("components/ui/PublicationTargetFields.tsx")).toBe(false);
    // A prefix must not over-match.
    expect(isExempt("components/ui/chromex/Foo.tsx")).toBe(false);
    expect(isExempt("components/uix/Foo.tsx")).toBe(false);
  });

  test("no raw controls outside components/ui", () => {
    const found = violations();
    const report = found.map(reportLine).join("\n");
    expect(found, `Raw controls must come from components/ui:\n${report}`).toEqual([]);
  });

  /*
   * The allowlist is empty, and this keeps it that way.
   *
   * It replaced two tests — "contains no stale entries" and "only shrink, and
   * the totals stay exact" — which did real work while the migration was in
   * flight but assert nothing over an empty object: a loop over no entries
   * cannot fail, and a total pinned to 0 is just the first test restated.
   *
   * What remains worth guarding is that an entry cannot quietly come back. A
   * future edit that re-adds one would otherwise pass every other test here,
   * because an allowlisted file is skipped by the scan.
   */
  test("the allowlist stays empty", () => {
    expect(
      Object.keys(ALLOWLIST),
      `Every file in apps/web/src renders controls through components/ui now. ` +
      `Migrate the controls instead of allowlisting ${Object.keys(ALLOWLIST).join(", ")}.`
    ).toEqual([]);
  });

  /*
   * The two tests above only ever assert that nothing was found. On their own
   * that cannot tell a correct matcher from one that matches nothing at all —
   * which is exactly how the multi-line scan and the `{` lookahead both went
   * unnoticed. These fixtures pin the matcher from both sides.
   */
  test("the matcher sees every raw-control opening and nothing else", () => {
    const controls = [
      "<button>",
      "<button >",
      "<button/>",
      '<button\n  className="x"\n>',
      "<input{...rest}>",
      "<select\n  value={v}\n>"
    ];
    const missed = controls.filter((source) => rawControlMatches(source).length === 0);
    expect(missed, `The matcher did not see these raw controls:\n${missed.join("\n")}`).toEqual([]);

    const notControls = ["<p>text</p>", "<Button>", "<div>", "<span>text</span>", "buttoneer"];
    const flagged = notControls.filter((source) => rawControlMatches(source).length > 0);
    expect(flagged, `The matcher flagged these as raw controls:\n${flagged.join("\n")}`).toEqual([]);
  });
});
