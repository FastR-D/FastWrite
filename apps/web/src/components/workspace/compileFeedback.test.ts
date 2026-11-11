import { describe, expect, test } from "bun:test";
import { compileFeedback } from "./compileFeedback";

const current = { state: "success" as const, progress: "编译成功", hasPdf: true, buffersDirty: false, compiledVersion: 7, projectVersion: 7 };

describe("PDF feedback reflects the displayed snapshot", () => {
  test("a current PDF retains the successful compilation message", () => {
    expect(compileFeedback(current)).toMatchObject({ tone: "success", message: "编译成功" });
  });
  test("unsaved changes and saved newer versions both keep the outdated warning", () => {
    expect(compileFeedback({ ...current, buffersDirty: true })).toMatchObject({ tone: "stale", message: "有未保存的更改 · PDF 待更新" });
    expect(compileFeedback({ ...current, projectVersion: 8 })).toMatchObject({ tone: "stale", message: "源文件已更新 · PDF 待更新" });
  });
  test("a running compilation takes precedence over an outdated warning", () => {
    expect(compileFeedback({ ...current, state: "loading", projectVersion: 8, progress: "正在准备工作区快照…" })).toMatchObject({ tone: "loading", message: "正在编译 · 显示上次 PDF", detail: "正在准备工作区快照…" });
  });
  test("failures keep a concise summary and the compiler details separately", () => {
    expect(compileFeedback({ ...current, state: "error", buffersDirty: true, progress: "Undefined control sequence at line 12" })).toMatchObject({ tone: "error", message: "编译失败 · 显示上次 PDF", detail: "Undefined control sequence at line 12" });
    expect(compileFeedback({ ...current, state: "error", hasPdf: false }).message).toBe("编译失败");
  });
  test("a failed PDF renderer cannot display a successful status", () => {
    expect(compileFeedback({ ...current, previewError: "Invalid PDF structure" })).toMatchObject({ tone: "error", message: "PDF 预览失败", detail: "Invalid PDF structure" });
  });
  test("without a PDF, editing does not suggest an outdated preview exists", () => {
    expect(compileFeedback({ ...current, state: "idle", hasPdf: false, compiledVersion: null, buffersDirty: true, progress: "准备编译" })).toMatchObject({ tone: "idle", message: "准备编译" });
  });
});
