import { BrandMark } from "../components/BrandMark";
import { userFacingError } from "../lib/notifications";
import { statusLabel, roleLabel } from "../lib/labels";
import type { ReferenceSettings, ReferencePaper } from "@fastwrite/shared";
import type { ReferenceWriteAction } from "../components/workspace/ReferenceStylePanel";
import { useFileDropTarget } from "../lib/uploads/use-file-drop-target";
import { readDroppedFiles, type DroppedFile } from "../lib/uploads/drop-files";
import { ReferenceStylePanel } from "../components/workspace/ReferenceStylePanel";
import { SkillDetailPanel } from "../components/workspace/SkillDetailPanel";
import { SkillPanel } from "../components/workspace/SkillPanel";
import { useTaskSkills, taskSkillLabel } from "../lib/useTaskSkills";
import { projectDocumentRegistry } from "../lib/editor/documentRegistry";
import { QuickOpenDialog } from "../components/workbench/QuickOpenDialog";
import { EditorTabs, diffRequestKey, type ComparisonTab } from "../components/workbench/EditorTabs";
import { openSourceTab, pinSourceTab, type SourceTab } from "../lib/editor/tabState";
import { ActivityBar, type SidebarView } from "../components/workbench/ActivityBar";
import { SourceControlView, type DiffRequest } from "../components/workbench/SourceControlView";
import { NavigationController, type NavigationRequest } from "../lib/editor/navigationController";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  FileContentResponse,
  OutlineItem,
  PaperClaim,
  PaperProject,
  ReviewIssue,
  SourceLocation,
  TextSelection,
  WorkspaceTreeNode,
  EvidenceCockpit,
} from "@fastwrite/shared";
import { api, ApiClientError } from "../api/client";
import { Button, Checkbox, Dialog, Field, Icon, IconButton, Link, Select, TabBar, TextArea, TextField, ThemeToggle, icons } from "../components/ui";
import { FileTree } from "../components/workspace/FileTree";
import { AddFileDialog } from "../components/workspace/AddFileDialog";
import { OutlineTree } from "../components/workspace/OutlineTree";
import type { CompileStateReport } from "../components/workspace/PdfPane";
import { ProjectSettingsEditor } from "../components/workspace/ProjectSettingsEditor";
import { RenameFileDialog } from "../components/workspace/RenameFileDialog";
import { CollaborationPanel } from "../components/workspace/CollaborationPanel";
import { useProjectCollaboration } from "../lib/useProjectCollaboration";
import { CollaborationButton } from "../components/workspace/CollaborationButton";
import type { SourceEditorHandle, WritingMode } from "../components/workspace/SourceEditor";
import { AiWorkspace } from "../components/workspace/AiWorkspace";
import { GithubSyncDialog } from "../components/workspace/GithubSyncDialog";
import { ComplianceDialog } from "../components/workspace/ComplianceDialog";
import type {
  CompileFailureContext,
  CompileRepairRequest,
} from "../components/workspace/compileRepair";
import { navigate } from "../lib/navigation";
import {
  currentParagraphSelection,
  currentSectionSelection,
} from "../lib/sectionSelection";
import { FASTWRITE_SAVE_EVENT } from "../lib/keyboard";
import { publicationTargetAbbreviation } from "../lib/labels";
import { ProvenanceDialog } from "../components/workspace/ProvenanceDialog";
import { canUseOfflineCache, loadWorkspaceFile, loadWorkspaceSnapshot, saveWorkspaceFile, saveWorkspaceSnapshot } from "../lib/offlineWorkspace";

const SourceEditor = lazy(() =>
  import("../components/workspace/SourceEditor").then((module) => ({
    default: module.SourceEditor,
  })),
);
const PdfPane = lazy(() =>
  import("../components/workspace/PdfPane").then((module) => ({
    default: module.PdfPane,
  })),
);

interface WorkspacePageProps {
  projectId: string;
}

const WorkspaceDiffEditor = lazy(() => import("../components/workbench/WorkspaceDiffEditor").then(module => ({ default: module.WorkspaceDiffEditor })));

