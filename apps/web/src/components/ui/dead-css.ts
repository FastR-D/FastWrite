// apps/web/src/components/ui/dead-css.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE_ROOT = join(import.meta.dir, "..", "..");
const STYLESHEET = join(SOURCE_ROOT, "styles.css");

/*
 * Classes that exist at runtime but that no source file can produce as a
 * literal, because a third-party library generates them.
 *
 * Without this list the detector reports them as orphaned, which makes "no
 * orphans" unreachable while the rules above them are deliberately kept — and a
 * check that cannot pass is a check nobody runs. Each entry is a claim that the
 * class is live; verify before adding one.
 */
const RUNTIME_GENERATED = new Set([
  // Monaco. The host class is ours; these are Monaco's own, targeted through
  // the host to reach the editor it mounts.
  "monaco-editor",
  "overflow-guard",
  "margin",
  // Monaco decorations, applied through its API as `options.className` rather
  // than as a JSX attribute, so no `className=` in our source names them.
  "fastwrite-monaco-selection",
  "fastwrite-monaco-completion",
  "fastwrite-remote-line",
  "fastwrite-remote-label",
  "fastwrite-remote-cursor",
  // vscrui's own Button renders this, and one of our rules uses it inside
  // `:not()` to exempt vscrui buttons from the app's styling.
  "vscrui-button",
  // react-pdf renders these inside `.pdf-canvas`.
  "react-pdf__Document",
  "react-pdf__Page__canvas"
]);

/**
 * Every `.tsx`/`.ts` under apps/web/src, recursively.
 *
 * Test files are skipped. They are not bundled, so they cannot produce a class
 * name at runtime — and counting them is actively harmful: the guard test that
 * uses this module names the classes it asserts on, so a test file that
 * mentioned a dead class would spare exactly that class. The guard would
 * quietly disable itself, one asserted name at a time.
 */
function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

/**
 * Class names the source can produce, and the prefixes it builds dynamically.
 *
 * Both halves are needed. A name that is only ever written as `is-${status}`
 * never appears as a literal, and a scan that looks only for literals reports
 * every one of its values as dead — which is how the first pass here decided
 * that the dynamic dialog width modifiers and the status modifiers were unused.
 * They are not; the review dialog's width and the draft diff's height come from
 * those rules.
 *
 * Only `className` is read, not every string in the file. Reading them all
 * produces junk prefixes from prose — a `description` template ending
 * `` `… reviewed file${n}` `` spares every class starting with `file`, so
 * `.file-input` would silently survive the cleanup.
 */
export function producedClassNames(): { literals: Set<string>; prefixes: Set<string> } {
  const literals = new Set<string>();
  const prefixes = new Set<string>();

  const record = (expression: string) => {
    // The static part of a template, so `a b--${x}` yields "a" and "b--".
    for (const token of expression.replace(/\$\{[^}]*\}/g, " ").match(/[a-zA-Z][\w-]*/g) ?? []) {
      literals.add(token);
    }
    for (const dynamic of expression.matchAll(/([\w-]*)\$\{/g)) prefixes.add(dynamic[1]!);
  };

  for (const file of sourceFiles(SOURCE_ROOT)) {
    const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    /*
     * Literals come from every string in the file, not just `className=`.
     * Class lists are routinely assembled into a variable first — Link does
     * `const classes = [cond ? "button button--secondary" : …]` — and a
     * className-scoped scan never sees those. Scanning everything can only
     * spare more classes, never delete a live one, so it is the safe side to
     * err on.
     *
     * Scanned one delimiter at a time, never with a shared `["'`]` class. Mixing
     * them desynchronises: in `? "" : "pdf-canvas--empty"` the empty string
     * closes on the next literal's opening quote, and the class after it is
     * never seen. Three passes cannot drift against each other.
     */
    for (const literalMatch of text.matchAll(/"([^"\n]*)"/g)) literals.add(literalMatch[1]!.trim());
    for (const literalMatch of text.matchAll(/'([^'\n]*)'/g)) literals.add(literalMatch[1]!.trim());
    for (const match of text.matchAll(/className=/g)) {
      const after = match.index! + match[0].length;
      const next = text[after];
      if (next === '"' || next === "'") {
        const end = text.indexOf(next, after + 1);
        if (end < 0) continue;
        for (const token of text.slice(after + 1, end).split(/\s+/)) if (token) literals.add(token);
        continue;
      }
      if (next !== "{") continue;
      /*
       * Scan to the matching brace rather than stopping at the first `}`. A
       * template literal contains its own braces — `` `dialog dialog--${width}` ``
       * — and the naive `\{([^}]*)\}` capture ends inside the interpolation,
       * losing both the `dialog--` prefix and everything after it. That is what
       * made the dynamic modifiers look orphaned again.
       */
      let depth = 0;
      let end = after;
      for (; end < text.length; end++) {
        const ch = text[end];
        if (ch === "{") depth += 1;
        else if (ch === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const expression = text.slice(after + 1, end);
      for (const inner of expression.matchAll(/["'`]([^"'`]*)["'`]/g)) record(inner[1]!);
    }
  }
  // A quoted string can hold a class list; split it into tokens for lookup.
  for (const value of [...literals]) {
    for (const token of value.split(/\s+/)) if (token) literals.add(token);
  }
  return { literals, prefixes };
}

/**
 * Class selectors declared in styles.css, with comments stripped first.
 *
 * Without stripping, a class merely *mentioned* in prose counts as declared —
 * `styles.css` has a comment explaining that a rule outranks `.iconButton`,
 * which made `iconButton` look like a rule to delete.
 */
export function declaredClassNames(): string[] {
  const css = readFileSync(STYLESHEET, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
  return [...new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => match[1]!))];
}

/**
 * Whether a declared class is unreachable from the source.
 *
 * Exported and pure so it can be tested against synthetic input. A test that
 * asserted on the live tree could only ever name classes that currently exist
 * in `styles.css` — and those are exactly the ones a successful cleanup
 * deletes, which would leave the test unable to run.
 */
export function isOrphaned(name: string, produced: { literals: Set<string>; prefixes: Set<string> }): boolean {
  if (produced.literals.has(name)) return false;
  if (RUNTIME_GENERATED.has(name)) return false;
  // A dynamic prefix makes everything under it live, in either direction:
  // `dialog--${width}` covers the wide variant, and a `--${x}` suffix on a
  // shorter name would cover the prefix itself.
  for (const prefix of produced.prefixes) {
    if (prefix && (name.startsWith(prefix) || prefix.startsWith(name))) return false;
  }
  return true;
}

export function orphanedClasses(): string[] {
  const produced = producedClassNames();
  return declaredClassNames().filter((name) => isOrphaned(name, produced));
}
