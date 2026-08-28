import type { CitationVerification, ComplianceFinding, ComplianceReport, PublicationVenueOption, WorkspaceTreeNode } from "@fastwrite/shared";
import type { SkillRegistry } from "../agent/skill-registry";
import type { WorkspaceService } from "../workspace/workspace-service";

interface ComplianceCheckInput { pdfBase64?: string; renderedPages?: number; mainBodyPages?: number; verifyCitationsOnline?: boolean }
interface BibEntry { key: string; type: string; fields: Record<string, string>; path: string; line: number }
export interface ComplianceRuleContext { projectId: string; projectVersion: number; documents: Array<{ path: string; content: string }>; stage?: string }
export interface ComplianceRule {
  id: string;
  category: string;
  sourceUrl?: string;
  stages?: string[];
  check(context: ComplianceRuleContext): ComplianceFinding | ComplianceFinding[];
}

export class ComplianceService {
  private readonly rules: ComplianceRule[] = [];
  constructor(private readonly workspaces: WorkspaceService, private readonly skills: SkillRegistry) {}

  registerRule(rule: ComplianceRule): () => void {
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(rule.id) || !rule.category || typeof rule.check !== "function") throw new Error("Invalid compliance rule");
    this.rules.push(rule);
    return () => { const index = this.rules.indexOf(rule); if (index >= 0) this.rules.splice(index, 1); };
  }

  async check(projectId: string, input: ComplianceCheckInput = {}): Promise<ComplianceReport> {
    const project = this.workspaces.getProject(projectId);
    const files = textPaths(await this.workspaces.tree(projectId));
    const documents = await Promise.all(files.filter((path) => /\.(?:tex|bib)$/i.test(path)).map(async (path) => ({ path, content: (await this.workspaces.readTextFile(projectId, path)).content })));
    const tex = documents.filter((document) => document.path.endsWith(".tex"));
    const venue = project.publicationTarget ? (await this.skills.catalog()).find((item) => item.value === project.publicationTarget!.venueId && item.domain === project.publicationTarget!.domain) : undefined;
    const renderedPages = validPageCount(input.renderedPages) ?? (input.pdfBase64 ? pdfPageCount(input.pdfBase64) : undefined);
    const mainBodyPages = validPageCount(input.mainBodyPages);
    const findings: ComplianceFinding[] = [];
    if (project.publicationTarget) {
      const loaded = await this.skills.load(project.skill, project.publicationTarget);
      const source = documents.map((document) => document.content).join("\n");
      for (const rule of loaded.venueRules?.checks ?? []) {
        let matched = false;
        try { matched = rule.pattern ? new RegExp(rule.pattern, "i").test(source) : false; } catch { findings.push({ id: `rule:${rule.id}`, category: rule.category, status: "unresolved", message: "Venue rule pattern is invalid; verify the sidecar rule definition." }); continue; }
        findings.push({ id: `rule:${rule.id}`, category: rule.category, status: matched ? "pass" : "unresolved", message: rule.message ?? (matched ? `Rule '${rule.id}' matched.` : `Rule '${rule.id}' could not be established deterministically.`), ...(loaded.venueRules?.sourceUrl ? { sourceUrl: loaded.venueRules.sourceUrl } : {}) });
      }
    }
    findings.push(...venueFindings(venue, tex, renderedPages, mainBodyPages, project.publicationTarget?.stage));
    findings.push(...commentFindings(tex, project.publicationTarget?.stage));
    const ruleContext: ComplianceRuleContext = { projectId, projectVersion: project.version, documents, ...(project.publicationTarget?.stage ? { stage: project.publicationTarget.stage } : {}) };
    for (const rule of this.rules) if (!rule.stages || rule.stages.includes(project.publicationTarget?.stage ?? "submission")) {
      const result = rule.check(ruleContext);
      for (const finding of Array.isArray(result) ? result : [result]) findings.push({ ...finding, id: finding.id || rule.id, category: finding.category || rule.category, ...(finding.sourceUrl || !rule.sourceUrl ? {} : { sourceUrl: rule.sourceUrl }) });
    }
    const citations = citedKeys(tex);
    const entries = parseBibliography(documents);
    findings.push(...referenceFindings(citations, entries));
    const citationResults = await verifyCitations(citations, entries, input.verifyCitationsOnline === true);
    for (const citation of citationResults) {
      const evidence = citation.title ?? citation.doi ?? citation.url;
      findings.push({ id: `citation:${citation.key}`, category: "citations", status: citation.status === "verified" ? "pass" : citation.status === "mismatch" || citation.status === "missing" ? "error" : "unresolved", message: citation.message, ...(evidence ? { evidence } : {}) });
    }
    if (citations.size) findings.push({ id: "citations:claim-support", category: "citations", status: "unresolved", message: "Registry checks establish bibliographic identity, not whether each source supports its adjacent manuscript claim; complete evidence-linked semantic review before submission." });
    const summary = {
      errors: findings.filter((finding) => finding.status === "error").length,
      warnings: findings.filter((finding) => finding.status === "warning").length,
      unresolved: findings.filter((finding) => finding.status === "unresolved").length,
      passed: findings.filter((finding) => finding.status === "pass").length
    };
    return { projectId, projectVersion: project.version, ...(project.publicationTarget ? { publicationTarget: project.publicationTarget } : {}), checkedAt: new Date().toISOString(), ...(renderedPages ? { renderedPages } : {}), ...(mainBodyPages ? { mainBodyPages } : {}), summary, submissionBlocked: summary.errors > 0 || summary.unresolved > 0, findings, citations: citationResults };
  }
}

