import { statusLabel } from "../../lib/labels";
import type { ReferencePaper, ReferenceSettings } from "@fastwrite/shared";
import type { ReferenceWriteAction } from "./ReferenceStylePanel";
import { ReferenceTags } from "./ReferenceTags";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeSet, PaperProject, ReviewIssue, ReviseCommandId, ReviseTurn, TextSelection, TableEquationCandidate } from "@fastwrite/shared";
import { api } from "../../api/client";
import { diffWords } from "../../lib/wordDiff";
import { Button, Dialog, Field, Icon, IconButton, icons, QuickPick, Select, SegmentedControl, Tag, TextArea } from "../ui";
import { ReviewDialog } from "./ReviewDialog";
import { MemoryDialog } from "./MemoryDialog";
import { ResearchDialog } from "./ResearchDialog";
import { AgentTaskWorkspace, type AgentTaskSeed } from "./AgentTaskDialog";
import type { CompileStateReport } from "./PdfPane";
import { compileRepairObjective, compileRepairPath, type CompileRepairRequest } from "./compileRepair";
import { responseLanguage } from "../../lib/responseLanguage";

interface AiWorkspaceProps {
  referenceSettings?: ReferenceSettings | null;
  referencePapers?: ReferencePaper[];
  referenceAction?: ReferenceWriteAction | null;
  onRemoveReference?: (id: string) => void;

