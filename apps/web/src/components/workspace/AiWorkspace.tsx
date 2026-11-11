import { CompileAssistantDialog } from "./CompileAssistantDialog";
import { userFacingError } from "../../lib/notifications";
import { statusLabel } from "../../lib/labels";
import type { AgentTaskRequest, AgentTaskSkillDescriptor, ReferencePaper, ReferenceSettings } from "@fastwrite/shared";
import type { ReferenceWriteAction } from "./ReferenceStylePanel";
import { ReferenceTags } from "./ReferenceTags";
import { useEffect, useRef, useState } from "react";
import type { ChangeSet, PaperProject, ReviewIssue, ReviseCommandId, ReviseTurn, TextSelection, TableEquationCandidate } from "@fastwrite/shared";
import { api } from "../../api/client";
import { Button, Dialog, Field, Icon, IconButton, icons, QuickPick, Select, SegmentedControl, Tag, TextArea } from "../ui";
import { ReviewDialog } from "./ReviewDialog";
import { MemoryDialog } from "./MemoryDialog";
import { ResearchDialog } from "./ResearchDialog";
import { AgentTaskWorkspace, type AgentTaskSeed } from "./AgentTaskDialog";
import type { CompileStateReport } from "./PdfPane";
import { compileRepairObjective, compileRepairPath, type CompileRepairRequest } from "./compileRepair";
import { responseLanguage } from "../../lib/responseLanguage";
import { AiThread } from "./ai/AiThread";
import { AiComposer } from "./ai/AiComposer";
import { AiContextBar } from "./ai/AiContextBar";
import { ChangeSetCard } from "./ai/ChangeSetCard";
import { useRevisionRequest } from "./ai/useRevisionRequest";
import type { AiChatMessage as ChatMessage, AiPanelState as PanelState } from "./ai/AiMessage";

interface AiWorkspaceProps {
  taskSkills: AgentTaskSkillDescriptor[];
  taskSkillsLoading: boolean;
  taskSkillIds: string[];
  onTaskSkillIdsChange: (ids: string[]) => void;
  skillTaskRequest: number;
  referenceSettings?: ReferenceSettings | null;
  referencePapers?: ReferencePaper[];
  referenceAction?: ReferenceWriteAction | null;
  onRemoveReference?: (id: string) => void;

  project: PaperProject;
  selection: TextSelection | null;
  paragraphSelection: TextSelection | null;
  sectionSelection: TextSelection | null;
  completionEnabled: boolean;
  onCompletionEnabledChange: (enabled: boolean) => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onUseSelection: (selection: TextSelection) => void;
  onClearSelection: () => void;
  onRestoreSelection: (selection: TextSelection) => Promise<boolean>;
  onFileChanged: (path: string, range?: { from: number; to: number }) => void | Promise<void>;
  onNavigate: (path: string, line?: number) => void;
  beforeCompile: () => Promise<void>;
  onWorkspaceChanged: () => void | Promise<void>;
  onPrepareLocalRevision: (issue: ReviewIssue) => Promise<TextSelection | null>;
  compileState: CompileStateReport;
  compileRepairRequest: CompileRepairRequest | null;
  onRequestCompile: () => void;
}

const SHORTCUTS: ReadonlyArray<{ id: ReviseCommandId; label: string }> = [
  { id: "academic-polish", label: "学术润色" },
  { id: "logic-check", label: "逻辑检查" },
  { id: "condense", label: "精简" },
  { id: "expand-argument", label: "扩展论证" },
  { id: "reorganize", label: "调整结构" },
  { id: "grammar", label: "语法检查" },
  { id: "citation-suggestion", label: "引用建议" },
  { id: "clarify-contribution", label: "明确贡献" },
  { id: "strengthen-transition", label: "加强衔接" },
  { id: "terminology-consistency", label: "术语一致性" },
  { id: "limitations", label: "局限性" }
];

