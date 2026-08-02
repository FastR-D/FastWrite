import type { TextHunk } from "./models";

interface LineToken { text: string; start: number; end: number }

function lines(text: string): LineToken[] {
  const tokens: LineToken[] = [];
  const pattern = /[^\n]*\n|[^\n]+$/g;
  for (const match of text.matchAll(pattern)) tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  return tokens;
}

function uniqueIndices(tokens: LineToken[]): Map<string, number> {
  const counts = new Map<string, number>();
  const indices = new Map<string, number>();
  tokens.forEach((token, index) => { counts.set(token.text, (counts.get(token.text) ?? 0) + 1); indices.set(token.text, index); });
  for (const [text, count] of counts) if (count !== 1) indices.delete(text);
  return indices;
}

function longestIncreasingAnchors(pairs: Array<[number, number]>): Array<[number, number]> {
  const tails: number[] = [];
  const tailIndices: number[] = [];
  const previous = new Array<number>(pairs.length).fill(-1);
  pairs.forEach(([, afterIndex], pairIndex) => {
    let low = 0; let high = tails.length;
    while (low < high) { const middle = (low + high) >> 1; if (tails[middle]! < afterIndex) low = middle + 1; else high = middle; }
    tails[low] = afterIndex;
    previous[pairIndex] = low > 0 ? tailIndices[low - 1]! : -1;
    tailIndices[low] = pairIndex;
  });
  if (!tailIndices.length) return [];
  const result: Array<[number, number]> = [];
  let index = tailIndices[tailIndices.length - 1]!;
  while (index >= 0) { result.push(pairs[index]!); index = previous[index]!; }
  return result.reverse();
}

export function buildTextHunks(before: string, after: string): TextHunk[] {
  if (before === after) return [];
  const beforeLines = lines(before);
  const afterLines = lines(after);
  const afterUnique = uniqueIndices(afterLines);
  const beforeUnique = uniqueIndices(beforeLines);
  const pairs = longestIncreasingAnchors(beforeLines.flatMap((line, index) => {
    const afterIndex = beforeUnique.has(line.text) ? afterUnique.get(line.text) : undefined;
    return afterIndex === undefined ? [] : [[index, afterIndex] as [number, number]];
  }));
  const anchors: Array<[number, number]> = [[-1, -1], ...pairs, [beforeLines.length, afterLines.length]];
  const hunks: TextHunk[] = [];
  for (let index = 1; index < anchors.length; index += 1) {
    const [previousBefore, previousAfter] = anchors[index - 1]!;
    const [nextBefore, nextAfter] = anchors[index]!;
    const beforeStartLine = previousBefore + 1;
    const afterStartLine = previousAfter + 1;
    if (beforeStartLine === nextBefore && afterStartLine === nextAfter) continue;
    const from = beforeStartLine < beforeLines.length ? beforeLines[beforeStartLine]!.start : before.length;
    const to = nextBefore > beforeStartLine ? beforeLines[nextBefore - 1]!.end : from;
    const afterStart = afterStartLine < afterLines.length ? afterLines[afterStartLine]!.start : after.length;
    const afterEnd = nextAfter > afterStartLine ? afterLines[nextAfter - 1]!.end : afterStart;
    hunks.push({ id: `hunk-${hunks.length + 1}`, from, to, before: before.slice(from, to), after: after.slice(afterStart, afterEnd), status: "pending" });
  }
  return hunks.length ? hunks : [{ id: "hunk-1", from: 0, to: before.length, before, after, status: "pending" }];
}

export function materializeTextHunks(before: string, hunks: TextHunk[]): string {
  let cursor = 0;
  let result = "";
  for (const hunk of [...hunks].sort((a, b) => a.from - b.from)) {
    if (hunk.from < cursor || hunk.to < hunk.from || before.slice(hunk.from, hunk.to) !== hunk.before) throw new Error("Invalid text hunk range");
    result += before.slice(cursor, hunk.from);
    result += hunk.status === "accepted" ? hunk.after : hunk.before;
    cursor = hunk.to;
  }
  return result + before.slice(cursor);
}