function venueFindings(venue: PublicationVenueOption | undefined, documents: Array<{ path: string; content: string }>, pages: number | undefined, mainBodyPages: number | undefined, stage?: string): ComplianceFinding[] {
  if (!venue) return [{ id: "venue:missing", category: "template", status: "unresolved", message: "Select a CCF-A publication target before running venue-specific checks." }];
  const findings: ComplianceFinding[] = [];
  const source = documents.map((document) => document.content).join("\n");
  const constraints = venue.constraints;
  const cameraReady = stage === "camera-ready";
  const totalLimit = cameraReady ? constraints?.cameraReadyTotalPageLimit : constraints?.totalPageLimit;
  const mainLimit = cameraReady ? constraints?.cameraReadyPageLimit : constraints?.pageLimit;
  if (!constraints) findings.push({ id: "venue:structured-rules", category: "template", status: "unresolved", message: `${venue.label} has no machine-readable hard constraints; verify the live author guide.`, sourceUrl: venue.sourceUrl });
  if (totalLimit) findings.push(pageFinding("total", totalLimit, pages, venue));
  else if (mainLimit) {
    if (mainBodyPages) findings.push(pageFinding("main body", mainLimit, mainBodyPages, venue));
    else if (!pages) findings.push(pageFinding("main", mainLimit, pages, venue));
    else if (pages <= mainLimit) findings.push({ id: "pages:main", category: "pages", status: "pass", message: `The entire rendered PDF has ${pages} pages, so its main body is necessarily within the ${mainLimit}-page threshold.`, sourceUrl: venue.sourceUrl });
    else findings.push({ id: "pages:main", category: "pages", status: "unresolved", message: `Rendered PDF has ${pages} total pages; ${venue.label} limits the main paper to ${mainLimit}, but references/appendices must be separated before deciding compliance.`, sourceUrl: venue.sourceUrl });
  } else findings.push({ id: "pages:policy", category: "pages", status: "unresolved", message: `No stable numeric ${cameraReady ? "camera-ready" : stage ?? "current-stage"} page limit is recorded for ${venue.label}; check the live author guide or selected track.`, sourceUrl: venue.sourceUrl });
  for (const token of constraints?.requiredLatex ?? []) findings.push({ id: `template:${token}`, category: "template", status: source.toLowerCase().includes(token.toLowerCase()) ? "pass" : "error", message: source.toLowerCase().includes(token.toLowerCase()) ? `Required LaTeX token '${token}' is present.` : `Required LaTeX class/style token '${token}' was not found.`, sourceUrl: venue.sourceUrl });
  const headings = [...source.matchAll(/\\(?:sub)*section\*?\s*\{([^}]+)\}/gi)].map((match) => normalize(match[1] ?? ""));
  for (const section of constraints?.requiredSections ?? []) {
    const present = headings.some((heading) => heading.includes(normalize(section)));
    findings.push({ id: `section:${normalize(section)}`, category: "required-section", status: present ? "pass" : "error", message: present ? `Required section '${section}' is present.` : `Required section '${section}' is missing.`, sourceUrl: venue.sourceUrl });
  }
  if (constraints?.anonymous && stage !== "camera-ready") findings.push(...anonymityFindings(documents, venue.sourceUrl));
  return findings;
}

