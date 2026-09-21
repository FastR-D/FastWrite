import type { NavigationRequest } from "../../lib/editor/navigationController";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type MutableRefObject } from "react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import { configureMonaco } from "../../lib/editor/monaco";
import { Button, Checkbox, Icon, icons } from "../ui";
import type { CompletionKind, CompletionResponse, FileContentResponse, SourceLocation, TextSelection } from "@fastwrite/shared";
import { api, ApiClientError } from "../../api/client";
import { type DocumentRegistry } from "../../lib/editor/documentRegistry";
import { DocumentRecoveryDialog } from "../workbench/DocumentRecoveryDialog";
import { completionSuffix } from "./completion";
import { currentTheme, THEME_CHANGE_EVENT } from "../../lib/theme";
type SaveStatus = "saved" | "dirty" | "saving" | "error" | "conflict" | "offline";
type CompletionMetricEvent = "suggested" | "cancelled" | "accepted" | "ignored" | "error";
function recordCompletionMetric(event: CompletionMetricEvent, kind: CompletionKind, latencyMs = 0) {
  const key = "fastwrite.completion.metrics.v1";
  try {
    const current = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, number>;
    current[event] = (current[event] ?? 0) + 1;
    current[`kind.${kind}.${event}`] = (current[`kind.${kind}.${event}`] ?? 0) + 1;
    if (event === "suggested") {
      current.latencySamples = (current.latencySamples ?? 0) + 1;
      current.latencyTotalMs = (current.latencyTotalMs ?? 0) + Math.max(0, Math.round(latencyMs));
    }
    localStorage.setItem(key, JSON.stringify(current));
  } catch {
    // Metrics are best-effort and contain counts/timing only, never paper text.
  }
}

