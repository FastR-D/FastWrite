const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;
const INTERNAL_WORKSPACE_NAMES = new Set([
  ".git",
  ".writeagent",
  ".fastwrite",
  ".DS_Store",
  "node_modules",
  "output",
  "build",
  "dist",
  "backup",
  "backups"
]);

export function normalizeWorkspacePath(input: string): string {
  const normalized = input.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  if (!normalized || normalized === ".") return "";
  if (normalized.startsWith("/") || WINDOWS_DRIVE.test(input) || CONTROL_CHARACTERS.test(normalized)) {
    throw new Error("Workspace paths must be safe relative paths");
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Workspace paths cannot contain empty, current, or parent segments");
  }

  return segments.join("/");
}

export function isTextFile(path: string): boolean {
  const extension = path.toLowerCase().split(".").pop() ?? "";
  return ["tex", "md", "bib", "sty", "cls", "bst", "txt", "yaml", "yml", "json"].includes(extension);
}

export function isImageFile(path: string): boolean {
  const extension = path.toLowerCase().split(".").pop() ?? "";
  return ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(extension);
}

export function sortWorkspaceNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Internal metadata and generated output never belong to the managed paper. */
export function isIgnoredWorkspacePath(path: string): boolean {
  const segments = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return segments.some((segment) => INTERNAL_WORKSPACE_NAMES.has(segment) || segment.startsWith("_minted-"));
}
