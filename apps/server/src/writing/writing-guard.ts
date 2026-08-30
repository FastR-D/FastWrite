import type { HunkFinding } from "@fastwrite/shared";

export interface WritingGuardInput { path: string; content: string; fileVersion?: number; approvedCitationKeys?: Set<string>; }

export type WritingCheck = (documents: WritingGuardInput[]) => HunkFinding[];

export const WritingCheckRegistry: ReadonlyMap<string, WritingCheck> = new Map([
  ["document", (documents) => documents.flatMap((document) => writingGuard(document))],
  ["numeric-consistency", numericConsistency],
]);

export function runWritingChecks(documents: WritingGuardInput[], checks: Iterable<string> = WritingCheckRegistry.keys()): HunkFinding[] {
  return [...checks].flatMap((name) => WritingCheckRegistry.get(name)?.(documents) ?? []);
}

export function numericConsistency(documents: WritingGuardInput[]): HunkFinding[] {
  const findings: HunkFinding[] = [];
  const values = new Map<string, Array<{ value: number; path: string }>>();
  for (const document of documents) for (const match of document.content.matchAll(/([A-Za-z][A-Za-z0-9 _-]{2,30})\s*[:=]\s*(\d+(?:\.\d+)?)\s*%/g)) {
    const key = match[1]!.toLowerCase().replace(/\s+/g, " ").trim();
    const list = values.get(key) ?? []; list.push({ value: Number(match[2]), path: document.path }); values.set(key, list);
  }
  for (const [metric, list] of values) if (new Set(list.map(item => item.value)).size > 1) findings.push({ id: `writing_numeric_${metric}`, source: "numeric", status: "blocking", referenceId: metric, message: `Metric '${metric}' has conflicting percentages: ${list.map(item => item.value).join(", ")}.` });
  for (const document of documents) for (const match of document.content.matchAll(/from\s+(\d+(?:\.\d+)?)\s*%\s+to\s+(\d+(?:\.\d+)?)\s*%[^.\n]{0,80}?(?:relative\s+)?improvement\s+(?:of\s+)?(\d+(?:\.\d+)?)\s*%/gi)) {
    const from = Number(match[1]), to = Number(match[2]), claimed = Number(match[3]);
    const expected = from === 0 ? 0 : ((to - from) / from) * 100;
    if (Math.abs(expected - claimed) > 0.2) findings.push({ id: `writing_arithmetic_${match.index}`, source: "numeric", status: "blocking", referenceId: String(match.index), message: `Relative improvement is ${expected.toFixed(2)}%, not ${claimed}%.` });
  }
  return findings;
}

