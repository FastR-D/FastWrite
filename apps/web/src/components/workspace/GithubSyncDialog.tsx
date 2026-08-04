import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, GitMerge, LoaderCircle, RefreshCw } from "lucide-react";
import type { GithubSyncResolution, GithubSyncResolutionChoice, GithubSyncRun, PaperProject } from "@fastwrite/shared";
import { api } from "../../api/client";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import type { CompileStateReport } from "./PdfPane";
import { createPendingResolutions, editTextResolution, keepConflictSide, type PendingGithubSyncResolution } from "./github-sync-resolution";

interface GithubSyncDialogProps {
  open: boolean;
  project: PaperProject;
  compileState: CompileStateReport;
  onClose: () => void;
  onFlushEditor: () => Promise<void>;
  onWorkspaceApplied: () => Promise<void>;
  onRequestCompile: () => void;
}

type DialogStage = "saving" | "syncing" | "conflicts" | "compiling" | "compile-error" | "finalizing" | "completed" | "remote-changed" | "error";

export function GithubSyncDialog({ open, project, compileState, onClose, onFlushEditor, onWorkspaceApplied, onRequestCompile }: GithubSyncDialogProps) {
  const [stage, setStage] = useState<DialogStage>("saving");
  const [run, setRun] = useState<GithubSyncRun | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, PendingGithubSyncResolution>>({});
  const [error, setError] = useState("");
  const startedRef = useRef(false);
  const expectedCompileVersionRef = useRef<number | null>(null);
  const compileStartedRef = useRef(false);

  const acceptRun = async (next: GithubSyncRun) => {
    setRun(next);
    setError("");
    if (next.status === "conflicts") {
      setResolutions(createPendingResolutions(next.conflicts));
      setStage("conflicts");
      return;
    }
    if (next.status === "ready-to-compile") {
      await onWorkspaceApplied();
      expectedCompileVersionRef.current = next.projectVersion ?? null;
      compileStartedRef.current = false;
      setStage("compiling");
      onRequestCompile();
      return;
    }
    if (next.status === "remote-changed") {
      setStage("remote-changed");
      return;
    }
    if (next.status === "completed") {
      await onWorkspaceApplied();
      setStage("completed");
      return;
    }
    setError(next.error ?? "GitHub Sync failed");
    setStage("error");
  };

  const start = async () => {
    setStage("saving");
    setRun(null);
    setResolutions({});
    setError("");
    expectedCompileVersionRef.current = null;
    compileStartedRef.current = false;
    try {
      await onFlushEditor();
      setStage("syncing");
      await acceptRun(await api.github.startSync(project.id));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "GitHub Sync failed");
      setStage("error");
    }
  };

  useEffect(() => {
    if (!open) {
      startedRef.current = false;
      return;
    }
    if (startedRef.current) return;
    startedRef.current = true;
    void start();
  }, [open, project.id]);

  useEffect(() => {
    if (stage !== "compiling" || expectedCompileVersionRef.current === null) return;
    if (compileState.state === "loading" || compileState.state === "compiling") compileStartedRef.current = true;
    if (!compileStartedRef.current || compileState.compiledVersion !== expectedCompileVersionRef.current) return;
    if (compileState.state === "error") {
      setStage("compile-error");
      return;
    }
    if (compileState.state !== "success" || !run) return;
    setStage("finalizing");
    void api.github.finalizeSync(project.id, run.id).then(acceptRun).catch((failure) => {
      setError(failure instanceof Error ? failure.message : "Could not finish GitHub Sync");
      setStage("error");
    });
  }, [compileState, project.id, run, stage]);

  const applyResolutions = async () => {
    if (!run) return;
    const body: GithubSyncResolution[] = run.conflicts.map((conflict) => {
      const resolution = resolutions[conflict.path]!;
      return { path: conflict.path, choice: resolution.choice as GithubSyncResolutionChoice, ...(resolution.choice === "edited" ? { content: resolution.content } : {}) };
    });
    setStage("syncing");
    try {
      await acceptRun(await api.github.resolveSync(project.id, run.id, body));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not apply conflict resolutions");
      setStage("conflicts");
    }
  };

  const retryCompile = () => {
    compileStartedRef.current = false;
    setStage("compiling");
    onRequestCompile();
  };

  const allResolved = Boolean(run?.conflicts.length) && run!.conflicts.every((conflict) => resolutions[conflict.path]?.choice);
  const busy = ["saving", "syncing", "compiling", "finalizing"].includes(stage);
  const footer = stage === "conflicts" ? <Button variant="primary" icon={<GitMerge />} disabled={!allResolved} onClick={() => void applyResolutions()}>Apply &amp; continue sync</Button>
    : stage === "compile-error" ? <Button variant="primary" icon={<RefreshCw />} onClick={retryCompile}>Compile again</Button>
    : stage === "remote-changed" || stage === "error" ? <Button variant="primary" icon={<RefreshCw />} onClick={() => void start()}>Sync again</Button>
    : stage === "completed" ? <Button variant="primary" onClick={onClose}>Done</Button>
    : <Button variant="secondary" disabled>Sync in progress</Button>;

  return <Dialog open={open} title="Sync with GitHub" {...(project.source.type === "github" ? { description: `${project.source.repository} · ${run?.branch ?? project.source.ref}` } : {})} width={stage === "conflicts" ? "wide" : "medium"} className="github-sync-dialog" onClose={busy ? () => undefined : onClose} footer={footer}>
    {stage === "saving" ? <SyncProgress icon={<LoaderCircle className="spin" />} title="Saving local changes" detail="Creating a local recovery checkpoint…" /> : null}
    {stage === "syncing" ? <SyncProgress icon={<LoaderCircle className="spin" />} title={run?.conflicts.length ? "Applying conflict resolutions" : "Syncing changes"} detail="Fetching GitHub and merging from the last synced commit…" /> : null}
    {stage === "compiling" ? <SyncProgress icon={<LoaderCircle className="spin" />} title="Compiling merged paper" detail="Sync will continue after the current project version compiles successfully." /> : null}
    {stage === "finalizing" ? <SyncProgress icon={<LoaderCircle className="spin" />} title="Finishing Sync" detail={run?.hasChangesToPush ? "Publishing one FastWrite commit…" : "Recording the synced GitHub version…"} /> : null}
    {stage === "completed" ? <SyncProgress icon={<CheckCircle2 />} title="GitHub is in sync" detail={run?.pushedCommit ? `Published ${shortCommit(run.pushedCommit)} on ${run.branch}.` : `Updated from ${run?.branch ?? "GitHub"}; no FastWrite commit was needed.`} tone="success" /> : null}
    {stage === "compile-error" ? <SyncProgress icon={<AlertTriangle />} title="The merged paper did not compile" detail="Fix the compile errors, then compile again to continue this Sync." tone="warning" /> : null}
    {stage === "remote-changed" ? <SyncProgress icon={<AlertTriangle />} title="GitHub changed during Sync" detail={run?.error ?? "Run Sync again to merge the latest remote commit. No force-push was attempted."} tone="warning" /> : null}
    {stage === "error" ? <SyncProgress icon={<AlertTriangle />} title="Sync could not finish" detail={error || run?.error || "GitHub Sync failed"} tone="error" /> : null}
    {stage === "conflicts" && run ? <div className="sync-conflict-list">
      <div className="sync-conflict-summary"><AlertTriangle /><div><strong>{run.conflicts.length} conflict{run.conflicts.length === 1 ? "" : "s"}</strong><span>Resolve each file, then continue this Sync.</span></div></div>
      {run.conflicts.map((conflict) => {
        const resolution = resolutions[conflict.path] ?? { choice: "", content: "" };
        return <article className="sync-conflict" key={conflict.path}>
          <header><code>{conflict.path}</code><span>{conflict.kind === "text" ? "Text conflict" : conflict.kind === "binary" ? "Binary conflict" : "Delete / modify conflict"}</span></header>
          {conflict.kind === "text" ? <div className="sync-conflict__comparison">
            <section><strong>Base</strong><pre>{conflict.baseContent ?? "No common base"}</pre></section>
            <section><strong>FastWrite</strong><pre>{conflict.fastwriteContent ?? "Deleted"}</pre></section>
            <section><strong>GitHub</strong><pre>{conflict.githubContent ?? "Deleted"}</pre></section>
          </div> : null}
          <div className="sync-resolution" role="group" aria-label={`Resolution for ${conflict.path}`}>
            <button className={resolution.choice === "fastwrite" ? "is-active" : ""} onClick={() => setResolutions((current) => ({ ...current, [conflict.path]: keepConflictSide(conflict, resolution, "fastwrite") }))}>Keep FastWrite</button>
            <button className={resolution.choice === "github" ? "is-active" : ""} onClick={() => setResolutions((current) => ({ ...current, [conflict.path]: keepConflictSide(conflict, resolution, "github") }))}>Keep GitHub</button>
          </div>
          {conflict.kind === "text" ? <label className="sync-conflict__result">
            <span>Merged result</span>
            <textarea aria-label={`Merged result for ${conflict.path}`} value={resolution.content} onChange={(event) => setResolutions((current) => ({ ...current, [conflict.path]: editTextResolution(resolution, event.target.value) }))} spellCheck={false} />
          </label> : null}
        </article>;
      })}
      {error ? <div className="form-error" role="alert">{error}</div> : null}
    </div> : null}
  </Dialog>;
}

function SyncProgress({ icon, title, detail, tone = "neutral" }: { icon: ReactNode; title: string; detail: string; tone?: "neutral" | "success" | "warning" | "error" }) {
  return <div className={`sync-progress sync-progress--${tone}`}><span>{icon}</span><div><strong>{title}</strong><p>{detail}</p></div></div>;
}

function shortCommit(commit: string): string { return commit.slice(0, 7); }
