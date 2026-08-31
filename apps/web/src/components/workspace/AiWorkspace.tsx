import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, Database, GripVertical, LoaderCircle, Maximize2, Minimize2, Pencil, RotateCcw, Send, ShieldCheck, Sparkles, Trash2, Workflow, X, Search } from "lucide-react";
import type { ChangeSet, PaperProject, ReviewIssue, ReviseCommandId, ReviseTurn, TextSelection } from "@fastwrite/shared";
import { api } from "../../api/client";
import { diffWords } from "../../lib/wordDiff";
import { Button } from "../ui/Button";
import { ReviewDialog } from "./ReviewDialog";
import { MemoryDialog } from "./MemoryDialog";
import { ResearchDialog } from "./ResearchDialog";
import { AgentTaskWorkspace, type AgentTaskSeed } from "./AgentTaskDialog";
import type { CompileStateReport } from "./PdfPane";
import { compileRepairObjective, compileRepairPath, type CompileRepairRequest } from "./compileRepair";

interface AiWorkspaceProps {
  project: PaperProject;
  selection: TextSelection | null;
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
  { id: "academic-polish", label: "Academic polish" },
  { id: "logic-check", label: "Logic check" },
  { id: "condense", label: "Condense" },
  { id: "expand-argument", label: "Expand argument" },
  { id: "reorganize", label: "Reorganize" },
  { id: "grammar", label: "Grammar" },
  { id: "citation-suggestion", label: "Citation suggestion" }
];

type PanelState = "idle" | "running" | "applying" | "accepted" | "error";
interface ChatMessage { id: string; role: "user" | "assistant"; content: string; rationale?: string }

