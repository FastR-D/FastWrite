import type { Principal } from "../auth/auth-service";
import type { AuthorizationService } from "../auth/authorization-service";
import { ApiError } from "../http";
import type { WorkspaceService } from "./workspace-service";
import type { WorkspaceTreeNode } from "@fastwrite/shared";

export interface ProjectSearchMatch {
  path: string;
  line: number;
  excerpt: string;
}

export interface ProjectSearchResult {
  query: string;
  matches: ProjectSearchMatch[];
  truncated: boolean;
}

/** Bounded project search that treats every result as path-scoped content. */
export class ProjectSearchService {
  constructor(private readonly workspaces: WorkspaceService, private readonly authorization: AuthorizationService) {}

  async search(projectId: string, principal: Principal, rawQuery: string): Promise<ProjectSearchResult> {
    const query = rawQuery.trim();
    if (!query || query.length > 500) throw new ApiError(400, "project_search_query_invalid", "Search query must be between 1 and 500 characters");
    this.authorization.requireProject(principal, projectId, "project:read");
    const needle = query.toLocaleLowerCase();
    const matches: ProjectSearchMatch[] = [];
    let truncated = false;
    for (const path of textPaths(await this.workspaces.tree(projectId))) {
      try { this.authorization.requireProjectPath(principal, projectId, path, "project:read"); }
      catch { continue; }
      const file = await this.workspaces.readTextFile(projectId, path);
      for (const [index, line] of file.content.split(/\r?\n/).entries()) {
        if (!line.toLocaleLowerCase().includes(needle)) continue;
        matches.push({ path, line: index + 1, excerpt: excerpt(line, needle) });
        if (matches.length === 100) { truncated = true; return { query, matches, truncated }; }
      }
    }
    return { query, matches, truncated };
  }
}

function textPaths(nodes: WorkspaceTreeNode[]): string[] { return nodes.flatMap((node) => node.type === "directory" ? textPaths(node.children) : node.kind === "text" ? [node.path] : []); }
function excerpt(line: string, needle: string): string {
  if (line.length <= 400) return line;
  const match = line.toLocaleLowerCase().indexOf(needle);
  const start = Math.max(0, match - 160); const end = Math.min(line.length, match + needle.length + 160);
  return `${start ? "..." : ""}${line.slice(start, end)}${end < line.length ? "..." : ""}`;
}