interface SourceEditorProps {
  registry: DocumentRegistry;
  projectId: string;
  document: FileContentResponse;
  targetLine: NavigationRequest | null;
  targetSelection: TextSelection | null;
  onDocumentState: (path: string, dirty: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
  onSelection: (selection: TextSelection | null) => void;
  onCursor: (location: SourceLocation) => void;
}

export interface SourceEditorHandle {
  flush: () => Promise<void>;
}

export const SourceEditor = forwardRef<SourceEditorHandle, SourceEditorProps>(function SourceEditor({ registry, projectId, document, targetLine, targetSelection, onSelection, onCursor, onDirtyChange, onDocumentState }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const decorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const completionDecorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const collaboratorDecorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const disposablesRef = useRef<monaco.IDisposable[]>([]);
  const currentPathRef = useRef("");
  const consumedNavigationRef = useRef<NavigationRequest | null>(null);
  const consumedSelectionRef = useRef<TextSelection | null>(null);
  const sessionsRef = useRef(registry.entries);
  sessionsRef.current = registry.entries;
  const releaseModelRef = useRef<(() => void) | null>(null);
  const activeKeyRef = useRef("");
  const [saveEpoch, setSaveEpoch] = useState(0);
  const onDocumentStateRef = useRef(onDocumentState);
  onDocumentStateRef.current = onDocumentState;
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const completionTimerRef = useRef<number | null>(null);
  const completionAbortRef = useRef<AbortController | null>(null);
  const completionRef = useRef<CompletionResponse | null>(null);
  const documentRef = useRef(document);
  const onSelectionRef = useRef(onSelection);
  const onCursorRef = useRef(onCursor);
  const contentChangeRef = useRef<() => void>(() => undefined);
  const cursorRef = useRef(0);
  const shouldCompleteRef = useRef(false);
  const suppressNextCompletionRef = useRef(false);
  const versionRef = useRef(document.file.version);
  const [editorReady, setEditorReady] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryCount, setRecoveryCount] = useState(0);
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [message, setMessage] = useState("");
  const [completion, setCompletionState] = useState<CompletionResponse | null>(null);
  const [completionLoading, setCompletionLoading] = useState(false);
  const [completionError, setCompletionError] = useState("");
  const [acceptedCompletion, setAcceptedCompletion] = useState<{ from: number; text: string } | null>(null);
  const [completionEnabled, setCompletionEnabled] = useState(() => localStorage.getItem("fastwrite.completion.enabled") !== "false");
  const [collaborationEnabled, setCollaborationEnabled] = useState(() => localStorage.getItem("fastwrite.collaboration.enabled") === "true");
  const [collaborationStatus, setCollaborationStatus] = useState("Initializing collaboration");
  const [collaborators, setCollaborators] = useState<Array<{ clientId: string; name: string; color?: string; path: string; line?: number }>>([]);
  const completionKind: CompletionKind = "auto";

  documentRef.current = document;
  onSelectionRef.current = onSelection;
  onCursorRef.current = onCursor;

  const setCompletion = (next: CompletionResponse | null) => {
    completionRef.current = next;
    setCompletionState(next);
  };
  const cancelCompletion = () => {
    if (completionTimerRef.current) window.clearTimeout(completionTimerRef.current);
    completionTimerRef.current = null;
    if (completionAbortRef.current) {
      completionAbortRef.current.abort();
      recordCompletionMetric("cancelled", completionKind);
    }
    completionAbortRef.current = null;
    setCompletionLoading(false);
  };

  const flush = () => registry.flush();

  useImperativeHandle(ref, () => ({ flush }));

  const update = () => {
    onDirtyChangeRef.current(true);
    onDocumentStateRef.current(currentPathRef.current, true);
    setStatus("dirty");
    cancelCompletion();
    setCompletion(null);
    setCompletionError("");
    shouldCompleteRef.current = !suppressNextCompletionRef.current;
    suppressNextCompletionRef.current = false;
  };
  contentChangeRef.current = update;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    configureMonaco();
    const editor = monaco.editor.create(host, {
      model: null,
      theme: currentTheme() === "dark" ? "fastwrite-github-dark" : "fastwrite-github",
      ariaLabel: `Source editor for ${documentRef.current.file.path}`,
      automaticLayout: true,
      minimap: { enabled: false },
      wordWrap: "on",
      wrappingIndent: "same",
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      roundedSelection: true,
      fontFamily: 'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 22,
      glyphMargin: false,
      folding: false,
      guides: { indentation: false, bracketPairs: true },
      renderLineHighlight: "line",
      renderWhitespace: "selection",
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      stickyScroll: { enabled: false },
      bracketPairColorization: { enabled: false },
      padding: { top: 12, bottom: 18 },
      fixedOverflowWidgets: true,
      contextmenu: true,
      mouseWheelZoom: false
    });
    editorRef.current = editor;
    decorationsRef.current = editor.createDecorationsCollection();
    completionDecorationsRef.current = editor.createDecorationsCollection();
    collaboratorDecorationsRef.current = editor.createDecorationsCollection();
    disposablesRef.current = [
      editor.onDidChangeModelContent(() => {
        if (!sessionsRef.current.get(activeKeyRef.current)?.applyingExternal) contentChangeRef.current();
      }),
      editor.onDidChangeCursorSelection(() => { emitSelection(editor, decorationsRef.current, documentRef.current, versionRef.current, onSelectionRef.current, onCursorRef.current, cursorRef, completionRef, setCompletion, completionAbortRef); })
    ];
    setEditorReady(true);
    const updateTheme = () => monaco.editor.setTheme(currentTheme() === "dark" ? "fastwrite-github-dark" : "fastwrite-github");
    window.addEventListener(THEME_CHANGE_EVENT, updateTheme);
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, updateTheme);

