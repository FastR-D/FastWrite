import { useEffect, useRef, useState } from "react";
import { FileSearch, Search } from "lucide-react";
import type { PaperProject } from "@fastwrite/shared";
import { api } from "../../api/client";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

type SearchResponse = Awaited<ReturnType<typeof api.projects.search>>;

export function ProjectSearchDialog({ open, project, onClose, onNavigate }: { open: boolean; project: PaperProject; onClose: () => void; onNavigate: (path: string, line: number) => void }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { if (!open) { controller.current?.abort(); setQuery(""); setResult(null); setError(""); setBusy(false); } }, [open]);

  const search = async () => {
    if (!query.trim() || busy) return;
    controller.current?.abort();
    const next = new AbortController(); controller.current = next;
    setBusy(true); setError("");
    try { setResult(await api.projects.search(project.id, query, next.signal)); }
    catch (failure) { if ((failure as DOMException).name !== "AbortError") setError(failure instanceof Error ? failure.message : "Could not search project files"); }
    finally { if (controller.current === next) { controller.current = null; setBusy(false); } }
  };

  return <Dialog open={open} width="medium" title="Find in files" description="Search files you can read in this project." onClose={onClose}>
    <div className="settings-fields">
      <div className="settings-agent__actions"><label className="field"><span>Search text</span><input value={query} autoFocus onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void search(); }} placeholder="Methods, citation key, or result" /></label><Button icon={<Search />} loading={busy} disabled={!query.trim()} onClick={() => void search()}>Search</Button></div>
      {error ? <div className="form-error" role="alert">{error}</div> : null}
      {result ? <section className="settings-agent" aria-live="polite"><div><strong>{result.matches.length} match{result.matches.length === 1 ? "" : "es"}</strong><span>{result.truncated ? "Showing the first 100 matches. Refine the query to see more." : "Only files available to you are included."}</span></div>{result.matches.length ? result.matches.map((match, index) => <button className="search-result" key={`${match.path}:${match.line}:${index}`} onClick={() => { onNavigate(match.path, match.line); onClose(); }}><FileSearch /><span><strong>{match.path}:{match.line}</strong><small>{match.excerpt}</small></span></button>) : <p className="empty-state">No readable files contain this text.</p>}</section> : null}
    </div>
  </Dialog>;
}
