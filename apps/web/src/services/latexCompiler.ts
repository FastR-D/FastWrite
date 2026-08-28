import type { SiglumCompiler } from "@siglum/engine";
import xzwasmUrl from "xzwasm/dist/package/xzwasm.min.js?url";
import { COMPILER_BUNDLES_URL, COMPILER_RESOURCE_VERSION, compilerDependencyPackages, compilerFontPackages, compilerPackageProgress, compilerResourceProgress, resolveCompilerBundles, type CompilerBundleManifest } from "./compilerResources";

export interface BrowserCompileResult {
  success: boolean;
  pdf?: Uint8Array;
  syncTexData?: unknown;
  log: string;
  error?: string;
  exitCode?: number;
}

export interface CompilerProgress {
  stage: string;
  detail: string;
  percent?: number;
  loadedBytes?: number;
  totalBytes?: number;
  resource?: string;
}

const progressListeners = new Set<(progress: CompilerProgress) => void>();
let compiler: SiglumCompiler | null = null;
let initialization: Promise<void> | null = null;
let logMessages: string[] = [];
let resourceAbortController: AbortController | null = null;

const NETWORK_VERSION_KEY = "fastwrite.compiler.network-version";
const NETWORK_FORCE_REFRESH_KEY = "fastwrite.compiler.force-refresh";
const EAGER_BUNDLES: string[] = [];

async function instance(): Promise<SiglumCompiler> {
  if (!compiler) {
    const { SiglumCompiler } = await import("@siglum/engine");
    compiler = new SiglumCompiler({
      bundlesUrl: COMPILER_BUNDLES_URL,
      wasmUrl: "/busytex.wasm",
      workerUrl: "/worker.js",
      xzwasmUrl,
      ctanProxyUrl: window.location.origin,
      enableCtan: true,
      enableLazyFS: true,
      enableDocCache: true,
      maxRetries: 15,
      verbose: true,
      eagerBundles: EAGER_BUNDLES,
      onLog: (message: string) => {
        logMessages.push(message);
        const detail = compilerPackageProgress(message);
        if (detail) notifyProgress({ stage: "packages", detail });
      },
      onProgress: (stage: string, detail: string) => {
        for (const listener of progressListeners) listener({ stage, detail });
      }
    });
  }
  return compiler;
}

export function subscribeCompilerProgress(listener: (progress: CompilerProgress) => void): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

export async function initializeCompiler(): Promise<void> {
  if (!initialization) {
    initialization = instance().then((activeCompiler) => activeCompiler.init()).catch((error) => {
      initialization = null;
      throw error;
    });
  }
  return initialization;
}

export async function compileLatex(source: string, additionalFiles: Record<string, string | Uint8Array>): Promise<BrowserCompileResult> {
  resourceAbortController?.abort();
  const controller = new AbortController();
  resourceAbortController = controller;
  try {
    const prescannedSource = withDependencyPrescan(source, additionalFiles);
    const networkSummary = await preloadCompilerResources(prescannedSource, additionalFiles, controller.signal);
    await initializeCompiler();
    logMessages = [];
    const activeCompiler = await instance();
    await preloadFontMetrics(activeCompiler, compilerFontPackages(source, additionalFiles));
    const result = await activeCompiler.compile(prescannedSource, {
      additionalFiles,
      useCache: Object.keys(additionalFiles).length === 0
    });
    return {
      success: result.success,
      ...(result.pdf ? { pdf: new Uint8Array(result.pdf) } : {}),
      ...(result.syncTexData ? { syncTexData: result.syncTexData } : {}),
      log: `[FastWrite resources] ${networkSummary} Missing TeX packages are downloaded on demand and cached in the browser.\n${result.log || logMessages.join("\n")}`,
      ...(result.error ? { error: result.error } : {}),
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode })
    };
  } finally {
    if (resourceAbortController === controller) resourceAbortController = null;
  }
}

async function preloadFontMetrics(activeCompiler: SiglumCompiler, packages: string[]): Promise<void> {
  for (const packageName of packages) {
    notifyProgress({ stage: "packages", detail: `Loading TeX font metrics for ${packageName}…` });
    const result = await activeCompiler.ctanFetcher.fetchPackage(packageName);
    if (!result) throw new Error(`Could not load required TeX font metrics for ${packageName}`);
  }
}

export function cancelCompiler(): void {
  resourceAbortController?.abort();
  resourceAbortController = null;
  compiler?.unload();
  compiler = null;
  initialization = null;
  logMessages = [];
}

