import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");
  const webPort = Number.parseInt(process.env.FASTWRITE_WEB_PORT ?? environment.FASTWRITE_WEB_PORT ?? "3002", 10);
  const apiOrigin = process.env.FASTWRITE_API_ORIGIN ?? environment.FASTWRITE_API_ORIGIN ?? `http://localhost:${process.env.FASTWRITE_PORT ?? environment.FASTWRITE_PORT ?? "3003"}`;
  return {
    plugins: [react()],
    publicDir: false,
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
            if (id.includes("lucide-react")) return "icons";
            if (id.includes("react-dom") || id.includes("/react/")) return "react-vendor";
          }
        }
      }
    }
  };
});