function pageFinding(scope: string, limit: number, pages: number | undefined, venue: PublicationVenueOption): ComplianceFinding {
  if (!pages) return { id: `pages:${scope}`, category: "pages", status: "unresolved", message: `Compile the final PDF to enforce the ${limit}-page ${scope} limit.`, sourceUrl: venue.sourceUrl };
  return { id: `pages:${scope}`, category: "pages", status: pages <= limit ? "pass" : "error", message: pages <= limit ? `Rendered PDF has ${pages}/${limit} allowed pages.` : `Rendered PDF has ${pages} pages and exceeds the ${limit}-page ${scope} limit.`, sourceUrl: venue.sourceUrl };
}

function anonymityFindings(documents: Array<{ path: string; content: string }>, sourceUrl: string): ComplianceFinding[] {
  const patterns: Array<[string, RegExp, string]> = [
    ["author", /\\author\s*\{\s*(?!anonymous\b)(?!\s*\})[^}]+\}/i, "Non-anonymous author content"],
    ["affiliation", /\\(?:affiliation|institute|institution|email|orcidlink)\b/i, "Affiliation, institution, email, or ORCID command"],
    ["acknowledgment", /\\(?:section\*?\s*\{\s*acknowledg|acks\b|acknowledg(?:e)?ments?\b)/i, "Acknowledgment content"],
    ["funding", /\b(?:grant|funded by|funding|national science foundation|nsf)\b/i, "Potential funding identifier"]
  ];
  const findings: ComplianceFinding[] = [];
  for (const document of documents) for (const [id, pattern, label] of patterns) {
    const match = pattern.exec(stripComments(document.content));
    if (match) findings.push({ id: `anonymity:${id}:${document.path}`, category: "anonymity", status: "error", message: `${label} may reveal author identity in an anonymous submission.`, path: document.path, line: lineAt(document.content, match.index), evidence: match[0].slice(0, 160), sourceUrl });
  }
  if (!findings.length) findings.push({ id: "anonymity:scan", category: "anonymity", status: "pass", message: "No common author, affiliation, acknowledgment, or funding markers were found." });
  return findings;
}

function commentFindings(documents: Array<{ path: string; content: string }>, stage?: string): ComplianceFinding[] {
  const findings: ComplianceFinding[] = [];
  for (const document of documents) document.content.split(/\r?\n/).forEach((line, index) => {
    const comment = unescapedComment(line);
    if (!comment) return;
    const sensitive = /\b(?:TODO|FIXME|XXX|NOTE|author|reviewer|camera.?ready|anonymous|cite|citation|result|claim)\b/i.test(comment);
    if (sensitive || stage === "submission") findings.push({ id: `comment:${document.path}:${index + 1}`, category: "comments", status: sensitive ? "error" : "warning", message: sensitive ? "Editorial or identity-sensitive LaTeX comment must be resolved before submission." : "LaTeX source comment remains in the submission source.", path: document.path, line: index + 1, evidence: comment.slice(0, 200) });
  });
  if (!findings.length) findings.push({ id: "comments:scan", category: "comments", status: "pass", message: "No actionable LaTeX comments were found." });
  return findings;
}

