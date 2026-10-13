import { expect, test, spyOn } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LatexCompileService } from "./latex-compile-service";
import type { WorkspaceService } from "../workspace/workspace-service";

test.each(["host", "bubblewrap"] as const)("%s compilation isolates configuration and output paths", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "fastwrite-compile-security-"));
  const prior = process.env.FASTWRITE_TEST_COMPILER_SECRET;
  process.env.FASTWRITE_TEST_COMPILER_SECRET = "must-not-reach-tex";
  const which = spyOn(Bun, "which").mockImplementation((name) => `/usr/bin/${name}`);
  let captured: { args: string[]; env: Record<string, string> } | undefined;
  const spawn = spyOn(Bun, "spawn").mockImplementation(((args: string[], options: any) => {
    captured = { args, env: options.env };
    return { exited: Promise.resolve(1), stdout: new Response("blocked test compile").body, stderr: new Response("").body, kill() {} };
  }) as any);
  const workspaces = {
    getProject() {},
    async copySnapshot(_id: string, source: string) {
      await mkdir(source, { recursive: true });
      await writeFile(join(source, ".latexmkrc"), "$pdflatex='unsafe';");
      return { mainDocument: "-shell-escape.tex", projectVersion: 1 };
    }
  } as unknown as WorkspaceService;
  try {
    await new LatexCompileService(root, workspaces, { mode }).compile("test");
    expect(captured!.args).toContain("-norc");
    expect(captured!.args).toContain("-no-shell-escape");
    expect(captured!.args.at(-1)).toBe("./-shell-escape.tex");
    expect(captured!.env.FASTWRITE_TEST_COMPILER_SECRET).toBeUndefined();
    expect(captured!.env).toMatchObject({ openin_any: "p", openout_any: "p", shell_escape: "f" });
    if (mode === "host") expect(captured!.env.HOME).toStartWith(root);
    else {
      const command = captured!.args.slice(captured!.args.indexOf("--") + 1);
      expect(command).toContain("-outdir=/workspace/output");
      expect(command).toContain("-auxdir=/workspace/output");
      expect(command.join(" ")).not.toContain(root);
      expect(Object.values(captured!.env).join(" ")).not.toContain(root);
      expect(captured!.env.TEXMFCONFIG).toBe("/workspace/output/texmf-config");
      expect(captured!.args).toContain("--unshare-all");
    }
  } finally {
    spawn.mockRestore(); which.mockRestore();
    if (prior === undefined) delete process.env.FASTWRITE_TEST_COMPILER_SECRET; else process.env.FASTWRITE_TEST_COMPILER_SECRET = prior;
    await rm(root, { recursive: true, force: true });
  }
});
