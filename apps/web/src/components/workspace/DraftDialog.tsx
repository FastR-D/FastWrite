import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeSet, DraftOutlineSection, DraftPlan, PaperProject } from "@fastwrite/shared";
import { api } from "../../api/client";
import { diffWords } from "../../lib/wordDiff";
import { Button, Dialog, Field, Icon, IconButton, Stepper, TextArea, TextField, icons, type StepStatus } from "../ui";
import type { CompileStateReport } from "./PdfPane";
import { EditableChangeReview } from "./EditableChangeReview";

interface DraftDialogProps {
  open: boolean;
  project: PaperProject;
  onClose: () => void;
  onAccepted: () => void | Promise<void>;
  compileState: CompileStateReport;
  onRequestCompile: () => void;
}

type Stage = "input" | "planning" | "outline" | "generating" | "diff" | "applying" | "accepted";
type DraftStep = "planning" | "generating" | "applying" | "compiling";

export function DraftDialog({ open, project, onClose, onAccepted, compileState, onRequestCompile }: DraftDialogProps) {
  const [stage, setStage] = useState<Stage>("input");
  const [brief, setBrief] = useState("");
  const [plan, setPlan] = useState<DraftPlan | null>(null);
  const [outline, setOutline] = useState<DraftOutlineSection[]>([]);
  const [changeSet, setChangeSet] = useState<ChangeSet | null>(null);
  const [activeFile, setActiveFile] = useState(0);
  const [error, setError] = useState("");
  const [failedStep, setFailedStep] = useState<DraftStep | null>(null);
  const [deciding, setDeciding] = useState(false);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => () => requestRef.current?.abort(), []);

  useEffect(() => {
    if (!open || stage !== "input") return;
    const controller = new AbortController();
    void api.drafts.list(project.id, controller.signal).then(async (plans) => {
      const pending = plans.find((candidate) => candidate.status === "proposed" || candidate.status === "waiting-approval");
      if (!pending) return;
      setPlan(pending);
      setBrief(pending.request.brief ?? [pending.request.topic, pending.request.researchQuestion, ...(pending.request.contributions ?? []), pending.request.materials].filter(Boolean).join("\n\n"));
      setOutline(pending.outline);
      if (pending.status === "waiting-approval" && pending.changeSetId) {
        setChangeSet(await api.revisions.get(project.id, pending.changeSetId, controller.signal));
        setStage("diff");
      } else setStage("outline");
    }).catch(() => undefined);
    return () => controller.abort();
  }, [open, project.id, stage]);

  const begin = async () => {
    const controller = beginRequest(requestRef);
    setStage("planning"); setError(""); setFailedStep(null);
    try {
      const response = await api.drafts.plan(project.id, { brief: brief.trim() }, controller.signal);
      setPlan(response.plan); setOutline(response.plan.outline); setStage("outline");
    } catch (failure) { setError(cancelMessage(failure, "初稿规划")); setFailedStep("planning"); setStage("input"); }
    finally { finishRequest(requestRef, controller); }
  };

  const generate = async () => {
    if (!plan) return;
    const controller = beginRequest(requestRef);
    setStage("generating"); setError(""); setFailedStep(null);
    try {
      const response = await api.drafts.confirm(project.id, plan.id, outline, controller.signal);
      setPlan(response.plan); setChangeSet(response.changeSet); setActiveFile(0); setStage("diff");
    } catch (failure) { setError(cancelMessage(failure, "初稿生成")); setFailedStep("generating"); setStage("outline"); }
    finally { finishRequest(requestRef, controller); }
  };

  const accept = async () => {
    if (!changeSet) return;
    setStage("applying"); setError(""); setFailedStep(null);
    try {
      setChangeSet(await api.revisions.accept(project.id, changeSet.id));
      await onAccepted();
      setStage("accepted");
    } catch (failure) { setError(message(failure)); setFailedStep("applying"); setStage("diff"); }
  };

  const reject = async () => {
    if (!changeSet) return;
    setDeciding(true);
    try {
      const updated = await api.revisions.reject(project.id, changeSet.id);
      if (updated.status === "accepted") { setChangeSet(updated); await onAccepted(); setStage("accepted"); }
      else { reset(); onClose(); }
    } catch (failure) { setError(message(failure)); }
    finally { setDeciding(false); }
  };

  const decideHunks = async (hunkIds: string[], status: "accepted" | "rejected") => {
    if (!changeSet || !selectedChange) return;
    setDeciding(true); setError("");
    try {
      const updated = await api.revisions.decide(project.id, changeSet.id, { decisions: [{ path: selectedChange.path, hunkIds, status }] });
      setChangeSet(updated);
      if (status === "accepted") await onAccepted();
      if (updated.status === "accepted") setStage("accepted");
      else if (updated.status === "rejected") { reset(); onClose(); }
    } catch (failure) { setError(message(failure)); }
    finally { setDeciding(false); }
  };

  const editChange = async (after: string) => {
    if (!changeSet || !selectedChange) return;
    setError("");
    setChangeSet(await api.revisions.edit(project.id, changeSet.id, { changes: [{ path: selectedChange.path, after }] }));
  };

  const discardPlan = async () => { if (plan?.status === "proposed") await api.drafts.cancel(project.id, plan.id).catch(() => undefined); reset(); };

  const reset = () => { setStage("input"); setBrief(""); setPlan(null); setOutline([]); setChangeSet(null); setError(""); setFailedStep(null); };
  const selectedChange = changeSet?.changes[activeFile];
  const parts = useMemo(() => selectedChange ? diffWords(selectedChange.before, selectedChange.after) : [], [selectedChange]);
  const busy = stage === "planning" || stage === "generating" || stage === "applying";
  const compiledCurrentVersion = compileState.state === "success" && compileState.compiledVersion === project.version;
  const compiling = compileState.state === "loading" || compileState.state === "compiling";

  return (
    <Dialog open={open} width="fullscreen" title="智能助手 · 论文初稿" description={project.skill.name} onClose={() => { if (!busy) onClose(); }} footer={
      busy ? <Button variant="secondary" onClick={() => requestRef.current?.abort()}>取消任务</Button> :
      stage === "input" ? <><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" disabled={!brief.trim()} onClick={() => void begin()}>规划大纲</Button></> :
      stage === "outline" ? <><Button variant="ghost" onClick={() => void discardPlan()}>放弃大纲</Button><Button variant="primary" onClick={() => void generate()}>确认并生成</Button></> :
      stage === "diff" ? <><Button variant="ghost" icon={<Icon name={icons.close} />} onClick={() => void reject()}>全部拒绝</Button><Button variant="primary" icon={<Icon name={icons.check} />} onClick={() => void accept()}>接受全部文件</Button></> :
      stage === "accepted" ? <><Button variant="ghost" onClick={() => { reset(); onClose(); }}>完成</Button>{!compiledCurrentVersion ? <Button variant="primary" loading={compiling} disabled={compiling} onClick={onRequestCompile}>{compiling ? "正在编译" : "编译初稿"}</Button> : <span className="compile-confirmed"><Icon name={icons.check} /> 已编译当前版本</span>}</> : null
    }>
      {stage !== "input" || failedStep ? <DraftRunProgress stage={stage} compileState={compileState} failedStep={failedStep} error={error} /> : null}
      {stage === "input" ? <div className="draft-agent-chat">
        <article className="revise-message revise-message--assistant"><span><Icon name={icons.fileText} /> 初稿助手</span><p>描述希望起草的论文，包括研究问题、贡献、威胁模型约束和已有证据。助手会先提出大纲，审核并接受后才会修改文件。</p></article>
        <Field className="draft-agent-composer" label="研究说明"><TextArea value={brief} onChange={setBrief} placeholder="我们研究…研究问题是…论文贡献包括…已有证据包括…不可声称…" autoFocus /></Field>
      </div> : null}
      {busy ? <div className="agent-progress"><Icon name={icons.loading} spin /><strong>{stage === "planning" ? "正在规划论文论证" : stage === "generating" ? "正在起草已确认的章节" : "正在应用已确认的文件"}</strong><span>智能助手正在使用 {project.skill.name} 技能。</span></div> : null}
      {stage === "outline" ? <div className="draft-outline"><div className="draft-outline__note">生成文件前，请审核各章节的任务。</div>{outline.map((section, index) => <div className="outline-editor" key={`${section.path}-${index}`}><span>{index + 1}</span><div><TextField aria-label={`章节 ${index + 1} 标题`} value={section.title} onChange={(next) => updateOutline(setOutline, index, "title", next)} /><TextField aria-label={`章节 ${index + 1} 路径`} value={section.path} onChange={(next) => updateOutline(setOutline, index, "path", next)} /><TextArea aria-label={`章节 ${index + 1} 用途`} value={section.purpose} onChange={(next) => updateOutline(setOutline, index, "purpose", next)} /></div><IconButton label="移除章节" icon={<Icon name={icons.close} />} onClick={() => setOutline((current) => current.filter((_, itemIndex) => itemIndex !== index))} /></div>)}<Button size="small" variant="secondary" icon={<Icon name={icons.add} />} onClick={() => setOutline((current) => [...current, { path: "sections/new-section.tex", title: "新章节", purpose: "说明本章节在论文论证中的作用。" }])}>添加章节</Button></div> : null}
      {(stage === "diff" || stage === "accepted") && changeSet ? <div className="draft-diff"><nav>{changeSet.changes.map((change, index) => <Button variant="ghost" className={index === activeFile ? "is-active" : ""} key={change.path} onClick={() => setActiveFile(index)}><Icon name={icons.fileText} /><span>{change.path}</span><small>{change.hunks?.some((hunk) => hunk.status === "pending") ? "待处理" : change.hunks?.some((hunk) => hunk.status === "accepted") ? "accepted" : "rejected"}</small><Icon name={icons.chevronRight} /></Button>)}</nav><div className="draft-diff__file"><header>{selectedChange?.path}</header>{selectedChange ? <EditableChangeReview change={selectedChange} busy={deciding} readOnly={stage === "accepted" || changeSet.status !== "proposed"} onSave={editChange} onDecide={(ids, status) => void decideHunks(ids, status)} /> : <div className="revision-diff">{parts.map((part, index) => <span key={index}>{part.value}</span>)}</div>}</div>{stage === "accepted" ? <div className={`draft-success ${compileState.state === "error" ? "draft-success--error" : ""}`}>{compileState.state === "error" ? <Icon name={icons.warning} /> : <Icon name={icons.check} />} {compileState.state === "error" ? "初稿编译失败，请查看 PDF 编译诊断，再修改或重试。" : compiledCurrentVersion ? "已应用初稿并编译成功。" : "已应用初稿文件，请编译论文以验证结果。"}</div> : null}</div> : null}
      {error ? <div className="form-error" role="alert">{error}</div> : null}
    </Dialog>
  );
}