export function writingGuardMany(documents: WritingGuardInput[]): HunkFinding[] {
  const findings = documents.flatMap(document => writingGuard(document));
  const bibliography = new Map<string, string>();
  for (const document of documents) for (const match of document.content.matchAll(/@\w+\s*\{\s*([^,\s]+)/g)) {
    const key = match[1]!; const prior = bibliography.get(key); if (prior) findings.push({ id: `writing_duplicate_${key}`, source: "citation", status: "blocking", referenceId: key, message: `Duplicate BibTeX key '${key}' in ${prior} and ${document.path}.` }); else bibliography.set(key, document.path);
  }
  findings.push(...numericConsistency(documents));
  return findings;
}

export function writingGuard(input: WritingGuardInput): HunkFinding[] {
  const findings: HunkFinding[] = [];
  const add = (source: HunkFinding["source"], status: HunkFinding["status"], message: string, referenceId: string) => { const offset = input.content.indexOf(referenceId); findings.push({ id: `writing_${source}_${referenceId}_${findings.length}`, source, status, message, referenceId, confidence: "high", ...(offset >= 0 ? { anchors: [{ path: input.path, fileVersion: input.fileVersion ?? 0, startOffset: offset, endOffset: offset + referenceId.length, exactText: referenceId, prefix: input.content.slice(Math.max(0, offset - 40), offset), suffix: input.content.slice(offset + referenceId.length, offset + referenceId.length + 40) }] } : {}) }); };
  const citations = [...input.content.matchAll(/\\(?:cite|citep|citet|parencite|textcite|autocite)\*?(?:\[[^\]]*\]){0,2}\{([^}]+)\}/g)].flatMap(m => (m[1] ?? "").split(",").map(k => k.trim())).filter(Boolean);
  for (const key of citations) if (input.approvedCitationKeys && !input.approvedCitationKeys.has(key)) add("citation", "blocking", `Citation '${key}' is not approved.`, key);
  const bibKeys = [...input.content.matchAll(/@\w+\s*\{\s*([^,\s]+)/g)].map(m => m[1]!); const bibSeen = new Set<string>();
  for (const key of bibKeys) { if (bibSeen.has(key)) add("citation", "blocking", `Duplicate BibTeX key '${key}'.`, key); bibSeen.add(key); }
  const labels = [...input.content.matchAll(/\\label\{([^}]+)\}/g)].map(m => m[1]!); const seen = new Set<string>();
  for (const label of labels) { if (seen.has(label)) add("structure", "blocking", `Duplicate label '${label}'.`, label); seen.add(label); }
  for (const ref of [...input.content.matchAll(/\\(?:ref|pageref)\{([^}]+)\}/g)].map(m => m[1]!)) if (!seen.has(ref)) add("structure", "blocking", `Reference '${ref}' has no label.`, ref);
  for (const match of input.content.matchAll(/TODO|TBD|FIXME|YOUR[_ ]TEXT|\\cite\{\s*\}/gi)) add("style", "warning", "Template or TODO residue remains.", String(match.index ?? 0));
  for (const match of input.content.matchAll(/\b(?:state[- ]of[- ]the[- ]art|SOTA|comprehensive|always|never|best)\b/gi)) add("style", "warning", `Strong scope claim '${match[0]}' requires evidence review.`, String(match.index ?? 0));
  const definitions = new Map<string, string>();
  for (const match of input.content.matchAll(/\b([A-Z][A-Z0-9-]{1,})\s*\(([^)]+)\)/g)) { const acronym = match[1]!.toLowerCase(); const expansion = match[2]!.toLowerCase().replace(/\s+/g, " "); const prior = definitions.get(acronym); if (prior && prior !== expansion) add("style", "warning", `Acronym '${match[1]}' has conflicting definitions.`, acronym); else definitions.set(acronym, expansion); }
  const terms = new Map<string, string>();
  for (const match of input.content.matchAll(/\b([A-Z][A-Za-z]{2,})\b/g)) { const term = match[1]!; const key = term.toLowerCase(); const prior = terms.get(key); if (prior && prior !== term) add("style", "warning", `Terminology casing drift: '${prior}' vs '${term}'.`, key); else terms.set(key, term); }
  const percentages = [...input.content.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map(m => Number(m[1]));
  if (percentages.some(value => value > 100)) add("numeric", "blocking", "Percentage value exceeds 100.", "percentage");
  for (const match of input.content.matchAll(/(\d+(?:\.\d+)?)\s*%\s*(?:improvement|increase|gain)/gi)) if (Number(match[1]) < 0) add("numeric", "blocking", "Improvement percentage cannot be negative.", String(match.index ?? 0));
  if (/\b(?:percentage|relative)\s+(?:improvement|increase)\b/i.test(input.content) && /\b(?:percentage points?|points?)\b/i.test(input.content)) add("numeric", "warning", "Percentage and percentage-point units appear together; verify the metric definition.", "unit-consistency");
  if (/\bhigher[- ]is[- ]better\b/i.test(input.content) && /\blower[- ]is[- ]better\b/i.test(input.content)) add("numeric", "warning", "The document declares conflicting metric directions (higher-is-better and lower-is-better).", "direction-consistency");
  return findings;
}