export async function repairCompilerCache(): Promise<void> {
  await compiler?.clearCache();
  cancelCompiler();
  localStorage.removeItem(NETWORK_VERSION_KEY);
  localStorage.setItem(NETWORK_FORCE_REFRESH_KEY, "1");
  const { fileSystem } = await import("@siglum/filesystem");
  if (await fileSystem.exists("/bundle-cache/bundles")) {
    await fileSystem.rmdir("/bundle-cache/bundles", { recursive: true, silent: true });
    if (await fileSystem.exists("/bundle-cache/bundles")) throw new Error("Could not clear the TeX bundle cache");
  }
  await Promise.all([
    "/bundle-cache/version",
    "/manifests/version",
    "/manifests/file-manifest.json",
    "/manifests/bundles.json",
    "/manifests/package-deps.json",
    "/wasm-cache/memory-snapshot.bin",
    "/wasm-cache/memory-snapshot-meta.json"
  ].map(async (path) => { if (await fileSystem.exists(path)) await fileSystem.deleteFile(path, { silent: true }); }));
  await clearIndexedDbStore("siglum-wasm-cache", "modules");
  try {
    const formatEntries = await fileSystem.readdir("/fmt-cache");
    await Promise.all(formatEntries.filter((entry) => !entry.isDirectory && entry.name.endsWith(".fmt")).map(async (entry) => { try { await fileSystem.deleteFile(`/fmt-cache/${entry.name}`, { silent: true }); } catch { /* Ignore individual stale entries. */ } }));
  } catch { /* The format cache may not have been created yet. */ }
  if ("storage" in navigator && "getDirectory" in navigator.storage) {
    const root = await navigator.storage.getDirectory();
    const knownEntries = ["bundles", "version", "file-manifest.json", "bundles.json", "package-deps.json", "memory-snapshot.bin", "memory-snapshot-meta.json"];
    await Promise.all(knownEntries.map(async (name) => { try { await root.removeEntry(name, { recursive: name === "bundles" }); } catch (error) { if ((error as DOMException).name !== "NotFoundError") throw error; } }));
    const entries = root as unknown as AsyncIterable<[string, FileSystemHandle]>;
    for await (const [name, handle] of entries) if (handle.kind === "file" && name.endsWith(".fmt")) await root.removeEntry(name);
  }
  notifyProgress({ stage: "repair", detail: "Compiler cache repaired. Resources will be verified again." });
}

function notifyProgress(progress: CompilerProgress) {
  for (const listener of progressListeners) listener(progress);
}

function withDependencyPrescan(source: string, additionalFiles: Record<string, string | Uint8Array>): string {
  const packages = compilerDependencyPackages(source, additionalFiles);
  if (!packages.length) return source;
  return `${source}\n${packages.map((packageName) => `% \\RequirePackage{${packageName}}`).join("\n")}`;
}

async function preloadCompilerResources(source: string, additionalFiles: Record<string, string | Uint8Array>, signal: AbortSignal): Promise<string> {
  const previousVersion = localStorage.getItem(NETWORK_VERSION_KEY);
  if (previousVersion && previousVersion !== COMPILER_RESOURCE_VERSION && localStorage.getItem(NETWORK_FORCE_REFRESH_KEY) !== "1") {
    await repairCompilerCache();
  }
  if (localStorage.getItem(NETWORK_VERSION_KEY) === COMPILER_RESOURCE_VERSION) return `WASM/bundle cache version ${COMPILER_RESOURCE_VERSION} reused without resource downloads.`;
  const forceRefresh = localStorage.getItem(NETWORK_FORCE_REFRESH_KEY) === "1";
  notifyProgress({ stage: "resources", detail: "Inspecting WASM and TeX bundle resources…" });
  const manifestResponse = await fetch(`${COMPILER_BUNDLES_URL}/bundles.json`, { signal, cache: forceRefresh ? "reload" : "default" });
  if (!manifestResponse.ok) throw new Error("TeX bundle manifest is unavailable");
  const manifest = await manifestResponse.json() as CompilerBundleManifest;
  const resources = ["/busytex.wasm", ...resolveCompilerBundles(source, manifest, EAGER_BUNDLES, additionalFiles).map((bundle) => `${COMPILER_BUNDLES_URL}/${bundle}.data.gz`)];
  const sizes = await Promise.all(resources.map(async (url) => {
    const response = await fetch(url, { method: "HEAD", signal, cache: forceRefresh ? "reload" : "default" });
    if (!response.ok) throw new Error(`Could not inspect compiler resource '${url}'`);
    return Number(response.headers.get("content-length")) || 0;
  }));
  const totalBytes = sizes.reduce((total, size) => total + size, 0);
  let loadedBytes = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < resources.length) {
      const index = cursor++;
      const url = resources[index]!;
      const expected = sizes[index]!;
      const resource = url.split("/").pop()!;
      const response = await fetch(url, { signal, cache: forceRefresh ? "reload" : "force-cache" });
      if (!response.ok || !response.body) throw new Error(`Could not load compiler resource '${url}'`);
      const reader = response.body.getReader();
      let resourceBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        resourceBytes += value.byteLength;
        loadedBytes += value.byteLength;
        const progress = compilerResourceProgress(loadedBytes, totalBytes || loadedBytes, resource, false);
        notifyProgress({ stage: "resources", detail: progress.detail, percent: progress.percent, loadedBytes, totalBytes: totalBytes || loadedBytes, resource });
      }
      if (expected && resourceBytes !== expected) throw new Error(`Compiler resource '${url}' failed its size check`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, resources.length) }, () => worker()));
  localStorage.setItem(NETWORK_VERSION_KEY, COMPILER_RESOURCE_VERSION);
  localStorage.removeItem(NETWORK_FORCE_REFRESH_KEY);
  return `${resources.length} WASM/bundle resources, ${loadedBytes} verified bytes, version ${COMPILER_RESOURCE_VERSION}.`;
}

async function clearIndexedDbStore(databaseName: string, storeName: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) { database.close(); resolve(); return; }
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).clear();
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  });
}
