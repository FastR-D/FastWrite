export const COMPILER_RESOURCE_VERSION = "siglum-0.1.4-bundles-1-dynamic-packages-3";
export const COMPILER_BUNDLES_URL = "https://cdn.siglum.org/tl2025/bundles";

const PACKAGE_COMMAND = /\\(?:usepackage|RequirePackage|RequirePackageWithOptions|LoadClass|LoadClassWithOptions)(?:\[[^\]]*\])?\{([^}]+)\}/g;
const FONT_COMMAND = /\\font\s*\\?[A-Za-z@]+\s*=\s*([A-Za-z][A-Za-z0-9_-]*)/g;
const FONT_PACKAGE_PREFIXES: ReadonlyArray<readonly [string, string]> = [["phv", "helvetic"], ["ptm", "times"], ["pcr", "courier"]];
const FONT_PACKAGES = new Set(["times", "helvetic", "courier"]);
const FONT_PACKAGE_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  times: ["helvetic", "courier"]
};

export function compilerDependencyPackages(source: string, additionalFiles: Record<string, string | Uint8Array> = {}): string[] {
  const packages = new Set<string>();
  const scan = (content: string) => {
    for (const match of content.matchAll(PACKAGE_COMMAND)) {
      for (const packageName of match[1]!.split(",").map((name) => name.trim())) if (packageName) packages.add(packageName);
    }
    for (const match of content.matchAll(FONT_COMMAND)) {
      const fontName = match[1]!.toLowerCase();
      const fontPackage = FONT_PACKAGE_PREFIXES.find(([prefix]) => fontName.startsWith(prefix))?.[1];
      if (fontPackage) packages.add(fontPackage);
    }
  };

  scan(source);
  for (const [path, content] of Object.entries(additionalFiles)) {
    if (!/\.(?:sty|cls|tex)$/i.test(path)) continue;
    scan(typeof content === "string" ? content : new TextDecoder().decode(content));
  }
  return [...packages].sort();
}

export function compilerFontPackages(source: string, additionalFiles: Record<string, string | Uint8Array> = {}): string[] {
  const packages = new Set<string>();
  const addPackage = (packageName: string) => {
    if (!FONT_PACKAGES.has(packageName)) return;
    packages.add(packageName);
    for (const dependency of FONT_PACKAGE_DEPENDENCIES[packageName] ?? []) packages.add(dependency);
  };
  const scan = (content: string) => {
    for (const match of content.matchAll(PACKAGE_COMMAND)) {
      for (const packageName of match[1]!.split(",").map((name) => name.trim())) addPackage(packageName);
    }
    for (const match of content.matchAll(FONT_COMMAND)) {
      const fontName = match[1]!.toLowerCase();
      const fontPackage = FONT_PACKAGE_PREFIXES.find(([prefix]) => fontName.startsWith(prefix))?.[1];
      if (fontPackage) addPackage(fontPackage);
    }
  };
  scan(source);
  for (const [path, content] of Object.entries(additionalFiles)) {
    if (/\.(?:sty|cls|tex)$/i.test(path)) scan(typeof content === "string" ? content : new TextDecoder().decode(content));
  }
  return [...packages].sort();
}

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

export function resolveCompilerBundles(source: string, manifest: CompilerBundleManifest, eager: string[], additionalFiles: Record<string, string | Uint8Array> = {}): string[] {
  const selected = new Set([...(manifest.engines.pdflatex?.required ?? []), ...eager]);
  for (const packageName of compilerDependencyPackages(source, additionalFiles)) {
    const bundle = manifest.packages[packageName];
    if (bundle) selected.add(bundle);
  }
  const pending = [...selected];
  for (let index = 0; index < pending.length; index += 1) {
    const bundle = pending[index]!;
    for (const dependency of manifest.bundles[bundle]?.requires ?? []) if (!selected.has(dependency)) { selected.add(dependency); pending.push(dependency); }
  }
  return [...selected].sort();
}
