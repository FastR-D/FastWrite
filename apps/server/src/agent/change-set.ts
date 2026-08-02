import { buildTextHunks, type FileContentResponse, type TextChange } from "@fastwrite/shared";

export function replaceFileChange(path: string, opened: FileContentResponse, after: string): TextChange {
  return {
    operation: "replace",
    path,
    from: 0,
    to: opened.content.length,
    before: opened.content,
    after,
    baseVersion: opened.file.version,
    baseContent: opened.content,
    currentVersion: opened.file.version,
    hunks: buildTextHunks(opened.content, after)
  };
}

export function replaceSelectionChange(path: string, opened: FileContentResponse, from: number, to: number, after: string): TextChange {
  const before = opened.content.slice(from, to);
  return {
    operation: "replace",
    path,
    from,
    to,
    before,
    after,
    baseVersion: opened.file.version,
    baseContent: opened.content,
    currentVersion: opened.file.version,
    hunks: buildTextHunks(before, after)
  };
}

export function createFileChange(path: string, content: string): TextChange {
  return {
    operation: "create",
    path,
    from: 0,
    to: 0,
    before: "",
    after: content,
    baseVersion: 0,
    baseContent: "",
    currentVersion: 0,
    hunks: buildTextHunks("", content)
  };
}
