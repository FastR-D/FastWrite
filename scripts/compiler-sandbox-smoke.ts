import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LatexCompileService } from "../apps/server/src/compiler/latex-compile-service";
import type { WorkspaceService } from "../apps/server/src/workspace/workspace-service";

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
} finally {
  await rm(root, { recursive: true, force: true });
}
