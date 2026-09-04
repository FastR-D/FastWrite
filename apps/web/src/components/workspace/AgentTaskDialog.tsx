import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, CheckCircle2, ChevronRight, FilePlus2, FileText, ListTodo, LoaderCircle, PencilLine, RotateCcw, ShieldCheck, X } from "lucide-react";
import type { AgentRun, AgentTaskIntent, AgentTaskPlan, ChangeSet, ChangeSetConflictDetails, ChangeSetDecisionRequest, IssueResolution, PaperProject } from "@fastwrite/shared";
import { api, ApiClientError } from "../../api/client";
import { diffWords } from "../../lib/wordDiff";
import { Button } from "../ui/Button";
import type { CompileStateReport } from "./PdfPane";
import { EditableChangeReview } from "./EditableChangeReview";
import { ChangeSetConflictDialog } from "./ChangeSetConflictDialog";
import { activeAgentChangeSetStage, activeAgentIntentCommand, AGENT_INTENT_COMMANDS, applyAgentIntentCommand, recoverableAgentPlan, restoredAgentReviewStage } from "./agentCommands";
import { changeSetHunkCounts, fileReviewState, hunkCounts, pendingDecisions } from "./agentReview";

type Stage = "input" | "planning" | "plan" | "generating" | "diff" | "applying" | "accepted" | "rereviewing";
type PendingConflict = { details: ChangeSetConflictDetails; request: ChangeSetDecisionRequest; finishAfter: boolean };
export interface AgentTaskSeed { issueIds?: string[]; objective?: string; path?: string; harness?: "codex" | "claude" }

