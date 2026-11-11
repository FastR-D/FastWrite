import type { TexEnvironmentService } from "../compiler/tex-environment-service";
import { ApiError } from "../http";
import { buildLatexIndex, type LatexDocument } from "@fastwrite/shared";
import type { WorkspaceService } from "../workspace/workspace-service";
import type { AuthorizationService } from "../auth/authorization-service";
import type { Principal } from "../auth/auth-service";

export class ProjectIntelligence {
  constructor(
    private readonly workspaces: WorkspaceService,
    private readonly authorization: AuthorizationService,
    private readonly environments?: TexEnvironmentService,
  ) {}
  async index(projectId: string, principal?: Principal) {
    const project = this.workspaces.getProject(projectId);
    if (principal)
      this.authorization.requireProject(principal, projectId, "project:read");
    const paths: string[] = [];
    const visit = (nodes: any[]) => {
      for (const node of nodes)
        if (node.type === "directory") visit(node.children);
        else if (/\.(?:tex|bib|sty|cls)$/i.test(node.path))
          paths.push(node.path);
    };
    visit(await this.workspaces.tree(projectId));
    const documents: LatexDocument[] = [];
    let size = 0;
    for (const path of paths) {
      if (
        principal &&
        !this.authorization.projectPathDecision(
          principal,
          projectId,
          path,
          "project:read",
        ).allowed
      )
        continue;
      const doc = await this.workspaces.readTextFile(projectId, path);
      size += doc.content.length;
      if (size > 4_000_000)
        throw new ApiError(
          413,
          "latex_index_too_large",
          "项目语言索引超过 400 万字符上限",
        );
      documents.push({ path, content: doc.content, version: doc.file.version });
    }
    if (principal)
      for (const document of documents)
        this.authorization.requireProjectPath(
          principal,
          projectId,
          document.path,
          "project:read",
        );
    const index = buildLatexIndex(documents, project.version);
    if (this.environments) {
      try {
        Object.assign(
          index,
          await this.environments.catalog(
            project.compilation?.environmentId ?? "system",
            documents,
          ),
        );
      } catch {
        /* Offline/distribution-specific catalogs retain core and project completion. */
      }
    }
    if (principal)
      for (const document of documents)
        this.authorization.requireProjectPath(
          principal,
          projectId,
          document.path,
          "project:read",
        );
    return index;
  }
}
