import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeSet, ClaimEvidenceLink, CitationReviewer, FastReadBundleReceipt, PaperClaim, PaperProject, ProjectResearchWorkDetails, ResearchRun, SourceEvidence, WorkspaceTreeNode } from "@fastwrite/shared";
import { api } from "../../api/client";
import { Button, Dialog, Field, Icon, IconButton, Select, Stepper, TextArea, TextField, icons } from "../ui";

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
    if (!latestRun) throw new Error("Run a research query before screening results.");
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
      setMessage(result.run.status === "failed" ? result.run.error || "All research providers failed." : `Research completed with ${result.works.length} result${result.works.length === 1 ? "" : "s"}${failed ? `; ${failed} provider${failed === 1 ? "" : "s"} unavailable` : ""}.`);
    } catch (failure) {
      if ((failure as DOMException).name === "AbortError") setMessage("Research cancelled. No result was approved or written to the paper.");
      else setError(errorMessage(failure));
    } finally {
      if (searchController.current === controller) searchController.current = null;
      setBusy(null);
    }
  };

  const saveProtocol = () => perform("protocol:save", async () => {
    if (!latestRun) throw new Error("Run a research query before editing its protocol.");
    const split = (value: string) => value.split(/\n|;/).map((item) => item.trim()).filter(Boolean);
    const updated = await api.research.updatePlan(project.id, latestRun.id, { steps: split(protocol.steps), rationale: protocol.rationale, inclusionCriteria: split(protocol.inclusionCriteria), exclusionCriteria: split(protocol.exclusionCriteria), extractionFields: split(protocol.extractionFields) });
    setLatestRun(updated); setProtocolOpen(false); setMessage("Research protocol saved with the query run.");
  });

  const importBundles = (manifestPath?: string) => perform(`bundle:${manifestPath ?? "all"}`, async () => {
    const results = await api.research.importFastReadBundles(project.id, manifestPath);
    await load();
    const failed = results.filter((item) => item.status === "failed");
    if (failed.length) setError(failed.map((item) => item.error || `${item.bundleId} failed`).join(" "));
    else setMessage(`${results.length} FastRead bundle${results.length === 1 ? "" : "s"} imported and indexed.`);
  });

  const approveWork = (work: ResearchWorkView) => perform(`work:${work.id}`, async () => {
    const citationKey = work.project.citationKey || `${(work.authors[0] || "ref").replace(/[^A-Za-z]/g, "").toLowerCase()}${work.year || ""}`;
    await api.research.approve(project.id, work.id, { status: "saved", citationKey });
    await load();
    setMessage(`Approved ${citationKey}.`);
  });

  const verifyMetadata = (work: ResearchWorkView) => perform(`verify:${work.id}`, async () => {
    const updated = await api.research.verifyMetadata(project.id, work.id);
    setWorks((items) => items.map((item) => item.id === updated.id ? { ...item, ...updated } : item));
    setMessage(`${updated.metadataStatus === "verified" ? "Metadata verified" : "Metadata conflict detected"}: ${work.title}`);
  });

  const importManualSource = () => perform("manual:import", async () => {
    if (!manualSource.title.trim()) throw new Error("Enter a source title.");
    const year = manualSource.year.trim() ? Number.parseInt(manualSource.year, 10) : undefined;
    if (year !== undefined && (!Number.isInteger(year) || year < 1000 || year > 3000)) throw new Error("Enter a valid publication year.");
    await api.research.import(project.id, {
      title: manualSource.title.trim(),
      authors: manualSource.authors.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean),
      ...(year !== undefined ? { year } : {}),
      ...(manualSource.venue.trim() ? { venue: manualSource.venue.trim() } : {}),
      ...(manualSource.doi.trim() ? { doi: manualSource.doi.trim() } : {}),
      ...(manualSource.arxiv.trim() ? { arxiv: manualSource.arxiv.trim() } : {}),
      ...(manualSource.citationKey.trim() ? { citationKey: manualSource.citationKey.trim() } : {})
    });
    setManualSource(EMPTY_MANUAL_SOURCE); setManualOpen(false); await load(); setMessage("Manual source saved with user provenance. Review it before applying BibTeX.");
  });

  const inspectCitations = (work: ResearchWorkView) => perform(`context:${work.id}`, async () => {
    const key = work.project.citationKey;
    if (!key) throw new Error("Approve a citation key before locating manuscript citations.");
    const context = await api.research.citationContext(project.id, key);
    setCitationContexts((current) => ({ ...current, [work.id]: context }));
  });

  const proposeBibtex = (work: ResearchWorkView) => perform(`bibtex:${work.id}`, async () => {
    setPendingBibtex(await api.research.bibtexChange(project.id, work.id, bibPath));
  });

  const applyBibtex = () => perform("bibtex:apply", async () => {
    if (!pendingBibtex) return;
    await api.revisions.accept(project.id, pendingBibtex.id);
    setMessage(`Applied ${pendingBibtex.summary} to ${pendingBibtex.changes[0]?.path}.`);
    setPendingBibtex(null);
    await load();
    onChanged?.();
  });

  const updateEvidence = (item: SourceEvidence, status: SourceEvidence["status"]) => perform(`evidence:${item.id}`, async () => {
    await api.claims.updateEvidence(project.id, item.id, { status });
    await load();
  });

  const saveStance = (item: SourceEvidence, stance: NonNullable<SourceEvidence["stance"]>) => perform(`stance:${item.id}`, async () => {
    await api.claims.updateEvidence(project.id, item.id, { stance });
    await load();
  });

  const saveRepresentation = (item: SourceEvidence, representation: SourceEvidence["representation"]) => perform(`representation:${item.id}`, async () => {
    await api.claims.updateEvidence(project.id, item.id, { representation });
    await load();
  });

  const importPdf = (file: File | undefined) => perform("pdf:import", async () => {
    if (!pdfAuthorized) throw new Error("Confirm that you are authorized to process this PDF first.");
    if (!pdfWorkId) throw new Error("Choose an approved source before importing a PDF.");
    if (!file) throw new Error("Choose a PDF file.");
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) throw new Error("Choose a PDF file.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunk, bytes.length)));
    await api.research.pdfEvidence(project.id, pdfWorkId, btoa(binary));
    await load();
    setMessage("PDF pages imported as candidate evidence. Review each page before approval.");
  });

  const scanClaims = () => perform("claims:scan", async () => {
    const next = await api.claims.scan(project.id);
    await load();
    setMessage(`${next.length} manuscript claim${next.length === 1 ? "" : "s"} detected. Stable claims keep their evidence links.`);
  });

  const linkEvidence = (claim: PaperClaim) => perform(`claim:${claim.id}`, async () => {
    const evidenceId = evidenceChoice[claim.id];
    if (!evidenceId) throw new Error("Choose approved evidence first.");
    const item = evidence.find((candidate) => candidate.id === evidenceId);
    const citationKey = item ? workById.get(item.workId)?.project.citationKey : undefined;
    await api.claims.linkEvidence(project.id, claim.id, evidenceId, citationKey);
    await load();
  });

  const addWaiver = (claim: PaperClaim) => perform(`waiver:${claim.id}`, async () => {
    const reason = waiverReasons[claim.id]?.trim() ?? "";
    if (reason.length < 8) throw new Error("Explain the review waiver in at least 8 characters.");
    await api.claims.linkWaiver(project.id, claim.id, reason);
    setWaiverReasons((current) => ({ ...current, [claim.id]: "" }));
    await load();
  });

  const markSupported = (claim: PaperClaim) => perform(`support:${claim.id}`, async () => {
    await api.claims.update(project.id, claim.id, { reviewStatus: "supported" });
    await load();
  });

  return <Dialog open={open} width="wide" className="research-dialog" title="Research & Evidence" description="FastRead handoff → approved evidence → manuscript claims → BibTeX" onClose={onClose}>
    <div className="research-panel">
      {/*
        Not a step timeline: a legend of three counts, one boolean each. `chain`
        is the variant for that — no current step, no failure state.
      */}
      <Stepper variant="chain" label="Evidence workflow" steps={[
        { id: "sources", label: "1. Sources", status: bundles.some((item) => item.status === "imported") ? "complete" : "pending", icon: <Icon name={icons.book} />, value: works.length },
        { id: "evidence", label: "2. Evidence", status: approvedEvidence.length ? "complete" : "pending", icon: <Icon name={icons.passFilled} />, value: approvedEvidence.length },
        { id: "claims", label: "3. Claims", status: claims.some((claim) => claim.reviewStatus === "supported") ? "complete" : "pending", icon: <Icon name={icons.verified} />, value: claims.length }
      ]} />
      <nav className="research-tabs" aria-label="Research sections">
        <Button variant="ghost" aria-current={tab === "sources" ? "page" : undefined} onClick={() => setTab("sources")}>Sources <span>{works.length}</span></Button>
        <Button variant="ghost" aria-current={tab === "evidence" ? "page" : undefined} onClick={() => setTab("evidence")}>Evidence <span>{evidence.length}</span></Button>
        <Button variant="ghost" aria-current={tab === "claims" ? "page" : undefined} onClick={() => setTab("claims")}>Claims <span>{claims.length}</span></Button>
      </nav>

      {message ? <p className="research-notice" role="status"><Icon name={icons.passFilled} />{message}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}

      {tab === "sources" ? <div className="research-view">
        <section className="research-section">
          <header><div><h3>FastRead handoff</h3><p>Manifest-last bundles are verified by SHA-256 and imported idempotently. Failed receipts stay retryable.</p></div><Button size="small" icon={<Icon name={icons.refresh} />} loading={busy === "bundle:all"} onClick={() => void importBundles()}>Import detected</Button></header>
          <div className="research-bundles">
            {bundles.length ? bundles.map((bundle) => <article key={bundle.id} className={`research-bundle is-${bundle.status}`}>
              <div><strong>{bundle.bundleId}</strong><small>{bundle.manifestPath}</small></div><span>{bundle.status}</span>
              <p>{bundle.status === "imported" ? `${bundle.workIds.length} papers · ${bundle.evidenceIds.length} exact quotes` : bundle.error || "Ready to import"}</p>
              {bundle.status !== "imported" ? <Button size="small" loading={busy === `bundle:${bundle.manifestPath}`} onClick={() => void importBundles(bundle.manifestPath)}>Retry import</Button> : null}
            </article>) : <div className="research-empty"><Icon name={icons.book} /><strong>No FastRead bundle detected</strong><span>Finish a FastRead handoff into references/fastread/&lt;bundle&gt;/; the manifest will trigger automatic import.</span></div>}
          </div>
        </section>

        <section className="research-section">
          <header><div><h3>Academic sources</h3><p>Provider results keep their provenance and partial failures stay visible. Manual import remains available offline.</p></div><div><Button size="small" variant="ghost" icon={<Icon name={icons.listTree} />} onClick={() => { const plan = latestRun?.queryPlan; setProtocol({ steps: plan?.steps.join("\n") ?? "Identify relevant literature", rationale: plan?.rationale ?? "", inclusionCriteria: plan?.inclusionCriteria?.join("\n") ?? "", exclusionCriteria: plan?.exclusionCriteria?.join("\n") ?? "", extractionFields: plan?.extractionFields?.join("\n") ?? "" }); setProtocolOpen((value) => !value); }}>Research protocol</Button><Button size="small" variant="ghost" icon={<Icon name={icons.newFile} />} onClick={() => setManualOpen((value) => !value)}>Add manually</Button></div></header>
          {protocolOpen ? <div className="research-protocol"><Field label="Query steps"><TextArea value={protocol.steps} onChange={(value) => setProtocol((current) => ({ ...current, steps: value }))} placeholder="One step per line" /></Field><Field label="Rationale"><TextArea value={protocol.rationale} onChange={(value) => setProtocol((current) => ({ ...current, rationale: value }))} /></Field><div className="form-grid"><Field label="Inclusion criteria"><TextArea value={protocol.inclusionCriteria} onChange={(value) => setProtocol((current) => ({ ...current, inclusionCriteria: value }))} placeholder="Peer-reviewed; 2020 onward" /></Field><Field label="Exclusion criteria"><TextArea value={protocol.exclusionCriteria} onChange={(value) => setProtocol((current) => ({ ...current, exclusionCriteria: value }))} placeholder="Retracted; outside scope" /></Field></div><Field label="Extraction fields"><TextArea value={protocol.extractionFields} onChange={(value) => setProtocol((current) => ({ ...current, extractionFields: value }))} placeholder="Population; method; outcome" /></Field><div><Button size="small" variant="ghost" onClick={() => setProtocolOpen(false)}>Cancel</Button><Button size="small" loading={busy === "protocol:save"} onClick={() => void saveProtocol()}>Save protocol</Button></div></div> : null}
          {manualOpen ? <div className="research-manual-source" aria-label="Manual source import">
            <Field label="Title *"><TextField value={manualSource.title} onChange={(next) => setManualSource((current) => ({ ...current, title: next }))} /></Field>
            <Field label="Authors"><TextField value={manualSource.authors} onChange={(next) => setManualSource((current) => ({ ...current, authors: next }))} placeholder="Ada Lovelace, Alan Turing" /></Field>
            <Field label="Year"><TextField value={manualSource.year} onChange={(next) => setManualSource((current) => ({ ...current, year: next }))} inputMode="numeric" /></Field>
            <Field label="Venue"><TextField value={manualSource.venue} onChange={(next) => setManualSource((current) => ({ ...current, venue: next }))} /></Field>
            <Field label="DOI"><TextField value={manualSource.doi} onChange={(next) => setManualSource((current) => ({ ...current, doi: next }))} /></Field>
            <Field label="arXiv"><TextField value={manualSource.arxiv} onChange={(next) => setManualSource((current) => ({ ...current, arxiv: next }))} /></Field>
            <Field label="Citation key"><TextField value={manualSource.citationKey} onChange={(next) => setManualSource((current) => ({ ...current, citationKey: next }))} /></Field>
            <div><Button size="small" variant="ghost" onClick={() => { setManualOpen(false); setManualSource(EMPTY_MANUAL_SOURCE); }}>Cancel</Button><Button size="small" loading={busy === "manual:import"} onClick={() => void importManualSource()}>Save source</Button></div>
          </div> : null}
          <div className="research-search"><Icon name={icons.search} /><TextField aria-label="Search academic sources" value={query} onChange={setQuery} placeholder="Search Crossref, OpenAlex, Semantic Scholar, arXiv" onKeyDown={(event) => { if (event.key === "Enter") void search(); }} />{busy === "search" ? <Button variant="ghost" onClick={() => searchController.current?.abort()}>Cancel search</Button> : <Button onClick={() => void search()}>Search</Button>}</div>
          {providerResults?.length ? <div className="research-provider-results" aria-label="Research provider status">{providerResults.map((item) => <span key={item.provider} className={`is-${item.status}`} title={item.error}>{item.status === "failed" ? <Icon name={icons.warning} /> : <Icon name={icons.passFilled} />}<strong>{providerLabel(item.provider)}</strong>{item.status === "completed" ? `${item.resultCount} results` : item.error || "failed"}</span>)}</div> : null}
          <div className="research-results">{works.length ? works.map((work) => {
            const context = citationContexts[work.id];
            const providers = [...new Set(work.metadataObservations.map((item) => item.provider))];
            return <article key={work.id}>
              <div className="research-work-title"><strong>{work.title}</strong><span className={`research-status is-${work.project.status}`}>{work.project.status}</span></div>
              <small>{work.authors.join(", ") || "Authors unresolved"} · {work.year ?? "year unresolved"} · {work.venue ?? "venue unresolved"}</small>
              <div className="research-source-provenance">{work.metadataStatus === "conflicting" ? <span className="is-conflict"><Icon name={icons.warning} />metadata conflict</span> : null}{providers.map((provider) => <span key={provider}>{providerLabel(provider)}</span>)}{work.identifiers.slice(0, 3).map((identifier) => <code key={`${identifier.scheme}:${identifier.value}`}>{identifier.scheme}: {identifier.value}</code>)}</div>
              {work.publicationStatus === "retracted" ? <strong className="text-danger">Retracted — do not cite without explicit justification.</strong> : work.publicationStatus === "corrected" ? <strong className="text-warning">Correction or erratum available.</strong> : null}
              <div className="research-work-actions">
                {latestRun ? <div className="research-screening"><Select aria-label={`Screening decision for ${work.title}`} value={screening[work.id]?.decision ?? "uncertain"} onChange={(next) => { const decision = next as "included" | "excluded" | "uncertain"; const reason = screening[work.id]?.reason ?? ""; setScreening((current) => ({ ...current, [work.id]: { decision, reason } })); void saveScreening(work, decision, reason); }} options={[{ value: "uncertain", label: "Screen: uncertain" }, { value: "included", label: "Screen: include" }, { value: "excluded", label: "Screen: exclude" }]} /><TextField aria-label={`Screening reason for ${work.title}`} value={screening[work.id]?.reason ?? ""} onChange={(reason) => setScreening((current) => ({ ...current, [work.id]: { decision: current[work.id]?.decision ?? "uncertain", reason } }))} onBlur={() => { const record = screening[work.id]; if (record) void saveScreening(work, record.decision, record.reason); }} placeholder="Reason / extracted note" /></div> : null}
                <Button size="small" variant="ghost" loading={busy === `verify:${work.id}`} onClick={() => void verifyMetadata(work)}>Verify DOI</Button>
                {work.project.status === "saved" ? <em>Approved · {work.project.citationKey || "key pending"}</em> : <Button size="small" loading={busy === `work:${work.id}`} onClick={() => void approveWork(work)}>Approve metadata</Button>}
                {work.project.status === "saved" ? <><Button size="small" variant="ghost" loading={busy === `context:${work.id}`} onClick={() => void inspectCitations(work)}>Find citations</Button><Button size="small" variant="ghost" loading={busy === `bibtex:${work.id}`} onClick={() => void proposeBibtex(work)}>Propose BibTeX</Button></> : null}
              </div>
              {context ? <div className="research-citation-context"><strong>Manuscript citation context · {context.key}</strong>{context.contexts.length ? context.contexts.map((item, index) => <Button variant="ghost" key={`${item.path}:${item.line}:${index}`} onClick={() => { onClose(); onNavigate?.(item.path, item.line); }}><Icon name={icons.pin} /><span>{item.path}:{item.line}</span><small>{item.excerpt}</small></Button>) : <p>No citation command uses this key yet.</p>}{context.bibliography ? <small>BibTeX: {context.bibliography.path}:{context.bibliography.line}</small> : null}</div> : null}
            </article>;
          }) : <div className="research-empty"><Icon name={icons.search} /><strong>No sources yet</strong><span>Import a FastRead bundle, add one manually, or search academic providers.</span></div>}</div>
        </section>

        <section className="research-section research-bibtex-target"><Field label="Paper bibliography target"><TextField list="research-bib-paths" value={bibPath} onChange={setBibPath} /></Field><datalist id="research-bib-paths">{bibPaths.map((path) => <option value={path} key={path} />)}</datalist><small>If the file does not exist, approval creates it through the ChangeSet workflow.</small></section>
        {pendingBibtex ? <section className="research-bibtex-review"><header><div><h3>Review BibTeX ChangeSet</h3><p>{pendingBibtex.summary}</p></div><span>Explicit approval</span></header><pre>{pendingBibtex.changes[0]?.after}</pre><div><Button variant="ghost" onClick={() => setPendingBibtex(null)}>Cancel</Button><Button loading={busy === "bibtex:apply"} onClick={() => void applyBibtex()}>Apply to paper</Button></div></section> : null}
      </div> : null}

      {tab === "evidence" ? <div className="research-view"><section className="research-section"><header><div><h3>Evidence reader</h3><p>Only process papers you are authorized to use. PDF pages become candidate evidence with a source hash; approval remains explicit.</p></div></header><div className="research-reader-controls"><Field label="Approved source"><Select value={pdfWorkId} onChange={setPdfWorkId} options={[{ value: "", label: "Choose a saved source…" }, ...works.filter((work) => work.project.status === "saved").map((work) => ({ value: work.id, label: work.title }))]} /></Field><label className="checkbox-field"><input type="checkbox" checked={pdfAuthorized} onChange={(event) => setPdfAuthorized(event.target.checked)} /> I am authorized to process this PDF and its excerpts.</label><input aria-label="Import authorized PDF" type="file" accept="application/pdf,.pdf" disabled={!pdfAuthorized || !pdfWorkId || busy === "pdf:import"} onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ""; void importPdf(file); }} /></div><div className="research-evidence-list">
        {evidence.length ? evidence.map((item) => <article key={item.id}>
          <header><span className={`research-status is-${item.status}`}>{item.status}</span><strong>{workById.get(item.workId)?.title || "Unknown source"}</strong><small>{item.locatorType} {item.locator}</small>{item.stance ? <span className={`research-status is-${item.stance}`}>stance: {item.stance}</span> : null}</header>
          <blockquote>{item.content}</blockquote>
          <footer><span>{item.fastReadBundleId ? `FastRead ${item.fastReadBundleId}` : item.origin}{item.sourceHash ? ` · hash ${item.sourceHash.slice(0, 12)}…` : ""}</span><div><Select aria-label={`Evidence representation for ${item.content.slice(0, 40)}`} value={evidenceRepresentation[item.id] ?? item.representation} onChange={(next) => { const representation = next as SourceEvidence["representation"]; setEvidenceRepresentation((current) => ({ ...current, [item.id]: representation })); void saveRepresentation(item, representation); }} options={[{ value: "verbatim", label: "Verbatim" }, { value: "paraphrase", label: "Paraphrase" }]} /><Select aria-label={`Citation stance for ${item.content.slice(0, 40)}`} value={evidenceStance[item.id] ?? item.stance ?? "unknown"} onChange={(next) => { const stance = next as NonNullable<SourceEvidence["stance"]>; setEvidenceStance((current) => ({ ...current, [item.id]: stance })); void saveStance(item, stance); }} options={[{ value: "unknown", label: "Stance unknown" }, { value: "supports", label: "Supports" }, { value: "contradicts", label: "Contradicts" }, { value: "mentions", label: "Mentions" }]} />{item.status !== "rejected" ? <Button size="small" variant="ghost" loading={busy === `evidence:${item.id}`} onClick={() => void updateEvidence(item, "rejected")}>Reject</Button> : null}{item.status !== "approved" ? <Button size="small" loading={busy === `evidence:${item.id}`} onClick={() => void updateEvidence(item, "approved")}>Approve</Button> : null}</div></footer>
        </article>) : <div className="research-empty"><Icon name={icons.passFilled} /><strong>No evidence yet</strong><span>Import FastRead exact quotes or add evidence from an approved source.</span></div>}
      </div></section></div> : null}

      {tab === "claims" ? <div className="research-view"><section className="research-section"><header><div><h3>Claim–evidence map</h3><p>Scan manuscript claims, bind approved evidence, then mark the claim supported.</p></div><Button size="small" icon={<Icon name={icons.searchFuzzy} />} loading={busy === "claims:scan"} onClick={() => void scanClaims()}>Scan manuscript</Button></header><div className="research-claims-list">
        {citationReviewer ? <div className="research-notice" role="status"><Icon name={icons.verified} /><span>Citation review: {citationReviewer.counts.cited}/{citationReviewer.counts.total} cited · {citationReviewer.counts.supported} supported · {citationReviewer.counts.missing} missing citations · {citationReviewer.counts.unresolved} unresolved anchors</span></div> : null}
        {claims.length ? claims.map((claim) => {
          const claimLinks = links.filter((link) => link.claimId === claim.id);
          const reviewItem = citationReviewer?.items.find((item) => item.claim.id === claim.id);
          return <article key={claim.id}>
            <header><span className={`research-status is-${claim.reviewStatus}`}>{claim.reviewStatus}</span><strong>{claim.type}</strong><small>{claim.anchor.path} · {claim.anchorStatus}</small></header>
            <blockquote>{claim.anchor.exactText}</blockquote>
            {reviewItem ? <div className="research-claim-review-status"><span className={`research-status is-${reviewItem.citationStatus}`}>Citation: {reviewItem.citationStatus}</span><span className={`research-status is-${reviewItem.evidenceStatus}`}>Evidence: {reviewItem.evidenceStatus}</span><span>metadata {reviewItem.metadataVerifiedCount} verified · {reviewItem.metadataConflictCount} conflicts</span></div> : null}
            {claimLinks.length ? <div className="research-linked-evidence">{claimLinks.map((link) => {
              const item = link.kind === "literature" ? evidence.find((candidate) => candidate.id === link.evidenceId) : undefined;
              const label = link.kind === "literature" ? (item ? `${item.locatorType} ${item.locator}: ${item.content.slice(0, 90)}` : link.evidenceId) : link.kind === "review-waiver" ? `User waiver: ${link.reason}` : `Workspace ${link.path}: ${link.anchor.exactText.slice(0, 90)}`;
              return <span key={link.id}><Icon name={icons.link} />{label}<IconButton label="Unlink claim support" icon="×" onClick={() => void perform(`unlink:${link.id}`, async () => { await api.claims.unlinkEvidence(project.id, claim.id, link.id); await load(); })} /></span>;
            })}</div> : null}
            <footer><Select aria-label={`Evidence for ${claim.anchor.exactText}`} value={evidenceChoice[claim.id] ?? ""} onChange={(next) => setEvidenceChoice((current) => ({ ...current, [claim.id]: next }))} options={[{ value: "", label: "Choose approved evidence…" }, ...approvedEvidence.map((item) => ({ value: item.id, label: `${workById.get(item.workId)?.project.citationKey || "source"} · p.${item.locator} · ${item.content.slice(0, 70)}` }))]} /><Button size="small" variant="ghost" icon={<Icon name={icons.link} />} loading={busy === `claim:${claim.id}`} onClick={() => void linkEvidence(claim)}>Link</Button>{claim.anchorStatus === "stale" || claim.anchorStatus === "orphaned" ? <Button size="small" variant="ghost" loading={busy === `reanchor:${claim.id}`} onClick={() => void perform(`reanchor:${claim.id}`, async () => { await api.claims.reanchor(project.id, claim.id); await load(); })}>Reanchor</Button> : null}<Button size="small" disabled={!claimLinks.length || claim.reviewStatus === "supported" || claim.anchorStatus === "stale" || claim.anchorStatus === "orphaned"} loading={busy === `support:${claim.id}`} onClick={() => void markSupported(claim)}>Mark supported</Button></footer>
            <div className="research-waiver"><TextField aria-label={`Waiver reason for ${claim.anchor.exactText}`} value={waiverReasons[claim.id] ?? ""} onChange={(next) => setWaiverReasons((current) => ({ ...current, [claim.id]: next }))} placeholder="Explicit review waiver reason…" /><Button size="small" variant="ghost" loading={busy === `waiver:${claim.id}`} onClick={() => void addWaiver(claim)}>Add waiver</Button></div>
          </article>;
        }) : <div className="research-empty"><Icon name={icons.searchFuzzy} /><strong>No claims scanned</strong><span>Scan the current TeX workspace to create stable claim anchors.</span></div>}
      </div></section></div> : null}
    </div>
  </Dialog>;
}

function bibliographyPaths(nodes: WorkspaceTreeNode[]): string[] {
  return nodes.flatMap((node) => node.type === "directory" ? bibliographyPaths(node.children) : node.kind === "text" && /\.bib$/i.test(node.path) && !node.path.startsWith("references/fastread/") ? [node.path] : []).sort();
}

function providerLabel(provider: string): string {
  return ({ crossref: "Crossref", openalex: "OpenAlex", "semantic-scholar": "Semantic Scholar", arxiv: "arXiv", fastread: "FastRead", user: "User", publisher: "Publisher", cache: "Cache" } as Record<string, string>)[provider] ?? provider;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Research request failed";
}