export function AiWorkspace({ project, selection, sectionSelection, height, fullscreen, onToggleFullscreen, onUseSelection, onClearSelection, onRestoreSelection, onFileChanged, onNavigate, onWorkspaceChanged, onPrepareLocalRevision, compileState, compileRepairRequest, onRequestCompile }: AiWorkspaceProps) {
  const [instruction, setInstruction] = useState("");
  const [state, setState] = useState<PanelState>("idle");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [changeSet, setChangeSet] = useState<ChangeSet | null>(null);
  const [error, setError] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [researchOpen, setResearchOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"revise" | "agent">("revise");
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

  const clearConversation = () => {
    if (changeSet?.status === "proposed" && !window.confirm("Discard the current unaccepted revision and clear this conversation?")) return;
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
        selection,
        ...(command ? { command } : { instruction: prompt }),
        ...(workingText !== selection.text ? { workingText } : {}),
        ...(history.length ? { history } : {})
      }, controller.signal);
      if (changeSet?.status === "proposed") await api.revisions.reject(project.id, changeSet.id).catch(() => undefined);
      setChangeSet(result.changeSet);
      setEditedAfter(result.changeSet.changes[0]!.after);
      setEditingProposal(false);
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", content: result.changeSet.changes[0]!.after, rationale: result.changeSet.rationale }]);
      setState("idle");
    } catch (failure) {
      if ((failure as DOMException).name === "AbortError") return;
      setError(failure instanceof Error ? failure.message : "Revision failed");
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
      setError(failure instanceof Error ? failure.message : "Could not apply this decision");
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
      setError(failure instanceof Error ? failure.message : "Could not roll back this revision");
      setState("error");
    }
  };

  const beginLocalRevision = async (issue: ReviewIssue) => {
    const nextSelection = await onPrepareLocalRevision(issue);
    if (!nextSelection) return;
    resetChat();
    selectionKeyRef.current = `${nextSelection.path}:${nextSelection.from}:${nextSelection.to}:${nextSelection.fileVersion}:${nextSelection.text}`;
    setInstruction(`Resolve this review issue locally: ${issue.title}. ${issue.suggestion}`);
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

  return (<>
    <section className={`ai-workspace${activeTab === "agent" ? " ai-workspace--agent" : ""}${fullscreen ? " ai-workspace--fullscreen" : ""}`} style={{ "--ai-workspace-height": `${height}px` } as React.CSSProperties} aria-label="AI writing workspace">
      <header className="ai-workspace__header">
        <nav className="ai-workspace__tabs" aria-label="AI writing mode"><button className={activeTab === "revise" ? "is-active" : ""} onClick={() => setActiveTab("revise")}><Sparkles /> Revise</button><button className={activeTab === "agent" ? "is-active" : ""} onClick={() => { setAgentSeed(selection?.path ? { path: selection.path } : {}); setActiveTab("agent"); }}><Workflow /> Agent</button></nav>
        <div className="ai-workspace__tools">
          <button className="ai-header-action" onClick={() => setMemoryOpen(true)}><Database /> Memory</button>
          <button className="ai-header-action" onClick={() => setResearchOpen(true)}><Search /> Research</button>
          <button className="ai-header-action" onClick={() => setReviewOpen(true)}><ShieldCheck /> Review</button>
          {activeTab === "revise" ? <button className="ai-header-action" title="Clear current conversation" onClick={clearConversation}><Trash2 /> Clear</button> : null}
          <button className="ai-header-action" title={fullscreen ? "Exit fullscreen" : "Fullscreen"} onClick={onToggleFullscreen}>{fullscreen ? <Minimize2 /> : <Maximize2 />}</button>
          <span className="ai-skill"><Bot /> {project.skill.name}</span>
        </div>
      </header>
      <div className={`ai-workspace__body${resizingWidth ? " is-resizing-width" : ""}`} style={fullscreen ? { width: `min(${fullscreenWidth}px, 100%)` } : undefined}>
      <div hidden={activeTab !== "revise"} className="revise-chat">
        {selection ? <aside className="revise-context-strip"><span>{selection.path} · lines {selection.startLine}–{selection.endLine}</span><p title={selection.text}>{selection.text}</p><button type="button" title="Clear selected context" aria-label="Clear selected context" onClick={onClearSelection}><X /></button></aside> : null}
        <div ref={messagesRef} className="revise-chat__messages" aria-live="polite">
          {!selection ? <div className="revise-chat__empty"><Sparkles /><strong>Select text in the editor</strong><span>Select a sentence or paragraph, or use the current section. The selection stays active while you chat.</span>{sectionSelection ? <Button size="small" variant="secondary" onClick={() => onUseSelection(sectionSelection)}>Use current section</Button> : null}</div> : null}
          {messages.map((message, index) => <article className={`revise-message revise-message--${message.role}`} key={message.id}>
            <span>{message.role === "assistant" ? <><Bot /> {project.skill.name}</> : "You"}</span>
            {message.role === "assistant" && index === messages.length - 1 && changeSet ? <>
              {editingProposal ? <textarea className="revision-edit-textarea" aria-label="Editable revised text" value={editedAfter} onChange={(event) => setEditedAfter(event.target.value)} spellCheck={false} autoFocus /> : <div className="revision-diff" aria-label="Proposed word-level changes">{diff.map((part, partIndex) => part.type === "delete" ? <del key={partIndex}>{part.value}</del> : part.type === "insert" ? <ins key={partIndex}>{part.value}</ins> : <span key={partIndex}>{part.value}</span>)}</div>}
              {message.rationale ? <p className="revision-rationale">{message.rationale}</p> : null}
              <div className="revision-inline-actions">
                {changeSet.status === "accepted" ? <><span className="revision-accepted"><Check /> Applied</span><Button size="small" variant="ghost" icon={<RotateCcw />} disabled={busy} onClick={() => void rollback()}>Rollback</Button></> : canDecide ? <><Button size="small" variant="ghost" icon={<X />} disabled={busy} onClick={() => void decide("reject")}>Reject</Button>{editingProposal ? <Button size="small" variant="ghost" onClick={() => { setEditedAfter(changeSet.changes[0]!.after); setEditingProposal(false); }}>Cancel edit</Button> : <Button size="small" variant="secondary" icon={<Pencil />} disabled={busy} onClick={() => setEditingProposal(true)}>Edit</Button>}<Button size="small" variant="primary" icon={<Check />} disabled={busy || (editingProposal && (!editedAfter.trim() || editedAfter === changeSet.changes[0]!.before))} onClick={() => void decide("accept")}>{editingProposal && editedAfter !== changeSet.changes[0]!.after ? "Save & accept" : "Accept"}</Button></> : null}
              </div>
            </> : <p>{message.content}</p>}
          </article>)}
          {state === "running" ? <article className="revise-message revise-message--assistant revise-message--status"><span><Bot /> {project.skill.name}</span><p><LoaderCircle className="spin" /> Refining the current candidate…</p></article> : null}
          {error ? <div className="revision-error" role="alert">{error}</div> : null}
        </div>
        <form className="revise-composer" onSubmit={(event) => { event.preventDefault(); void propose(); }}>
          <div className="revise-shortcuts" aria-label="Revision prompt shortcuts">{SHORTCUTS.map((shortcut) => <button type="button" key={shortcut.id} disabled={!selection || busy} onClick={() => void propose(shortcut.id)}>{shortcut.label}</button>)}</div>
          <div className="revise-composer__input"><textarea ref={inputRef} rows={2} value={instruction} onChange={(event) => setInstruction(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (selection && instruction.trim() && !busy) void propose(); } }} placeholder={selection ? "Ask for another revision…" : "Select text in the editor to start…"} disabled={!selection || busy} aria-label="Revision message" /><Button variant="primary" size="small" icon={<Send />} loading={busy} disabled={!selection || !instruction.trim() || busy} type="submit">Send</Button></div>
          <small>Each reply refines the current candidate. The file changes only after Accept.</small>
        </form>
      </div>
      <div hidden={activeTab !== "agent"} className="agent-workspace-slot"><AgentTaskWorkspace open={activeTab === "agent"} project={project} seed={agentSeed} compileState={compileState} onRequestCompile={onRequestCompile} onClose={() => setActiveTab("revise")} onAccepted={onFileChanged} onNavigate={onNavigate} /></div>
      {fullscreen ? <div className="ai-workspace__width-handle" role="separator" aria-label="Resize maximized AI workspace" aria-orientation="vertical" aria-valuemin={Math.min(560, window.innerWidth)} aria-valuemax={window.innerWidth} aria-valuenow={Math.min(fullscreenWidth, window.innerWidth)} tabIndex={0} onPointerDown={startWidthResize} onKeyDown={(event) => {
        if (event.key === "ArrowLeft") { event.preventDefault(); updateFullscreenWidth(fullscreenWidth - 40); }
        else if (event.key === "ArrowRight") { event.preventDefault(); updateFullscreenWidth(fullscreenWidth + 40); }
        else if (event.key === "Home") { event.preventDefault(); updateFullscreenWidth(560); }
        else if (event.key === "End") { event.preventDefault(); updateFullscreenWidth(window.innerWidth); }
      }}><GripVertical /></div> : null}
      </div>
    </section>
    <ReviewDialog open={reviewOpen} project={project} compileState={compileState} onRequestCompile={onRequestCompile} onClose={() => setReviewOpen(false)} onNavigate={onNavigate} onReviseLocally={(issue) => void beginLocalRevision(issue)} onReviseWithAgent={(issueIds, objective) => { setAgentSeed({ issueIds, objective }); setReviewOpen(false); setActiveTab("agent"); }} />
    <MemoryDialog open={memoryOpen} project={project} onClose={() => setMemoryOpen(false)} onNavigate={onNavigate} onChanged={onWorkspaceChanged} />
    <ResearchDialog open={researchOpen} project={project} onClose={() => setResearchOpen(false)} />
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
