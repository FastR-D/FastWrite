import type { OutlineItem } from "@fastwrite/shared";

const LEVELS: Record<string, number> = { part: 0, chapter: 0, section: 1, subsection: 2, subsubsection: 3 };
const COMMAND = /\\(part|chapter|section|subsection|subsubsection|input|include|subfile)\*?\s*\{/g;

export type LatexDocumentEntry =
  | { type: "heading"; item: OutlineItem }
  | { type: "include"; path: string; line: number };

export function parseLatexDocumentEntries(content: string, path: string): LatexDocumentEntry[] {
  const source = maskComments(content);
  const entries: LatexDocumentEntry[] = [];
  for (const match of source.matchAll(COMMAND)) {
    const command = match[1];
    if (!command || match.index === undefined) continue;
    const open = match.index + match[0].lastIndexOf("{");
    const value = readBalancedArgument(source, open);
    if (!value) continue;
    const line = lineAt(source, match.index);
    const text = content.slice(value.from, value.to).replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (command === "input" || command === "include" || command === "subfile") {
      entries.push({ type: "include", path: text, line });
    } else {
      entries.push({ type: "heading", item: { id: `${path}:${line}`, title: text, level: LEVELS[command] ?? 1, path, line, children: [] } });
    }
  }
  return entries;
}

export function parseLatexOutline(content: string, path: string): OutlineItem[] {
  return buildLatexOutline(parseLatexDocumentEntries(content, path).flatMap((entry) => entry.type === "heading" ? [entry.item] : []));
}

export function parseLatexOutlineLine(line: string, path: string, lineNumber: number): OutlineItem | null {
  const entry = parseLatexDocumentEntries(line, path).find((candidate) => candidate.type === "heading");
  return entry?.type === "heading" ? { ...entry.item, id: `${path}:${lineNumber}`, line: lineNumber } : null;
}

export function buildLatexOutline(items: OutlineItem[]): OutlineItem[] {
  const roots: OutlineItem[] = [];
  const stack: OutlineItem[] = [];
  for (const item of items) {
    while (stack.length > 0 && (stack.at(-1)?.level ?? -1) >= item.level) stack.pop();
    const parent = stack.at(-1);
    if (parent) parent.children.push(item);
    else roots.push(item);
    stack.push(item);
  }
  return roots;
}

function maskComments(content: string): string {
  return content.split("\n").map((line) => {
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] !== "%") continue;
      let slashes = 0;
      for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) slashes += 1;
      if (slashes % 2 === 0) return line.slice(0, index) + " ".repeat(line.length - index);
    }
    return line;
  }).join("\n");
}

function readBalancedArgument(content: string, open: number): { from: number; to: number } | null {
  let depth = 0;
  for (let index = open; index < content.length; index += 1) {
    if (content[index] === "{" && content[index - 1] !== "\\") depth += 1;
    if (content[index] === "}" && content[index - 1] !== "\\") {
      depth -= 1;
      if (depth === 0) return { from: open + 1, to: index };
    }
  }
  return null;
}

function lineAt(content: string, offset: number): number {
  return content.slice(0, offset).split("\n").length;
}
