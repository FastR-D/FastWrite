import { gzipSync } from "node:zlib";
import type { Plugin } from "vite";

const HEAVY_MODULE = /\/node_modules\/(?:.*\/)?(?:monaco-editor|pdfjs-dist|react-pdf|@siglum\/[^/]+|xzwasm|blake3-wasm)(?:\/|@)/;

/** Assert the actual emitted graph, so future shared imports cannot undo lazy routing. */
export function startupAssets(): Plugin {
  return {
    name: "fastwrite-startup-assets",
    enforce: "post",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const chunks = Object.values(bundle).filter((item) => item.type === "chunk");
        const initial = chunks.filter((chunk) => chunk.isEntry || chunk.facadeModuleId?.replaceAll("\\", "/").endsWith("/pages/ProjectsPage.tsx"));
        const visited = new Set<string>();
        const visit = (fileName: string): void => {
          if (visited.has(fileName)) return;
          visited.add(fileName);
          const chunk = bundle[fileName];
          if (chunk?.type !== "chunk") return;
          const heavyweight = Object.keys(chunk.modules).find((id) => HEAVY_MODULE.test(id.replaceAll("\\", "/")));
          if (heavyweight) this.error(`The home/project-list startup depends on an editor-only module: ${heavyweight} (in ${fileName})`);
          chunk.imports.forEach(visit);
        };
        initial.forEach((chunk) => visit(chunk.fileName));
        this.emitFile({
          type: "asset",
          fileName: "startup-assets.json",
          source: JSON.stringify({
            checked: ["entry", "project-list"],
            chunks: [...visited].map((fileName) => {
              const chunk = bundle[fileName];
              return { fileName, bytes: chunk?.type === "chunk" ? Buffer.byteLength(chunk.code) : 0 };
            }),
            editorOnly: chunks.filter((chunk) => Object.keys(chunk.modules).some((id) => HEAVY_MODULE.test(id.replaceAll("\\", "/")))).map((chunk) => chunk.fileName)
          }, null, 2)
        });
        // Precompress text assets once at build time. TeX .data.gz bundles are
        // application archives and must retain their original HTTP encoding.
        for (const item of Object.values(bundle)) {
          if (!/\.(?:html|js|mjs|css|svg|json)$/.test(item.fileName)) continue;
          const source = item.type === "chunk" ? item.code : item.source;
          this.emitFile({ type: "asset", fileName: `${item.fileName}.gz`, source: gzipSync(source, { level: 9 }) });
        }
      }
    }
  };
}
