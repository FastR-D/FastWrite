import { useEffect, useState } from "react";
import type { AgentRun, ChangeSet } from "@fastwrite/shared";
import { api } from "../../api/client";
import { Button, Dialog, Disclosure, Icon, icons } from "../ui";

type ProvenanceDossier = { disclosureDraft: string; runs: Array<Pick<AgentRun, "id" | "type" | "status" | "objective" | "skill" | "changeSetId" | "createdAt" | "auditTrail">>; changeSets: Array<Pick<ChangeSet, "id" | "status" | "summary" | "changes">>; experiments: Array<{ id: string; projectVersion: number; scriptPath: string; status: string; inputSnapshotHash?: string; result?: { success: boolean; exitCode: number; artifactPaths: string[]; runId: string }; createdAt: string }> };

export function ProvenanceDialog({ open, projectId, onClose }: { open: boolean; projectId: string; onClose: () => void }) {
  const [dossier, setDossier] = useState<ProvenanceDossier | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError("");
    void api.projects.provenance(projectId, controller.signal).then((value) => setDossier(value as ProvenanceDossier)).catch((failure) => { if ((failure as DOMException).name !== "AbortError") setError(failure instanceof Error ? failure.message : "Could not load provenance"); });
    return () => controller.abort();
  }, [open, projectId]);
  const download = async () => {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/provenance/export`);
    if (!response.ok) throw new Error("Could not export provenance");
    const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `fastwrite-provenance-${projectId}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <Dialog open={open} width="wide" title="AI provenance dossier" description="Auditable runs, reviewed changes, hunk decisions, and disclosure draft" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button variant="secondary" onClick={() => void download()}>Export dossier</Button></>}>
    {error ? <p className="form-error" role="alert">{error}</p> : dossier ? <div className="provenance-dialog">
      <section className="provenance-disclosure"><header><div><h3>Disclosure draft</h3><p>Review this wording against the target venue before submission.</p></div><Icon name={icons.fileText} /></header><blockquote>{dossier.disclosureDraft}</blockquote></section>
      <section><header className="provenance-section-heading"><div><h3>Operations</h3><p>{dossier.runs.length} recorded AI run{dossier.runs.length === 1 ? "" : "s"} · {dossier.changeSets.length} ChangeSet{dossier.changeSets.length === 1 ? "" : "s"}</p></div></header>
        {dossier.runs.length ? dossier.runs.map((run) => <Disclosure key={run.id} summary={<><strong>{run.type}</strong><small>{run.status} · {run.skill?.name ?? "skill not recorded"} · {new Date(run.createdAt).toLocaleString()}</small></>}><dl><div><dt>Objective</dt><dd>{run.objective}</dd></div><div><dt>ChangeSet</dt><dd>{run.changeSetId ?? "No file change proposed"}</dd></div>{run.auditTrail?.length ? <div><dt>Audit events</dt><dd>{run.auditTrail.length}</dd></div> : null}</dl></Disclosure>) : <p className="provenance-empty">No AI-assisted writing operation is recorded for this project.</p>}
      </section>
      <section><header className="provenance-section-heading"><div><h3>Experiments</h3><p>{dossier.experiments.length} recorded sandbox run{dossier.experiments.length === 1 ? "" : "s"}</p></div></header>{dossier.experiments.length ? dossier.experiments.map((run) => <Disclosure key={run.id} summary={<><strong>{run.scriptPath}</strong><small>{run.status} · project v{run.projectVersion} · {new Date(run.createdAt).toLocaleString()}</small></>}><dl><div><dt>Input snapshot</dt><dd>{run.inputSnapshotHash ?? "Not available"}</dd></div><div><dt>Run ID</dt><dd>{run.result?.runId ?? "Not completed"}</dd></div><div><dt>Artifacts</dt><dd>{run.result?.artifactPaths.length ?? 0}</dd></div></dl></Disclosure>) : <p className="provenance-empty">No sandbox experiment is recorded for this project.</p>}</section>
        {dossier.changeSets.length ? <section><header className="provenance-section-heading"><div><h3>Reviewed changes</h3><p>Every file change remains tied to its hunk-level decision.</p></div></header>{dossier.changeSets.map((changeSet) => <Disclosure key={changeSet.id} summary={<><strong>{changeSet.summary}</strong><small>{changeSet.status} · {changeSet.changes.length} file{changeSet.changes.length === 1 ? "" : "s"}</small></>}><div className="provenance-changes">{changeSet.changes.map((change) => { const hunks = change.hunks ?? []; return <div key={change.path}><strong>{change.path}</strong><span>{change.operation} · {hunks.filter((hunk) => hunk.status === "accepted").length} accepted · {hunks.filter((hunk) => hunk.status === "rejected").length} rejected · {hunks.filter((hunk) => hunk.status === "pending").length} pending</span></div>; })}</div></Disclosure>)}</section> : null}
    </div> : <div className="provenance-empty"><Icon name={icons.loading} spin />Loading provenance…</div>}
  </Dialog>;
}
