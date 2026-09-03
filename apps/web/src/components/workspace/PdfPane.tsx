import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { AlertTriangle, CheckCircle2, FileOutput, LoaderCircle, LocateFixed, Maximize2, Minimize2, OctagonX, RotateCw, Scan, Search, Wrench, X, ZoomIn, ZoomOut } from "lucide-react";
import { parseLatexDiagnostics, parseSyncTex, pdfToSource, sourceToPdf, type PdfLocation, type SourceLocation, type SyncTexDocument, type WorkspaceTreeNode } from "@fastwrite/shared";
import { Button, IconButton } from "../ui/Button";
import { api } from "../../api/client";
import { fitPdfPageScale, MAX_PDF_SCALE, MIN_PDF_SCALE } from "./pdfScale";
import { compilerLogExcerpt, shouldAutoCompile, type CompileFailureContext } from "./compileRepair";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

export type CompileState = "idle" | "loading" | "compiling" | "success" | "error";
export interface CompileStateReport { state: CompileState; compiledVersion: number | null; renderedPages?: number; failure?: CompileFailureContext }

export function PdfPane({ projectId, projectVersion, mainDocument, tree, sourceLocation, compileRequest, onCompileState, onFixWithAgent, onSyncToSource }: { projectId: string; projectVersion: number; mainDocument: string; tree: WorkspaceTreeNode[]; sourceLocation: SourceLocation | null; compileRequest: number; onCompileState: (report: CompileStateReport) => void; onFixWithAgent: (failure: CompileFailureContext) => void; onSyncToSource: (location: SourceLocation) => void }) {
  const paneRef = useRef<HTMLElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef(new Map<number, HTMLDivElement>());
  const abortRef = useRef<AbortController | null>(null);
  const autoCompileTimerRef = useRef<number | null>(null);
  const compileRequestRef = useRef(compileRequest);
  const hasCompiledRef = useRef(false);
  const runningRef = useRef(false);
  const pdfUrlRef = useRef<string | null>(null);
  const pageDimensions = useRef(new Map<number, { width: number; height: number }>());
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [fitToPanel, setFitToPanel] = useState(true);
  const [state, setState] = useState<CompileState>("idle");
  const [progress, setProgress] = useState("Ready to compile");
  const [resourcePercent, setResourcePercent] = useState<number | null>(null);
  const [log, setLog] = useState("");
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [syncTex, setSyncTex] = useState<SyncTexDocument | null>(null);
  const [compiledVersion, setCompiledVersion] = useState<number | null>(null);
  const [lastAttemptedVersion, setLastAttemptedVersion] = useState<number | null>(null);
  const [syncHighlight, setSyncHighlight] = useState<PdfLocation | null>(null);
  const [compiledWorkspacePaths, setCompiledWorkspacePaths] = useState<string[]>([]);
  const [fullscreen, setFullscreen] = useState(false);
  const workspacePaths = useMemo(() => compiledWorkspacePaths.length ? compiledWorkspacePaths : flattenWorkspacePaths(tree), [compiledWorkspacePaths, tree]);
  const diagnostics = useMemo(() => parseLatexDiagnostics(log, workspacePaths, mainDocument), [log, mainDocument, workspacePaths]);
  const visibleDiagnostics = useMemo(() => state === "success" ? diagnostics.filter((diagnostic) => diagnostic.severity !== "error") : diagnostics, [diagnostics, state]);
  const failure = useMemo<CompileFailureContext | undefined>(() => state === "error" ? {
    engine: "server",
    mainDocument,
    summary: progress,
    diagnostics: visibleDiagnostics.map(({ severity, message, path, line }) => ({ severity, message, ...(path ? { path } : {}), ...(line ? { line } : {}) })),
    logExcerpt: compilerLogExcerpt(log || progress)
  } : undefined, [log, mainDocument, progress, state, visibleDiagnostics]);
  const activeSyncTex = compiledVersion === projectVersion ? syncTex : null;

  useEffect(() => {
    const updateFullscreen = () => setFullscreen(document.fullscreenElement === paneRef.current);
    document.addEventListener("fullscreenchange", updateFullscreen);
    return () => document.removeEventListener("fullscreenchange", updateFullscreen);
  }, []);

  useEffect(() => () => {
    abortRef.current?.abort();
    // React Strict Mode intentionally remounts effects in development. Let the
    // second mount restart the initial compilation after cancelling the first.
    hasCompiledRef.current = false;
    if (autoCompileTimerRef.current) window.clearTimeout(autoCompileTimerRef.current);
    if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
  }, []);

  const compile = useCallback(async () => {
    hasCompiledRef.current = true;
    setLastAttemptedVersion(projectVersion);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    runningRef.current = true;
    setState("loading");
    setProgress("Preparing workspace snapshot…");
    setResourcePercent(null);
    setLog("");
    try {
      setState("compiling");
      setProgress("Compiling with Local LaTeX…");
      const result = await api.compiler.compileOnServer(projectId, controller.signal).then((server) => ({ ...server, pdf: server.pdfBase64 ? base64ToBytes(server.pdfBase64) : undefined }));
      if (controller.signal.aborted) {
        if (abortRef.current === controller) {
          runningRef.current = false;
          setState(pdfUrlRef.current ? "success" : "idle");
          setProgress("Compilation cancelled");
        }
        return;
      }
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
      void api.compileResults.record(projectId, { projectVersion, status: "success", summary: "Compiled successfully with Local LaTeX" }).catch(() => undefined);
    } catch (error) {
      if ((error as DOMException).name === "AbortError") {
        if (abortRef.current === controller) {
          setState(pdfUrlRef.current ? "success" : "idle");
          setProgress("Compilation cancelled");
          runningRef.current = false;
        }
        return;
      }
      runningRef.current = false;
      setState("error");
      setResourcePercent(null);
      setProgress(error instanceof Error ? error.message : "Compilation failed");
      setDiagnosticsOpen(true);
      void api.compileResults.record(projectId, { projectVersion, status: "error", summary: error instanceof Error ? error.message : "Compilation failed" }).catch(() => undefined);
    }
  }, [mainDocument, projectId, projectVersion]);

  useEffect(() => {
    if (hasCompiledRef.current) return;
    void compile();
  }, [compile]);

  useEffect(() => {
    if (!shouldAutoCompile(hasCompiledRef.current, lastAttemptedVersion, projectVersion)) return;
    if (autoCompileTimerRef.current) window.clearTimeout(autoCompileTimerRef.current);
    setProgress("Saved changes · waiting to recompile…");
    autoCompileTimerRef.current = window.setTimeout(() => void compile(), 1_200);
    return () => {
      if (autoCompileTimerRef.current) window.clearTimeout(autoCompileTimerRef.current);
    };
  }, [compile, lastAttemptedVersion, projectVersion]);

  useEffect(() => { onCompileState({ state, compiledVersion, ...(pageCount > 0 ? { renderedPages: pageCount } : {}), ...(failure ? { failure } : {}) }); }, [compiledVersion, failure, onCompileState, pageCount, state]);

  useEffect(() => {
    if (compileRequest === compileRequestRef.current) return;
    compileRequestRef.current = compileRequest;
    void compile();
  }, [compile, compileRequest]);

  const cancel = () => {
    abortRef.current?.abort();
    runningRef.current = false;
    setState(pdfUrl ? "success" : "idle");
    setProgress("Compilation cancelled");
    setResourcePercent(null);
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
    const canvas = event.currentTarget.querySelector<HTMLCanvasElement>(".react-pdf__Page__canvas");
    const rect = canvas?.getBoundingClientRect();
    const dimensions = pageDimensions.current.get(page);
    if (!rect || !dimensions || !rect.width || !rect.height) return;
    const x = Math.max(0, Math.min(dimensions.width, ((event.clientX - rect.left) / rect.width) * dimensions.width));
    const y = Math.max(0, Math.min(dimensions.height, ((event.clientY - rect.top) / rect.height) * dimensions.height));
    const location = pdfToSource(activeSyncTex, page, x, y);
    if (location) onSyncToSource(location);
    else setProgress(`No source location for this point on page ${page}. Recompile after saving, then try again.`);
  };

  const isRunning = state === "loading" || state === "compiling";
  const applyFitToPanel = useCallback(() => {
    const container = containerRef.current;
    const page = pageDimensions.current.get(1);
    if (!container || !page) return;
    const next = fitPdfPageScale(container.clientWidth, container.clientHeight, page.width, page.height);
    if (next === null) return;
    setScale((current) => Math.abs(current - next) < .002 ? current : next);
  }, []);
  useEffect(() => {
    if (!fitToPanel || !pdfUrl || !containerRef.current) return;
    const observer = new ResizeObserver(() => window.requestAnimationFrame(applyFitToPanel));
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [applyFitToPanel, fitToPanel, pdfUrl]);
  const diagnosticErrors = visibleDiagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const diagnosticWarnings = visibleDiagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
  const diagnosticLabel = diagnosticErrors ? `${diagnosticErrors} ${diagnosticErrors === 1 ? "error" : "errors"}` : diagnosticWarnings ? `${diagnosticWarnings} ${diagnosticWarnings === 1 ? "warning" : "warnings"}` : "Compiler log";
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void paneRef.current?.requestFullscreen().catch((error: unknown) => setProgress(error instanceof Error ? error.message : "Could not enter PDF fullscreen"));
  };
  return (
    <section ref={paneRef} className="pdf-pane" aria-label="PDF preview">
      <header className="pdf-toolbar">
        <div className="pdf-toolbar__title"><FileOutput /><span>PDF Preview</span></div>
        <div className="pdf-toolbar__controls" aria-label="PDF controls">
          {pageCount > 0 ? <><input className="pdf-page-input" aria-label="Current PDF page" value={currentPage} onChange={(event) => scrollToPage(Number(event.target.value))} /><span className="pdf-page-count">/ {pageCount}</span><span className="toolbar-separator" /></> : null}
          <IconButton label="Zoom out" icon={<ZoomOut />} disabled={!pdfUrl || scale <= MIN_PDF_SCALE} onClick={() => { setFitToPanel(false); setScale((value) => Math.max(MIN_PDF_SCALE, value - .1)); }} />
          <span className="pdf-toolbar__zoom">{Math.round(scale * 100)}%</span>
          <IconButton label="Zoom in" icon={<ZoomIn />} disabled={!pdfUrl || scale >= MAX_PDF_SCALE} onClick={() => { setFitToPanel(false); setScale((value) => Math.min(MAX_PDF_SCALE, value + .1)); }} />
          <span className="toolbar-separator" />
          <IconButton label="Fit PDF page to panel" icon={<Scan />} disabled={!pdfUrl} onClick={() => { setFitToPanel(true); window.requestAnimationFrame(applyFitToPanel); }} />
          <IconButton label="Locate editor selection in PDF" icon={<LocateFixed />} disabled={!activeSyncTex || !sourceLocation || pageCount === 0} onClick={locateSource} />
          <IconButton label={fullscreen ? "Exit PDF fullscreen" : "Enter PDF fullscreen"} icon={fullscreen ? <Minimize2 /> : <Maximize2 />} onClick={toggleFullscreen} />
          <IconButton label="Search PDF" icon={<Search />} disabled />
        </div>
      </header>
      <div className={`compile-strip compile-strip--${state}`} aria-live="polite">
        {resourcePercent !== null ? <div className="compile-strip__meter" role="progressbar" aria-label="Compiler resource loading" aria-valuemin={0} aria-valuemax={100} aria-valuenow={resourcePercent} style={{ width: `${resourcePercent}%` }} /> : null}
        <CompileStatusIcon state={state} />
        <span>{progress}</span>
        {failure ? <button className="compile-fix-agent" onClick={() => onFixWithAgent(failure)}><Wrench />Fix with Agent</button> : null}
        <span className="compile-engine">Local LaTeX</span>
        {isRunning ? <button onClick={cancel}>Cancel</button> : <button onClick={() => void compile()}>{pdfUrl ? "Recompile" : "Compile"}</button>}
        {log ? <button onClick={() => setDiagnosticsOpen((value) => !value)}>{diagnosticLabel}</button> : null}
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
                <Page pageNumber={page} scale={scale} renderTextLayer renderAnnotationLayer onLoadSuccess={(loadedPage) => { const viewport = loadedPage.getViewport({ scale: 1 }); pageDimensions.current.set(page, { width: viewport.width, height: viewport.height }); if (page === 1 && fitToPanel) window.requestAnimationFrame(applyFitToPanel); }} />
                {syncHighlight?.page === page ? <span className="synctex-highlight" style={{ left: syncHighlight.x * scale, top: Math.max(0, syncHighlight.y * scale - 3), width: Math.min(syncHighlight.width * scale, 420), height: syncHighlight.height * scale }} /> : null}
              </div>
            ))}
          </Document>
        ) : (
          <div className="pdf-empty">
            <span className={`pdf-empty__icon ${state === "error" ? "pdf-empty__icon--error" : ""}`}>{state === "error" ? <OctagonX /> : <FileOutput />}</span>
            <h3>{state === "error" ? "Compilation failed" : "Compile your paper"}</h3>
            <p>{state === "error" ? progress : <><code>{mainDocument}</code> will compile with the local LaTeX toolchain.</>}</p>
            <Button variant="primary" icon={<RotateCw />} loading={isRunning} onClick={() => void compile()}>{isRunning ? "Compiling" : "Compile PDF"}</Button>
          </div>
        )}
      </div>
      {diagnosticsOpen ? <aside className="pdf-diagnostics"><header><div>{state === "error" ? <OctagonX /> : <FileOutput />}<span>{visibleDiagnostics.length > 0 ? "LaTeX diagnostics" : "Compilation log"}</span></div><IconButton label="Close compilation log" icon={<X />} onClick={() => setDiagnosticsOpen(false)} /></header>{visibleDiagnostics.length > 0 ? <div className="diagnostic-list">{visibleDiagnostics.map((diagnostic) => <button key={diagnostic.id} className={`diagnostic-row diagnostic-row--${diagnostic.severity}`} disabled={!diagnostic.path || !diagnostic.line} onClick={() => diagnostic.path && diagnostic.line && onSyncToSource({ path: diagnostic.path, line: diagnostic.line })}><AlertTriangle /><span><strong>{diagnostic.message}</strong>{diagnostic.path ? <code>{diagnostic.path}{diagnostic.line ? `:${diagnostic.line}` : ""}</code> : null}</span></button>)}</div> : null}<details className="compile-log-details" open={visibleDiagnostics.length === 0}><summary>Raw compiler log</summary><pre>{log || progress}</pre></details></aside> : null}
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

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