function referenceFindings(citations: Set<string>, entries: BibEntry[]): ComplianceFinding[] {
  const findings: ComplianceFinding[] = [];
  const byKey = new Map<string, BibEntry>();
  for (const entry of entries) {
    if (byKey.has(entry.key)) findings.push({ id: `reference:duplicate:${entry.key}`, category: "references", status: "error", message: `Duplicate bibliography key '${entry.key}'.`, path: entry.path, line: entry.line });
    else byKey.set(entry.key, entry);
    for (const field of ["title", "year"]) if (!entry.fields[field]) findings.push({ id: `reference:field:${entry.key}:${field}`, category: "references", status: "error", message: `Bibliography entry '${entry.key}' is missing ${field}.`, path: entry.path, line: entry.line });
    if (!entry.fields.author && entry.type !== "misc") findings.push({ id: `reference:field:${entry.key}:author`, category: "references", status: "warning", message: `Bibliography entry '${entry.key}' has no author/editor.`, path: entry.path, line: entry.line });
    if (entry.fields.doi && !/^10\.\d{4,9}\/\S+$/i.test(cleanDoi(entry.fields.doi))) findings.push({ id: `reference:doi:${entry.key}`, category: "references", status: "error", message: `Bibliography entry '${entry.key}' has a malformed DOI.`, path: entry.path, line: entry.line, evidence: entry.fields.doi });
  }
  for (const key of citations) if (!byKey.has(key)) findings.push({ id: `reference:missing:${key}`, category: "references", status: "error", message: `Citation key '${key}' has no bibliography entry.` });
  for (const entry of entries) if (!citations.has(entry.key)) findings.push({ id: `reference:unused:${entry.key}`, category: "references", status: "warning", message: `Bibliography entry '${entry.key}' is not cited.`, path: entry.path, line: entry.line });
  if (!findings.some((finding) => finding.status === "error")) findings.push({ id: "references:integrity", category: "references", status: "pass", message: "Citation keys and required bibliography fields are internally consistent." });
  return findings;
}

async function verifyCitations(citations: Set<string>, entries: BibEntry[], online: boolean): Promise<CitationVerification[]> {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const results: CitationVerification[] = [];
  const keys = [...citations].slice(0, 100);
  for (let offset = 0; offset < keys.length; offset += 10) results.push(...await Promise.all(keys.slice(offset, offset + 10).map(async (key): Promise<CitationVerification> => {
    const entry = byKey.get(key);
    if (!entry) return { key, status: "missing", message: "No bibliography entry exists for this citation key." };
    const title = entry.fields.title?.replace(/[{}]/g, "").trim();
    const doi = entry.fields.doi ? cleanDoi(entry.fields.doi) : doiFromUrl(entry.fields.url);
    const url = entry.fields.url;
    if (!online) return { key, status: "unresolved", ...(title ? { title } : {}), ...(doi ? { doi } : {}), ...(url ? { url } : {}), message: "Online authenticity verification was not requested." };
    if (doi) return verifyDoi(key, doi, entry);
    if (title) return verifyTitle(key, title, url);
    return { key, status: "unresolved", ...(url ? { url } : {}), message: "No DOI or title is available for authoritative verification." };
  })));
  return results;
}

