import { userFacingError } from "./notifications";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CollaboratorPresence, CommentThreadView, ProjectAccess, SourceLocation } from "@fastwrite/shared";
import { api, ApiClientError } from "../api/client";
import type { DocumentRegistry } from "./editor/documentRegistry";

export function useProjectCollaboration(projectId: string, registry: DocumentRegistry, path: string | null, cursor: SourceLocation) {
  const [access, setAccess] = useState<ProjectAccess | null>(null);
  const [threads, setThreads] = useState<CommentThreadView[]>([]);
  const [externalComments, setExternalComments] = useState<Awaited<ReturnType<typeof api.projects.sharedComments>>>([]);
  const [peers, setPeers] = useState<CollaboratorPresence[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState(0);
  const clientId = useRef(crypto.randomUUID());
  const cursorRef = useRef(cursor); cursorRef.current = cursor;
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => { setThreads([]); setExternalComments([]); setPeers([]); setLoaded(false); setAccess(null); }, [projectId]);
  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    const poll = async () => {
      if (running || document.visibilityState === "hidden") return;
      running = true;
      try {
        const nextAccess = await api.projects.access(projectId, path ?? undefined, controller.signal);
        if (controller.signal.aborted) return;
        setAccess(nextAccess);
        if (path) { const entry = registry.get(path); if (entry) registry.setAccess(entry, nextAccess); }
        if (nextAccess.realtime) {
          const [nextThreads, nextPeers, nextExternal] = await Promise.all([
            api.projects.comments(projectId, controller.signal),
            path ? api.projects.collaborationPresence(projectId, { clientId: clientId.current, name: "", path, ...(cursorRef.current.path === path ? { line: cursorRef.current.line } : {}) }) : api.projects.presence(projectId, controller.signal),
            api.projects.sharedComments(projectId, controller.signal)
          ]);
          if (controller.signal.aborted) return;
          setThreads(nextThreads); setPeers(nextPeers); setExternalComments(nextExternal);
        }
        setError(""); setLoaded(true);
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiClientError && [401, 403].includes(failure.status)) {
          setAccess(null);
          for (const entry of registry.entries.values()) if (entry.access) registry.setAccess(entry, { ...entry.access, canWrite: false, canComment: false, canInvite: false, canManage: false });
        }
        setError(userFacingError(failure, "协作暂不可用"));
        setLoaded(true);
      } finally { running = false; }
    };
    void poll();
    const interval = setInterval(() => { void poll(); }, 3_000);
    const visible = () => { if (document.visibilityState === "visible") void poll(); };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", visible);
    return () => { controller.abort(); clearInterval(interval); document.removeEventListener("visibilitychange", visible); window.removeEventListener("online", visible); };
  }, [projectId, registry, path, revision]);
  useEffect(() => {
    const id = clientId.current;
    return () => { void api.projects.leavePresence(projectId, id).catch(() => undefined); };
  }, [projectId]);
  return { access, threads, externalComments, peers, error, loaded, refresh, openCount: threads.filter(thread => thread.status !== "resolved").length + externalComments.filter(item => item.status === "open").length };
}
export type ProjectCollaboration = ReturnType<typeof useProjectCollaboration>;
