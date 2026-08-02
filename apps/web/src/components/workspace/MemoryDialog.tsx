import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Database, ExternalLink, LoaderCircle, RotateCcw, X } from "lucide-react";
import type { MemoryItem, MemoryItemStatus, PaperMemory, PaperProject } from "@fastwrite/shared";
import { api } from "../../api/client";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

export function MemoryDialog({ open, project, onClose, onNavigate }: { open: boolean; project: PaperProject; onClose: () => void; onNavigate: (path: string, line?: number) => void }) {
  const [memory, setMemory] = useState<PaperMemory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [drafts, setDrafts] = useState<Record<string, { label: string; content: string }>>({});

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    api.memory.get(project.id, controller.signal).then((value) => { setMemory(value); seedDrafts(value, setDrafts); }).catch((failure) => setError(message(failure)));
    return () => controller.abort();
  }, [open, project.id]);

  const extract = async () => {
    setLoading(true); setError("");
    try { const value = await api.memory.extract(project.id); setMemory(value); seedDrafts(value, setDrafts); }
    catch (failure) { setError(message(failure)); }
    finally { setLoading(false); }
  };

  const update = async (item: MemoryItem, status?: MemoryItemStatus) => {
    const draft = drafts[item.id] ?? { label: item.label, content: item.content };
    setError("");
    try {
      const value = await api.memory.updateItem(project.id, item.id, { ...(status ? { status } : {}), label: draft.label, content: draft.content });
      setMemory(value); seedDrafts(value, setDrafts);
    } catch (failure) { setError(message(failure)); }
  };

  const rollback = async () => {
    setError("");
    try { const value = await api.memory.rollback(project.id); setMemory(value); seedDrafts(value, setDrafts); }
    catch (failure) { setError(message(failure)); }
  };

  const visible = useMemo(() => memory?.items.filter((item) => {
    const statusMatches = statusFilter === "all" || (statusFilter === "active" ? item.status !== "rejected" : item.status === statusFilter);
    return statusMatches && (categoryFilter === "all" || item.category === categoryFilter);
  }) ?? [], [memory, statusFilter, categoryFilter]);
  const confirmed = memory?.items.filter((item) => item.status === "confirmed").length ?? 0;
  const stale = memory?.items.filter((item) => item.status === "stale").length ?? 0;

  return <Dialog open={open} width="large" title="Paper Memory" description={memory ? `Memory v${memory.version} · project v${memory.projectVersion} · ${confirmed} confirmed` : "Confirmed project facts shared by Agent, Revise, and Review"} onClose={() => { if (!loading) onClose(); }} footer={<><Button variant="ghost" onClick={onClose}>Close</Button>{memory && memory.version > 1 ? <Button variant="secondary" icon={<RotateCcw />} onClick={() => void rollback()}>Restore previous</Button> : null}<Button variant="primary" icon={loading ? <LoaderCircle className="spin" /> : <Database />} loading={loading} onClick={() => void extract()}>{memory ? "Re-extract suggestions" : "Generate Memory"}</Button></>}>
    {loading ? <div className="agent-progress"><LoaderCircle className="spin" /><strong>Extracting evidence-backed paper facts</strong><span>Suggestions remain untrusted until you confirm them.</span></div> : memory ? <div className="memory-panel">
      {stale ? <div className="memory-stale"><AlertTriangle /> {stale} confirmed item{stale === 1 ? " is" : "s are"} stale because its source file changed.</div> : null}
      <div className="memory-toolbar"><label>Category <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="all">All</option>{["research-question", "contribution", "system-model", "threat-model", "term", "experiment", "limitation", "open-question"].map((category) => <option key={category} value={category}>{category.replace("-", " ")}</option>)}</select></label><label>Status <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="active">Active</option><option value="all">All</option><option value="suggested">Suggested</option><option value="confirmed">Confirmed</option><option value="stale">Stale</option><option value="needs-information">Needs information</option><option value="rejected">Rejected</option></select></label><span>{visible.length} items</span></div>
      <div className="memory-list">{visible.map((item) => { const draft = drafts[item.id] ?? { label: item.label, content: item.content }; return <article className={`memory-card memory-card--${item.status}`} key={item.id}><header><span>{item.category.replace("-", " ")}</span><strong>{item.status.replace("-", " ")}</strong></header><input aria-label={`Label for ${item.label}`} value={draft.label} onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: { ...draft, label: event.target.value } }))} /><textarea aria-label={`Memory content for ${item.label}`} value={draft.content} onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: { ...draft, content: event.target.value } }))} /><div className="memory-sources">{item.sources.map((source, index) => <button key={`${source.path}-${index}`} onClick={() => { onNavigate(source.path, source.line); onClose(); }}><ExternalLink /><span><strong>{source.path}{source.line ? `:${source.line}` : ""}</strong><q>{source.excerpt}</q></span></button>)}</div><footer><Button size="small" variant="ghost" icon={<X />} onClick={() => void update(item, "rejected")}>Reject</Button><Button size="small" variant="secondary" onClick={() => void update(item, "needs-information")}>Needs info</Button><Button size="small" variant="primary" icon={<Check />} onClick={() => void update(item, "confirmed")}>{item.status === "confirmed" ? "Save" : "Confirm"}</Button></footer></article>; })}</div>
    </div> : <div className="review-empty"><Database /><h3>Build a verifiable project memory</h3><p>Extract research questions, contributions, models, terminology, experiments, limitations, and open questions. Every suggestion must include exact source evidence.</p></div>}
    {error ? <div className="form-error" role="alert">{error}</div> : null}
  </Dialog>;
}

function seedDrafts(memory: PaperMemory | null, setter: React.Dispatch<React.SetStateAction<Record<string, { label: string; content: string }>>>) { setter(Object.fromEntries(memory?.items.map((item) => [item.id, { label: item.label, content: item.content }]) ?? [])); }
function message(error: unknown) { return error instanceof Error ? error.message : "Paper Memory request failed"; }