  project: PaperProject;
  selection: TextSelection | null;
  paragraphSelection: TextSelection | null;
  sectionSelection: TextSelection | null;
  height: number;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onUseSelection: (selection: TextSelection) => void;
  onClearSelection: () => void;
  onRestoreSelection: (selection: TextSelection) => Promise<boolean>;
  onFileChanged: (path: string, range?: { from: number; to: number }) => void | Promise<void>;
  onNavigate: (path: string, line?: number) => void;
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

type PanelState = "idle" | "running" | "applying" | "accepted" | "error";
interface ChatMessage { id: string; role: "user" | "assistant"; content: string; rationale?: string }

export function AiWorkspace({ referenceSettings = null, referencePapers = [], referenceAction, onRemoveReference = () => {}, project, selection, paragraphSelection, sectionSelection, height, fullscreen, onToggleFullscreen, onUseSelection, onClearSelection, onRestoreSelection, onFileChanged, onNavigate, onWorkspaceChanged, onPrepareLocalRevision, compileState, compileRepairRequest, onRequestCompile }: AiWorkspaceProps) {
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
  const [editedAfter, setEditedAfter] = useState("");
  const [fullscreenWidth, setFullscreenWidth] = useState(() => Number.parseInt(localStorage.getItem("fastwrite.ai-fullscreen-width") ?? "", 10) || 800);
  const [resizingWidth, setResizingWidth] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const selectionKeyRef = useRef("");
  const preserveNextSelectionRef = useRef(false);
  const restoredKeyRef = useRef("");
  const recoveryAttemptedRef = useRef("");
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const appliedCompileRepairRef = useRef<number | null>(null);

  useEffect(() => () => { requestRef.current?.abort(); resizeCleanupRef.current?.(); }, []);
  useEffect(() => { const controller = new AbortController(); void api.harness.list(controller.signal).then(setHarnesses).catch(() => setHarnesses([])).finally(() => { if (!controller.signal.aborted) setHarnessLoading(false); }); return () => controller.abort(); }, []);
  useEffect(() => {
    if (!compileRepairRequest || appliedCompileRepairRef.current === compileRepairRequest.id) return;
    appliedCompileRepairRef.current = compileRepairRequest.id;
    setAgentSeed({
      objective: compileRepairObjective(compileRepairRequest.failure),
      path: compileRepairPath(compileRepairRequest.failure)
    });
    setActiveTab("agent");
  }, [compileRepairRequest]);
  useEffect(() => { messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight }); }, [messages, state, editingProposal]);
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
      else resetChat();
    }
    selectionKeyRef.current = selectionKey;
    restoredKeyRef.current = selectionKey;
    const stored = readConversation(project.id, selectionKey);
    if (!stored || !selection) return;
    setMessages(stored.messages);
    setChangeSet(stored.changeSet);
    setEditedAfter(stored.workingText || stored.changeSet?.changes[0]?.after || "");
    setInstruction(stored.instruction || "");
  }, [project.id, selection, selectionKey]);

  useEffect(() => {
    if (!selectionKey || selectionKeyRef.current !== selectionKey) return;
    if (selection) writeConversation(project.id, selectionKey, { selection, messages, changeSet, workingText: editingProposal ? editedAfter : changeSet?.changes[0]?.after ?? "", instruction });
  }, [changeSet, editingProposal, editedAfter, instruction, messages, project.id, selection, selectionKey]);

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

  const resetChat = () => {
    requestRef.current?.abort();
    if (changeSet?.status === "proposed") void api.revisions.reject(project.id, changeSet.id).catch(() => undefined);
    setMessages([]);
    setChangeSet(null);
    setEditedAfter("");
    setEditingProposal(false);
    setInstruction("");
    setError("");
    setState("idle");
    if (selectionKey) localStorage.removeItem(conversationStorageKey(project.id, selectionKey));
    localStorage.removeItem(latestConversationStorageKey(project.id));
  };

  const proposeStructured = async () => {
    setStructuredBusy(true);
    try {
      const candidate = await api.structuredCandidates.propose(project.id, { kind: structuredKind, targetPath: structuredPath, sourceFormat: structuredKind === "equation" && structuredFormat === "csv" ? "latex" : structuredFormat, source: structuredSource });
      setStructuredCandidate(candidate);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "无法生成结构化候选内容"); }
    finally { setStructuredBusy(false); }
  };
  const compileStructured = async () => {
    if (!structuredCandidate) return;
    setStructuredBusy(true);
    try {
      const result = await api.structuredCandidates.compileCheck(project.id, structuredCandidate.changeSet.id);
      setStructuredCandidate((current) => current ? { ...current, compileCheck: { status: result.status, message: result.message } } : current);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "无法验证候选内容"); }
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
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
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
      }, controller.signal);
      if (changeSet?.status === "proposed") await api.revisions.reject(project.id, changeSet.id).catch(() => undefined);
      setChangeSet(result.changeSet);
      setEditedAfter(result.changeSet.changes[0]!.after);
      setEditingProposal(false);
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", content: result.changeSet.changes[0]!.after, rationale: result.changeSet.rationale }]);
      setState("idle");
    } catch (failure) {
      if ((failure as DOMException).name === "AbortError") return;
      setError(failure instanceof Error ? failure.message : "修改失败");
      setState("error");
    }
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
      setError(failure instanceof Error ? failure.message : "无法应用此审核决定");
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
      setError(failure instanceof Error ? failure.message : "无法回滚此次修改");
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

  const proposedAfter = editingProposal ? editedAfter : changeSet?.changes[0]?.after ?? "";
  const diff = useMemo(() => changeSet ? diffWords(changeSet.changes[0]!.before, proposedAfter) : [], [changeSet, proposedAfter]);
  const busy = state === "running" || state === "applying";
  const canDecide = changeSet?.status === "proposed";
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

  return (<>
    <section className={`ai-workspace${activeTab === "agent" ? " ai-workspace--agent" : ""}${fullscreen ? " ai-workspace--fullscreen" : ""}`} style={{ "--ai-workspace-height": `${height}px` } as React.CSSProperties} aria-label="AI 写作工作区">
      <header className="ai-workspace__header">
        <div className="ai-workspace__controls">
          <SegmentedControl
            className="ai-workspace__mode"
            label="AI 写作模式"
            value={activeTab}
            onChange={(mode) => { if (mode === "agent") setAgentSeed(selection?.path ? { path: selection.path } : {}); setActiveTab(mode); }}
            options={[
              { value: "revise", label: "修改", icon: <Icon name={icons.sparkle} /> },
              { value: "agent", label: "智能助手", icon: <Icon name={icons.typeHierarchy} /> }
            ]}
          />
          <div className="ai-workspace__harness">
            <Select aria-label="智能助手服务" value={selectedHarness} onChange={(kind) => { setSelectedHarness(kind as "codex" | "claude"); localStorage.setItem("fastwrite.selected-harness", kind); }} options={[{ value: "codex", label: "Codex" }, { value: "claude", label: "Claude" }]} />
            <span role="status" aria-label="智能助手服务状态"><Tag tone={harnessState === "ready" ? "success" : harnessState === "degraded" ? "warning" : "neutral"} title={harnessStatus?.message ?? harnessStatus?.version ?? "智能助手服务可用性"}>{harnessLoading ? "检查中" : harnessState === "ready" ? "就绪" : harnessState === "degraded" ? "受限" : "不可用"}</Tag></span>
          </div>
        </div>
        <div className="ai-workspace__tools">
          <IconButton label="论文记忆" icon={<Icon name={icons.database} />} onClick={() => setMemoryOpen(true)} />
          <IconButton label="文献研究" icon={<Icon name={icons.search} />} onClick={() => setResearchOpen(true)} />
          <IconButton label="表格或公式助手" icon={<Icon name={icons.listTree} />} onClick={() => setStructuredOpen(true)} />
          <IconButton label="审稿" icon={<Icon name={icons.verified} />} onClick={() => setReviewOpen(true)} />
      {activeTab === "revise" ? <IconButton label="清空当前对话" icon={<Icon name={icons.trash} />} onClick={clearConversation} /> : null}
          <IconButton label={fullscreen ? "退出全屏" : "全屏"} icon={<Icon name={fullscreen ? icons.screenNormal : icons.screenFull} />} onClick={onToggleFullscreen} />
        </div>
      </header>
      <ReferenceTags settings={referenceSettings} papers={referencePapers} onRemove={onRemoveReference} />
      <div className={`ai-workspace__body${resizingWidth ? " is-resizing-width" : ""}`} style={fullscreen ? { width: `min(${fullscreenWidth}px, 100%)` } : undefined}>
      <div hidden={activeTab !== "revise"} className="revise-chat">
        {selection ? <aside className="revise-context-strip"><span>{selection.path} · 行 {selection.startLine}–{selection.endLine}</span><p title={selection.text}>{selection.text}</p><IconButton label="清除所选上下文" icon={<Icon name={icons.close} />} onClick={onClearSelection} /></aside> : null}
        <div ref={messagesRef} className="revise-chat__messages" aria-live="polite">
          {!selection ? <div className="revise-chat__empty"><Icon name={icons.sparkle} /><strong>在编辑器中选择文本</strong><span>选择句子、使用光标所在段落，或修改当前章节。对话期间将保留所选上下文。</span>{paragraphSelection ? <Button size="small" variant="primary" onClick={() => onUseSelection(paragraphSelection)}>使用当前段落</Button> : null}{sectionSelection ? <Button size="small" variant="secondary" onClick={() => onUseSelection(sectionSelection)}>使用当前章节</Button> : null}</div> : null}
          {messages.map((message, index) => <article className={`revise-message revise-message--${message.role}`} key={message.id}>
            <span>{message.role === "assistant" ? <><Icon name={icons.robot} /> {project.skill.name}</> : "你"}</span>
            {message.role === "assistant" && index === messages.length - 1 && changeSet ? <>
              {editingProposal ? <TextArea className="revision-edit-textarea" aria-label="可编辑的修改文本" value={editedAfter} onChange={setEditedAfter} spellCheck={false} autoFocus /> : <div className="revision-diff" aria-label="建议的逐词更改">{diff.map((part, partIndex) => part.type === "delete" ? <del key={partIndex}>{part.value}</del> : part.type === "insert" ? <ins key={partIndex}>{part.value}</ins> : <span key={partIndex}>{part.value}</span>)}</div>}
              {message.rationale ? <p className="revision-rationale">{message.rationale}</p> : null}
              <div className="revision-inline-actions">
                {changeSet.status === "accepted" ? <><span className="revision-accepted"><Icon name={icons.check} /> 已应用</span><Button size="small" variant="ghost" icon={<Icon name={icons.discard} />} disabled={busy} onClick={() => void rollback()}>回滚</Button></> : canDecide ? <><Button size="small" variant="ghost" icon={<Icon name={icons.close} />} disabled={busy} onClick={() => void decide("reject")}>拒绝</Button>{editingProposal ? <Button size="small" variant="ghost" onClick={() => { setEditedAfter(changeSet.changes[0]!.after); setEditingProposal(false); }}>取消编辑</Button> : <Button size="small" variant="secondary" icon={<Icon name={icons.edit} />} disabled={busy} onClick={() => setEditingProposal(true)}>编辑</Button>}<Button size="small" variant="primary" icon={<Icon name={icons.check} />} disabled={busy || (editingProposal && (!editedAfter.trim() || editedAfter === changeSet.changes[0]!.before))} onClick={() => void decide("accept")}>{editingProposal && editedAfter !== changeSet.changes[0]!.after ? "保存并接受" : "接受"}</Button></> : null}
              </div>
            </> : <p>{message.content}</p>}
          </article>)}
          {state === "running" ? <article className="revise-message revise-message--assistant revise-message--status"><span><Icon name={icons.robot} /> {project.skill.name}</span><p><Icon name={icons.loading} spin /> 正在优化当前候选内容…</p></article> : null}
          {error ? <div className="revision-error" role="alert">{error}</div> : null}
        </div>
        <form className="revise-composer" onSubmit={(event) => { event.preventDefault(); void propose(); }}>
          <div className="revise-shortcuts" role="group" aria-label="快捷修改指令">
            {SHORTCUTS.slice(0, 3).map((shortcut) => <Button variant="secondary" className="revise-shortcut" key={shortcut.id} disabled={!selection || busy} onClick={() => void propose(shortcut.id)}>{shortcut.label}</Button>)}
            <Button variant="ghost" className="revise-shortcut" icon={<Icon name={icons.ellipsis} />} disabled={!selection || busy} onClick={() => setActionsOpen(true)}>更多操作</Button>
          </div>
          <div className="revise-composer__input"><TextArea ref={inputRef} rows={2} value={instruction} onChange={setInstruction} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (selection && instruction.trim() && !busy) void propose(); } }} placeholder={selection ? "提出进一步修改要求…" : "在编辑器中选择文本以开始…"} disabled={!selection || busy} aria-label="修改要求" /><Button variant="primary" size="small" icon={<Icon name={icons.send} />} loading={busy} disabled={!selection || !instruction.trim() || busy} type="submit">发送</Button></div>
          <small>每轮回复都会优化当前候选内容，接受后才会修改文件。</small>
        </form>
      </div>
      <div hidden={activeTab !== "agent"} className="agent-workspace-slot"><AgentTaskWorkspace key={agentSeed.planId ?? "default"} open={activeTab === "agent"} project={project} references={referenceSettings?.selections ?? []} seed={{ ...agentSeed, harness: selectedHarness }} compileState={compileState} onRequestCompile={onRequestCompile} onClose={() => setActiveTab("revise")} onAccepted={onFileChanged} onNavigate={onNavigate} /></div>
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
