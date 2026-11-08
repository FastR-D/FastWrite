import { api } from "../../api/client";
import { ReviewDraftSession, type ReviewDraftRecord } from "./reviewDraftSession";
import { loadOfflineDraft, preserveRecoveryDraft, saveOfflineDraft } from "../offlineDrafts";

const sessions = new Map<string, ReviewDraftSession>();
export function projectReviewDraft(projectId: string, path: string, userId: string, onSaved: () => void) {
  const key = JSON.stringify([projectId, userId, path]);
  const existing = sessions.get(key); if (existing) return existing;
  const localPath = `review:${userId}:${path}`;
  const session = new ReviewDraftSession({
    start: previousId => api.projects.startReviewSession(projectId, path, previousId),
    read: id => api.projects.reviewSession(projectId, id),
    save: (id, body) => api.projects.saveReviewSession(projectId, id, body),
    load: async () => {
      const draft = await loadOfflineDraft(projectId, localPath);
      if (!draft?.baseContent) return;
      try { return JSON.parse(draft.baseContent) as ReviewDraftRecord; } catch { return; }
    },
    store: record => saveOfflineDraft(projectId, localPath, record.content, record.session.revision, JSON.stringify(record)),
    archive: async record => { await preserveRecoveryDraft(projectId, localPath, { content: record.content, baseVersion: record.session.revision, baseContent: record.session.baseContent }, "before-recovery"); }
  }, onSaved);
  sessions.set(key, session);
  if (sessions.size > 32) {
    for (const [candidate, stored] of sessions) if (stored !== session && !stored.dirty && stored.state === "saved") { void stored.dispose(); sessions.delete(candidate); if (sessions.size <= 32) break; }
  }
  return session;
}
