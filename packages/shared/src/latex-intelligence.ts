/** Deterministic project intelligence. Never asks a model to invent citation keys. */
export interface LatexDocument {
  path: string;
  content: string;
  version: number;
}
export interface BibEntry {
  key: string;
  type: string;
  fields: Record<string, string>;
  path: string;
  line: number;
  version: number;
}
export interface LatexSymbol {
  name: string;
  kind: "label" | "command" | "environment";
  path: string;
  line: number;
  parameters?: number;
}
export interface LatexIndex {
  packages?: string[];
  classes?: string[];
  packageSymbols?: LatexSymbol[];
  documents: LatexDocument[];
  entries: BibEntry[];
  symbols: LatexSymbol[];
  diagnostics: Array<{ path: string; line: number; message: string }>;
  projectVersion: number;
}

function unescapeText(value: string) {
  return value
    .replace(/\\(?:textit|textbf|emph|textrm)\s*\{([^{}]*)\}/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/\\([&%_#$])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
export function withoutLatexComments(text: string): string {
  return text.replace(/(?:\\.|%[^\n]*|[^\\%]+)/g, (token) =>
    token.startsWith("%") ? " ".repeat(token.length) : token,
  );
}
/** Balanced BibTeX scanner: nested braces, quoted strings, @string, # concatenation and comments. */
export function parseBibtex(document: LatexDocument): {
  entries: BibEntry[];
  diagnostics: LatexIndex["diagnostics"];
} {
  const text = document.content,
    entries: BibEntry[] = [],
    diagnostics: LatexIndex["diagnostics"] = [];
  const macros: Record<string, string> = {
    jan: "January",
    feb: "February",
    mar: "March",
    apr: "April",
    may: "May",
    jun: "June",
    jul: "July",
    aug: "August",
    sep: "September",
    oct: "October",
    nov: "November",
    dec: "December",
  };
  let i = 0;
  const skip = () => {
    while (i < text.length) {
      if (/\s/.test(text[i]!)) i++;
      else if (text[i] === "%") {
        while (i < text.length && text[i] !== "\n") i++;
      } else break;
    }
  };
  const value = (depthLimit = 0): string => {
    if (depthLimit > 64) return "";
    skip();
    let result = "";
    if (text[i] === "{" || text[i] === '"') {
      const quoted = text[i++] === '"';
      let depth = quoted ? 0 : 1;
      while (i < text.length) {
        const ch = text[i++]!;
        if (ch === "\\" && i < text.length) {
          result += ch + text[i++];
          continue;
        }
        if (ch === "{") depth++;
        if (ch === "}") {
          depth--;
          if (!quoted && depth === 0) break;
        }
        if (quoted && ch === '"' && depth === 0) break;
        result += ch;
      }
    } else {
      const start = i;
      while (i < text.length && !/[\s,#})]/.test(text[i]!)) i++;
      const token = text.slice(start, i);
      result = macros[token.toLowerCase()] ?? token;
    }
    skip();
    if (text[i] === "#") {
      i++;
      result += value(depthLimit + 1);
    }
    return result;
  };
  while (i < text.length) {
    skip();
    if (text[i] !== "@") {
      i++;
      continue;
    }
    const start = i++,
      line = text.slice(0, start).split("\n").length;
    const typeMatch = /^[A-Za-z]+/.exec(text.slice(i));
    if (!typeMatch) continue;
    const type = typeMatch[0].toLowerCase();
    i += type.length;
    skip();
    const open = text[i++];
    if (open !== "{" && open !== "(") continue;
    const close = open === "{" ? "}" : ")";
    skip();
    if (type === "comment" || type === "preamble") {
      let depth = 1;
      while (i < text.length && depth) {
        const ch = text[i++]!;
        if (ch === "\\") i++;
        else if (ch === open) depth++;
        else if (ch === close) depth--;
      }
      continue;
    }
    if (type === "string") {
      const name = /^[\w:.-]+/.exec(text.slice(i))?.[0];
      if (name) {
        i += name.length;
        skip();
        if (text[i] === "=") {
          i++;
          macros[name.toLowerCase()] = value();
        }
      }
      while (i < text.length && text[i] !== close) i++;
      i++;
      continue;
    }
    const keyStart = i;
    while (i < text.length && ![",", close, "\n"].includes(text[i]!)) i++;
    const key = text.slice(keyStart, i).trim();
    const fields: Record<string, string> = {};
    if (text[i] !== "," || !key || /[\s{}\\]/.test(key)) {
      diagnostics.push({
        path: document.path,
        line,
        message: "无法解析 BibTeX 引用标识",
      });
      continue;
    }
    i++;
    let closed = false;
    while (i < text.length) {
      skip();
      if (text[i] === close) {
        i++;
        closed = true;
        break;
      }
      if (text[i] === ",") {
        i++;
        continue;
      }
      const name = /^[\w:-]+/.exec(text.slice(i))?.[0];
      if (!name) {
        i++;
        continue;
      }
      i += name.length;
      skip();
      if (text[i] !== "=") {
        i++;
        continue;
      }
      i++;
      fields[name.toLowerCase()] = unescapeText(value());
    }
    if (!closed)
      diagnostics.push({
        path: document.path,
        line,
        message: `BibTeX 条目 ${key} 未闭合`,
      });
    else
      entries.push({
        key,
        type,
        fields,
        path: document.path,
        line,
        version: document.version,
      });
  }
  for (const entry of entries) {
    const parent = entries.find(
      (candidate) => candidate.key === entry.fields.crossref,
    );
    if (parent) entry.fields = { ...parent.fields, ...entry.fields };
  }
  return { entries, diagnostics };
}
export function buildLatexIndex(
  documents: LatexDocument[],
  projectVersion = 0,
): LatexIndex {
  const index: LatexIndex = {
    documents,
    projectVersion,
    entries: [],
    symbols: [],
    diagnostics: [],
  };
  for (const doc of documents) {
    if (/\.bib$/i.test(doc.path)) {
      const bib = parseBibtex(doc);
      index.entries.push(...bib.entries);
      index.diagnostics.push(...bib.diagnostics);
      continue;
    }
    const content = withoutLatexComments(doc.content);
    for (const match of content.matchAll(
      /\\label\s*\{([^{}]+)\}|\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand)\*?\s*\{?\\([A-Za-z@]+)|\\(?:def|gdef|edef|xdef)\s*\\([A-Za-z@]+)|\\(?:newenvironment|renewenvironment)\*?\s*\{([^{}]+)\}|\\(?:NewDocumentCommand|RenewDocumentCommand)\s*\{?\\([A-Za-z@]+)/g,
    )) {
      const name = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5]!;
      const parameters = /^\s*\}?\s*\[(\d)\]/.exec(
        content.slice(match.index + match[0].length),
      )?.[1];
      index.symbols.push({
        ...(parameters ? { parameters: Number(parameters) } : {}),
        name,
        kind: match[1] ? "label" : match[4] ? "environment" : "command",
        path: doc.path,
        line: content.slice(0, match.index).split("\n").length,
      });
    }
    for (const match of content.matchAll(
      /\\(?:DeclareMathOperator|DeclarePairedDelimiter)\*?\s*\{?\\([A-Za-z@]+)|\\(?:newtheorem|NewDocumentEnvironment|RenewDocumentEnvironment)\*?\s*\{([^{}]+)\}/g,
    )) {
      index.symbols.push({
        name: match[1] ?? match[2]!,
        kind: match[1] ? "command" : "environment",
        path: doc.path,
        line: content.slice(0, match.index).split("\n").length,
      });
    }
  }
  const counts = new Map<string, number>();
  for (const entry of index.entries)
    counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1);
  for (const entry of index.entries)
    if (counts.get(entry.key)! > 1)
      index.diagnostics.push({
        path: entry.path,
        line: entry.line,
        message: `重复引用标识 ${entry.key}，请先消除冲突`,
      });
  return index;
}
export function searchBibliography(
  entries: BibEntry[],
  query: string,
): BibEntry[] {
  const terms = query
    .normalize("NFKC")
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return entries
    .filter((entry) => {
      const text = [entry.key, entry.type, ...Object.values(entry.fields)]
        .join(" ")
        .normalize("NFKC")
        .toLocaleLowerCase();
      return terms.every((term) => text.includes(term));
    })
    .sort(
      (a, b) =>
        Number(b.key.toLowerCase().startsWith(query.toLowerCase())) -
          Number(a.key.toLowerCase().startsWith(query.toLowerCase())) ||
        a.key.localeCompare(b.key),
    );
}
export interface CitationSlot {
  from: number;
  to: number;
  keys: string[];
}
export function citationSlot(
  text: string,
  cursor: number,
): CitationSlot | null {
  const prefix = withoutLatexComments(text.slice(0, cursor));
  const match =
    /\\(?:cite(?:p|t|alp|alt|author|year(?:par)?)?|autocite|parencite|textcite|footcite|smartcite|supercite|nocite)\*?(?:\s*\[[^\]\n]*\])*\s*\{([^{}]*)$/.exec(
      prefix,
    );
  if (!match) return null;
  const from = cursor - match[1]!.length,
    end = text.indexOf("}", cursor);
  if (end < 0 || /[{}\n]/.test(text.slice(cursor, end))) return null;
  return {
    from,
    to: end,
    keys: text
      .slice(from, end)
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean),
  };
}
