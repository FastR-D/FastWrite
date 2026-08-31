import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Project = { id: string; build?: { cwd: string; command: string[]; minimumLatexYear?: number; env?: Record<string, string> } };
const rootIndex = Bun.argv.indexOf("--root"); const root = rootIndex >= 0 ? Bun.argv[rootIndex + 1] : process.env.FASTWRITE_PAPER_EVAL_ROOT;
if (!root) { console.error("Usage: bun scripts/papers-compile.ts --root /path/to/checkouts"); process.exit(2); }
const manifest = JSON.parse(await readFile(new URL("../evaluation/real-papers.json", import.meta.url), "utf8")) as { projects: Project[] };
const latexYear = await detectedLatexYear();
for (const project of manifest.projects) {
  const build = project.build; let result: Record<string, unknown>;
  if (!build) result = { success: "unavailable", reason: "build command not configured" };
  else if (build.minimumLatexYear && (!latexYear || latexYear < build.minimumLatexYear)) result = { success: "unavailable", reason: `requires LaTeX ${build.minimumLatexYear}+, detected ${latexYear ?? "unknown"}` };
  else if (!await commandExists(build.command[0]!)) result = { success: "unavailable", reason: `missing command ${build.command[0]}` };
  else { const projectRoot = join(root, project.id); const extraEnv = Object.fromEntries(Object.entries(build.env ?? {}).map(([key, value]) => [key, value.replaceAll("{projectRoot}", projectRoot)])); const child = Bun.spawn(build.command, { cwd: join(projectRoot, build.cwd), stdout: "pipe", stderr: "pipe", env: { ...process.env, ...extraEnv, SOURCE_DATE_EPOCH: "0" } }); const timer = setTimeout(() => child.kill(), 90_000); const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); clearTimeout(timer); const log = `${stdout}\n${stderr}`.trim(); const unavailableReason = exitCode === 0 ? undefined : toolchainUnavailableReason(log); result = unavailableReason ? { success: "unavailable", reason: unavailableReason, exitCode, command: build.command, logTail: log.split("\n").slice(-30).join("\n") } : { success: exitCode === 0, exitCode, command: build.command, logTail: log.split("\n").slice(-30).join("\n") }; }
  await writeFile(join(root, project.id, "fastwrite-compile.json"), JSON.stringify(result, null, 2)); console.log(`${project.id}: ${String(result.success)}${result.reason ? ` (${result.reason})` : ""}`);
}
async function commandExists(command: string): Promise<boolean> { return Bun.spawn(["sh", "-c", `command -v "$1" >/dev/null`, "sh", command], { stdout: "ignore", stderr: "ignore" }).exited.then((code) => code === 0); }
async function detectedLatexYear(): Promise<number | undefined> { if (!await commandExists("pdflatex")) return undefined; const child = Bun.spawn(["pdflatex", "--version"], { stdout: "pipe", stderr: "ignore" }); const output = await new Response(child.stdout).text(); await child.exited; const year = Number(output.match(/TeX Live (\d{4})/)?.[1]); return Number.isFinite(year) ? year : undefined; }
function toolchainUnavailableReason(log: string): string | undefined { const missingPackage = log.match(/File `([^']+\.(?:sty|cls))' not found/i)?.[1]; if (missingPackage) return `missing TeX dependency ${missingPackage}`; const missingFont = log.match(/font "([^"]+)" cannot be found/i)?.[1]; if (missingFont) return `missing font ${missingFont}`; if (/requires either XeTeX or LuaTeX/i.test(log)) return "configured TeX engine is unavailable"; return undefined; }
