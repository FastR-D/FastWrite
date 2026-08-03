import type { WorkspaceTreeNode } from "@fastwrite/shared";
import { api } from "../api/client";
import { compileLatex, type BrowserCompileResult } from "./latexCompiler";

export type WorkspaceCompileResult = BrowserCompileResult & { workspacePaths: string[] };

export async function compileWorkspace(projectId: string, mainDocument: string, signal?: AbortSignal, onProgress?: (detail: string) => void): Promise<WorkspaceCompileResult> {
  const tree = await api.projects.tree(projectId, signal);
  const files = flattenFiles(tree);
  onProgress?.(`Reading ${files.length} workspace files…`);
  const main = await api.projects.readFile(projectId, mainDocument, signal);
  const additionalFiles: Record<string, string | Uint8Array> = {};
  let completed = 0;

  await Promise.all(files.filter((file) => file.path !== mainDocument).map(async (file) => {
    if (signal?.aborted) throw new DOMException("Compilation cancelled", "AbortError");
    if (file.kind === "text") {
      addCompileFile(additionalFiles, file.path, mainDocument, (await api.projects.readFile(projectId, file.path, signal)).content);
      completed += 1;
      onProgress?.(`Reading workspace files (${completed}/${Math.max(0, files.length - 1)})…`);
      return;
    }
    const response = await fetch(`/api/projects/${projectId}/asset?path=${encodeURIComponent(file.path)}`, signal ? { signal } : undefined);
    if (!response.ok) throw new Error(`Could not read '${file.path}' for compilation`);
    addCompileFile(additionalFiles, file.path, mainDocument, new Uint8Array(await response.arrayBuffer()));
    completed += 1;
    onProgress?.(`Reading workspace files (${completed}/${Math.max(0, files.length - 1)})…`);
  }));

  if (signal?.aborted) throw new DOMException("Compilation cancelled", "AbortError");
  onProgress?.("Starting LaTeX compiler…");
  return { ...await compileLatex(main.content, additionalFiles), workspacePaths: files.map((file) => file.path) };
}

/**
 * Siglum compiles the selected source as its root document. Imported projects
 * often keep that document in a folder (for example `paper/main.tex`) and use
 * paths relative to that folder. Keep the original workspace path for absolute
 * references and add a root alias for files beside the main document.
 */
export function addCompileFile(files: Record<string, string | Uint8Array>, path: string, mainDocument: string, content: string | Uint8Array): void {
  files[path] = content;
  const separator = mainDocument.lastIndexOf("/");
  if (separator < 0) return;
  const mainDirectory = mainDocument.slice(0, separator + 1);
  if (!path.startsWith(mainDirectory)) return;
  const relativePath = path.slice(mainDirectory.length);
  if (relativePath && !(relativePath in files)) files[relativePath] = content;
}

function flattenFiles(nodes: WorkspaceTreeNode[]): Array<Extract<WorkspaceTreeNode, { type: "file" }>> {
  const files: Array<Extract<WorkspaceTreeNode, { type: "file" }>> = [];
  for (const node of nodes) {
    if (node.type === "file") files.push(node);
    else files.push(...flattenFiles(node.children));
  }
  return files;
}