export function AiWorkspace({ taskSkills, taskSkillsLoading, taskSkillIds, onTaskSkillIdsChange, skillTaskRequest, referenceSettings = null, referencePapers = [], referenceAction, onRemoveReference = () => {}, project, selection, paragraphSelection, sectionSelection, completionEnabled, onCompletionEnabledChange, fullscreen, onToggleFullscreen, onUseSelection, onClearSelection, onRestoreSelection, onFileChanged, onNavigate, onWorkspaceChanged, beforeCompile, onPrepareLocalRevision, compileState, compileRepairRequest, onRequestCompile }: AiWorkspaceProps) {
  const [instruction, setInstruction] = useState("");
  const [state, setState] = useState<PanelState>("idle");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [changeSet, setChangeSet] = useState<ChangeSet | null>(null);
  const [error, setError] = useState("");
  const [actionsOpen, setActionsOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [researchOpen, setResearchOpen] = useState(false);
  const [structuredOpen, setStructuredOpen] = useState(false);
  const [structuredKind, setStructuredKind] = useState<"table" | "equation">("table");
  const [structuredFormat, setStructuredFormat] = useState<"csv" | "natural-language" | "latex">("csv");
  const [structuredPath, setStructuredPath] = useState("sections/results.tex");
  const [structuredSource, setStructuredSource] = useState("");
  const [structuredCandidate, setStructuredCandidate] = useState<TableEquationCandidate | null>(null);
  const [structuredBusy, setStructuredBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<"revise" | "agent">("revise");
  const [harnesses, setHarnesses] = useState<Array<{ status: { kind: string; state: string; version?: string; message?: string }; capabilities: Record<string, boolean> }>>([]);
  const [harnessLoading, setHarnessLoading] = useState(true);
  const [selectedHarness, setSelectedHarness] = useState<"codex" | "claude">(() => localStorage.getItem("fastwrite.selected-harness") === "claude" ? "claude" : "codex");
  const [agentSeed, setAgentSeed] = useState<AgentTaskSeed>({});
  const [editingProposal, setEditingProposal] = useState(false);
  const [compileAssistantOpen, setCompileAssistantOpen] = useState(false);
  const [compileAssistantLightweight, setCompileAssistantLightweight] = useState(false);
  const [editedAfter, setEditedAfter] = useState("");
  const [fullscreenWidth, setFullscreenWidth] = useState(() => Number.parseInt(localStorage.getItem("fastwrite.ai-fullscreen-width") ?? "", 10) || 800);
  const [resizingWidth, setResizingWidth] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const revisionRequest = useRevisionRequest();
  const submittedInstruction = useRef("");
  const [loadedSelectionKey, setLoadedSelectionKey] = useState("");
  const selectionKeyRef = useRef("");
  const preserveNextSelectionRef = useRef(false);
  const restoredKeyRef = useRef("");
  const recoveryAttemptedRef = useRef("");
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const appliedCompileRepairRef = useRef<number | null>(null);
  const appliedSkillTaskRef = useRef(0);

  useEffect(() => {
    if (!skillTaskRequest || skillTaskRequest === appliedSkillTaskRef.current) return;
    appliedSkillTaskRef.current = skillTaskRequest;
    setAgentSeed({});
    setActiveTab("agent");
  }, [skillTaskRequest]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);
  useEffect(() => { const controller = new AbortController(); void api.harness.list(controller.signal).then(setHarnesses).catch(() => setHarnesses([])).finally(() => { if (!controller.signal.aborted) setHarnessLoading(false); }); return () => controller.abort(); }, []);
  useEffect(() => {
    if (!compileRepairRequest || appliedCompileRepairRef.current === compileRepairRequest.id) return;
    appliedCompileRepairRef.current = compileRepairRequest.id;
    setCompileAssistantLightweight(true);
    setCompileAssistantOpen(true);
  }, [compileRepairRequest]);
  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onToggleFullscreen(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullscreen, onToggleFullscreen]);

  useEffect(() => {
    if (selection || recoveryAttemptedRef.current === project.id) return;
    recoveryAttemptedRef.current = project.id;
    const stored = readLatestConversation(project.id);
    if (!stored?.selection) return;
    void onRestoreSelection(stored.selection);
  }, [onRestoreSelection, project.id, selection]);

  const selectionKey = selection ? `${selection.path}:${selection.from}:${selection.to}:${selection.fileVersion}:${selection.text}` : "";
  useEffect(() => {
    if (!selectionKey || restoredKeyRef.current === selectionKey) return;
    if (selectionKeyRef.current && selectionKeyRef.current !== selectionKey) {
      if (preserveNextSelectionRef.current) preserveNextSelectionRef.current = false;
      else resetChat(selectionKeyRef.current, false);
    }
    selectionKeyRef.current = selectionKey;
    restoredKeyRef.current = selectionKey;
    setLoadedSelectionKey(selectionKey);
    const stored = readConversation(project.id, selectionKey);
    if (!stored || !selection) return;
    setMessages(stored.messages);
    setChangeSet(stored.changeSet);
    setEditedAfter(stored.workingText ?? stored.changeSet?.changes[0]?.after ?? "");
    setEditingProposal(stored.changeSet?.status === "proposed" && typeof stored.workingText === "string" && stored.workingText !== stored.changeSet.changes[0]?.after);
    setInstruction(stored.instruction || "");
  }, [project.id, selection, selectionKey]);

  useEffect(() => {
    if (!selectionKey || loadedSelectionKey !== selectionKey || selectionKeyRef.current !== selectionKey) return;
    if (selection) writeConversation(project.id, selectionKey, { selection, messages, changeSet, workingText: editingProposal ? editedAfter : changeSet?.changes[0]?.after ?? "", instruction });
  }, [changeSet, editingProposal, editedAfter, instruction, loadedSelectionKey, messages, project.id, selection, selectionKey]);

  const handledReferenceAction = useRef<string | null>(null);
  useEffect(() => {
    if (!referenceAction || handledReferenceAction.current === referenceAction.id) return;
    if (state === "running" || state === "applying") { handledReferenceAction.current = referenceAction.id; setError("请等待当前写作完成后再切换目标范围。"); return; }
    if (referenceAction.target === "selection" || referenceAction.target === "section") {
      const target = referenceAction.target === "section" ? sectionSelection : selection;
      if (!target) { setError("请先选择当前论文的文本或章节。"); return; }
      if (referenceAction.target === "section" && target.text.length > 12_000) {
        handledReferenceAction.current = referenceAction.id;
        setAgentSeed({ objective: referenceAction.instruction, path: target.path, scope: { type: "section", path: target.path, section: { heading: target.text.split("\n")[0] ?? "当前章节", startLine: target.startLine, endLine: target.endLine } } });
        setActiveTab("agent"); return;
      }
      if (!selection || selection.path !== target.path || selection.from !== target.from || selection.to !== target.to || selection.fileVersion !== target.fileVersion) { onUseSelection(target); return; }
      handledReferenceAction.current = referenceAction.id;
      setInstruction(referenceAction.instruction); setActiveTab("revise");
    } else {
      const path = referenceAction.path ?? selection?.path ?? sectionSelection?.path ?? paragraphSelection?.path;
      if (referenceAction.target === "file" && !path) { setError("请先打开一个正文文件。"); return; }
      handledReferenceAction.current = referenceAction.id;
      setAgentSeed({ objective: referenceAction.instruction, ...(path ? { path } : {}), scope: referenceAction.target === "file" ? { type: "file", path: path! } : { type: "project" } });
      setActiveTab("agent");
    }
  }, [referenceAction, state, selection, sectionSelection, paragraphSelection, onUseSelection]);

  const resetChat = (keyToClear = selectionKey, discard = true) => {
    revisionRequest.cancel();
    if (discard && changeSet?.status === "proposed") void api.revisions.reject(project.id, changeSet.id).catch(() => undefined);
    setMessages([]);
    setChangeSet(null);
    setEditedAfter("");
    setEditingProposal(false);
    setInstruction("");
    setError("");
    setState("idle");
    if (discard) {
      if (keyToClear) localStorage.removeItem(conversationStorageKey(project.id, keyToClear));
      localStorage.removeItem(latestConversationStorageKey(project.id));
    }
  };

  const proposeStructured = async () => {
    setStructuredBusy(true);
    try {
      const candidate = await api.structuredCandidates.propose(project.id, { kind: structuredKind, targetPath: structuredPath, sourceFormat: structuredKind === "equation" && structuredFormat === "csv" ? "latex" : structuredFormat, source: structuredSource });
      setStructuredCandidate(candidate);
    } catch (failure) { setError(userFacingError(failure, "无法生成结构化候选内容")); }
    finally { setStructuredBusy(false); }
  };
  const compileStructured = async () => {
    if (!structuredCandidate) return;
    setStructuredBusy(true);
    try {
      const result = await api.structuredCandidates.compileCheck(project.id, structuredCandidate.changeSet.id);
      setStructuredCandidate((current) => current ? { ...current, compileCheck: { status: result.status, message: result.message } } : current);
    } catch (failure) { setError(userFacingError(failure, "无法验证候选内容")); }
    finally { setStructuredBusy(false); }
  };

  const clearConversation = () => {
    if (changeSet?.status === "proposed" && !window.confirm("放弃当前尚未接受的修改并清空对话？")) return;
    resetChat();
  };

  const propose = async (command?: ReviseCommandId) => {
    if (!selection || state === "running" || state === "applying") return;
    const prompt = command ? SHORTCUTS.find((item) => item.id === command)?.label ?? command : instruction.trim();
    if (!prompt) return;
    const request = revisionRequest.begin();
    submittedInstruction.current = prompt;
    const workingText = changeSet ? (editingProposal ? editedAfter : changeSet.changes[0]!.after) : selection.text;
    const history: ReviseTurn[] = messages.map(({ role, content }) => ({ role, content }));
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content: prompt };
    setMessages((current) => [...current, userMessage]);
    setInstruction("");
    setState("running");
    setError("");
    try {
      const result = await api.revisions.propose(project.id, {
        references: referenceSettings?.selections ?? [],
        selection,
        ...(command ? { command } : { instruction: prompt }),
        ...(workingText !== selection.text ? { workingText } : {}),
        ...(history.length ? { history } : {})
        ,responseLanguage: responseLanguage()
      }, request.signal);
      if (!request.isCurrent()) return;
      if (changeSet?.status === "proposed") await api.revisions.reject(project.id, changeSet.id).catch(() => undefined);
      if (!request.isCurrent()) return;
      setChangeSet(result.changeSet);
      setEditedAfter(result.changeSet.changes[0]!.after);
      setEditingProposal(false);
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", content: result.changeSet.changes[0]!.after, rationale: result.changeSet.rationale }]);
      setState("idle");
    } catch (failure) {
      if (!request.isCurrent() || (failure as DOMException).name === "AbortError") return;
      setError(userFacingError(failure, "修改失败"));
      setState("error");
    } finally { request.finish(); }
  };

  const stopRevision = () => {
    revisionRequest.cancel();
    setInstruction(submittedInstruction.current);
    setState("stopped");
    setError("");
  };

  const decide = async (decision: "accept" | "reject") => {
    if (!changeSet || changeSet.status !== "proposed") return;
    setState("applying");
    setError("");
    try {
      let pending = changeSet;
      if (decision === "accept" && editingProposal && editedAfter !== changeSet.changes[0]!.after) {
        pending = await api.revisions.edit(project.id, changeSet.id, { changes: [{ path: changeSet.changes[0]!.path, after: editedAfter }] });
      }
      const updated = decision === "accept"
        ? await api.revisions.accept(project.id, pending.id)
        : await api.revisions.reject(project.id, pending.id);
      setEditingProposal(false);
      if (decision === "accept") {
        const change = updated.changes[0]!;
        setChangeSet(updated);
        setState("accepted");
        preserveNextSelectionRef.current = true;
        await onFileChanged(change.path, { from: change.from, to: change.from + change.after.length });
      } else {
        setChangeSet(null);
        setEditedAfter("");
        setState("idle");
        inputRef.current?.focus();
      }
    } catch (failure) {
      setError(userFacingError(failure, "无法应用此审核决定"));
      setState("error");
    }
  };

  const rollback = async () => {
    if (!changeSet || changeSet.status !== "accepted") return;
    setState("applying");
    setError("");
    try {
      const updated = await api.revisions.rollback(project.id, changeSet.id);
      const change = updated.changes[0]!;
      preserveNextSelectionRef.current = true;
      await onFileChanged(change.path, { from: change.from, to: change.from + change.before.length });
      resetChat();
    } catch (failure) {
      setError(userFacingError(failure, "无法回滚此次修改"));
      setState("error");
    }
  };

  const beginLocalRevision = async (issue: ReviewIssue) => {
    const nextSelection = await onPrepareLocalRevision(issue);
    if (!nextSelection) return;
    resetChat();
    selectionKeyRef.current = `${nextSelection.path}:${nextSelection.from}:${nextSelection.to}:${nextSelection.fileVersion}:${nextSelection.text}`;
    setInstruction(`局部解决此审稿问题： ${issue.title}. ${issue.suggestion}`);
    setReviewOpen(false);
    window.setTimeout(() => inputRef.current?.focus(), 120);
  };

  const busy = state === "running" || state === "applying";
  const updateFullscreenWidth = (next: number) => {
    const width = Math.round(Math.min(Math.max(560, next), Math.max(560, window.innerWidth)));
    setFullscreenWidth(width);
    localStorage.setItem("fastwrite.ai-fullscreen-width", String(width));
  };
  const startWidthResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeCleanupRef.current?.();
    setResizingWidth(true);
    const onMove = (moveEvent: PointerEvent) => updateFullscreenWidth(Math.abs(moveEvent.clientX - window.innerWidth / 2) * 2);
    const cleanup = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", cleanup);
      resizeCleanupRef.current = null;
      setResizingWidth(false);
    };
    resizeCleanupRef.current = cleanup;
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", cleanup, { once: true });
  };

  const harnessStatus = harnesses.find(item => item.status.kind === selectedHarness)?.status;
  const harnessState = harnessStatus?.state;
  const needsSection = taskSkills.some(skill => taskSkillIds.includes(skill.id) && skill.allowedScope === "section");
  const taskScope: AgentTaskRequest["scope"] = agentSeed.scope ?? (needsSection && sectionSelection ? { type: "section", path: sectionSelection.path, section: { heading: sectionSelection.text.split("\n")[0] ?? "当前章节", startLine: sectionSelection.startLine, endLine: sectionSelection.endLine } } : { type: "project" });

  return (<>
    <section className={`ai-workspace${activeTab === "agent" ? " ai-workspace--agent" : ""}${fullscreen ? " ai-workspace--fullscreen" : ""}`} aria-label="AI 写作工作区">
      <header className="ai-workspace__header">
        <div className="ai-workspace__controls">
          <SegmentedControl
            className="ai-workspace__mode"
            label="AI 写作模式"
            value={activeTab}
            onChange={(mode) => { if (state === "running") stopRevision(); if (mode === "agent") setAgentSeed(selection?.path ? { path: selection.path } : {}); setActiveTab(mode); }}
            options={[
              { value: "revise", label: "修改", disabled: state === "applying", icon: <Icon name={icons.sparkle} /> },
              { value: "agent", label: "智能助手", disabled: state === "applying", icon: <Icon name={icons.typeHierarchy} /> }
            ]}
          />
          <div className="ai-workspace__harness">
            <Select appearance="toolbar" aria-label="智能助手服务" value={selectedHarness} onChange={(kind) => { setSelectedHarness(kind as "codex" | "claude"); localStorage.setItem("fastwrite.selected-harness", kind); }} options={[
              { value: "codex", label: "Codex", description: "OpenAI", icon: <Icon name={icons.robot} size={14} /> },
              { value: "claude", label: "Claude", description: "Anthropic", icon: <Icon name={icons.sparkle} size={14} /> }
            ]} />
            <span role="status" aria-label="智能助手服务状态"><Tag tone={harnessState === "ready" ? "success" : harnessState === "degraded" ? "warning" : "neutral"} title={harnessStatus?.message ?? harnessStatus?.version ?? "智能助手服务可用性"}>{harnessLoading ? "检查中" : harnessState === "ready" ? "就绪" : harnessState === "degraded" ? "受限" : "不可用"}</Tag></span>
          </div>
        </div>
        <div className="ai-workspace__tools">
          <Button className="ai-workspace__completion" size="small" variant={completionEnabled ? "secondary" : "ghost"} type="button" aria-pressed={completionEnabled} title="技能指导的写作补全" icon={<Icon name={icons.sparkle} />} onClick={() => onCompletionEnabledChange(!completionEnabled)}>补全</Button>
          <IconButton label="编译助手与待审核修改" icon={<Icon name={icons.tools} />} onClick={() => { setCompileAssistantLightweight(false); setCompileAssistantOpen(true); }} />
          <IconButton label="论文记忆" icon={<Icon name={icons.database} />} onClick={() => setMemoryOpen(true)} />
          <IconButton label="文献研究" icon={<Icon name={icons.search} />} onClick={() => setResearchOpen(true)} />
          <IconButton label="表格或公式助手" icon={<Icon name={icons.listTree} />} onClick={() => setStructuredOpen(true)} />
          <IconButton label="审稿" icon={<Icon name={icons.verified} />} onClick={() => setReviewOpen(true)} />
      {activeTab === "revise" ? <IconButton label="清空当前对话" icon={<Icon name={icons.trash} />} onClick={clearConversation} /> : null}
          <IconButton label={fullscreen ? "退出全屏" : "全屏"} icon={<Icon name={fullscreen ? icons.screenNormal : icons.screenFull} />} onClick={onToggleFullscreen} />
        </div>
      </header>
      {activeTab === "agent" ? <ReferenceTags settings={referenceSettings} papers={referencePapers} onRemove={onRemoveReference} /> : null}
      <div className={`ai-workspace__body${resizingWidth ? " is-resizing-width" : ""}`} style={fullscreen ? { width: `min(${fullscreenWidth}px, 100%)` } : undefined}>
      <div hidden={activeTab !== "revise"} className="revise-chat">
        <AiThread conversationKey={`${project.id}:${selectionKey}`} active={activeTab === "revise"} messages={messages} assistantName={project.skill.name} state={state} error={error} proposalVersion={`${changeSet?.id ?? ""}:${changeSet?.status ?? ""}:${editingProposal}:${editingProposal ? editedAfter : ""}`}
          empty={!selection ? <div className="revise-chat__empty"><Icon name={icons.sparkle} /><strong>在编辑器中选择文本</strong><div className="revise-chat__targets">{paragraphSelection ? <Button size="small" variant="primary" onClick={() => onUseSelection(paragraphSelection)}>使用当前段落</Button> : null}{sectionSelection ? <Button size="small" variant="secondary" onClick={() => onUseSelection(sectionSelection)}>使用当前章节</Button> : null}</div></div> : undefined}
          proposal={changeSet ? <ChangeSetCard changeSet={changeSet} rationale={changeSet.rationale} editing={editingProposal} editedAfter={editedAfter} busy={busy}
            onEdit={() => setEditingProposal(true)} onEditText={setEditedAfter} onCancelEdit={() => { setEditedAfter(changeSet.changes[0]!.after); setEditingProposal(false); }}
            onDecide={decision => void decide(decision)} onRollback={() => void rollback()} /> : undefined}
        />
        <AiComposer instruction={instruction} state={state} hasSelection={!!selection} inputRef={inputRef} shortcuts={SHORTCUTS.slice(0, 3)}
          context={<AiContextBar selection={selection} settings={referenceSettings} papers={referencePapers} disabled={state === "applying"} onClear={() => { if (state === "running") stopRevision(); onClearSelection(); }} onRemoveReference={onRemoveReference} />}
          onChange={setInstruction} onSubmit={() => void propose()} onShortcut={command => void propose(command)} onMore={() => setActionsOpen(true)} onStop={stopRevision}
        />
      </div>
      <div hidden={activeTab !== "agent"} className="agent-workspace-slot"><AgentTaskWorkspace key={agentSeed.planId ?? "default"} open={activeTab === "agent"} project={project} taskSkills={taskSkills} taskSkillsLoading={taskSkillsLoading} taskSkillIds={taskSkillIds} onTaskSkillIdsChange={onTaskSkillIdsChange} references={referenceSettings?.selections ?? []} seed={{ ...agentSeed, harness: selectedHarness, scope: taskScope }} compileState={compileState} onRequestCompile={onRequestCompile} onClose={() => setActiveTab("revise")} onAccepted={onFileChanged} onNavigate={onNavigate} /></div>
      {fullscreen ? <div className="ai-workspace__width-handle" role="separator" aria-label="调整最大化 AI 工作区大小" aria-orientation="vertical" aria-valuemin={Math.min(560, window.innerWidth)} aria-valuemax={window.innerWidth} aria-valuenow={Math.min(fullscreenWidth, window.innerWidth)} tabIndex={0} onPointerDown={startWidthResize} onKeyDown={(event) => {
        if (event.key === "ArrowLeft") { event.preventDefault(); updateFullscreenWidth(fullscreenWidth - 40); }
        else if (event.key === "ArrowRight") { event.preventDefault(); updateFullscreenWidth(fullscreenWidth + 40); }
        else if (event.key === "Home") { event.preventDefault(); updateFullscreenWidth(560); }
        else if (event.key === "End") { event.preventDefault(); updateFullscreenWidth(window.innerWidth); }
      }}><Icon name={icons.gripper} /></div> : null}
      </div>
    </section>
    <Dialog open={actionsOpen} title="修改操作" description="为所选文本选择操作。" width="small" onClose={() => setActionsOpen(false)}>
      <QuickPick label="修改操作" filterLabel="查找修改操作" items={SHORTCUTS.slice(3)} onSelect={(command) => { setActionsOpen(false); void propose(command as ReviseCommandId); }} />
    </Dialog>
    <CompileAssistantDialog open={compileAssistantOpen} projectId={project.id} initialLightweight={compileAssistantLightweight} {...(compileRepairRequest?.diagnosticId && compileAssistantLightweight ? { initialDiagnosticId: compileRepairRequest.diagnosticId } : {})} diagnostics={compileState.diagnostics} beforeRun={beforeCompile} onAccepted={async path => { await onFileChanged(path); await onWorkspaceChanged(); onRequestCompile(); }} onClose={() => setCompileAssistantOpen(false)} />
    <ReviewDialog open={reviewOpen} project={project} compileState={compileState} onRequestCompile={onRequestCompile} onClose={() => setReviewOpen(false)} onNavigate={onNavigate} onReviseLocally={(issue) => void beginLocalRevision(issue)} onReviseWithAgent={(issueIds, objective) => { setAgentSeed({ issueIds, objective }); setReviewOpen(false); setActiveTab("agent"); }} />
    <Dialog open={structuredOpen} width="wide" title="表格与公式助手" description="生成可审核的 LaTeX 候选内容，审核更改集后再应用。" onClose={() => setStructuredOpen(false)}>
      <div className="structured-assistant"><div className="form-grid"><Field label="类型"><Select value={structuredKind} onChange={(value) => { setStructuredKind(value as "table" | "equation"); setStructuredFormat(value === "table" ? "csv" : "latex"); }} options={[{ value: "table", label: "表格" }, { value: "equation", label: "公式" }]} /></Field><Field label="输入格式"><Select value={structuredFormat} onChange={(value) => setStructuredFormat(value as typeof structuredFormat)} options={structuredKind === "table" ? [{ value: "csv", label: "CSV" }, { value: "natural-language", label: "自然语言" }, { value: "latex", label: "LaTeX" }] : [{ value: "latex", label: "LaTeX" }, { value: "natural-language", label: "自然语言" }]} /></Field><Field label="目标 .tex 文件路径"><TextArea rows={1} value={structuredPath} onChange={setStructuredPath} /></Field></div><Field label="来源"><TextArea value={structuredSource} onChange={setStructuredSource} placeholder={structuredKind === "table" ? "方法,准确率\nA,0.9" : "x = y + 1"} /></Field><Button loading={structuredBusy} disabled={!structuredSource.trim() || !structuredPath.trim()} onClick={() => void proposeStructured()}>生成候选内容</Button>{structuredCandidate ? <section className="structured-candidate"><header><strong>候选内容预览</strong><span>{statusLabel(structuredCandidate.compileCheck.status)}</span></header><pre>{structuredCandidate.preview}</pre><p>{structuredCandidate.compileCheck.message ?? "编译整个项目之前，请先检查候选内容。"}</p><div><Button size="small" variant="secondary" loading={structuredBusy} onClick={() => void compileStructured()}>检查候选内容</Button><Button size="small" variant="ghost" onClick={() => { setStructuredOpen(false); setStructuredCandidate(null); }}>关闭</Button></div></section> : null}</div>
    </Dialog>
    <MemoryDialog open={memoryOpen} project={project} onClose={() => setMemoryOpen(false)} onNavigate={onNavigate} onChanged={onWorkspaceChanged} />
    <ResearchDialog open={researchOpen} project={project} onClose={() => setResearchOpen(false)} onChanged={onWorkspaceChanged} onNavigate={onNavigate} />
  </>);
}

