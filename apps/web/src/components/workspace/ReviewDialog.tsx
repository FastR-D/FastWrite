import { statusLabel } from "../../lib/labels";
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
  const run = async (sourceOnly: boolean) => { const controller = new AbortController(); runAbortRef.current = controller; setLoading(true); setActiveRun(null); setError(""); try { const response = await api.reviews.run(project.id, sourceOnly, controller.signal); setReport(response.report); setActiveRun(response.run); setSelected([]); } catch (failure) { setError(failure instanceof DOMException && failure.name === "AbortError" ? "已取消审稿，未生成报告。" : message(failure)); } finally { if (runAbortRef.current === controller) runAbortRef.current = null; setLoading(false); } };
  const updateIssue = async (issueId: string, updates: Parameters<typeof api.reviews.updateIssue>[2]) => { try { const updated = await api.reviews.updateIssue(project.id, issueId, updates); setReport((current) => current ? { ...current, issues: current.issues.map((issue) => issue.id === issueId ? updated : issue) } : current); } catch (failure) { setError(message(failure)); } };
  const createManual = async () => { try { const created = await api.reviews.createIssue(project.id, { ...manual, ...(report ? { reportId: report.id } : {}) }); setReport((current) => current ? { ...current, issues: [...current.issues, created] } : current); setManual(EMPTY_MANUAL); setManualOpen(false); } catch (failure) { setError(message(failure)); } };
  const mergeSelected = async () => { if (selected.length < 2) return; try { await api.reviews.mergeIssues(project.id, selected[0]!, selected.slice(1), "问题分类时已作为重复问题合并"); await refresh(); setSelected([]); } catch (failure) { setError(message(failure)); } };
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

  return <Dialog open={open} width={width} className="review-dialog" resizable={width === "wide"} title="论文审稿" description={`${project.skill.name} · 保存于 ${snapshotTime(project.updatedAt)}`} headerActions={<div className="dialog-size-controls" aria-label="审稿窗口大小"><IconButton label="紧凑审稿窗口" icon={<Icon name={icons.screenNormal} />} aria-pressed={width === "large"} onClick={() => setWidth("large")} /><IconButton label="宽屏审稿窗口" icon={<Icon name={icons.screenFull} />} aria-pressed={width === "wide"} onClick={() => setWidth("wide")} /><IconButton label="全屏审稿窗口" icon={<Icon name={icons.windowMaximize} />} aria-pressed={width === "fullscreen"} onClick={() => setWidth("fullscreen")} /></div>} onClose={() => { if (!loading) onClose(); }} footer={<><Button variant="ghost" disabled={loading} onClick={onClose}>关闭</Button>{!compiledCurrentVersion && !loading ? <Button variant="secondary" loading={compiling} disabled={compiling} onClick={onRequestCompile}>{compiling ? "正在编译" : "编译当前版本"}</Button> : null}{loading ? <Button variant="secondary" onClick={() => runAbortRef.current?.abort()}>取消审稿</Button> : <Button variant="primary" icon={<Icon name={icons.verified} />} onClick={() => void run(!compiledCurrentVersion)}>{report ? compiledCurrentVersion ? "重新审稿" : "仅审查源文件" : compiledCurrentVersion ? "审查论文" : "继续仅审查源文件"}</Button>}</>}>
    <div className="review-context" aria-label="审稿输入快照"><span>已保存的快照 <strong>{snapshotTime(project.updatedAt)}</strong></span><span>编译 <strong>{compiledCurrentVersion ? "当前版本 · 成功" : compiling ? "running" : compileState.state === "error" ? "当前版本 · 失败" : "不是当前版本"}</strong></span></div>
    {loading ? <div className="agent-progress review-run-progress"><Icon name={icons.loading} spin /><strong>正在审查论文快照</strong><span>正在收集章节证据、应用写作技能并合并重复问题。</span>{activeRun?.steps?.length ? <Stepper variant="grid" label="审稿步骤" steps={activeRun.steps.map((step) => ({ id: step.id, label: step.label, status: reviewStepStatus(step.status), icon: reviewStepIcon(step.status), detail: statusLabel(step.status) }))} /> : null}</div> : report ? <div className="review-report">
      <header className="review-summary"><div><span className={`recommendation recommendation--${report.recommendation}`}>{statusLabel(report.recommendation)}</span><strong>{report.overallAssessment}</strong></div><small>{report.issues.length} 项问题 · 报告已保存</small></header>
      {incompleteCoverage ? <div className="form-error" role="status"><Icon name={icons.warning} /> 审稿覆盖范围不完整，请检查失败或跳过的审查阶段，再判断论文是否没有问题。</div> : null}
      {report.passes?.length ? <section className="review-pass-coverage" aria-label="审稿阶段覆盖情况"><h3>审查覆盖情况</h3><div>{report.passes.map((pass) => <Disclosure className={`review-pass review-pass--${pass.status}`} key={statusLabel(pass.id)} summary={<><strong>{statusLabel(pass.id)}</strong><small>{statusLabel(pass.status)}{pass.issues.length ? ` · ${pass.issues.length} 个问题` : ""}</small></>}><dl><div><dt>服务</dt><dd>{statusLabel(pass.provider ?? "unavailable")}{pass.model ? ` / ${pass.model}` : ""}</dd></div><div><dt>输入</dt><dd>{pass.inputBoundary ?? "未记录"}</dd></div>{pass.error || pass.unavailableReason ? <div><dt>原因</dt><dd>{pass.error ?? pass.unavailableReason}</dd></div> : null}</dl></Disclosure>)}</div></section> : null}
      <div className="review-columns"><section><h3><Icon name={icons.passFilled} /> 优点</h3>{report.strengths.map((item, index) => <p key={index}>{item}</p>)}</section><section><h3><Icon name={icons.warning} /> 不足</h3>{report.weaknesses.map((item, index) => <p key={index}>{item}</p>)}</section></div>
      <section className="review-issues">
        <div className="review-issues__toolbar"><h3>待处理问题</h3><Button size="small" variant="ghost" icon={<Icon name={icons.add} />} onClick={() => setManualOpen((value) => !value)}>添加</Button><Button size="small" variant="ghost" icon={<Icon name={icons.gitMerge} />} disabled={selected.length < 2} onClick={() => void mergeSelected()}>合并 {selected.length || ""}</Button><Button size="small" variant="secondary" icon={<Icon name={icons.verified} />} disabled={!selected.length} onClick={() => { const selectedIssues = report.issues.filter((issue) => selected.includes(issue.id)); onClose(); onReviseWithAgent(selected, `解决 ${selected.length} 个所选审稿问题: ${selectedIssues.map((issue) => issue.title).join("；")}`); }}>使用智能助手修复 {selected.length || ""}</Button><Field label="严重程度"><Select value={severity} onChange={setSeverity} options={[{ value: "all", label: "全部" }, { value: "blocking", label: "阻塞" }, { value: "major", label: "严重" }, { value: "minor", label: "轻微" }, { value: "suggestion", label: "建议" }]} /></Field><Field label="类别"><Select value={category} onChange={setCategory} options={[{ value: "all", label: "全部" }, ...["novelty", "soundness", "technical-depth", "threat-model", "evaluation", "reproducibility", "related-work", "clarity", "ethics"].map((value) => ({ value, label: statusLabel(value) }))]} /></Field><Field label="文件"><Select value={file} onChange={setFile} options={[{ value: "all", label: "全部" }, ...issueFiles.map((path) => ({ value: path, label: path }))]} /></Field><Field label="状态"><Select value={status} onChange={setStatus} options={[{ value: "active", label: "有效" }, { value: "all", label: "全部" }, { value: "open", label: "待处理" }, { value: "planned", label: "已规划" }, { value: "in_revision", label: "修改中" }, { value: "resolved", label: "已解决" }, { value: "dismissed", label: "已忽略" }]} /></Field></div>
        {manualOpen ? <div className="manual-issue"><div className="form-grid"><Field label="类别"><Select value={manual.category} onChange={(next) => setManual((current) => ({ ...current, category: next as ManualIssue["category"] }))} options={["novelty", "soundness", "technical-depth", "threat-model", "evaluation", "reproducibility", "related-work", "clarity", "ethics"].map((value) => ({ value, label: statusLabel(value) }))} /></Field><Field label="严重程度"><Select value={manual.severity} onChange={(next) => setManual((current) => ({ ...current, severity: next as ManualIssue["severity"] }))} options={["blocking", "major", "minor", "suggestion"].map((value) => ({ value, label: statusLabel(value) }))} /></Field></div><Field label="标题"><TextField value={manual.title} onChange={(next) => setManual((current) => ({ ...current, title: next }))} /></Field><Field label="理由"><TextArea value={manual.rationale} onChange={(next) => setManual((current) => ({ ...current, rationale: next }))} /></Field><div className="form-grid"><Field label="影响"><TextArea value={manual.impact} onChange={(next) => setManual((current) => ({ ...current, impact: next }))} /></Field><Field label="建议方向"><TextArea value={manual.suggestion} onChange={(next) => setManual((current) => ({ ...current, suggestion: next }))} /></Field></div><div className="manual-issue__actions"><Button size="small" variant="ghost" onClick={() => setManualOpen(false)}>取消</Button><Button size="small" variant="primary" disabled={!manual.title.trim() || !manual.rationale.trim()} onClick={() => void createManual()}>添加问题</Button></div></div> : null}
        {visibleIssues.map((issue) => {
          const canReviseLocally = issue.evidence.some((evidence) => !evidence.inferred && Boolean(evidence.excerpt.trim() || evidence.line));
          const inactive = issue.status === "dismissed" || issue.status === "resolved";
          return <article className={`review-issue review-issue--${issue.severity}`} key={issue.id}>
            <header>
              <Checkbox aria-label={`选择 ${issue.title}`} checked={selected.includes(issue.id)} onChange={(checked) => setSelected((current) => checked ? [...current, issue.id] : current.filter((id) => id !== issue.id))} />
              <span>{statusLabel(issue.severity)}</span><small>{statusLabel(issue.category)}</small><strong>{issue.title}</strong>
              <Label className="issue-priority">P <NumberField min={0} max={10000} defaultValue={issue.priority} onCommit={(value) => void updateIssue(issue.id, { priority: value ?? 0, reason: "分类时已调整优先级" })} /></Label>
              {canReviseLocally ? <Button variant="ghost" className="review-revise" disabled={inactive} onClick={() => { void updateIssue(issue.id, { status: "in_revision" }); onReviseLocally(issue); }}>局部修改</Button> : null}
              <Button variant="ghost" className="review-revise" disabled={inactive} onClick={() => { onClose(); onReviseWithAgent([issue.id], `解决审稿问题： ${issue.title}. ${issue.suggestion}`); }}>使用智能助手修复</Button>
              <Select className="review-issue-status" aria-label={`问题状态： ${issue.title}`} value={issue.status} onChange={(next) => void updateIssue(issue.id, { status: next as typeof issue.status })} options={[{ value: "open", label: "待处理" }, { value: "planned", label: "已规划" }, { value: "in_revision", label: "修改中" }, { value: "needs_review", label: "待审核" }, { value: "resolved", label: "已解决" }, { value: "dismissed", label: "已忽略" }]} />
            </header>
            <p>{issue.rationale}</p><dl><div><dt>影响</dt><dd>{issue.impact}</dd></div><div><dt>方向</dt><dd>{issue.suggestion}</dd></div></dl>
            {issue.evidence.map((evidence, index) => <Button variant="ghost" className="review-evidence" key={index} disabled={!evidence.path} onClick={() => { if (evidence.path) onNavigate(evidence.path, evidence.line); onClose(); }}><Icon name={icons.linkExternal} /><span><strong>{evidence.path ?? `PDF 页码 ${evidence.page ?? "?"}`}{evidence.line ? `:${evidence.line}` : ""}</strong><q>{evidence.excerpt || "根据稿件缺少证据推断"}</q></span>{evidence.inferred ? <small>推断</small> : null}</Button>)}
            {issue.history?.length ? <Disclosure className="issue-history" summary={`${issue.history.length} 条历史记录`}>{issue.history.map((entry) => <p key={entry.id}><strong>{statusLabel(entry.action)}</strong>{entry.reason}<time>{new Date(entry.createdAt).toLocaleString("zh-CN")}</time></p>)}</Disclosure> : null}
          </article>;
        })}
      </section>
      {report.nextSteps.length ? <section className="review-next"><h3>建议下一步</h3><List ordered label="建议下一步">{report.nextSteps.map((step, index) => <ListRow key={index}>{step}</ListRow>)}</List></section> : null}
    </div> : <div className="review-empty"><Icon name={icons.verified} /><h3>以证据为依据的论文审稿</h3><p>FastWrite 将使用保存于 {snapshotTime(project.updatedAt)}的论文快照，读取已确认的 {project.skill.name} 技能，然后生成结构化报告。 {compiledCurrentVersion ? "当前稿件已通过本地 LaTeX 编译。" : "请先编译，或明确选择继续仅审查源文件。"} 审稿不会修改论文文件。</p></div>}
    {error ? <div className="form-error" role="alert">{error}</div> : null}
  </Dialog>;
}

function message(error: unknown) { return error instanceof Error ? error.message : "审稿请求失败"; }
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
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}
