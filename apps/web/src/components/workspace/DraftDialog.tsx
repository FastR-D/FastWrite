import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronRight, FileText, LoaderCircle, Plus, X } from "lucide-react";
import type { ChangeSet, DraftOutlineSection, DraftPlan, PaperProject } from "@fastwrite/shared";
import { api } from "../../api/client";
import { diffWords } from "../../lib/wordDiff";
import { Button, IconButton } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
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
    } catch (failure) { setError(cancelMessage(failure, "Draft planning")); setFailedStep("planning"); setStage("input"); }
    finally { finishRequest(requestRef, controller); }
  };

  const generate = async () => {
    if (!plan) return;
    const controller = beginRequest(requestRef);
    setStage("generating"); setError(""); setFailedStep(null);
    try {
      const response = await api.drafts.confirm(project.id, plan.id, outline, controller.signal);
      setPlan(response.plan); setChangeSet(response.changeSet); setActiveFile(0); setStage("diff");
    } catch (failure) { setError(cancelMessage(failure, "Draft generation")); setFailedStep("generating"); setStage("outline"); }
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
    <Dialog open={open} width="fullscreen" title="Agent · Draft paper" description={`${project.skill.name} · v${project.skill.version}`} onClose={() => { if (!busy) onClose(); }} footer={
      busy ? <Button variant="secondary" onClick={() => requestRef.current?.abort()}>Cancel task</Button> :
      stage === "input" ? <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!brief.trim()} onClick={() => void begin()}>Plan outline</Button></> :
      stage === "outline" ? <><Button variant="ghost" onClick={() => void discardPlan()}>Discard outline</Button><Button variant="primary" onClick={() => void generate()}>Confirm & generate</Button></> :
      stage === "diff" ? <><Button variant="ghost" icon={<X />} onClick={() => void reject()}>Reject all</Button><Button variant="primary" icon={<Check />} onClick={() => void accept()}>Accept all files</Button></> :
      stage === "accepted" ? <><Button variant="ghost" onClick={() => { reset(); onClose(); }}>Done</Button>{!compiledCurrentVersion ? <Button variant="primary" loading={compiling} disabled={compiling} onClick={onRequestCompile}>{compiling ? "Compiling" : "Compile draft"}</Button> : <span className="compile-confirmed"><Check /> Current version compiled</span>}</> : null
    }>
      {stage !== "input" || failedStep ? <DraftRunProgress stage={stage} compileState={compileState} failedStep={failedStep} error={error} /> : null}
      {stage === "input" ? <div className="draft-agent-chat">
        <article className="revise-message revise-message--assistant"><span><FileText /> Draft Agent</span><p>Describe the paper you want to draft. Include the research question, claimed contributions, threat-model constraints, and what evidence actually exists. I will first propose an outline; no files change until you review and accept them.</p></article>
        <label className="draft-agent-composer"><span>Your research brief</span><textarea value={brief} onChange={(event) => setBrief(event.target.value)} placeholder="We study… Our question is… The paper contributes… Available evidence includes… Do not claim…" autoFocus /></label>
      </div> : null}
      {busy ? <div className="agent-progress"><LoaderCircle className="spin" /><strong>{stage === "planning" ? "Planning the paper argument" : stage === "generating" ? "Drafting confirmed sections" : "Applying approved files"}</strong><span>The Agent is following the {project.skill.name} Skill.</span></div> : null}
      {stage === "outline" ? <div className="draft-outline"><div className="draft-outline__note">Review section responsibilities before any files are generated.</div>{outline.map((section, index) => <div className="outline-editor" key={`${section.path}-${index}`}><span>{index + 1}</span><div><input aria-label={`Section ${index + 1} title`} value={section.title} onChange={(event) => updateOutline(setOutline, index, "title", event.target.value)} /><input aria-label={`Section ${index + 1} path`} value={section.path} onChange={(event) => updateOutline(setOutline, index, "path", event.target.value)} /><textarea aria-label={`Section ${index + 1} purpose`} value={section.purpose} onChange={(event) => updateOutline(setOutline, index, "purpose", event.target.value)} /></div><IconButton label="Remove section" icon={<X />} onClick={() => setOutline((current) => current.filter((_, itemIndex) => itemIndex !== index))} /></div>)}<Button size="small" variant="secondary" icon={<Plus />} onClick={() => setOutline((current) => [...current, { path: "sections/new-section.tex", title: "New section", purpose: "Define this section's role in the paper argument." }])}>Add section</Button></div> : null}
      {(stage === "diff" || stage === "accepted") && changeSet ? <div className="draft-diff"><nav>{changeSet.changes.map((change, index) => <button className={index === activeFile ? "is-active" : ""} key={change.path} onClick={() => setActiveFile(index)}><FileText /><span>{change.path}</span><small>{change.hunks?.some((hunk) => hunk.status === "pending") ? "pending" : change.hunks?.some((hunk) => hunk.status === "accepted") ? "accepted" : "rejected"}</small><ChevronRight /></button>)}</nav><div className="draft-diff__file"><header>{selectedChange?.path}</header>{selectedChange ? <EditableChangeReview change={selectedChange} busy={deciding} readOnly={stage === "accepted" || changeSet.status !== "proposed"} onSave={editChange} onDecide={(ids, status) => void decideHunks(ids, status)} /> : <div className="revision-diff">{parts.map((part, index) => <span key={index}>{part.value}</span>)}</div>}</div>{stage === "accepted" ? <div className={`draft-success ${compileState.state === "error" ? "draft-success--error" : ""}`}>{compileState.state === "error" ? <AlertTriangle /> : <Check />} {compileState.state === "error" ? "Draft compilation failed. Review PDF diagnostics, then revise or retry." : compiledCurrentVersion ? "Draft applied and compiled successfully." : "Draft files applied. Compile the paper to validate the result."}</div> : null}</div> : null}
      {error ? <div className="form-error" role="alert">{error}</div> : null}
    </Dialog>
  );
}

