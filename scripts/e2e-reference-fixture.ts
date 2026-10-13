import { createApplication } from "../apps/server/src/app";
import { referenceTestProvider } from "../apps/server/src/references/test-provider";
import { referencePdf } from "../apps/server/src/references/fixtures";
import { strToU8, zipSync } from "../apps/server/node_modules/fflate";
const calls: Array<{ operation: string; input: unknown }> = [];
const app = await createApplication(process.env.FASTWRITE_DATA_DIR!, { agentProvider: referenceTestProvider(calls), features: { serverAuth: false } });
const archive = zipSync({ "main.tex": strToU8("\\documentclass{article}\n\\begin{document}\n\\section{Introduction}\nREFERENCE_ONLY: problem, gap, approach.\\input{method}\\section{Conclusion}\nREFERENCE_END: bounded implications.\\end{document}"), "method.tex": strToU8("\\section{Method}\nREFERENCE_METHOD: topic, support, transition.") });
const pdf = referencePdf([["Introduction", "A synthetic example first frames a problem, then describes a gap."], ["Conclusion", "The final paragraph provides a bounded interpretation."]]);
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.FASTWRITE_PORT ?? 0), async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/__reference_e2e__/archive") return new Response(archive);
  if (path === "/__reference_e2e__/pdf") return new Response(pdf);
  if (path === "/__reference_e2e__/calls") return Response.json(calls);
  return app(request);
} });
console.log(`REFERENCE_E2E_URL=http://127.0.0.1:${server.port}`);
