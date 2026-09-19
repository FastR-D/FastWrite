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
    catch (failure) { if ((failure as DOMException).name !== "AbortError") setError(failure instanceof Error ? failure.message : "Compliance check failed"); }
    finally { setLoading(false); }
  }, [mainBodyPages, online, project.id, renderedPages]);
  useEffect(() => { if (!open) return; const controller = new AbortController(); void run(controller.signal); return () => controller.abort(); }, [open, run]);

  return <Dialog open={open} title="Submission compliance" description="Deterministic source, venue-format, anonymity, comment, reference, and citation-authenticity checks." width="large" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button variant="primary" icon={<Icon name={icons.verified} />} loading={loading} onClick={() => void run()}>Run checks</Button></>}>
    <div className="form-stack">
      <Field label="Authenticity verification" hint="Unreachable or unmatched records remain unresolved; they are never treated as genuine.">
        <Select aria-label="Authenticity verification" value={online ? "online" : "local"} onChange={(next) => setOnline(next === "online")} options={[{ value: "online", label: "Crossref online verification" }, { value: "local", label: "Local consistency only" }]} />
      </Field>
      <Field label="Main-body pages" hint="Enter the number of rendered main-text pages before references so main-text-only limits can be enforced exactly.">
        <NumberField min={1} step={1} value={mainBodyPages} onChange={setMainBodyPages} placeholder="Optional when references are excluded" />
      </Field>
      {report ? <>
        <div className="agent-resolution"><Icon name={icons.verified} /><span><strong>{report.submissionBlocked ? "SUBMISSION BLOCKED" : "READY"} · {report.summary.errors} errors · {report.summary.warnings} warnings · {report.summary.unresolved} unresolved · {report.summary.passed} passed</strong>{report.renderedPages ? `Rendered PDF: ${report.renderedPages} pages.` : "Compile the PDF to enforce page limits."}</span></div>
        <div className="agent-plan"><section><h3>Checks</h3><List label="Checks">{report.findings.map((finding) => <ListRow key={finding.id}><strong>{finding.status.toUpperCase()} · {finding.category}</strong> — {finding.message}{finding.path ? ` (${finding.path}${finding.line ? `:${finding.line}` : ""})` : ""}</ListRow>)}</List></section>
        <section><h3>Citation authenticity</h3>{report.citations.length ? <List label="Citation authenticity">{report.citations.map((citation) => <ListRow key={citation.key}><strong>{citation.status.toUpperCase()} · {citation.key}</strong> — {citation.message}</ListRow>)}</List> : <p><Icon name={icons.passFilled} /> No citation commands were found.</p>}</section></div>
        <section><h3>Writing quality preflight</h3>{writingFindings.length ? <List label="Writing quality preflight">{writingFindings.map((finding) => <ListRow key={finding.id}><strong className={finding.status === "blocking" ? "text-danger" : finding.status === "warning" ? "text-warning" : ""}>{finding.status.toUpperCase()} · {finding.source}</strong> — {finding.message}</ListRow>)}</List> : <p><Icon name={icons.passFilled} /> No deterministic writing findings.</p>}</section>
      </> : null}
      {error ? <div className="form-error" role="alert">{error}</div> : null}
    </div>
  </Dialog>;
}
