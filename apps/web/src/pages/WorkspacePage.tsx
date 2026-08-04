import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FilePlus2,
  FolderTree,
  GitCommitHorizontal,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  RefreshCw,
  Trash2,
  Upload
} from "lucide-react";
import type { FileContentResponse, OutlineItem, PaperProject, ReviewIssue, SourceLocation, TextSelection, WorkspaceTreeNode } from "@fastwrite/shared";
import { api } from "../api/client";
import { Button, IconButton } from "../components/ui/Button";
import { Dialog } from "../components/ui/Dialog";
import { FileTree } from "../components/workspace/FileTree";
import { AddFileDialog } from "../components/workspace/AddFileDialog";
import { OutlineTree } from "../components/workspace/OutlineTree";
import { PdfPane, type CompileStateReport } from "../components/workspace/PdfPane";
import { ProjectSettingsDialog } from "../components/workspace/ProjectSettingsDialog";
import { RenameFileDialog } from "../components/workspace/RenameFileDialog";
import { SourceEditor, type SourceEditorHandle } from "../components/workspace/SourceEditor";
import { AiWorkspace } from "../components/workspace/AiWorkspace";
import { GithubSyncDialog } from "../components/workspace/GithubSyncDialog";
import type { CompileFailureContext, CompileRepairRequest } from "../components/workspace/compileRepair";
import { navigate } from "../lib/navigation";
import { currentSectionSelection } from "../lib/sectionSelection";
import { FASTWRITE_SAVE_EVENT } from "../lib/keyboard";

interface WorkspacePageProps {
  projectId: string;
}