function updateOutline(setter: React.Dispatch<React.SetStateAction<DraftOutlineSection[]>>, index: number, key: keyof DraftOutlineSection, value: string) {
  setter((current) => current.map((section, itemIndex) => itemIndex === index ? { ...section, [key]: value } : section));
}
function message(error: unknown) { return error instanceof Error ? error.message : "初稿助手任务失败"; }
function cancelMessage(error: unknown, label: string) { return error instanceof DOMException && error.name === "AbortError" ? `${label} 已取消，未产生更改。` : message(error); }
function beginRequest(ref: React.MutableRefObject<AbortController | null>) { ref.current?.abort(); const controller = new AbortController(); ref.current = controller; return controller; }
function finishRequest(ref: React.MutableRefObject<AbortController | null>, controller: AbortController) { if (ref.current === controller) ref.current = null; }
function DraftRunProgress({ stage, compileState, failedStep, error }: { stage: Stage; compileState: CompileStateReport; failedStep: DraftStep | null; error: string }) {
  const order: DraftStep[] = ["planning", "generating", "applying", "compiling"];
  const labels: Record<DraftStep, string> = { planning: "规划", generating: "生成", applying: "批准", compiling: "编译" };
  const current: DraftStep = stage === "planning" || stage === "outline" ? "planning"
    : stage === "generating" ? "generating"
      : stage === "diff" || stage === "applying" ? "applying"
        : "compiling";
  const currentIndex = order.indexOf(current);
  return <div className="draft-run-progress" aria-label="初稿任务进度">
    <Stepper variant="grid" numbered connectors label="初稿任务进度" steps={order.map((step, index) => {
      const failed = failedStep === step || (step === "compiling" && compileState.state === "error");
      const complete = index < currentIndex || (step === "compiling" && compileState.state === "success");
      const active = step === current && !complete && !failed;
      const status: StepStatus = failed ? "error" : complete ? "complete" : active ? "current" : "pending";
      return {
        id: step,
        label: labels[step],
        status,
        icon: failed ? <Icon name={icons.warning} /> : complete ? <Icon name={icons.check} /> : active && (stage === "planning" || stage === "generating" || stage === "applying" || compileState.state === "loading" || compileState.state === "compiling") ? <Icon name={icons.loading} spin /> : null
      };
    })} />
    {failedStep && error ? <p role="alert"><Icon name={icons.warning} /> {labels[failedStep]} 失败： {error}</p> : null}
  </div>;
}