export function AgentTaskWorkspace({ open, project, seed, compileState, onRequestCompile, onClose, onAccepted, onNavigate }: { open: boolean; project: PaperProject; seed: AgentTaskSeed; compileState: CompileStateReport; onRequestCompile: () => void; onClose: () => void; onAccepted: (path: string) => void | Promise<void>; onNavigate?: (path: string, line?: number) => void }) {
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
  const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const appliedSeedRef = useRef<string | null>(null);
  const objectiveRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const key = `${project.id}\u0000${seed.objective ?? ""}\u0000${seed.path ?? ""}\u0000${(seed.issueIds ?? []).join(",")}`;
    if (appliedSeedRef.current === key) return;
    if (stage !== "input") return;
    appliedSeedRef.current = key;
    setObjective(seed.objective ?? "");
  }, [project.id, seed.issueIds, seed.objective, seed.path, stage]);
  useEffect(() => { setDismissedPlanId(null); }, [project.id]);
  useEffect(() => () => requestRef.current?.abort(), []);
  useEffect(() => {
    if (!open || stage !== "input" || seed.objective || seed.issueIds?.length) return;
    const controller = new AbortController();
    void Promise.all([api.agentTasks.list(project.id, controller.signal), api.agentTasks.resolutions(project.id, controller.signal), api.agentTasks.runs(project.id, controller.signal)]).then(async ([plans, resolutions, runs]) => {
      const recoverable = recoverableAgentPlan(plans, dismissedPlanId);
      if (!recoverable) return;
      const recoveredRun = runs.find((candidate) => candidate.id === recoverable.agentRunId) ?? null;
      const recoveredResolution = resolutions.find((candidate) => candidate.agentRunId === recoverable.agentRunId) ?? null;
      if (recoverable.changeSetId) {
        const restoredChangeSet = await api.revisions.get(project.id, recoverable.changeSetId, controller.signal);
        const restoredStage = restoredAgentReviewStage(restoredChangeSet);
        if (!restoredStage) { setDismissedPlanId(recoverable.id); return; }
        setChangeSet(restoredChangeSet);
        setStage(restoredStage);
      } else setStage("plan");
      setPlan(recoverable);
      setRun(recoveredRun);
      setObjective(recoverable.request.objective);
      setResolution(recoveredResolution);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [dismissedPlanId, open, project.id, seed.issueIds, seed.objective, stage]);
  useEffect(() => {
    if (!open || stage !== "diff" || !changeSet) return;
    const controller = new AbortController();
    void api.revisions.get(project.id, changeSet.id, controller.signal).then((latest) => {
      const latestStage = activeAgentChangeSetStage(latest);
      if (!latestStage) {
        setDismissedPlanId(plan?.id ?? null);
        setStage("input");
        setPlan(null);
        setRun(null);
        setChangeSet(null);
        setResolution(null);
        setError("");
        setPendingConflict(null);
        setActiveFile(0);
        return;
      }
      setChangeSet(latest);
      setStage(latestStage);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [changeSet?.id, open, plan?.id, project.id, stage]);
  useEffect(() => {
    if (!open || stage !== "accepted" || !plan || compileState.state !== "success") return;
    const controller = new AbortController();
    void Promise.all([api.agentTasks.runs(project.id, controller.signal), api.agentTasks.resolutions(project.id, controller.signal)]).then(([runs, resolutions]) => {
      setRun(runs.find((candidate) => candidate.id === plan.agentRunId) ?? null);
      setResolution(resolutions.find((candidate) => candidate.agentRunId === plan.agentRunId) ?? null);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [compileState.state, compileState.compiledVersion, open, plan, project.id, stage]);
  useEffect(() => {
    if (!open || stage !== "generating" || !plan) return;
    let active = true;
    const poll = () => { void api.agentTasks.runs(project.id).then((runs) => { if (active) setRun(runs.find((candidate) => candidate.id === plan.agentRunId) ?? null); }).catch(() => undefined); };
    poll();
    const timer = window.setInterval(poll, 600);
    return () => { active = false; window.clearInterval(timer); };
  }, [open, plan, project.id, stage]);
  const busy = ["planning", "generating", "applying", "rereviewing"].includes(stage);
  const compiledCurrentVersion = compileState.state === "success" && compileState.compiledVersion === project.version;
  const compiling = compileState.state === "loading" || compileState.state === "compiling";
  const selectedChange = changeSet?.changes[activeFile];
  const selectedCounts = selectedChange ? hunkCounts(selectedChange) : null;
  const selectedPendingHunkIds = selectedChange?.hunks?.filter((hunk) => hunk.status === "pending").map((hunk) => hunk.id) ?? [];
  const selectedPendingHasBlocking = selectedChange?.hunks?.some((hunk) => hunk.status === "pending" && hunk.findings?.some((finding) => finding.status === "blocking")) ?? false;
  const reviewCounts = changeSet ? changeSetHunkCounts(changeSet) : null;
  const parts = useMemo(() => selectedChange ? diffWords(selectedChange.before, selectedChange.after) : [], [selectedChange]);

  const createPlan = async () => { const controller = beginRequest(requestRef); setStage("planning"); setError(""); try { const result = await api.agentTasks.plan(project.id, { objective, scope: { type: "project" }, ...(seed.issueIds?.length ? { issueIds: seed.issueIds } : {}), ...(seed.harness ? { harness: seed.harness } : {}) }, controller.signal); setRun(result.run); setPlan(result.plan); setResolution(result.resolution ?? null); setStage("plan"); } catch (failure) { setError(cancelMessage(failure, "Agent planning")); setStage("input"); } finally { finishRequest(requestRef, controller); } };
  const generate = async () => { if (!plan) return; const controller = beginRequest(requestRef); setStage("generating"); setError(""); try { const result = await api.agentTasks.confirm(project.id, plan.id, controller.signal); setRun(result.run); setPlan(result.plan); setChangeSet(result.changeSet); setResolution(result.resolution ?? resolution); setActiveFile(0); setStage("diff"); } catch (failure) { setError(cancelMessage(failure, "Agent execution")); setStage("plan"); } finally { finishRequest(requestRef, controller); } };
  const reset = () => { setStage("input"); setPlan(null); setRun(null); setChangeSet(null); setResolution(null); setError(""); setPendingConflict(null); setActiveFile(0); };
  const startNewTask = () => { setDismissedPlanId(plan?.id ?? null); setObjective(""); reset(); };
  const refreshTaskState = async () => { const [resolutions, runs] = await Promise.all([api.agentTasks.resolutions(project.id), api.agentTasks.runs(project.id)]); const refreshedResolution = resolutions.find((item) => item.id === resolution?.id || item.agentRunId === plan?.agentRunId) ?? resolution; if (refreshedResolution) setResolution(refreshedResolution); setRun(runs.find((item) => item.id === plan?.agentRunId) ?? run); return refreshedResolution; };
  const applyFinishedReview = async (finished: ChangeSet) => {
    setChangeSet(finished);
    const refreshedResolution = await refreshTaskState();
    if (finished.status === "accepted") {
      await onAccepted(finished.changes.find((change) => change.hunks?.some((hunk) => hunk.status === "accepted"))?.path ?? finished.changes[0]!.path);
      if (refreshedResolution) setStage("accepted");
      else startNewTask();
    } else startNewTask();
  };
  const submitDecisions = async (request: ChangeSetDecisionRequest, finishAfter: boolean) => {
    if (!changeSet) return;
    setDeciding(true); setError("");
    try {
      const updated = await api.revisions.decide(project.id, changeSet.id, request);
      setChangeSet(updated);
      const firstPath = request.decisions[0]?.path;
      const updatedChange = updated.changes.find((change) => change.path === firstPath);
      const focusPath = updatedChange?.operation === "create" && !updatedChange.hunks?.some((hunk) => hunk.status === "accepted") ? project.mainDocument : firstPath ?? project.mainDocument;
      await onAccepted(focusPath);
      await refreshTaskState();
      if (finishAfter && !changeSetHunkCounts(updated).pending) await applyFinishedReview(await api.revisions.finish(project.id, updated.id));
      else if (updated.approvalMode !== "explicit-finish") {
        if (updated.status === "accepted") setStage("accepted");
        else if (updated.status === "rejected") { setObjective(""); reset(); }
      }
    } catch (failure) {
      if (failure instanceof ApiClientError && failure.code === "changeset_conflict_review_required" && isConflictDetails(failure.details)) setPendingConflict({ details: failure.details, request: { decisions: request.decisions }, finishAfter });
      else if (failure instanceof ApiClientError && failure.code === "changeset_not_proposed") {
        const latest = await api.revisions.get(project.id, changeSet.id).catch(() => null);
        const latestStage = latest ? activeAgentChangeSetStage(latest) : null;
        if (latest && latestStage) { setChangeSet(latest); setStage(latestStage); }
        else { setDismissedPlanId(plan?.id ?? null); reset(); }
        setError("");
      }
      else setError(message(failure));
    } finally { setDeciding(false); }
  };
  const decidePending = async (status: "accepted" | "rejected") => { if (!changeSet) return; const decisions = pendingDecisions(changeSet, status); if (decisions.length) await submitDecisions({ decisions, ...(status === "accepted" ? { overrideBlockingFindings: true } : {}) }, true); };
  const decideHunks = async (hunkIds: string[], status: "accepted" | "rejected") => { if (!selectedChange) return; await submitDecisions({ decisions: [{ path: selectedChange.path, hunkIds, status }] }, false); };
  const finishReview = async () => { if (!changeSet || reviewCounts?.pending) return; setStage("applying"); setError(""); try { await applyFinishedReview(await api.revisions.finish(project.id, changeSet.id)); } catch (failure) { setError(message(failure)); setStage("diff"); } };
  const editHunk = async (hunkId: string, after: string) => { if (!changeSet || !selectedChange) return; setError(""); try { setChangeSet(await api.revisions.edit(project.id, changeSet.id, { hunks: [{ path: selectedChange.path, hunkId, after }] })); } catch (failure) { setError(message(failure)); } };
  const confirmOverwrite = async () => {
    if (!pendingConflict) return;
    const { details, request, finishAfter } = pendingConflict;
    setPendingConflict(null);
    await submitDecisions({ ...request, overwriteConflicts: details.conflicts.map((conflict) => ({ path: conflict.path, currentVersion: conflict.currentVersion })) }, finishAfter);
  };
  const rollback = async () => { if (!changeSet) return; setStage("applying"); setError(""); try { await api.revisions.rollback(project.id, changeSet.id); await onAccepted(changeSet.changes[0]!.path); reset(); onClose(); } catch (failure) { setError(message(failure)); setStage("accepted"); } };
  const rereview = async () => { if (!resolution) return; const controller = beginRequest(requestRef); setStage("rereviewing"); setError(""); try { setResolution(await api.agentTasks.rereview(project.id, resolution.id, controller.signal)); setStage("accepted"); } catch (failure) { setError(cancelMessage(failure, "Targeted re-review")); setStage("accepted"); } finally { finishRequest(requestRef, controller); } };
  const reopen = async () => { if (!resolution) return; setError(""); try { setResolution(await api.agentTasks.reopen(project.id, resolution.id)); } catch (failure) { setError(message(failure)); } };
  const discardPlan = async () => { if (plan?.status === "proposed") await api.agentTasks.cancel(project.id, plan.id).catch(() => undefined); reset(); };
  const applyIntent = (intent: AgentTaskIntent) => {
    setObjective((current) => applyAgentIntentCommand(current, intent));
    window.requestAnimationFrame(() => objectiveRef.current?.focus());
  };

  const footer = (
    busy ? <Button variant="secondary" onClick={() => requestRef.current?.abort()}>Cancel task</Button> :
    stage === "input" ? <Button variant="primary" disabled={!objective.trim()} onClick={() => void createPlan()}>Create plan</Button> :
    stage === "plan" ? <><Button variant="ghost" onClick={() => void discardPlan()}>Discard plan</Button><Button variant="primary" onClick={() => void generate()}>Confirm plan</Button></> :
    stage === "diff" ? <><Button variant="ghost" disabled={deciding} onClick={onClose}>Leave review</Button>{reviewCounts?.pending ? <><Button variant="ghost" icon={<X />} disabled={deciding} onClick={() => void decidePending("rejected")}>Reject pending & complete</Button><Button variant="secondary" icon={<Check />} disabled={deciding} title="Accept all pending changes, including hunks with findings" onClick={() => void decidePending("accepted")}>Accept all & complete</Button></> : <Button variant="primary" icon={<CheckCircle2 />} disabled={deciding} title="Finalize the accepted and rejected hunk choices" onClick={() => void finishReview()}>Complete review</Button>}</> :
    stage === "accepted" ? <><Button variant="ghost" onClick={startNewTask}>New task</Button><Button variant="secondary" icon={<RotateCcw />} onClick={() => void rollback()}>Rollback</Button>{resolution?.status === "resolved" ? <Button variant="secondary" onClick={() => void reopen()}>Reopen issue</Button> : null}{!compiledCurrentVersion ? <Button variant="secondary" loading={compiling} disabled={compiling} onClick={onRequestCompile}>{compiling ? "Compiling" : "Compile current version"}</Button> : null}{resolution?.status === "needs-review" || resolution?.status === "reopened" ? <Button variant="primary" icon={<ShieldCheck />} disabled={!compiledCurrentVersion} onClick={() => void rereview()}>Targeted re-review</Button> : null}</> : null
  );
  const content = <>
    {stage === "input" ? <div className="agent-task-form"><label className="field"><span>What should Agent do?</span><textarea id="agent-task-objective" name="agent-task-objective" ref={objectiveRef} value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="Create an initial draft, continue the TODO sections, or revise the Introduction and Evaluation consistently…" autoFocus /></label><div className="agent-command-buttons" aria-label="Agent intent commands">{AGENT_INTENT_COMMANDS.map(({ intent, label }) => <Button type="button" size="small" variant="secondary" icon={intent === "draft" ? <FilePlus2 /> : intent === "continue" ? <ListTodo /> : <PencilLine />} aria-pressed={activeAgentIntentCommand(objective) === intent} key={intent} onClick={() => applyIntent(intent)}>{label}</Button>)}</div>{seed.path ? <small className="agent-command-hint">Editor context: {seed.path}</small> : null}{seed.issueIds?.length ? <div className="agent-issue-seed"><ShieldCheck /> Revision is linked to {seed.issueIds.length} Review Issue{seed.issueIds.length === 1 ? "" : "s"}.</div> : null}</div> : null}
    {busy ? <div className="agent-progress agent-task-progress" role="status" aria-live="polite"><LoaderCircle className="spin" /><strong>{stage === "planning" ? "Planning Agent task" : stage === "generating" ? "Executing approved plan in parallel" : stage === "rereviewing" ? "Checking whether the issue is resolved" : "Finishing the reviewed changes"}</strong><span>{stage === "planning" ? "Reading source context and asking Agent for a reviewed file plan. No files are changed yet." : stage === "generating" ? "Planned files run in parallel bounded model calls, then every hunk still requires review before applying." : "Files remain unchanged until their hunks are accepted."}</span>{stage === "generating" && run?.steps?.length ? <ol>{run.steps.map((step) => <li className={`is-${step.status}`} key={step.id}><span>{step.status === "completed" ? <CheckCircle2 /> : step.status === "running" ? <LoaderCircle className="spin" /> : step.status === "failed" ? <AlertTriangle /> : null}</span><strong>{step.label}</strong><small>{step.status}</small></li>)}</ol> : null}</div> : null}
    {stage === "plan" && plan?.sectionContracts?.length ? <div className="agent-contract-preview"><h3>Section contracts</h3>{plan.sectionContracts.map((contract) => <article key={contract.path}><strong>{contract.path}</strong><span>{contract.purpose}</span><small>{contract.requiredClaimIds.length} required claims · {contract.allowedEvidenceIds.length} allowed evidence{contract.openQuestions.length ? ` · ${contract.openQuestions.length} open questions` : ""}</small></article>)}</div> : null}
    {stage === "plan" && plan ? <div className="agent-plan"><div className="agent-plan__objective"><small>{plan.intent ?? plan.request.intent ?? "revise"} plan</small><strong>{plan.request.objective}</strong></div><section><h3>Steps</h3><ol>{plan.steps.map((step, index) => <li key={index}>{step}</li>)}</ol></section>{plan.sectionBudget?.length ? <section><h3>Section budget</h3><ul>{plan.sectionBudget.map((item, index) => <li key={index}><strong>{item.section}</strong>{item.targetPages ? ` · ${item.targetPages} pages` : ""} — {item.purpose}</li>)}</ul></section> : null}{plan.venueChecks?.length ? <section><h3>Venue compliance</h3><ul>{plan.venueChecks.map((item, index) => <li key={index}><strong>{item.status.replace("-", " ")}: {item.requirement}</strong>{item.action ? ` — ${item.action}` : ""}</li>)}</ul></section> : null}<section><h3>Affected files</h3>{plan.affectedFiles.map((path) => <code key={path}>{path}</code>)}</section><section><h3>Validation</h3><ul>{plan.validation.map((item, index) => <li key={index}>{item}</li>)}</ul></section><section><h3>Risks</h3>{plan.risks.length ? <ul>{plan.risks.map((risk, index) => <li key={index}>{risk}</li>)}</ul> : <p>No special risks reported.</p>}</section></div> : null}
    {(stage === "diff" || stage === "accepted") && changeSet ? <div className="draft-diff">
      <nav>
        <header className="agent-review-overview"><strong>{changeSet.changes.length} file{changeSet.changes.length === 1 ? "" : "s"}</strong><span className="review-counts"><b className="is-pending">Pending {reviewCounts?.pending ?? 0}</b><b className="is-accepted">Accepted {reviewCounts?.accepted ?? 0}</b><b className="is-rejected">Rejected {reviewCounts?.rejected ?? 0}</b></span></header>
        {changeSet.changes.map((change, index) => { const counts = hunkCounts(change); const state = fileReviewState(change); return <button className={`${index === activeFile ? "is-active " : ""}is-${state}`} aria-label={`${change.path}: ${counts.pending} pending, ${counts.accepted} accepted, ${counts.rejected} rejected`} key={change.path} onClick={() => setActiveFile(index)}><FileText /><span>{change.path}</span><small><b>P {counts.pending}</b><b>A {counts.accepted}</b><b>R {counts.rejected}</b></small><ChevronRight /></button>; })}
      </nav>
      <div className="draft-diff__file">
        <header className="agent-file-review-header"><span>{selectedChange?.path}</span><div className="agent-file-review-header__controls">{selectedCounts ? <small className="review-counts"><b className="is-pending">Pending {selectedCounts.pending}/{selectedCounts.total}</b><b className="is-accepted">Accepted {selectedCounts.accepted}/{selectedCounts.total}</b><b className="is-rejected">Rejected {selectedCounts.rejected}/{selectedCounts.total}</b></small> : null}{stage === "diff" ? <><Button size="small" variant="ghost" disabled={deciding || !selectedPendingHunkIds.length} onClick={() => void decideHunks(selectedPendingHunkIds, "rejected")}>Reject pending file hunks</Button><Button size="small" variant="secondary" disabled={deciding || !selectedPendingHunkIds.length || selectedPendingHasBlocking} title={selectedPendingHasBlocking ? "Edit or reject blocking hunks first" : undefined} onClick={() => void decideHunks(selectedPendingHunkIds, "accepted")}>Accept pending file hunks</Button></> : null}</div></header>
        {selectedChange ? <EditableChangeReview change={selectedChange} busy={deciding} readOnly={stage === "accepted"} showHunkToolbar={false} onEditHunk={editHunk} onDecide={(ids, status) => void decideHunks(ids, status)} {...(onNavigate ? { onNavigate } : {})} /> : <div className="revision-diff">{parts.map((part, index) => <span key={index}>{part.value}</span>)}</div>}
      </div>
      {stage === "accepted" ? <div className={`agent-resolution agent-resolution--${resolution?.status ?? "accepted"}`}>{resolution?.status === "resolved" ? <Check /> : resolution?.status === "reopened" ? <AlertTriangle /> : <ShieldCheck />}<span><strong>{resolution ? resolution.status.replace("-", " ") : "Changes applied"}</strong>{resolution?.rereviewAssessment ?? (resolution ? "Compile the paper, then run targeted re-review for the linked issues." : "Compile the paper to validate the accepted changes.")}{resolution ? <small className="resolution-timeline">Review snapshot {resolution.reviewSnapshotIds?.length || 0} → Run → ChangeSet → {resolution.compileRecordId ? "Compile recorded" : "Compile pending"} → {resolution.status === "resolved" ? "Resolved" : "Re-review pending"}</small> : null}</span></div> : null}
    </div> : null}
    {run?.auditTrail?.length ? <details className="agent-audit"><summary>Audit trail · {run.auditTrail.length} events</summary>{run.auditTrail.map((event) => <div key={event.id}><span>{event.action.replaceAll("-", " ")}</span><p>{event.summary}</p><time>{new Date(event.createdAt).toLocaleString()}</time></div>)}</details> : null}
    {error ? <div className="form-error" role="alert">{error}</div> : null}
  </>;
  return <><section className="agent-embedded" aria-label="Agent workspace"><div className="agent-embedded__body">{content}</div><footer className="agent-embedded__footer">{footer}</footer></section><ChangeSetConflictDialog details={pendingConflict?.details ?? null} busy={deciding} onCancel={() => setPendingConflict(null)} onConfirm={() => void confirmOverwrite()} /></>;
}

function message(error: unknown) { return error instanceof Error ? error.message : "Agent task failed"; }
function isConflictDetails(value: unknown): value is ChangeSetConflictDetails { return Boolean(value && typeof value === "object" && Array.isArray((value as ChangeSetConflictDetails).conflicts) && (value as ChangeSetConflictDetails).conflicts.length); }
function cancelMessage(error: unknown, label: string) { return error instanceof DOMException && error.name === "AbortError" ? `${label} cancelled. No changes were created.` : message(error); }
function beginRequest(ref: React.MutableRefObject<AbortController | null>) { ref.current?.abort(); const controller = new AbortController(); ref.current = controller; return controller; }
function finishRequest(ref: React.MutableRefObject<AbortController | null>, controller: AbortController) { if (ref.current === controller) ref.current = null; }
