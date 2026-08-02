import type { FileContentResponse, OutlineItem, SourceLocation, TextSelection } from "@fastwrite/shared";

export function currentSectionSelection(document: FileContentResponse | null, outline: OutlineItem[], cursor: SourceLocation): TextSelection | null {
  if (!document || cursor.path !== document.file.path) return null;
  const sections = flattenOutline(outline).filter((item) => item.path === document.file.path).sort((a, b) => a.line - b.line);
  let activeIndex = -1;
  for (let index = 0; index < sections.length; index += 1) if (sections[index]!.line <= cursor.line) activeIndex = index;
  if (activeIndex < 0) return null;
  const active = sections[activeIndex]!;
  const nextPeer = sections.slice(activeIndex + 1).find((item) => item.level <= active.level);
  const lines = document.content.split("\n");
  const endLine = (nextPeer?.line ?? lines.length + 1) - 1;
  const from = offsetAtLine(lines, active.line);
  const to = nextPeer ? Math.max(from, offsetAtLine(lines, nextPeer.line) - 1) : document.content.length;
  return to > from ? {
    path: document.file.path, text: document.content.slice(from, to), from, to,
    startLine: active.line, endLine: Math.min(endLine, lines.length), fileVersion: document.file.version
  } : null;
}

function flattenOutline(items: OutlineItem[]): OutlineItem[] {
  return items.flatMap((item) => [item, ...flattenOutline(item.children)]);
}

function offsetAtLine(lines: string[], line: number): number {
  return lines.slice(0, Math.max(0, line - 1)).reduce((total, value) => total + value.length + 1, 0);
}
