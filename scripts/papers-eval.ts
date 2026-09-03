import { access, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { writingGuardMany } from "../apps/server/src/writing/writing-guard";

type Manifest = { projects: Array<{ id: string; domain: string; source: string; revision: string; license: string; mainDocument: string }> };
const rootFlag = Bun.argv.indexOf("--root");
const root = rootFlag >= 0 ? Bun.argv[rootFlag + 1] : process.env.FASTWRITE_PAPER_EVAL_ROOT;
if (!root) { console.error("Usage: bun run papers:eval -- --root /path/to/checkouts"); process.exit(2); }
const manifest = JSON.parse(await readFile(new URL("../evaluation/real-papers.json", import.meta.url), "utf8")) as Manifest;
const results = [];
for (const project of manifest.projects) {
  const directory = join(root, project.id);
  try {
    await access(join(directory, project.mainDocument));
    const paths = (await walk(directory)).filter((path) => /\.(?:tex|bib|md)$/i.test(path));
    const documents = await Promise.all(paths.map(async (path) => ({ path: relative(directory, path), content: await readFile(path, "utf8") })));
    const findings = writingGuardMany(documents);
    const compile = await readOptionalJson(join(directory, "fastwrite-compile.json"));
    results.push({ ...project, status: "evaluated", files: documents.length, sourceBytes: documents.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0), findings: findings.length, blockingFindings: findings.filter((item) => item.status === "blocking").length, compileSuccess: typeof compile?.success === "boolean" ? compile.success : "unavailable", claimRelocationStability: relocationStability(documents) });
  } catch (error) {
    results.push({ ...project, status: "unavailable", error: error instanceof Error ? error.message : "Could not read checkout" });
  }
}
const evaluated = results.filter((item) => item.status === "evaluated");
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), corpusSize: manifest.projects.length, evaluated: evaluated.length, compileSuccessRate: rate(evaluated.filter((item) => item.compileSuccess !== "unavailable"), (item) => item.compileSuccess === true), meanClaimRelocationStability: evaluated.length ? evaluated.reduce((sum, item) => sum + Number(item.claimRelocationStability), 0) / evaluated.length : null, projects: results }, null, 2));

async function walk(directory: string): Promise<string[]> { const entries = await readdir(directory, { withFileTypes: true }); const nested = await Promise.all(entries.filter((entry) => ![".git", "node_modules", "build", "dist"].includes(entry.name)).map((entry) => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)])); return nested.flat(); }
async function readOptionalJson(path: string): Promise<any> { try { return JSON.parse(await readFile(path, "utf8")); } catch { return undefined; } }
function relocationStability(documents: Array<{ content: string }>): number { const anchors = documents.flatMap((document) => [...document.content.matchAll(/[^.!?\n]{20,240}[.!?]/g)].map((match) => match[0].trim())).slice(0, 500); if (!anchors.length) return 1; const stable = anchors.filter((anchor) => documents.filter((document) => document.content.includes(anchor)).length === 1).length; return stable / anchors.length; }
function rate<T>(items: T[], predicate: (item: T) => boolean): number | null { return items.length ? items.filter(predicate).length / items.length : null; }