export function WorkspacePage({ projectId }: WorkspacePageProps) {
  const registry = useMemo(() => projectDocumentRegistry(projectId), [projectId]);
  useEffect(() => registry.attachOwner(), [registry]);
  const containerRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<WorkspaceTreeNode[]>([]);
  const editorRef = useRef<SourceEditorHandle>(null);
  const [completionEnabled, setCompletionEnabled] = useState(() => localStorage.getItem("fastwrite.completion.enabled") !== "false");
  const [referenceSettings, setReferenceSettings] = useState<ReferenceSettings | null>(null);
  const [referencePapers, setReferencePapers] = useState<ReferencePaper[]>([]);
  const [referenceAction, setReferenceAction] = useState<ReferenceWriteAction | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setReferenceSettings(null); setReferencePapers([]); setReferenceAction(null);
    void Promise.all([api.referencePapers.settings(projectId, controller.signal), api.referencePapers.list(projectId, controller.signal)]).then(([settings, papers]) => { if (!controller.signal.aborted) { setReferenceSettings(settings); setReferencePapers(papers); } }).catch(() => {});
    return () => controller.abort();
  }, [projectId]);
  const removeWritingReference = async (id: string) => {
    if (!referenceSettings) return;
    try { setReferenceSettings(await api.referencePapers.saveSettings(projectId, referenceSettings.selections.filter(item => item.referenceId !== id), referenceSettings.revision)); }
    catch { const settings = await api.referencePapers.settings(projectId); setReferenceSettings(settings); }
  };

  const [sourceTabs, setSourceTabs] = useState<SourceTab[]>([]);
  const [dirtyFiles, setDirtyFiles] = useState<Record<string, boolean>>({});
  const [tabError, setTabError] = useState("");
  const rootDrop = useFileDropTarget((transfer) => receiveDrop(transfer, ""));
  const [sidebarView, setSidebarView] = useStoredString(`fastwrite.workbench-layout:${projectId}:sidebar-view`, "files", ["files", "git", "evidence", "outline", "reference-style", "skills", "collaboration"] as const);
  const [skillRevision, setSkillRevision] = useState(0);
  const taskSkills = useTaskSkills(projectId, skillRevision);
  const [skillTabs, setSkillTabs] = useState<Array<{ id: string; label: string }>>([]);
  const [activeSkill, setActiveSkill] = useState<string | null>(null);
  useEffect(() => { setSkillTabs([]); setActiveSkill(null); }, [projectId]);
  const [skillTaskRequest, setSkillTaskRequest] = useState(0);
  const [historyDiff, setHistoryDiff] = useState<DiffRequest | null>(null);
  const [comparisonTabs, setComparisonTabs] = useState<ComparisonTab[]>([]);
  const comparisonTabsRef = useRef(comparisonTabs); comparisonTabsRef.current = comparisonTabs;
  const historyDiffRef = useRef(historyDiff); historyDiffRef.current = historyDiff;
  const diffPdfWidth = useRef<number | null>(null);
  const [buffersDirty, setBuffersDirty] = useState(false);
  const prepareCompile = useCallback(async () => { await editorRef.current?.flush(); await registry.flush(); }, [registry]);
  const [project, setProject] = useState<PaperProject | null>(null);
  const [tree, setTree] = useState<WorkspaceTreeNode[]>([]);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [claims, setClaims] = useState<PaperClaim[]>([]);
  const [evidenceCockpit, setEvidenceCockpit] = useState<EvidenceCockpit | null>(null);
  const [claimStatusFilter, setClaimStatusFilter] = useState<"all" | PaperClaim["reviewStatus"] | "stale" | "orphaned">("all");
  const [claimPathFilter, setClaimPathFilter] = useState("all");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  useEffect(() => { if (selectedPath) setSourceTabs(tabs => openSourceTab(tabs, selectedPath)); }, [selectedPath]);
  useEffect(() => { setSourceTabs([]); setDirtyFiles({}); setHistoryDiff(null); setComparisonTabs([]); setSelectedPath(null); }, [projectId]);
  const [quickOpen, setQuickOpen] = useState(false);
  const tabsStateRef = useRef({ projectId, selectedPath, sourceTabs });
  tabsStateRef.current = { projectId, selectedPath, sourceTabs };
  const [fileDocument, setFileDocument] = useState<FileContentResponse | null>(
    null,
  );
  const navigationRef = useRef(new NavigationController());
  const [targetLine, setTargetLine] = useState<NavigationRequest | null>(null);
  useEffect(() => () => navigationRef.current.cancel(), [projectId]);
  const [targetSelection, setTargetSelection] = useState<TextSelection | null>(
    null,
  );
  const [selection, setSelection] = useState<TextSelection | null>(null);
  const [cursorLocation, setCursorLocation] = useState<SourceLocation>({
    path: "",
    line: 1,
  });
  const collaboration = useProjectCollaboration(projectId, registry, selectedPath, cursorLocation);
  const [writingMode, setWritingMode] = useState<WritingMode | "auto">("auto");
  const [editingMode, setEditingMode] = useState<WritingMode>("viewing");
  const [activeCommentId, setActiveCommentId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [offlineNotice, setOfflineNotice] = useState("");
  const [sidebarWidth, setSidebarWidth] = useStoredNumber(
    `fastwrite.workbench-layout:${projectId}:sidebar-width`,
    254,
  );
  const [pdfWidth, setPdfWidth] = useStoredNumber(`fastwrite.workbench-layout:${projectId}:pdf-width`, 440);
  const [aiHeight, setAiHeight] = useStoredNumber(`fastwrite.workbench-layout:${projectId}:bottom-height`, 280);
  const [outlineHeight, setOutlineHeight] = useStoredNumber(
    `fastwrite.workbench-layout:${projectId}:outline-height`,
    250,
  );
  const [outlineCollapsed, setOutlineCollapsed] = useStoredBoolean(
    `fastwrite.workbench-layout:${projectId}:outline-collapsed`,
    false,
  );
  const [sidebarBeforeCollapse, setSidebarBeforeCollapse] = useStoredNumber(`fastwrite.workbench-layout:${projectId}:sidebar-expanded-width`, sidebarWidth || 254);
  useEffect(() => {
    if (sidebarWidth > 0) setSidebarBeforeCollapse(sidebarWidth);
  }, [sidebarWidth]);
  useEffect(() => {
    const threadId = new URLSearchParams(window.location.search).get("discussion");
    if (!threadId || !/^thread_[a-zA-Z0-9_-]+$/.test(threadId)) return;
    setActiveCommentId(threadId); setSidebarView("collaboration"); if (sidebarWidth === 0) setSidebarWidth(sidebarBeforeCollapse);
  }, [projectId]);
  const [pdfBeforeCollapse, setPdfBeforeCollapse] = useState(440);
  const [resizing, setResizing] = useState<
    "sidebar" | "pdf" | "ai" | "outline" | null
  >(null);
  const [panelCollapsed, setPanelCollapsed] = useStoredBoolean(`fastwrite.workbench-layout:${projectId}:bottom-collapsed`, false);
  const [bottomPanelTab, setBottomPanelTab] = useStoredString(`fastwrite.workbench-layout:${projectId}:bottom-tab`, "ai", ["ai", "problems", "output"] as const);
  const [compactViewport, setCompactViewport] = useState(() => ({ sidebar: window.innerWidth < 760, pdf: window.innerWidth < 1080, panel: window.innerHeight < 640 || window.innerWidth < 540 }));
  useEffect(() => {
    const adapt = () => setCompactViewport({ sidebar: window.innerWidth < 760, pdf: window.innerWidth < 1080, panel: window.innerHeight < 640 || window.innerWidth < 540 });
    adapt(); window.addEventListener("resize", adapt);
    return () => window.removeEventListener("resize", adapt);
  }, []);
  const [aiFullscreen, setAiFullscreen] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [addFileOpen, setAddFileOpen] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<DroppedFile[]>([]);
  const [dropDirectory, setDropDirectory] = useState("");
  const receiveDrop = (transfer: DataTransfer, directory: string) => { if (!collaboration.access?.canWrite) return; void readDroppedFiles(transfer).then(files => { setDroppedFiles(files); setDropDirectory(directory); setAddFileOpen(true); }).catch(error => window.alert(userFacingError(error, String(error)))); };
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsActive, setSettingsActive] = useState(false);
  const settingsPanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setSettingsOpen(false); setSettingsActive(false); }, [projectId]);
  const [syncOpen, setSyncOpen] = useState(false);
  const [complianceOpen, setComplianceOpen] = useState(false);
  const [provenanceOpen, setProvenanceOpen] = useState(false);
  const [settingsTree, setSettingsTree] = useState<WorkspaceTreeNode[]>([]);
  const [deleteError, setDeleteError] = useState("");
  const [compileRequest, setCompileRequest] = useState(0);
  const [compileState, setCompileState] = useState<CompileStateReport>({
    state: "idle",
    compiledVersion: null,
    diagnostics: [],
    log: "",
    progress: "准备编译",
  });
  const [compileRepairRequest, setCompileRepairRequest] =
    useState<CompileRepairRequest | null>(null);
  const [checkpointState, setCheckpointState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [shareOpen, setShareOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const handleCompileState = useCallback(
    (report: CompileStateReport) =>
      setCompileState((current) =>
        report.state === "idle" && current.state === "success"
          ? current
          : report,
      ),
    [],
  );
  const fixCompileWithAgent = useCallback(
    (failure: CompileFailureContext) => {
      setBottomPanelTab("ai");
      setPanelCollapsed(false);
      setCompileRepairRequest((current) => ({
        id: (current?.id ?? 0) + 1,
        failure,
      }));
      setAiHeight(Math.max(aiHeight, 380));
    },
    [aiHeight, setAiHeight, setBottomPanelTab, setPanelCollapsed],
  );
  const updateOutlineHeight = useCallback(
    (next: number) => {
      const available = containerRef.current?.clientHeight ?? 760;
      setOutlineHeight(
        Math.min(Math.max(120, available - 160), Math.max(120, next)),
      );
      setOutlineCollapsed(false);
    },
    [setOutlineCollapsed, setOutlineHeight],
  );

  useEffect(() => {
    const save = () => {
      if (settingsActive) {
        settingsPanelRef.current?.querySelector<HTMLButtonElement>('button[data-save-command]:not(:disabled)')?.click();
        return;
      }
      void prepareCompile().catch(failure => setTabError(userFacingError(failure, "保存失败，已保留本地文本")));
    };
    window.addEventListener(FASTWRITE_SAVE_EVENT, save);
    return () => window.removeEventListener(FASTWRITE_SAVE_EVENT, save);
  }, [prepareCompile, settingsActive]);

  const commitTree = useCallback((nextTree: WorkspaceTreeNode[]) => {
    treeRef.current = nextTree;
    setTree(nextTree);
  }, []);

  const refreshWorkspace = useCallback(
    async (signal?: AbortSignal, focusPath?: string) => {
      const [nextProject, rootTree, nextOutline] = await Promise.all([
        api.projects.get(projectId, signal),
        api.projects.treeLevel(projectId, "", signal),
        api.projects.outline(projectId, signal),
      ]);
      let nextTree = await hydrateTreePath(
        projectId,
        rootTree,
        nextProject.mainDocument,
        signal,
      );
      if (focusPath && focusPath !== nextProject.mainDocument)
        nextTree = await hydrateTreePath(
          projectId,
          nextTree,
          focusPath,
          signal,
        );
      setProject(nextProject);
      commitTree(nextTree);
      setOutline(nextOutline);
      return nextProject;
    },
    [commitTree, projectId],
  );

  useEffect(() => {
    const version = collaboration.access?.projectVersion;
    if (!project || !version || version <= project.version) return;
    const controller = new AbortController();
    void refreshWorkspace(controller.signal, selectedPath ?? undefined).then(nextProject => {
      if (controller.signal.aborted || !selectedPath || findNode(treeRef.current, selectedPath)) return;
      const entry = registry.get(selectedPath);
      if (!entry || !registry.dirtyEntry(entry)) { setSelectedPath(nextProject.mainDocument); setSelection(null); setTargetSelection(null); }
    }).catch(() => undefined);
    return () => controller.abort();
  }, [collaboration.access?.projectVersion, project?.version, refreshWorkspace, registry, selectedPath]);

  useEffect(() => {
    registry.onSaved = saved => refreshWorkspace(undefined, saved.file.path).then(() => undefined);
    const sync = () => {
      setBuffersDirty(registry.dirty);
      const next = Object.fromEntries([...registry.entries.values()].map(entry => [entry.session.path, registry.dirtyEntry(entry)]));
      setDirtyFiles(current => Object.keys(current).length === Object.keys(next).length && Object.entries(next).every(([path, dirty]) => current[path] === dirty) ? current : next);
      setSourceTabs(tabs => tabs.some(tab => next[tab.path] && !tab.pinned) ? tabs.map(tab => next[tab.path] ? { ...tab, pinned: true } : tab) : tabs);
    };
    const unsubscribe = registry.subscribe(sync);
    const online = () => { void registry.flush().catch(() => undefined); };
    const beforeUnload = (event: BeforeUnloadEvent) => { if (registry.dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("online", online); window.addEventListener("beforeunload", beforeUnload);
    sync();
    return () => { unsubscribe(); registry.onSaved = undefined; window.removeEventListener("online", online); window.removeEventListener("beforeunload", beforeUnload); };
  }, [registry, refreshWorkspace]);
  useEffect(() => registry.retain(sourceTabs.map(tab => tab.path)), [registry, sourceTabs]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    Promise.all([
      api.projects.get(projectId, controller.signal),
      api.projects.treeLevel(projectId, "", controller.signal),
      api.projects.outline(projectId, controller.signal),
      api.compileResults.latest(projectId, controller.signal),
      api.claims.list(projectId),
      api.claims.cockpit(projectId),
    ])
      .then(
        async ([
          nextProject,
          rootTree,
          nextOutline,
          latestCompile,
          nextClaims,
          nextCockpit,
        ]) => {
          const nextTree = await hydrateTreePath(
            projectId,
            rootTree,
            nextProject.mainDocument,
            controller.signal,
          );
          setProject(nextProject);
          commitTree(nextTree);
          setOutline(nextOutline);
          setClaims(nextClaims);
          setEvidenceCockpit(nextCockpit);
          setOfflineNotice("");
          void saveWorkspaceSnapshot(projectId, { project: nextProject, tree: nextTree, outline: nextOutline, claims: nextClaims });
          setSelectedPath(nextProject.mainDocument);
          if (latestCompile)
            setCompileState({
              state: latestCompile.status === "success" ? "success" : "error",
              compiledVersion: latestCompile.projectVersion,
              diagnostics: [],
              log: "",
              progress: latestCompile.summary,
            });
        },
      )
      .catch(async (loadError) => {
        if ((loadError as DOMException).name === "AbortError") return;
        const snapshot = canUseOfflineCache(loadError) ? await loadWorkspaceSnapshot(projectId) : null;
        if (controller.signal.aborted) return;
        if (snapshot) {
          setProject(snapshot.project); commitTree(snapshot.tree); setTree(snapshot.tree); setOutline(snapshot.outline); setClaims(snapshot.claims); setSelectedPath(snapshot.project.mainDocument);
          const cachedMain = await loadWorkspaceFile<FileContentResponse>(projectId, snapshot.project.mainDocument);
          if (controller.signal.aborted) return;
          if (cachedMain) setFileDocument(cachedMain);
          setError("");
          setOfflineNotice("已加载离线工作区快照，缓存文件仍可使用。联网后请重新加载以刷新项目。");
        } else setError(userFacingError(loadError, "无法打开项目"));
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [commitTree, projectId]);

  useEffect(() => {
    if (!selectedPath) {
      setFileDocument(null);
      return;
    }
    const node = findNode(treeRef.current, selectedPath);
    if (!node || node.type !== "file" || node.kind !== "text") {
      setFileDocument(null);
      return;
    }
    const cached = registry.document(selectedPath);
    if (cached && cached.file.version >= node.version) {
      setFileDocument(cached);
      return;
    }
    const controller = new AbortController();
    api.projects
      .readFile(projectId, selectedPath, controller.signal)
      .then((nextDocument) => {
        if (controller.signal.aborted) return;
        void saveWorkspaceFile(projectId, selectedPath, nextDocument);
        setFileDocument(nextDocument);
        setCursorLocation((current) =>
          current.path === selectedPath
            ? current
            : { path: selectedPath, line: 1 },
        );
      })
      .catch(async (readError) => {
        if ((readError as DOMException).name === "AbortError") return;
        const cachedFile = canUseOfflineCache(readError) ? await loadWorkspaceFile<FileContentResponse>(projectId, selectedPath) : null;
        if (controller.signal.aborted) return;
        if (cachedFile) setFileDocument(cachedFile);
        else setError(userFacingError(readError, "无法打开文件"));
      });
    return () => controller.abort();
  }, [projectId, selectedPath, registry]);

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
        const max = Math.max(
          300,
          rect.width - Math.max(sidebarWidth, 48) - 420,
        );
        setPdfWidth(next < 150 ? 0 : Math.min(next, max));
      } else if (resizing === "ai") {
        const next = Math.max(
          220,
          Math.min(
            Math.max(220, rect.height - 250),
            rect.bottom - event.clientY,
          ),
        );
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
  }, [
    resizing,
    setAiHeight,
    setPdfWidth,
    setSidebarWidth,
    sidebarWidth,
    updateOutlineHeight,
  ]);

  const closeHistoryDiff = useCallback(() => {
    setActiveSkill(null);
    setSettingsActive(false);
    setHistoryDiff(null);
    if (diffPdfWidth.current !== null) { setPdfWidth(diffPdfWidth.current); diffPdfWidth.current = null; }
  }, [setPdfWidth]);

  const selectNode = (node: WorkspaceTreeNode) => {
    if (node.type === "directory") return;
    closeHistoryDiff();
    navigationRef.current.cancel();
    setSelectedPath(node.path);
    setCursorLocation({ path: node.path, line: 1 });
    setTargetLine(null);
    setTargetSelection(null);
    setSelection(null);
  };

  const expandDirectory = useCallback(
    async (path: string) => {
      const children = await api.projects.treeLevel(projectId, path);
      commitTree(replaceDirectoryChildren(treeRef.current, path, children));
    },
    [commitTree, projectId],
  );

  const navigateToPath = useCallback(
    async (path: string, line?: number) => {
      closeHistoryDiff();
      const request = navigationRef.current.begin(projectId, path, line);
      try {
        const nextTree = await hydrateTreePath(
          projectId,
          treeRef.current,
          path,
        );
        if (!navigationRef.current.isCurrent(request)) return;
        commitTree(nextTree);
        setSelectedPath(path);
        setTargetSelection(null);
        setTargetLine(line === undefined ? null : request);
      } catch (navigationError) {
        if (!navigationRef.current.isCurrent(request)) return;
        setError(
          userFacingError(navigationError, "无法打开源文件位置"),
        );
      }
    },
    [closeHistoryDiff, commitTree, projectId],
  );

  const selectOutline = (item: OutlineItem) => { void navigateToPath(item.path, item.line); };
  const selectClaim = async (claim: PaperClaim) => {
    if (claim.anchorStatus === "orphaned") { setError("此论断的源文件已不存在，请先恢复文件或重新定位论断。"); return; }
    try {
      let opened = registry.document(claim.anchor.path) ?? await api.projects.readFile(projectId, claim.anchor.path);
      let resolved = claim;
      if (claim.anchorStatus !== "current" || claim.anchor.fileVersion !== opened.file.version || opened.content.slice(claim.anchor.startOffset, claim.anchor.endOffset) !== claim.anchor.exactText) {
        resolved = await api.claims.reanchor(projectId, claim.id);
        setClaims(current => current.map(item => item.id === resolved.id ? resolved : item));
        opened = registry.document(resolved.anchor.path) ?? await api.projects.readFile(projectId, resolved.anchor.path);
      }
      if (resolved.anchorStatus === "orphaned" || resolved.anchor.fileVersion !== opened.file.version || opened.content.slice(resolved.anchor.startOffset, resolved.anchor.endOffset) !== resolved.anchor.exactText) { setError("无法核实此版本中的论断位置，未使用旧位置打开文件。"); return; }
      const nextTree = await hydrateTreePath(projectId, treeRef.current, resolved.anchor.path);
      commitTree(nextTree);
      const nextSelection = makeSelection(resolved.anchor.path, opened, resolved.anchor.startOffset, resolved.anchor.endOffset);
      closeHistoryDiff(); navigationRef.current.cancel(); setSelectedPath(resolved.anchor.path); setFileDocument(opened); setTargetLine(null); setSelection(nextSelection); setTargetSelection(nextSelection); setCursorLocation({ path: resolved.anchor.path, line: nextSelection.startLine, column: 1 });
    } catch (failure) { setError(userFacingError(failure, "无法核实论断位置")); }
  };
  const selectEvidenceClaim = async (claim: PaperClaim) => {
    setSidebarView("evidence");
    await selectClaim(claim);
  };
  const claimPaths = useMemo(() => [...new Set(claims.map(claim => claim.anchor.path))].sort((a, b) => a.localeCompare(b)), [claims]);
  const visibleClaims = useMemo(() => claims.filter(claim => {
    const statusMatches = claimStatusFilter === "all"
      ? true
      : claimStatusFilter === "stale" || claimStatusFilter === "orphaned"
        ? claim.anchorStatus === claimStatusFilter
        : claimStatusFilter === "needs-review"
          ? claim.reviewStatus === "needs-review" || claim.reviewStatus === "detected"
          : claim.anchorStatus !== "stale" && claim.anchorStatus !== "orphaned" && claim.reviewStatus === claimStatusFilter;
    return statusMatches && (claimPathFilter === "all" || claim.anchor.path === claimPathFilter);
  }), [claimPathFilter, claimStatusFilter, claims]);

  const openSettings = async () => {
    setActiveSkill(null);
    setSettingsActive(true);
    if (settingsOpen) return;
    setSettingsTree(tree);
    setSettingsOpen(true);
    try {
      setSettingsTree(await api.projects.tree(projectId));
    } catch (settingsError) {
      setTabError(userFacingError(settingsError, "无法加载设置所需的全部项目文件"));
    }
  };

  const selectedNode = useMemo(
    () => (selectedPath ? findNode(tree, selectedPath) : null),
    [selectedPath, tree],
  );
  const sectionSelection = useMemo(
    () => currentSectionSelection(fileDocument ? registry.document(fileDocument.file.path) ?? fileDocument : null, outline, cursorLocation),
    [cursorLocation, fileDocument, outline, registry],
  );
  const paragraphSelection = useMemo(
    () => currentParagraphSelection(fileDocument ? registry.document(fileDocument.file.path) ?? fileDocument : null, cursorLocation),
    [cursorLocation, fileDocument, registry],
  );
  const activeOutlineId = useMemo(() => activeOutline(outline, cursorLocation), [outline, cursorLocation]);

  const prepareLocalRevision = useCallback(
    async (issue: ReviewIssue): Promise<TextSelection | null> => {
      const evidence = issue.evidence.find(
        (item) => !item.inferred && (item.excerpt.trim() || item.line),
      );
      if (!evidence?.path) return null;
      const nextTree = await hydrateTreePath(
        projectId,
        treeRef.current,
        evidence.path,
      );
      commitTree(nextTree);
      const opened = await api.projects.readFile(projectId, evidence.path);
      let from = evidence.excerpt.trim()
        ? opened.content.indexOf(evidence.excerpt.trim())
        : -1;
      let to = from >= 0 ? from + evidence.excerpt.trim().length : -1;
      if (from < 0) {
        const lines = opened.content.split("\n");
        const lineNumber = Math.max(
          1,
          Math.min(evidence.line ?? 1, lines.length),
        );
        from = lines
          .slice(0, lineNumber - 1)
          .reduce((total, line) => total + line.length + 1, 0);
        to = from + (lines[lineNumber - 1]?.length ?? 0);
      }
      if (to <= from) return null;
      const nextSelection = makeSelection(evidence.path, opened, from, to);
      closeHistoryDiff();
      setSelectedPath(evidence.path);
      setFileDocument(opened);
      setSelection(nextSelection);
      setTargetSelection(nextSelection);
      setCursorLocation({ path: evidence.path, line: nextSelection.startLine });
      return nextSelection;
    },
    [closeHistoryDiff, commitTree, projectId],
  );

  const collapseSidebar = useCallback(() => {
    if (sidebarWidth > 0) {
      setSidebarBeforeCollapse(sidebarWidth);
      setSidebarWidth(0);
    } else setSidebarWidth(sidebarBeforeCollapse);
  }, [sidebarWidth, sidebarBeforeCollapse, setSidebarWidth]);
  const collapsePdf = () => {
    if (pdfWidth > 0) {
      setPdfBeforeCollapse(pdfWidth);
      setPdfWidth(0);
    } else setPdfWidth(pdfBeforeCollapse);
  };

  const refreshAfterSync = useCallback(async () => {
    const nextProject = await refreshWorkspace(
      undefined,
      selectedPath ?? undefined,
    );
    const preferredPath =
      selectedPath && findNode(treeRef.current, selectedPath)
        ? selectedPath
        : nextProject.mainDocument;
    setSelectedPath(preferredPath);
    try {
      setFileDocument(await api.projects.readFile(projectId, preferredPath));
    } catch {
      setSelectedPath(nextProject.mainDocument);
      setFileDocument(
        await api.projects.readFile(projectId, nextProject.mainDocument),
      );
    }
    setSelection(null);
    setTargetSelection(null);
  }, [projectId, refreshWorkspace, selectedPath]);

  const chooseSidebar = (view: SidebarView) => {
    if (view === sidebarView || sidebarWidth === 0) collapseSidebar();
    setSidebarView(view);
  };
  const openHistoryDiff = (request: DiffRequest) => {
    setActiveSkill(null);
    setSettingsActive(false);
    const key = diffRequestKey(request);
    setComparisonTabs(tabs => tabs.some(tab => tab.key === key) ? tabs : [...tabs, { key, request }]);
    setHistoryDiff(request);
    if (window.innerWidth < 1600 && diffPdfWidth.current === null) { diffPdfWidth.current = pdfWidth; setPdfWidth(0); }
  };
  const closeComparisonTab = async (key: string, returnToSource = false) => {
    const tab = comparisonTabsRef.current.find(item => item.key === key); if (!tab) return;
    try {
      if (tab.request.targetRef === "working") { const entry = registry.get(tab.request.path); if (entry) await registry.flushEntry(entry); }
      if (tabsStateRef.current.projectId !== projectId) return;
      const remaining = comparisonTabsRef.current.filter(item => item.key !== key);
      setComparisonTabs(remaining);
      if (historyDiffRef.current && diffRequestKey(historyDiffRef.current) === key) {
        if (!returnToSource && remaining.length) openHistoryDiff(remaining.at(-1)!.request);
        else closeHistoryDiff();
      }
    } catch (failure) { setTabError(userFacingError(failure, "无法保存对比结果，已保留本地文本")); }
  };
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "p" && !event.shiftKey) { event.preventDefault(); setQuickOpen(true); }
      if (key === "b" && !event.shiftKey) { event.preventDefault(); collapseSidebar(); }
      if (event.shiftKey && (key === "e" || key === "g")) { event.preventDefault(); const view = key === "e" ? "files" : "git"; setSidebarView(view); if (sidebarWidth === 0) collapseSidebar(); }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [sidebarWidth, setSidebarView, collapseSidebar]);

  if (loading) return <WorkspaceLoading />;
  if (error || !project)
    return <WorkspaceError message={error || "项目不存在"} />;
  const pdfSourceLocation = selection
    ? { path: selection.path, line: selection.startLine }
    : cursorLocation.path
      ? cursorLocation
      : null;
  // Keep the activity bar and an explicitly selected view usable on narrow screens.
  const sidebarForcedCollapsed = false;
  const pdfForcedCollapsed = compactViewport.pdf;
  const bottomPanelHidden = panelCollapsed || compactViewport.panel;

  return (
    <div className="workspace-page">
      {offlineNotice ? <div role="status" className="workspace-offline-notice">{offlineNotice}</div> : null}
      <header className="workspace-topbar">
        <div className="workspace-topbar__left">
          <IconButton
            label="返回项目列表"
            icon={<Icon name={icons.arrowLeft} />}
            onClick={() => navigate("/projects")}
          />
          <Link
            variant="inherit"
            className="brand brand--workspace"
            href="/projects"
          >
            <BrandMark />
            <span>FastWrite</span>
          </Link>
          <span className="topbar-divider" />
          <div className="project-identity">
            <strong>{project.name}</strong>
            <span>{project.mainDocument}</span>
          </div>
        </div>
        <div className="workspace-topbar__right">
          <CollaborationButton key={projectId} registry={registry} path={!activeSkill && !settingsActive && !historyDiff ? fileDocument?.file.path ?? null : null} />
          <span
            className="skill-badge"
            title={project.publicationTarget?.venueId ?? project.skill.name}
          >
            {publicationTargetAbbreviation(
              project.publicationTarget,
              project.skill.id,
            )}
          </span>
          <Button
            size="small"
            variant="secondary"
            icon={<Icon name={icons.verified} />}
            onClick={() => setComplianceOpen(true)}
          >
            投稿检查
          </Button>
          <Button size="small" variant="secondary" icon={<Icon name={icons.history} />} onClick={() => setProvenanceOpen(true)}>溯源记录</Button>
          <Button size="small" variant="secondary" icon={<Icon name={icons.comment} />} aria-pressed={sidebarView === "collaboration" && sidebarWidth > 0} onClick={() => { setSidebarView("collaboration"); if (sidebarWidth === 0) setSidebarWidth(sidebarBeforeCollapse); }}>协作{collaboration.openCount ? ` · ${collaboration.openCount}` : ""}</Button>
          {project.source.type === "github" ? (
            <Button
              className="workspace-sync-button"
              size="small"
              variant="secondary"
              icon={<Icon name={icons.refresh} />}
              onClick={() => setSyncOpen(true)}
            >
              同步
            </Button>
          ) : null}
          <ThemeToggle />
          <IconButton
            label="项目设置"
            icon={<Icon name={icons.ellipsis} />}
            onClick={() => void openSettings()}
          />
        </div>
      </header>

      <div className="workspace-shell" ref={containerRef}>
        <ActivityBar onDropFiles={transfer => receiveDrop(transfer, "")} active={sidebarView} expanded={!sidebarForcedCollapsed && sidebarWidth > 0} onSelect={chooseSidebar} onSettings={() => void openSettings()} evidenceCount={evidenceCockpit?.counts.unresolved ?? claims.filter(claim => claim.reviewStatus === "needs-review" || claim.anchorStatus === "stale").length} />
        {(
          <aside className="workspace-sidebar" hidden={sidebarForcedCollapsed || sidebarWidth === 0} style={{ width: sidebarWidth }}>
            <section {...rootDrop.props("")} id="sidebar-files" hidden={sidebarView !== "files"} className="sidebar-section sidebar-section--files">
              {rootDrop.activeTarget !== null ? <div className="upload-drop-hint" role="status">将文件拖放到项目根目录</div> : null}
              <header className="panel-heading">
                <div>
                  <Icon name={icons.listTree} />
                  <span>文件</span>
                </div>
                <div>
                  <IconButton
                    label={
                      checkpointState === "saving"
                        ? "正在保存本地历史检查点"
                        : checkpointState === "saved"
                          ? "本地历史检查点已保存"
                          : checkpointState === "error"
                            ? "重试保存本地历史检查点"
                            : "保存本地历史检查点"
                    }
                    icon={<Icon name={icons.gitCommit} />}
                    disabled={checkpointState === "saving"}
                    onClick={async () => {
                      setCheckpointState("saving");
                      try {
                        await editorRef.current?.flush(); await registry.flush();
                        await api.projects.checkpoint(projectId);
                        setCheckpointState("saved");
                        window.setTimeout(
                          () => setCheckpointState("idle"),
                          2000,
                        );
                      } catch {
                        setCheckpointState("error");
                      }
                    }}
                  />
                  <IconButton
                    disabled={!collaboration.access?.canWrite} label="新建文件"
                    icon={<Icon name={icons.newFile} />}
                    onClick={() => setNewFileOpen(true)}
                  />
                  <IconButton
                    disabled={!collaboration.access?.canWrite} label="添加外部文件"
                    icon={<Icon name={icons.cloudUpload} />}
                    onClick={() => { setDroppedFiles([]); setDropDirectory(""); setAddFileOpen(true); }}
                  />
                  <IconButton
                    label="重命名所选文件"
                    icon={<Icon name={icons.edit} />}
                    disabled={!collaboration.access?.canWrite || selectedNode?.type !== "file"}
                    onClick={() => setRenameOpen(true)}
                  />
                  <IconButton
                    label="将所选文件移入回收站"
                    icon={<Icon name={icons.trash} />}
                    variant="danger"
                    disabled={
                      !collaboration.access?.canWrite || selectedNode?.type !== "file" ||
                      selectedPath === project.mainDocument
                    }
                    onClick={() => {
                      setDeleteError("");
                      setDeleteOpen(true);
                    }}
                  />
                  <IconButton
                    label="收起文件面板"
                    icon={<Icon name={icons.chevronLeft} />}
                    onClick={collapseSidebar}
                  />
                </div>
              </header>
              <FileTree
                onDropFiles={receiveDrop}
                nodes={tree}
                selectedPath={selectedPath}
                mainDocument={project.mainDocument}
                onSelect={selectNode}
                onPin={node => setSourceTabs(tabs => openSourceTab(tabs, node.path, true))}
                onExpand={expandDirectory}
              />
            </section>
            <section id="sidebar-collaboration" hidden={sidebarView !== "collaboration"} className="sidebar-section" style={{ flex: 1, minHeight: 0 }}>
              <CollaborationPanel writingMode={editingMode} onWritingModeChange={setWritingMode} key={projectId} projectId={projectId} registry={registry} collaboration={collaboration} selection={selection} selectedPath={selectedPath} activeCommentId={activeCommentId} onInvite={() => setInviteOpen(true)} onShare={() => setShareOpen(true)} onSelection={setActiveCommentId} onCompare={(oid, path) => openHistoryDiff({ baseRef: oid, targetRef: "working", path })} onRestored={async () => { for (const entry of registry.entries.values()) { try { if (entry.collaboration) await entry.collaboration.refresh(); } catch { /* Deleted files are handled by the workspace refresh. */ } } await refreshAfterSync(); collaboration.refresh(); }} onNavigate={async (path, from, to, line) => {
                await navigateToPath(path, line);
                if (from !== undefined) {
                  const entry = registry.get(path);
                  if (entry?.collaboration) await entry.collaboration.refresh();
                  const opened = registry.document(path) ?? await api.projects.readFile(projectId, path);
                  setTargetSelection(makeSelection(path, opened, from, to ?? from));
                }
              }} />
            </section>
            <section id="sidebar-reference-style" hidden={sidebarView !== "reference-style"} className="sidebar-section">
              <header className="panel-heading">
                <div>
                  <Icon name={icons.book} />
                  <span>参考论文</span>
                </div>
              </header>
              <div className="reference-style-content">
                {sidebarView === "reference-style" ? <ReferenceStylePanel projectId={projectId} {...(selectedPath ? { path: selectedPath } : {})} hasSelection={!!selection} hasSection={!!sectionSelection} refreshVersion={referenceSettings?.revision ?? 0} onSettingsChanged={(settings, papers) => { setReferenceSettings(settings); setReferencePapers(papers); }} onWrite={(target, instruction) => { setReferenceAction({ id: crypto.randomUUID(), target, instruction, ...(selectedPath ? { path: selectedPath } : {}) }); setBottomPanelTab("ai"); setPanelCollapsed(false); }} /> : null}
              </div>
            </section>
            <section id="sidebar-skills" hidden={sidebarView !== "skills"} className="sidebar-section">
              <SkillPanel onDetails={skill => { closeHistoryDiff(); setSkillTabs(tabs => tabs.some(tab => tab.id === skill.id) ? tabs : [...tabs, { id: skill.id, label: skill.id }]); setActiveSkill(skill.id); }} skills={taskSkills.skills} selectedIds={taskSkills.selectedIds} loading={taskSkills.loading} error={taskSkills.error} hasSection={Boolean(sectionSelection)} onChange={taskSkills.setSelectedIds} onReload={() => setSkillRevision(value => value + 1)} onUse={() => { setSkillTaskRequest(value => value + 1); setBottomPanelTab("ai"); setPanelCollapsed(false); setAiHeight(Math.max(aiHeight, 380)); }} />
            </section>
            <section id="sidebar-outline" hidden={sidebarView !== "outline"} className="sidebar-section workbench-outline">
              <header className="panel-heading panel-heading--plain">
                <span>文档大纲</span>
                <IconButton
                  label={
                    outlineCollapsed
                      ? "展开文档大纲"
                      : "收起文档大纲"
                  }
                  icon={outlineCollapsed ? <Icon name={icons.chevronUp} /> : <Icon name={icons.chevronDown} />}
                  onClick={() => setOutlineCollapsed(!outlineCollapsed)}
                />
              </header>
              {!outlineCollapsed ? <OutlineTree items={outline} activeId={activeOutlineId} onSelect={selectOutline} /> : null}
            </section>
            <section id="sidebar-evidence" hidden={sidebarView !== "evidence"} className="sidebar-section sidebar-section--claims">
              <header className="panel-heading panel-heading--plain">
                <div><span>论断与证据</span>{evidenceCockpit ? <small>{evidenceCockpit.counts.supported}/{evidenceCockpit.counts.total} 项已支持 · {evidenceCockpit.counts.unresolved} 未解决</small> : null}</div>
                <IconButton
                  label="重新扫描论断"
                  icon={<Icon name={icons.refresh} />}
                  onClick={async () => {
                    try {
                      const next = await api.claims.scan(projectId);
                      setClaims(next);
                      setEvidenceCockpit(await api.claims.cockpit(projectId));
                    } catch {
                      /* keep the last ledger visible */
                    }
                  }}
                />
              </header>
              <div className="claim-filters" role="group" aria-label="证据筛选">
                <Field label="状态">
                  <Select aria-label="证据状态" value={claimStatusFilter} onChange={(next) => setClaimStatusFilter(next as typeof claimStatusFilter)} options={[{ value: "all", label: "全部" }, { value: "needs-review", label: "待审核" }, { value: "supported", label: "已获支持" }, { value: "partial", label: "部分支持" }, { value: "unsupported", label: "缺少支持" }, { value: "stale", label: "锚点已过期" }, { value: "orphaned", label: "源文件缺失" }]} />
                </Field>
                <Field label="来源">
                  <Select aria-label="证据来源" value={claimPathFilter} onChange={setClaimPathFilter} options={[{ value: "all", label: "全部文件" }, ...claimPaths.map(path => ({ value: path, label: path }))]} />
                </Field>
              </div>
              {claims.length ? (
                <div className="claim-ledger-list">
                  {(
                    [
                      "supported",
                      "partial",
                      "unsupported",
                      "stale",
                      "orphaned",
                      "needs-review",
                    ] as const
                  ).map((status) => {
                    const items = visibleClaims.filter((claim) =>
                      status === "stale" || status === "orphaned"
                        ? claim.anchorStatus === status
                        : status === "needs-review"
                          ? claim.reviewStatus === "needs-review" ||
                            claim.reviewStatus === "detected"
                          : claim.reviewStatus === status &&
                            claim.anchorStatus !== "stale" &&
                            claim.anchorStatus !== "orphaned",
                    );
                    return items.length ? (
                      <div className="claim-ledger-group" key={status}>
                        <small>
                          {statusLabel(status)} · {items.length}
                        </small>
                        {items.map((claim) => (
                          <Button
                            variant="ghost"
                            className={`claim-ledger-item is-${status}`}
                            key={claim.id}
                            onClick={() => { void selectEvidenceClaim(claim); }}
                            title={
                              `${claim.anchor.path} · 已保存版本${claim.anchor.fileVersion} · ${claim.anchorStatus === "current" ? "锚点已核实" : "打开前请核实并重新定位"}`
                            }
                          >
                            <span>{claim.semanticType ?? "claim"}</span>
                            <em>
                              {claim.anchor.exactText.slice(0, 72)}
                              {claim.anchorStatus === "current" ? ` · ${claim.anchor.path} · 已保存版本${claim.anchor.fileVersion}` : claim.anchorStatus === "orphaned" ? " · 源文件缺失" : " · 请核实位置"}
                            </em>
                          </Button>
                        ))}
                      </div>
                    ) : null;
                  })}
                  {!visibleClaims.length ? <p className="sidebar-empty">没有符合筛选条件的论断。</p> : null}
                </div>
              ) : (
                <p className="sidebar-empty">
                  扫描工作区以建立论断列表。
                </p>
              )}
            </section>
            <div id="sidebar-git" hidden={sidebarView !== "git"} className="workbench-git"><SourceControlView registry={registry} projectId={projectId} version={project.version} selectedPath={selectedPath} onCompare={openHistoryDiff} onFlush={async () => {
              /*
               * Flush before every Git mutation, not just commit. `stage` copies
               * the on-disk content, and a `discard` is undone by a save that
               * lands after it, so the sidebar calls this at the start of each
               * operation — see `act` in WorkingChangesView.
               */
              await editorRef.current?.flush();
              await registry.flush();
            }} onDiscard={async paths => {
              await api.projects.discardPaths(projectId, paths);
              const matches = (path: string) => paths.some(prefix => path === prefix || path.startsWith(prefix + "/"));
              const removed = new Set<string>();
              for (const entry of registry.entries.values()) if (matches(entry.session.path)) {
                try {
                  const document = await api.projects.readFile(projectId, entry.session.path);
                  if (entry.collaboration) await entry.collaboration.refresh(); else registry.open(document);
                  if (selectedPath === entry.session.path) setFileDocument(document);
                } catch (failure) {
                  if (!(failure instanceof ApiClientError) || failure.status !== 404) throw failure;
                  await registry.forget(entry.session.path);
                  removed.add(entry.session.path);
                }
              }
              if (removed.size) {
                setSourceTabs(tabs => tabs.filter(tab => !removed.has(tab.path)));
                if (selectedPath && removed.has(selectedPath)) { setSelectedPath(null); setFileDocument(null); }
              }
              await refreshWorkspace();
            }} onCommit={async (message) => {
              /*
               * No flush here: the sidebar's `act` has already run `onFlush`
               * before calling this, and a second one would just be the same
               * wait twice.
               */
              await api.projects.commitWorking(projectId, message);
              /*
               * A commit moves HEAD and empties the index. The sidebar re-reads
               * its own status after every mutation, but the rest of the page
               * keys off project.version, so the project is re-read too rather
               * than left describing a state HEAD has already left.
               */
              setProject(await api.projects.get(projectId));
            }} {...(project.source.type === "github" ? { onSync: () => setSyncOpen(true) } : {})} /></div>
          </aside>
        )}
        {!sidebarForcedCollapsed ? <PanelDivider
          label="调整文件面板大小"
          active={resizing === "sidebar"}
          value={sidebarWidth}
          min={0}
          max={420}
          onPointerDown={() => setResizing("sidebar")}
          onKeyboardChange={setSidebarWidth}
        /> : null}

        <main className="workspace-center">
          <EditorTabs documents={skillTabs.map(tab => ({ id: `skill-${tab.id}`, label: `Skill · ${taskSkillLabel(tab.id)}`, active: activeSkill === tab.id, select: () => { closeHistoryDiff(); setActiveSkill(tab.id); }, close: () => { setSkillTabs(tabs => tabs.filter(item => item.id !== tab.id)); if (activeSkill === tab.id) setActiveSkill(null); } }))} settings={settingsOpen ? { active: settingsActive, select: () => { setActiveSkill(null); setSettingsActive(true); }, close: () => { setSettingsOpen(false); setSettingsActive(false); } } : undefined} comparisons={comparisonTabs} activeComparison={!activeSkill && !settingsActive && historyDiff ? diffRequestKey(historyDiff) : null} onSelectComparison={openHistoryDiff} onCloseComparison={key => { void closeComparisonTab(key); }} tabs={sourceTabs} activePath={activeSkill || settingsActive || historyDiff ? null : selectedPath} dirty={dirtyFiles} onSelect={path => { closeHistoryDiff(); navigationRef.current.cancel(); setTargetLine(null); setTargetSelection(null); setSelectedPath(path); }} onPin={path => setSourceTabs(tabs => pinSourceTab(tabs, path))} onClose={async path => {
            setTabError("");
            try {
              await editorRef.current?.flush(); await registry.flush();
              if (tabsStateRef.current.projectId !== projectId) return;
              const remaining = tabsStateRef.current.sourceTabs.filter(tab => tab.path !== path);
              setSourceTabs(remaining);
              if (path === tabsStateRef.current.selectedPath) setSelectedPath(remaining.at(-1)?.path ?? null);
            } catch (failure) { setTabError(userFacingError(failure, "无法保存此标签页，已保留本地文本")); }
          }} />
          {tabError ? <p role="alert">{tabError}</p> : null}
          <section className="editor-region" id="source-editor-area">
            {settingsOpen ? <div ref={settingsPanelRef} id="settings-editor-panel" className="settings-tab-panel" role="tabpanel" aria-label="设置" hidden={!settingsActive}>
              <ProjectSettingsEditor key={projectId} project={project} tree={settingsTree} onSaved={async (updated) => {
                setProject(updated);
                await refreshWorkspace(undefined, selectedPath ?? updated.mainDocument);
              }} />
            </div> : null}
            {comparisonTabs.map(tab => <div className="diff-tab-panel" id={`comparison-${tab.key}`} key={tab.key} hidden={!!activeSkill || settingsActive || !historyDiff || diffRequestKey(historyDiff) !== tab.key}><Suspense fallback={<p>正在加载对比…</p>}><WorkspaceDiffEditor allowEdit={editingMode === "editing"} registry={registry} projectId={projectId} projectVersion={project.version} dirty={buffersDirty} request={tab.request} onClose={() => { void closeComparisonTab(tab.key); }} onSaveCheckpoint={async () => { await editorRef.current?.flush(); await registry.flush(); await api.projects.checkpoint(projectId); return (await api.projects.get(projectId)).version; }} onRestored={async path => { await refreshWorkspace(undefined, path); setSelectedPath(path); setFileDocument(await api.projects.readFile(projectId, path)); await closeComparisonTab(tab.key, true); }} /></Suspense></div>)}
            {skillTabs.map(tab => <div id={`skill-${tab.id}`} key={tab.id} className="skill-tab-panel" role="tabpanel" aria-label={`Skill · ${taskSkillLabel(tab.id)}`} hidden={activeSkill !== tab.id}><SkillDetailPanel id={tab.id} /></div>)}
            <div className="source-editor-container" hidden={!!activeSkill || settingsActive || historyDiff !== null}>
            {fileDocument ? (
              <Suspense
                fallback={
                  <div className="workspace-panel-loading">正在加载编辑器…</div>
                }
              >
                <SourceEditor
                  ref={editorRef}
                  completionEnabled={completionEnabled}
                  comments={collaboration.threads}
                  onReviewSaved={collaboration.refresh}
                  writingMode={writingMode}
                  onModeChange={setEditingMode}
                  activeCommentId={activeCommentId}
                  onCommentClick={id => { setActiveCommentId(id); setSidebarView("collaboration"); if (sidebarWidth === 0) setSidebarWidth(sidebarBeforeCollapse); }}
                  registry={registry}
                  projectId={projectId}
                  references={referenceSettings?.selections ?? []}
                  document={fileDocument}
                  targetLine={targetLine}
                  targetSelection={targetSelection}
                  onSelection={(nextSelection) => {
                    setSelection(nextSelection);
                    if (nextSelection || !targetSelection)
                      setTargetSelection(null);
                  }}
                  onCursor={setCursorLocation}
                  onDirtyChange={setBuffersDirty}
                  onDocumentState={(path, dirty) => {
                    setDirtyFiles(current => current[path] === dirty ? current : { ...current, [path]: dirty });
                    if (dirty) setSourceTabs(tabs => pinSourceTab(tabs, path));
                  }}
                />
              </Suspense>
            ) : selectedNode?.type === "file" &&
              selectedNode.kind === "image" ? (
              <AssetPreview
                projectId={projectId}
                path={selectedNode.path}
                name={selectedNode.name}
              />
            ) : (
              <div className="editor-empty">
                <Icon name={icons.listTree} />
                <h3>选择源文件</h3>
                <p>
                  从项目文件树中选择 LaTeX、Markdown 或 BibTeX 文件。
                </p>
              </div>
            )}
            </div>
          </section>
          <div className="bottom-panel-heading">
            <TabBar
              className="bottom-panel-tabs"
              label="底部面板"
              activeId={bottomPanelTab}
              onSelect={(id) => { setBottomPanelTab(id as typeof bottomPanelTab); setPanelCollapsed(false); }}
              tabs={[
                { id: "ai", label: "AI" },
                { id: "problems", label: `问题${compileState.diagnostics.length ? ` (${compileState.diagnostics.length})` : ""}` },
                { id: "output", label: "输出" }
              ]}
            />
            <Button variant="ghost" aria-expanded={!bottomPanelHidden} aria-controls="bottom-workbench-panel" onClick={() => setPanelCollapsed(!panelCollapsed)}>{bottomPanelHidden ? "显示面板" : "隐藏面板"}</Button>
          </div>
          <div id="bottom-workbench-panel" className="workbench-bottom-panel" style={{ height: aiHeight }} hidden={bottomPanelHidden}>
          <PanelDivider
            label="调整底部面板大小"
            orientation="horizontal"
            active={resizing === "ai"}
            value={aiHeight}
            min={220}
            max={760}
            onPointerDown={() => setResizing("ai")}
            onKeyboardChange={setAiHeight}
          />
          <div className="bottom-panel-content" role="tabpanel" hidden={bottomPanelTab !== "ai"}>
          <AiWorkspace
            project={project}
            taskSkills={taskSkills.skills}
            taskSkillsLoading={taskSkills.loading}
            taskSkillIds={taskSkills.selectedIds}
            onTaskSkillIdsChange={taskSkills.setSelectedIds}
            skillTaskRequest={skillTaskRequest}
            referenceSettings={referenceSettings}
            referencePapers={referencePapers}
            referenceAction={referenceAction}
            onRemoveReference={id => void removeWritingReference(id)}
            selection={selection}
            paragraphSelection={paragraphSelection}
            sectionSelection={sectionSelection}
            completionEnabled={completionEnabled}
            onCompletionEnabledChange={enabled => {
              setCompletionEnabled(enabled);
              localStorage.setItem("fastwrite.completion.enabled", String(enabled));
            }}
            fullscreen={aiFullscreen}
            onToggleFullscreen={() => setAiFullscreen((value) => !value)}
            onUseSelection={(nextSelection) => {
              setSelection(nextSelection);
              setTargetSelection(nextSelection);
            }}
            onClearSelection={() => {
              setSelection(null);
              setTargetSelection(null);
            }}
            onRestoreSelection={async (savedSelection) => {
              try {
                const opened = await api.projects.readFile(
                  projectId,
                  savedSelection.path,
                );
                if (
                  opened.file.version !== savedSelection.fileVersion ||
                  opened.content.slice(
                    savedSelection.from,
                    savedSelection.to,
                  ) !== savedSelection.text
                )
                  return false;
                const restored = makeSelection(
                  savedSelection.path,
                  opened,
                  savedSelection.from,
                  savedSelection.to,
                );
                setSelectedPath(savedSelection.path);
                setFileDocument(opened);
                setSelection(restored);
                setTargetSelection(restored);
                setCursorLocation({
                  path: restored.path,
                  line: restored.startLine,
                });
                return true;
              } catch {
                return false;
              }
            }}
            onPrepareLocalRevision={prepareLocalRevision}
            compileState={compileState}
            compileRepairRequest={compileRepairRequest}
            onRequestCompile={() => setCompileRequest((value) => value + 1)}
            onNavigate={(path, line) => {
              void navigateToPath(path, line);
            }}
            onWorkspaceChanged={async () => {
              await refreshWorkspace(undefined, selectedPath ?? undefined);
            }}
            onFileChanged={async (path, range) => {
              const updatedProject = await refreshWorkspace(undefined, path);
              setProject(updatedProject);
              setSelectedPath(path);
              const nextDocument = await api.projects.readFile(projectId, path);
              setFileDocument(nextDocument);
              if (range) {
                const retained = makeSelection(
                  path,
                  nextDocument,
                  range.from,
                  range.to,
                );
                setSelection(retained);
                setTargetSelection(retained);
              } else {
                setSelection(null);
                setTargetSelection(null);
              }
            }}
          />
          </div>
          <div className="bottom-panel-content bottom-panel-problems" role="tabpanel" hidden={bottomPanelTab !== "problems"}>
            <header><span>{compileState.state === "error" ? "编译失败" : compileState.diagnostics.length ? "编译诊断" : "没有编译问题"}</span><small>{compileState.progress}</small></header>
            {compileState.diagnostics.length ? <div className="diagnostic-list">{compileState.diagnostics.map(diagnostic => <div className={`diagnostic-row diagnostic-row--${diagnostic.severity}`} key={diagnostic.id}><Button variant="ghost" disabled={!diagnostic.path || !diagnostic.line} onClick={() => { if (diagnostic.path && diagnostic.line) void navigateToPath(diagnostic.path, diagnostic.line); }}><Icon name={icons.warning} /><span><strong>{diagnostic.message}</strong>{diagnostic.path ? <code>{diagnostic.path}{diagnostic.line ? `:${diagnostic.line}` : ""}</code> : null}</span></Button>{compileState.failure ? <Button size="small" variant="secondary" icon={<Icon name={icons.tools} />} onClick={() => { setBottomPanelTab("ai"); setPanelCollapsed(false); fixCompileWithAgent(compileState.failure!); }}>使用智能助手修复</Button> : null}</div>)}</div> : <div className="bottom-panel-empty"><Icon name={icons.passFilled} />{compileState.state === "error" ? "编译器未提供源文件位置。" : "编译项目后即可查看诊断信息。"}</div>}
          </div>
          <div className="bottom-panel-content bottom-panel-output" role="tabpanel" hidden={bottomPanelTab !== "output"}>
            <header><Icon name={icons.filePdf} /><span>编译输出</span><small>{compileState.compiledVersion === null ? "尚未编译" : `工作区版本 ${compileState.compiledVersion}`}</small></header>
            <pre>{compileState.log ? compileState.log.slice(-24_000) : compileState.progress}</pre>
          </div>
          </div>
        </main>

        {!pdfForcedCollapsed ? <PanelDivider
          label="调整 PDF 预览大小"
          active={resizing === "pdf"}
          value={pdfWidth}
          min={0}
          max={780}
          reverse
          onPointerDown={() => setResizing("pdf")}
          onKeyboardChange={setPdfWidth}
        /> : null}
        {!pdfForcedCollapsed && pdfWidth > 0 ? (
          <div className="workspace-pdf" style={{ width: pdfWidth }}>
            <Suspense
              fallback={
                <div className="workspace-panel-loading">
                  正在加载 PDF 预览…
                </div>
              }
            >
              <PdfPane
                canCompile={collaboration.access?.canCompile ?? false}
                projectId={projectId}
                projectVersion={project.version}
                buffersDirty={buffersDirty}
                beforeCompile={prepareCompile}
                mainDocument={project.mainDocument}
                tree={tree}
                sourceLocation={pdfSourceLocation}
                compileRequest={compileRequest}
                onCompileState={handleCompileState}
                onFixWithAgent={fixCompileWithAgent}
                onSyncToSource={(location) => {
                  void navigateToPath(location.path, location.line);
                }}
              />
            </Suspense>
            <IconButton
              className="pdf-collapse"
              label="收起 PDF 预览"
              icon={<Icon name={icons.layoutPanelRight} />}
              onClick={collapsePdf}
            />
          </div>
        ) : !pdfForcedCollapsed ? (
          <Button
            variant="ghost"
            className="collapsed-rail collapsed-rail--right"
            onClick={collapsePdf}
            aria-label="展开 PDF 预览"
            title="展开 PDF 预览"
          >
            <Icon name={icons.layoutPanelRight} />
            <span>PDF</span>
          </Button>
        ) : null}
      </div>

      <NewFileDialog
        open={newFileOpen}
        projectId={projectId}
        onClose={() => setNewFileOpen(false)}
        onCreated={async (path) => {
          setNewFileOpen(false);
          await refreshWorkspace(undefined, path);
          setSelectedPath(path);
        }}
      />
      <AddFileDialog
        initialFiles={droppedFiles}
        targetPath={dropDirectory}
        open={addFileOpen}
        projectId={projectId}
        onClose={() => setAddFileOpen(false)}
        onAdded={async (path, targetKind) => {
          setAddFileOpen(false);
          if (targetKind === "skill-resource") { setSkillRevision(value => value + 1); setSidebarView("skills"); return; }
          if (targetKind === "reference-artifact") { setSidebarView("reference-style"); return; }
          await refreshWorkspace(undefined, path);
          setSelectedPath(path);
        }}
      />
      <RenameFileDialog
        open={renameOpen}
        projectId={projectId}
        path={selectedPath ?? ""}
        onClose={() => setRenameOpen(false)}
        onRenamed={async (path) => {
          setRenameOpen(false);
          await refreshWorkspace(undefined, path);
          setSelectedPath(path);
        }}
      />
      {project.source.type === "github" ? (
        <GithubSyncDialog
          open={syncOpen}
          project={project}
          compileState={compileState}
          onClose={() => setSyncOpen(false)}
          onFlushEditor={prepareCompile}
          onWorkspaceApplied={refreshAfterSync}
          onRequestCompile={() => setCompileRequest((value) => value + 1)}
        />
      ) : null}
      <ComplianceDialog
        open={complianceOpen}
        project={project}
        {...(compileState.renderedPages
          ? { renderedPages: compileState.renderedPages }
          : {})}
        onClose={() => setComplianceOpen(false)}
      />
      <ProvenanceDialog open={provenanceOpen} projectId={projectId} onClose={() => setProvenanceOpen(false)} />
      <QuickOpenDialog open={quickOpen} projectId={projectId} onClose={() => setQuickOpen(false)} onOpen={path => { closeHistoryDiff(); void navigateToPath(path); }} />
      <ShareDialog
        open={shareOpen}
        projectId={projectId}
        onClose={() => setShareOpen(false)}
      />
      <InviteDialog
        onTransferred={updated => { setProject(updated); collaboration.refresh(); }}
        open={inviteOpen}
        projectId={projectId}
        onClose={() => setInviteOpen(false)}
      />
      <Dialog
        open={deleteOpen}
        title="将文件移入回收站？"
        description={selectedPath ?? ""}
        onClose={() => setDeleteOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              取消
            </Button>
            <Button
              variant="danger"
              icon={<Icon name={icons.trash} />}
              onClick={async () => {
                if (!selectedPath) return;
                setDeleteError("");
                try {
                  await editorRef.current?.flush(); await registry.flush();
                  await api.projects.deleteFile(projectId, selectedPath);
                  setDeleteOpen(false);
                  setSelectedPath(project.mainDocument);
                  await refreshWorkspace();
                } catch (deleteFailure) {
                  setDeleteError(
                    userFacingError(deleteFailure, "无法删除文件"),
                  );
                }
              }}
            >
              移入回收站
            </Button>
          </>
        }
      >
        <p className="dialog-copy">
          文件将移入项目回收站，可从工作区存储中恢复。
        </p>
        {deleteError ? (
          <div className="form-error" role="alert">
            {deleteError}
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

function ShareDialog({
  open,
  projectId,
  onClose,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
}) {
  const [links, setLinks] = useState<
    Array<{
      id: string;
      permission: "read" | "comment";
      revokedAt?: string;
      label?: string;
      expiresAt?: string;
      createdAt: string;
    }>
  >([]);
  const [label, setLabel] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [createdUrl, setCreatedUrl] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(
    () =>
      api.projects
        .shares(projectId)
        .then(setLinks)
        .catch((e) =>
          setError(
            userFacingError(e, "无法加载分享链接"),
          ),
        ),
    [projectId],
  );
  useEffect(() => {
    if (open) void load();
  }, [load, open]);
  const create = async (permission: "read" | "comment") => {
    if (busy) return;
    setBusy(true); setError(""); setCopied(false);
    try {
      const share = await api.projects.createShare(projectId, permission, { ...(label.trim() ? { label: label.trim() } : {}), ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}) });
      setCreatedUrl(`${window.location.origin}/shared/${share.token}`);
      await load();
    } catch (e) {
      setError(userFacingError(e, "无法创建分享链接"));
    } finally { setBusy(false); }
  };
  return (
    <Dialog
      open={open}
      title="分享项目"
      description="创建可撤销的链接。只读链接不可评论，评论链接不可编辑稿件。"
      onClose={onClose}
      footer={
        <Button variant="ghost" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <div className="history-dialog">
        <Field label="链接说明（可选）"><TextField aria-label="链接说明" value={label} onChange={setLabel} maxLength={120} placeholder="例如：外部合作者审阅" /></Field>
        <Field label="失效时间（可选）"><TextField aria-label="分享链接失效时间" type="datetime-local" value={expiresAt} onChange={setExpiresAt} /></Field>
        <div>
          <Button variant="secondary" disabled={busy} onClick={() => void create("read")}>
            创建只读链接
          </Button>{" "}
          <Button variant="secondary" disabled={busy} onClick={() => void create("comment")}>
            创建审稿链接
          </Button>
        </div>
        {createdUrl ? (
          <Field label="新链接（仅显示一次）">
            <TextField readonly value={createdUrl} />
            <Button size="small" onClick={() => { void navigator.clipboard.writeText(createdUrl).then(() => setCopied(true)).catch(() => setError("请在链接文本框中手动复制链接")); }}>{copied ? "已复制" : "复制链接"}</Button>
          </Field>
        ) : null}
        {error ? (
          <div className="form-error" role="alert">
            {error}
          </div>
        ) : null}
        {links.map((link) => (
          <p className="dialog-copy" key={link.id}>
            {link.label ? `${link.label} · ` : ""}{statusLabel(link.permission)}{link.expiresAt ? ` · ${new Date(link.expiresAt).getTime() <= Date.now() ? "已过期" : `有效至 ${new Date(link.expiresAt).toLocaleString("zh-CN")}`}` : ""} · {new Date(link.createdAt).toLocaleString("zh-CN")} ·{" "}
            {link.revokedAt ? (
              "已撤销"
            ) : (
              <Button
                variant="ghost"
                onClick={async () => {
                  await api.projects.revokeShare(projectId, link.id);
                  await load();
                }}
              >
                撤销
              </Button>
            )}
          </p>
        ))}
      </div>
    </Dialog>
  );
}

function InviteDialog({
  open,
  projectId,
  onClose,
  onTransferred,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onTransferred: (project: PaperProject) => void;
}) {
  const [ownerTarget, setOwnerTarget] = useState("");
  const [confirmOwner, setConfirmOwner] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<
    "maintainer" | "editor" | "commenter" | "viewer"
  >("editor");
  const [expiresAt, setExpiresAt] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState("");
  const [token, setToken] = useState("");
  const [invitations, setInvitations] = useState<
    Array<{
      id: string;
      emailNormalized: string;
      role: string;
      expiresAt: string;
      message?: string;
      createdAt: string;
      acceptedAt?: string;
      revokedAt?: string;
    }>
  >([]);
  const [members, setMembers] = useState<
    Array<{
      userId: string;
      role: "owner" | "maintainer" | "editor" | "commenter" | "viewer";
      user: { displayName: string; emailNormalized: string };
    }>
  >([]);
  const [accessRequests, setAccessRequests] = useState<
    Array<{
      id: string;
      requesterUserId: string;
      requester: { displayName: string; emailNormalized: string };
      requestedRole: "maintainer" | "editor" | "commenter" | "viewer";
      message?: string;
      status: "pending" | "approved" | "rejected";
      createdAt: string;
    }>
  >([]);
  const [canManageMembers, setCanManageMembers] = useState(false);
  const load = useCallback(async () => {
    try {
      const [nextInvitations, membership, requests] = await Promise.all([
        api.projects.invitations(projectId),
        api.projects.members(projectId),
        api.projects.accessRequests(projectId),
      ]);
      setInvitations(nextInvitations);
      setMembers(membership.members);
      setCanManageMembers(membership.canManage);
      setAccessRequests(requests);
      setError("");
    } catch (failure) {
      setError(
        userFacingError(failure, "无法加载邀请"),
      );
    }
  }, [projectId]);
  useEffect(() => {
    if (open) {
      setError("");
      setSent("");
      setToken("");
      void load();
    }
  }, [load, open]);
  const invite = async () => {
    if (!email.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.projects.invite(projectId, {
        email: email.trim(),
        role,
        ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
        ...(message.trim() ? { message: message.trim() } : {}),
      });
      setSent(
        `邀请已创建，到期时间为 ${new Date(result.invitation.expiresAt).toLocaleDateString("zh-CN")}.`,
      );
      setToken(
        `${window.location.origin}/projects?invite=${encodeURIComponent(result.token)}`,
      );
      setEmail("");
      setExpiresAt("");
      setMessage("");
      await load();
    } catch (failure) {
      setError(
        userFacingError(failure, "无法创建邀请"),
      );
    } finally {
      setBusy(false);
    }
  };
  const resend = async (invitationId: string) => {
    setBusy(true);
    setError("");
    try {
      const result = await api.projects.resendInvitation(invitationId);
      setToken(
        `${window.location.origin}/projects?invite=${encodeURIComponent(result.token)}`,
      );
      setSent(
        `邀请已重新发送，到期时间为 ${new Date(result.invitation.expiresAt).toLocaleDateString("zh-CN")}.`,
      );
      await load();
    } catch (failure) {
      setError(
        userFacingError(failure, "无法重新发送邀请"),
      );
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (invitationId: string) => {
    setBusy(true);
    setError("");
    try {
      await api.projects.revokeInvitation(invitationId);
      await load();
    } catch (failure) {
      setError(
        userFacingError(failure, "无法撤销邀请"),
      );
    } finally {
      setBusy(false);
    }
  };
  const updateMember = async (
    userId: string,
    nextRole: "maintainer" | "editor" | "commenter" | "viewer",
  ) => {
    setBusy(true);
    setError("");
    try {
      await api.projects.updateMember(projectId, userId, nextRole);
      await load();
    } catch (failure) {
      setError(
        userFacingError(failure, "无法更新成员角色"),
      );
    } finally {
      setBusy(false);
    }
  };
  const removeMember = async (userId: string) => {
    setBusy(true);
    setError("");
    try {
      await api.projects.removeMember(projectId, userId);
      await load();
    } catch (failure) {
      setError(
        userFacingError(failure, "无法移除成员"),
      );
    } finally {
      setBusy(false);
    }
  };
  const decideAccessRequest = async (requestId: string, approved: boolean) => {
    setBusy(true);
    setError("");
    try {
      await api.projects.decideAccessRequest(projectId, requestId, approved);
      await load();
    } catch (failure) {
      setError(
        userFacingError(failure, "无法处理访问申请"),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      title="邀请协作者"
      description="通过邮箱邀请用户，并选择项目角色。"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button
            variant="primary"
            icon={<Icon name={icons.personAdd} />}
            loading={busy}
            disabled={!email.trim()}
            onClick={() => void invite()}
          >
            邀请
          </Button>
        </>
      }
    >
      <div className="form-stack">
        <Field label="邮箱">
          <TextField
            type="email"
            value={email}
            onChange={setEmail}
            autoFocus
          />
        </Field>
        <Field label="角色">
          <Select
            aria-label="角色"
            value={role}
            onChange={(next) => setRole(next as typeof role)}
            options={[
              { value: "maintainer", label: "维护者" },
              { value: "editor", label: "编辑者" },
              { value: "commenter", label: "审阅者" },
              { value: "viewer", label: "查看者" }
            ]}
          />
        </Field>
        <Field label="到期时间（可选）">
          <TextField
            type="datetime-local"
            value={expiresAt}
            onChange={setExpiresAt}
          />
        </Field>
        <Field label="留言（可选）">
          <TextArea
            rows={3}
            maxLength={2000}
            value={message}
            onChange={setMessage}
          />
        </Field>
        {sent ? (
          <div className="form-notice" role="status">
            {sent}
          </div>
        ) : null}
        {token ? (
          <Field label="邀请链接（仅显示一次）">
            <TextField readonly value={token} />
          </Field>
        ) : null}
        {error ? (
          <div className="form-error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="history-dialog">
          <h3>协作者</h3>
          {members.map((member) => (
            <p className="dialog-copy" key={member.userId}>
              {member.user.displayName} ({member.user.emailNormalized}) ·{" "}
              {member.role === "owner" || !canManageMembers ? (
                roleLabel(member.role)
              ) : (
                <>
                  <Select
                    aria-label={`成员角色： ${member.user.displayName}`}
                    value={member.role}
                    disabled={busy}
                    onChange={(next) =>
                      void updateMember(
                        member.userId,
                        next as
                          "maintainer" | "editor" | "commenter" | "viewer",
                      )
                    }
                    options={[
                      { value: "maintainer", label: "维护者" },
                      { value: "editor", label: "编辑者" },
                      { value: "commenter", label: "审阅者" },
                      { value: "viewer", label: "查看者" }
                    ]}
                  />{" "}
                  <Button
                    size="small"
                    variant="ghost"
                    icon={<Icon name={icons.trash} />}
                    disabled={busy}
                    onClick={() => void removeMember(member.userId)}
                  >
                    移除
                  </Button>
                </>
              )}
            </p>
          ))}
          {canManageMembers ? (
            <>
              <h3>访问申请</h3>
              {accessRequests
                .filter((request) => request.status === "pending")
                .map((request) => (
                  <p className="dialog-copy" key={request.id}>
                    {request.requester.displayName} ({request.requester.emailNormalized}) · {roleLabel(request.requestedRole)}
                    {request.message ? ` · ${request.message}` : ""}{" "}
                    <Button
                      size="small"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void decideAccessRequest(request.id, true)}
                    >
                      批准
                    </Button>{" "}
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void decideAccessRequest(request.id, false)
                      }
                    >
                      拒绝
                    </Button>
                  </p>
                ))}
              {!accessRequests.some(
                (request) => request.status === "pending",
              ) ? (
                <p className="sidebar-empty">暂无待处理的访问申请。</p>
              ) : null}
            </>
          ) : null}
          {canManageMembers ? <section className="history-dialog">
            <h3>转移所有权</h3>
            <Field label="新所有者"><Select aria-label="新所有者" value={ownerTarget} disabled={busy} onChange={value => { setOwnerTarget(value); setConfirmOwner(false); }} options={[{ value: "", label: "选择已加入项目的协作者" }, ...members.filter(member => member.role !== "owner").map(member => ({ value: member.userId, label: `${member.user.displayName} (${member.user.emailNormalized})` }))]} /></Field>
            <p className="dialog-copy">转移后，新所有者管理成员与分享；原所有者保留编辑权限。</p>
            <Checkbox checked={confirmOwner} onChange={setConfirmOwner} disabled={!ownerTarget || busy}>确认将管理权限移交给所选协作者</Checkbox>
            <Button variant="danger" size="small" disabled={busy || !ownerTarget || !confirmOwner} onClick={() => { setBusy(true); setError(""); void api.projects.transferOwnership(projectId, ownerTarget).then(updated => { onTransferred(updated); onClose(); }).catch(failure => setError(userFacingError(failure, "无法转移所有权"))).finally(() => setBusy(false)); }}>转移所有权</Button>
          </section> : null}
          <h3>邀请</h3>
          {invitations.map((invitation) => (
            <p className="dialog-copy" key={invitation.id}>
              {invitation.emailNormalized} · {roleLabel(invitation.role)} ·{" "}
              {invitation.acceptedAt ? (
                "已接受"
              ) : invitation.revokedAt ? (
                "已撤销"
              ) : new Date(invitation.expiresAt) <= new Date() ? (
                "已过期"
              ) : (
                <>
                  <span>
                    待接受，有效期至{" "}
                    {new Date(invitation.expiresAt).toLocaleDateString("zh-CN")}
                  </span>{" "}
                  <Button
                    size="small"
                    variant="ghost"
                    icon={<Icon name={icons.refresh} />}
                    disabled={busy}
                    onClick={() => void resend(invitation.id)}
                  >
                    重新发送
                  </Button>{" "}
                  <Button
                    size="small"
                    variant="ghost"
                    icon={<Icon name={icons.trash} />}
                    disabled={busy}
                    onClick={() => void revoke(invitation.id)}
                  >
                    撤销
                  </Button>
                </>
              )}
              {invitation.message ? <small>{invitation.message}</small> : null}
            </p>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

function PanelDivider({
  label,
  active,
  value,
  min,
  max,
  reverse = false,
  orientation = "vertical",
  onPointerDown,
  onKeyboardChange,
}: {
  label: string;
  active: boolean;
  value: number;
  min: number;
  max: number;
  reverse?: boolean;
  orientation?: "vertical" | "horizontal";
  onPointerDown: () => void;
  onKeyboardChange: (value: number) => void;
}) {
  const decreaseKey = orientation === "horizontal" ? "ArrowDown" : "ArrowLeft";
  const increaseKey = orientation === "horizontal" ? "ArrowUp" : "ArrowRight";
  return (
    <div
      className={`panel-divider panel-divider--${orientation} ${active ? "is-active" : ""}`}
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      onKeyDown={(event) => {
        const direction = reverse ? -1 : 1;
        if (event.key === decreaseKey) {
          event.preventDefault();
          onKeyboardChange(
            Math.min(max, Math.max(min, value - 16 * direction)),
          );
        } else if (event.key === increaseKey) {
          event.preventDefault();
          onKeyboardChange(
            Math.min(max, Math.max(min, value + 16 * direction)),
          );
        } else if (event.key === "Home") {
          event.preventDefault();
          onKeyboardChange(min);
        } else if (event.key === "End") {
          event.preventDefault();
          onKeyboardChange(max);
        }
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        onPointerDown();
      }}
    >
      <span />
    </div>
  );
}

function AssetPreview({
  projectId,
  path,
  name,
}: {
  projectId: string;
  path: string;
  name: string;
}) {
  const assetKey = JSON.stringify([projectId, path]);
  const [preview, setPreview] = useState<{ key: string; url?: string; error?: string }>();
  useEffect(() => {
    const controller = new AbortController();
    let objectURL: string | undefined;
    setPreview({ key: assetKey });
    void api.projects.readAsset(projectId, path, controller.signal).then(blob => {
      if (controller.signal.aborted) return;
      objectURL = URL.createObjectURL(blob);
      setPreview({ key: assetKey, url: objectURL });
    }).catch(error => {
      if (!controller.signal.aborted) setPreview({ key: assetKey, error: userFacingError(error, "无法加载图片") });
    });
    return () => {
      controller.abort();
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [assetKey, projectId, path]);
  const current = preview?.key === assetKey ? preview : undefined;
  return (
    <div className="asset-preview">
      <div className="asset-preview__canvas">
        {current?.error ? <p role="alert">{current.error}</p> : current?.url ? (
          <img src={current.url} alt={name} onError={() => setPreview({ key: assetKey, error: "无法显示图片" })} />
        ) : <p role="status">正在加载图片…</p>}
      </div>
    </div>
  );
}

function NewFileDialog({
  open,
  projectId,
  onClose,
  onCreated,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onCreated: (path: string) => void | Promise<void>;
}) {
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
      setError(
        userFacingError(createError, "无法创建文件"),
      );
    } finally {
      setLoading(false);
    }
  };
  return (
    <Dialog
      open={open}
      title="创建文件"
      description="请使用工作区相对路径，例如 sections/method.tex。"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={loading}
            disabled={!path.trim()}
            onClick={() => void create()}
          >
            创建文件
          </Button>
        </>
      }
    >
      <Field label="文件路径">
        <TextField
          value={path}
          onChange={setPath}
          placeholder="sections/new-section.tex"
          autoFocus
        />
      </Field>
      {error ? (
        <div className="form-error" role="alert">
          {error}
        </div>
      ) : null}
    </Dialog>
  );
}

function WorkspaceLoading() {
  return (
    <div className="workspace-loading">
      <BrandMark />
      <div>
        <strong>正在打开论文</strong>
        <span>正在加载工作区…</span>
      </div>
    </div>
  );
}

function WorkspaceError({ message }: { message: string }) {
  return (
    <div className="workspace-error">
      <h1>无法打开此论文</h1>
      <p>{message}</p>
      <Button variant="primary" onClick={() => navigate("/projects")}>
        返回项目列表
      </Button>
    </div>
  );
}

function activeOutline(items: OutlineItem[], cursor: SourceLocation): string | null {
  const all: OutlineItem[] = [];
  const visit = (nodes: OutlineItem[]) => nodes.forEach(item => { all.push(item); visit(item.children); });
  visit(items);
  return all.filter(item => item.path === cursor.path && item.line <= cursor.line).sort((left, right) => right.line - left.line)[0]?.id ?? null;
}

function findNode(
  nodes: WorkspaceTreeNode[],
  path: string,
): WorkspaceTreeNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.type === "directory") {
      const child = findNode(node.children, path);
      if (child) return child;
    }
  }
  return null;
}

async function hydrateTreePath(
  projectId: string,
  initialTree: WorkspaceTreeNode[],
  filePath: string,
  signal?: AbortSignal,
): Promise<WorkspaceTreeNode[]> {
  let nextTree = initialTree;
  const segments = filePath.split("/").filter(Boolean);
  let directoryPath = "";
  for (const segment of segments.slice(0, -1)) {
    directoryPath = directoryPath ? `${directoryPath}/${segment}` : segment;
    const directory = findNode(nextTree, directoryPath);
    if (directory?.type === "directory" && directory.loaded === true) continue;
    const children = await api.projects.treeLevel(
      projectId,
      directoryPath,
      signal,
    );
    nextTree = replaceDirectoryChildren(nextTree, directoryPath, children);
  }
  return nextTree;
}

function replaceDirectoryChildren(
  nodes: WorkspaceTreeNode[],
  path: string,
  children: WorkspaceTreeNode[],
): WorkspaceTreeNode[] {
  return nodes.map((node) => {
    if (node.type !== "directory") return node;
    if (node.path === path) return { ...node, children, loaded: true };
    return {
      ...node,
      children: replaceDirectoryChildren(node.children, path, children),
    };
  });
}

function makeSelection(
  path: string,
  document: FileContentResponse,
  requestedFrom: number,
  requestedTo: number,
): TextSelection {
  const from = Math.max(0, Math.min(requestedFrom, document.content.length));
  const to = Math.max(from, Math.min(requestedTo, document.content.length));
  return {
    path,
    text: document.content.slice(from, to),
    from,
    to,
    startLine: lineAtOffset(document.content, from),
    endLine: lineAtOffset(document.content, to),
    fileVersion: document.file.version,
  };
}

function lineAtOffset(content: string, offset: number): number {
  return content
    .slice(0, Math.max(0, Math.min(offset, content.length)))
    .split("\n").length;
}

function useStoredString<T extends string>(key: string, initial: T, allowed: readonly T[]): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => { const stored = localStorage.getItem(key); return allowed.includes(stored as T) ? stored as T : initial; });
  const update = useCallback((next: T) => { setValue(next); localStorage.setItem(key, next); }, [key]);
  return [value, update];
}

function useStoredNumber(
  key: string,
  initial: number,
): [number, (value: number) => void] {
  const [value, setValue] = useState(
    () => { const stored = Number.parseInt(localStorage.getItem(key) ?? "", 10); return Number.isFinite(stored) ? stored : initial; },
  );
  const update = useCallback(
    (next: number) => {
      setValue(next);
      localStorage.setItem(key, String(Math.round(next)));
    },
    [key],
  );
  return [value, update];
}

function useStoredBoolean(
  key: string,
  initial: boolean,
): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    const stored = localStorage.getItem(key);
    return stored === null ? initial : stored === "true";
  });
  const update = useCallback(
    (next: boolean) => {
      setValue(next);
      localStorage.setItem(key, String(next));
    },
    [key],
  );
  return [value, update];
}
