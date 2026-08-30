import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, ShieldCheck } from "lucide-react";
import type { ComplianceReport, PaperProject } from "@fastwrite/shared";
import { api } from "../../api/client";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

export function ComplianceDialog({ open, project, renderedPages, onClose }: { open: boolean; project: PaperProject; renderedPages?: number; onClose: () => void }) {
  const [report, setReport] = useState<ComplianceReport | null>(null);
  const [online, setOnline] = useState(true);
  const [mainBodyPages, setMainBodyPages] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [writingFindings, setWritingFindings] = useState<Array<{ id: string; status: string; source: string; message: string }>>([]);
  const run = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError("");
    try { const parsedMainPages = Number(mainBodyPages); const [compliance, writing] = await Promise.all([api.compliance.check(project.id, { ...(renderedPages ? { renderedPages } : {}), ...(Number.isSafeInteger(parsedMainPages) && parsedMainPages > 0 ? { mainBodyPages: parsedMainPages } : {}), verifyCitationsOnline: online }, signal), api.claims.writingChecks(project.id, signal)]); setReport(compliance); setWritingFindings(writing.findings as Array<{ id: string; status: string; source: string; message: string }>); }
    catch (failure) { if ((failure as DOMException).name !== "AbortError") setError(failure instanceof Error ? failure.message : "Compliance check failed"); }
    finally { setLoading(false); }
  }, [mainBodyPages, online, project.id, renderedPages]);
  useEffect(() => { if (!open) return; const controller = new AbortController(); void run(controller.signal); return () => controller.abort(); }, [open, run]);

  return <Dialog open={open} title="Submission compliance" description="Deterministic source, venue-format, anonymity, comment, reference, and citation-authenticity checks." width="large" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button variant="primary" icon={<ShieldCheck />} loading={loading} onClick={() => void run()}>Run checks</Button></>}>
    <div className="form-stack">
      <label className="field"><span>Authenticity verification</span><select value={online ? "online" : "local"} onChange={(event) => setOnline(event.target.value === "online")}><option value="online">Crossref online verification</option><option value="local">Local consistency only</option></select><small>Unreachable or unmatched records remain unresolved; they are never treated as genuine.</small></label>
      <label className="field"><span>Main-body pages</span><input type="number" min="1" step="1" value={mainBodyPages} onChange={(event) => setMainBodyPages(event.target.value)} placeholder="Optional when references are excluded" /><small>Enter the number of rendered main-text pages before references so main-text-only limits can be enforced exactly.</small></label>
      {report ? <>
        <div className="agent-resolution"><ShieldCheck /><span><strong>{report.submissionBlocked ? "SUBMISSION BLOCKED" : "READY"} · {report.summary.errors} errors · {report.summary.warnings} warnings · {report.summary.unresolved} unresolved · {report.summary.passed} passed</strong>{report.renderedPages ? `Rendered PDF: ${report.renderedPages} pages.` : "Compile the PDF to enforce page limits."}</span></div>
        <div className="agent-plan"><section><h3>Checks</h3><ul>{report.findings.map((finding) => <li key={finding.id}><strong>{finding.status.toUpperCase()} · {finding.category}</strong> — {finding.message}{finding.path ? ` (${finding.path}${finding.line ? `:${finding.line}` : ""})` : ""}</li>)}</ul></section>
        <section><h3>Citation authenticity</h3>{report.citations.length ? <ul>{report.citations.map((citation) => <li key={citation.key}><strong>{citation.status.toUpperCase()} · {citation.key}</strong> — {citation.message}</li>)}</ul> : <p><CheckCircle2 /> No citation commands were found.</p>}</section></div>
        <section><h3>Writing quality preflight</h3>{writingFindings.length ? <ul>{writingFindings.map((finding) => <li key={finding.id}><strong className={finding.status === "blocking" ? "text-danger" : finding.status === "warning" ? "text-warning" : ""}>{finding.status.toUpperCase()} · {finding.source}</strong> — {finding.message}</li>)}</ul> : <p><CheckCircle2 /> No deterministic writing findings.</p>}</section>
      </> : null}
      {error ? <div className="form-error" role="alert">{error}</div> : null}
    </div>
  </Dialog>;
}
