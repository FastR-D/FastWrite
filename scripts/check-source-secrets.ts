import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

// Match the tracked-source policy used by security-check.sh without printing
// matching values. User data and ignored local configuration are never scanned.
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".toml", ".yaml", ".yml", ".sh", ".ps1", ".env", ".html", ".css", ".conf"]);
const secretPattern = /(OPENAI_API_KEY|FASTWRITE_\w*SECRET|AWS_SECRET_ACCESS_KEY)\s*=\s*[A-Za-z0-9_./+=-]{8,}|-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----/;
const placeholderPattern = /process\.env|\.env\.example|placeholder|example|YOUR_|\.\.\./;
const root = resolve(import.meta.dir, "..");
const child = Bun.spawn(["git", "ls-files", "-z"], { cwd: root, stdout: "pipe", stderr: "pipe" });
const [output, error, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
if (exitCode !== 0) throw new Error(`Unable to list tracked source files: ${error}`);
const findings: string[] = [];
for (const path of output.split("\0").filter(Boolean)) {
  if (path.startsWith("docs/") || path.endsWith(".test.ts") || path.endsWith(".test.tsx") || path.endsWith(".env.example") || !sourceExtensions.has(extname(path))) continue;
  const content = await readFile(resolve(root, path), "utf8");
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (secretPattern.test(line) && !placeholderPattern.test(line)) findings.push(`${path}:${index + 1}`);
  }
}
if (findings.length) {
  console.error(`Potential tracked secrets at:\n${findings.join("\n")}`);
  process.exitCode = 1;
} else console.log("Tracked source secret check passed");
