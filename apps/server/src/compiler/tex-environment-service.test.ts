import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonDatabase } from "../storage/database";
import { WorkspaceService } from "../workspace/workspace-service";
import { LatexCompileService } from "./latex-compile-service";
import {
  TexEnvironmentService,
  inspectProjectEnvironment,
} from "./tex-environment-service";

test("environment configuration rejects arbitrary root mounts and user-controlled command names", () => {
  expect(
    () =>
      new TexEnvironmentService(
        '[{"id":"bad","label":"bad","binDirectory":"/bin","roots":["/"]}]',
      ),
  ).toThrow();
  expect(
    () =>
      new TexEnvironmentService(
        '[{"id":"system","label":"duplicate","image":"test:1"}]',
      ),
  ).toThrow();
  expect(
    () =>
      new TexEnvironmentService(
        '[{"id":"remote","label":"remote","image":"image; unsafe"}]',
      ),
  ).toThrow();
  expect(
    new TexEnvironmentService(
      '[{"id":"pinned","label":"pinned","image":"registry.example/tex@sha256:abc"}]',
    ).get("pinned").image,
  ).toContain("sha256");
});
for (const engine of ["pdflatex", "xelatex", "lualatex"] as const) {
  test.skipIf(!Bun.which(engine) || !Bun.which("latexmk"))(
    `real ${engine} compiles with diagnostics and isolated candidates`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), `fastwrite-${engine}-`));
      try {
        const database = new JsonDatabase(root);
        await database.initialize();
        const workspaces = new WorkspaceService(root, database);
        await workspaces.initialize();
        const project = await workspaces.createEmpty("Engine validation");
        const opened = await workspaces.readTextFile(
          project.id,
          project.mainDocument,
        );
        const content = `\\documentclass{article}\n${engine !== "pdflatex" ? "\\usepackage{fontspec}\n\\setmainfont{DejaVu Serif}\n" : ""}\\begin{document}\nA reproducible result.\\label{result}\n\\end{document}\n`;
        await workspaces.saveTextFile(project.id, project.mainDocument, {
          content,
          baseVersion: opened.file.version,
        });
        await workspaces.updateProject(project.id, {
          compilation: { engine, environmentId: "system" },
        });
        const compiler = new LatexCompileService(root, workspaces, {
          mode: "host",
        });
        const result = await compiler.compile(project.id);
        expect(result.success, result.log).toBe(true);
        expect(result.pdfBase64).toBeTruthy();
        expect(result.compiler).toBe(engine);
        expect(compiler.latest(project.id)?.snapshotId).toBe(result.snapshotId);
        const invalid = await compiler.compile(project.id, undefined, {
          expectedVersion: result.projectVersion,
          files: [
            {
              path: project.mainDocument,
              content: content.replace(
                "A reproducible",
                "\\deliberatelyUndefined A reproducible",
              ),
            },
          ],
        });
        expect(invalid.success).toBe(false);
        expect(
          invalid.diagnostics?.some((item) => item.severity === "error"),
        ).toBe(true);
        expect(
          (await workspaces.readTextFile(project.id, project.mainDocument))
            .content,
        ).toBe(content);
        expect(compiler.latest(project.id)?.success).toBe(true);
        await expect(
          compiler.compile(project.id, undefined, {
            expectedVersion: 999,
            files: [],
          }),
        ).rejects.toMatchObject({ code: "compile_candidate_stale" });
        const preflight = await inspectProjectEnvironment(
          compiler.environments,
          { engine, environmentId: "system" },
          [
            {
              path: "main.tex",
              content:
                "\\documentclass{article}\n\\usepackage{fastwritenonexistentpackage}",
            },
          ],
        );
        expect(preflight.missing).toContain("fastwritenonexistentpackage.sty");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    90_000,
  );
}