export function WorkspacePage({ projectId }: WorkspacePageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<WorkspaceTreeNode[]>([]);
  const editorRef = useRef<SourceEditorHandle>(null);
  const [project, setProject] = useState<PaperProject | null>(null);
  const [tree, setTree] = useState<WorkspaceTreeNode[]>([]);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileDocument, setFileDocument] = useState<FileContentResponse | null>(null);
  const [targetLine, setTargetLine] = useState<number | null>(null);
  const [targetSelection, setTargetSelection] = useState<TextSelection | null>(null);
  const [selection, setSelection] = useState<TextSelection | null>(null);
  const [cursorLocation, setCursorLocation] = useState<SourceLocation>({ path: "", line: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sidebarWidth, setSidebarWidth] = useStoredNumber("fastwrite.sidebar-width", 254);
  const [pdfWidth, setPdfWidth] = useStoredNumber("fastwrite.pdf-width", 440);
  const [aiHeight, setAiHeight] = useStoredNumber("fastwrite.ai-height", 322);
  const [outlineHeight, setOutlineHeight] = useStoredNumber("fastwrite.outline-height", 250);
  const [outlineCollapsed, setOutlineCollapsed] = useStoredBoolean("fastwrite.outline-collapsed", false);
  const [sidebarBeforeCollapse, setSidebarBeforeCollapse] = useState(254);
  const [pdfBeforeCollapse, setPdfBeforeCollapse] = useState(440);
  const [resizing, setResizing] = useState<"sidebar" | "pdf" | "ai" | "outline" | null>(null);
  const [aiFullscreen, setAiFullscreen] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [addFileOpen, setAddFileOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [settingsTree, setSettingsTree] = useState<WorkspaceTreeNode[]>([]);
  const [deleteError, setDeleteError] = useState("");
  const [compileRequest, setCompileRequest] = useState(0);
  const [compileState, setCompileState] = useState<CompileStateReport>({ state: "idle", compiledVersion: null });
  const [compileRepairRequest, setCompileRepairRequest] = useState<CompileRepairRequest | null>(null);
  const [checkpointState, setCheckpointState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const handleCompileState = useCallback((report: CompileStateReport) => setCompileState((current) => report.state === "idle" && current.state === "success" ? current : report), []);
  const fixCompileWithAgent = useCallback((failure: CompileFailureContext) => {
    setCompileRepairRequest((current) => ({ id: (current?.id ?? 0) + 1, failure }));
    setAiHeight(Math.max(aiHeight, 380));
  }, [aiHeight, setAiHeight]);
  const updateOutlineHeight = useCallback((next: number) => {
    const available = containerRef.current?.clientHeight ?? 760;
    setOutlineHeight(Math.min(Math.max(120, available - 160), Math.max(120, next)));
    setOutlineCollapsed(false);
  }, [setOutlineCollapsed, setOutlineHeight]);

  useEffect(() => {
    const save = () => { void editorRef.current?.flush().catch(() => undefined); };
    window.addEventListener(FASTWRITE_SAVE_EVENT, save);
    return () => window.removeEventListener(FASTWRITE_SAVE_EVENT, save);
  }, []);

  const commitTree = useCallback((nextTree: WorkspaceTreeNode[]) => {
    treeRef.current = nextTree;
    setTree(nextTree);
  }, []);

  const refreshWorkspace = useCallback(async (signal?: AbortSignal, focusPath?: string) => {
    const [nextProject, rootTree, nextOutline] = await Promise.all([api.projects.get(projectId, signal), api.projects.treeLevel(projectId, "", signal), api.projects.outline(projectId, signal)]);
    let nextTree = await hydrateTreePath(projectId, rootTree, nextProject.mainDocument, signal);
    if (focusPath && focusPath !== nextProject.mainDocument) nextTree = await hydrateTreePath(projectId, nextTree, focusPath, signal);
    setProject(nextProject);
    commitTree(nextTree);
    setOutline(nextOutline);
    return nextProject;
  }, [commitTree, projectId]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    Promise.all([api.projects.get(projectId, controller.signal), api.projects.treeLevel(projectId, "", controller.signal), api.projects.outline(projectId, controller.signal), api.compileResults.latest(projectId, controller.signal)])
      .then(async ([nextProject, rootTree, nextOutline, latestCompile]) => {
        const nextTree = await hydrateTreePath(projectId, rootTree, nextProject.mainDocument, controller.signal);
        setProject(nextProject);
        commitTree(nextTree);
        setOutline(nextOutline);
        setSelectedPath(nextProject.mainDocument);
        if (latestCompile) setCompileState({ state: latestCompile.status === "success" ? "success" : "error", compiledVersion: latestCompile.projectVersion });
      })
      .catch((loadError) => {
        if ((loadError as DOMException).name !== "AbortError") setError(loadError instanceof Error ? loadError.message : "Could not open project");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [commitTree, projectId]);

  useEffect(() => {
    if (!selectedPath) {
      setFileDocument(null);
      return;
    }
    const node = findNode(tree, selectedPath);
    if (!node || node.type !== "file" || node.kind !== "text") {
      setFileDocument(null);
      return;
    }
    const controller = new AbortController();
    api.projects.readFile(projectId, selectedPath, controller.signal)
      .then((nextDocument) => {
        setFileDocument(nextDocument);
        setCursorLocation((current) => current.path === selectedPath ? current : { path: selectedPath, line: 1 });
      })
      .catch((readError) => {
        if ((readError as DOMException).name !== "AbortError") setError(readError instanceof Error ? readError.message : "Could not open file");
      });
    return () => controller.abort();
  }, [projectId, selectedPath, tree]);

  useEffect(() => {
    if (!resizing) return;
    const onMove = (event: PointerEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      if (resizing === "sidebar") {
        const next = Math.max(0, Math.min(420, event.clientX - rect.left));
        setSidebarWidth(next < 76 ? 0 : next);
      } else if (resizing === "pdf") {
        const next = Math.max(0, Math.min(780, rect.right - event.clientX));
        const max = Math.max(300, rect.width - Math.max(sidebarWidth, 48) - 420);
        setPdfWidth(next < 150 ? 0 : Math.min(next, max));
      } else if (resizing === "ai") {
        const next = Math.max(220, Math.min(Math.max(220, rect.height - 250), rect.bottom - event.clientY));
        setAiHeight(next);
      } else {
        updateOutlineHeight(rect.bottom - event.clientY);
      }
    };
    const onUp = () => setResizing(null);
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
    document.body.classList.add("is-resizing");
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.classList.remove("is-resizing");
    };
  }, [resizing, setAiHeight, setPdfWidth, setSidebarWidth, sidebarWidth, updateOutlineHeight]);

  const selectNode = (node: WorkspaceTreeNode) => {
    if (node.type === "directory") return;
    setSelectedPath(node.path);
    setCursorLocation({ path: node.path, line: 1 });
    setTargetLine(null);
    setTargetSelection(null);
    setSelection(null);
  };

  const expandDirectory = useCallback(async (path: string) => {
    const children = await api.projects.treeLevel(projectId, path);
    commitTree(replaceDirectoryChildren(treeRef.current, path, children));
  }, [commitTree, projectId]);

  const navigateToPath = useCallback(async (path: string, line?: number) => {
    try {
      const nextTree = await hydrateTreePath(projectId, treeRef.current, path);
      commitTree(nextTree);
      setSelectedPath(path);
      setTargetSelection(null);
      setTargetLine(null);
      if (line) window.setTimeout(() => setTargetLine(line), 120);
    } catch (navigationError) {
      setError(navigationError instanceof Error ? navigationError.message : "Could not open source location");
    }
  }, [commitTree, projectId]);

  const selectOutline = (item: OutlineItem) => {
    void navigateToPath(item.path, item.line);
  };

  const openSettings = async () => {
    try {
      setSettingsTree(await api.projects.tree(projectId));
      setSettingsOpen(true);
    } catch (settingsError) {
      setError(settingsError instanceof Error ? settingsError.message : "Could not load project settings");
    }
  };

  const selectedNode = useMemo(() => selectedPath ? findNode(tree, selectedPath) : null, [selectedPath, tree]);
  const sectionSelection = useMemo(() => currentSectionSelection(fileDocument, outline, cursorLocation), [cursorLocation, fileDocument, outline]);

  const prepareLocalRevision = useCallback(async (issue: ReviewIssue): Promise<TextSelection | null> => {
    const evidence = issue.evidence.find((item) => !item.inferred && (item.excerpt.trim() || item.line));
    if (!evidence) return null;
    const nextTree = await hydrateTreePath(projectId, treeRef.current, evidence.path);
    commitTree(nextTree);
    const opened = await api.projects.readFile(projectId, evidence.path);
    let from = evidence.excerpt.trim() ? opened.content.indexOf(evidence.excerpt.trim()) : -1;
    let to = from >= 0 ? from + evidence.excerpt.trim().length : -1;
    if (from < 0) {
      const lines = opened.content.split("\n");
      const lineNumber = Math.max(1, Math.min(evidence.line ?? 1, lines.length));
      from = lines.slice(0, lineNumber - 1).reduce((total, line) => total + line.length + 1, 0);
      to = from + (lines[lineNumber - 1]?.length ?? 0);
    }
    if (to <= from) return null;
    const nextSelection = makeSelection(evidence.path, opened, from, to);
    setSelectedPath(evidence.path);
    setFileDocument(opened);
    setSelection(nextSelection);
    setTargetSelection(nextSelection);
    setCursorLocation({ path: evidence.path, line: nextSelection.startLine });
    return nextSelection;
  }, [commitTree, projectId]);

  const collapseSidebar = () => {
    if (sidebarWidth > 0) {
      setSidebarBeforeCollapse(sidebarWidth);
      setSidebarWidth(0);
    } else setSidebarWidth(sidebarBeforeCollapse);
  };
  const collapsePdf = () => {
    if (pdfWidth > 0) {
      setPdfBeforeCollapse(pdfWidth);
      setPdfWidth(0);
    } else setPdfWidth(pdfBeforeCollapse);
  };

  const refreshAfterSync = useCallback(async () => {
    const nextProject = await refreshWorkspace(undefined, selectedPath ?? undefined);
    const preferredPath = selectedPath && findNode(treeRef.current, selectedPath) ? selectedPath : nextProject.mainDocument;
    setSelectedPath(preferredPath);
    try {
      setFileDocument(await api.projects.readFile(projectId, preferredPath));
    } catch {
      setSelectedPath(nextProject.mainDocument);
      setFileDocument(await api.projects.readFile(projectId, nextProject.mainDocument));
    }
    setSelection(null);
    setTargetSelection(null);
  }, [projectId, refreshWorkspace, selectedPath]);

  if (loading) return <WorkspaceLoading />;
  if (error || !project) return <WorkspaceError message={error || "Project not found"} />;
  const pdfSourceLocation = selection ? { path: selection.path, line: selection.startLine } : cursorLocation.path ? cursorLocation : null;

  return (
    <div className="workspace-page">
      <header className="workspace-topbar">
        <div className="workspace-topbar__left">
          <IconButton label="Back to projects" icon={<ArrowLeft />} onClick={() => navigate("/projects")} />
          <a className="brand brand--workspace" href="/projects" onClick={(event) => { event.preventDefault(); navigate("/projects"); }}><span className="brand__mark">F</span><span>FastWrite</span></a>
          <span className="topbar-divider" />
          <div className="project-identity"><strong>{project.name}</strong><span>{project.mainDocument}</span></div>
        </div>
        <div className="workspace-topbar__right">
          <span className="skill-badge">{project.skill.name}</span>
          {project.source.type === "github" ? <Button className="workspace-sync-button" size="small" variant="secondary" icon={<RefreshCw />} onClick={() => setSyncOpen(true)}>Sync</Button> : null}
          <IconButton label="Project settings" icon={<MoreHorizontal />} onClick={() => void openSettings()} />
        </div>
      </header>

      <div className="workspace-shell" ref={containerRef}>
        {sidebarWidth > 0 ? (
          <aside className="workspace-sidebar" style={{ width: sidebarWidth }}>
            <section className="sidebar-section sidebar-section--files">
              <header className="panel-heading"><div><FolderTree /><span>Files</span></div><div><IconButton label={checkpointState === "saving" ? "Saving local history checkpoint" : checkpointState === "saved" ? "Local history checkpoint saved" : checkpointState === "error" ? "Retry local history checkpoint" : "Save local history checkpoint"} icon={<GitCommitHorizontal />} disabled={checkpointState === "saving"} onClick={async () => { setCheckpointState("saving"); try { await api.projects.checkpoint(projectId); setCheckpointState("saved"); window.setTimeout(() => setCheckpointState("idle"), 2000); } catch { setCheckpointState("error"); } }} /><IconButton label="New file" icon={<FilePlus2 />} onClick={() => setNewFileOpen(true)} /><IconButton label="Add external file" icon={<Upload />} onClick={() => setAddFileOpen(true)} /><IconButton label="Rename selected file" icon={<Pencil />} disabled={selectedNode?.type !== "file"} onClick={() => setRenameOpen(true)} /><IconButton label="Move selected file to trash" icon={<Trash2 />} variant="danger" disabled={selectedNode?.type !== "file" || selectedPath === project.mainDocument} onClick={() => { setDeleteError(""); setDeleteOpen(true); }} /><IconButton label="Collapse files panel" icon={<ChevronLeft />} onClick={collapseSidebar} /></div></header>
              <FileTree nodes={tree} selectedPath={selectedPath} mainDocument={project.mainDocument} onSelect={selectNode} onExpand={expandDirectory} />
            </section>
            {!outlineCollapsed ? <PanelDivider label="Resize document outline" orientation="horizontal" active={resizing === "outline"} value={outlineHeight} min={120} max={640} onPointerDown={() => setResizing("outline")} onKeyboardChange={updateOutlineHeight} /> : null}
            <section className={`sidebar-section sidebar-section--outline${outlineCollapsed ? " is-collapsed" : ""}`} style={{ height: outlineCollapsed ? 35 : outlineHeight }}>
              <header className="panel-heading panel-heading--plain"><span>Document outline</span><IconButton label={outlineCollapsed ? "Expand document outline" : "Collapse document outline"} icon={outlineCollapsed ? <ChevronUp /> : <ChevronDown />} onClick={() => setOutlineCollapsed(!outlineCollapsed)} /></header>
              {!outlineCollapsed ? <OutlineTree items={outline} onSelect={selectOutline} /> : null}
            </section>
          </aside>
        ) : (
          <button className="collapsed-rail collapsed-rail--left" onClick={collapseSidebar} aria-label="Expand files panel" title="Expand files panel"><ChevronRight /><span>Files</span></button>
        )}
        <PanelDivider label="Resize files panel" active={resizing === "sidebar"} value={sidebarWidth} min={0} max={420} onPointerDown={() => setResizing("sidebar")} onKeyboardChange={setSidebarWidth} />

        <main className="workspace-center">
          <section className="editor-region">
            {fileDocument ? (
              <SourceEditor ref={editorRef} projectId={projectId} document={fileDocument} targetLine={targetLine} targetSelection={targetSelection} onSelection={(nextSelection) => { setSelection(nextSelection); if (nextSelection || !targetSelection) setTargetSelection(null); }} onCursor={setCursorLocation} onSaved={async (saved) => { setFileDocument((current) => current?.file.path === saved.file.path ? saved : current); await refreshWorkspace(undefined, saved.file.path); }} />
            ) : selectedNode?.type === "file" && selectedNode.kind === "image" ? (
              <AssetPreview projectId={projectId} path={selectedNode.path} name={selectedNode.name} />
            ) : (
              <div className="editor-empty"><FolderTree /><h3>Select a source file</h3><p>Choose a LaTeX, Markdown or BibTeX file from the project tree.</p></div>
            )}
          </section>
          <PanelDivider label="Resize AI workspace" orientation="horizontal" active={resizing === "ai"} value={aiHeight} min={220} max={760} onPointerDown={() => setResizing("ai")} onKeyboardChange={setAiHeight} />
          <AiWorkspace project={project} selection={selection} sectionSelection={sectionSelection} height={aiHeight} fullscreen={aiFullscreen} onToggleFullscreen={() => setAiFullscreen((value) => !value)} onUseSelection={(nextSelection) => { setSelection(nextSelection); setTargetSelection(nextSelection); }} onClearSelection={() => { setSelection(null); setTargetSelection(null); }} onRestoreSelection={async (savedSelection) => {
            try {
              const opened = await api.projects.readFile(projectId, savedSelection.path);
              if (opened.file.version !== savedSelection.fileVersion || opened.content.slice(savedSelection.from, savedSelection.to) !== savedSelection.text) return false;
              const restored = makeSelection(savedSelection.path, opened, savedSelection.from, savedSelection.to);
              setSelectedPath(savedSelection.path);
              setFileDocument(opened);
              setSelection(restored);
              setTargetSelection(restored);
              setCursorLocation({ path: restored.path, line: restored.startLine });
              return true;
            } catch { return false; }
          }} onPrepareLocalRevision={prepareLocalRevision} compileState={compileState} compileRepairRequest={compileRepairRequest} onRequestCompile={() => setCompileRequest((value) => value + 1)} onNavigate={(path, line) => { void navigateToPath(path, line); }} onWorkspaceChanged={async () => { await refreshWorkspace(undefined, selectedPath ?? undefined); }} onFileChanged={async (path, range) => {
            const updatedProject = await refreshWorkspace(undefined, path);
            setProject(updatedProject);
            setSelectedPath(path);
            const nextDocument = await api.projects.readFile(projectId, path);
            setFileDocument(nextDocument);
            if (range) {
              const retained = makeSelection(path, nextDocument, range.from, range.to);
              setSelection(retained);
              setTargetSelection(retained);
            } else {
              setSelection(null);
              setTargetSelection(null);
            }
          }} />
        </main>

        <PanelDivider label="Resize PDF preview" active={resizing === "pdf"} value={pdfWidth} min={0} max={780} reverse onPointerDown={() => setResizing("pdf")} onKeyboardChange={setPdfWidth} />
        {pdfWidth > 0 ? (
          <div className="workspace-pdf" style={{ width: pdfWidth }}>
            <PdfPane projectId={projectId} projectVersion={project.version} mainDocument={project.mainDocument} tree={tree} sourceLocation={pdfSourceLocation} compileRequest={compileRequest} onCompileState={handleCompileState} onFixWithAgent={fixCompileWithAgent} onSyncToSource={(location) => { void navigateToPath(location.path, location.line); }} />
            <IconButton className="pdf-collapse" label="Collapse PDF preview" icon={<PanelRightClose />} onClick={collapsePdf} />
          </div>
        ) : (
          <button className="collapsed-rail collapsed-rail--right" onClick={collapsePdf} aria-label="Expand PDF preview" title="Expand PDF preview"><PanelRightOpen /><span>PDF</span></button>
        )}
      </div>

      <NewFileDialog open={newFileOpen} projectId={projectId} onClose={() => setNewFileOpen(false)} onCreated={async (path) => { setNewFileOpen(false); await refreshWorkspace(undefined, path); setSelectedPath(path); }} />
      <AddFileDialog open={addFileOpen} projectId={projectId} onClose={() => setAddFileOpen(false)} onAdded={async (path) => { setAddFileOpen(false); await refreshWorkspace(undefined, path); setSelectedPath(path); }} />
      <RenameFileDialog open={renameOpen} projectId={projectId} path={selectedPath ?? ""} onClose={() => setRenameOpen(false)} onRenamed={async (path) => { setRenameOpen(false); await refreshWorkspace(undefined, path); setSelectedPath(path); }} />
      <ProjectSettingsDialog open={settingsOpen} project={project} tree={settingsTree} onClose={() => setSettingsOpen(false)} onSaved={async (updated) => { setProject(updated); setSettingsOpen(false); await refreshWorkspace(undefined, updated.mainDocument); setSelectedPath(updated.mainDocument); }} />
      {project.source.type === "github" ? <GithubSyncDialog open={syncOpen} project={project} compileState={compileState} onClose={() => setSyncOpen(false)} onFlushEditor={() => editorRef.current?.flush() ?? Promise.resolve()} onWorkspaceApplied={refreshAfterSync} onRequestCompile={() => setCompileRequest((value) => value + 1)} /> : null}
      <Dialog open={deleteOpen} title="Move file to trash?" description={selectedPath ?? ""} onClose={() => setDeleteOpen(false)} footer={<><Button variant="ghost" onClick={() => setDeleteOpen(false)}>Cancel</Button><Button variant="danger" icon={<Trash2 />} onClick={async () => { if (!selectedPath) return; setDeleteError(""); try { await editorRef.current?.flush(); await api.projects.deleteFile(projectId, selectedPath); setDeleteOpen(false); setSelectedPath(project.mainDocument); await refreshWorkspace(); } catch (deleteFailure) { setDeleteError(deleteFailure instanceof Error ? deleteFailure.message : "Could not delete file"); } }}>Move to trash</Button></>}><p className="dialog-copy">The file is moved to the project trash and can be recovered from workspace storage.</p>{deleteError ? <div className="form-error" role="alert">{deleteError}</div> : null}</Dialog>
    </div>
  );
}

function PanelDivider({ label, active, value, min, max, reverse = false, orientation = "vertical", onPointerDown, onKeyboardChange }: { label: string; active: boolean; value: number; min: number; max: number; reverse?: boolean; orientation?: "vertical" | "horizontal"; onPointerDown: () => void; onKeyboardChange: (value: number) => void }) {
  const decreaseKey = orientation === "horizontal" ? "ArrowDown" : "ArrowLeft";
  const increaseKey = orientation === "horizontal" ? "ArrowUp" : "ArrowRight";
  return <div className={`panel-divider panel-divider--${orientation} ${active ? "is-active" : ""}`} role="separator" aria-label={label} aria-orientation={orientation} aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(value)} tabIndex={0} onKeyDown={(event) => {
    const direction = reverse ? -1 : 1;
    if (event.key === decreaseKey) { event.preventDefault(); onKeyboardChange(Math.min(max, Math.max(min, value - 16 * direction))); }
    else if (event.key === increaseKey) { event.preventDefault(); onKeyboardChange(Math.min(max, Math.max(min, value + 16 * direction))); }
    else if (event.key === "Home") { event.preventDefault(); onKeyboardChange(min); }
    else if (event.key === "End") { event.preventDefault(); onKeyboardChange(max); }
  }} onPointerDown={(event) => { event.preventDefault(); onPointerDown(); }}><span /></div>;
}

function AssetPreview({ projectId, path, name }: { projectId: string; path: string; name: string }) {
  return <div className="asset-preview"><div className="editor-toolbar"><div className="editor-toolbar__file"><span>{name}</span><code>{path}</code></div></div><div className="asset-preview__canvas"><img src={`/api/projects/${projectId}/asset?path=${encodeURIComponent(path)}`} alt={name} /></div></div>;
}

function NewFileDialog({ open, projectId, onClose, onCreated }: { open: boolean; projectId: string; onClose: () => void; onCreated: (path: string) => void | Promise<void> }) {
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const create = async () => {
    setLoading(true);
    setError("");
    try {
      const file = await api.projects.createFile(projectId, path.trim());
      setPath("");
      await onCreated(file.path);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Could not create file");
    } finally {
      setLoading(false);
    }
  };
  return <Dialog open={open} title="Create a file" description="Use a workspace-relative path, for example sections/method.tex." onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={loading} disabled={!path.trim()} onClick={() => void create()}>Create file</Button></>}><label className="field"><span>File path</span><input value={path} onChange={(event) => setPath(event.target.value)} placeholder="sections/new-section.tex" autoFocus /></label>{error ? <div className="form-error" role="alert">{error}</div> : null}</Dialog>;
}

function WorkspaceLoading() {
  return <div className="workspace-loading"><span className="brand__mark">F</span><div><strong>Opening paper</strong><span>Loading managed workspace…</span></div></div>;
}

function WorkspaceError({ message }: { message: string }) {
  return <div className="workspace-error"><h1>Could not open this paper</h1><p>{message}</p><Button variant="primary" onClick={() => navigate("/projects")}>Back to projects</Button></div>;
}

function findNode(nodes: WorkspaceTreeNode[], path: string): WorkspaceTreeNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.type === "directory") {
      const child = findNode(node.children, path);
      if (child) return child;
    }
  }
  return null;
}