      if (completionTimerRef.current) window.clearTimeout(completionTimerRef.current);
      completionAbortRef.current?.abort();
      disposablesRef.current.forEach((item) => item.dispose());
      decorationsRef.current?.clear();
      completionDecorationsRef.current?.clear();
      collaboratorDecorationsRef.current?.clear();
      const entry = sessionsRef.current.get(activeKeyRef.current);
      if (entry) entry.viewState = editor.saveViewState();
      editor.setModel(null);
      releaseModelRef.current?.();
      releaseModelRef.current = null;
      activeKeyRef.current = "";
      editor.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
  }, []);

  useEffect(() => registry.subscribe(entry => {
    if (entry.session.key !== activeKeyRef.current) return;
    const session = entry.session;
    if (versionRef.current !== session.serverVersion) setSaveEpoch(value => value + 1);
    versionRef.current = session.serverVersion;
    setCollaborators(entry.collaboration?.peers() ?? []);
    const provider = entry.collaboration;
    if (provider) setCollaborationStatus(provider.error ? "Collaboration needs attention" : provider.state === "initializing" ? "Initializing collaboration" : provider.state === "offline" ? "Offline · local changes retained" : registry.dirtyEntry(entry) ? "Local changes · awaiting persistence" : provider.state === "persisted" ? "Persisted to file" : provider.state === "connecting" ? "Connecting" : "Connected");
    setRecoveryCount(entry.recoveries.length);
    const error = session.error ?? entry.collaboration?.error ?? entry.draftError;
    setStatus(error ? error instanceof ApiClientError && error.status === 409 ? "conflict" : !navigator.onLine || error instanceof TypeError ? "offline" : "error" : session.saving ? "saving" : registry.dirtyEntry(entry) ? "dirty" : "saved");
    setMessage(error instanceof Error ? error.message : entry.recoveries.length ? "Saved local drafts are available for comparison." : "");
  }), [registry]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editorReady || !editor) return;
    const key = JSON.stringify([projectId, document.file.path]);
    const pathChanged = activeKeyRef.current !== key;
    const entry = registry.open(document);
    setCollaborationEnabled(entry.mode === "collaboration");
    setRecoveryCount(entry.recoveries.length);
    if (pathChanged) {
      const previous = sessionsRef.current.get(activeKeyRef.current);
      if (previous) previous.viewState = editor.saveViewState();
      const releasePrevious = releaseModelRef.current;
      releaseModelRef.current = registry.acquire(entry);
      releasePrevious?.();
      cancelCompletion();
      setCompletionError("");
      activeKeyRef.current = key;
      currentPathRef.current = document.file.path;
      modelRef.current = entry.model;
      editor.setModel(entry.model);
      if (hostRef.current) { hostRef.current.dataset.modelId = entry.model.id; hostRef.current.dataset.modelUri = entry.model.uri.toString(); }
      if (entry.viewState) editor.restoreViewState(entry.viewState);
      decorationsRef.current?.clear();
      completionDecorationsRef.current?.clear();
      setAcceptedCompletion(null);
    }
    editor.updateOptions({ ariaLabel: `Source editor for ${document.file.path}` });
    versionRef.current = entry.session.serverVersion;
    setStatus(entry.session.error ? "error" : entry.session.saving ? "saving" : registry.dirtyEntry(entry) ? "dirty" : "saved");
    setMessage(entry.session.error instanceof Error ? entry.session.error.message : "");
    setCompletion(null);

    if (!shouldCompleteRef.current || !completionEnabled) return;
    shouldCompleteRef.current = false;
    const expected = { path: document.file.path, cursor: cursorRef.current, fileVersion: versionRef.current, kind: completionKind };
    completionTimerRef.current = window.setTimeout(async () => {
      const controller = new AbortController();
      const startedAt = performance.now();
      completionAbortRef.current = controller;
      setCompletionLoading(true);
      setCompletionError("");
      try {
        const result = await api.completions.suggest(projectId, expected, controller.signal);
        if (result.suggestion && result.path === currentPathRef.current && result.fileVersion === versionRef.current && result.cursor === cursorRef.current) {
          setCompletion(result);
          recordCompletionMetric("suggested", result.kind, performance.now() - startedAt);
        }
      } catch (error) {
        const stillCurrent = expected.path === currentPathRef.current && expected.fileVersion === versionRef.current && expected.cursor === cursorRef.current;
        if (stillCurrent && (error as DOMException).name !== "AbortError" && !(error instanceof ApiClientError && error.status === 409)) {
          setCompletionError(error instanceof Error ? error.message : "Completion unavailable");
          recordCompletionMetric("error", completionKind);
        }
      } finally {
        if (completionAbortRef.current === controller) {
          completionAbortRef.current = null;
          setCompletionLoading(false);
        }
      }
    }, 500);
  }, [completionEnabled, document.content, document.file.path, document.file.version, editorReady, projectId, saveEpoch, registry, collaborationEnabled]);

  useEffect(() => {
    const reconnect = () => { for (const { session } of sessionsRef.current.values()) if (session.dirty) void session.flush().catch(() => undefined); };
    window.addEventListener("online", reconnect);
    return () => window.removeEventListener("online", reconnect);
  }, [status]);

  useEffect(() => {
    const entry = registry.get(document.file.path), editor = editorRef.current;
    if (!editorReady || !editor || !entry?.collaboration) return;
    return entry.collaboration.attachEditor(editor);
  }, [registry, document.file.path, editorReady, collaborationEnabled]);

  useEffect(() => {
    const model = modelRef.current; const decorations = collaboratorDecorationsRef.current;
    if (!model || !decorations || !collaborationEnabled) { decorations?.clear(); return; }
    decorations.set(collaborators.filter((item) => item.path === document.file.path && item.line).map((item) => { const lineNumber = Math.max(1, Math.min(item.line!, model.getLineCount())); return { range: new monaco.Range(lineNumber, 1, lineNumber, 1), options: { isWholeLine: true, className: "fastwrite-remote-line", glyphMarginClassName: "fastwrite-remote-cursor", hoverMessage: { value: `${item.name} is editing here` }, before: { content: `${item.name} `, inlineClassName: "fastwrite-remote-label" } } }; }));
  }, [collaborationEnabled, collaborators, document.file.path, document.file.version, editorReady]);

  useEffect(() => {
    const model = modelRef.current;
    const decorations = completionDecorationsRef.current;
    const next = completion;
    if (!model || !decorations || !next || next.path !== currentPathRef.current || next.fileVersion !== versionRef.current || next.cursor !== cursorRef.current) {
      decorations?.clear();
      return;
    }
    const position = model.getPositionAt(next.cursor);
    const suffix = completionSuffix(next.suggestion, model.getValueInRange(new monaco.Range(1, 1, position.lineNumber, position.column)));
    if (!suffix) {
      decorations.clear();
      return;
    }
    decorations.set([{
      range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
      options: {
        after: { content: suffix, inlineClassName: "fastwrite-monaco-completion" },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
      }
    }]);
  }, [completion, document.content, document.file.path, document.file.version, editorReady]);

  useEffect(() => {
    const editor = editorRef.current;
    const model = modelRef.current;
    if (!editor || !model || !targetLine || targetLine.projectId !== projectId || targetLine.path !== currentPathRef.current || consumedNavigationRef.current === targetLine) return;
    consumedNavigationRef.current = targetLine;
    const safeLine = Math.min(Math.max(1, targetLine.line), model.getLineCount());
    editor.setPosition({ lineNumber: safeLine, column: 1 });
    editor.revealLineInCenter(safeLine);
    editor.focus();
  }, [projectId, document.file.path, editorReady, targetLine]);

  useEffect(() => {
    const editor = editorRef.current;
    const model = modelRef.current;
    if (!editor || !model || !targetSelection || targetSelection.path !== currentPathRef.current || consumedSelectionRef.current === targetSelection) return;
    const from = Math.max(0, Math.min(targetSelection.from, model.getValueLength()));
    const to = Math.max(from, Math.min(targetSelection.to, model.getValueLength()));
    const range = rangeFromOffsets(model, from, to);
    if (model.getValueInRange(range) !== targetSelection.text || targetSelection.fileVersion !== versionRef.current) return;
    consumedSelectionRef.current = targetSelection;
    editor.setSelection(range);
    editor.revealRangeInCenter(range);
    showPersistentSelection(decorationsRef.current, range);
  }, [document.content, document.file.path, document.file.version, editorReady, targetSelection]);

  const acceptCompletion = () => {
    const next = completionRef.current;
    const editor = editorRef.current;
    const model = modelRef.current;
    if (!next || !editor || !model || next.path !== currentPathRef.current || next.fileVersion !== versionRef.current || next.cursor !== cursorRef.current) return;
    suppressNextCompletionRef.current = true;
    const suffix = completionSuffix(next.suggestion, model.getValueInRange(new monaco.Range(1, 1, model.getPositionAt(next.cursor).lineNumber, model.getPositionAt(next.cursor).column)));
    if (!suffix) { ignoreCompletion(); return; }
    setAcceptedCompletion({ from: next.cursor, text: suffix });
    recordCompletionMetric("accepted", next.kind);
    setCompletion(null);
    const position = model.getPositionAt(next.cursor);
    editor.executeEdits("fastwrite-completion", [{ range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: suffix, forceMoveMarkers: true }]);
    editor.pushUndoStop();
    const end = model.getPositionAt(next.cursor + suffix.length);
    editor.setPosition(end);
    editor.focus();
  };

  const undoCompletion = () => {
    const accepted = acceptedCompletion;
    const editor = editorRef.current;
    const model = modelRef.current;
    if (!accepted || !editor || !model) return;
    const range = rangeFromOffsets(model, accepted.from, accepted.from + accepted.text.length);
    if (model.getValueInRange(range) !== accepted.text) return;
    suppressNextCompletionRef.current = true;
    editor.executeEdits("fastwrite-completion-undo", [{ range, text: "", forceMoveMarkers: true }]);
    editor.pushUndoStop();
    editor.setPosition(model.getPositionAt(accepted.from));
    setAcceptedCompletion(null);
    editor.focus();
  };

  const ignoreCompletion = () => {
    const ignored = completionRef.current;
    if (ignored) recordCompletionMetric("ignored", ignored.kind);
    setCompletion(null);
  };

  const changeCompletionEnabled = (enabled: boolean) => {
    setCompletionEnabled(enabled);
    localStorage.setItem("fastwrite.completion.enabled", String(enabled));
    if (!enabled) {
      shouldCompleteRef.current = false;
      cancelCompletion();
      setCompletion(null);
    }
  };

  return (
    <div className="source-editor" onKeyDownCapture={(event) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Tab" && completionRef.current) { event.preventDefault(); event.stopPropagation(); acceptCompletion(); }
      if (event.key === "Escape" && completionRef.current) { event.preventDefault(); event.stopPropagation(); ignoreCompletion(); }

    }}>
      <div className="editor-toolbar">
        <div className="editor-toolbar__file"><span>{document.file.name}</span><code>{document.file.path}</code></div>
        <div className="editor-toolbar__actions">
          <Checkbox id="completion-enabled" name="completion-enabled" variant="pill" icon={completionLoading ? <Icon name={icons.loading} spin /> : <Icon name={icons.sparkle} />} checked={completionEnabled} onChange={changeCompletionEnabled} title={completionError || "Skill-guided writing completion"}>
            Complete
          </Checkbox>
        <Checkbox id="collaboration-enabled" name="collaboration-enabled" variant="pill" checked={collaborationEnabled} onChange={(enabled) => {
          const entry = registry.get(document.file.path);
          if (entry) void registry.setCollaboration(entry, enabled).then(() => { setCollaborationEnabled(enabled); localStorage.setItem("fastwrite.collaboration.enabled", String(enabled)); }).catch(error => { setStatus("error"); setMessage(error instanceof Error ? error.message : "Could not switch synchronization mode"); });
        }} title="Synchronize this file through Yjs collaboration">Collaborate{collaborators.length ? ` · ${collaborators.length}` : ""}</Checkbox>
          {acceptedCompletion ? <Button variant="ghost" className="editor-undo-completion" type="button" onClick={undoCompletion} icon={<Icon name={icons.discard} />}>Undo completion</Button> : null}
          {collaborationEnabled ? <span className="collaboration-status" role="status">{collaborationStatus}</span> : null}
          <Button variant="secondary" type="button" onClick={() => { cancelCompletion(); setCompletion(null); setRecoveryOpen(true); }}>Compare / recover{recoveryCount ? ` (${recoveryCount})` : ""}</Button>
          <SaveIndicator status={status} />
        </div>
      </div>
      <div ref={hostRef} className="monaco-editor-host" />
      {recoveryOpen && registry.get(document.file.path) ? <DocumentRecoveryDialog registry={registry} entry={registry.get(document.file.path)!} onClose={() => setRecoveryOpen(false)} /> : null}
      {completion ? <span className="sr-only" role="status">Writing suggestion available. Press Tab to accept or Escape to ignore.</span> : null}
      {message ? <div className={`editor-message editor-message--${status}`} role="alert"><Icon name={icons.info} /> {message}</div> : null}
    </div>
  );
});

