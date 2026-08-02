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
  return {
    plugins: [siglumStaticHeaders(), react(), wasm(), topLevelAwait()],
    server: {
      port: 3002,
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp"
      },
      proxy: {
        "/api": environment.FASTWRITE_API_ORIGIN || "http://localhost:3003"
      }
    },
    build: {
      target: "esnext",
      sourcemap: true
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
