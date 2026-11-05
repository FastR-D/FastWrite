import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

const scanner = join(import.meta.dir, "check-source-secrets.ts");
const fixtures: string[] = [];
const fakeToken = "gh" + "p_" + "A1b2".repeat(9);

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error("fixture git command failed");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "fastwrite-secret-check-"));
  fixtures.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "--quiet");
  return { root, repo };
}

function scan(cwd: string) {
  const result = Bun.spawnSync([process.execPath, scanner], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    const actual = realpathSync(root);
    if (!actual.startsWith(realpathSync(tmpdir()) + sep)) throw new Error("fixture cleanup outside temporary directory");
    rmSync(actual, { recursive: true, force: true });
  }
});

test("reports private key and GitHub token formats without printing their values", () => {
  const { repo } = fixture();
  const cases: Array<[string, string]> = [
    ...["", "RSA ", "DSA ", "EC ", "OPENSSH ", "ENCRYPTED "].map((kind): [string, string] => ["-----BEGIN " + kind + "PRIVATE KEY" + "-----", "private-key"]),
    [fakeToken, "github-token"],
    [["github", "pat", "A1".repeat(41)].join("_"), "github-token"],
  ];
  for (const [value, rule] of cases) {
    writeFileSync(join(repo, "source with spaces.ts"), `// fixture\n${value}\n`);
    git(repo, "add", "--", "source with spaces.ts");
    const result = scan(repo);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(`"source with spaces.ts":2: ${rule}`);
    expect(result.stderr).not.toContain(value);
  }
});

test("accepts environment references and short placeholders", () => {
  const { repo } = fixture();
  writeFileSync(join(repo, "config.ts"), 'const key = process.env.GITHUB_TOKEN;\nconst example = "ghp_replace_me";\n');
  git(repo, "add", ".");
  expect(scan(repo)).toEqual({ code: 0, stdout: "", stderr: "" });
});

test("does not scan untracked files or NUL-containing binary files", () => {
  const { repo } = fixture();
  writeFileSync(join(repo, "asset.bin"), Buffer.from(`\0${fakeToken}`));
  git(repo, "add", ".");
  writeFileSync(join(repo, "untracked.txt"), fakeToken);
  expect(scan(repo)).toEqual({ code: 0, stdout: "", stderr: "" });
});

test("does not follow a tracked path replaced with an outside directory symlink", () => {
  const { root, repo } = fixture();
  const outside = join(root, "outside");
  const nested = join(repo, "nested");
  mkdirSync(outside);
  mkdirSync(nested);
  writeFileSync(join(outside, "config.ts"), fakeToken);
  writeFileSync(join(nested, "config.ts"), "// tracked file");
  git(repo, "add", ".");
  unlinkSync(join(nested, "config.ts"));
  rmdirSync(nested);
  symlinkSync(outside, nested, process.platform === "win32" ? "junction" : "dir");
  const result = scan(repo);
  expect(result.code).toBe(1);
  expect(result.stderr.trim()).toBe('"nested/config.ts":0: symlink-path');
  expect(result.stderr).not.toContain(fakeToken);
  expect(readFileSync(join(outside, "config.ts"), "utf8")).toBe(fakeToken);
});

test("fails closed when Git enumeration or reading a tracked file fails", () => {
  const { root, repo } = fixture();
  const noGit = scan(root);
  expect(noGit.code).toBe(1);
  expect(noGit.stderr.trim()).toBe('"source-secret-check":0: git-enumeration-failed');
  writeFileSync(join(repo, "deleted.ts"), "// tracked file");
  git(repo, "add", ".");
  unlinkSync(join(repo, "deleted.ts"));
  const deleted = scan(repo);
  expect(deleted.code).toBe(1);
  expect(deleted.stderr.trim()).toBe('"deleted.ts":0: file-read-failed');
});
