export const COMPILER_RESOURCE_VERSION = "siglum-0.1.4-bundles-1-dynamic-packages-1";

export function compilerResourceProgress(loadedBytes: number, totalBytes: number, resource: string, cached = false): { percent: number; detail: string } {
  const percent = totalBytes > 0 ? Math.min(100, Math.round((loadedBytes / totalBytes) * 100)) : 100;
  const source = cached ? "cache" : "download";
  return {
    percent,
    detail: `${percent}% · ${formatBytes(loadedBytes)} / ${formatBytes(totalBytes)} · ${source} · ${resource}`
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function trackedCompilerResourceName(url: string): string | null {
  const pathname = new URL(url, "http://fastwrite.local").pathname;
  if (pathname === "/busytex.wasm") return "busytex.wasm";
  const bundle = pathname.match(/^\/bundles\/([^/]+\.data\.gz)$/);
  return bundle?.[1] ?? null;
}

export function compilerPackageProgress(message: string): string | null {
  const missing = message.match(/^Missing:\s+([^,]+),\s+(?:fetching|loading)\s+(.+?)(?:\s+from CTAN)?\.\.\.$/i);
  if (missing) return `Downloading missing TeX package for ${missing[1]}: ${missing[2]}…`;
  const prefetch = message.match(/^\[FETCH\]\s+([^:]+):\s+starting fetch$/i);
  if (prefetch) return `Checking TeX package ${prefetch[1]}…`;
  const cached = message.match(/^\[FETCH\]\s+([^:]+):\s+loaded from cache$/i);
  if (cached) return `Loaded TeX package ${cached[1]} from cache`;
  const downloaded = message.match(/^Processed\s+(\d+)\s+TeX\/font files from\s+(.+)$/i);
  if (downloaded) return `Downloaded TeX package ${downloaded[2]} · ${downloaded[1]} files`;
  return null;
}

export interface CompilerBundleManifest {
  bundles: Record<string, { requires?: string[] }>;
  engines: Record<string, { required: string[] }>;
  packages: Record<string, string>;
}

export function resolveCompilerBundles(source: string, manifest: CompilerBundleManifest, eager: string[]): string[] {
  const selected = new Set([...(manifest.engines.pdflatex?.required ?? []), ...eager]);
  for (const match of source.matchAll(/\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
    for (const packageName of match[1]!.split(",").map((name) => name.trim())) {
      const bundle = manifest.packages[packageName];
      if (bundle) selected.add(bundle);
    }
  }
  const pending = [...selected];
  for (let index = 0; index < pending.length; index += 1) {
    const bundle = pending[index]!;
    for (const dependency of manifest.bundles[bundle]?.requires ?? []) if (!selected.has(dependency)) { selected.add(dependency); pending.push(dependency); }
  }
  return [...selected].sort();
}