async function verifyDoi(key: string, doi: string, entry: BibEntry): Promise<CitationVerification> {
  const expectedTitle = entry.fields.title?.replace(/[{}]/g, "").trim();
  try {
    const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, { headers: { "user-agent": "FastWrite/0.1 (citation verification)" }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { key, status: response.status === 404 ? "mismatch" : "unresolved", doi, ...(expectedTitle ? { title: expectedTitle } : {}), message: response.status === 404 ? "DOI was not found in Crossref." : `Crossref returned HTTP ${response.status}.` };
    const body = await response.json() as { message?: { title?: string[]; issued?: { "date-parts"?: number[][] }; published?: { "date-parts"?: number[][] }; "update-to"?: Array<{ type?: string }> } };
    const actual = body.message?.title?.[0] ?? "";
    const retracted = body.message?.["update-to"]?.some((update) => /retract/i.test(update.type ?? "")) ?? false;
    const actualYear = body.message?.issued?.["date-parts"]?.[0]?.[0] ?? body.message?.published?.["date-parts"]?.[0]?.[0];
    const yearMatches = !entry.fields.year || !actualYear || Number(entry.fields.year) === actualYear;
    const similar = !expectedTitle || titleSimilarity(expectedTitle, actual) >= 0.9;
    const title = actual || expectedTitle;
    const verified = similar && yearMatches && !retracted;
    const message = retracted ? "Crossref reports a retraction update for this work." : !similar ? `Crossref title does not match the bibliography title: ${actual}` : !yearMatches ? `Crossref publication year ${actualYear} does not match bibliography year ${entry.fields.year}.` : "DOI, title, and available year metadata were verified against Crossref.";
    return { key, status: verified ? "verified" : "mismatch", doi, ...(title ? { title } : {}), message };
  } catch { return { key, status: "unresolved", doi, ...(expectedTitle ? { title: expectedTitle } : {}), message: "Crossref could not be reached; authenticity remains unresolved." }; }
}

async function verifyTitle(key: string, title: string, url?: string): Promise<CitationVerification> {
  try {
    const response = await fetch(`https://api.crossref.org/works?query.title=${encodeURIComponent(title)}&rows=3&select=DOI,title`, { headers: { "user-agent": "FastWrite/0.1 (citation verification)" }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error("lookup failed");
    const body = await response.json() as { message?: { items?: Array<{ DOI?: string; title?: string[] }> } };
    const best = (body.message?.items ?? []).map((item) => ({ item, score: titleSimilarity(title, item.title?.[0] ?? "") })).sort((a, b) => b.score - a.score)[0];
    if (!best || best.score < 0.9) return { key, status: "unresolved", title, ...(url ? { url } : {}), message: "No sufficiently similar Crossref title was found." };
    return { key, status: "verified", title: best.item.title?.[0] ?? title, ...(best.item.DOI ? { doi: best.item.DOI } : {}), ...(url ? { url } : {}), message: "Title was matched against Crossref; add the DOI for stronger verification." };
  } catch { return { key, status: "unresolved", title, ...(url ? { url } : {}), message: "Crossref could not be reached; authenticity remains unresolved." }; }
}

function citedKeys(documents: Array<{ content: string }>): Set<string> {
  const keys = new Set<string>();
  for (const document of documents) for (const match of stripComments(document.content).matchAll(/\\(?:cite|citep|citet|parencite|textcite|autocite|nocite)\*?(?:\[[^\]]*\]){0,2}\{([^}]+)\}/g)) for (const key of (match[1] ?? "").split(",")) if (key.trim() && key.trim() !== "*") keys.add(key.trim());
  return keys;
}

function parseBibliography(documents: Array<{ path: string; content: string }>): BibEntry[] {
  const entries: BibEntry[] = [];
  for (const document of documents) {
    const starts = [...document.content.matchAll(/@(\w+)\s*\{\s*([^,\s]+)\s*,/g)];
    for (const [index, match] of starts.entries()) {
      const start = match.index ?? 0; const end = starts[index + 1]?.index ?? document.content.length; const body = document.content.slice(start, end);
      const fields = parseBibFields(body);
      entries.push({ key: match[2]!, type: (match[1] ?? "misc").toLowerCase(), fields, path: document.path, line: lineAt(document.content, start) });
    }
    for (const match of document.content.matchAll(/\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}([^\n]*)/g)) {
      const title = (match[2] ?? "").trim();
      entries.push({ key: match[1]!, type: "manual", fields: title ? { title } : {}, path: document.path, line: lineAt(document.content, match.index ?? 0) });
    }
  }
  return entries;
}

function parseBibFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const pattern = /(?:^|[,\n])\s*([A-Za-z][\w-]*)\s*=\s*/g;
  for (let match = pattern.exec(body); match; match = pattern.exec(body)) {
    const name = match[1]!.toLowerCase();
    let cursor = pattern.lastIndex;
    let value = "";
    if (body[cursor] === "{") {
      const start = ++cursor; let depth = 1;
      while (cursor < body.length && depth) { if (body[cursor] === "{" && body[cursor - 1] !== "\\") depth++; else if (body[cursor] === "}" && body[cursor - 1] !== "\\") depth--; cursor++; }
      value = body.slice(start, Math.max(start, cursor - 1));
    } else if (body[cursor] === '"') {
      const start = ++cursor;
      while (cursor < body.length && (body[cursor] !== '"' || body[cursor - 1] === "\\")) cursor++;
      value = body.slice(start, cursor);
    } else {
      const start = cursor;
      while (cursor < body.length && body[cursor] !== "," && body[cursor] !== "\n") cursor++;
      value = body.slice(start, cursor).trim();
    }
    fields[name] = value.trim();
    pattern.lastIndex = cursor;
  }
  return fields;
}

