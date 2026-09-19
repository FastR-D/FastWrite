import type { ChangeStatus, WorkingFile, WorkingStatus } from "@fastwrite/shared";

/**
 * Maps one porcelain letter to a change status, or null for "unchanged".
 *
 * `C` (copied) collapses onto `A`: the sidebar has no distinct marker for a
 * copy, and a user reading the list cares that a file is new, not which
 * detection heuristic produced it. It only appears when copy detection is on,
 * which the default `git status` does not enable.
 */
function statusLetter(letter: string | undefined): ChangeStatus | null {
  switch (letter) {
    case "A": case "M": case "D": case "R": case "T": return letter;
    case "C": return "A";
    default: return null;
  }
}

/** The last field of a `1`/`2`/`u` record, which never contains a space. */
function pathOf(fields: string[], index: number): string {
  return fields.slice(index).join(" ");
}

/**
 * Parses `git status --porcelain=v2 --branch -z`.
 *
 * The `-z` form is mandatory rather than a preference: it is the only one that
 * leaves paths containing spaces, quotes or non-ASCII bytes intact, and this
 * codebase has real test fixtures with `中文 name [1] : old.tex`.
 *
 * Field offsets differ per record type and are read from the constant tables
 * below rather than counted inline, because an off-by-one here does not throw —
 * it silently truncates or drops a path.
 */
const PATH_FIELD: Record<string, number> = { "1": 8, "2": 9, u: 10 };

export function parseWorkingStatus(output: string): WorkingStatus {
  // A record's fields are space-separated, records are NUL-separated.
  const records = output.split("\0");
  let head: string | null = null;
  const files: WorkingFile[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;

    if (record.startsWith("# branch.oid ")) {
      const value = record.slice("# branch.oid ".length);
      head = value === "(initial)" ? null : value;
      continue;
    }
    // Other headers (# branch.head, # branch.ab) and ignored entries carry no
    // file the sidebar shows.
    if (record.startsWith("#")) continue;
    if (record.startsWith("! ")) continue;

    const kind = record[0]!;
    if (kind === "?") {
      files.push({ path: record.slice(2), staged: null, unstaged: null, untracked: true, conflicted: false });
      continue;
    }
    if (kind === "u") {
      files.push({
        path: pathOf(record.split(" "), PATH_FIELD.u!),
        staged: null, unstaged: null, untracked: false, conflicted: true
      });
      continue;
    }
    if (kind === "1" || kind === "2") {
      const fields = record.split(" ");
      const xy = fields[1] ?? "..";
      const file: WorkingFile = {
        path: pathOf(fields, PATH_FIELD[kind]!),
        staged: statusLetter(xy[0]),
        unstaged: statusLetter(xy[1]),
        untracked: false,
        conflicted: false
      };
      // A rename's old path is the NEXT record, not a field of this one.
      if (kind === "2") {
        const oldPath = records[index + 1];
        if (oldPath) { file.oldPath = oldPath; index += 1; }
      }
      files.push(file);
      continue;
    }
  }

  return { head, files };
}
