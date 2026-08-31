import { useEffect, useState } from "react";
import type { PaperProject, ResearchWork } from "@fastwrite/shared";
import { api } from "../../api/client";
import { Dialog } from "../ui/Dialog";

export function ResearchDialog({ open, project, onClose }: { open: boolean; project: PaperProject; onClose: () => void }) {
  const [query, setQuery] = useState(""); const [works, setWorks] = useState<Array<ResearchWork & { project: { status: string; citationKey?: string } }>>([]); const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const load = async (signal?: AbortSignal) => setWorks(await api.research.works(project.id, signal));
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setMessage("");
    void load(controller.signal).catch((error) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) setMessage(error instanceof Error ? error.message : "Could not load research works");
    });
    return () => controller.abort();
  }, [open, project.id]);
  const search = async () => { if (!query.trim()) return; setBusy(true); setMessage(""); try { await api.research.search(project.id, query); await load(); } catch (error) { setMessage(error instanceof Error ? error.message : "Research search failed"); } finally { setBusy(false); } };
  const approve = async (work: ResearchWork & { project: { status: string; citationKey?: string } }) => { const citationKey = work.project.citationKey || `${(work.authors[0] || "ref").replace(/[^A-Za-z]/g, "").toLowerCase()}${work.year || ""}`; setBusy(true); setMessage(""); try { await api.research.approve(project.id, work.id, { status: "saved", citationKey }); await load(); setMessage(`Approved ${citationKey}; generate a BibTeX ChangeSet when ready.`); } catch (error) { setMessage(error instanceof Error ? error.message : "Metadata approval failed"); } finally { setBusy(false); } };
  const verify = async (work: ResearchWork) => { setBusy(true); try { const updated = await api.research.verifyMetadata(project.id, work.id); setWorks((items) => items.map((item) => item.id === updated.id ? { ...item, ...updated } : item)); setMessage(`${updated.metadataStatus === "verified" ? "Metadata verified" : "Metadata conflict detected"}: ${work.title}`); } catch (error) { setMessage(error instanceof Error ? error.message : "Metadata verification failed"); } finally { setBusy(false); } };
  return <Dialog open={open} title="Research & Evidence" onClose={onClose}><div className="research-panel"><div className="research-search"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Crossref, OpenAlex, Semantic Scholar, arXiv" onKeyDown={(event) => { if (event.key === "Enter") void search(); }} /><button onClick={() => void search()} disabled={busy}>Search</button></div>{message ? <p role="status">{message}</p> : null}<div className="research-results">{works.map((work) => <article key={work.id}><strong>{work.title}</strong><small>{work.authors.join(", ")} · {work.year ?? "year unresolved"} · {work.venue ?? "venue unresolved"}</small><span>{work.metadataStatus} · {work.publicationStatus}</span>{work.publicationStatus === "retracted" ? <strong className="text-danger">Retracted — do not cite without explicit justification.</strong> : work.publicationStatus === "corrected" ? <strong className="text-warning">Correction or erratum available.</strong> : null}<button onClick={() => void verify(work)} disabled={busy}>Verify DOI</button>{work.project.status === "saved" ? <em>Approved · {work.project.citationKey}</em> : <button onClick={() => void approve(work)} disabled={busy}>Approve metadata</button>}</article>)}</div></div></Dialog>;
}