function textPaths(nodes: WorkspaceTreeNode[]): string[] { return nodes.flatMap((node) => node.type === "directory" ? textPaths(node.children) : node.kind === "text" ? [node.path] : []); }
function stripComments(content: string): string { return content.split(/\r?\n/).map((line) => { const index = commentIndex(line); return index < 0 ? line : line.slice(0, index); }).join("\n"); }
function unescapedComment(line: string): string | undefined { const index = commentIndex(line); return index < 0 ? undefined : line.slice(index + 1).trim(); }
function commentIndex(line: string): number { for (let i = 0; i < line.length; i++) if (line[i] === "%") { let slashes = 0; for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) slashes++; if (slashes % 2 === 0) return i; } return -1; }
function lineAt(content: string, offset: number): number { return content.slice(0, offset).split("\n").length; }
function validPageCount(value?: number): number | undefined { return Number.isSafeInteger(value) && value! > 0 ? value : undefined; }
function pdfPageCount(base64: string): number | undefined { try { const text = Buffer.from(base64, "base64").toString("latin1"); const direct = [...text.matchAll(/\/Type\s*\/Page(?!s)\b/g)].length; const counts = [...text.matchAll(/\/Type\s*\/Pages\b[\s\S]{0,200}?\/Count\s+(\d+)/g)].map((match) => Number(match[1])); return direct || Math.max(0, ...counts) || undefined; } catch { return undefined; } }
function cleanDoi(value: string): string { return value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/[{}]/g, ""); }
function doiFromUrl(value?: string): string | undefined { const match = value?.match(/doi\.org\/(10\.\d{4,9}\/[^\s?#]+)/i); return match?.[1] ? cleanDoi(match[1]) : undefined; }
function normalize(value: string): string { return value.toLowerCase().replace(/\\[a-z]+/g, " ").replace(/[^a-z0-9]+/g, " ").trim(); }
function titleSimilarity(left: string, right: string): number { const a = new Set(normalize(left).split(" ").filter((word) => word.length > 2)); const b = new Set(normalize(right).split(" ").filter((word) => word.length > 2)); if (!a.size || !b.size) return 0; const overlap = [...a].filter((word) => b.has(word)).length; return (2 * overlap) / (a.size + b.size); }
