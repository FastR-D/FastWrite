import { statusLabel } from "../../lib/labels";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeSet, ClaimEvidenceLink, CitationReviewer, FastReadBundleReceipt, PaperClaim, PaperProject, ProjectResearchWorkDetails, ResearchRun, SourceEvidence, WorkspaceTreeNode } from "@fastwrite/shared";
import { api } from "../../api/client";
import { Button, Checkbox, Dialog, Field, FileField, Icon, IconButton, Select, Stepper, TextArea, TextField, icons } from "../ui";

type ResearchWorkView = ProjectResearchWorkDetails;
type ResearchTab = "sources" | "evidence" | "claims";
type CitationContext = { key: string; contexts: Array<{ path: string; line: number; excerpt: string }>; bibliography?: { path: string; line: number; entry: string } };
type ManualSource = { title: string; authors: string; year: string; venue: string; doi: string; arxiv: string; citationKey: string };
const EMPTY_MANUAL_SOURCE: ManualSource = { title: "", authors: "", year: "", venue: "", doi: "", arxiv: "", citationKey: "" };

export function ResearchDialog({ open, project, onClose, onChanged, onNavigate }: { open: boolean; project: PaperProject; onClose: () => void; onChanged?: () => void; onNavigate?: (path: string, line?: number) => void }) {
  const [tab, setTab] = useState<ResearchTab>("sources");
  const [query, setQuery] = useState("");
  const [works, setWorks] = useState<ResearchWorkView[]>([]);
  const [bundles, setBundles] = useState<FastReadBundleReceipt[]>([]);
  const [evidence, setEvidence] = useState<SourceEvidence[]>([]);
  const [claims, setClaims] = useState<PaperClaim[]>([]);
  const [links, setLinks] = useState<ClaimEvidenceLink[]>([]);
  const [citationReviewer, setCitationReviewer] = useState<CitationReviewer | null>(null);
  const [bibPath, setBibPath] = useState("references.bib");
  const [bibPaths, setBibPaths] = useState<string[]>([]);
  const [pendingBibtex, setPendingBibtex] = useState<ChangeSet | null>(null);
  const [evidenceChoice, setEvidenceChoice] = useState<Record<string, string>>({});
  const [waiverReasons, setWaiverReasons] = useState<Record<string, string>>({});
  const [providerResults, setProviderResults] = useState<ResearchRun["providers"]>([]);
  const [latestRun, setLatestRun] = useState<ResearchRun | null>(null);
  const [screening, setScreening] = useState<Record<string, { decision: "included" | "excluded" | "uncertain"; reason: string }>>({});
  const [protocolOpen, setProtocolOpen] = useState(false);
  const [protocol, setProtocol] = useState({ steps: "", rationale: "", inclusionCriteria: "", exclusionCriteria: "", extractionFields: "" });
  const [citationContexts, setCitationContexts] = useState<Record<string, CitationContext>>({});
  const [manualOpen, setManualOpen] = useState(false);
  const [manualSource, setManualSource] = useState<ManualSource>(EMPTY_MANUAL_SOURCE);
  const [evidenceStance, setEvidenceStance] = useState<Record<string, SourceEvidence["stance"]>>({});
  const [evidenceRepresentation, setEvidenceRepresentation] = useState<Record<string, SourceEvidence["representation"]>>({});
  const [pdfWorkId, setPdfWorkId] = useState("");
  const [pdfAuthorized, setPdfAuthorized] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const searchController = useRef<AbortController | null>(null);

  const workById = useMemo(() => new Map(works.map((work) => [work.id, work])), [works]);
  const approvedEvidence = evidence.filter((item) => item.status === "approved");

  const load = async () => {
    const [nextWorks, nextBundles, nextEvidence, nextClaims, nextLinks, nextReviewer, tree] = await Promise.all([
      api.research.works(project.id),
      api.research.fastReadBundles(project.id),
      api.claims.evidence(project.id),
      api.claims.list(project.id),
      api.claims.links(project.id),
      api.claims.citationReviewer(project.id),
      api.projects.tree(project.id)
    ]);
    setWorks(nextWorks);
    setBundles(nextBundles);
    setEvidence(nextEvidence);
    setClaims(nextClaims);
    setLinks(nextLinks);
    setCitationReviewer(nextReviewer);
    if (latestRun) {
      const records = await api.research.screening(project.id, latestRun.id);
      setScreening(Object.fromEntries(records.map((record) => [record.workId, { decision: record.decision, reason: record.reason ?? "" }])));
    }
    const discovered = bibliographyPaths(tree);
    setBibPaths(discovered);
    if (discovered.length && !discovered.includes(bibPath)) setBibPath(discovered[0]!);
  };

  const saveScreening = (work: ResearchWorkView, decision: "included" | "excluded" | "uncertain", reason: string) => perform(`screen:${work.id}`, async () => {
    if (!latestRun) throw new Error("请先检索文献，再筛选结果。");
    await api.research.updateScreening(project.id, latestRun.id, work.id, { decision, ...(reason.trim() ? { reason: reason.trim() } : {}) });
    setScreening((current) => ({ ...current, [work.id]: { decision, reason } }));
  });

  useEffect(() => {
    if (!open) return;
    setError("");
    void load().catch((failure) => setError(errorMessage(failure)));
  }, [open, project.id]);
  useEffect(() => () => searchController.current?.abort(), []);

  const perform = async (key: string, operation: () => Promise<void>) => {
    setBusy(key);
    setError("");
    setMessage("");
    try { await operation(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(null); }
  };

  const search = async () => {
    if (!query.trim() || busy === "search") return;
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    setBusy("search"); setError(""); setMessage("");
    try {
      const result = await api.research.search(project.id, query, controller.signal);
      setProviderResults(result.run.providers ?? []);
      setLatestRun(result.run);
      await load();
      const failed = result.run.providers?.filter((item) => item.status === "failed").length ?? 0;
      setMessage(result.run.status === "failed" ? result.run.error || "全部文献服务均不可用。" : `文献检索完成，共 ${result.works.length} 个结果${failed ? `；${failed} 个服务 不可用` : ""}.`);
    } catch (failure) {
      if ((failure as DOMException).name === "AbortError") setMessage("已取消文献检索，未批准结果或写入论文。");
      else setError(errorMessage(failure));
    } finally {
      if (searchController.current === controller) searchController.current = null;
      setBusy(null);
    }
  };

  const saveProtocol = () => perform("protocol:save", async () => {
    if (!latestRun) throw new Error("请先检索文献，再编辑检索方案。");
    const split = (value: string) => value.split(/\n|;/).map((item) => item.trim()).filter(Boolean);
    const updated = await api.research.updatePlan(project.id, latestRun.id, { steps: split(protocol.steps), rationale: protocol.rationale, inclusionCriteria: split(protocol.inclusionCriteria), exclusionCriteria: split(protocol.exclusionCriteria), extractionFields: split(protocol.extractionFields) });
    setLatestRun(updated); setProtocolOpen(false); setMessage("检索方案已随本次检索记录保存。");
  });

  const importBundles = (manifestPath?: string) => perform(`bundle:${manifestPath ?? "all"}`, async () => {
    const results = await api.research.importFastReadBundles(project.id, manifestPath);
    await load();
    const failed = results.filter((item) => item.status === "failed");
    if (failed.length) setError(failed.map((item) => item.error || `${item.bundleId} 失败`).join(" "));
    else setMessage(`${results.length} 个 FastRead 资料包 已导入并建立索引。`);
  });

  const approveWork = (work: ResearchWorkView) => perform(`work:${work.id}`, async () => {
    const citationKey = work.project.citationKey || `${(work.authors[0] || "ref").replace(/[^A-Za-z]/g, "").toLowerCase()}${work.year || ""}`;
    await api.research.approve(project.id, work.id, { status: "saved", citationKey });
    await load();
    setMessage(`已批准 ${citationKey}。`);
  });

  const verifyMetadata = (work: ResearchWorkView) => perform(`verify:${work.id}`, async () => {
    const updated = await api.research.verifyMetadata(project.id, work.id);
    setWorks((items) => items.map((item) => item.id === updated.id ? { ...item, ...updated } : item));
    setMessage(`${updated.metadataStatus === "verified" ? "元数据已核实" : "检测到元数据冲突"}: ${work.title}`);
  });

  const importManualSource = () => perform("manual:import", async () => {
    if (!manualSource.title.trim()) throw new Error("请填写文献标题。");
    const year = manualSource.year.trim() ? Number.parseInt(manualSource.year, 10) : undefined;
    if (year !== undefined && (!Number.isInteger(year) || year < 1000 || year > 3000)) throw new Error("请填写有效的发表年份。");
    await api.research.import(project.id, {
      title: manualSource.title.trim(),
      authors: manualSource.authors.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean),
      ...(year !== undefined ? { year } : {}),
      ...(manualSource.venue.trim() ? { venue: manualSource.venue.trim() } : {}),
      ...(manualSource.doi.trim() ? { doi: manualSource.doi.trim() } : {}),
      ...(manualSource.arxiv.trim() ? { arxiv: manualSource.arxiv.trim() } : {}),
      ...(manualSource.citationKey.trim() ? { citationKey: manualSource.citationKey.trim() } : {})
    });
    setManualSource(EMPTY_MANUAL_SOURCE); setManualOpen(false); await load(); setMessage("已保存手动添加的文献及来源记录，请审核后再应用 BibTeX。");
  });

  const inspectCitations = (work: ResearchWorkView) => perform(`context:${work.id}`, async () => {
    const key = work.project.citationKey;
    if (!key) throw new Error("定位稿件引用前，请先确认引用标识。");
    const context = await api.research.citationContext(project.id, key);
    setCitationContexts((current) => ({ ...current, [work.id]: context }));
  });

  const proposeBibtex = (work: ResearchWorkView) => perform(`bibtex:${work.id}`, async () => {
    setPendingBibtex(await api.research.bibtexChange(project.id, work.id, bibPath));
  });

  const applyBibtex = () => perform("bibtex:apply", async () => {
    if (!pendingBibtex) return;
    await api.revisions.accept(project.id, pendingBibtex.id);
    setMessage(`已将 ${pendingBibtex.summary} 应用到 ${pendingBibtex.changes[0]?.path}。`);
    setPendingBibtex(null);
    await load();
    onChanged?.();
  });

  const updateEvidence = (item: SourceEvidence, status: SourceEvidence["status"]) => perform(`evidence:${item.id}`, async () => {
    await api.claims.updateEvidence(project.id, item.id, { status });
    await load();
  });

  const saveStance = (item: SourceEvidence, stance: NonNullable<SourceEvidence["stance"]>) => perform(`引用立场：${item.id}`, async () => {
    await api.claims.updateEvidence(project.id, item.id, { stance });
    await load();
  });

  const saveRepresentation = (item: SourceEvidence, representation: SourceEvidence["representation"]) => perform(`representation:${item.id}`, async () => {
    await api.claims.updateEvidence(project.id, item.id, { representation });
    await load();
  });

  const importPdf = (file: File | undefined) => perform("pdf:import", async () => {
    if (!pdfAuthorized) throw new Error("请先确认你有权处理此 PDF。");
    if (!pdfWorkId) throw new Error("导入 PDF 前，请选择已确认的文献。");
    if (!file) throw new Error("请选择 PDF 文件。");
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) throw new Error("请选择 PDF 文件。");
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunk, bytes.length)));
    await api.research.pdfEvidence(project.id, pdfWorkId, btoa(binary));
    await load();
    setMessage("PDF 页面已作为候选证据导入，请逐页审核后再批准。");
  });

  const scanClaims = () => perform("claims:scan", async () => {
    const next = await api.claims.scan(project.id);
    await load();
    setMessage(`${next.length} 个稿件论断 已检测到，已有论断将保留证据关联。`);
  });

  const linkEvidence = (claim: PaperClaim) => perform(`claim:${claim.id}`, async () => {
    const evidenceId = evidenceChoice[claim.id];
    if (!evidenceId) throw new Error("请先选择已批准的证据。");
    const item = evidence.find((candidate) => candidate.id === evidenceId);
    const citationKey = item ? workById.get(item.workId)?.project.citationKey : undefined;
    await api.claims.linkEvidence(project.id, claim.id, evidenceId, citationKey);
    await load();
  });

  const addWaiver = (claim: PaperClaim) => perform(`waiver:${claim.id}`, async () => {
    const reason = waiverReasons[claim.id]?.trim() ?? "";
    if (reason.length < 8) throw new Error("请填写至少 8 个字符，说明审稿豁免原因。");
    await api.claims.linkWaiver(project.id, claim.id, reason);
    setWaiverReasons((current) => ({ ...current, [claim.id]: "" }));
    await load();
  });

  const markSupported = (claim: PaperClaim) => perform(`support:${claim.id}`, async () => {
    await api.claims.update(project.id, claim.id, { reviewStatus: "supported" });
    await load();
  });

  return <Dialog open={open} width="wide" className="research-dialog" title="文献与证据" description="FastRead 导入 → 已批准证据 → 稿件论断 → BibTeX" onClose={onClose}>
    <div className="research-panel">
      {/*
        Not a step timeline: a legend of three counts, one boolean each. `chain`
        is the variant for that — no current step, no failure state.
      */}
      <Stepper variant="chain" label="证据工作流" steps={[
        { id: "sources", label: "1. 文献", status: bundles.some((item) => item.status === "imported") ? "complete" : "pending", icon: <Icon name={icons.book} />, value: works.length },
        { id: "evidence", label: "2. 证据", status: approvedEvidence.length ? "complete" : "pending", icon: <Icon name={icons.passFilled} />, value: approvedEvidence.length },
        { id: "claims", label: "3. 论断", status: claims.some((claim) => claim.reviewStatus === "supported") ? "complete" : "pending", icon: <Icon name={icons.verified} />, value: claims.length }
      ]} />
      <nav className="research-tabs" aria-label="文献研究模块">
        <Button variant="ghost" aria-current={tab === "sources" ? "page" : undefined} onClick={() => setTab("sources")}>文献 <span>{works.length}</span></Button>
        <Button variant="ghost" aria-current={tab === "evidence" ? "page" : undefined} onClick={() => setTab("evidence")}>证据 <span>{evidence.length}</span></Button>
        <Button variant="ghost" aria-current={tab === "claims" ? "page" : undefined} onClick={() => setTab("claims")}>论断 <span>{claims.length}</span></Button>
      </nav>

      {message ? <p className="research-notice" role="status"><Icon name={icons.passFilled} />{message}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}

      {tab === "sources" ? <div className="research-view">
        <section className="research-section">
          <header><div><h3>FastRead 导入</h3><p>完整资料包经 SHA-256 校验后导入，重复导入不会产生副本，失败后仍可重试。</p></div><Button size="small" icon={<Icon name={icons.refresh} />} loading={busy === "bundle:all"} onClick={() => void importBundles()}>导入已检测到的资料</Button></header>
          <div className="research-bundles">
            {bundles.length ? bundles.map((bundle) => <article key={bundle.id} className={`research-bundle is-${bundle.status}`}>
              <div><strong>{bundle.bundleId}</strong><small>{bundle.manifestPath}</small></div><span>{statusLabel(bundle.status)}</span>
              <p>{bundle.status === "imported" ? `${bundle.workIds.length} 篇论文 · ${bundle.evidenceIds.length} 条原文摘录` : bundle.error || "准备导入"}</p>
              {bundle.status !== "imported" ? <Button size="small" loading={busy === `bundle:${bundle.manifestPath}`} onClick={() => void importBundles(bundle.manifestPath)}>重试导入</Button> : null}
            </article>) : <div className="research-empty"><Icon name={icons.book} /><strong>未检测到 FastRead 资料包</strong><span>将 FastRead 资料包放入 references/fastread/&lt;bundle&gt;/，清单文件会触发自动导入。</span></div>}
          </div>
        </section>

        <section className="research-section">
          <header><div><h3>学术文献</h3><p>保留检索结果的来源和各服务失败记录，离线时仍可手动导入。</p></div><div><Button size="small" variant="ghost" icon={<Icon name={icons.listTree} />} onClick={() => { const plan = latestRun?.queryPlan; setProtocol({ steps: plan?.steps.join("\n") ?? "查找相关文献", rationale: plan?.rationale ?? "", inclusionCriteria: plan?.inclusionCriteria?.join("\n") ?? "", exclusionCriteria: plan?.exclusionCriteria?.join("\n") ?? "", extractionFields: plan?.extractionFields?.join("\n") ?? "" }); setProtocolOpen((value) => !value); }}>检索方案</Button><Button size="small" variant="ghost" icon={<Icon name={icons.newFile} />} onClick={() => setManualOpen((value) => !value)}>手动添加</Button></div></header>
          {protocolOpen ? <div className="research-protocol"><Field label="检索步骤"><TextArea value={protocol.steps} onChange={(value) => setProtocol((current) => ({ ...current, steps: value }))} placeholder="每行填写一个步骤" /></Field><Field label="理由"><TextArea value={protocol.rationale} onChange={(value) => setProtocol((current) => ({ ...current, rationale: value }))} /></Field><div className="form-grid"><Field label="纳入标准"><TextArea value={protocol.inclusionCriteria} onChange={(value) => setProtocol((current) => ({ ...current, inclusionCriteria: value }))} placeholder="经过同行评审；2020 年及以后" /></Field><Field label="排除标准"><TextArea value={protocol.exclusionCriteria} onChange={(value) => setProtocol((current) => ({ ...current, exclusionCriteria: value }))} placeholder="已撤稿；不在研究范围内" /></Field></div><Field label="提取字段"><TextArea value={protocol.extractionFields} onChange={(value) => setProtocol((current) => ({ ...current, extractionFields: value }))} placeholder="研究对象；方法；结果" /></Field><div><Button size="small" variant="ghost" onClick={() => setProtocolOpen(false)}>取消</Button><Button size="small" loading={busy === "protocol:save"} onClick={() => void saveProtocol()}>保存方案</Button></div></div> : null}
          {manualOpen ? <div className="research-manual-source" aria-label="手动导入文献">
            <Field label="标题 *"><TextField value={manualSource.title} onChange={(next) => setManualSource((current) => ({ ...current, title: next }))} /></Field>
            <Field label="作者"><TextField value={manualSource.authors} onChange={(next) => setManualSource((current) => ({ ...current, authors: next }))} placeholder="Ada Lovelace, Alan Turing" /></Field>
            <Field label="年份"><TextField value={manualSource.year} onChange={(next) => setManualSource((current) => ({ ...current, year: next }))} inputMode="numeric" /></Field>
            <Field label="会议或期刊"><TextField value={manualSource.venue} onChange={(next) => setManualSource((current) => ({ ...current, venue: next }))} /></Field>
            <Field label="DOI"><TextField value={manualSource.doi} onChange={(next) => setManualSource((current) => ({ ...current, doi: next }))} /></Field>
            <Field label="arXiv"><TextField value={manualSource.arxiv} onChange={(next) => setManualSource((current) => ({ ...current, arxiv: next }))} /></Field>
            <Field label="引用标识"><TextField value={manualSource.citationKey} onChange={(next) => setManualSource((current) => ({ ...current, citationKey: next }))} /></Field>
            <div><Button size="small" variant="ghost" onClick={() => { setManualOpen(false); setManualSource(EMPTY_MANUAL_SOURCE); }}>取消</Button><Button size="small" loading={busy === "manual:import"} onClick={() => void importManualSource()}>保存文献</Button></div>
          </div> : null}
          <div className="research-search"><Icon name={icons.search} /><TextField aria-label="搜索学术文献" value={query} onChange={setQuery} placeholder="搜索 Crossref、OpenAlex、Semantic Scholar、arXiv" onKeyDown={(event) => { if (event.key === "Enter") void search(); }} />{busy === "search" ? <Button variant="ghost" onClick={() => searchController.current?.abort()}>取消搜索</Button> : <Button onClick={() => void search()}>搜索</Button>}</div>
          {providerResults?.length ? <div className="research-provider-results" aria-label="文献服务状态">{providerResults.map((item) => <span key={item.provider} className={`is-${item.status}`} title={item.error}>{item.status === "failed" ? <Icon name={icons.warning} /> : <Icon name={icons.passFilled} />}<strong>{providerLabel(item.provider)}</strong>{item.status === "completed" ? `${item.resultCount} 个结果` : item.error || "失败"}</span>)}</div> : null}
          <div className="research-results">{works.length ? works.map((work) => {
            const context = citationContexts[work.id];
            const providers = [...new Set(work.metadataObservations.map((item) => item.provider))];
            return <article key={work.id}>
              <div className="research-work-title"><strong>{work.title}</strong><span className={`research-status is-${work.project.status}`}>{statusLabel(work.project.status)}</span></div>
              <small>{work.authors.join(", ") || "作者未核实"} · {work.year ?? "年份未核实"} · {work.venue ?? "会议或期刊未核实"}</small>
              <div className="research-source-provenance">{work.metadataStatus === "conflicting" ? <span className="is-conflict"><Icon name={icons.warning} />元数据冲突</span> : null}{providers.map((provider) => <span key={provider}>{providerLabel(provider)}</span>)}{work.identifiers.slice(0, 3).map((identifier) => <code key={`${identifier.scheme}:${identifier.value}`}>{identifier.scheme}: {identifier.value}</code>)}</div>
              {work.publicationStatus === "retracted" ? <strong className="text-danger">已撤稿，请勿在没有明确理由的情况下引用。</strong> : work.publicationStatus === "corrected" ? <strong className="text-warning">存在更正或勘误。</strong> : null}
              <div className="research-work-actions">
                {latestRun ? <div className="research-screening"><Select aria-label={`文献筛选决定： ${work.title}`} value={screening[work.id]?.decision ?? "uncertain"} onChange={(next) => { const decision = next as "included" | "excluded" | "uncertain"; const reason = screening[work.id]?.reason ?? ""; setScreening((current) => ({ ...current, [work.id]: { decision, reason } })); void saveScreening(work, decision, reason); }} options={[{ value: "uncertain", label: "筛选：待确定" }, { value: "included", label: "筛选：纳入" }, { value: "excluded", label: "筛选：排除" }]} /><TextField aria-label={`文献筛选原因： ${work.title}`} value={screening[work.id]?.reason ?? ""} onChange={(reason) => setScreening((current) => ({ ...current, [work.id]: { decision: current[work.id]?.decision ?? "uncertain", reason } }))} onBlur={() => { const record = screening[work.id]; if (record) void saveScreening(work, record.decision, record.reason); }} placeholder="理由或提取记录" /></div> : null}
                <Button size="small" variant="ghost" loading={busy === `verify:${work.id}`} onClick={() => void verifyMetadata(work)}>核实 DOI</Button>
                {work.project.status === "saved" ? <em>已批准 · {work.project.citationKey || "引用标识待确认"}</em> : <Button size="small" loading={busy === `work:${work.id}`} onClick={() => void approveWork(work)}>批准元数据</Button>}
                {work.project.status === "saved" ? <><Button size="small" variant="ghost" loading={busy === `context:${work.id}`} onClick={() => void inspectCitations(work)}>查找引用</Button><Button size="small" variant="ghost" loading={busy === `bibtex:${work.id}`} onClick={() => void proposeBibtex(work)}>生成 BibTeX 建议</Button></> : null}
              </div>
              {context ? <div className="research-citation-context"><strong>稿件引用上下文 · {context.key}</strong>{context.contexts.length ? context.contexts.map((item, index) => <Button variant="ghost" key={`${item.path}:${item.line}:${index}`} onClick={() => { onClose(); onNavigate?.(item.path, item.line); }}><Icon name={icons.pin} /><span>{item.path}:{item.line}</span><small>{item.excerpt}</small></Button>) : <p>尚无引用命令使用此标识。</p>}{context.bibliography ? <small>BibTeX： {context.bibliography.path}:{context.bibliography.line}</small> : null}</div> : null}
            </article>;
          }) : <div className="research-empty"><Icon name={icons.search} /><strong>暂无文献</strong><span>导入 FastRead 资料包、手动添加，或通过学术服务检索。</span></div>}</div>
        </section>

        <section className="research-section research-bibtex-target"><Field label="论文参考文献目标文件"><TextField list="research-bib-paths" value={bibPath} onChange={setBibPath} /></Field><datalist id="research-bib-paths">{bibPaths.map((path) => <option value={path} key={path} />)}</datalist><small>若文件不存在，批准后将通过更改集工作流创建。</small></section>
        {pendingBibtex ? <section className="research-bibtex-review"><header><div><h3>审核 BibTeX 更改集</h3><p>{pendingBibtex.summary}</p></div><span>需明确批准</span></header><pre>{pendingBibtex.changes[0]?.after}</pre><div><Button variant="ghost" onClick={() => setPendingBibtex(null)}>取消</Button><Button loading={busy === "bibtex:apply"} onClick={() => void applyBibtex()}>应用到论文</Button></div></section> : null}
      </div> : null}

      {tab === "evidence" ? <div className="research-view"><section className="research-section"><header><div><h3>证据阅读器</h3><p>仅处理你有权使用的论文。PDF 页面将成为带来源哈希的候选证据，仍需明确批准。</p></div></header><div className="research-reader-controls"><Field label="已批准的文献"><Select value={pdfWorkId} onChange={setPdfWorkId} options={[{ value: "", label: "选择已保存的文献…" }, ...works.filter((work) => work.project.status === "saved").map((work) => ({ value: work.id, label: work.title }))]} /></Field><Checkbox className="checkbox-field" checked={pdfAuthorized} onChange={setPdfAuthorized}>我有权处理此 PDF 及其摘录。</Checkbox><FileField label="导入已授权 PDF" accept="application/pdf,.pdf" disabled={!pdfAuthorized || !pdfWorkId || busy === "pdf:import"} onSelect={(files) => { void importPdf(files[0]); }} /></div><div className="research-evidence-list">
        {evidence.length ? evidence.map((item) => <article key={item.id}>
          <header><span className={`research-status is-${item.status}`}>{statusLabel(item.status)}</span><strong>{workById.get(item.workId)?.title || "未知来源"}</strong><small>{statusLabel(item.locatorType)} {item.locator}</small>{item.stance ? <span className={`research-status is-${item.stance}`}>引用立场： {statusLabel(item.stance)}</span> : null}</header>
          <blockquote>{item.content}</blockquote>
          <footer><span>{item.fastReadBundleId ? `FastRead ${item.fastReadBundleId}` : statusLabel(item.origin)}{item.sourceHash ? ` · 哈希 ${item.sourceHash.slice(0, 12)}…` : ""}</span><div><Select aria-label={`证据表达形式： ${item.content.slice(0, 40)}`} value={evidenceRepresentation[item.id] ?? item.representation} onChange={(next) => { const representation = next as SourceEvidence["representation"]; setEvidenceRepresentation((current) => ({ ...current, [item.id]: representation })); void saveRepresentation(item, representation); }} options={[{ value: "verbatim", label: "原文摘录" }, { value: "paraphrase", label: "转述" }]} /><Select aria-label={`引用立场： ${item.content.slice(0, 40)}`} value={evidenceStance[item.id] ?? item.stance ?? "unknown"} onChange={(next) => { const stance = next as NonNullable<SourceEvidence["stance"]>; setEvidenceStance((current) => ({ ...current, [item.id]: stance })); void saveStance(item, stance); }} options={[{ value: "unknown", label: "立场未知" }, { value: "supports", label: "支持" }, { value: "contradicts", label: "反驳" }, { value: "mentions", label: "提及" }]} />{item.status !== "rejected" ? <Button size="small" variant="ghost" loading={busy === `evidence:${item.id}`} onClick={() => void updateEvidence(item, "rejected")}>拒绝</Button> : null}{item.status !== "approved" ? <Button size="small" loading={busy === `evidence:${item.id}`} onClick={() => void updateEvidence(item, "approved")}>批准</Button> : null}</div></footer>
        </article>) : <div className="research-empty"><Icon name={icons.passFilled} /><strong>暂无证据</strong><span>导入 FastRead 原文摘录，或从已批准文献中添加证据。</span></div>}
      </div></section></div> : null}

      {tab === "claims" ? <div className="research-view"><section className="research-section"><header><div><h3>论断与证据关联</h3><p>扫描稿件论断、关联已批准证据，再标记论断已获支持。</p></div><Button size="small" icon={<Icon name={icons.searchFuzzy} />} loading={busy === "claims:scan"} onClick={() => void scanClaims()}>扫描稿件</Button></header><div className="research-claims-list">
        {citationReviewer ? <div className="research-notice" role="status"><Icon name={icons.verified} /><span>引用审核： {citationReviewer.counts.cited}/{citationReviewer.counts.total} 项已引用 · {citationReviewer.counts.supported} 项已支持 · {citationReviewer.counts.missing} 项缺少引用 · {citationReviewer.counts.unresolved} 项未核实锚点</span></div> : null}
        {claims.length ? claims.map((claim) => {
          const claimLinks = links.filter((link) => link.claimId === claim.id);
          const reviewItem = citationReviewer?.items.find((item) => item.claim.id === claim.id);
          return <article key={claim.id}>
            <header><span className={`research-status is-${claim.reviewStatus}`}>{statusLabel(claim.reviewStatus)}</span><strong>{statusLabel(claim.type)}</strong><small>{claim.anchor.path} · {statusLabel(claim.anchorStatus)}</small></header>
            <blockquote>{claim.anchor.exactText}</blockquote>
            {reviewItem ? <div className="research-claim-review-status"><span className={`research-status is-${reviewItem.citationStatus}`}>引用： {statusLabel(reviewItem.citationStatus)}</span><span className={`research-status is-${reviewItem.evidenceStatus}`}>证据： {statusLabel(reviewItem.evidenceStatus)}</span><span>元数据 {reviewItem.metadataVerifiedCount} 项已核实 · {reviewItem.metadataConflictCount} 项冲突</span></div> : null}
            {claimLinks.length ? <div className="research-linked-evidence">{claimLinks.map((link) => {
              const item = link.kind === "literature" ? evidence.find((candidate) => candidate.id === link.evidenceId) : undefined;
              const label = link.kind === "literature" ? (item ? `${statusLabel(item.locatorType)} ${item.locator}: ${item.content.slice(0, 90)}` : link.evidenceId) : link.kind === "review-waiver" ? `用户豁免： ${link.reason}` : `工作区 ${link.path}: ${link.anchor.exactText.slice(0, 90)}`;
              return <span key={link.id}><Icon name={icons.link} />{label}<IconButton label="解除论断支持关联" icon="×" onClick={() => void perform(`unlink:${link.id}`, async () => { await api.claims.unlinkEvidence(project.id, claim.id, link.id); await load(); })} /></span>;
            })}</div> : null}
            <footer><Select aria-label={`关联证据： ${claim.anchor.exactText}`} value={evidenceChoice[claim.id] ?? ""} onChange={(next) => setEvidenceChoice((current) => ({ ...current, [claim.id]: next }))} options={[{ value: "", label: "选择已批准证据…" }, ...approvedEvidence.map((item) => ({ value: item.id, label: `${workById.get(item.workId)?.project.citationKey || "source"} · p.${item.locator} · ${item.content.slice(0, 70)}` }))]} /><Button size="small" variant="ghost" icon={<Icon name={icons.link} />} loading={busy === `claim:${claim.id}`} onClick={() => void linkEvidence(claim)}>关联</Button>{claim.anchorStatus === "stale" || claim.anchorStatus === "orphaned" ? <Button size="small" variant="ghost" loading={busy === `reanchor:${claim.id}`} onClick={() => void perform(`reanchor:${claim.id}`, async () => { await api.claims.reanchor(project.id, claim.id); await load(); })}>重新定位锚点</Button> : null}<Button size="small" disabled={!claimLinks.length || claim.reviewStatus === "supported" || claim.anchorStatus === "stale" || claim.anchorStatus === "orphaned"} loading={busy === `support:${claim.id}`} onClick={() => void markSupported(claim)}>标记已获支持</Button></footer>
            <div className="research-waiver"><TextField aria-label={`豁免原因： ${claim.anchor.exactText}`} value={waiverReasons[claim.id] ?? ""} onChange={(next) => setWaiverReasons((current) => ({ ...current, [claim.id]: next }))} placeholder="填写明确的审稿豁免原因…" /><Button size="small" variant="ghost" loading={busy === `waiver:${claim.id}`} onClick={() => void addWaiver(claim)}>添加豁免</Button></div>
          </article>;
        }) : <div className="research-empty"><Icon name={icons.searchFuzzy} /><strong>尚未扫描论断</strong><span>扫描当前 TeX 工作区以创建稳定的论断锚点。</span></div>}
      </div></section></div> : null}
    </div>
  </Dialog>;
}

function bibliographyPaths(nodes: WorkspaceTreeNode[]): string[] {
  return nodes.flatMap((node) => node.type === "directory" ? bibliographyPaths(node.children) : node.kind === "text" && /\.bib$/i.test(node.path) && !node.path.startsWith("references/fastread/") ? [node.path] : []).sort();
}

function providerLabel(provider: string): string {
  return ({ crossref: "Crossref", openalex: "OpenAlex", "semantic-scholar": "Semantic Scholar", arxiv: "arXiv", fastread: "FastRead", user: "用户", publisher: "出版社", cache: "缓存" } as Record<string, string>)[provider] ?? provider;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "文献请求失败";
}