type StoredConversation = { selection: TextSelection; messages: ChatMessage[]; changeSet: ChangeSet | null; workingText: string; instruction: string };
function conversationStorageKey(projectId: string, selectionKey: string) { return `fastwrite.revise.${projectId}.${encodeURIComponent(selectionKey)}`; }
function latestConversationStorageKey(projectId: string) { return `fastwrite.revise.${projectId}.latest`; }
function readConversation(projectId: string, selectionKey: string): StoredConversation | null {
  try {
    const raw = localStorage.getItem(conversationStorageKey(projectId, selectionKey));
    if (!raw) return null;
    const value = JSON.parse(raw) as StoredConversation;
    return Array.isArray(value.messages) ? value : null;
  } catch { return null; }
}
function writeConversation(projectId: string, selectionKey: string, value: StoredConversation): void {
  try {
    localStorage.setItem(conversationStorageKey(projectId, selectionKey), JSON.stringify(value));
    localStorage.setItem(latestConversationStorageKey(projectId), selectionKey);
  } catch { /* Storage is optional. */ }
}
function readLatestConversation(projectId: string): StoredConversation | null {
  try {
    const selectionKey = localStorage.getItem(latestConversationStorageKey(projectId));
    return selectionKey ? readConversation(projectId, selectionKey) : null;
  } catch { return null; }
}
