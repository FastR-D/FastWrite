import type { OutlineItem, PaperClaim, PaperProject, WorkspaceTreeNode } from "@fastwrite/shared";

interface WorkspaceSnapshot {
  project: PaperProject;
  tree: WorkspaceTreeNode[];
  outline: OutlineItem[];
  claims: PaperClaim[];
  savedAt: number;
}

const keyFor = (projectId: string) => `fastwrite.workspace-snapshot:${projectId}`;
const fileKeyFor = (projectId: string, path: string) => `fastwrite.workspace-file:${projectId}:${path}`;

export function saveWorkspaceSnapshot(projectId: string, snapshot: Omit<WorkspaceSnapshot, "savedAt">) {
  try { localStorage.setItem(keyFor(projectId), JSON.stringify({ ...snapshot, savedAt: Date.now() })); } catch { /* Storage may be unavailable or full. */ }
}

export function loadWorkspaceSnapshot(projectId: string): WorkspaceSnapshot | null {
  try {
    const raw = localStorage.getItem(keyFor(projectId));
    if (!raw) return null;
    const snapshot = JSON.parse(raw) as WorkspaceSnapshot;
    return snapshot?.project && Array.isArray(snapshot.tree) && Array.isArray(snapshot.outline) && Array.isArray(snapshot.claims) ? snapshot : null;
  } catch { return null; }
}

export function saveWorkspaceFile(projectId: string, path: string, file: unknown) {
  try { localStorage.setItem(fileKeyFor(projectId, path), JSON.stringify(file)); } catch { /* Best effort cache. */ }
}

export function loadWorkspaceFile<T>(projectId: string, path: string): T | null {
  try { const raw = localStorage.getItem(fileKeyFor(projectId, path)); return raw ? JSON.parse(raw) as T : null; } catch { return null; }
}
