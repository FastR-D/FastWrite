import { statusLabel } from "../../lib/labels";
import { useEffect, useState } from "react";
import type { AgentRun, ChangeSet } from "@fastwrite/shared";
import { api, downloadFile } from "../../api/client";
import { Button, Dialog, Disclosure, Icon, icons } from "../ui";

type ProvenanceDossier = { disclosureDraft: string; runs: Array<Pick<AgentRun, "id" | "type" | "status" | "objective" | "skill" | "changeSetId" | "createdAt" | "auditTrail">>; changeSets: Array<Pick<ChangeSet, "id" | "status" | "summary" | "changes">>; experiments: Array<{ id: string; projectVersion: number; scriptPath: string; status: string; inputSnapshotHash?: string; result?: { success: boolean; exitCode: number; artifactPaths: string[]; runId: string }; createdAt: string }> };

export function ProvenanceDialog({ open, projectId, onClose }: { open: boolean; projectId: string; onClose: () => void }) {
  const [dossier, setDossier] = useState<ProvenanceDossier | null>(null);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError("");
    void api.projects.provenance(projectId, controller.signal).then((value) => setDossier(value as ProvenanceDossier)).catch((failure) => { if ((failure as DOMException).name !== "AbortError") setError(failure instanceof Error ? failure.message : "无法加载溯源记录"); });
    return () => controller.abort();
  }, [open, projectId]);
  const download = async () => {
    setExporting(true); setError("");
    try { await downloadFile(`/api/projects/${encodeURIComponent(projectId)}/provenance/export`, `fastwrite-provenance-${projectId}.json`); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "无法导出溯源记录"); }
    finally { setExporting(false); }
  };
  return <Dialog open={open} width="wide" title="AI 写作溯源档案" description="可审计的运行记录、更改审核、修改块决定及使用声明草稿" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>关闭</Button><Button variant="secondary" loading={exporting} onClick={() => void download()}>导出档案</Button></>}>
    {error ? <p className="form-error" role="alert">{error}</p> : dossier ? <div className="provenance-dialog">
      <section className="provenance-disclosure"><header><div><h3>使用声明草稿</h3><p>投稿前请根据目标会议或期刊的要求审核此声明。</p></div><Icon name={icons.fileText} /></header><blockquote>{dossier.disclosureDraft}</blockquote></section>
      <section><header className="provenance-section-heading"><div><h3>操作记录</h3><p>{dossier.runs.length} 次 AI 运行记录 · {dossier.changeSets.length} 更改集</p></div></header>
        {dossier.runs.length ? dossier.runs.map((run) => <Disclosure key={run.id} summary={<><strong>{statusLabel(run.type)}</strong><small>{statusLabel(run.status)} · {run.skill?.name ?? "未记录技能"} · {new Date(run.createdAt).toLocaleString("zh-CN")}</small></>}><dl><div><dt>目标</dt><dd>{run.objective}</dd></div><div><dt>更改集</dt><dd>{run.changeSetId ?? "未提出文件更改"}</dd></div>{run.auditTrail?.length ? <div><dt>审计事件</dt><dd>{run.auditTrail.length}</dd></div> : null}</dl></Disclosure>) : <p className="provenance-empty">此项目尚无 AI 辅助写作记录。</p>}
      </section>
      <section><header className="provenance-section-heading"><div><h3>实验</h3><p>{dossier.experiments.length} 次沙箱运行记录</p></div></header>{dossier.experiments.length ? dossier.experiments.map((run) => <Disclosure key={run.id} summary={<><strong>{run.scriptPath}</strong><small>{statusLabel(run.status)} · 项目版本{run.projectVersion} · {new Date(run.createdAt).toLocaleString("zh-CN")}</small></>}><dl><div><dt>输入快照</dt><dd>{run.inputSnapshotHash ?? "暂无"}</dd></div><div><dt>运行 ID</dt><dd>{run.result?.runId ?? "未完成"}</dd></div><div><dt>产物</dt><dd>{run.result?.artifactPaths.length ?? 0}</dd></div></dl></Disclosure>) : <p className="provenance-empty">此项目尚无沙箱实验记录。</p>}</section>
        {dossier.changeSets.length ? <section><header className="provenance-section-heading"><div><h3>已审核的更改</h3><p>每项文件更改均保留对应修改块的审核决定。</p></div></header>{dossier.changeSets.map((changeSet) => <Disclosure key={changeSet.id} summary={<><strong>{changeSet.summary}</strong><small>{statusLabel(changeSet.status)} · {changeSet.changes.length} 个文件</small></>}><div className="provenance-changes">{changeSet.changes.map((change) => { const hunks = change.hunks ?? []; return <div key={change.path}><strong>{change.path}</strong><span>{statusLabel(change.operation)} · {hunks.filter((hunk) => hunk.status === "accepted").length} 项已接受 · {hunks.filter((hunk) => hunk.status === "rejected").length} 项已拒绝 · {hunks.filter((hunk) => hunk.status === "pending").length} 待处理</span></div>; })}</div></Disclosure>)}</section> : null}
    </div> : <div className="provenance-empty"><Icon name={icons.loading} spin />正在加载溯源记录…</div>}
  </Dialog>;
}
