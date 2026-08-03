import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, LoaderCircle, Maximize, Maximize2, Merge, Minimize2, Plus, ShieldCheck } from "lucide-react";
import type { AgentRun, PaperProject, ReviewIssue, ReviewReport } from "@fastwrite/shared";
import { api } from "../../api/client";
import { Button, IconButton } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
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
  const issueFiles = [...new Set(report?.issues.flatMap((issue) => issue.evidence.map((evidence) => evidence.path)) ?? [])].sort();
  const visibleIssues = report?.issues.filter((issue) =>
    (severity === "all" || issue.severity === severity) &&
    (category === "all" || issue.category === category) &&
    (file === "all" || issue.evidence.some((evidence) => evidence.path === file)) &&
    (status === "all" || (status === "active" ? issue.status !== "dismissed" && issue.status !== "resolved" : issue.status === status))
  ).sort((a, b) => a.priority - b.priority) ?? [];

  return <Dialog open={open} width={width} className="review-dialog" title="Paper Review" description={`${project.skill.name} · v${project.skill.version} · saved ${snapshotTime(project.updatedAt)}`} headerActions={<div className="dialog-size-controls" aria-label="Review window size"><IconButton label="Compact review window" icon={<Minimize2 />} aria-pressed={width === "large"} onClick={() => setWidth("large")} /><IconButton label="Wide review window" icon={<Maximize />} aria-pressed={width === "wide"} onClick={() => setWidth("wide")} /><IconButton label="Fullscreen review window" icon={<Maximize2 />} aria-pressed={width === "fullscreen"} onClick={() => setWidth("fullscreen")} /></div>} onClose={() => { if (!loading) onClose(); }} footer={<><Button variant="ghost" disabled={loading} onClick={onClose}>Close</Button>{!compiledCurrentVersion && !loading ? <Button variant="secondary" loading={compiling} disabled={compiling} onClick={onRequestCompile}>{compiling ? "Compiling" : "Compile current version"}</Button> : null}{loading ? <Button variant="secondary" onClick={() => runAbortRef.current?.abort()}>Cancel review</Button> : <Button variant="primary" icon={<ShieldCheck />} onClick={() => void run(!compiledCurrentVersion)}>{report ? compiledCurrentVersion ? "Run new review" : "Run source-only review" : compiledCurrentVersion ? "Review paper" : "Continue source-only"}</Button>}</>}>
    <div className="review-context" aria-label="Review input snapshot"><span>Saved snapshot <strong>{snapshotTime(project.updatedAt)}</strong></span><span>Skill <strong>v{project.skill.version}</strong></span><span>Compile <strong>{compiledCurrentVersion ? "current · success" : compiling ? "running" : compileState.state === "error" ? "current · failed" : "not current"}</strong></span></div>
    {loading ? <div className="agent-progress review-run-progress"><LoaderCircle className="spin" /><strong>Reviewing the frozen paper snapshot</strong><span>Collecting section evidence, applying the Writing Skill, and deduplicating issues.</span>{activeRun?.steps?.length ? <ol>{activeRun.steps.map((step) => <li key={step.id} className={`is-${step.status}`}><span>{step.status === "completed" ? <CheckCircle2 /> : step.status === "failed" ? <AlertTriangle /> : step.status === "running" ? <LoaderCircle className="spin" /> : null}</span><strong>{step.label}</strong><small>{step.status.replace("-", " ")}</small></li>)}</ol> : null}</div> : report ? <div className="review-report">
      <header className="review-summary"><div><span className={`recommendation recommendation--${report.recommendation}`}>{report.recommendation.replace("-", " ")}</span><strong>{report.overallAssessment}</strong></div><small>{report.issues.length} issues · saved report</small></header>
      <div className="review-columns"><section><h3><CheckCircle2 /> Strengths</h3>{report.strengths.map((item, index) => <p key={index}>{item}</p>)}</section><section><h3><AlertTriangle /> Weaknesses</h3>{report.weaknesses.map((item, index) => <p key={index}>{item}</p>)}</section></div>
      <section className="review-issues">
        <div className="review-issues__toolbar"><h3>Actionable issues</h3><Button size="small" variant="ghost" icon={<Plus />} onClick={() => setManualOpen((value) => !value)}>Add</Button><Button size="small" variant="ghost" icon={<Merge />} disabled={selected.length < 2} onClick={() => void mergeSelected()}>Merge {selected.length || ""}</Button><Button size="small" variant="secondary" icon={<ShieldCheck />} disabled={!selected.length} onClick={() => { const selectedIssues = report.issues.filter((issue) => selected.includes(issue.id)); onClose(); onReviseWithAgent(selected, `Resolve ${selected.length} selected review issue${selected.length === 1 ? "" : "s"}: ${selectedIssues.map((issue) => issue.title).join("; ")}`); }}>Fix with Agent {selected.length || ""}</Button><label>Severity <select value={severity} onChange={(event) => setSeverity(event.target.value)}><option value="all">All</option><option value="blocking">Blocking</option><option value="major">Major</option><option value="minor">Minor</option><option value="suggestion">Suggestion</option></select></label><label>Category <select value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">All</option>{["novelty", "soundness", "technical-depth", "threat-model", "evaluation", "reproducibility", "related-work", "clarity", "ethics"].map((value) => <option key={value}>{value}</option>)}</select></label><label>File <select value={file} onChange={(event) => setFile(event.target.value)}><option value="all">All</option>{issueFiles.map((path) => <option key={path}>{path}</option>)}</select></label><label>Status <select value={status} onChange={(event) => setStatus(event.target.value)}><option value="active">Active</option><option value="all">All</option><option value="open">Open</option><option value="planned">Planned</option><option value="in_revision">In revision</option><option value="resolved">Resolved</option><option value="dismissed">Dismissed</option></select></label></div>
        {manualOpen ? <div className="manual-issue"><div className="form-grid"><label className="field"><span>Category</span><select value={manual.category} onChange={(event) => setManual((current) => ({ ...current, category: event.target.value as ManualIssue["category"] }))}>{["novelty", "soundness", "technical-depth", "threat-model", "evaluation", "reproducibility", "related-work", "clarity", "ethics"].map((value) => <option key={value}>{value}</option>)}</select></label><label className="field"><span>Severity</span><select value={manual.severity} onChange={(event) => setManual((current) => ({ ...current, severity: event.target.value as ManualIssue["severity"] }))}>{["blocking", "major", "minor", "suggestion"].map((value) => <option key={value}>{value}</option>)}</select></label></div><label className="field"><span>Title</span><input value={manual.title} onChange={(event) => setManual((current) => ({ ...current, title: event.target.value }))} /></label><label className="field"><span>Rationale</span><textarea value={manual.rationale} onChange={(event) => setManual((current) => ({ ...current, rationale: event.target.value }))} /></label><div className="form-grid"><label className="field"><span>Impact</span><textarea value={manual.impact} onChange={(event) => setManual((current) => ({ ...current, impact: event.target.value }))} /></label><label className="field"><span>Suggested direction</span><textarea value={manual.suggestion} onChange={(event) => setManual((current) => ({ ...current, suggestion: event.target.value }))} /></label></div><div className="manual-issue__actions"><Button size="small" variant="ghost" onClick={() => setManualOpen(false)}>Cancel</Button><Button size="small" variant="primary" disabled={!manual.title.trim() || !manual.rationale.trim()} onClick={() => void createManual()}>Add issue</Button></div></div> : null}
        {visibleIssues.map((issue) => {
          const canReviseLocally = issue.evidence.some((evidence) => !evidence.inferred && Boolean(evidence.excerpt.trim() || evidence.line));
          const inactive = issue.status === "dismissed" || issue.status === "resolved";
          return <article className={`review-issue review-issue--${issue.severity}`} key={issue.id}>
            <header>
              <input type="checkbox" aria-label={`Select ${issue.title}`} checked={selected.includes(issue.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, issue.id] : current.filter((id) => id !== issue.id))} />
              <span>{issue.severity}</span><small>{issue.category.replace("-", " ")}</small><strong>{issue.title}</strong>
              <label className="issue-priority">P <input type="number" min="0" max="10000" defaultValue={issue.priority} onBlur={(event) => void updateIssue(issue.id, { priority: Number(event.target.value), reason: "Priority adjusted during triage" })} /></label>
              {canReviseLocally ? <button className="review-revise" disabled={inactive} onClick={() => { void updateIssue(issue.id, { status: "in_revision" }); onReviseLocally(issue); }}>Revise locally</button> : null}
              <button className="review-revise" disabled={inactive} onClick={() => { onClose(); onReviseWithAgent([issue.id], `Resolve review issue: ${issue.title}. ${issue.suggestion}`); }}>Fix with Agent</button>
              <select aria-label={`Status for ${issue.title}`} value={issue.status} onChange={(event) => void updateIssue(issue.id, { status: event.target.value as typeof issue.status })}><option value="open">Open</option><option value="planned">Planned</option><option value="in_revision">In revision</option><option value="resolved">Resolved</option><option value="dismissed">Dismissed</option></select>
            </header>
            <p>{issue.rationale}</p><dl><div><dt>Impact</dt><dd>{issue.impact}</dd></div><div><dt>Direction</dt><dd>{issue.suggestion}</dd></div></dl>
            {issue.evidence.map((evidence, index) => <button className="review-evidence" key={index} onClick={() => { onNavigate(evidence.path, evidence.line); onClose(); }}><ExternalLink /><span><strong>{evidence.path}{evidence.line ? `:${evidence.line}` : ""}</strong><q>{evidence.excerpt || "Inferred from missing manuscript evidence"}</q></span>{evidence.inferred ? <small>inference</small> : null}</button>)}
            {issue.history?.length ? <details className="issue-history"><summary>{issue.history.length} history events</summary>{issue.history.map((entry) => <p key={entry.id}><strong>{entry.action}</strong>{entry.reason}<time>{new Date(entry.createdAt).toLocaleString()}</time></p>)}</details> : null}
          </article>;
        })}
      </section>
      {report.nextSteps.length ? <section className="review-next"><h3>Suggested next steps</h3><ol>{report.nextSteps.map((step, index) => <li key={index}>{step}</li>)}</ol></section> : null}
    </div> : <div className="review-empty"><ShieldCheck /><h3>Evidence-first paper review</h3><p>FastWrite freezes the paper saved at {snapshotTime(project.updatedAt)}, reads the confirmed {project.skill.name} Skill, then produces a structured report. {compiledCurrentVersion ? "The current draft has a successful browser WASM compile." : "Compile first, or explicitly continue with a source-only review."} Review never edits paper files.</p></div>}
    {error ? <div className="form-error" role="alert">{error}</div> : null}
  </Dialog>;
}

function message(error: unknown) { return error instanceof Error ? error.message : "Review request failed"; }
function snapshotTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown time" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
