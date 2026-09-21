import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import { normalizeWorkspacePath, type FileContentResponse, type SaveFileResponse } from "@fastwrite/shared";
import { api } from "../../api/client";
import { CollaborationProvider } from "./collaborationProvider";
import { DocumentSession } from "./documentSession";
import { configureMonaco, languageForPath } from "./monaco";
import { loadOfflineDraft, removeOfflineDraft, saveOfflineDraft, listRecoveryDrafts, preserveRecoveryDraft, removeRecoveryDraft, type RecoveryDraft } from "../offlineDrafts";

export interface DocumentEntry {
  session: DocumentSession;
  model: monaco.editor.ITextModel;
  file: FileContentResponse["file"];
  viewState: monaco.editor.ICodeEditorViewState | null;
  applyingExternal: boolean;
  references: number;
  lastAccess: number;
  mode: "rest" | "collaboration";
  collaboration?: CollaborationProvider;
  persist?: (snapshot: { content: string; baseVersion: number; revision: number }) => Promise<Pick<SaveFileResponse, "file">>;
  recoveries: RecoveryDraft[];
  draftReady: Promise<void>;
  draftLoading: boolean;
  draftError?: unknown;
  draftWrites: Promise<void>;
  dispose: () => void;
}

/** Project-owned models survive editor views and share exactly one persistence queue. */
export class DocumentRegistry {
  readonly entries = new Map<string, DocumentEntry>();
  onSaved: ((document: FileContentResponse) => void | Promise<void>) | undefined;
  private listeners = new Set<(entry: DocumentEntry) => void>();
  private retained = new Set<string>();
  private closed = false;
  private owners = 0;
  private closing: Promise<void> | undefined;
  get disposed() { return this.closed; }
  attachOwner() {
    this.owners++;
    let released = false;
    return () => {
      if (released) return; released = true; this.owners--;
      queueMicrotask(() => { if (!this.owners) void this.close().catch(error => console.error("Could not preserve document drafts", error)); });
    };
  }
  constructor(readonly projectId: string, readonly cacheLimit = 32) {}
  key(path: string) { return JSON.stringify([this.projectId, normalizeWorkspacePath(path)]); }
  get(path: string) { return this.entries.get(this.key(path)); }
  document(path: string): FileContentResponse | undefined {
    const entry = this.get(path);
    return entry ? { file: { ...entry.file, version: entry.session.serverVersion }, content: entry.model.getValue() } : undefined;
  }
  subscribe(listener: (entry: DocumentEntry) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(entry: DocumentEntry) { for (const listener of this.listeners) listener(entry); }
  dirtyEntry(entry: DocumentEntry) { return entry.session.dirty || !!entry.collaboration?.dirty; }
  get dirty() { return [...this.entries.values()].some(entry => this.dirtyEntry(entry)); }

  open(document: FileContentResponse): DocumentEntry {
    if (this.closed) throw new Error("Document registry is closed");
    const key = this.key(document.file.path);
    let entry = this.entries.get(key);
    if (entry) {
      entry.lastAccess = performance.now();
      if (entry.mode === "rest" && entry.session.receive(document.content, document.file.version)) {
        entry.file = document.file;
        this.applyExternal(entry, entry.session.content);
      }
      return entry;
    }
    configureMonaco();
    const path = normalizeWorkspacePath(document.file.path);
    if (!path) throw new Error("A document path is required");
    const model = monaco.editor.createModel(document.content, languageForPath(path), monaco.Uri.from({ scheme: "fastwrite", authority: this.projectId, path: `/${path}` }));
    const session = new DocumentSession(this.projectId, path, document.content, document.file.version, async snapshot => {
      const result = await (created.persist ? created.persist(snapshot) : api.projects.saveFile(this.projectId, path, { content: snapshot.content, baseVersion: snapshot.baseVersion }));
      created.file = result.file;
      void Promise.resolve().then(() => { if (!this.closed) return this.onSaved?.({ file: result.file, content: snapshot.content }); }).catch(() => undefined);
      return { version: result.file.version };
    });
    const created: DocumentEntry = { session, model, file: document.file, viewState: null, applyingExternal: false, references: 0, lastAccess: performance.now(), mode: "rest", recoveries: [], draftLoading: true, draftReady: Promise.resolve(), draftWrites: Promise.resolve(), dispose: () => undefined };
    this.entries.set(key, created);
    const change = model.onDidChangeContent(() => {
      if (!created.applyingExternal && created.mode === "rest") session.edit(model.getValue());
    });
    const unsubscribe = session.subscribe(() => {
      const content = session.content, version = session.serverVersion, baseContent = session.baseContent, dirty = session.dirty;
      created.draftWrites = created.draftWrites.catch(() => undefined).then(() => created.draftReady).then(() => dirty ? saveOfflineDraft(this.projectId, path, content, version, baseContent) : removeOfflineDraft(this.projectId, path));
      void created.draftWrites.catch(error => { created.draftError = error; this.emit(created); });
      this.emit(created);
    });
    created.dispose = () => { created.collaboration?.dispose(); change.dispose(); unsubscribe(); model.dispose(); };
    // Recover and archive the previous draft before any new save/ACK can overwrite it.
    created.draftReady = this.recoverDrafts(created).catch(error => { created.draftError = error; this.emit(created); throw error; });
    created.draftWrites = created.draftReady;
    void created.draftReady.catch(() => undefined);
    if (localStorage.getItem("fastwrite.collaboration.enabled") === "true") this.enableCollaboration(created);
    this.emit(created);
    return created;
  }

  private async recoverDrafts(entry: DocumentEntry) {
    const path = entry.session.path;
    const [draft, recoveries] = await Promise.all([loadOfflineDraft(this.projectId, path), listRecoveryDrafts(this.projectId, path)]);
    if (this.closed || entry.model.isDisposed()) return;
    entry.recoveries = recoveries;
    if (draft && draft.content !== entry.model.getValue()) {
      if (!recoveries.some(item => item.content === draft.content && item.baseVersion === draft.baseVersion)) {
        entry.recoveries.unshift(await preserveRecoveryDraft(this.projectId, path, draft, "offline"));
      }
      // The await above may allow fresh input; check revision only after archival completes.
      if (entry.mode === "rest" && entry.session.localRevision === 0 && draft.baseVersion === entry.session.serverVersion) {
        this.applyExternal(entry, draft.content);
        entry.session.edit(draft.content);
      }
    }
    entry.draftLoading = false;
    this.emit(entry);
  }
  async preserve(entry: DocumentEntry, content: string, reason: RecoveryDraft["reason"], baseline?: { content?: string; version: number }) {
    const baseContent = baseline ? baseline.content : entry.session.baseContent;
    const baseVersion = baseline?.version ?? entry.session.serverVersion;
    await entry.draftReady;
    const existing = entry.recoveries.find(item => item.content === content && item.baseVersion === baseVersion && item.baseContent === baseContent);
    if (existing) return existing;
    const draft = await preserveRecoveryDraft(this.projectId, entry.session.path, { content, ...(baseContent === undefined ? {} : { baseContent }), baseVersion }, reason);
    entry.recoveries.unshift(draft); this.emit(entry);
    return draft;
  }
  async forgetRecovery(entry: DocumentEntry, id: string) {
    await removeRecoveryDraft(id);
    entry.recoveries = entry.recoveries.filter(item => item.id !== id); this.emit(entry);
  }
  async resolve(entry: DocumentEntry, content: string, server: FileContentResponse, expectedRevision: number) {
    if (entry.mode !== "rest") throw new Error("Save a copy of this recovery before changing the collaborative document.");
    if (entry.session.localRevision !== expectedRevision || entry.session.saving) throw new Error("Local text changed or is still saving. Reopen the comparison before applying it.");
    await this.preserve(entry, entry.model.getValue(), "before-recovery");
    entry.session.resolveConflict(content, server.content, server.file.version, expectedRevision);
    entry.applyingExternal = true;
    try {
      entry.model.pushStackElement();
      entry.model.pushEditOperations(null, [{ range: entry.model.getFullModelRange(), text: content }], () => null);
      entry.model.pushStackElement();
    } finally { entry.applyingExternal = false; }
    await entry.session.flush();
  }
  async saveCopy(entry: DocumentEntry, path: string, content: string) {
    const normalized = normalizeWorkspacePath(path);
    if (!normalized || normalized === entry.session.path) throw new Error("Choose a different path for the recovered copy.");
    const file = await api.projects.createFile(this.projectId, normalized, content);
    void Promise.resolve().then(() => this.onSaved?.({ file, content })).catch(() => undefined);
    return file;
  }

  enableCollaboration(entry: DocumentEntry) {
    if (entry.collaboration) return entry.collaboration;
    entry.mode = "collaboration";
    const provider = new CollaborationProvider(this.projectId, entry, () => this.emit(entry));
    entry.collaboration = provider;
    entry.persist = () => provider.persist();
    this.emit(entry);
    return provider;
  }
  async setCollaboration(entry: DocumentEntry, enabled: boolean) {
    if (enabled === (entry.mode === "collaboration")) return;
    await this.flush();
    if (enabled) this.enableCollaboration(entry);
    else {
      entry.collaboration?.dispose(); delete entry.collaboration; delete entry.persist;
      entry.mode = "rest";
      this.emit(entry);
    }
  }
  async flushEntry(entry: DocumentEntry) {
    await entry.collaboration?.ready();
    await entry.session.flush();
    await entry.collaboration?.flush();
  }
  applyExternal(entry: DocumentEntry, content: string) {
    entry.applyingExternal = true;
    try { applyModelContent(entry.model, content); }
    finally { entry.applyingExternal = false; }
  }
  acquire(entry: DocumentEntry): () => void {
    entry.references++; entry.lastAccess = performance.now();
    let released = false;
    return () => { if (released) return; released = true; entry.references--; entry.lastAccess = performance.now(); this.evict(); };
  }
  retain(paths: string[]) { this.retained = new Set(paths.map(normalizeWorkspacePath)); this.evict(); }
  private evict() {
    const candidates = [...this.entries.values()].filter(entry => !entry.references && !this.dirtyEntry(entry) && !entry.session.saving && !entry.draftLoading && !this.retained.has(entry.session.path)).sort((a, b) => a.lastAccess - b.lastAccess);
    while (this.entries.size > this.cacheLimit && candidates.length) {
      const entry = candidates.shift()!; this.entries.delete(entry.session.key); entry.dispose();
    }
  }
  async flush() { await Promise.all([...this.entries.values()].map(entry => this.flushEntry(entry))); }
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closing) return this.closing;
    this.closing = this.closeWhenUnowned().finally(() => { this.closing = undefined; });
    return this.closing;
  }
  private async closeWhenUnowned() {
    // A failed network save must leave a committed local draft before releasing memory.
    await Promise.allSettled([...this.entries.values()].map(entry => this.flushEntry(entry)));
    // React replay or navigation back can reacquire this registry while saves wait.
    // Do not clear the new owner's subscriptions or dispose its working models.
    if (this.owners) return;
    for (;;) {
      const drafts = [...this.entries.values()].map(entry => entry.draftWrites);
      await Promise.all(drafts);
      if (this.owners) return;
      if ([...this.entries.values()].every((entry, index) => entry.draftWrites === drafts[index])) break;
    }
    this.onSaved = undefined;
    this.listeners.clear();
    this.closed = true;
    for (const entry of this.entries.values()) entry.dispose();
    this.entries.clear();
  }
}

export function applyModelContent(model: monaco.editor.ITextModel, next: string) {
  const current = model.getValue(); if (current === next) return;
  let start = 0; const common = Math.min(current.length, next.length);
  while (start < common && current.charCodeAt(start) === next.charCodeAt(start)) start++;
  let end = 0;
  while (end < common - start && current.charCodeAt(current.length - end - 1) === next.charCodeAt(next.length - end - 1)) end++;
  const from = model.getPositionAt(start), to = model.getPositionAt(current.length - end);
  model.applyEdits([{ range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column), text: next.slice(start, next.length - end), forceMoveMarkers: true }]);
}

const registries = new Map<string, DocumentRegistry>();
export function projectDocumentRegistry(projectId: string): DocumentRegistry {
  let registry = registries.get(projectId);
  if (!registry || registry.disposed) { registry = new DocumentRegistry(projectId); registries.set(projectId, registry); }
  return registry;
}
