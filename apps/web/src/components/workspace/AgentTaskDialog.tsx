import type { ReferenceSelection, AgentTaskRequest } from "@fastwrite/shared";
import { ReferenceSnapshotSummary } from "./ReferenceTags";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentRun, AgentTaskIntent, AgentTaskPlan, AgentTaskSkillDescriptor, ChangeSet, ChangeSetConflictDetails, ChangeSetDecisionRequest, IssueResolution, PaperProject } from "@fastwrite/shared";
import { api, ApiClientError } from "../../api/client";
import { diffWords } from "../../lib/wordDiff";
import { Button, Disclosure, Field, Icon, List, ListRow, MultiSelect, Stepper, TextArea, icons, type StepStatus } from "../ui";
import type { CompileStateReport } from "./PdfPane";
import { EditableChangeReview } from "./EditableChangeReview";
import { ChangeSetConflictDialog } from "./ChangeSetConflictDialog";
import { activeAgentChangeSetStage, activeAgentIntentCommand, AGENT_INTENT_COMMANDS, applyAgentIntentCommand, recoverableAgentPlan, restoredAgentReviewStage } from "./agentCommands";
import { responseLanguage } from "../../lib/responseLanguage";
import { changeSetHunkCounts, fileReviewState, hunkCounts, pendingDecisions } from "./agentReview";

type Stage = "input" | "planning" | "plan" | "generating" | "diff" | "applying" | "accepted" | "rereviewing";
type PendingConflict = { details: ChangeSetConflictDetails; request: ChangeSetDecisionRequest; finishAfter: boolean };
export interface AgentTaskSeed { planId?: string; issueIds?: string[]; objective?: string; scope?: AgentTaskRequest["scope"]; path?: string; harness?: "codex" | "claude" }

