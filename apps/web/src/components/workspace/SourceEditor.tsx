import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type MutableRefObject } from "react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import { AlertCircle, Check, CloudOff, LoaderCircle, Sparkles, Undo2 } from "lucide-react";
import type { CompletionKind, CompletionResponse, FileContentResponse, SourceLocation, TextSelection } from "@fastwrite/shared";
import { api, ApiClientError } from "../../api/client";
import { completionSuffix } from "./completion";
import { currentTheme, THEME_CHANGE_EVENT } from "../../lib/theme";
import * as Y from "yjs";

type SaveStatus = "saved" | "dirty" | "saving" | "error" | "conflict";
type CompletionMetricEvent = "suggested" | "cancelled" | "accepted" | "ignored" | "error";
type SaveTarget = { path: string; baseVersion: number };

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker: (_moduleId: string, _label: string) => Worker };
  }
}

let monacoConfigured = false;

function configureMonaco() {
  if (monacoConfigured) return;
  monacoConfigured = true;
  window.MonacoEnvironment = { getWorker: () => new EditorWorker() };
  if (!monaco.languages.getLanguages().some((language) => language.id === "latex")) {
    monaco.languages.register({ id: "latex", extensions: [".tex", ".sty", ".cls", ".bib"] });
    monaco.languages.setMonarchTokensProvider("latex", {
      tokenizer: {
        root: [
          [/%.*$/, "comment"],
          [/\\(?:begin|end)(?=\{)/, "keyword.control"],
          [/\\[a-zA-Z@]+\*?/, "keyword"],
          [/\\./, "string.escape"],
          [/\$\$?/, { token: "string", next: "@math" }],
          [/[{}[\]()]/, "delimiter.bracket"],
          [/[&_^]/, "operator"]
        ],
        math: [
          [/\\[a-zA-Z@]+\*?/, "type"],
          [/\$\$?/, { token: "string", next: "@pop" }],
          [/[{}[\]()]/, "delimiter.bracket"],
          [/./, "string"]
        ]
      }
    });
    monaco.languages.setLanguageConfiguration("latex", {
      comments: { lineComment: "%" },
      brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
      autoClosingPairs: [{ open: "{", close: "}" }, { open: "[", close: "]" }, { open: "(", close: ")" }, { open: "$", close: "$" }],
      surroundingPairs: [{ open: "{", close: "}" }, { open: "[", close: "]" }, { open: "(", close: ")" }, { open: "$", close: "$" }]
    });
  }
  monaco.editor.defineTheme("fastwrite-github", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6E7781" },
      { token: "keyword", foreground: "CF222E" },
      { token: "keyword.control", foreground: "8250DF", fontStyle: "bold" },
      { token: "type", foreground: "0550AE" },
      { token: "string", foreground: "0A3069" },
      { token: "string.escape", foreground: "116329" },
      { token: "operator", foreground: "8250DF" }
    ],
    colors: {
      "editor.background": "#FFFFFF",
      "editor.foreground": "#24292F",
      "editorGutter.background": "#F6F8FA",
      "editorLineNumber.foreground": "#8C959F",
      "editorLineNumber.activeForeground": "#24292F",
      "editor.lineHighlightBackground": "#F6F8FA",
      "editor.selectionBackground": "#54AEFF66",
      "editor.inactiveSelectionBackground": "#54AEFF4D",
      "editorCursor.foreground": "#0969DA",
      "editorWhitespace.foreground": "#AFB8C1",
      "editorIndentGuide.background1": "#D8DEE4",
      "editorBracketMatch.background": "#DDF4FF",
      "editorBracketMatch.border": "#54AEFF"
    }
  });
  monaco.editor.defineTheme("fastwrite-github-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "8B949E" },
      { token: "keyword", foreground: "FF7B72" },
      { token: "keyword.control", foreground: "D2A8FF", fontStyle: "bold" },
      { token: "type", foreground: "79C0FF" },
      { token: "string", foreground: "A5D6FF" },
      { token: "string.escape", foreground: "7EE787" },
      { token: "operator", foreground: "D2A8FF" }
    ],
    colors: {
      "editor.background": "#0D1117",
      "editor.foreground": "#C9D1D9",
      "editorGutter.background": "#0D1117",
      "editorLineNumber.foreground": "#6E7681",
      "editorLineNumber.activeForeground": "#C9D1D9",
      "editor.lineHighlightBackground": "#161B22",
      "editor.selectionBackground": "#264F78",
      "editor.inactiveSelectionBackground": "#264F7855",
      "editorCursor.foreground": "#58A6FF",
      "editorWhitespace.foreground": "#30363D",
      "editorIndentGuide.background1": "#21262D",
      "editorBracketMatch.background": "#1F3B5B",
      "editorBracketMatch.border": "#58A6FF"
    }
  });
}

function languageForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".tex") || lower.endsWith(".sty") || lower.endsWith(".cls") || lower.endsWith(".bib")) return "latex";
  return "plaintext";
}

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
  projectId: string;
  document: FileContentResponse;
  targetLine: number | null;
  targetSelection: TextSelection | null;
  onSaved: (document: FileContentResponse) => void | Promise<void>;
  onSelection: (selection: TextSelection | null) => void;
  onCursor: (location: SourceLocation) => void;
}

export interface SourceEditorHandle {
  flush: () => Promise<void>;
}

export const SourceEditor = forwardRef<SourceEditorHandle, SourceEditorProps>(function SourceEditor({ projectId, document, targetLine, targetSelection, onSaved, onSelection, onCursor }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const decorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const completionDecorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const collaboratorDecorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const disposablesRef = useRef<monaco.IDisposable[]>([]);
  const applyingExternalRef = useRef(false);
  const currentPathRef = useRef("");
  const timerRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const completionTimerRef = useRef<number | null>(null);
  const completionAbortRef = useRef<AbortController | null>(null);
  const completionRef = useRef<CompletionResponse | null>(null);
  const documentRef = useRef(document);
  const onSelectionRef = useRef(onSelection);
  const onCursorRef = useRef(onCursor);
  const contentChangeRef = useRef<(content: string) => void>(() => undefined);
  const cursorRef = useRef(0);
  const shouldCompleteRef = useRef(false);
  const suppressNextCompletionRef = useRef(false);
  const versionRef = useRef(document.file.version);
  const savedContentRef = useRef(document.content);
  const [editorReady, setEditorReady] = useState(false);
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [message, setMessage] = useState("");
  const [completion, setCompletionState] = useState<CompletionResponse | null>(null);
  const [completionLoading, setCompletionLoading] = useState(false);
  const [completionError, setCompletionError] = useState("");
  const [acceptedCompletion, setAcceptedCompletion] = useState<{ from: number; text: string } | null>(null);
  const [completionEnabled, setCompletionEnabled] = useState(() => localStorage.getItem("fastwrite.completion.enabled") !== "false");
  const [collaborationEnabled, setCollaborationEnabled] = useState(() => localStorage.getItem("fastwrite.collaboration.enabled") === "true");
  const [collaborators, setCollaborators] = useState<Array<{ clientId: string; name: string; color?: string; path: string; line?: number }>>([]);
  const collaborationClientRef = useRef(localStorage.getItem("fastwrite.collaboration.client") || crypto.randomUUID());
  const collaborationSocketRef = useRef<WebSocket | null>(null);
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

  const save = async (content: string, propagateError = false, target: SaveTarget = { path: currentPathRef.current, baseVersion: versionRef.current }) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (currentPathRef.current === target.path) setStatus("saving");
    try {
      const result = collaborationEnabled ? await saveCollaborative(projectId, target, content, collaborationClientRef.current, cursorRef.current) : await api.projects.saveFile(projectId, target.path, { content, baseVersion: target.baseVersion }, controller.signal);
      if (collaborationEnabled && "presence" in result) setCollaborators(result.presence.filter((item) => item.clientId !== collaborationClientRef.current));
      if (collaborationEnabled && collaborationSocketRef.current?.readyState === WebSocket.OPEN) collaborationSocketRef.current.send(JSON.stringify({ type: "document-updated", fileVersion: result.file.version }));
      if (currentPathRef.current === target.path) {
        versionRef.current = result.file.version;
        savedContentRef.current = content;
        setStatus("saved");
        setMessage("");
      }
      await onSaved({ file: result.file, content });
    } catch (error) {
      if ((error as DOMException).name === "AbortError") return;
      if (currentPathRef.current === target.path) {
        if (error instanceof ApiClientError && error.status === 409) {
          setStatus("conflict");
          setMessage("This file changed elsewhere. Reopen it before saving again.");
        } else {
          setStatus("error");
          setMessage(error instanceof Error ? error.message : "Save failed");
        }
      }
      if (propagateError) throw error;
    }
  };

  const flush = async () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    const content = modelRef.current?.getValue();
    if (content !== undefined && content !== savedContentRef.current) {
      await save(content, true, { path: currentPathRef.current, baseVersion: versionRef.current });
    }
  };

  useImperativeHandle(ref, () => ({ flush }));

  const update = (content: string) => {
    setStatus("dirty");
    cancelCompletion();
    setCompletion(null);
    setCompletionError("");
    shouldCompleteRef.current = !suppressNextCompletionRef.current;
    suppressNextCompletionRef.current = false;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    const target = { path: currentPathRef.current, baseVersion: versionRef.current };
    timerRef.current = window.setTimeout(() => void save(content, false, target), 850);
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
        if (!applyingExternalRef.current) contentChangeRef.current(editor.getValue());
      }),
      editor.onDidChangeCursorSelection(() => emitSelection(editor, decorationsRef.current, documentRef.current, versionRef.current, onSelectionRef.current, onCursorRef.current, cursorRef, completionRef, setCompletion, completionAbortRef))
    ];
    setEditorReady(true);
    const updateTheme = () => monaco.editor.setTheme(currentTheme() === "dark" ? "fastwrite-github-dark" : "fastwrite-github");
    window.addEventListener(THEME_CHANGE_EVENT, updateTheme);
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, updateTheme);
      if (timerRef.current) window.clearTimeout(timerRef.current);
      abortRef.current?.abort();
      if (completionTimerRef.current) window.clearTimeout(completionTimerRef.current);
      completionAbortRef.current?.abort();
      disposablesRef.current.forEach((item) => item.dispose());
      decorationsRef.current?.clear();
      completionDecorationsRef.current?.clear();
      collaboratorDecorationsRef.current?.clear();
      editor.setModel(null);
      modelRef.current?.dispose();
      editor.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editorReady || !editor) return;
    const pathChanged = currentPathRef.current !== document.file.path;
    if (pathChanged) {
      cancelCompletion();
      setCompletionError("");
      editor.setModel(null);
      modelRef.current?.dispose();
      const uri = monaco.Uri.from({ scheme: "fastwrite", authority: projectId, path: `/${document.file.path}` });
      modelRef.current = monaco.editor.createModel(document.content, languageForPath(document.file.path), uri);
      editor.setModel(modelRef.current);
      currentPathRef.current = document.file.path;
      editor.setScrollPosition({ scrollTop: 0, scrollLeft: 0 });
      decorationsRef.current?.clear();
      completionDecorationsRef.current?.clear();
      setAcceptedCompletion(null);
    } else if (modelRef.current && modelRef.current.getValue() !== document.content) {
      applyingExternalRef.current = true;
      modelRef.current.setValue(document.content);
      applyingExternalRef.current = false;
    }
    editor.updateOptions({ ariaLabel: `Source editor for ${document.file.path}` });
    versionRef.current = document.file.version;
    savedContentRef.current = document.content;
    setStatus("saved");
    setMessage("");
    setCompletion(null);

    if (!shouldCompleteRef.current || !completionEnabled) return;
    shouldCompleteRef.current = false;
    const expected = { path: document.file.path, cursor: cursorRef.current, fileVersion: document.file.version, kind: completionKind };
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
  }, [completionEnabled, document.content, document.file.path, document.file.version, editorReady, projectId]);

  useEffect(() => {
    if (!collaborationEnabled || !editorReady) { setCollaborators([]); return; }
    localStorage.setItem("fastwrite.collaboration.client", collaborationClientRef.current);
    let active = true;
    const poll = async () => { try { const state = await api.projects.collaboration(projectId, document.file.path); if (!active) return; setCollaborators(state.presence.filter((item) => item.clientId !== collaborationClientRef.current)); if (state.fileVersion > versionRef.current) { const remote = new Y.Doc(); Y.applyUpdate(remote, fromBase64(state.update)); const content = remote.getText("content").toString(); applyingExternalRef.current = true; modelRef.current?.setValue(content); applyingExternalRef.current = false; versionRef.current = state.fileVersion; savedContentRef.current = content; setStatus("saved"); } } catch { /* Existing save conflict UI remains authoritative. */ } };
    void poll(); const interval = window.setInterval(() => void poll(), 3000); return () => { active = false; window.clearInterval(interval); };
  }, [collaborationEnabled, document.file.path, editorReady, projectId]);

  useEffect(() => {
    if (!collaborationEnabled || !editorReady) return;
    const heartbeat = async () => { try { const line = modelRef.current?.getPositionAt(cursorRef.current).lineNumber; const members = await api.projects.collaborationPresence(projectId, { clientId: collaborationClientRef.current, name: localStorage.getItem("fastwrite.collaboration.name") || "Author", path: document.file.path, ...(line ? { line } : {}) }); setCollaborators(members.filter((item) => item.clientId !== collaborationClientRef.current)); } catch { /* Presence is best-effort. */ } };
    void heartbeat(); const interval = window.setInterval(() => void heartbeat(), 12_000); return () => window.clearInterval(interval);
  }, [collaborationEnabled, document.file.path, editorReady, projectId]);

  useEffect(() => {
    if (!collaborationEnabled || !editorReady) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/collaboration/socket?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(document.file.path)}&clientId=${encodeURIComponent(collaborationClientRef.current)}`);
    collaborationSocketRef.current = socket;
    socket.onmessage = (event) => { try { const message = JSON.parse(String(event.data)) as { type?: string }; if (message.type === "document-updated" || message.type === "presence") void api.projects.collaboration(projectId, document.file.path).then((state) => { setCollaborators(state.presence.filter((item) => item.clientId !== collaborationClientRef.current)); if (message.type === "document-updated" && state.fileVersion > versionRef.current) { const remote = new Y.Doc(); Y.applyUpdate(remote, fromBase64(state.update)); const content = remote.getText("content").toString(); applyingExternalRef.current = true; modelRef.current?.setValue(content); applyingExternalRef.current = false; versionRef.current = state.fileVersion; savedContentRef.current = content; } }); } catch { /* Ignore malformed collaboration broadcasts. */ } };
    return () => { if (collaborationSocketRef.current === socket) collaborationSocketRef.current = null; socket.close(); };
  }, [collaborationEnabled, document.file.path, editorReady, projectId]);

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
    if (!editor || !model || !targetLine || currentPathRef.current !== document.file.path) return;
    const safeLine = Math.min(Math.max(1, targetLine), model.getLineCount());
    editor.setPosition({ lineNumber: safeLine, column: 1 });
    editor.revealLineInCenter(safeLine);
    editor.focus();
  }, [document.file.path, editorReady, targetLine]);

  useEffect(() => {
    const editor = editorRef.current;
    const model = modelRef.current;
    if (!editor || !model || !targetSelection || targetSelection.path !== document.file.path) return;
    const from = Math.max(0, Math.min(targetSelection.from, model.getValueLength()));
    const to = Math.max(from, Math.min(targetSelection.to, model.getValueLength()));
    const range = rangeFromOffsets(model, from, to);
    if (model.getValueInRange(range) !== targetSelection.text) return;
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
      if (event.key === "Tab" && completionRef.current) { event.preventDefault(); event.stopPropagation(); acceptCompletion(); }
      if (event.key === "Escape" && completionRef.current) { event.preventDefault(); event.stopPropagation(); ignoreCompletion(); }
    }}>
      <div className="editor-toolbar">
        <div className="editor-toolbar__file"><span>{document.file.name}</span><code>{document.file.path}</code></div>
        <div className="editor-toolbar__actions">
          <label className={`completion-switch${completionEnabled ? " is-on" : ""}`} title={completionError || "Skill-guided writing completion"}>
            <input id="completion-enabled" name="completion-enabled" type="checkbox" checked={completionEnabled} onChange={(event) => changeCompletionEnabled(event.target.checked)} />
            {completionLoading ? <LoaderCircle className="spin" /> : <Sparkles />}
            <span>Complete</span>
          </label>
        <label className={`completion-switch${collaborationEnabled ? " is-on" : ""}`} title="Synchronize this file through Yjs collaboration"><input id="collaboration-enabled" name="collaboration-enabled" type="checkbox" checked={collaborationEnabled} onChange={(event) => { setCollaborationEnabled(event.target.checked); localStorage.setItem("fastwrite.collaboration.enabled", String(event.target.checked)); }} /><span>Collaborate{collaborators.length ? ` · ${collaborators.length}` : ""}</span></label>
          {acceptedCompletion ? <button className="editor-undo-completion" type="button" onClick={undoCompletion}><Undo2 /> Undo completion</button> : null}
          <SaveIndicator status={status} />
        </div>
      </div>
      <div ref={hostRef} className="monaco-editor-host" />
      {completion ? <span className="sr-only" role="status">Writing suggestion available. Press Tab to accept or Escape to ignore.</span> : null}
      {message ? <div className={`editor-message editor-message--${status}`} role="alert"><AlertCircle /> {message}</div> : null}
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
  onCursor({ path: document.file.path, line: selection.positionLineNumber });
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
    saved: [<Check key="icon" />, "Saved"], dirty: [<CloudOff key="icon" />, "Unsaved"], saving: [<LoaderCircle key="icon" className="spin" />, "Saving"], error: [<AlertCircle key="icon" />, "Save failed"], conflict: [<AlertCircle key="icon" />, "Conflict"]
  }[status];
  return <span className={`save-indicator save-indicator--${status}`}>{content}</span>;
}

async function saveCollaborative(projectId: string, target: SaveTarget, content: string, clientId: string, cursor: number) {
  const state = await api.projects.collaboration(projectId, target.path);
  if (state.fileVersion !== target.baseVersion) throw new ApiClientError(409, "collaboration_version_conflict", "This file changed elsewhere. Reload it before saving again.");
  const document = new Y.Doc(); Y.applyUpdate(document, fromBase64(state.update)); const text = document.getText("content"); text.delete(0, text.length); text.insert(0, content);
  const result = await api.projects.collaborationUpdate(projectId, { path: target.path, update: toBase64(Y.encodeStateAsUpdate(document)), baseVersion: target.baseVersion, clientId, name: localStorage.getItem("fastwrite.collaboration.name") || "Author", line: modelLineFromOffset(content, cursor) });
  return { file: { path: target.path, name: target.path.split("/").pop() ?? target.path, kind: "text" as const, size: new Blob([content]).size, version: result.fileVersion, updatedAt: new Date().toISOString() }, presence: result.presence };
}
function modelLineFromOffset(content: string, offset: number): number { return content.slice(0, Math.max(0, offset)).split("\n").length; }
function toBase64(update: Uint8Array): string { let value = ""; for (const byte of update) value += String.fromCharCode(byte); return btoa(value); }
function fromBase64(value: string): Uint8Array { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); }
