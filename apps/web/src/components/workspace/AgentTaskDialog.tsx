import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronRight, FileText, LoaderCircle, RotateCcw, ShieldCheck, Workflow, X } from "lucide-react";
import type { AgentRun, AgentTaskPlan, ChangeSet, IssueResolution, PaperProject } from "@fastwrite/shared";
import { api } from "../../api/client";
import { diffWords } from "../../lib/wordDiff";
import { Button } from "../ui/Button";
import type { CompileStateReport } from "./PdfPane";
import { EditableChangeReview } from "./EditableChangeReview";

type Stage = "input" | "planning" | "plan" | "generating" | "diff" | "applying" | "accepted" | "rereviewing";
export interface AgentTaskSeed { issueIds?: string[]; objective?: string; path?: string }

export function AgentTaskWorkspace({ open, project, seed, compileState, onRequestCompile, onClose, onDraft, onAccepted }: { open: boolean; project: PaperProject; seed: AgentTaskSeed; compileState: CompileStateReport; onRequestCompile: () => void; onClose: () => void; onDraft?: () => void; onAccepted: (path: string) => void | Promise<void> }) {
  const [stage, setStage] = useState<Stage>("input");
  const [objective, setObjective] = useState("");
  const [plan, setPlan] = useState<AgentTaskPlan | null>(null);
  const [run, setRun] = useState<AgentRun | null>(null);
  const [changeSet, setChangeSet] = useState<ChangeSet | null>(null);
  const [resolution, setResolution] = useState<IssueResolution | null>(null);
  const [activeFile, setActiveFile] = useState(0);
  const [error, setError] = useState("");
  const [deciding, setDeciding] = useState(false);
  const [dismissedPlanId, setDismissedPlanId] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => { if (open && stage === "input") setObjective(seed.objective ?? ""); }, [open, seed.objective, stage]);
  useEffect(() => { setDismissedPlanId(null); }, [project.id]);
  useEffect(() => () => requestRef.current?.abort(), []);
  useEffect(() => {
    if (!open || stage !== "input" || seed.objective || seed.issueIds?.length) return;
    const controller = new AbortController();
    void Promise.all([api.agentTasks.list(project.id, controller.signal), api.agentTasks.resolutions(project.id, controller.signal), api.agentTasks.runs(project.id, controller.signal)]).then(async ([plans, resolutions, runs]) => {
      const recoverable = plans.find((candidate) => candidate.id !== dismissedPlanId && (candidate.status === "proposed" || candidate.status === "waiting-approval"))
        ?? plans.find((candidate) => candidate.id !== dismissedPlanId && candidate.status === "accepted" && candidate.changeSetId);
      if (!recoverable) return;
      setPlan(recoverable);
      setRun(runs.find((candidate) => candidate.id === recoverable.agentRunId) ?? null);
      setObjective(recoverable.request.objective);
      setResolution(resolutions.find((candidate) => candidate.agentRunId === recoverable.agentRunId) ?? null);
      if (recoverable.changeSetId) {
        const restoredChangeSet = await api.revisions.get(project.id, recoverable.changeSetId, controller.signal);
        setChangeSet(restoredChangeSet);
        setStage(restoredChangeSet.status === "accepted" ? "accepted" : "diff");
      } else setStage("plan");
    }).catch(() => undefined);
    return () => controller.abort();
  }, [dismissedPlanId, open, project.id, seed.issueIds, seed.objective, stage]);
  useEffect(() => {
    if (!open || stage !== "accepted" || !plan || compileState.state !== "success") return;
    const controller = new AbortController();
    void Promise.all([api.agentTasks.runs(project.id, controller.signal), api.agentTasks.resolutions(project.id, controller.signal)]).then(([runs, resolutions]) => {
      setRun(runs.find((candidate) => candidate.id === plan.agentRunId) ?? null);
      setResolution(resolutions.find((candidate) => candidate.agentRunId === plan.agentRunId) ?? null);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [compileState.state, compileState.compiledVersion, open, plan, project.id, stage]);
  const busy = ["planning", "generating", "applying", "rereviewing"].includes(stage);
  const compiledCurrentVersion = compileState.state === "success" && compileState.compiledVersion === project.version;
  const compiling = compileState.state === "loading" || compileState.state === "compiling";
  const selectedChange = changeSet?.changes[activeFile];
  const parts = useMemo(() => selectedChange ? diffWords(selectedChange.before, selectedChange.after) : [], [selectedChange]);

  const createPlan = async () => { const controller = beginRequest(requestRef); setStage("planning"); setError(""); try { const result = await api.agentTasks.plan(project.id, { objective, scope: { type: "project" }, ...(seed.issueIds?.length ? { issueIds: seed.issueIds } : {}) }, controller.signal); setRun(result.run); setPlan(result.plan); setResolution(result.resolution ?? null); setStage("plan"); } catch (failure) { setError(cancelMessage(failure, "Agent planning")); setStage("input"); } finally { finishRequest(requestRef, controller); } };
  const generate = async () => { if (!plan) return; const controller = beginRequest(requestRef); setStage("generating"); setError(""); try { const result = await api.agentTasks.confirm(project.id, plan.id, controller.signal); setRun(result.run); setPlan(result.plan); setChangeSet(result.changeSet); setResolution(result.resolution ?? resolution); setActiveFile(0); setStage("diff"); } catch (failure) { setError(cancelMessage(failure, "Agent execution")); setStage("plan"); } finally { finishRequest(requestRef, controller); } };
  const accept = async () => { if (!changeSet) return; setStage("applying"); setError(""); try { const accepted = await api.revisions.accept(project.id, changeSet.id); setChangeSet(accepted); await onAccepted(accepted.changes[0]!.path); const [resolutions, runs] = await Promise.all([api.agentTasks.resolutions(project.id), api.agentTasks.runs(project.id)]); if (resolution) setResolution(resolutions.find((item) => item.id === resolution.id) ?? resolution); setRun(runs.find((item) => item.id === plan?.agentRunId) ?? run); setStage("accepted"); } catch (failure) { setError(message(failure)); setStage("diff"); } };
  const reject = async () => { if (!changeSet) return; setDeciding(true); setError(""); try { const updated = await api.revisions.reject(project.id, changeSet.id); if (updated.status === "accepted") { setChangeSet(updated); await onAccepted(updated.changes.find((change) => change.hunks?.some((hunk) => hunk.status === "accepted"))?.path ?? updated.changes[0]!.path); setStage("accepted"); } else { reset(); onClose(); } } catch (failure) { setError(message(failure)); } finally { setDeciding(false); } };
  const decideHunks = async (hunkIds: string[], status: "accepted" | "rejected") => { if (!changeSet || !selectedChange) return; setDeciding(true); setError(""); try { const updated = await api.revisions.decide(project.id, changeSet.id, { decisions: [{ path: selectedChange.path, hunkIds, status }] }); setChangeSet(updated); if (status === "accepted") await onAccepted(selectedChange.path); const [resolutions, runs] = await Promise.all([api.agentTasks.resolutions(project.id), api.agentTasks.runs(project.id)]); if (resolution) setResolution(resolutions.find((item) => item.id === resolution.id) ?? resolution); setRun(runs.find((item) => item.id === plan?.agentRunId) ?? run); if (updated.status === "accepted") setStage("accepted"); else if (updated.status === "rejected") { reset(); onClose(); } } catch (failure) { setError(message(failure)); } finally { setDeciding(false); } };
  const editChange = async (after: string) => { if (!changeSet || !selectedChange) return; setError(""); setChangeSet(await api.revisions.edit(project.id, changeSet.id, { changes: [{ path: selectedChange.path, after }] })); };
  const rollback = async () => { if (!changeSet) return; setStage("applying"); setError(""); try { await api.revisions.rollback(project.id, changeSet.id); await onAccepted(changeSet.changes[0]!.path); reset(); onClose(); } catch (failure) { setError(message(failure)); setStage("accepted"); } };
  const rereview = async () => { if (!resolution) return; const controller = beginRequest(requestRef); setStage("rereviewing"); setError(""); try { setResolution(await api.agentTasks.rereview(project.id, resolution.id, controller.signal)); setStage("accepted"); } catch (failure) { setError(cancelMessage(failure, "Targeted re-review")); setStage("accepted"); } finally { finishRequest(requestRef, controller); } };
  const reopen = async () => { if (!resolution) return; setError(""); try { setResolution(await api.agentTasks.reopen(project.id, resolution.id)); } catch (failure) { setError(message(failure)); } };
  const discardPlan = async () => { if (plan?.status === "proposed") await api.agentTasks.cancel(project.id, plan.id).catch(() => undefined); reset(); };
  const startNewTask = () => { setDismissedPlanId(plan?.id ?? null); reset(); };
  const reset = () => { setStage("input"); setPlan(null); setRun(null); setChangeSet(null); setResolution(null); setError(""); setActiveFile(0); };

  const footer = (
    busy ? <Button variant="secondary" onClick={() => requestRef.current?.abort()}>Cancel task</Button> :
    stage === "input" ? <><Button variant="ghost" onClick={onClose}>Back to Revise</Button><Button variant="primary" disabled={!objective.trim()} onClick={() => void createPlan()}>Create plan</Button></> :
    stage === "plan" ? <><Button variant="ghost" onClick={() => void discardPlan()}>Discard plan</Button><Button variant="primary" onClick={() => void generate()}>Confirm plan</Button></> :
    stage === "diff" ? <><Button variant="ghost" icon={<X />} onClick={() => void reject()}>Reject all</Button><Button variant="primary" icon={<Check />} onClick={() => void accept()}>Accept changes</Button></> :
    stage === "accepted" ? <><Button variant="ghost" onClick={() => { reset(); onClose(); }}>Done</Button><Button variant="ghost" onClick={startNewTask}>New task</Button><Button variant="secondary" icon={<RotateCcw />} onClick={() => void rollback()}>Rollback</Button>{resolution?.status === "resolved" ? <Button variant="secondary" onClick={() => void reopen()}>Reopen issue</Button> : null}{!compiledCurrentVersion ? <Button variant="secondary" loading={compiling} disabled={compiling} onClick={onRequestCompile}>{compiling ? "Compiling" : "Compile current version"}</Button> : null}{resolution?.status === "needs-review" || resolution?.status === "reopened" ? <Button variant="primary" icon={<ShieldCheck />} disabled={!compiledCurrentVersion} onClick={() => void rereview()}>Targeted re-review</Button> : null}</> : null
  );
  const content = <>
    {stage === "input" ? <div className="agent-task-form"><div className="agent-mode-intro"><Workflow /><div><strong>Draft or revise across the whole paper</strong><span>Describe the outcome. Agent reads the project, proposes an affected-file plan, then shows an editable ChangeSet before anything is written.</span>{seed.path ? <small>Current editor context: {seed.path} (a hint, not a scope limit)</small> : null}</div></div>{!seed.issueIds?.length && onDraft ? <div className="agent-draft-entry"><div><strong>Starting a paper?</strong><span>Send one research brief, review the outline, then approve the generated files like a code change.</span></div><Button variant="secondary" onClick={onDraft}>Draft from research brief</Button></div> : null}<label className="field"><span>What should Agent change?</span><textarea value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="Create an initial draft, or revise the Introduction and Evaluation consistently…" autoFocus /></label>{seed.issueIds?.length ? <div className="agent-issue-seed"><ShieldCheck /> Revision is linked to {seed.issueIds.length} Review Issue{seed.issueIds.length === 1 ? "" : "s"}.</div> : null}</div> : null}
    {busy ? <div className="agent-progress"><LoaderCircle className="spin" /><strong>{stage === "planning" ? "Planning the scoped revision" : stage === "generating" ? "Executing the approved plan" : stage === "rereviewing" ? "Checking whether the issue is resolved" : "Applying approved changes"}</strong><span>Files remain unchanged until the ChangeSet is accepted.</span></div> : null}
    {stage === "plan" && plan ? <div className="agent-plan"><div className="agent-plan__objective"><small>Objective</small><strong>{plan.request.objective}</strong></div><section><h3>Steps</h3><ol>{plan.steps.map((step, index) => <li key={index}>{step}</li>)}</ol></section><section><h3>Affected files</h3>{plan.affectedFiles.map((path) => <code key={path}>{path}</code>)}</section><section><h3>Validation</h3><ul>{plan.validation.map((item, index) => <li key={index}>{item}</li>)}</ul></section><section><h3>Risks</h3>{plan.risks.length ? <ul>{plan.risks.map((risk, index) => <li key={index}>{risk}</li>)}</ul> : <p>No special risks reported.</p>}</section></div> : null}
    {(stage === "diff" || stage === "accepted") && changeSet ? <div className="draft-diff"><nav>{changeSet.changes.map((change, index) => <button className={index === activeFile ? "is-active" : ""} key={change.path} onClick={() => setActiveFile(index)}><FileText /><span>{change.path}</span><small>{change.hunks?.some((hunk) => hunk.status === "pending") ? "pending" : change.hunks?.some((hunk) => hunk.status === "accepted") ? "accepted" : "rejected"}</small><ChevronRight /></button>)}</nav><div className="draft-diff__file"><header>{selectedChange?.path}</header>{selectedChange ? <EditableChangeReview change={selectedChange} busy={deciding} readOnly={stage === "accepted" || changeSet.status !== "proposed"} onSave={editChange} onDecide={(ids, status) => void decideHunks(ids, status)} /> : <div className="revision-diff">{parts.map((part, index) => <span key={index}>{part.value}</span>)}</div>}</div>{stage === "accepted" ? <div className={`agent-resolution agent-resolution--${resolution?.status ?? "accepted"}`}>{resolution?.status === "resolved" ? <Check /> : resolution?.status === "reopened" ? <AlertTriangle /> : <ShieldCheck />}<span><strong>{resolution ? resolution.status.replace("-", " ") : "Changes applied"}</strong>{resolution?.rereviewAssessment ?? (resolution ? "Compile the paper, then run targeted re-review for the linked issues." : "Compile the paper to validate the accepted changes.")}{resolution ? <small className="resolution-timeline">Review snapshot {resolution.reviewSnapshotIds?.length || 0} → Run → ChangeSet → {resolution.compileRecordId ? "Compile recorded" : "Compile pending"} → {resolution.status === "resolved" ? "Resolved" : "Re-review pending"}</small> : null}</span></div> : null}</div> : null}
    {run?.auditTrail?.length ? <details className="agent-audit"><summary>Audit trail · {run.auditTrail.length} events</summary>{run.auditTrail.map((event) => <div key={event.id}><span>{event.action.replaceAll("-", " ")}</span><p>{event.summary}</p><time>{new Date(event.createdAt).toLocaleString()}</time></div>)}</details> : null}
    {error ? <div className="form-error" role="alert">{error}</div> : null}
  </>;
  return <section className="agent-embedded" aria-label="Agent workspace"><div className="agent-embedded__body">{content}</div><footer className="agent-embedded__footer">{footer}</footer></section>;
}

function message(error: unknown) { return error instanceof Error ? error.message : "Agent task failed"; }
function cancelMessage(error: unknown, label: string) { return error instanceof DOMException && error.name === "AbortError" ? `${label} cancelled. No changes were created.` : message(error); }
function beginRequest(ref: React.MutableRefObject<AbortController | null>) { ref.current?.abort(); const controller = new AbortController(); ref.current = controller; return controller; }
function finishRequest(ref: React.MutableRefObject<AbortController | null>, controller: AbortController) { if (ref.current === controller) ref.current = null; }
