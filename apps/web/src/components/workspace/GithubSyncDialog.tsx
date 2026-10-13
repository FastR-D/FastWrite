import { useEffect, useRef, useState, type ReactNode } from "react";
import * as monaco from "../../lib/editor/monacoRuntime";
import type { GithubSyncResolution, GithubSyncResolutionChoice, GithubSyncRun, PaperProject } from "@fastwrite/shared";
import { api } from "../../api/client";
import { Button, Dialog, Field, Icon, TextArea, icons } from "../ui";
import type { CompileStateReport } from "./PdfPane";
import { createPendingResolutions, editTextResolution, keepConflictSide, type PendingGithubSyncResolution } from "./github-sync-resolution";
import { TextModelComparison } from "../workbench/TextModelComparison";
import { configureMonaco, languageForPath } from "../../lib/editor/monaco";

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
    setError(next.error ?? "GitHub 同步失败");
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
      setError(failure instanceof Error ? failure.message : "GitHub 同步失败");
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
      setError(failure instanceof Error ? failure.message : "无法完成 GitHub 同步");
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
      setError(failure instanceof Error ? failure.message : "无法应用冲突解决结果");
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
  const footer = stage === "conflicts" ? <Button variant="primary" icon={<Icon name={icons.gitMerge} />} disabled={!allResolved} onClick={() => void applyResolutions()}>应用并继续同步</Button>
    : stage === "compile-error" ? <Button variant="primary" icon={<Icon name={icons.refresh} />} onClick={retryCompile}>重新编译</Button>
    : stage === "remote-changed" || stage === "error" ? <Button variant="primary" icon={<Icon name={icons.refresh} />} onClick={() => void start()}>重新同步</Button>
    : stage === "completed" ? <Button variant="primary" onClick={onClose}>完成</Button>
    : <Button variant="secondary" disabled>正在同步</Button>;

  return <Dialog open={open} title="与 GitHub 同步" {...(project.source.type === "github" ? { description: `${project.source.repository} · ${run?.branch ?? project.source.ref}` } : {})} width={stage === "conflicts" ? "wide" : "medium"} className="github-sync-dialog" onClose={busy ? () => undefined : onClose} footer={footer}>
    {stage === "saving" ? <SyncProgress icon={<Icon name={icons.loading} spin />} title="正在保存本地更改" detail="正在创建本地恢复检查点…" /> : null}
    {stage === "syncing" ? <SyncProgress icon={<Icon name={icons.loading} spin />} title={run?.conflicts.length ? "正在应用冲突解决结果" : "正在同步更改"} detail="正在获取 GitHub 内容，并基于上次同步提交合并…" /> : null}
    {stage === "compiling" ? <SyncProgress icon={<Icon name={icons.loading} spin />} title="正在编译合并后的论文" detail="当前项目版本编译成功后将继续同步。" /> : null}
    {stage === "finalizing" ? <SyncProgress icon={<Icon name={icons.loading} spin />} title="正在完成同步" detail={run?.hasChangesToPush ? "正在发布 FastWrite 提交…" : "正在记录同步后的 GitHub 版本…"} /> : null}
    {stage === "completed" ? <SyncProgress icon={<Icon name={icons.passFilled} />} title="已与 GitHub 同步" detail={run?.pushedCommit ? `已将提交 ${shortCommit(run.pushedCommit)} 发布到 ${run.branch}。` : `已更新自 ${run?.branch ?? "GitHub"}；无需创建 FastWrite 提交。`} tone="success" /> : null}
    {stage === "compile-error" ? <SyncProgress icon={<Icon name={icons.warning} />} title="合并后的论文编译失败" detail="请修复编译错误，再重新编译以继续同步。" tone="warning" /> : null}
    {stage === "remote-changed" ? <SyncProgress icon={<Icon name={icons.warning} />} title="同步期间 GitHub 已有新的更改" detail={run?.error ?? "请重新同步以合并最新远程提交，本次未进行强制推送。"} tone="warning" /> : null}
    {stage === "error" ? <SyncProgress icon={<Icon name={icons.warning} />} title="无法完成同步" detail={error || run?.error || "GitHub 同步失败"} tone="error" /> : null}
    {stage === "conflicts" && run ? <div className="sync-conflict-list">
      <div className="sync-conflict-summary"><Icon name={icons.warning} /><div><strong>{run.conflicts.length} conflict</strong><span>请逐个解决文件冲突，再继续同步。</span></div></div>
      {run.conflicts.map((conflict) => {
        const resolution = resolutions[conflict.path] ?? { choice: "", content: "" };
        return <article className="sync-conflict" key={conflict.path}>
          <header><code>{conflict.path}</code><span>{conflict.kind === "text" ? "文本冲突" : conflict.kind === "binary" ? "二进制冲突" : "删除与修改冲突"}</span></header>
          {conflict.kind === "text" ? <GithubTextConflictComparison path={conflict.path} base={conflict.baseContent} fastwrite={conflict.fastwriteContent} github={conflict.githubContent} /> : null}
          <div className="sync-resolution" role="group" aria-label={`冲突解决结果： ${conflict.path}`}>
            <Button variant="ghost" className={resolution.choice === "fastwrite" ? "is-active" : ""} onClick={() => setResolutions((current) => ({ ...current, [conflict.path]: keepConflictSide(conflict, resolution, "fastwrite") }))}>保留 FastWrite 版本</Button>
            <Button variant="ghost" className={resolution.choice === "github" ? "is-active" : ""} onClick={() => setResolutions((current) => ({ ...current, [conflict.path]: keepConflictSide(conflict, resolution, "github") }))}>保留 GitHub 版本</Button>
          </div>
          {conflict.kind === "text" ? <Field label="合并结果" className="sync-conflict__result">
            <TextArea aria-label={`合并结果： ${conflict.path}`} value={resolution.content} onChange={(content) => setResolutions((current) => ({ ...current, [conflict.path]: editTextResolution(resolution, content) }))} spellCheck={false} />
          </Field> : null}
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

function GithubTextConflictComparison({ path, base, fastwrite, github }: { path: string; base: string | undefined; fastwrite: string | undefined; github: string | undefined }) {
  const [models, setModels] = useState<{ fastwrite: monaco.editor.ITextModel; github: monaco.editor.ITextModel } | null>(null);
  useEffect(() => {
    configureMonaco();
    const identity = crypto.randomUUID();
    const create = (side: string, content: string) => monaco.editor.createModel(content, languageForPath(path), monaco.Uri.from({ scheme: "fastwrite-github-conflict", path: `/${path}`, query: `${identity}-${side}` }));
    const created = { fastwrite: create("fastwrite", fastwrite ?? "已删除"), github: create("github", github ?? "已删除") };
    setModels(created);
    return () => { setModels(null); created.fastwrite.dispose(); created.github.dispose(); };
  }, [fastwrite, github, path]);
  return <div className="sync-conflict__comparison"><section><strong>共同基准版本</strong><pre>{base ?? "没有共同基准版本"}</pre></section><section className="sync-conflict__diff">{models ? <TextModelComparison original={models.fastwrite} modified={models.github} originalLabel="FastWrite" modifiedLabel="GitHub" /> : null}</section></div>;
}
