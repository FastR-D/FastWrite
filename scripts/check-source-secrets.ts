import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// This is a narrow source-pattern check, not a comprehensive secret scanner.
// Private-key labels: https://www.rfc-editor.org/rfc/rfc7468#section-10
// Token formats: https://github.com/gitleaks/gitleaks/blob/master/cmd/generate/config/rules/github.go
const rules = [
  { name: "private-key", pattern: /-----BEGIN (?:(?:RSA|DSA|EC|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----/ },
  { name: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82})\b/ },
];

function fail(file: string, rule: string): never {
  console.error(`${JSON.stringify(file)}:0: ${rule}`);
  process.exit(1);
}

function check(): number {
  const root = process.cwd();
  const listing = Bun.spawnSync(["git", "ls-files", "--stage", "-z"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (listing.exitCode !== 0) fail("source-secret-check", "git-enumeration-failed");
  let findings = 0;
  for (const entry of listing.stdout.toString().split("\0").filter(Boolean)) {
    const separator = entry.indexOf("\t");
    if (separator < 0) fail("source-secret-check", "invalid-git-entry");
    const mode = entry.slice(0, 6);
    // Git symlinks and submodules are not source files in this checkout.
    if (mode === "120000" || mode === "160000") continue;
    if (mode !== "100644" && mode !== "100755") fail("source-secret-check", "invalid-git-entry");
    const file = entry.slice(separator + 1);
    const path = resolve(root, file);
    const within = relative(root, path);
    if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) fail(file, "outside-repository");
    let contents: Buffer;
    try {
      let current = root;
      // Do not read through a tracked path replaced by a filesystem symlink.
      for (const part of within.split(sep)) {
        current = join(current, part);
        if (lstatSync(current).isSymbolicLink()) fail(file, "symlink-path");
      }
      contents = readFileSync(path);
    } catch {
      fail(file, "file-read-failed");
    }
    // NUL-containing files are outside this text-only check.
    if (contents.includes(0)) continue;
    for (const [index, line] of contents.toString("utf8").split(/\r?\n/).entries()) {
      for (const rule of rules) {
        if (!rule.pattern.test(line)) continue;
        console.error(`${JSON.stringify(file)}:${index + 1}: ${rule.name}`);
        findings++;
      }
    }
  }
  return findings ? 1 : 0;
}

try {
  process.exitCode = check();
} catch {
  fail("source-secret-check", "check-failed");
}
