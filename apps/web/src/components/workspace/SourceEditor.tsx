import { userFacingError } from "../../lib/notifications";
import type { CommentThreadView, ReferenceSelection } from "@fastwrite/shared";
import type { NavigationRequest } from "../../lib/editor/navigationController";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type MutableRefObject } from "react";
import * as monaco from "../../lib/editor/monacoRuntime";
import { compactGutterOptions, configureMonaco } from "../../lib/editor/monaco";
import { ReviewEditor } from "./ReviewEditor";
import type { ProjectAccess } from "@fastwrite/shared";
import { Icon, icons } from "../ui";
import type { CompletionKind, CompletionResponse, FileContentResponse, SourceLocation, TextSelection } from "@fastwrite/shared";
import { api, ApiClientError } from "../../api/client";
import { type DocumentRegistry } from "../../lib/editor/documentRegistry";
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

export type WritingMode = "editing" | "reviewing" | "viewing";
interface SourceEditorProps {
  writingMode?: WritingMode | "auto";
  onModeChange?: (mode: WritingMode) => void;
  comments?: CommentThreadView[];
  activeCommentId?: string;
  onCommentClick?: (id: string) => void;
  onReviewSaved?: () => void;
  references?: ReferenceSelection[];
  completionEnabled: boolean;
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

export const SourceEditor = forwardRef<SourceEditorHandle, SourceEditorProps>(function SourceEditor({ writingMode = "auto", comments = [], activeCommentId, onCommentClick, onReviewSaved, onModeChange, references, completionEnabled: completionsEnabled, registry, projectId, document, targetLine, targetSelection, onSelection, onCursor, onDirtyChange, onDocumentState }, ref) {
  const [access, setAccess] = useState<ProjectAccess | null>(null);
  const defaultMode = access?.canWrite ? "editing" : access?.canComment ? "reviewing" : "viewing";
  const mode = writingMode === "auto" || (writingMode === "editing" && !access?.canWrite) || (writingMode === "reviewing" && !access?.canComment) ? defaultMode : writingMode;
  useEffect(() => { onModeChange?.(mode); }, [mode, onModeChange]);
  const completionEnabled = completionsEnabled && mode === "editing";
  const reviewRef = useRef<{ flush: () => Promise<void> }>(null);
  const modeRef = useRef(mode); modeRef.current = mode;
  const commentRef = useRef({ comments, onCommentClick }); commentRef.current = { comments, onCommentClick };
  const commentDecorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const [readOnly, setReadOnly] = useState(true);
  const referenceKey = JSON.stringify(references ?? []);
  const referenceKeyRef = useRef(referenceKey);
  referenceKeyRef.current = referenceKey;
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
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [message, setMessage] = useState("");
  const [completion, setCompletionState] = useState<CompletionResponse | null>(null);
  const [completionLoading, setCompletionLoading] = useState(false);
  const [completionError, setCompletionError] = useState("");
  const [collaborationEnabled, setCollaborationEnabled] = useState(() => localStorage.getItem("fastwrite.collaboration.enabled") === "true");
  const [collaborators, setCollaborators] = useState<Array<{ clientId: string; name: string; color?: string; path: string; line?: number; offset?: number; anchor?: number }>>([]);
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
  useEffect(() => { cancelCompletion(); setCompletion(null); setCompletionError(""); }, [referenceKey]);

  const flush = async () => { await registry.flush(); if (mode === "reviewing") await reviewRef.current?.flush(); };

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
      readOnly: true,
      theme: currentTheme() === "dark" ? "fastwrite-github-dark" : "fastwrite-github",
      ariaLabel: `源文件编辑器： ${documentRef.current.file.path}`,
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
      ...compactGutterOptions,
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
    commentDecorationsRef.current = editor.createDecorationsCollection();
    disposablesRef.current = [
      editor.onMouseDown(event => {
        if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS || !event.target.position) return;
        const model = editor.getModel(); if (!model) return;
        const thread = commentRef.current.comments.find(item => item.path === currentPathRef.current && item.status !== "resolved" && item.from !== undefined && model.getPositionAt(item.from).lineNumber === event.target.position!.lineNumber);
        if (thread) commentRef.current.onCommentClick?.(thread.id);
      }),
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
      commentDecorationsRef.current?.clear();
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
    setAccess(entry.access ?? null);
    setReadOnly(entry.readOnly);
    editorRef.current?.updateOptions({ readOnly: entry.readOnly || modeRef.current !== "editing" });
    if (versionRef.current !== session.serverVersion) setSaveEpoch(value => value + 1);
    versionRef.current = session.serverVersion;
    setCollaborators(entry.collaboration?.peers() ?? []);
    setCollaborationEnabled(entry.mode === "collaboration");
    const error = session.error ?? entry.collaboration?.error ?? entry.draftError;
    setStatus(error ? error instanceof ApiClientError && error.status === 409 ? "conflict" : !navigator.onLine || error instanceof TypeError ? "offline" : "error" : session.saving ? "saving" : registry.dirtyEntry(entry) ? "dirty" : "saved");
    setMessage(userFacingError(error, ""));
  }), [registry]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editorReady || !editor) return;
    const key = JSON.stringify([projectId, document.file.path]);
    const pathChanged = activeKeyRef.current !== key;
    const entry = registry.open(document);
    setCollaborationEnabled(entry.mode === "collaboration");
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
    }
    setAccess(entry.access ?? null);
    setReadOnly(entry.readOnly);
    editor.updateOptions({ readOnly: entry.readOnly || modeRef.current !== "editing", ariaLabel: `源文件编辑器： ${document.file.path}` });
    versionRef.current = entry.session.serverVersion;
    setStatus(entry.session.error ? "error" : entry.session.saving ? "saving" : registry.dirtyEntry(entry) ? "dirty" : "saved");
    setMessage(userFacingError(entry.session.error, ""));
    setCompletion(null);

    if (entry.readOnly || !shouldCompleteRef.current || !completionEnabled) return;
    shouldCompleteRef.current = false;
    const expected = { ...(references ? { references } : {}), path: document.file.path, cursor: cursorRef.current, fileVersion: versionRef.current, kind: completionKind };
    completionTimerRef.current = window.setTimeout(async () => {
      const controller = new AbortController();
      const startedAt = performance.now();
      completionAbortRef.current = controller;
      setCompletionLoading(true);
      setCompletionError("");
      try {
        const result = await api.completions.suggest(projectId, expected, controller.signal);
        if (!controller.signal.aborted && referenceKey === referenceKeyRef.current && result.suggestion && result.path === currentPathRef.current && result.fileVersion === versionRef.current && result.cursor === cursorRef.current) {
          setCompletion(result);
          recordCompletionMetric("suggested", result.kind, performance.now() - startedAt);
        }
      } catch (error) {
        const stillCurrent = expected.path === currentPathRef.current && expected.fileVersion === versionRef.current && expected.cursor === cursorRef.current;
        if (stillCurrent && (error as DOMException).name !== "AbortError" && !(error instanceof ApiClientError && error.status === 409)) {
          setCompletionError(userFacingError(error, "补全暂不可用"));
          recordCompletionMetric("error", completionKind);
        }
      } finally {
        if (completionAbortRef.current === controller) {
          completionAbortRef.current = null;
          setCompletionLoading(false);
        }
      }
    }, 500);
  }, [completionEnabled, document.content, document.file.path, document.file.version, editorReady, projectId, saveEpoch, registry, collaborationEnabled, referenceKey]);

  useEffect(() => { editorRef.current?.updateOptions({ readOnly: readOnly || mode !== "editing" }); onSelectionRef.current(null); }, [mode, readOnly]);

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
    const palette = ["#2563eb", "#059669", "#c2410c", "#7c3aed", "#be123c"];
    decorations.set(collaborators.filter(item => item.path === document.file.path && item.offset !== undefined).flatMap(item => {
      const head = model.getPositionAt(item.offset!);
      const color = Math.max(0, palette.indexOf(item.color ?? ""));
      const caret = { range: new monaco.Range(head.lineNumber, head.column, head.lineNumber, head.column), options: { beforeContentClassName: `fastwrite-remote-caret remote-color-${color}`, hoverMessage: { value: `${item.name} 正在此处阅读或编辑` }, showIfCollapsed: true, stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } };
      if (item.anchor === undefined || item.anchor === item.offset) return [caret];
      const from = model.getPositionAt(Math.min(item.anchor, item.offset!)), to = model.getPositionAt(Math.max(item.anchor, item.offset!));
      return [caret, { range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column), options: { className: `fastwrite-remote-selection remote-color-${color}`, hoverMessage: { value: item.name } } }];
    }));
  }, [collaborationEnabled, collaborators, document.file.path, document.file.version, editorReady]);

  useEffect(() => {
    const model = modelRef.current, decorations = commentDecorationsRef.current;
    if (!model || !decorations) return;
    decorations.set(comments.filter(thread => thread.path === document.file.path && thread.status !== "resolved" && thread.from !== undefined && thread.to !== undefined).map(thread => ({
      range: rangeFromOffsets(model, thread.from!, thread.to!),
      options: { inlineClassName: thread.id === activeCommentId ? "fastwrite-comment-range is-active" : "fastwrite-comment-range", linesDecorationsClassName: "fastwrite-comment-glyph", linesDecorationsTooltip: thread.messages[0]?.body ?? "查看讨论", stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges }
    })));
  }, [comments, activeCommentId, document.file.path, editorReady]);

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
        showIfCollapsed: true,
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
    if (readOnly || mode !== "editing" || !next || !editor || !model || next.path !== currentPathRef.current || next.fileVersion !== versionRef.current || next.cursor !== cursorRef.current) return;
    suppressNextCompletionRef.current = true;
    const suffix = completionSuffix(next.suggestion, model.getValueInRange(new monaco.Range(1, 1, model.getPositionAt(next.cursor).lineNumber, model.getPositionAt(next.cursor).column)));
    if (!suffix) { ignoreCompletion(); return; }
    recordCompletionMetric("accepted", next.kind);
    setCompletion(null);
    const position = model.getPositionAt(next.cursor);
    editor.executeEdits("fastwrite-completion", [{ range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: suffix, forceMoveMarkers: true }]);
    editor.pushUndoStop();
    const end = model.getPositionAt(next.cursor + suffix.length);
    editor.setPosition(end);
    editor.focus();
  };

  const ignoreCompletion = () => {
    const ignored = completionRef.current;
    if (ignored) recordCompletionMetric("ignored", ignored.kind);
    setCompletion(null);
  };

  useEffect(() => {
    if (!completionEnabled) {
      shouldCompleteRef.current = false;
      cancelCompletion();
      setCompletion(null);
      setCompletionError("");
    }
  }, [completionEnabled]);

  return (
    <div className="source-editor" onKeyDownCapture={(event) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Tab" && completionRef.current) { event.preventDefault(); event.stopPropagation(); acceptCompletion(); }
      if (event.key === "Escape" && completionRef.current) { event.preventDefault(); event.stopPropagation(); ignoreCompletion(); }

    }}>
      <div ref={hostRef} className="monaco-editor-host" hidden={mode === "reviewing"} />
      {mode === "reviewing" && access?.userId ? <ReviewEditor key={`${projectId}:${document.file.path}:${access.userId}`} ref={reviewRef} projectId={projectId} path={document.file.path} userId={access.userId} onSaved={() => onReviewSaved?.()} /> : null}
      {readOnly && mode !== "reviewing" ? <div className="editor-readonly-notice" role="status">只读模式 · 可选择文本、查看讨论，审阅者可发表评论和修改建议</div> : null}
      {completionLoading ? <span className="sr-only" role="status">正在生成写作补全…</span> : null}
      {completionError ? <div className="editor-message editor-message--error" role="alert">{completionError}</div> : null}
      {completion ? <span className="sr-only" role="status">有可用的写作建议，按 Tab 接受，按 Esc 忽略。</span> : null}
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
