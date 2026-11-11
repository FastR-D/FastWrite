import { createApplication } from "../../apps/server/src/app";
const provider = {
  revise: async () => ({ replacement: "", rationale: "fixture" }),
  assistantStep: async (input: any) => {
    const source =
      input.observation?.source ??
      (input.observation?.content ? input.observation : null);
    if (source?.content.includes("\\fixturebroken"))
      return {
        action: "propose_edit" as const,
        path: source.path,
        oldText: "\\fixturebroken",
        newText: "",
        explanation: "移除未定义的测试命令，保留全部正文。",
      };
    return {
      action: "finish" as const,
      path: "",
      oldText: "",
      newText: "",
      explanation: "请审核隔离编译验证后的候选。",
    };
  },
};
const app = await createApplication(process.env.FASTWRITE_DATA_DIR!, {
  features: { serverAuth: false },
  agentProvider: provider,
});
Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.FASTWRITE_PORT),
  fetch: app,
  idleTimeout: 255,
});
