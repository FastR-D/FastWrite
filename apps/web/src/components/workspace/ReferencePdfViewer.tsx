import { useEffect, useMemo, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { api } from "../../api/client";
import { Button, Select } from "../ui";
import styles from "./ReferenceStylePanel.module.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;
export function ReferencePdfViewer({ projectId, referenceId }: { projectId: string; referenceId: string }) {
  const [data, setData] = useState<Uint8Array | null>(null);
  const [page, setPage] = useState(1), [count, setCount] = useState(0), [scale, setScale] = useState(.85);
  const [error, setError] = useState("");
  const file = useMemo(() => data ? { data } : null, [data]);
  const options = useMemo(() => ({ isEvalSupported: false }), []);
  useEffect(() => { const controller = new AbortController(); setData(null); setPage(1); setCount(0); setError(""); void api.referencePapers.source(projectId, referenceId, controller.signal).then(response => response.arrayBuffer()).then(buffer => { if (!controller.signal.aborted) setData(new Uint8Array(buffer)); }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }); return () => controller.abort(); }, [projectId, referenceId]);
  return <div className={styles.pdf}>
    <div className={styles.actions}><Button disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</Button><span>{page} / {count || "…"}</span><Button disabled={page >= count} onClick={() => setPage(page + 1)}>下一页</Button><Select value={String(scale)} onChange={value => setScale(Number(value))} aria-label="参考 PDF 缩放" options={[.6, .85, 1, 1.25].map(value => ({ value: String(value), label: `${Math.round(value * 100)}%` }))} /></div>
    {error ? <p role="alert">{error}</p> : null}
    {file ? <Document file={file} options={options} onLoadSuccess={({ numPages }) => setCount(numPages)} onLoadError={failure => setError(failure.message)}><Page pageNumber={page} scale={scale} renderTextLayer renderAnnotationLayer={false} /></Document> : <p role="status">正在读取参考 PDF…</p>}
  </div>;
}
