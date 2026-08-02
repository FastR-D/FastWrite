import { resolve, sep } from "node:path";
import { normalizeWorkspacePath } from "@fastwrite/shared";
import { ApiError } from "../http";

export function resolveWorkspacePath(workspaceRoot: string, requestedPath: string): { relativePath: string; absolutePath: string } {
  let relativePath: string;
  try {
    relativePath = normalizeWorkspacePath(requestedPath);
  } catch {
    throw new ApiError(400, "invalid_path", "The requested path is not a safe workspace-relative path");
  }

  if (!relativePath) throw new ApiError(400, "invalid_path", "A file path is required");
  const absolutePath = resolve(workspaceRoot, relativePath);
  if (!absolutePath.startsWith(`${resolve(workspaceRoot)}${sep}`)) {
    throw new ApiError(400, "invalid_path", "The requested path escapes the project workspace");
  }
  return { relativePath, absolutePath };
}
