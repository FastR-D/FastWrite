import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { AlertTriangle, CheckCircle2, FileOutput, LoaderCircle, LocateFixed, Maximize2, OctagonX, RotateCw, Search, X, ZoomIn, ZoomOut } from "lucide-react";
import { parseLatexDiagnostics, parseSyncTex, pdfToSource, sourceToPdf, type PdfLocation, type SourceLocation, type SyncTexDocument, type WorkspaceTreeNode } from "@fastwrite/shared";
import { Button, IconButton } from "../ui/Button";
import { cancelCompiler, repairCompilerCache, subscribeCompilerProgress } from "../../services/latexCompiler";
import { compileWorkspace } from "../../services/workspaceCompiler";
import { api } from "../../api/client";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

export type CompileState = "idle" | "loading" | "compiling" | "success" | "error";
export interface CompileStateReport { state: CompileState; compiledVersion: number | null }

export function PdfPane({ projectId, projectVersion, mainDocument, tree, sourceLocation, compileRequest, onCompileState, onSyncToSource }: { projectId: string; projectVersion: number; mainDocument: string; tree: WorkspaceTreeNode[]; sourceLocation: SourceLocation | null; compileRequest: number; onCompileState: (report: CompileStateReport) => void; onSyncToSource: (location: SourceLocation) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef(new Map<number, HTMLDivElement>());
  const abortRef = useRef<AbortController | null>(null);
  const autoCompileTimerRef = useRef<number | null>(null);
  const compileRequestRef = useRef(compileRequest);
  const hasCompiledRef = useRef(false);
  const runningRef = useRef(false);
  const pdfUrlRef = useRef<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [state, setState] = useState<CompileState>("idle");
  const [progress, setProgress] = useState("Ready to compile");
  const [resourcePercent, setResourcePercent] = useState<number | null>(null);
  const [log, setLog] = useState("");
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [syncTex, setSyncTex] = useState<SyncTexDocument | null>(null);
  const [compiledVersion, setCompiledVersion] = useState<number | null>(null);
  const [syncHighlight, setSyncHighlight] = useState<PdfLocation | null>(null);
  const [compiledWorkspacePaths, setCompiledWorkspacePaths] = useState<string[]>([]);
  const workspacePaths = useMemo(() => compiledWorkspacePaths.length ? compiledWorkspacePaths : flattenWorkspacePaths(tree), [compiledWorkspacePaths, tree]);
  const diagnostics = useMemo(() => parseLatexDiagnostics(log, workspacePaths, mainDocument), [log, mainDocument, workspacePaths]);
  const activeSyncTex = compiledVersion === projectVersion ? syncTex : null;

  useEffect(() => subscribeCompilerProgress(({ stage, detail, percent }) => {
    if (!runningRef.current) return;
    setProgress(detail || stage);
    setResourcePercent(percent ?? null);
    setState(stage.toLowerCase().includes("compile") ? "compiling" : "loading");
  }), []);

  useEffect(() => () => {
    abortRef.current?.abort();
    if (autoCompileTimerRef.current) window.clearTimeout(autoCompileTimerRef.current);
    if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
  }, []);

  const compile = useCallback(async () => {
    hasCompiledRef.current = true;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    runningRef.current = true;
    setState("loading");
    setProgress("Preparing workspace snapshot…");
    setResourcePercent(null);
    setLog("");
    try {
      const result = await compileWorkspace(projectId, mainDocument, controller.signal);
      if (controller.signal.aborted) return;
      runningRef.current = false;
      setLog(result.log);
      setCompiledWorkspacePaths(result.workspacePaths);
      setSyncTex(typeof result.syncTexData === "string" ? parseSyncTex(result.syncTexData, { mainDocument, workspacePaths: result.workspacePaths }) : null);
      if (!result.success || !result.pdf) {
        setState("error");
        setResourcePercent(null);
        setProgress(result.error || "Compilation failed");
        setDiagnosticsOpen(true);
        void api.compileResults.record(projectId, { projectVersion, status: "error", summary: result.error || "Compilation failed" }).catch(() => undefined);
        return;
      }
      const nextUrl = URL.createObjectURL(new Blob([new Uint8Array(result.pdf)], { type: "application/pdf" }));
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
      pdfUrlRef.current = nextUrl;
      setPdfUrl(nextUrl);
      setCompiledVersion(projectVersion);
      setState("success");
      setResourcePercent(null);
      setProgress("Compiled successfully");
      void api.compileResults.record(projectId, { projectVersion, status: "success", summary: "Compiled successfully in browser WASM engine" }).catch(() => undefined);
    } catch (error) {
      runningRef.current = false;
      if ((error as DOMException).name === "AbortError") return;
      setState("error");
      setResourcePercent(null);
      setProgress(error instanceof Error ? error.message : "Compilation failed");
      setDiagnosticsOpen(true);
      void api.compileResults.record(projectId, { projectVersion, status: "error", summary: error instanceof Error ? error.message : "Compilation failed" }).catch(() => undefined);
    }
  }, [mainDocument, projectId, projectVersion]);

  useEffect(() => {
    if (!hasCompiledRef.current || compiledVersion === null || compiledVersion === projectVersion) return;
    if (autoCompileTimerRef.current) window.clearTimeout(autoCompileTimerRef.current);
    setProgress("Saved changes · waiting to recompile…");
    autoCompileTimerRef.current = window.setTimeout(() => void compile(), 1_200);
    return () => {
      if (autoCompileTimerRef.current) window.clearTimeout(autoCompileTimerRef.current);
    };
  }, [compile, compiledVersion, projectVersion]);

  useEffect(() => { onCompileState({ state, compiledVersion }); }, [compiledVersion, onCompileState, state]);

  useEffect(() => {
    if (compileRequest === compileRequestRef.current) return;
    compileRequestRef.current = compileRequest;
    void compile();
  }, [compile, compileRequest]);

  const cancel = () => {
    abortRef.current?.abort();
    runningRef.current = false;
    cancelCompiler();
    setState(pdfUrl ? "success" : "idle");
    setProgress("Compilation cancelled");
    setResourcePercent(null);
  };

  const repairAndRetry = async () => {
    runningRef.current = true;
    setState("loading");
    setProgress("Repairing compiler cache…");
    setResourcePercent(null);
    try {
      await repairCompilerCache();
      runningRef.current = false;
      await compile();
    } catch (error) {
      runningRef.current = false;
      setState("error");
      setProgress(error instanceof Error ? error.message : "Compiler cache repair failed");
    }
  };

  const scrollToPage = (page: number) => {
    const safe = Math.max(1, Math.min(pageCount, page));
    pageRefs.current.get(safe)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setCurrentPage(safe);
  };

  const locateSource = () => {
    if (!activeSyncTex || !sourceLocation) return;
    const location = sourceToPdf(activeSyncTex, sourceLocation.path, sourceLocation.line);
    if (!location) {
      setProgress(`No SyncTeX location for ${sourceLocation.path}:${sourceLocation.line}. Recompile after saving, then try again.`);
      return;
    }
    setSyncHighlight(location);
    scrollToPage(location.page);
    window.setTimeout(() => setSyncHighlight((current) => current === location ? null : current), 2400);
  };

  const locatePdfPoint = (event: React.MouseEvent<HTMLDivElement>, page: number) => {
    if (!activeSyncTex) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const location = pdfToSource(activeSyncTex, page, (event.clientX - rect.left) / scale, (event.clientY - rect.top) / scale);
    if (location) onSyncToSource(location);
    else setProgress(`No source location for this point on page ${page}. Recompile after saving, then try again.`);
  };

  const isRunning = state === "loading" || state === "compiling";
  return (
    <section className="pdf-pane" aria-label="PDF preview">
      <header className="pdf-toolbar">
        <div className="pdf-toolbar__title"><FileOutput /><span>PDF Preview</span></div>
        <div className="pdf-toolbar__controls" aria-label="PDF controls">
          {pageCount > 0 ? <><input className="pdf-page-input" aria-label="Current PDF page" value={currentPage} onChange={(event) => scrollToPage(Number(event.target.value))} /><span className="pdf-page-count">/ {pageCount}</span><span className="toolbar-separator" /></> : null}
          <IconButton label="Zoom out" icon={<ZoomOut />} disabled={!pdfUrl || scale <= .5} onClick={() => setScale((value) => Math.max(.5, value - .1))} />
          <span className="pdf-toolbar__zoom">{Math.round(scale * 100)}%</span>
          <IconButton label="Zoom in" icon={<ZoomIn />} disabled={!pdfUrl || scale >= 2.2} onClick={() => setScale((value) => Math.min(2.2, value + .1))} />
          <span className="toolbar-separator" />
          <IconButton label="Fit to width" icon={<Maximize2 />} disabled={!pdfUrl} onClick={() => setScale(.92)} />
          <IconButton label="Locate source in PDF" icon={<LocateFixed />} disabled={!activeSyncTex || !sourceLocation || pageCount === 0} onClick={locateSource} />
          <IconButton label="Search PDF" icon={<Search />} disabled />
        </div>
      </header>
      <div className={`compile-strip compile-strip--${state}`} aria-live="polite">
        {resourcePercent !== null ? <div className="compile-strip__meter" role="progressbar" aria-label="Compiler resource loading" aria-valuemin={0} aria-valuemax={100} aria-valuenow={resourcePercent} style={{ width: `${resourcePercent}%` }} /> : null}
        <CompileStatusIcon state={state} />
        <span>{progress}</span>
        {isRunning ? <button onClick={cancel}>Cancel</button> : <button onClick={() => void compile()}>{pdfUrl ? "Recompile" : "Compile"}</button>}
        {state === "error" ? <button onClick={() => void repairAndRetry()}>Repair cache</button> : null}
        {log ? <button onClick={() => setDiagnosticsOpen((value) => !value)}>{diagnostics.length > 0 ? `${diagnostics.length} ${diagnostics.length === 1 ? "issue" : "issues"}` : "Log"}</button> : null}
      </div>
      <div ref={containerRef} className={`pdf-canvas ${pdfUrl ? "" : "pdf-canvas--empty"}`} role="region" aria-label="PDF preview" tabIndex={0} onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        let closest = 1;
        let distance = Number.POSITIVE_INFINITY;
        for (const [page, element] of pageRefs.current) {
          const next = Math.abs(element.offsetTop - top - 12);
          if (next < distance) { distance = next; closest = page; }
        }
        setCurrentPage(closest);
      }}>
        {pdfUrl ? (
          <Document file={pdfUrl} loading={<PdfLoading label="Loading PDF…" />} error={<PdfError label="The compiled PDF could not be displayed." />} onLoadSuccess={({ numPages }) => { setPageCount(numPages); setCurrentPage(1); }}>
            {Array.from({ length: pageCount }, (_, index) => index + 1).map((page) => (
              <div className="pdf-page" key={page} title={activeSyncTex ? "Double-click to open source" : undefined} onDoubleClick={(event) => locatePdfPoint(event, page)} ref={(element) => { if (element) pageRefs.current.set(page, element); else pageRefs.current.delete(page); }}>
                <Page pageNumber={page} scale={scale} renderTextLayer renderAnnotationLayer />
                {syncHighlight?.page === page ? <span className="synctex-highlight" style={{ left: syncHighlight.x * scale, top: Math.max(0, syncHighlight.y * scale - 3), width: Math.min(syncHighlight.width * scale, 420), height: syncHighlight.height * scale }} /> : null}
              </div>
            ))}
          </Document>
        ) : (
          <div className="pdf-empty">
            <span className={`pdf-empty__icon ${state === "error" ? "pdf-empty__icon--error" : ""}`}>{state === "error" ? <OctagonX /> : <FileOutput />}</span>
            <h3>{state === "error" ? "Compilation failed" : "Compile your paper"}</h3>
            <p>{state === "error" ? progress : <><code>{mainDocument}</code> will compile entirely in this browser.</>}</p>
            <Button variant="primary" icon={<RotateCw />} loading={isRunning} onClick={() => void compile()}>{isRunning ? "Compiling" : "Compile PDF"}</Button>
          </div>
        )}
      </div>
      {diagnosticsOpen ? <aside className="pdf-diagnostics"><header><div>{state === "error" ? <OctagonX /> : <FileOutput />}<span>{diagnostics.length > 0 ? "LaTeX diagnostics" : "Compilation log"}</span></div><IconButton label="Close compilation log" icon={<X />} onClick={() => setDiagnosticsOpen(false)} /></header>{diagnostics.length > 0 ? <div className="diagnostic-list">{diagnostics.map((diagnostic) => <button key={diagnostic.id} className={`diagnostic-row diagnostic-row--${diagnostic.severity}`} disabled={!diagnostic.path || !diagnostic.line} onClick={() => diagnostic.path && diagnostic.line && onSyncToSource({ path: diagnostic.path, line: diagnostic.line })}><AlertTriangle /><span><strong>{diagnostic.message}</strong>{diagnostic.path ? <code>{diagnostic.path}{diagnostic.line ? `:${diagnostic.line}` : ""}</code> : null}</span></button>)}</div> : null}<details className="compile-log-details" open={diagnostics.length === 0}><summary>Raw compiler log</summary><pre>{log || progress}</pre></details></aside> : null}
    </section>
  );
}

function PdfLoading({ label }: { label: string }) { return <div className="pdf-document-state"><RotateCw className="spin" /><span>{label}</span></div>; }
function PdfError({ label }: { label: string }) { return <div className="pdf-document-state pdf-document-state--error"><OctagonX /><span>{label}</span></div>; }

function CompileStatusIcon({ state }: { state: CompileState }) {
  if (state === "error") return <OctagonX className="compile-status-icon compile-status-icon--error" aria-label="Compilation error" />;
  if (state === "success") return <CheckCircle2 className="compile-status-icon" aria-hidden="true" />;
  if (state === "loading" || state === "compiling") return <LoaderCircle className="compile-status-icon spin" aria-hidden="true" />;
  return <FileOutput className="compile-status-icon" aria-hidden="true" />;
}

function flattenWorkspacePaths(nodes: WorkspaceTreeNode[]): string[] {
  return nodes.flatMap((node) => node.type === "file" ? [node.path] : flattenWorkspacePaths(node.children));
}
