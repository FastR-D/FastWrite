import { cp, mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const output = resolve(projectRoot, "app-bin");
const sourceEnvironment = join(projectRoot, ".env");
const releaseEnvironment = join(output, ".env");
const releaseData = join(output, "paperdata");
const legacyData = join(output, ".fastwrite-data");
const webDirectory = join(projectRoot, "apps", "web", "dist");
const standaloneEntry = join(projectRoot, "scripts", ".standalone-entry.ts");

if (basename(output) !== "app-bin" || !output.startsWith(`${projectRoot}/`)) throw new Error("Refusing to package outside this project's app-bin directory");

await run(["bun", "run", "build"]);
await mkdir(output, { recursive: true });
if (!await exists(releaseData) && await exists(legacyData)) await rename(legacyData, releaseData);
await Promise.all([
  rm(join(output, "fastwrite"), { force: true }),
  rm(join(output, "skills"), { recursive: true, force: true }),
  rm(join(output, "web"), { recursive: true, force: true }),
  rm(join(output, "start.sh"), { force: true })
]);

await Bun.write(standaloneEntry, await standaloneEntrySource());
try {
  await run(["bun", "build", "--compile", "--target=bun", "--asset-naming=[dir]/[name].[ext]", "scripts/.standalone-entry.ts", "--outfile", "app-bin/fastwrite"], projectRoot);
} finally {
  await rm(standaloneEntry, { force: true });
}
await cp(join(projectRoot, "apps", "server", "dist", "skills"), join(output, "skills"), { recursive: true });
await Bun.write(join(output, "README.md"), `# FastWrite

## Run

Start the application from this directory:

\`\`\`bash
./fastwrite
\`\`\`

Open the local address printed in the terminal. Your papers and compiler cache are stored in \`paperdata/\` beside the binary.

## Configure AI

Create \`.env\` beside \`fastwrite\` (or copy \`.env.example\` when present):

\`\`\`dotenv
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1
FASTWRITE_OPENAI_MODEL=gpt-5.6
\`\`\`

The API base URL and model are optional. The \`skills/\` directory must remain beside the binary. Keep \`paperdata/\` when upgrading FastWrite; it contains your local workspace data.
`);

if (await exists(sourceEnvironment) && !await exists(releaseEnvironment)) await cp(sourceEnvironment, releaseEnvironment);
else if (!await exists(releaseEnvironment)) await Bun.write(join(output, ".env.example"), "# Copy to .env and configure your AI provider.\n# OPENAI_API_KEY=...\n# OPENAI_BASE_URL=https://api.openai.com/v1\n# FASTWRITE_OPENAI_MODEL=gpt-5.6\n");

await Bun.spawn(["chmod", "+x", join(output, "fastwrite")]).exited;

console.log(`Packaged standalone FastWrite binary into ${output}`);

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function standaloneEntrySource(): Promise<string> {
  const imports: string[] = [];
  for await (const path of new Bun.Glob("**/*").scan({ cwd: webDirectory, onlyFiles: true })) {
    const source = join(webDirectory, path);
    const specifier = relative(dirname(standaloneEntry), source);
    imports.push(`import ${JSON.stringify(specifier.startsWith(".") ? specifier : `./${specifier}`)} with { type: "file" };`);
  }
  imports.sort();
  imports.push('import { startServer } from "../apps/server/src/server";');
  imports.push("await startServer();");
  return `${imports.join("\n")}\n`;
}

async function run(command: string[], cwd = projectRoot): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Command failed: ${command.join(" ")}`);
}
