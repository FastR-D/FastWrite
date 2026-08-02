# FastWrite

需要 [Bun](https://bun.sh/) 1.3+ 和 Git。

## 开发运行

```bash
bun install
bun run dev
```

打开 <http://localhost:3002>。API 默认运行于 <http://localhost:3003>。

## 生产运行

```bash
bun install
bun run build
bun start
```

打开 <http://localhost:3003>。

可通过 `FASTWRITE_PORT` 修改端口，通过 `FASTWRITE_DATA_DIR` 指定 Workspace 数据目录。
使用 Agent、Revise 和 Review 时在 `.env` 设置 `OPENAI_API_KEY`（兼容现有 `OPENAI_KEY`）以及可选的 `OPENAI_BASE_URL`（兼容现有 `OPENAI_API_BASE`）。自定义端点会自动选择可用模型，也可用 `FASTWRITE_OPENAI_MODEL` 显式覆盖。常规 Agent 默认超时 120 秒，多文件初稿生成默认 300 秒；可用 `FASTWRITE_AGENT_TIMEOUT_MS` 覆盖。导入私有 GitHub Repository 时设置 `FASTWRITE_GITHUB_TOKEN`。

验证 `.env` 中的真实 LLM 配置：

```bash
bun run llm:smoke
```