function emitSelection(
  editor: monaco.editor.IStandaloneCodeEditor,
  decorations: monaco.editor.IEditorDecorationsCollection | null,
  document: FileContentResponse,
  fileVersion: number,
  onSelection: (selection: TextSelection | null) => void,
  onCursor: (location: SourceLocation) => void,
  cursorRef: MutableRefObject<number>,
  completionRef: MutableRefObject<CompletionResponse | null>,
  setCompletion: (next: CompletionResponse | null) => void,
  completionAbortRef: MutableRefObject<AbortController | null>
) {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection) return;
  const cursor = model.getOffsetAt({ lineNumber: selection.positionLineNumber, column: selection.positionColumn });
  cursorRef.current = cursor;
  completionAbortRef.current?.abort();
  if (completionRef.current && completionRef.current.cursor !== cursor) setCompletion(null);
  onCursor({ path: document.file.path, line: selection.positionLineNumber, column: selection.positionColumn });
  if (selection.isEmpty()) {
    decorations?.clear();
    onSelection(null);
    return;
  }
  const range = new monaco.Range(selection.startLineNumber, selection.startColumn, selection.endLineNumber, selection.endColumn);
  const from = model.getOffsetAt(range.getStartPosition());
  const to = model.getOffsetAt(range.getEndPosition());
  const text = model.getValueInRange(range);
  if (!text) { onSelection(null); return; }
  showPersistentSelection(decorations, range);
  onSelection({ path: document.file.path, text, from, to, startLine: range.startLineNumber, endLine: range.endLineNumber, fileVersion });
}

function showPersistentSelection(decorations: monaco.editor.IEditorDecorationsCollection | null, range: monaco.Range) {
  decorations?.set([{ range, options: { inlineClassName: "fastwrite-monaco-selection", stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } }]);
}

function rangeFromOffsets(model: monaco.editor.ITextModel, from: number, to: number): monaco.Range {
  const start = model.getPositionAt(Math.max(0, Math.min(from, model.getValueLength())));
  const end = model.getPositionAt(Math.max(0, Math.min(to, model.getValueLength())));
  return new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);
}

function SaveIndicator({ status }: { status: SaveStatus }) {
  const content = {
    saved: [<Icon key="icon" name={icons.check} />, "Saved"], dirty: [<Icon key="icon" name={icons.circleFilled} />, "Unsaved"], saving: [<Icon key="icon" name={icons.loading} spin />, "Saving"], error: [<Icon key="icon" name={icons.info} />, "Save failed"], conflict: [<Icon key="icon" name={icons.info} />, "Conflict"], offline: [<Icon key="icon" name={icons.circleFilled} />, "Offline - queued"]
  }[status];
  return <span className={`save-indicator save-indicator--${status}`}>{content}</span>;
}
