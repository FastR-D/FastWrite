export interface DiffPart {
  type: "equal" | "delete" | "insert";
  value: string;
}

const TOKEN_PATTERN = /(\s+|[^\s\p{L}\p{N}_]+|[\p{L}\p{N}_]+)/gu;

export function diffWords(before: string, after: string): DiffPart[] {
  if (before === after) return before ? [{ type: "equal", value: before }] : [];
  const left = before.match(TOKEN_PATTERN) ?? [];
  const right = after.match(TOKEN_PATTERN) ?? [];
  let prefix = 0;
  while (left[prefix] === right[prefix] && prefix < left.length && prefix < right.length) prefix += 1;
  let suffix = 0;
  while (left[left.length - 1 - suffix] === right[right.length - 1 - suffix] && suffix < left.length - prefix && suffix < right.length - prefix) suffix += 1;

  const head = left.slice(0, prefix).join("");
  const tail = suffix ? left.slice(left.length - suffix).join("") : "";
  const oldMiddle = left.slice(prefix, left.length - suffix);
  const newMiddle = right.slice(prefix, right.length - suffix);
  const middle = oldMiddle.length * newMiddle.length > 160_000
    ? compactReplacement(oldMiddle, newMiddle)
    : lcsDiff(oldMiddle, newMiddle);
  return mergeParts([
    ...(head ? [{ type: "equal" as const, value: head }] : []),
    ...middle,
    ...(tail ? [{ type: "equal" as const, value: tail }] : [])
  ]);
}

function lcsDiff(left: string[], right: string[]): DiffPart[] {
  const rows = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      rows[i]![j] = left[i] === right[j] ? rows[i + 1]![j + 1]! + 1 : Math.max(rows[i + 1]![j]!, rows[i]![j + 1]!);
    }
  }
  const result: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      result.push({ type: "equal", value: left[i++]! });
      j += 1;
    } else if (j < right.length && (i === left.length || rows[i]![j + 1]! > rows[i + 1]![j]!)) {
      result.push({ type: "insert", value: right[j++]! });
    } else {
      result.push({ type: "delete", value: left[i++]! });
    }
  }
  return result;
}

function compactReplacement(left: string[], right: string[]): DiffPart[] {
  return [
    ...(left.length ? [{ type: "delete" as const, value: left.join("") }] : []),
    ...(right.length ? [{ type: "insert" as const, value: right.join("") }] : [])
  ];
}

function mergeParts(parts: DiffPart[]): DiffPart[] {
  return parts.reduce<DiffPart[]>((merged, part) => {
    const previous = merged.at(-1);
    if (previous?.type === part.type) previous.value += part.value;
    else if (part.value) merged.push({ ...part });
    return merged;
  }, []);
}
