import type { ChangeSet, HunkFinding } from "@fastwrite/shared";

const CITATION = /\\(?:cite|citep|citet|parencite|textcite|autocite)\*?(?:\[[^\]]*\]){0,2}\{([^}]+)\}/g;

export function isEvidencePlaceholderCitation(key: string): boolean {
  const normalized = key.replace(/[\[\]{}]/g, " ").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return /^(?:evidence|required evidence|evidence required|citation|citation needed|citation required|cite needed|todo|tbd|placeholder|\?+)$/.test(normalized);
}

export function citationFindings(content: string, approved: Set<string>): HunkFinding[] {
  const keys = [...content.matchAll(CITATION)].flatMap((match) => (match[1] ?? "").split(",").map((key) => key.trim()).filter(Boolean));
  return [...new Set(keys)].map((key) => isEvidencePlaceholderCitation(key)
    ? { id: `citation:${key}`, source: "citation", referenceId: key, status: "warning", message: `Citation placeholder '${key}' is evidence-honest but must be replaced with a verified source before submission.` }
    : approved.has(key)
      ? { id: `citation:${key}`, source: "citation", referenceId: key, status: "pass", message: `Citation '${key}' is approved for this project.` }
      : { id: `citation:${key}`, source: "citation", referenceId: key, status: "blocking", message: `Citation '${key}' has not been approved in Research; verify it or edit this hunk before accepting.` });
}

export function normalizePlaceholderFindings(changeSet: ChangeSet): ChangeSet {
  for (const hunk of changeSet.changes.flatMap((change) => change.hunks ?? [])) {
    for (const finding of hunk.findings ?? []) {
      if (finding.source === "citation" && finding.status === "blocking" && isEvidencePlaceholderCitation(finding.referenceId)) {
        finding.status = "warning";
        finding.message = `Citation placeholder '${finding.referenceId}' is evidence-honest but must be replaced with a verified source before submission.`;
      }
    }
  }
  return changeSet;
}
