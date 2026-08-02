import { normalizeWorkspacePath } from "./path";

export type LatexDiagnosticSeverity = "error" | "warning" | "info";

export interface LatexDiagnostic {
  id: string;
  severity: LatexDiagnosticSeverity;
  message: string;
  path?: string;
  line?: number;
  raw: string;
}

export function parseLatexDiagnostics(log: string, workspacePaths: string[] = [], mainDocument?: string): LatexDiagnostic[] {
  const normalizedPaths = workspacePaths.map(normalizeWorkspacePath);
  const diagnostics: LatexDiagnostic[] = [];
  const lines = log.replaceAll("\0", "").split(/\r?\n/);
  let pendingError: { message: string; raw: string } | null = null;

  const add = (severity: LatexDiagnosticSeverity, message: string, raw: string, candidatePath?: string, line?: number) => {
    const path = candidatePath ? resolveWorkspacePath(candidatePath, normalizedPaths, mainDocument) : mainDocument;
    const signature = `${severity}:${path ?? ""}:${line ?? ""}:${message}`;
    if (diagnostics.some((item) => `${item.severity}:${item.path ?? ""}:${item.line ?? ""}:${item.message}` === signature)) return;
    diagnostics.push({
      id: `latex-${diagnostics.length + 1}`,
      severity,
      message: cleanMessage(message),
      ...(path ? { path } : {}),
      ...(line && line > 0 ? { line } : {}),
      raw
    });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]?.trim() ?? "";
    if (!raw) continue;
    const cleaned = raw.replace(/^(?:\[TeX(?: ERR)?\]\s*)+/, "");
    const fileLine = cleaned.match(/^(.+?\.(?:tex|sty|cls|bib)):(\d+):\s*(?:(LaTeX|Package)\s+)?(Error|Warning):?\s*(.+)$/i);
    if (fileLine?.[1] && fileLine[2] && fileLine[4] && fileLine[5]) {
      add(fileLine[4].toLowerCase() === "error" ? "error" : "warning", fileLine[5], raw, fileLine[1], Number.parseInt(fileLine[2], 10));
      pendingError = null;
      continue;
    }
    if (cleaned.startsWith("!")) {
      if (pendingError) add("error", pendingError.message, pendingError.raw);
      const message = cleaned.replace(/^!\s*(?:LaTeX Error:\s*)?/i, "");
      const inlineLine = cleaned.match(/(?:line|l\.)\s*(\d+)/i)?.[1];
      if (inlineLine) add("error", message, raw, undefined, Number.parseInt(inlineLine, 10));
      else pendingError = { message, raw };
      continue;
    }
    if (pendingError) {
      const sourceLine = cleaned.match(/^l\.(\d+)\s*(.*)$/i);
      if (sourceLine?.[1]) {
        add("error", pendingError.message, `${pendingError.raw}\n${raw}`, undefined, Number.parseInt(sourceLine[1], 10));
        pendingError = null;
        continue;
      }
    }
    const warning = cleaned.match(/^(?:LaTeX|Package\s+\S+) Warning:\s*(.+?)(?:\s+on input line\s+(\d+))?\.?$/i);
    if (warning?.[1]) {
      add("warning", warning[1], raw, undefined, warning[2] ? Number.parseInt(warning[2], 10) : undefined);
      continue;
    }
    const box = cleaned.match(/^((?:Over|Under)full \\[hv]box.+?)(?:at lines?\s+(\d+)(?:--\d+)?)?$/i);
    if (box?.[1]) add("warning", box[1], raw, undefined, box[2] ? Number.parseInt(box[2], 10) : undefined);
  }

  if (pendingError) add("error", pendingError.message, pendingError.raw);
  return diagnostics;
}

function resolveWorkspacePath(candidate: string, workspacePaths: string[], mainDocument?: string): string | undefined {
  const normalized = candidate.replaceAll("\\", "/").replace(/\/\.\//g, "/").replace(/^\/+/, "");
  if (normalized === "document.tex" && mainDocument) return normalizeWorkspacePath(mainDocument);
  const exact = workspacePaths.find((path) => normalized === path || normalized.endsWith(`/${path}`));
  if (exact) return exact;
  const basename = normalized.split("/").at(-1)?.toLowerCase();
  const matches = workspacePaths.filter((path) => path.split("/").at(-1)?.toLowerCase() === basename);
  return matches.length === 1 ? matches[0] : undefined;
}

function cleanMessage(message: string): string {
  return message.replace(/\s+/g, " ").replace(/\s*\.\s*$/, ".").trim();
}
