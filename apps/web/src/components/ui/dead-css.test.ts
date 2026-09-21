import { describe, expect, test } from "bun:test";
import { isOrphaned, orphanedClasses, producedClassNames } from "./dead-css";

describe("dead CSS", () => {
  /*
   * The migration moved component styling into CSS modules and left the rules
   * that used to style the raw elements behind. Nothing references them, and
   * nothing will: the guard test keeps raw controls from coming back, so the
   * classes they carried cannot reappear either.
   *
   * This test exists so the file cannot re-accrete. It is the same shape as the
   * raw-control guard: a property of the source that a migration established
   * and that nothing else enforces.
   */
  test("styles.css declares no unreferenced class", () => {
    const orphans = orphanedClasses();
    expect(
      orphans,
      `These classes in styles.css are unreferenced. Delete their rules, or if the ` +
      `name is built dynamically, extend the detector:\n  ${orphans.join("\n  ")}`
    ).toEqual([]);
  });

  /*
   * Pins the two classes of false positive that a literal-only scan produces.
   * Both were real: the first pass here called every one of these dead.
   */
  test("spares classes the source builds dynamically", () => {
    const orphans = orphanedClasses();
    // Emitted as `dialog dialog--${width}` in chrome/Dialog.tsx, and selected by
    // two live consumer rules — the review dialog's width and the draft diff's
    // height. A literal scan sees neither.
    expect(orphans).not.toContain("dialog--wide");
    expect(orphans).not.toContain("dialog--fullscreen");
    // Emitted as `is-${status}` in six files.
    for (const modifier of ["completed", "failed", "current", "error", "running", "pending"]) {
      expect(orphans).not.toContain(`is-${modifier}`);
    }
  });

  /*
   * Pins the extraction itself, because getting it wrong is invisible: a broken
   * scanner reports MORE orphans, which looks like progress rather than a bug.
   *
   * The first version captured `className={([^}]*)}`, which stops at the first
   * `}` — and a template literal's interpolation has one. `dialog--${width}`
   * therefore yielded "dialog--" with nothing after it, the prefix went
   * unrecorded, and every dynamic modifier silently reappeared as dead.
   */
  test("records the prefix that precedes an interpolation", () => {
    const { prefixes, literals } = producedClassNames();
    expect(prefixes.has("dialog--")).toBe(true);
    expect(prefixes.has("is-")).toBe(true);
    // The literal half of the same expression must survive too.
    expect(literals.has("dialog")).toBe(true);
    // And a name reached only through a conditional must still count.
    expect(literals.has("review-dialog")).toBe(true);
  });

  test("still catches classes nothing produces", () => {
    /*
     * Asserted against synthetic input, not the live tree. The classes this
     * test named before the cleanup — tree-row, icon-button and the rest — were
     * deleted along with their rules, so naming them again would assert that a
     * class which no longer exists is still reported. Testing the predicate
     * keeps the check meaningful however styles.css changes.
     *
     * The risk it guards is a detector that spares everything: the dynamic
     * handling above is deliberately generous, and generosity is one step from
     * vacuity.
     */
    const produced = { literals: new Set(["live"]), prefixes: new Set(["dynamic--"]) };
    expect(isOrphaned("orphan", produced)).toBe(true);
    expect(isOrphaned("live", produced)).toBe(false);
    // Under a dynamic prefix, in both directions.
    expect(isOrphaned("dynamic--wide", produced)).toBe(false);
    expect(isOrphaned("dynamic", produced)).toBe(false);
    // Named by a third-party library at runtime.
    expect(isOrphaned("vscrui-button", produced)).toBe(false);
    expect(isOrphaned("monaco-editor", produced)).toBe(false);
  });
});
