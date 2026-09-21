import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentRun, PaperProject, ReviewIssue, ReviewReport } from "@fastwrite/shared";
import { api } from "../../api/client";
import { Button, Checkbox, Dialog, Disclosure, Field, Icon, IconButton, Label, List, ListRow, NumberField, Select, Stepper, TextArea, TextField, icons, type StepStatus } from "../ui";
import type { CompileStateReport } from "./PdfPane";

type ManualIssue = Pick<ReviewIssue, "category" | "severity" | "title" | "rationale" | "impact" | "suggestion">;
const EMPTY_MANUAL: ManualIssue = { category: "soundness", severity: "major", title: "", rationale: "", impact: "", suggestion: "" };
type ReviewDialogWidth = "large" | "wide" | "fullscreen";

interface ReviewDialogProps {
  open: boolean;
  project: PaperProject;
  compileState: CompileStateReport;
  onRequestCompile: () => void;
  onClose: () => void;
  onNavigate: (path: string, line?: number) => void;
  onReviseLocally: (issue: ReviewIssue) => void;
  onReviseWithAgent: (issueIds: string[], objective: string) => void;
}

export function ReviewDialog({ open, project, compileState, onRequestCompile, onClose, onNavigate, onReviseLocally, onReviseWithAgent }: ReviewDialogProps) {
  const [report, setReport] = useState<ReviewReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [severity, setSeverity] = useState("all");
  const [category, setCategory] = useState("all");
  const [file, setFile] = useState("all");
  const [status, setStatus] = useState("active");
  const [selected, setSelected] = useState<string[]>([]);
  const [width, setWidth] = useState<ReviewDialogWidth>("wide");
  const [manualOpen, setManualOpen] = useState(false);
  const [manual, setManual] = useState<ManualIssue>(EMPTY_MANUAL);
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const runAbortRef = useRef<AbortController | null>(null);

  const refresh = async (signal?: AbortSignal) => { const reports = await api.reviews.list(project.id, signal); setReport(reports[0] ?? null); };
  useEffect(() => {
    setSeverity(localStorage.getItem(`fastwrite.review.${project.id}.severity`) ?? "all");
    setCategory(localStorage.getItem(`fastwrite.review.${project.id}.category`) ?? "all");
    setFile(localStorage.getItem(`fastwrite.review.${project.id}.file`) ?? "all");
    setStatus(localStorage.getItem(`fastwrite.review.${project.id}.status`) ?? "active");
    const savedWidth = localStorage.getItem(`fastwrite.review.${project.id}.width`);
    setWidth(savedWidth === "large" || savedWidth === "wide" || savedWidth === "fullscreen" ? savedWidth : "wide");
  }, [project.id]);
  useEffect(() => {
    localStorage.setItem(`fastwrite.review.${project.id}.severity`, severity);
    localStorage.setItem(`fastwrite.review.${project.id}.category`, category);
    localStorage.setItem(`fastwrite.review.${project.id}.file`, file);
    localStorage.setItem(`fastwrite.review.${project.id}.status`, status);
    localStorage.setItem(`fastwrite.review.${project.id}.width`, width);
  }, [project.id, severity, category, file, status, width]);
  useEffect(() => { if (!open) return; const controller = new AbortController(); void refresh(controller.signal).catch(() => undefined); return () => { controller.abort(); runAbortRef.current?.abort(); }; }, [open, project.id]);
  useEffect(() => {
    if (!open || !loading) return;
    const controller = new AbortController();
    const poll = () => void api.agentTasks.runs(project.id, controller.signal).then((runs) => setActiveRun(runs.find((run) => run.type === "review" && run.status === "running") ?? null)).catch(() => undefined);
    poll();
    const interval = window.setInterval(poll, 600);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, [loading, open, project.id]);

  const compiledCurrentVersion = compileState.state === "success" && compileState.compiledVersion === project.version;
  const compiling = compileState.state === "loading" || compileState.state === "compiling";
  const run = async (sourceOnly: boolean) => { const controller = new AbortController(); runAbortRef.current = controller; setLoading(true); setActiveRun(null); setError(""); try { const response = await api.reviews.run(project.id, sourceOnly, controller.signal); setReport(response.report); setActiveRun(response.run); setSelected([]); } catch (failure) { setError(failure instanceof DOMException && failure.name === "AbortError" ? "Review cancelled. No report was created." : message(failure)); } finally { if (runAbortRef.current === controller) runAbortRef.current = null; setLoading(false); } };
  const updateIssue = async (issueId: string, updates: Parameters<typeof api.reviews.updateIssue>[2]) => { try { const updated = await api.reviews.updateIssue(project.id, issueId, updates); setReport((current) => current ? { ...current, issues: current.issues.map((issue) => issue.id === issueId ? updated : issue) } : current); } catch (failure) { setError(message(failure)); } };
  const createManual = async () => { try { const created = await api.reviews.createIssue(project.id, { ...manual, ...(report ? { reportId: report.id } : {}) }); setReport((current) => current ? { ...current, issues: [...current.issues, created] } : current); setManual(EMPTY_MANUAL); setManualOpen(false); } catch (failure) { setError(message(failure)); } };
  const mergeSelected = async () => { if (selected.length < 2) return; try { await api.reviews.mergeIssues(project.id, selected[0]!, selected.slice(1), "Merged as duplicate during issue triage"); await refresh(); setSelected([]); } catch (failure) { setError(message(failure)); } };
  /*
   * Evidence may carry no path at all (a PDF-page citation). Those never made a
   * usable option — they rendered as a blank row — and `Select` needs a real
   * string, so they are dropped rather than stringified into "undefined".
   */
  const issueFiles = [...new Set(report?.issues.flatMap((issue) => issue.evidence.map((evidence) => evidence.path)) ?? [])].filter((path): path is string => Boolean(path)).sort();
  const visibleIssues = report?.issues.filter((issue) =>
    (severity === "all" || issue.severity === severity) &&
    (category === "all" || issue.category === category) &&
    (file === "all" || issue.evidence.some((evidence) => evidence.path === file)) &&
    (status === "all" || (status === "active" ? issue.status !== "dismissed" && issue.status !== "resolved" : issue.status === status))
  ).sort((a, b) => a.priority - b.priority) ?? [];
  const incompleteCoverage = report ? !(report.coverage?.eligibleForClean ?? (report.passes?.every((pass) => pass.status === "completed") ?? false)) : false;

  return <Dialog open={open} width={width} className="review-dialog" resizable={width === "wide"} title="Paper Review" description={`${project.skill.name} · saved ${snapshotTime(project.updatedAt)}`} headerActions={<div className="dialog-size-controls" aria-label="Review window size"><IconButton label="Compact review window" icon={<Icon name={icons.screenNormal} />} aria-pressed={width === "large"} onClick={() => setWidth("large")} /><IconButton label="Wide review window" icon={<Icon name={icons.screenFull} />} aria-pressed={width === "wide"} onClick={() => setWidth("wide")} /><IconButton label="Fullscreen review window" icon={<Icon name={icons.windowMaximize} />} aria-pressed={width === "fullscreen"} onClick={() => setWidth("fullscreen")} /></div>} onClose={() => { if (!loading) onClose(); }} footer={<><Button variant="ghost" disabled={loading} onClick={onClose}>Close</Button>{!compiledCurrentVersion && !loading ? <Button variant="secondary" loading={compiling} disabled={compiling} onClick={onRequestCompile}>{compiling ? "Compiling" : "Compile current version"}</Button> : null}{loading ? <Button variant="secondary" onClick={() => runAbortRef.current?.abort()}>Cancel review</Button> : <Button variant="primary" icon={<Icon name={icons.verified} />} onClick={() => void run(!compiledCurrentVersion)}>{report ? compiledCurrentVersion ? "Run new review" : "Run source-only review" : compiledCurrentVersion ? "Review paper" : "Continue source-only"}</Button>}</>}>
    <div className="review-context" aria-label="Review input snapshot"><span>Saved snapshot <strong>{snapshotTime(project.updatedAt)}</strong></span><span>Compile <strong>{compiledCurrentVersion ? "current · success" : compiling ? "running" : compileState.state === "error" ? "current · failed" : "not current"}</strong></span></div>
    {loading ? <div className="agent-progress review-run-progress"><Icon name={icons.loading} spin /><strong>Reviewing the frozen paper snapshot</strong><span>Collecting section evidence, applying the Writing Skill, and deduplicating issues.</span>{activeRun?.steps?.length ? <Stepper variant="grid" label="Review steps" steps={activeRun.steps.map((step) => ({ id: step.id, label: step.label, status: reviewStepStatus(step.status), icon: reviewStepIcon(step.status), detail: step.status.replace("-", " ") }))} /> : null}</div> : report ? <div className="review-report">
      <header className="review-summary"><div><span className={`recommendation recommendation--${report.recommendation}`}>{report.recommendation.replace("-", " ")}</span><strong>{report.overallAssessment}</strong></div><small>{report.issues.length} issues · saved report</small></header>
      {incompleteCoverage ? <div className="form-error" role="status"><Icon name={icons.warning} /> Review coverage is incomplete. Failed or skipped passes must be inspected before treating this report as clean.</div> : null}
      {report.passes?.length ? <section className="review-pass-coverage" aria-label="Review pass coverage"><h3>Pass coverage</h3><div>{report.passes.map((pass) => <Disclosure className={`review-pass review-pass--${pass.status}`} key={pass.id} summary={<><strong>{pass.id}</strong><small>{pass.status}{pass.issues.length ? ` · ${pass.issues.length} issues` : ""}</small></>}><dl><div><dt>Provider</dt><dd>{pass.provider ?? "unavailable"}{pass.model ? ` / ${pass.model}` : ""}</dd></div><div><dt>Input</dt><dd>{pass.inputBoundary ?? "not recorded"}</dd></div>{pass.error || pass.unavailableReason ? <div><dt>Reason</dt><dd>{pass.error ?? pass.unavailableReason}</dd></div> : null}</dl></Disclosure>)}</div></section> : null}
      <div className="review-columns"><section><h3><Icon name={icons.passFilled} /> Strengths</h3>{report.strengths.map((item, index) => <p key={index}>{item}</p>)}</section><section><h3><Icon name={icons.warning} /> Weaknesses</h3>{report.weaknesses.map((item, index) => <p key={index}>{item}</p>)}</section></div>
      <section className="review-issues">
        <div className="review-issues__toolbar"><h3>Actionable issues</h3><Button size="small" variant="ghost" icon={<Icon name={icons.add} />} onClick={() => setManualOpen((value) => !value)}>Add</Button><Button size="small" variant="ghost" icon={<Icon name={icons.gitMerge} />} disabled={selected.length < 2} onClick={() => void mergeSelected()}>Merge {selected.length || ""}</Button><Button size="small" variant="secondary" icon={<Icon name={icons.verified} />} disabled={!selected.length} onClick={() => { const selectedIssues = report.issues.filter((issue) => selected.includes(issue.id)); onClose(); onReviseWithAgent(selected, `Resolve ${selected.length} selected review issue${selected.length === 1 ? "" : "s"}: ${selectedIssues.map((issue) => issue.title).join("; ")}`); }}>Fix with Agent {selected.length || ""}</Button><Field label="Severity"><Select value={severity} onChange={setSeverity} options={[{ value: "all", label: "All" }, { value: "blocking", label: "Blocking" }, { value: "major", label: "Major" }, { value: "minor", label: "Minor" }, { value: "suggestion", label: "Suggestion" }]} /></Field><Field label="Category"><Select value={category} onChange={setCategory} options={[{ value: "all", label: "All" }, ...["novelty", "soundness", "technical-depth", "threat-model", "evaluation", "reproducibility", "related-work", "clarity", "ethics"].map((value) => ({ value, label: value }))]} /></Field><Field label="File"><Select value={file} onChange={setFile} options={[{ value: "all", label: "All" }, ...issueFiles.map((path) => ({ value: path, label: path }))]} /></Field><Field label="Status"><Select value={status} onChange={setStatus} options={[{ value: "active", label: "Active" }, { value: "all", label: "All" }, { value: "open", label: "Open" }, { value: "planned", label: "Planned" }, { value: "in_revision", label: "In revision" }, { value: "resolved", label: "Resolved" }, { value: "dismissed", label: "Dismissed" }]} /></Field></div>
        {manualOpen ? <div className="manual-issue"><div className="form-grid"><Field label="Category"><Select value={manual.category} onChange={(next) => setManual((current) => ({ ...current, category: next as ManualIssue["category"] }))} options={["novelty", "soundness", "technical-depth", "threat-model", "evaluation", "reproducibility", "related-work", "clarity", "ethics"].map((value) => ({ value, label: value }))} /></Field><Field label="Severity"><Select value={manual.severity} onChange={(next) => setManual((current) => ({ ...current, severity: next as ManualIssue["severity"] }))} options={["blocking", "major", "minor", "suggestion"].map((value) => ({ value, label: value }))} /></Field></div><Field label="Title"><TextField value={manual.title} onChange={(next) => setManual((current) => ({ ...current, title: next }))} /></Field><Field label="Rationale"><TextArea value={manual.rationale} onChange={(next) => setManual((current) => ({ ...current, rationale: next }))} /></Field><div className="form-grid"><Field label="Impact"><TextArea value={manual.impact} onChange={(next) => setManual((current) => ({ ...current, impact: next }))} /></Field><Field label="Suggested direction"><TextArea value={manual.suggestion} onChange={(next) => setManual((current) => ({ ...current, suggestion: next }))} /></Field></div><div className="manual-issue__actions"><Button size="small" variant="ghost" onClick={() => setManualOpen(false)}>Cancel</Button><Button size="small" variant="primary" disabled={!manual.title.trim() || !manual.rationale.trim()} onClick={() => void createManual()}>Add issue</Button></div></div> : null}
        {visibleIssues.map((issue) => {
          const canReviseLocally = issue.evidence.some((evidence) => !evidence.inferred && Boolean(evidence.excerpt.trim() || evidence.line));
          const inactive = issue.status === "dismissed" || issue.status === "resolved";
          return <article className={`review-issue review-issue--${issue.severity}`} key={issue.id}>
            <header>
              <Checkbox aria-label={`Select ${issue.title}`} checked={selected.includes(issue.id)} onChange={(checked) => setSelected((current) => checked ? [...current, issue.id] : current.filter((id) => id !== issue.id))} />
              <span>{issue.severity}</span><small>{issue.category.replace("-", " ")}</small><strong>{issue.title}</strong>
              <Label className="issue-priority">P <NumberField min={0} max={10000} defaultValue={issue.priority} onCommit={(value) => void updateIssue(issue.id, { priority: value ?? 0, reason: "Priority adjusted during triage" })} /></Label>
              {canReviseLocally ? <Button variant="ghost" className="review-revise" disabled={inactive} onClick={() => { void updateIssue(issue.id, { status: "in_revision" }); onReviseLocally(issue); }}>Revise locally</Button> : null}
              <Button variant="ghost" className="review-revise" disabled={inactive} onClick={() => { onClose(); onReviseWithAgent([issue.id], `Resolve review issue: ${issue.title}. ${issue.suggestion}`); }}>Fix with Agent</Button>
              <Select aria-label={`Status for ${issue.title}`} value={issue.status} onChange={(next) => void updateIssue(issue.id, { status: next as typeof issue.status })} options={[{ value: "open", label: "Open" }, { value: "planned", label: "Planned" }, { value: "in_revision", label: "In revision" }, { value: "needs_review", label: "Needs review" }, { value: "resolved", label: "Resolved" }, { value: "dismissed", label: "Dismissed" }]} />
            </header>
            <p>{issue.rationale}</p><dl><div><dt>Impact</dt><dd>{issue.impact}</dd></div><div><dt>Direction</dt><dd>{issue.suggestion}</dd></div></dl>
            {issue.evidence.map((evidence, index) => <Button variant="ghost" className="review-evidence" key={index} disabled={!evidence.path} onClick={() => { if (evidence.path) onNavigate(evidence.path, evidence.line); onClose(); }}><Icon name={icons.linkExternal} /><span><strong>{evidence.path ?? `PDF page ${evidence.page ?? "?"}`}{evidence.line ? `:${evidence.line}` : ""}</strong><q>{evidence.excerpt || "Inferred from missing manuscript evidence"}</q></span>{evidence.inferred ? <small>inference</small> : null}</Button>)}
            {issue.history?.length ? <Disclosure className="issue-history" summary={`${issue.history.length} history events`}>{issue.history.map((entry) => <p key={entry.id}><strong>{entry.action}</strong>{entry.reason}<time>{new Date(entry.createdAt).toLocaleString()}</time></p>)}</Disclosure> : null}
          </article>;
        })}
      </section>
      {report.nextSteps.length ? <section className="review-next"><h3>Suggested next steps</h3><List ordered label="Suggested next steps">{report.nextSteps.map((step, index) => <ListRow key={index}>{step}</ListRow>)}</List></section> : null}
    </div> : <div className="review-empty"><Icon name={icons.verified} /><h3>Evidence-first paper review</h3><p>FastWrite freezes the paper saved at {snapshotTime(project.updatedAt)}, reads the confirmed {project.skill.name} Skill, then produces a structured report. {compiledCurrentVersion ? "The current draft has a successful Local LaTeX compile." : "Compile first, or explicitly continue with a source-only review."} Review never edits paper files.</p></div>}
    {error ? <div className="form-error" role="alert">{error}</div> : null}
  </Dialog>;
}

function message(error: unknown) { return error instanceof Error ? error.message : "Review request failed"; }
/*
 * The run's own vocabulary ("completed"/"running"/"failed") is translated here;
 * Stepper only knows complete/current/error/pending.
 */
function reviewStepStatus(status: string): StepStatus {
  return status === "completed" ? "complete" : status === "failed" ? "error" : status === "running" ? "current" : "pending";
}
function reviewStepIcon(status: string): ReactNode {
  return status === "completed" ? <Icon name={icons.passFilled} /> : status === "failed" ? <Icon name={icons.warning} /> : status === "running" ? <Icon name={icons.loading} spin /> : null;
}
function snapshotTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown time" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
