import * as Y from "yjs";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import { IndexeddbPersistence } from "y-indexeddb";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { readSyncMessage, writeSyncStep1, writeUpdate, messageYjsSyncStep2 } from "y-protocols/sync";
import { api } from "../../api/client";
import type { DocumentEntry } from "./documentRegistry";

const LOCAL = Symbol("local-monaco-edit");
const REMOTE = Symbol("remote-update");
export type CollaborationState = "initializing" | "cached" | "connecting" | "synced" | "persisted" | "offline" | "conflict";

/** A project document owns this provider; mounted editors only borrow bindings. */
export class CollaborationProvider {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  readonly undoManager = new Y.UndoManager(this.doc.getText("content"), { trackedOrigins: new Set([LOCAL]) });
  state: CollaborationState = "initializing";
  error: unknown = null;
  private documentId: string | undefined;
  private persistence: IndexeddbPersistence | undefined;
  private socket: WebSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private localRevision = 0;
  private persistedRevision = 0;
  private persistTail: Promise<unknown> = Promise.resolve();
  private metadataTimer: ReturnType<typeof setTimeout> | undefined;
  get dirty() { return this.localRevision > this.persistedRevision; }
  private attempts = 0;
  private connecting = false;
  private selections = new Map<monaco.editor.IStandaloneCodeEditor, { anchor: Y.RelativePosition; head: Y.RelativePosition }>();
  private disposed = false;
  private initialized = false;
  private applying = false;
  private initializing: Promise<void> | undefined;
  private editors = new Set<monaco.editor.IStandaloneCodeEditor>();
  private modelSubscription: monaco.IDisposable;
  private readonly initialContent: string;
  private readonly clientId = crypto.randomUUID();

  constructor(readonly projectId: string, readonly entry: DocumentEntry, private readonly changed: () => void) {
    this.initialContent = entry.model.getValue();
    this.modelSubscription = entry.model.onDidChangeContent(event => {
      if (this.applying || entry.applyingExternal) return;
      if (this.initialized) {
        this.applying = true;
        try { this.doc.transact(() => {
        const text = this.doc.getText("content");
        for (const change of [...event.changes].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
          if (change.rangeLength) text.delete(change.rangeOffset, change.rangeLength);
          if (change.text) text.insert(change.rangeOffset, change.text);
        }
      }, LOCAL); } finally { this.applying = false; }
      }
      // Before initialization, preserve text in the same durable draft queue. No REST fallback.
      entry.session.edit(entry.model.getValue());
    });
    this.doc.getText("content").observe(this.onText);
    this.doc.on("update", this.onUpdate);
    this.doc.on("beforeAllTransactions", this.captureSelections);
    this.awareness.on("update", this.onAwareness);
    window.addEventListener("online", this.online);
    void this.ready().catch(() => undefined);
  }

  ready(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Collaboration provider is closed"));
    if (this.initialized) return Promise.resolve();
    if (this.initializing) return this.initializing;
    this.initializing = this.initialize().catch(error => {
      this.error = error; this.state = navigator.onLine ? "conflict" : "offline"; this.changed(); throw error;
    }).finally(() => { this.initializing = undefined; });
    return this.initializing;
  }
  private async initialize() {
    const state = await api.projects.collaboration(this.projectId, this.entry.session.path);
    if (this.disposed) return;
    if (this.documentId && this.documentId !== state.documentId) throw new Error("The collaboration document was replaced. Local text is retained for comparison.");
    if (state.fileVersion < this.entry.session.serverVersion) throw new Error("The file changed outside collaboration. Local text is retained; compare before reconnecting.");
    this.documentId = state.documentId;
    if (!this.persistence) this.persistence = new IndexeddbPersistence(`fastwrite-collaboration:${this.projectId}:${state.documentId}`, this.doc);
    await this.persistence.whenSynced;
    if (this.disposed) return;
    Y.applyUpdate(this.doc, fromBase64(state.update), REMOTE);
    const text = this.doc.getText("content");
    const pending = this.entry.model.getValue();
    if (pending !== this.initialContent) {
      if (text.toString() !== this.initialContent) throw new Error("Local input and the collaborative document both changed during initialization. Local text is retained for comparison.");
      // Reconcile only the changed range, retaining CRDT identities for untouched text.
      let start = 0, end = 0;
      while (start < Math.min(pending.length, this.initialContent.length) && pending[start] === this.initialContent[start]) start++;
      while (end < Math.min(pending.length, this.initialContent.length) - start && pending[pending.length - end - 1] === this.initialContent[this.initialContent.length - end - 1]) end++;
      this.doc.transact(() => { text.delete(start, this.initialContent.length - start - end); text.insert(start, pending.slice(start, pending.length - end)); }, LOCAL);
    }
    this.initialized = true;
    // Cached updates can be textually identical while carrying new CRDT identities/deletes.
    // Confirm the entire recovered state even when DocumentSession has no textual edit.
    this.localRevision++;
    clearTimeout(this.metadataTimer);
    this.metadataTimer = setTimeout(() => {
      if (this.dirty && !this.entry.session.dirty && !this.entry.session.saving) void this.persist().catch(error => { this.error = error; this.changed(); });
    }, 850);
    this.replaceModel(text.toString());
    this.entry.session.edit(text.toString());
    this.state = "cached"; this.error = null; this.changed();
    void this.connect();
  }

