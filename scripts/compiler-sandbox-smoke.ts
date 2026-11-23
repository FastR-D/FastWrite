import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LatexCompileService } from "../apps/server/src/compiler/latex-compile-service";
import { JsonDatabase } from "../apps/server/src/storage/database";
import { WorkspaceService } from "../apps/server/src/workspace/workspace-service";

const root = await mkdtemp(join(tmpdir(), "fastwrite-sandbox-smoke-"));
try {
  const workspaces = {
    getProject() {},
    async copySnapshot(_id: string, source: string) {
      await mkdir(join(source, "sections"), { recursive: true });
      await writeFile(join(source, "main.tex"), "\\documentclass{article}\n\\begin{document}\n\\input{sections/method}\n\\end{document}");
      await writeFile(join(source, "sections/method.tex"), "\\section{Method}\nSandboxed compilation with a secondary source file.");
      // Loading either project RC file must fail this smoke test.
      await writeFile(join(source, ".latexmkrc"), 'die "Project RC must never execute";');
      await writeFile(join(source, "latexmkrc"), 'die "Project RC must never execute";');
      return { mainDocument: "main.tex", projectVersion: 1 };
    }
  } as unknown as WorkspaceService;
  const result = await new LatexCompileService(root, workspaces, { mode: "bubblewrap" }).compile("smoke");
  assert.ok(result.success, `${result.error}\n${result.log}`);
  assert.ok(Buffer.from(result.pdfBase64!, "base64").subarray(0, 5).equals(Buffer.from("%PDF-")));
  assert.ok(result.syncTexData?.includes("sections/method.tex"), "Missing secondary-file SyncTeX mapping");
  console.log("PASS: real sandbox compilation produces PDF and SyncTeX while ignoring project RC files");

  const database = new JsonDatabase(root);
  await database.initialize();
  const projects = new WorkspaceService(root, database);
  const compiler = new LatexCompileService(root, projects, { mode: "bubblewrap" });
  for (const [title, engine] of [["中文论文（实验） #1_2 on 50% & {A}", "xelatex"], ["English paper #1", "pdflatex"]]) {
    const project = await projects.createEmpty(title);
    const compiled = await compiler.compile(project.id);
    assert.equal(compiled.compiler, engine);
    assert.ok(compiled.success, `${compiled.error}\n${compiled.log}`);
    assert.ok(Buffer.from(compiled.pdfBase64!, "base64").subarray(0, 5).equals(Buffer.from("%PDF-")));
    assert.doesNotMatch(compiled.log, /Missing character:/);
  }
  console.log("PASS: new Chinese and English projects compile with their default engines");
} finally {
  await rm(root, { recursive: true, force: true });
}
