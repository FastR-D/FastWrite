import { describe, expect, test } from "bun:test";
import { parseWorkingStatus } from "./working-status";

describe("parseWorkingStatus", () => {
  test("reads HEAD from the branch header", () => {
    const output = "# branch.oid 57cd66bd857b5509620fcc4892e4dc83ed91414a\0# branch.head master\0";
    expect(parseWorkingStatus(output).head).toBe("57cd66bd857b5509620fcc4892e4dc83ed91414a");
  });

  test("reports no HEAD in a repository with no commits", () => {
    const output = "# branch.oid (initial)\0# branch.head master\0? main.tex\0";
    expect(parseWorkingStatus(output).head).toBeNull();
  });

  test("splits an ordinary record into staged and unstaged", () => {
    // `1 XY sub mH mI mW hH hI path` — path is field 8.
    const staged = "# branch.oid abc\0" + "1 M. N... 100644 100644 100644 aaa bbb sections/m.tex\0";
    expect(parseWorkingStatus(staged).files[0]).toEqual({
      path: "sections/m.tex", staged: "M", unstaged: null, untracked: false, conflicted: false
    });

    const unstaged = "# branch.oid abc\0" + "1 .M N... 100644 100644 100644 aaa bbb main.tex\0";
    expect(parseWorkingStatus(unstaged).files[0]).toEqual({
      path: "main.tex", staged: null, unstaged: "M", untracked: false, conflicted: false
    });
  });

  test("carries both sides of a file that is staged and then edited again", () => {
    const output = "# branch.oid abc\0" + "1 MM N... 100644 100644 100644 aaa bbb main.tex\0";
    const file = parseWorkingStatus(output).files[0]!;
    expect(file.staged).toBe("M");
    expect(file.unstaged).toBe("M");
  });

  test("takes a rename's old path from the following token", () => {
    // `2 XY sub mH mI mW hH hI Xscore path` — path is field 9, and the old path
    // is a separate NUL-separated token, not another field.
    const output = "# branch.oid abc\0" +
      "2 R. N... 100644 100644 100644 f2ad6c7 f2ad6c7 R100 sections/methods.tex\0sections/m.tex\0";
    expect(parseWorkingStatus(output).files[0]).toEqual({
      path: "sections/methods.tex", oldPath: "sections/m.tex",
      staged: "R", unstaged: null, untracked: false, conflicted: false
    });
  });

  test("does not re-read a rename's old path as a record of its own", () => {
    /*
     * The old path is a bare token, so if it were not skipped it would be parsed
     * as a record by its first character. `sections/m.tex` starts with `s` and
     * falls through harmlessly, which is why the case above cannot catch this —
     * a rename from `untitled-old.tex` can, because `u` opens an unmerged
     * record. Real captured output: without the skip this yields two files, the
     * second the bogus `{ path: "", conflicted: true }`.
     *
     * Also asserts the length, so a stray extra entry fails rather than being
     * ignored by a `files[0]` comparison.
     */
    const output = "# branch.oid 2bcc47fd87a989892c97fd9547ced01b172c4ee7\0# branch.head master\0" +
      "2 R. N... 100644 100644 100644 d95f3ad14dee633a758d2e331151e950dd13e4ed d95f3ad14dee633a758d2e331151e950dd13e4ed R100 renamed.tex\0untitled-old.tex\0";
    const status = parseWorkingStatus(output);
    expect(status.files).toHaveLength(1);
    expect(status.files[0]).toEqual({
      path: "renamed.tex", oldPath: "untitled-old.tex",
      staged: "R", unstaged: null, untracked: false, conflicted: false
    });
  });

  test("keeps paths containing spaces and non-ASCII characters", () => {
    const output = "# branch.oid abc\0" + "1 .M N... 100644 100644 100644 aaa bbb 中文 name [1] : old.tex\0";
    expect(parseWorkingStatus(output).files[0]!.path).toBe("中文 name [1] : old.tex");
  });

  test("marks untracked files without inventing a status", () => {
    const output = "# branch.oid abc\0" + "? refs.bib\0";
    expect(parseWorkingStatus(output).files[0]).toEqual({
      path: "refs.bib", staged: null, unstaged: null, untracked: true, conflicted: false
    });
  });

  test("marks unmerged files as conflicted rather than modified", () => {
    // `u XY sub m1 m2 m3 mW h1 h2 h3 path` — path is field 10.
    const output = "# branch.oid abc\0" +
      "u UU N... 100644 100644 100644 100644 df967b9 ba2906d e45c9c2 f.txt\0";
    expect(parseWorkingStatus(output).files[0]).toEqual({
      path: "f.txt", staged: null, unstaged: null, untracked: false, conflicted: true
    });
  });

  test("ignores ignored entries and unknown lines", () => {
    const output = "# branch.oid abc\0! build/out.log\0# branch.ab +1 -0\0? real.txt\0";
    expect(parseWorkingStatus(output).files.map((file) => file.path)).toEqual(["real.txt"]);
  });

  test("reads a realistic multi-record status", () => {
    const output = [
      "# branch.oid 57cd66bd857b5509620fcc4892e4dc83ed91414a", "# branch.head master", "# branch.ab +1 -0",
      "1 .M N... 100644 100644 100644 7898192 7898192 main.tex",
      "1 M. N... 100644 100644 100644 6178079 f2ad6c7 sections/m.tex",
      "? refs.bib",
      "1 .D N... 100644 100644 000000 c1827f0 c1827f0 removed.tex",
      ""
    ].join("\0");
    const status = parseWorkingStatus(output);
    expect(status.head).toBe("57cd66bd857b5509620fcc4892e4dc83ed91414a");
    expect(status.files.map((file) => [file.path, file.staged, file.unstaged, file.untracked])).toEqual([
      ["main.tex", null, "M", false],
      ["sections/m.tex", "M", null, false],
      ["refs.bib", null, null, true],
      ["removed.tex", null, "D", false]
    ]);
  });
});