  private replaceModel(content: string) {
    const model = this.entry.model;
    if (model.getValue() === content) return;
    this.applying = this.entry.applyingExternal = true;
    try { model.applyEdits([{ range: model.getFullModelRange(), text: content }]); }
    finally { this.applying = this.entry.applyingExternal = false; }
  }
  // Y.Text delta calculation can create internal transactions. Capture once for the whole batch.
  private captureSelections = () => {
    if (!this.initialized || this.applying) return;
    this.selections.clear();
    const text = this.doc.getText("content");
    for (const editor of this.editors) {
      if (editor.getModel() !== this.entry.model) continue;
      const selection = editor.getSelection(); if (!selection) continue;
      this.selections.set(editor, {
        anchor: Y.createRelativePositionFromTypeIndex(text, this.entry.model.getOffsetAt(selection.getSelectionStart())),
        head: Y.createRelativePositionFromTypeIndex(text, this.entry.model.getOffsetAt(selection.getPosition())),
      });
    }
  };
  private restoreSelections = () => {
    this.applying = true;
    try {
      for (const [editor, selection] of this.selections) {
        if (editor.getModel() !== this.entry.model) continue;
        const anchor = Y.createAbsolutePositionFromRelativePosition(selection.anchor, this.doc);
        const head = Y.createAbsolutePositionFromRelativePosition(selection.head, this.doc);
        if (!anchor || !head) continue;
        const start = this.entry.model.getPositionAt(anchor.index), end = this.entry.model.getPositionAt(head.index);
        editor.setSelection(new monaco.Selection(start.lineNumber, start.column, end.lineNumber, end.column));
      }
    } finally { this.selections.clear(); this.applying = false; }
  };
  private onText = (event: Y.YTextEvent, transaction: Y.Transaction) => {
    if (!this.initialized || transaction.origin === LOCAL) return;
    const model = this.entry.model;
    const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
    let offset = 0;
    for (const delta of event.delta) {
      if (delta.retain) offset += delta.retain;
      else if (delta.delete) {
        const start = model.getPositionAt(offset), end = model.getPositionAt(offset + delta.delete);
        edits.push({ range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), text: "" });
        offset += delta.delete;
      } else if (typeof delta.insert === "string") {
        const position = model.getPositionAt(offset);
        edits.push({ range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: delta.insert });
      }
    }
    this.applying = this.entry.applyingExternal = true;
    try { model.applyEdits(edits); this.restoreSelections(); }
    finally { this.applying = this.entry.applyingExternal = false; }
    this.entry.session.edit(model.getValue());
    this.changed();
  };
  private onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE || !this.initialized && origin !== LOCAL) return;
    this.localRevision++;
    clearTimeout(this.metadataTimer);
    this.metadataTimer = setTimeout(() => {
      if (this.dirty && !this.entry.session.dirty && !this.entry.session.saving) void this.persist().catch(error => { this.error = error; this.changed(); });
    }, 850);
    if (!this.initialized) return;
    this.state = this.socket?.readyState === WebSocket.OPEN ? "cached" : "offline";
    if (this.socket?.readyState === WebSocket.OPEN) {
      const encoder = encoding.createEncoder(); encoding.writeVarUint(encoder, 0); writeUpdate(encoder, update); this.socket.send(encoding.toUint8Array(encoder));
    }
    this.changed();
  };
  private onAwareness = (_changes: unknown, origin: unknown) => {
    if (origin !== REMOTE && this.socket?.readyState === WebSocket.OPEN) {
      const encoder = encoding.createEncoder(); encoding.writeVarUint(encoder, 1); encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(this.awareness, [this.doc.clientID])); this.socket.send(encoding.toUint8Array(encoder));
    }
    this.changed();
  };
  private online = () => { void this.ready().then(() => { void this.connect(); return this.entry.session.flush(); }).catch(() => undefined); };
  private async connect() {
    if (this.disposed || this.connecting || this.socket && this.socket.readyState < WebSocket.CLOSING) return;
    this.connecting = true;
    this.state = "connecting"; this.changed();
    try {
      const state = await api.projects.collaboration(this.projectId, this.entry.session.path);
      if (this.disposed) return;
      if (state.documentId !== this.documentId) { this.state = "conflict"; this.error = new Error("The collaboration document was replaced. Local text is retained for comparison."); this.changed(); return; }
      Y.applyUpdate(this.doc, fromBase64(state.update), REMOTE);
      const grant = await api.projects.collaborationToken(this.projectId, this.entry.session.path);
      if (this.disposed) return;
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${location.host}/api/collaboration/socket?clientId=${this.clientId}&token=${encodeURIComponent(grant.token)}`);
      this.socket = socket; socket.binaryType = "arraybuffer";
      socket.onopen = () => { this.attempts = 0; const encoder = encoding.createEncoder(); encoding.writeVarUint(encoder, 0); writeSyncStep1(encoder, this.doc); socket.send(encoding.toUint8Array(encoder)); this.onAwareness(null, LOCAL); };
      socket.onmessage = event => {
        if (this.disposed || this.socket !== socket || !(event.data instanceof ArrayBuffer)) return;
        try {
          const decoder = decoding.createDecoder(new Uint8Array(event.data)); const type = decoding.readVarUint(decoder);
          if (type === 0) {
            const reply = encoding.createEncoder(); encoding.writeVarUint(reply, 0);
            const sync = readSyncMessage(decoder, reply, this.doc, REMOTE);
            if (encoding.length(reply) > 1) socket.send(encoding.toUint8Array(reply));
            if (sync === messageYjsSyncStep2) { this.state = "synced"; this.error = null; this.changed(); }
          } else if (type === 1) applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), REMOTE);
          else socket.close(1003, "Invalid collaboration message");
        } catch { socket.close(1003, "Invalid collaboration update"); }
      };
      socket.onclose = () => { if (this.socket === socket) { this.socket = undefined; this.scheduleReconnect(); } };
    } catch (error) { this.error = error; this.scheduleReconnect(); }
    finally { this.connecting = false; }
  }
  private scheduleReconnect() {
    if (this.disposed || this.reconnectTimer) return;
    this.state = "offline"; this.changed();
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; void this.connect(); }, Math.min(1000 * 2 ** this.attempts++, 30000));
  }

  async persist() {
    await this.ready();
    if (this.disposed || !this.documentId || this.state === "conflict") throw this.error ?? new Error("Collaboration is unavailable");
    const update = toBase64(Y.encodeStateAsUpdate(this.doc));
    const revision = this.localRevision, documentId = this.documentId;
    const operation = this.persistTail.catch(() => undefined).then(async () => {
      const result = await api.projects.collaborationPersist(this.projectId, { path: this.entry.session.path, documentId, update });
      if (!this.disposed) {
        Y.applyUpdate(this.doc, fromBase64(result.update), REMOTE);
        this.persistedRevision = Math.max(this.persistedRevision, revision);
        this.state = this.dirty ? "cached" : "persisted"; this.error = null; this.changed();
      }
      return { file: { ...this.entry.file, version: result.fileVersion } };
    });
    this.persistTail = operation;
    return operation;
  }
  async flush() { await this.ready(); if (this.dirty) await this.persist(); }
  attachEditor(editor: monaco.editor.IStandaloneCodeEditor) {
    this.editors.add(editor);
    const cursor = editor.onDidChangeCursorSelection(() => {
      if (!this.initialized || this.applying || editor.getModel() !== this.entry.model) return;
      const selection = editor.getSelection(); if (!selection) return;
      const text = this.doc.getText("content"), model = this.entry.model;
      this.awareness.setLocalStateField("cursor", { anchor: toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, model.getOffsetAt(selection.getSelectionStart())))), head: toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, model.getOffsetAt(selection.getPosition())))) });
    });
    const keys = editor.onKeyDown(event => {
      if (event.browserEvent.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.browserEvent.key.toLowerCase();
      if (key !== "z" && key !== "y") return;
      event.preventDefault(); event.stopPropagation();
      this.undoManager[key === "y" || event.shiftKey ? "redo" : "undo"]();
    });
    return () => { cursor.dispose(); keys.dispose(); this.editors.delete(editor); };
  }
  peers() {
    return [...this.awareness.getStates()].filter(([id]) => id !== this.doc.clientID).flatMap(([id, state]) => {
      if (typeof state.user?.name !== "string") return [];
      let offset: number | undefined;
      try { if (typeof state.cursor?.head === "string") offset = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromBase64(state.cursor.head)), this.doc)?.index; } catch { /* Invalid remote cursor has no position. */ }
      return [{ clientId: String(id), name: state.user.name as string, path: this.entry.session.path, ...(offset === undefined ? {} : { line: this.entry.model.getPositionAt(offset).lineNumber }) }];
    });
  }
  dispose() {
    this.disposed = true; clearTimeout(this.reconnectTimer); clearTimeout(this.metadataTimer); window.removeEventListener("online", this.online);
    this.modelSubscription.dispose(); this.doc.getText("content").unobserve(this.onText); this.doc.off("update", this.onUpdate);
    this.doc.off("beforeAllTransactions", this.captureSelections);
    this.awareness.off("update", this.onAwareness); this.awareness.destroy(); this.undoManager.destroy();
    this.socket?.close(); void this.persistence?.destroy(); this.doc.destroy(); this.editors.clear();
  }
}
function toBase64(bytes: Uint8Array) { let value = ""; for (const byte of bytes) value += String.fromCharCode(byte); return btoa(value); }
function fromBase64(value: string) { return Uint8Array.from(atob(value), character => character.charCodeAt(0)); }