async function hydrateTreePath(projectId: string, initialTree: WorkspaceTreeNode[], filePath: string, signal?: AbortSignal): Promise<WorkspaceTreeNode[]> {
  let nextTree = initialTree;
  const segments = filePath.split("/").filter(Boolean);
  let directoryPath = "";
  for (const segment of segments.slice(0, -1)) {
    directoryPath = directoryPath ? `${directoryPath}/${segment}` : segment;
    const directory = findNode(nextTree, directoryPath);
    if (directory?.type === "directory" && directory.loaded === true) continue;
    const children = await api.projects.treeLevel(projectId, directoryPath, signal);
    nextTree = replaceDirectoryChildren(nextTree, directoryPath, children);
  }
  return nextTree;
}

function replaceDirectoryChildren(nodes: WorkspaceTreeNode[], path: string, children: WorkspaceTreeNode[]): WorkspaceTreeNode[] {
  return nodes.map((node) => {
    if (node.type !== "directory") return node;
    if (node.path === path) return { ...node, children, loaded: true };
    return { ...node, children: replaceDirectoryChildren(node.children, path, children) };
  });
}

function makeSelection(path: string, document: FileContentResponse, requestedFrom: number, requestedTo: number): TextSelection {
  const from = Math.max(0, Math.min(requestedFrom, document.content.length));
  const to = Math.max(from, Math.min(requestedTo, document.content.length));
  return {
    path,
    text: document.content.slice(from, to),
    from,
    to,
    startLine: lineAtOffset(document.content, from),
    endLine: lineAtOffset(document.content, to),
    fileVersion: document.file.version
  };
}

function lineAtOffset(content: string, offset: number): number {
  return content.slice(0, Math.max(0, Math.min(offset, content.length))).split("\n").length;
}

function useStoredNumber(key: string, initial: number): [number, (value: number) => void] {
  const [value, setValue] = useState(() => Number.parseInt(localStorage.getItem(key) ?? "", 10) || initial);
  const update = useCallback((next: number) => {
    setValue(next);
    localStorage.setItem(key, String(Math.round(next)));
  }, [key]);
  return [value, update];
}

function useStoredBoolean(key: string, initial: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    const stored = localStorage.getItem(key);
    return stored === null ? initial : stored === "true";
  });
  const update = useCallback((next: boolean) => {
    setValue(next);
    localStorage.setItem(key, String(next));
  }, [key]);
  return [value, update];
}
