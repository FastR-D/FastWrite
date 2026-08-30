import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, BookOpen, CheckCircle2, FileCheck2, FilePlus2, Link2, MapPin, RefreshCw, ScanSearch, Search, ShieldCheck } from "lucide-react";
import type { ChangeSet, ClaimEvidenceLink, FastReadBundleReceipt, PaperClaim, PaperProject, ProjectResearchWorkDetails, ResearchRun, SourceEvidence, WorkspaceTreeNode } from "@fastwrite/shared";
import { api } from "../../api/client";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";

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
  const [bibPath, setBibPath] = useState("references.bib");
  const [bibPaths, setBibPaths] = useState<string[]>([]);
  const [pendingBibtex, setPendingBibtex] = useState<ChangeSet | null>(null);
  const [evidenceChoice, setEvidenceChoice] = useState<Record<string, string>>({});
  const [waiverReasons, setWaiverReasons] = useState<Record<string, string>>({});
  const [providerResults, setProviderResults] = useState<ResearchRun["providers"]>([]);
  const [citationContexts, setCitationContexts] = useState<Record<string, CitationContext>>({});
  const [manualOpen, setManualOpen] = useState(false);
  const [manualSource, setManualSource] = useState<ManualSource>(EMPTY_MANUAL_SOURCE);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const searchController = useRef<AbortController | null>(null);

  const workById = useMemo(() => new Map(works.map((work) => [work.id, work])), [works]);
  const approvedEvidence = evidence.filter((item) => item.status === "approved");

  const load = async () => {
    const [nextWorks, nextBundles, nextEvidence, nextClaims, nextLinks, tree] = await Promise.all([
      api.research.works(project.id),
      api.research.fastReadBundles(project.id),
      api.claims.evidence(project.id),
      api.claims.list(project.id),
      api.claims.links(project.id),
      api.projects.tree(project.id)
    ]);
    setWorks(nextWorks);
    setBundles(nextBundles);
    setEvidence(nextEvidence);
    setClaims(nextClaims);
    setLinks(nextLinks);
    const discovered = bibliographyPaths(tree);
    setBibPaths(discovered);
    if (discovered.length && !discovered.includes(bibPath)) setBibPath(discovered[0]!);
  };

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
    await api.claims.updateEvidence(project.id, item.id, status);
    await load();
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
      <ol className="research-chain" aria-label="Evidence workflow">
        <li className={bundles.some((item) => item.status === "imported") ? "is-complete" : ""}><BookOpen /><span>1. Sources</span><strong>{works.length}</strong></li>
        <li className={approvedEvidence.length ? "is-complete" : ""}><FileCheck2 /><span>2. Evidence</span><strong>{approvedEvidence.length}</strong></li>
        <li className={claims.some((claim) => claim.reviewStatus === "supported") ? "is-complete" : ""}><ShieldCheck /><span>3. Claims</span><strong>{claims.length}</strong></li>
      </ol>
      <nav className="research-tabs" aria-label="Research sections">
        <button aria-current={tab === "sources" ? "page" : undefined} onClick={() => setTab("sources")}>Sources <span>{works.length}</span></button>
        <button aria-current={tab === "evidence" ? "page" : undefined} onClick={() => setTab("evidence")}>Evidence <span>{evidence.length}</span></button>
        <button aria-current={tab === "claims" ? "page" : undefined} onClick={() => setTab("claims")}>Claims <span>{claims.length}</span></button>
      </nav>

      {message ? <p className="research-notice" role="status"><CheckCircle2 />{message}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}

      {tab === "sources" ? <div className="research-view">
        <section className="research-section">
          <header><div><h3>FastRead handoff</h3><p>Manifest-last bundles are verified by SHA-256 and imported idempotently. Failed receipts stay retryable.</p></div><Button size="small" icon={<RefreshCw />} loading={busy === "bundle:all"} onClick={() => void importBundles()}>Import detected</Button></header>
          <div className="research-bundles">
            {bundles.length ? bundles.map((bundle) => <article key={bundle.id} className={`research-bundle is-${bundle.status}`}>
              <div><strong>{bundle.bundleId}</strong><small>{bundle.manifestPath}</small></div><span>{bundle.status}</span>
              <p>{bundle.status === "imported" ? `${bundle.workIds.length} papers · ${bundle.evidenceIds.length} exact quotes` : bundle.error || "Ready to import"}</p>
              {bundle.status !== "imported" ? <Button size="small" loading={busy === `bundle:${bundle.manifestPath}`} onClick={() => void importBundles(bundle.manifestPath)}>Retry import</Button> : null}
            </article>) : <div className="research-empty"><BookOpen /><strong>No FastRead bundle detected</strong><span>Finish a FastRead handoff into references/fastread/&lt;bundle&gt;/; the manifest will trigger automatic import.</span></div>}
          </div>
        </section>

        <section className="research-section">
          <header><div><h3>Academic sources</h3><p>Provider results keep their provenance and partial failures stay visible. Manual import remains available offline.</p></div><Button size="small" variant="ghost" icon={<FilePlus2 />} onClick={() => setManualOpen((value) => !value)}>Add manually</Button></header>
          {manualOpen ? <div className="research-manual-source" aria-label="Manual source import">
            <label><span>Title *</span><input value={manualSource.title} onChange={(event) => setManualSource((current) => ({ ...current, title: event.target.value }))} /></label>
            <label><span>Authors</span><input value={manualSource.authors} onChange={(event) => setManualSource((current) => ({ ...current, authors: event.target.value }))} placeholder="Ada Lovelace, Alan Turing" /></label>
            <label><span>Year</span><input value={manualSource.year} onChange={(event) => setManualSource((current) => ({ ...current, year: event.target.value }))} inputMode="numeric" /></label>
            <label><span>Venue</span><input value={manualSource.venue} onChange={(event) => setManualSource((current) => ({ ...current, venue: event.target.value }))} /></label>
            <label><span>DOI</span><input value={manualSource.doi} onChange={(event) => setManualSource((current) => ({ ...current, doi: event.target.value }))} /></label>
            <label><span>arXiv</span><input value={manualSource.arxiv} onChange={(event) => setManualSource((current) => ({ ...current, arxiv: event.target.value }))} /></label>
            <label><span>Citation key</span><input value={manualSource.citationKey} onChange={(event) => setManualSource((current) => ({ ...current, citationKey: event.target.value }))} /></label>
            <div><Button size="small" variant="ghost" onClick={() => { setManualOpen(false); setManualSource(EMPTY_MANUAL_SOURCE); }}>Cancel</Button><Button size="small" loading={busy === "manual:import"} onClick={() => void importManualSource()}>Save source</Button></div>
          </div> : null}
          <div className="research-search"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Crossref, OpenAlex, Semantic Scholar, arXiv" onKeyDown={(event) => { if (event.key === "Enter") void search(); }} />{busy === "search" ? <Button variant="ghost" onClick={() => searchController.current?.abort()}>Cancel search</Button> : <Button onClick={() => void search()}>Search</Button>}</div>
          {providerResults?.length ? <div className="research-provider-results" aria-label="Research provider status">{providerResults.map((item) => <span key={item.provider} className={`is-${item.status}`} title={item.error}>{item.status === "failed" ? <AlertTriangle /> : <CheckCircle2 />}<strong>{providerLabel(item.provider)}</strong>{item.status === "completed" ? `${item.resultCount} results` : item.error || "failed"}</span>)}</div> : null}
          <div className="research-results">{works.length ? works.map((work) => {
            const context = citationContexts[work.id];
            const providers = [...new Set(work.metadataObservations.map((item) => item.provider))];
            return <article key={work.id}>
              <div className="research-work-title"><strong>{work.title}</strong><span className={`research-status is-${work.project.status}`}>{work.project.status}</span></div>
              <small>{work.authors.join(", ") || "Authors unresolved"} · {work.year ?? "year unresolved"} · {work.venue ?? "venue unresolved"}</small>
              <div className="research-source-provenance">{work.metadataStatus === "conflicting" ? <span className="is-conflict"><AlertTriangle />metadata conflict</span> : null}{providers.map((provider) => <span key={provider}>{providerLabel(provider)}</span>)}{work.identifiers.slice(0, 3).map((identifier) => <code key={`${identifier.scheme}:${identifier.value}`}>{identifier.scheme}: {identifier.value}</code>)}</div>
              <div className="research-work-actions">
                {work.project.status === "saved" ? <em>Approved · {work.project.citationKey || "key pending"}</em> : <Button size="small" loading={busy === `work:${work.id}`} onClick={() => void approveWork(work)}>Approve metadata</Button>}
                {work.project.status === "saved" ? <><Button size="small" variant="ghost" loading={busy === `context:${work.id}`} onClick={() => void inspectCitations(work)}>Find citations</Button><Button size="small" variant="ghost" loading={busy === `bibtex:${work.id}`} onClick={() => void proposeBibtex(work)}>Propose BibTeX</Button></> : null}
              </div>
              {context ? <div className="research-citation-context"><strong>Manuscript citation context · {context.key}</strong>{context.contexts.length ? context.contexts.map((item, index) => <button key={`${item.path}:${item.line}:${index}`} onClick={() => { onClose(); onNavigate?.(item.path, item.line); }}><MapPin /><span>{item.path}:{item.line}</span><small>{item.excerpt}</small></button>) : <p>No citation command uses this key yet.</p>}{context.bibliography ? <small>BibTeX: {context.bibliography.path}:{context.bibliography.line}</small> : null}</div> : null}
            </article>;
          }) : <div className="research-empty"><Search /><strong>No sources yet</strong><span>Import a FastRead bundle, add one manually, or search academic providers.</span></div>}</div>
        </section>

        <section className="research-section research-bibtex-target"><label><span>Paper bibliography target</span><input list="research-bib-paths" value={bibPath} onChange={(event) => setBibPath(event.target.value)} /></label><datalist id="research-bib-paths">{bibPaths.map((path) => <option value={path} key={path} />)}</datalist><small>If the file does not exist, approval creates it through the ChangeSet workflow.</small></section>
        {pendingBibtex ? <section className="research-bibtex-review"><header><div><h3>Review BibTeX ChangeSet</h3><p>{pendingBibtex.summary}</p></div><span>Explicit approval</span></header><pre>{pendingBibtex.changes[0]?.after}</pre><div><Button variant="ghost" onClick={() => setPendingBibtex(null)}>Cancel</Button><Button loading={busy === "bibtex:apply"} onClick={() => void applyBibtex()}>Apply to paper</Button></div></section> : null}
      </div> : null}

      {tab === "evidence" ? <div className="research-view"><section className="research-section"><header><div><h3>Evidence inbox</h3><p>FastRead exact quotes arrive approved with page and source hash. Other evidence requires an explicit decision.</p></div></header><div className="research-evidence-list">
        {evidence.length ? evidence.map((item) => <article key={item.id}>
          <header><span className={`research-status is-${item.status}`}>{item.status}</span><strong>{workById.get(item.workId)?.title || "Unknown source"}</strong><small>{item.locatorType} {item.locator}</small></header>
          <blockquote>{item.content}</blockquote>
          <footer><span>{item.fastReadBundleId ? `FastRead ${item.fastReadBundleId}` : item.origin}{item.sourceHash ? ` · hash ${item.sourceHash.slice(0, 12)}…` : ""}</span><div>{item.status !== "rejected" ? <Button size="small" variant="ghost" loading={busy === `evidence:${item.id}`} onClick={() => void updateEvidence(item, "rejected")}>Reject</Button> : null}{item.status !== "approved" ? <Button size="small" loading={busy === `evidence:${item.id}`} onClick={() => void updateEvidence(item, "approved")}>Approve</Button> : null}</div></footer>
        </article>) : <div className="research-empty"><FileCheck2 /><strong>No evidence yet</strong><span>Import FastRead exact quotes or add evidence from an approved source.</span></div>}
      </div></section></div> : null}

      {tab === "claims" ? <div className="research-view"><section className="research-section"><header><div><h3>Claim–evidence map</h3><p>Scan manuscript claims, bind approved evidence, then mark the claim supported.</p></div><Button size="small" icon={<ScanSearch />} loading={busy === "claims:scan"} onClick={() => void scanClaims()}>Scan manuscript</Button></header><div className="research-claims-list">
        {claims.length ? claims.map((claim) => {
          const claimLinks = links.filter((link) => link.claimId === claim.id);
          return <article key={claim.id}>
            <header><span className={`research-status is-${claim.reviewStatus}`}>{claim.reviewStatus}</span><strong>{claim.type}</strong><small>{claim.anchor.path} · {claim.anchorStatus}</small></header>
            <blockquote>{claim.anchor.exactText}</blockquote>
            {claimLinks.length ? <div className="research-linked-evidence">{claimLinks.map((link) => {
              const item = link.kind === "literature" ? evidence.find((candidate) => candidate.id === link.evidenceId) : undefined;
              const label = link.kind === "literature" ? (item ? `${item.locatorType} ${item.locator}: ${item.content.slice(0, 90)}` : link.evidenceId) : link.kind === "review-waiver" ? `User waiver: ${link.reason}` : `Workspace ${link.path}: ${link.anchor.exactText.slice(0, 90)}`;
              return <span key={link.id}><Link2 />{label}<button aria-label="Unlink claim support" onClick={() => void perform(`unlink:${link.id}`, async () => { await api.claims.unlinkEvidence(project.id, claim.id, link.id); await load(); })}>×</button></span>;
            })}</div> : null}
            <footer><select aria-label={`Evidence for ${claim.anchor.exactText}`} value={evidenceChoice[claim.id] ?? ""} onChange={(event) => setEvidenceChoice((current) => ({ ...current, [claim.id]: event.target.value }))}><option value="">Choose approved evidence…</option>{approvedEvidence.map((item) => <option key={item.id} value={item.id}>{workById.get(item.workId)?.project.citationKey || "source"} · p.{item.locator} · {item.content.slice(0, 70)}</option>)}</select><Button size="small" variant="ghost" icon={<Link2 />} loading={busy === `claim:${claim.id}`} onClick={() => void linkEvidence(claim)}>Link</Button>{claim.anchorStatus === "stale" || claim.anchorStatus === "orphaned" ? <Button size="small" variant="ghost" loading={busy === `reanchor:${claim.id}`} onClick={() => void perform(`reanchor:${claim.id}`, async () => { await api.claims.reanchor(project.id, claim.id); await load(); })}>Reanchor</Button> : null}<Button size="small" disabled={!claimLinks.length || claim.reviewStatus === "supported" || claim.anchorStatus === "stale" || claim.anchorStatus === "orphaned"} loading={busy === `support:${claim.id}`} onClick={() => void markSupported(claim)}>Mark supported</Button></footer>
            <div className="research-waiver"><input aria-label={`Waiver reason for ${claim.anchor.exactText}`} value={waiverReasons[claim.id] ?? ""} onChange={(event) => setWaiverReasons((current) => ({ ...current, [claim.id]: event.target.value }))} placeholder="Explicit review waiver reason…" /><Button size="small" variant="ghost" loading={busy === `waiver:${claim.id}`} onClick={() => void addWaiver(claim)}>Add waiver</Button></div>
          </article>;
        }) : <div className="research-empty"><ScanSearch /><strong>No claims scanned</strong><span>Scan the current TeX workspace to create stable claim anchors.</span></div>}
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
