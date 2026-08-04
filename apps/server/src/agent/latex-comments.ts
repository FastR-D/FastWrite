interface LatexComment {
  line: number;
  prefix: string;
  text: string;
  fullLine: boolean;
}

export function preserveLatexComments(before: string, generated: string): string {
  const originalLines = before.split("\n");
  const generatedLines = generated.split("\n");
  const comments = originalLines.flatMap((line, index) => {
    const offset = commentOffset(line);
    if (offset < 0) return [];
    return [{ line: index, prefix: line.slice(0, offset), text: line.slice(offset), fullLine: !line.slice(0, offset).trim() } satisfies LatexComment];
  });

  for (const comment of comments) {
    if (generatedLines.some((line) => line.includes(comment.text))) continue;
    if (!comment.fullLine) {
      const prefix = comment.prefix.trimEnd();
      const matchingLine = prefix ? generatedLines.findIndex((line) => line.trimEnd() === prefix.trim()) : -1;
      if (matchingLine >= 0) {
        generatedLines[matchingLine] = `${generatedLines[matchingLine]!.trimEnd()} ${comment.text}`;
        continue;
      }
    }
    const relativeLine = originalLines.length <= 1 ? 0 : comment.line / (originalLines.length - 1);
    const insertion = Math.min(generatedLines.length, Math.max(0, Math.round(relativeLine * Math.max(0, generatedLines.length - 1))));
    const indent = comment.prefix.match(/^\s*/)?.[0] ?? "";
    generatedLines.splice(insertion, 0, `${indent}${comment.text}`);
  }

  return generatedLines.join("\n");
}

function commentOffset(line: string): number {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== "%") continue;
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) slashes += 1;
    if (slashes % 2 === 0) return index;
  }
  return -1;
}
