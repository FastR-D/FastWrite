import type { CompileState } from "./PdfPane";

export function compileFeedback({ state, progress, hasPdf, buffersDirty, compiledVersion, projectVersion, previewError = "" }: {
  state: CompileState;
  progress: string;
  hasPdf: boolean;
  buffersDirty: boolean;
  compiledVersion: number | null;
  projectVersion: number;
  previewError?: string;
}) {
  const outdated = hasPdf && (buffersDirty || compiledVersion !== projectVersion);
  if (state === "error") return { tone: "error", message: hasPdf ? "编译失败 · 显示上次 PDF" : "编译失败", detail: progress } as const;
  if (previewError) return { tone: "error", message: "PDF 预览失败", detail: previewError } as const;
  if (state === "loading" || state === "compiling") return { tone: "loading", message: hasPdf ? "正在编译 · 显示上次 PDF" : "正在编译", detail: progress } as const;
  if (outdated) return { tone: "stale", message: buffersDirty ? "有未保存的更改 · PDF 待更新" : "源文件已更新 · PDF 待更新", detail: "重新编译后更新预览，并恢复与源文件的双向定位。" } as const;
  return { tone: state, message: progress, detail: progress } as const;
}
