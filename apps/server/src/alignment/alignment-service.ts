import type { AlignmentFinding } from "@fastwrite/shared";
import type { WorkspaceService } from "../workspace/workspace-service";

export class AlignmentService {
  constructor(private readonly workspaces: WorkspaceService) {}
  async check(projectId: string): Promise<{ projectId: string; findings: AlignmentFinding[] }> {
    this.workspaces.getProject(projectId); const tree = await this.workspaces.tree(projectId); const paths = textPaths(tree); const findings: AlignmentFinding[] = [];
    const tex = paths.filter((path) => /\.tex$/i.test(path)); const files = paths.filter((path) => /\.(?:csv|json|tsv|txt)$/i.test(path));
    for (const path of files) findings.push({ id: `file:${path}`, kind: "file", status: "unresolved", message: "Result file discovered; link it to a manuscript experiment explicitly before treating values as aligned.", path });
    for (const path of tex) { const content = (await this.workspaces.readTextFile(projectId, path)).content; for (const match of content.matchAll(/\b\d+(?:\.\d+)?%?/g)) { const token = match[0]; const offset = match.index ?? 0; const line = content.slice(0, offset).split("\n").length; findings.push({ id: `number:${path}:${offset}`, kind: "number", status: "unresolved", message: `Numeric value '${token}' requires user-confirmed linkage to a result source.`, path, line, evidence: token }); } }
    if (!findings.length) findings.push({ id: "alignment:empty", kind: "file", status: "pass", message: "No manuscript numbers or result files were found for alignment analysis." });
    return { projectId, findings };
  }
}
function textPaths(nodes: any[]): string[] { return nodes.flatMap((node) => node.type === "directory" ? textPaths(node.children) : node.kind === "text" ? [node.path] : []); }
