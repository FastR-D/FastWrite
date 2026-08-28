import { useEffect, useState } from "react";
import type { PaperProject, ResearchWork } from "@fastwrite/shared";
import { api } from "../../api/client";
import { Dialog } from "../ui/Dialog";

export function ResearchDialog({ open, project, onClose }: { open: boolean; project: PaperProject; onClose: () => void }) {
  const [query, setQuery] = useState(""); const [works, setWorks] = useState<Array<ResearchWork & { project: { status: string; citationKey?: string } }>>([]); const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const load = async () => setWorks(await api.research.works(project.id));
  useEffect(() => { if (open) void load(); }, [open, project.id]);
  const search = async () => { if (!query.trim()) return; setBusy(true); setMessage(""); try { await api.research.search(project.id, query); await load(); } catch (error) { setMessage(error instanceof Error ? error.message : "Research search failed"); } finally { setBusy(false); } };
  const approve = async (work: ResearchWork & { project: { status: string; citationKey?: string } }) => { const citationKey = work.project.citationKey || `${(work.authors[0] || "ref").replace(/[^A-Za-z]/g, "").toLowerCase()}${work.year || ""}`; await api.research.approve(project.id, work.id, { status: "saved", citationKey }); await load(); setMessage(`Approved ${citationKey}; generate a BibTeX ChangeSet when ready.`); };
  return <Dialog open={open} title="Research & Evidence" onClose={onClose}><div className="research-panel"><div className="research-search"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Crossref, OpenAlex, Semantic Scholar, arXiv" onKeyDown={(event) => { if (event.key === "Enter") void search(); }} /><button onClick={() => void search()} disabled={busy}>Search</button></div>{message ? <p role="status">{message}</p> : null}<div className="research-results">{works.map((work) => <article key={work.id}><strong>{work.title}</strong><small>{work.authors.join(", ")} · {work.year ?? "year unresolved"} · {work.venue ?? "venue unresolved"}</small><span>{work.metadataStatus}</span>{work.project.status === "saved" ? <em>Approved · {work.project.citationKey}</em> : <button onClick={() => void approve(work)}>Approve metadata</button>}</article>)}</div></div></Dialog>;
}
