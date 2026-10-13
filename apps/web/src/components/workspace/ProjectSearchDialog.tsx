import { useEffect, useRef, useState } from "react";
import type { PaperProject } from "@fastwrite/shared";
import { api } from "../../api/client";
import { Button, Dialog, Field, Icon, icons, TextField } from "../ui";

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
    catch (failure) { if ((failure as DOMException).name !== "AbortError") setError(failure instanceof Error ? failure.message : "无法搜索项目文件"); }
    finally { if (controller.current === next) { controller.current = null; setBusy(false); } }
  };

  return <Dialog open={open} width="medium" title="在文件中查找" description="搜索此项目中有权读取的文件。" onClose={onClose}>
    <div className="settings-fields">
      <div className="settings-agent__actions"><Field label="搜索文本"><TextField value={query} autoFocus onChange={setQuery} onKeyDown={(event) => { if (event.key === "Enter") void search(); }} placeholder="方法、引用标识或结果" /></Field><Button icon={<Icon name={icons.search} />} loading={busy} disabled={!query.trim()} onClick={() => void search()}>搜索</Button></div>
      {error ? <div className="form-error" role="alert">{error}</div> : null}
      {result ? <section className="settings-agent" aria-live="polite"><div><strong>{result.matches.length} 处匹配{result.matches.length === 1 ? "" : "es"}</strong><span>{result.truncated ? "当前显示前 100 处匹配，请缩小搜索范围以查看更多结果。" : "仅包含你有权访问的文件。"}</span></div>{result.matches.length ? result.matches.map((match, index) => <Button variant="ghost" className="search-result" key={`${match.path}:${match.line}:${index}`} onClick={() => { onNavigate(match.path, match.line); onClose(); }}><Icon name={icons.search} /><span><strong>{match.path}:{match.line}</strong><small>{match.excerpt}</small></span></Button>) : <p className="empty-state">可读取的文件中没有此文本。</p>}</section> : null}
    </div>
  </Dialog>;
}
