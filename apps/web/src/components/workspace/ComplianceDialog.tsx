import { useCallback, useEffect, useState } from "react";
import type { ComplianceReport, PaperProject } from "@fastwrite/shared";
import { api } from "../../api/client";
import { Button, Dialog, Field, Icon, icons, List, ListRow, NumberField, Select } from "../ui";

export function ComplianceDialog({ open, project, renderedPages, onClose }: { open: boolean; project: PaperProject; renderedPages?: number; onClose: () => void }) {
  const [report, setReport] = useState<ComplianceReport | null>(null);
  const [online, setOnline] = useState(true);
  const [mainBodyPages, setMainBodyPages] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [writingFindings, setWritingFindings] = useState<Array<{ id: string; status: string; source: string; message: string }>>([]);
  const run = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError("");
    try { const hasMainPages = mainBodyPages !== undefined && Number.isSafeInteger(mainBodyPages) && mainBodyPages > 0; const [compliance, writing] = await Promise.all([api.compliance.check(project.id, { ...(renderedPages ? { renderedPages } : {}), ...(hasMainPages ? { mainBodyPages } : {}), verifyCitationsOnline: online }, signal), api.claims.writingChecks(project.id, signal)]); setReport(compliance); setWritingFindings(writing.findings as Array<{ id: string; status: string; source: string; message: string }>); }
    catch (failure) { if ((failure as DOMException).name !== "AbortError") setError(failure instanceof Error ? failure.message : "投稿检查失败"); }
    finally { setLoading(false); }
  }, [mainBodyPages, online, project.id, renderedPages]);
  useEffect(() => { if (!open) return; const controller = new AbortController(); void run(controller.signal); return () => controller.abort(); }, [open, run]);

  return <Dialog open={open} title="投稿检查" description="检查源文件、投稿格式、匿名性、注释、参考文献及引用真实性。" width="large" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>关闭</Button><Button variant="primary" icon={<Icon name={icons.verified} />} loading={loading} onClick={() => void run()}>运行检查</Button></>}>
    <div className="form-stack">
      <Field label="真实性验证" hint="无法访问或匹配的记录将保留为未核实，不会视为真实引用。">
        <Select aria-label="真实性验证" value={online ? "online" : "local"} onChange={(next) => setOnline(next === "online")} options={[{ value: "online", label: "Crossref 在线验证" }, { value: "local", label: "仅检查本地一致性" }]} />
      </Field>
      <Field label="正文页数" hint="填写参考文献之前的正文页数，以准确检查正文页数限制。">
        <NumberField min={1} step={1} value={mainBodyPages} onChange={setMainBodyPages} placeholder="不计参考文献时可选填" />
      </Field>
      {report ? <>
        <div className="agent-resolution"><Icon name={icons.verified} /><span><strong>{report.submissionBlocked ? "投稿检查未通过" : "准备就绪"} · {report.summary.errors} 项错误 · {report.summary.warnings} 项警告 · {report.summary.unresolved} 项未核实 · {report.summary.passed} 已通过</strong>{report.renderedPages ? `已生成的 PDF： ${report.renderedPages} 页。` : "请编译 PDF 以检查页数限制。"}</span></div>
        <div className="agent-plan"><section><h3>检查项</h3><List label="检查项">{report.findings.map((finding) => <ListRow key={finding.id}><strong>{finding.status.toUpperCase()} · {finding.category}</strong> — {finding.message}{finding.path ? ` (${finding.path}${finding.line ? `:${finding.line}` : ""})` : ""}</ListRow>)}</List></section>
        <section><h3>引用真实性</h3>{report.citations.length ? <List label="引用真实性">{report.citations.map((citation) => <ListRow key={citation.key}><strong>{citation.status.toUpperCase()} · {citation.key}</strong> — {citation.message}</ListRow>)}</List> : <p><Icon name={icons.passFilled} /> 未发现引用命令。</p>}</section></div>
        <section><h3>写作质量预检</h3>{writingFindings.length ? <List label="写作质量预检">{writingFindings.map((finding) => <ListRow key={finding.id}><strong className={finding.status === "blocking" ? "text-danger" : finding.status === "warning" ? "text-warning" : ""}>{finding.status.toUpperCase()} · {finding.source}</strong> — {finding.message}</ListRow>)}</List> : <p><Icon name={icons.passFilled} /> 未发现可确定的写作问题。</p>}</section>
      </> : null}
      {error ? <div className="form-error" role="alert">{error}</div> : null}
    </div>
  </Dialog>;
}
