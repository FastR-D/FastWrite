import type { ClaimAnchor, PaperClaim } from "@fastwrite/shared";

export interface ClaimAnalyzerDocument { projectId: string; path: string; fileVersion: number; content: string; }

export function analyzeClaims(document: ClaimAnalyzerDocument): PaperClaim[] {
  const candidates: Array<{ text: string; offset: number; surface: NonNullable<PaperClaim["surface"]> }> = [];
  const add = (text: string, offset: number, surface: NonNullable<PaperClaim["surface"]>) => {
    const exactText = text.trim(); const start = offset + text.indexOf(exactText);
    if (exactText.length >= 8 && !candidates.some((item) => item.offset === start)) candidates.push({ text: exactText, offset: start, surface });
  };
  for (const match of document.content.matchAll(/[^.!?\n]{20,}(?:shows?|demonstrates?|improves?|reduces?|increases?|achieves?|outperforms?|propose?s?|introduces?)[^.!?\n]*[.!?]/gi)) add(match[0], match.index ?? 0, "text");
  for (const match of document.content.matchAll(/\\caption\s*\{([^}]*)\}/gi)) add(match[1] ?? "", (match.index ?? 0) + match[0].indexOf(match[1] ?? ""), "caption");
  for (const match of document.content.matchAll(/[^\n{}]{8,}&[^\n{}]{3,}(?:\\\\|\n)/g)) add(match[0], match.index ?? 0, "table-cell");
  for (const match of document.content.matchAll(/[^.!?\n]{12,}(?:\\(?:cite|citep|citet|parencite|textcite|autocite)\*?(?:\[[^]]*\]){0,2}\{[^}]+\})[^.!?\n]*[.!?]/gi)) add(match[0], match.index ?? 0, "citation");
  for (const match of document.content.matchAll(/\\(?:label|ref|pageref)\s*\{[^}]+\}/g)) add(match[0], match.index ?? 0, "artifact-reference");
  return candidates.map((candidate, index) => {
    const anchor = makeAnchor(document, candidate.offset, candidate.text);
    const numbers = [...candidate.text.matchAll(/(-?\d+(?:\.\d+)?)\s*(%|ms|s|×|x|points?)?/gi)].map((match) => ({ raw: match[0], normalized: Number(match[1]), ...(match[2] ? { unit: match[2] } : {}) }));
    const type = /contribution|propose|introduce/i.test(candidate.text) ? "contribution" : /method|algorithm|model/i.test(candidate.text) ? "method" : /limitation|cannot|future work/i.test(candidate.text) ? "limitation" : /result|improv|reduc|increase|outperform|\d+(?:\.\d+)?\s*%/i.test(candidate.text) ? "result" : "background";
    return { id: `claim_${crypto.randomUUID()}_${index}`, projectId: document.projectId, anchor, type, surface: candidate.surface, normalizedText: candidate.text.replace(/\s+/g, " ").trim(), ...(numbers.length ? { numbers } : {}), reviewStatus: "detected", anchorStatus: "current", createdBy: "scanner", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } satisfies PaperClaim;
  });
}

function makeAnchor(document: ClaimAnalyzerDocument, offset: number, exactText: string): ClaimAnchor { return { path: document.path, fileVersion: document.fileVersion, startOffset: offset, endOffset: offset + exactText.length, exactText, prefix: document.content.slice(Math.max(0, offset - 40), offset), suffix: document.content.slice(offset + exactText.length, offset + exactText.length + 40) }; }