function updateOutline(setter: React.Dispatch<React.SetStateAction<DraftOutlineSection[]>>, index: number, key: keyof DraftOutlineSection, value: string) {
  setter((current) => current.map((section, itemIndex) => itemIndex === index ? { ...section, [key]: value } : section));
}
function message(error: unknown) { return error instanceof Error ? error.message : "Draft Agent failed"; }
function cancelMessage(error: unknown, label: string) { return error instanceof DOMException && error.name === "AbortError" ? `${label} cancelled. No changes were created.` : message(error); }
function beginRequest(ref: React.MutableRefObject<AbortController | null>) { ref.current?.abort(); const controller = new AbortController(); ref.current = controller; return controller; }
function finishRequest(ref: React.MutableRefObject<AbortController | null>, controller: AbortController) { if (ref.current === controller) ref.current = null; }
function DraftRunProgress({ stage, compileState, failedStep, error }: { stage: Stage; compileState: CompileStateReport; failedStep: DraftStep | null; error: string }) {
  const order: DraftStep[] = ["planning", "generating", "applying", "compiling"];
  const labels: Record<DraftStep, string> = { planning: "Plan", generating: "Generate", applying: "Approve", compiling: "Compile" };
  const current: DraftStep = stage === "planning" || stage === "outline" ? "planning"
    : stage === "generating" ? "generating"
      : stage === "diff" || stage === "applying" ? "applying"
        : "compiling";
  const currentIndex = order.indexOf(current);
  return <div className="draft-run-progress" aria-label="Draft task progress">
    <ol>{order.map((step, index) => {
      const failed = failedStep === step || (step === "compiling" && compileState.state === "error");
      const complete = index < currentIndex || (step === "compiling" && compileState.state === "success");
      const active = step === current && !complete && !failed;
      return <li key={step} className={`${complete ? "is-complete" : ""} ${active ? "is-current" : ""} ${failed ? "is-error" : ""}`} aria-current={active ? "step" : undefined}>
        <span>{failed ? <AlertTriangle /> : complete ? <Check /> : active && (stage === "planning" || stage === "generating" || stage === "applying" || compileState.state === "loading" || compileState.state === "compiling") ? <LoaderCircle className="spin" /> : index + 1}</span>
        <strong>{labels[step]}</strong>
      </li>;
    })}</ol>
    {failedStep && error ? <p role="alert"><AlertTriangle /> {labels[failedStep]} failed: {error}</p> : null}
  </div>;
}
