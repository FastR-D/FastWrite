export const TEX_ENGINES = ["pdflatex", "xelatex", "lualatex"] as const;
export type TexEngine = (typeof TEX_ENGINES)[number];
export interface CompileSettings {
  engine: TexEngine;
  environmentId: string;
}
export interface TexEnvironmentStatus {
  id: string;
  label: string;
  engines: Array<{ engine: TexEngine; available: boolean; version?: string }>;
  tools: Array<{ name: string; available: boolean }>;
  sandboxAvailable: boolean;
  ready: boolean;
}
export function normalizeCompileSettings(input: unknown): CompileSettings {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("无效的编译设置");
  const value = input as Record<string, unknown>;
  if (
    !TEX_ENGINES.includes(value.engine as TexEngine) ||
    typeof value.environmentId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(value.environmentId)
  )
    throw new Error("请选择有效的编译引擎和环境");
  return {
    engine: value.engine as TexEngine,
    environmentId: value.environmentId,
  };
}
