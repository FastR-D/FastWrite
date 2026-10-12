import type { OutlineItem, PaperClaim, PaperProject, WorkspaceTreeNode } from "@fastwrite/shared";

interface WorkspaceSnapshot {
  project: PaperProject;
  tree: WorkspaceTreeNode[];
  outline: OutlineItem[];
  claims: PaperClaim[];
  savedAt: number;
}

async function cacheScope() {
  const token = localStorage.getItem("fastwrite.session-token");
  const digest = token ? await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)) : null;
  const key = digest ? Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("") : "local";
  return { key, current: () => localStorage.getItem("fastwrite.session-token") === token };
}
const keyFor = (scope: string, projectId: string) => `fastwrite.workspace-snapshot:v2:${scope}:${projectId}`;
const fileKeyFor = (scope: string, projectId: string, path: string) => `fastwrite.workspace-file:v2:${scope}:${projectId}:${path}`;

export function canUseOfflineCache(error: unknown): boolean {
  return error instanceof TypeError && /fetch|network|load failed|connection/i.test(error.message) || error instanceof DOMException && error.name === "NetworkError";
}
const NETWORK_EVENT = "fastwrite-network";

export function networkState(): "online" | "offline" {
  return typeof navigator === "undefined" || navigator.onLine ? "online" : "offline";
}

export function subscribeNetworkState(listener: (state: "online" | "offline") => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent).detail === "offline" ? "offline" : "online");
  const online = () => listener("online");
  const offline = () => listener("offline");
  window.addEventListener(NETWORK_EVENT, handler);
  window.addEventListener("online", online);
  window.addEventListener("offline", offline);
  return () => { window.removeEventListener(NETWORK_EVENT, handler); window.removeEventListener("online", online); window.removeEventListener("offline", offline); };
}

export async function saveWorkspaceSnapshot(projectId: string, snapshot: Omit<WorkspaceSnapshot, "savedAt">) {
  try { const scope = await cacheScope(); if (!scope.current()) return; localStorage.setItem(keyFor(scope.key, projectId), JSON.stringify({ ...snapshot, savedAt: Date.now() })); } catch { /* Storage may be unavailable or full. */ }
}

export async function loadWorkspaceSnapshot(projectId: string): Promise<WorkspaceSnapshot | null> {
  try {
    const scope = await cacheScope(); if (!scope.current()) return null;
    const raw = localStorage.getItem(keyFor(scope.key, projectId));
    if (!raw) return null;
    const snapshot = JSON.parse(raw) as WorkspaceSnapshot;
    return snapshot?.project && Array.isArray(snapshot.tree) && Array.isArray(snapshot.outline) && Array.isArray(snapshot.claims) ? snapshot : null;
  } catch { return null; }
}

export async function saveWorkspaceFile(projectId: string, path: string, file: unknown) {
  try { const scope = await cacheScope(); if (!scope.current()) return; localStorage.setItem(fileKeyFor(scope.key, projectId, path), JSON.stringify(file)); } catch { /* Best effort cache. */ }
}

export async function loadWorkspaceFile<T>(projectId: string, path: string): Promise<T | null> {
  try { const scope = await cacheScope(); if (!scope.current()) return null; const raw = localStorage.getItem(fileKeyFor(scope.key, projectId, path)); return raw ? JSON.parse(raw) as T : null; } catch { return null; }
}