export function AgentTaskWorkspace({ open, project, seed, references = [], compileState, onRequestCompile, onClose, onAccepted, onNavigate }: { open: boolean; project: PaperProject; seed: AgentTaskSeed; references?: ReferenceSelection[]; compileState: CompileStateReport; onRequestCompile: () => void; onClose: () => void; onAccepted: (path: string) => void | Promise<void>; onNavigate?: (path: string, line?: number) => void }) {
  const [stage, setStage] = useState<Stage>("input");
  const [objective, setObjective] = useState("");
  const [plan, setPlan] = useState<AgentTaskPlan | null>(null);
  const [run, setRun] = useState<AgentRun | null>(null);
  const [changeSet, setChangeSet] = useState<ChangeSet | null>(null);
  const [resolution, setResolution] = useState<IssueResolution | null>(null);
  const [activeFile, setActiveFile] = useState(0);
  const [error, setError] = useState("");
  const [taskSkills, setTaskSkills] = useState<AgentTaskSkillDescriptor[]>([]);
  const [taskSkillIds, setTaskSkillIds] = useState<string[]>([]);
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
  useEffect(() => { if (open) void api.agentSkills.list().then(setTaskSkills).catch(() => setTaskSkills([])); }, [open]);
  useEffect(() => () => requestRef.current?.abort(), []);
  useEffect(() => {
    if (!open || stage !== "input" || (seed.planId && seed.planId === dismissedPlanId) || (!seed.planId && (seed.objective || seed.issueIds?.length))) return;
    const controller = new AbortController();
    void Promise.all([api.agentTasks.list(project.id, controller.signal), api.agentTasks.resolutions(project.id, controller.signal), api.agentTasks.runs(project.id, controller.signal)]).then(async ([plans, resolutions, runs]) => {
      if (controller.signal.aborted) return;
      const recoverable = recoverableAgentPlan(seed.planId ? plans.filter(candidate => candidate.id === seed.planId) : plans, dismissedPlanId);
      if (!recoverable) { if(seed.planId)setError("此计划已无法审核，请刷新技能任务以查看状态。");return; }
      const recoveredRun = runs.find((candidate) => candidate.id === recoverable.agentRunId) ?? null;
      const recoveredResolution = resolutions.find((candidate) => candidate.agentRunId === recoverable.agentRunId) ?? null;
      if (recoverable.changeSetId) {
        const restoredChangeSet = await api.revisions.get(project.id, recoverable.changeSetId, controller.signal);
        if (controller.signal.aborted) return;
        const restoredStage = restoredAgentReviewStage(restoredChangeSet);
        if (!restoredStage) { setDismissedPlanId(recoverable.id); return; }
        setChangeSet(restoredChangeSet);
        setStage(restoredStage);
      } else setStage("plan");
      setPlan(recoverable);
      setRun(recoveredRun);
      setObjective(recoverable.request.objective);
      setResolution(recoveredResolution);
    }).catch(error => { if(!controller.signal.aborted&&seed.planId)setError(error instanceof Error?error.message:String(error)); });
    return () => controller.abort();
  }, [dismissedPlanId, open, project.id, seed.issueIds, seed.objective, seed.planId, stage]);
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

  const createPlan = async () => { const controller = beginRequest(requestRef); setStage("planning"); setError(""); try { const result = await api.agentTasks.plan(project.id, { objective, references, scope: seed.scope ?? { type: "project" }, responseLanguage: responseLanguage(), ...(taskSkillIds.length ? { taskSkillIds } : {}), ...(seed.issueIds?.length ? { issueIds: seed.issueIds } : {}), ...(seed.harness ? { harness: seed.harness } : {}) }, controller.signal); setRun(result.run); setPlan(result.plan); setResolution(result.resolution ?? null); setStage("plan"); } catch (failure) { setError(cancelMessage(failure, "智能助手规划")); setStage("input"); } finally { finishRequest(requestRef, controller); } };
  const generate = async () => { if (!plan) return; const controller = beginRequest(requestRef); setStage("generating"); setError(""); try { const result = await api.agentTasks.confirm(project.id, plan.id, controller.signal); setRun(result.run); setPlan(result.plan); setChangeSet(result.changeSet); setResolution(result.resolution ?? resolution); setActiveFile(0); setStage("diff"); } catch (failure) { setError(cancelMessage(failure, "智能助手执行")); setStage("plan"); } finally { finishRequest(requestRef, controller); } };
  const reset = () => { setStage("input"); setPlan(null); setRun(null); setChangeSet(null); setResolution(null); setError(""); setPendingConflict(null); setActiveFile(0); };
  const startNewTask = () => { setDismissedPlanId(plan?.id ?? null); setObjective(""); reset(); };
  const refreshTaskState = async () => { const [resolutions, runs] = await Promise.all([api.agentTasks.resolutions(project.id), api.agentTasks.runs(project.id)]); const refreshedResolution = resolutions.find((item) => item.id === resolution?.id || item.agentRunId === plan?.agentRunId) ?? resolution; if (refreshedResolution) setResolution(refreshedResolution); setRun(runs.find((item) => item.id === plan?.agentRunId) ?? run); return refreshedResolution; };
  const applyFinishedReview = async (finished: ChangeSet) => {
    setChangeSet(finished);
    await refreshTaskState();
    if (finished.status === "accepted") {
      await onAccepted(finished.changes.find((change) => change.hunks?.some((hunk) => hunk.status === "accepted"))?.path ?? finished.changes[0]!.path);
      setStage("accepted");
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
  const rollback = async () => { if (!changeSet) return; setStage("applying"); setError(""); try { await api.revisions.rollback(project.id, changeSet.id); await onAccepted(changeSet.changes[0]!.path); setDismissedPlanId(plan?.id ?? null); reset(); onClose(); } catch (failure) { setError(message(failure)); setStage("accepted"); } };
  const rereview = async () => { if (!resolution) return; const controller = beginRequest(requestRef); setStage("rereviewing"); setError(""); try { setResolution(await api.agentTasks.rereview(project.id, resolution.id, controller.signal)); setStage("accepted"); } catch (failure) { setError(cancelMessage(failure, "定向复审")); setStage("accepted"); } finally { finishRequest(requestRef, controller); } };
  const reopen = async () => { if (!resolution) return; setError(""); try { setResolution(await api.agentTasks.reopen(project.id, resolution.id)); } catch (failure) { setError(message(failure)); } };
  const discardPlan = async () => {
    try {
      if (plan?.status === "proposed") await api.agentTasks.cancel(project.id, plan.id);
      setDismissedPlanId(plan?.id ?? null);
      reset();
    } catch (failure) { setError(message(failure)); }
  };
  const applyIntent = (intent: AgentTaskIntent) => {
    setObjective((current) => applyAgentIntentCommand(current, intent));
    window.requestAnimationFrame(() => objectiveRef.current?.focus());
  };

  const footer = (
    busy ? <Button variant="secondary" onClick={() => requestRef.current?.abort()}>取消任务</Button> :
    stage === "input" ? <Button variant="primary" disabled={!objective.trim()} onClick={() => void createPlan()}>创建计划</Button> :
    stage === "plan" ? <><Button variant="ghost" onClick={() => void discardPlan()}>放弃计划</Button><Button variant="primary" onClick={() => void generate()}>确认计划</Button></> :
    stage === "diff" ? <><Button variant="ghost" disabled={deciding} onClick={onClose}>退出审核</Button>{reviewCounts?.pending ? <><Button variant="ghost" icon={<Icon name={icons.close} />} disabled={deciding} onClick={() => void decidePending("rejected")}>拒绝待审核更改并完成</Button><Button variant="secondary" icon={<Icon name={icons.check} />} disabled={deciding} title="接受全部待审核更改，包括存在问题的修改块" onClick={() => void decidePending("accepted")}>接受全部并完成</Button></> : <Button variant="primary" icon={<Icon name={icons.passFilled} />} disabled={deciding} title="完成已接受和已拒绝修改块的审核" onClick={() => void finishReview()}>完成审核</Button>}</> :
    stage === "accepted" ? <><Button variant="ghost" onClick={startNewTask}>新任务</Button><Button variant="secondary" icon={<Icon name={icons.discard} />} onClick={() => void rollback()}>回滚</Button>{resolution?.status === "resolved" ? <Button variant="secondary" onClick={() => void reopen()}>重新打开问题</Button> : null}{!compiledCurrentVersion ? <Button variant="secondary" loading={compiling} disabled={compiling} onClick={onRequestCompile}>{compiling ? "正在编译" : "编译当前版本"}</Button> : null}{resolution?.status === "needs-review" || resolution?.status === "reopened" ? <Button variant="primary" icon={<Icon name={icons.verified} />} disabled={!compiledCurrentVersion} onClick={() => void rereview()}>定向复审</Button> : null}</> : null
  );
  const content = <>
    <ReferenceSnapshotSummary context={plan?.styleReferenceContext} />
    {stage === "input" ? <div className="agent-task-form"><Field label="希望智能助手做什么？"><TextArea name="agent-task-objective" ref={objectiveRef} value={objective} onChange={setObjective} placeholder="生成初稿、续写待完成章节，或统一修改引言与评估章节…" autoFocus /></Field><div className="agent-command-buttons" aria-label="智能助手任务指令">{AGENT_INTENT_COMMANDS.map(({ intent, label }) => <Button type="button" size="small" variant="secondary" icon={intent === "draft" ? <Icon name={icons.newFile} /> : intent === "continue" ? <Icon name={icons.checklist} /> : <Icon name={icons.edit} />} aria-pressed={activeAgentIntentCommand(objective) === intent} key={intent} onClick={() => applyIntent(intent)}>{label}</Button>)}</div>{taskSkills.length ? <Field label="任务技能"><MultiSelect label="任务技能" value={taskSkillIds} onChange={setTaskSkillIds} options={taskSkills.filter((skill) => !skill.supportedIntents.length || skill.supportedIntents.includes(activeAgentIntentCommand(objective) ?? "revise")).map((skill) => ({ value: skill.id, label: `${skill.id} · ${skill.description}` }))} /></Field> : null}{seed.path ? <small className="agent-command-hint">编辑器上下文： {seed.path}</small> : null}{seed.issueIds?.length ? <div className="agent-issue-seed"><Icon name={icons.verified} /> 修改关联至 {seed.issueIds.length} 审稿问题.</div> : null}</div> : null}
    {busy ? <div className="agent-progress agent-task-progress" role="status" aria-live="polite"><Icon name={icons.loading} spin /><strong>{stage === "planning" ? "正在规划智能助手任务" : stage === "generating" ? "正在并行执行已确认的计划" : stage === "rereviewing" ? "正在检查问题是否已解决" : "正在完成已审核的更改"}</strong><span>{stage === "planning" ? "正在读取源文件上下文并生成可审核的文件计划，尚未修改文件。" : stage === "generating" ? "按计划并行生成各文件，应用前仍需审核每个修改块。" : "只有接受修改块后，才会更改文件。"}</span>{stage === "generating" && run?.steps?.length ? <Stepper variant="list" label="智能助手任务步骤" steps={run.steps.map((step) => ({ id: step.id, label: step.label, status: agentStepStatus(step.status), icon: agentStepIcon(step.status), detail: statusLabel(step.status) }))} /> : null}</div> : null}
    {stage === "plan" && plan?.sectionContracts?.length ? <div className="agent-contract-preview"><h3>章节约定</h3>{plan.sectionContracts.map((contract) => <article key={contract.path}><strong>{contract.path}</strong><span>{contract.purpose}</span><small>{contract.requiredClaimIds.length} 项必需论断 · {contract.allowedEvidenceIds.length} 项可用证据{contract.openQuestions.length ? ` · ${contract.openQuestions.length} 个待解问题` : ""}</small></article>)}</div> : null}
    {stage === "plan" && plan ? <div className="agent-plan"><div className="agent-plan__objective"><small>{statusLabel(plan.intent ?? plan.request.intent ?? "revise")}计划</small><strong>{plan.request.objective}</strong></div><section><h3>步骤</h3><List ordered label="计划步骤">{plan.steps.map((step, index) => <ListRow key={index}>{step}</ListRow>)}</List></section>{plan.sectionBudget?.length ? <section><h3>章节篇幅</h3><List label="章节篇幅">{plan.sectionBudget.map((item, index) => <ListRow key={index}><strong>{item.section}</strong>{item.targetPages ? ` · ${item.targetPages} 页` : ""} — {item.purpose}</ListRow>)}</List></section> : null}{plan.venueChecks?.length ? <section><h3>投稿规则检查</h3><List label="投稿规则检查">{plan.venueChecks.map((item, index) => <ListRow key={index}><strong>{statusLabel(item.status)}: {item.requirement}</strong>{item.action ? ` — ${item.action}` : ""}</ListRow>)}</List></section> : null}<section><h3>涉及文件</h3>{plan.affectedFiles.map((path) => <code key={path}>{path}</code>)}</section><section><h3>验证</h3><List label="验证">{plan.validation.map((item, index) => <ListRow key={index}>{item}</ListRow>)}</List></section><section><h3>风险</h3>{plan.risks.length ? <List label="风险">{plan.risks.map((risk, index) => <ListRow key={index}>{risk}</ListRow>)}</List> : <p>未发现特殊风险。</p>}</section></div> : null}
    {(stage === "diff" || stage === "accepted") && changeSet ? <div className="draft-diff">
      <nav>
        <header className="agent-review-overview"><strong>{changeSet.changes.length} 个文件</strong><span className="review-counts"><b className="is-pending">待处理 {reviewCounts?.pending ?? 0}</b><b className="is-accepted">已接受 {reviewCounts?.accepted ?? 0}</b><b className="is-rejected">已拒绝 {reviewCounts?.rejected ?? 0}</b></span></header>
        {changeSet.changes.map((change, index) => { const counts = hunkCounts(change); const state = fileReviewState(change); return <Button variant="ghost" className={`${index === activeFile ? "is-active " : ""}is-${state}`} aria-label={`${change.path}: ${counts.pending} 项待审核，${counts.accepted} 项已接受，${counts.rejected} 项已拒绝`} key={change.path} onClick={() => setActiveFile(index)}><Icon name={icons.fileText} /><span>{change.path}</span><small><b>待 {counts.pending}</b><b>已接受 {counts.accepted}</b><b>已拒绝 {counts.rejected}</b></small><Icon name={icons.chevronRight} /></Button>; })}
      </nav>
      <div className="draft-diff__file">
        <header className="agent-file-review-header"><span>{selectedChange?.path}</span><div className="agent-file-review-header__controls">{selectedCounts ? <small className="review-counts"><b className="is-pending">待处理 {selectedCounts.pending}/{selectedCounts.total}</b><b className="is-accepted">已接受 {selectedCounts.accepted}/{selectedCounts.total}</b><b className="is-rejected">已拒绝 {selectedCounts.rejected}/{selectedCounts.total}</b></small> : null}{stage === "diff" ? <><Button size="small" variant="ghost" disabled={deciding || !selectedPendingHunkIds.length} onClick={() => void decideHunks(selectedPendingHunkIds, "rejected")}>拒绝此文件的待审核修改块</Button><Button size="small" variant="secondary" disabled={deciding || !selectedPendingHunkIds.length || selectedPendingHasBlocking} title={selectedPendingHasBlocking ? "请先编辑或拒绝阻塞修改块" : undefined} onClick={() => void decideHunks(selectedPendingHunkIds, "accepted")}>接受此文件的待审核修改块</Button></> : null}</div></header>
        {selectedChange ? <EditableChangeReview change={selectedChange} busy={deciding} readOnly={stage === "accepted"} showHunkToolbar={false} onEditHunk={editHunk} onDecide={(ids, status) => void decideHunks(ids, status)} {...(onNavigate ? { onNavigate } : {})} /> : <div className="revision-diff">{parts.map((part, index) => <span key={index}>{part.value}</span>)}</div>}
      </div>
      {stage === "accepted" ? <div className={`agent-resolution agent-resolution--${resolution?.status ?? "accepted"}`}>{resolution?.status === "resolved" ? <Icon name={icons.check} /> : resolution?.status === "reopened" ? <Icon name={icons.warning} /> : <Icon name={icons.verified} />}<span><strong>{resolution ? statusLabel(resolution.status) : "已应用更改"}</strong>{resolution?.rereviewAssessment ?? (resolution ? "请编译论文，再对关联问题进行定向复审。" : "请编译论文，验证已接受的更改。")}{resolution ? <small className="resolution-timeline">审稿快照 {resolution.reviewSnapshotIds?.length || 0} → 运行 → 更改集 → {resolution.compileRecordId ? "已记录编译结果" : "待编译"} → {resolution.status === "resolved" ? "已解决" : "待复审"}</small> : null}</span></div> : null}
    </div> : null}
    {run?.auditTrail?.length ? <Disclosure className="agent-audit" summary={`审计记录 · ${run.auditTrail.length} 条记录`}>{run.auditTrail.map((event) => <div key={event.id}><span>{statusLabel(event.action)}</span><p>{event.summary}</p><time>{new Date(event.createdAt).toLocaleString("zh-CN")}</time></div>)}</Disclosure> : null}
    {error ? <div className="form-error" role="alert">{error}</div> : null}
  </>;
  return <><section className="agent-embedded" aria-label="智能助手工作区"><div className="agent-embedded__body">{content}</div><footer className="agent-embedded__footer">{footer}</footer></section><ChangeSetConflictDialog details={pendingConflict?.details ?? null} busy={deciding} onCancel={() => setPendingConflict(null)} onConfirm={() => void confirmOverwrite()} /></>;
}

function message(error: unknown) { return error instanceof Error ? error.message : "智能助手任务失败"; }
/*
 * The run's own words ("completed"/"running"/"failed") translate to Stepper's
 * four. The detail line keeps the raw status, as this dialog always showed it.
 */
function agentStepStatus(status: string): StepStatus {
  return status === "completed" ? "complete" : status === "failed" ? "error" : status === "running" ? "current" : "pending";
}
function agentStepIcon(status: string) {
  return status === "completed" ? <Icon name={icons.passFilled} /> : status === "running" ? <Icon name={icons.loading} spin /> : status === "failed" ? <Icon name={icons.warning} /> : null;
}
function isConflictDetails(value: unknown): value is ChangeSetConflictDetails { return Boolean(value && typeof value === "object" && Array.isArray((value as ChangeSetConflictDetails).conflicts) && (value as ChangeSetConflictDetails).conflicts.length); }
function cancelMessage(error: unknown, label: string) { return error instanceof DOMException && error.name === "AbortError" ? `${label} 已取消，未产生更改。` : message(error); }
function beginRequest(ref: React.MutableRefObject<AbortController | null>) { ref.current?.abort(); const controller = new AbortController(); ref.current = controller; return controller; }
function finishRequest(ref: React.MutableRefObject<AbortController | null>, controller: AbortController) { if (ref.current === controller) ref.current = null; }
import { statusLabel } from "../../lib/labels";
