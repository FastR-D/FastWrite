import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import topLevelAwait from "vite-plugin-top-level-await";
import wasm from "vite-plugin-wasm";

function siglumStaticHeaders(): Plugin {
  return {
    name: "fastwrite-siglum-static-headers",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url && (/^\/bundles\//.test(request.url) || /^\/(?:busytex\.wasm|worker\.js)(?:\?|$)/.test(request.url))) {
          response.setHeader("Cache-Control", "public, max-age=3600");
        }
        if (request.url?.startsWith("/bundles/") && request.url.endsWith(".data.gz")) {
          // Siglum receives and decompresses these bytes itself.
          response.setHeader("Content-Type", "application/octet-stream");
          response.setHeader("Content-Encoding", "identity");
        }
        next();
      });
    }
  };
}

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");
  const webPort = Number.parseInt(process.env.FASTWRITE_WEB_PORT ?? environment.FASTWRITE_WEB_PORT ?? "3002", 10);
  const apiOrigin = process.env.FASTWRITE_API_ORIGIN ?? environment.FASTWRITE_API_ORIGIN ?? `http://localhost:${process.env.FASTWRITE_PORT ?? environment.FASTWRITE_PORT ?? "3003"}`;
  return {
    plugins: [siglumStaticHeaders(), react(), wasm(), topLevelAwait()],
    server: {
      host: "127.0.0.1",
      port: webPort,
      strictPort: true,
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp"
      },
      proxy: {
        "/api": apiOrigin
      }
    },
    clearScreen: false,
    build: {
      target: "esnext",
      sourcemap: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes("node_modules")) return;
            if (id.includes("monaco-editor")) return "monaco";
            if (id.includes("pdfjs-dist") || id.includes("react-pdf")) return "pdf";
            if (id.includes("@siglum/") || id.includes("blake3-wasm") || id.includes("xzwasm")) return "latex-engine";
            if (id.includes("lucide-react")) return "icons";
            if (id.includes("react-dom") || id.includes("/react/")) return "react-vendor";
          }
        }
      }
    },
    optimizeDeps: {
      exclude: ["@siglum/engine", "blake3-wasm"]
    },
    resolve: {
      alias: {
        "./blake3_js_bg.js": "./blake3_js_bg.wasm"
      }
    }
  };
});
