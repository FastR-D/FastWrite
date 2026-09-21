import * as Y from "yjs";
import type { CollaborationPersistResponse } from "@fastwrite/shared";
import type { JsonDatabase } from "../storage/database";
import type { WorkspaceService } from "../workspace/workspace-service";
import { ApiError } from "../http";

const COMPACT_AFTER_UPDATES = 1_000;
const COMPACT_AFTER_BYTES = 5 * 1024 * 1024;
const LIVE_FLUSH_IDLE_MS = 1_000;

export class CollaborationService {
  private readonly projectLocks = new Map<string, Promise<unknown>>();
  private readonly liveFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private readonly database: JsonDatabase, private readonly workspaces: WorkspaceService) {}

  async open(projectId: string, path: string) {
    const document = await this.document(projectId, path);
    const ydoc = this.restore(document.id);
    return { documentId: document.id, path: document.path, fileVersion: document.fileVersion, update: encode(Y.encodeStateAsUpdate(ydoc)) };
  }

  async positions(projectId: string, path: string, from: number, to: number) {
    const document = await this.document(projectId, path); const ydoc = this.restore(document.id); const text = ydoc.getText("content");
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > text.length) throw new ApiError(400, "comment_anchor_invalid", "Comment selection is outside the document");
    return { documentId: document.id, fileVersion: document.fileVersion, content: text.toString(), start: encode(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, from))), end: encode(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, to))) };
  }

  absolutePositions(documentId: string, start: string, end: string) {
    const ydoc = this.restore(documentId); const decodePosition = (value: string) => Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(decode(value)), ydoc)?.index;
    return { start: decodePosition(start), end: decodePosition(end) };
  }

  async apply(projectId: string, path: string, update: string, baseVersion: number, flush = true) {
    return this.serialized(projectId, async () => this.applyNow(projectId, path, update, baseVersion, flush));
  }

  async applyLive(projectId: string, path: string, update: string) {
    const result = await this.serialized(projectId, async () => {
      const document = await this.document(projectId, path);
      const bytes = decode(update); const ydoc = this.restore(document.id);
      try { Y.applyUpdate(ydoc, bytes, "remote"); } catch { throw new ApiError(400, "collaboration_update_invalid", "Yjs update could not be decoded"); }
      const sequence = this.nextSequence(document.id);
      await this.database.mutate((state) => {
        state.yDocumentUpdates.push({ documentId: document.id, sequence, update, bytes: bytes.byteLength, createdAt: new Date().toISOString() });
        const stored = state.collaborationDocuments.find((item) => item.id === document.id);
        if (stored) stored.updatedAt = new Date().toISOString();
      });
      if (this.shouldCompact(document.id)) await this.compact(document.id, ydoc);
      return { documentId: document.id, path: document.path };
    });
    this.scheduleLiveFlush(projectId);
    return result;
  }

  /** The request carries its target state, so HTTP cannot overtake a pending WS update. */
  async persistSnapshot(projectId: string, path: string, documentId: string, update: string): Promise<CollaborationPersistResponse> {
    return this.serialized(projectId, async () => {
      const document = await this.document(projectId, path);
      if (document.id !== documentId) throw new ApiError(409, "collaboration_document_replaced", "The collaboration document was replaced. Compare local changes before reconnecting.");
      const ydoc = this.restore(document.id);
      const bytes = decode(update);
      try { Y.applyUpdate(ydoc, bytes, "remote"); }
      catch { throw new ApiError(400, "collaboration_update_invalid", "Yjs update could not be decoded"); }
      // A partial update with missing dependencies cannot count as a persisted target.
      if (ydoc.store.pendingStructs || ydoc.store.pendingDs) throw new ApiError(409, "collaboration_update_incomplete", "The persistence barrier requires a complete CRDT snapshot.");
      const sequence = this.nextSequence(document.id);
      await this.database.mutate(state => {
        state.yDocumentUpdates.push({ documentId, sequence, update, bytes: bytes.byteLength, createdAt: new Date().toISOString() });
      });
      if (this.shouldCompact(document.id)) await this.compact(document.id, ydoc);
      const persisted = await this.flush(projectId, path, document.id, ydoc);
      return { path: document.path, documentId, fileVersion: persisted.fileVersion, update: encode(Y.encodeStateAsUpdate(ydoc)), content: ydoc.getText("content").toString() };
    });
  }

  private async applyNow(projectId: string, path: string, update: string, baseVersion: number, flush: boolean) {
    const document = await this.document(projectId, path);
    if (document.fileVersion !== baseVersion) throw new ApiError(409, "collaboration_version_conflict", "Reload the CRDT document from the latest file revision");
    const bytes = decode(update); const ydoc = this.restore(document.id);
    try { Y.applyUpdate(ydoc, bytes, "remote"); } catch { throw new ApiError(400, "collaboration_update_invalid", "Yjs update could not be decoded"); }
    const sequence = this.nextSequence(document.id);
    await this.database.mutate((state) => {
      state.yDocumentUpdates.push({ documentId: document.id, sequence, update, bytes: bytes.byteLength, createdAt: new Date().toISOString() });
      const stored = state.collaborationDocuments.find((item) => item.id === document.id);
      if (stored) stored.updatedAt = new Date().toISOString();
    });
    if (this.shouldCompact(document.id)) await this.compact(document.id, ydoc);
    const result = flush ? await this.flush(projectId, path, document.id, ydoc) : { fileVersion: document.fileVersion };
    return { documentId: document.id, path: document.path, fileVersion: result.fileVersion, update: encode(Y.encodeStateAsUpdate(ydoc)) };
  }

  async flushProject(projectId: string): Promise<void> {
    return this.serialized(projectId, () => this.flushProjectNow(projectId));
  }

  private async flushProjectNow(projectId: string): Promise<void> {
    const documents = this.database.snapshot().collaborationDocuments.filter((item) => item.projectId === projectId && item.status === "active");
    for (const document of documents) await this.flush(projectId, document.path, document.id, this.restore(document.id));
  }

  async archivePath(projectId: string, path: string): Promise<void> { await this.serialized(projectId, () => this.database.mutate((state) => { for (const document of state.collaborationDocuments) if (document.projectId === projectId && (document.path === path || document.path.startsWith(`${path}/`)) && document.status === "active") { document.status = "archived"; document.updatedAt = new Date().toISOString(); } })); }

  private async document(projectId: string, path: string) {
    const opened = await this.workspaces.readTextFile(projectId, path); const state = this.database.snapshot();
    const existing = state.collaborationDocuments.find((item) => item.projectId === projectId && item.path === opened.file.path && item.status === "active");
    if (existing) return existing;
    const now = new Date().toISOString(); const created = { id: `ydoc_${crypto.randomUUID()}`, projectId, path: opened.file.path, status: "active" as const, fileVersion: opened.file.version, createdAt: now, updatedAt: now };
    const ydoc = new Y.Doc(); ydoc.getText("content").insert(0, opened.content);
    await this.database.mutate((current) => { const concurrent = current.collaborationDocuments.find((item) => item.projectId === projectId && item.path === opened.file.path && item.status === "active"); if (concurrent) return; current.collaborationDocuments.push(created); current.yDocumentSnapshots.push({ documentId: created.id, sequence: 0, update: encode(Y.encodeStateAsUpdate(ydoc)), createdAt: now }); });
    return this.database.snapshot().collaborationDocuments.find((item) => item.projectId === projectId && item.path === opened.file.path && item.status === "active")!;
  }
  private restore(documentId: string) { const state = this.database.snapshot(); const ydoc = new Y.Doc(); const snapshot = state.yDocumentSnapshots.filter((item) => item.documentId === documentId).sort((a, b) => b.sequence - a.sequence)[0]; if (snapshot) Y.applyUpdate(ydoc, decode(snapshot.update), "restore"); const after = snapshot?.sequence ?? -1; for (const update of state.yDocumentUpdates.filter((item) => item.documentId === documentId && item.sequence > after).sort((a, b) => a.sequence - b.sequence)) Y.applyUpdate(ydoc, decode(update.update), "restore"); return ydoc; }
  private nextSequence(documentId: string) { const state = this.database.snapshot(); return Math.max(0, ...state.yDocumentSnapshots.filter((item) => item.documentId === documentId).map((item) => item.sequence), ...state.yDocumentUpdates.filter((item) => item.documentId === documentId).map((item) => item.sequence)) + 1; }
  private shouldCompact(documentId: string) { const updates = this.database.snapshot().yDocumentUpdates.filter((item) => item.documentId === documentId); return updates.length >= COMPACT_AFTER_UPDATES || updates.reduce((sum, item) => sum + item.bytes, 0) >= COMPACT_AFTER_BYTES; }
  private async compact(documentId: string, ydoc: Y.Doc) { const state = this.database.snapshot(); const sequence = this.nextSequence(documentId); const update = encode(Y.encodeStateAsUpdate(ydoc)); await this.database.mutate((current) => { current.yDocumentSnapshots.push({ documentId, sequence, update, createdAt: new Date().toISOString() }); current.yDocumentUpdates = current.yDocumentUpdates.filter((item) => item.documentId !== documentId); }); }
  private async flush(projectId: string, path: string, documentId: string, ydoc: Y.Doc) { const current = this.database.snapshot().collaborationDocuments.find((item) => item.id === documentId); if (!current) throw new ApiError(404, "collaboration_document_not_found", "Collaboration document not found"); const content = ydoc.getText("content").toString(); const file = await this.workspaces.readTextFile(projectId, path); if (file.content === content) return { fileVersion: file.file.version }; const saved = await this.workspaces.saveTextFile(projectId, path, { content, baseVersion: current.fileVersion }); await this.database.mutate((state) => { const stored = state.collaborationDocuments.find((item) => item.id === documentId); if (stored) { stored.fileVersion = saved.file.version; stored.updatedAt = new Date().toISOString(); } }); return { fileVersion: saved.file.version }; }
  private async serialized<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.projectLocks.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => next);
    this.projectLocks.set(projectId, queued);
    await previous;
    try { return await operation(); } finally { release(); if (this.projectLocks.get(projectId) === queued) this.projectLocks.delete(projectId); }
  }
  private scheduleLiveFlush(projectId: string) {
    const previous = this.liveFlushTimers.get(projectId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.liveFlushTimers.delete(projectId);
      void this.flushProject(projectId).catch(() => undefined);
    }, LIVE_FLUSH_IDLE_MS);
    timer.unref?.();
    this.liveFlushTimers.set(projectId, timer);
  }
}
function encode(update: Uint8Array) { return Buffer.from(update).toString("base64"); }
function decode(update: string) { try { return new Uint8Array(Buffer.from(update, "base64")); } catch { throw new ApiError(400, "collaboration_update_invalid", "Yjs update could not be decoded"); } }
