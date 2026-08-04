# FastWrite

需要 [Bun](https://bun.sh/) 1.3+ 和 Git。

## 开发运行

```bash
bun install
bun run dev
```

打开 <http://localhost:3002>。API 默认运行于 <http://localhost:3003>。

浏览器 WASM 编译器会在编译时自动识别缺少的 TeX 包，由 FastWrite Server 从兼容的 TeX Live/CTAN 源按需下载；下载结果会在服务端和浏览器中缓存，不需要预先同步 `local-packages`。

## 生产运行

```bash
bun install
bun run build
bun start
```

打开 <http://localhost:3003>。

可通过 `FASTWRITE_PORT` 修改端口，通过 `FASTWRITE_DATA_DIR` 指定 Workspace 数据目录。

## 开发说明

先让Agent解决 BUG.md中问题，解决了的移到BUG-done.md。
等待期间，去测试功能，将Bug记录到BUG-new，等完成再继续下一轮Bug修改。

## 可运行发布包

```bash
bun run package:app
./app-bin/fastwrite
```

该命令生成可直接发布的单个 `app-bin/fastwrite`。Web 静态资源嵌入该二进制；外置的 `app-bin/skills/` 和 `app-bin/paperdata/` 与二进制并列，后者保存 Workspace、导入和编译缓存，重新打包不会删除它。根目录存在 `.env` 时会在首次打包时复制至 `app-bin/.env`，否则生成 `.env.example`；二进制会自动加载同级 `.env`。浏览器打开二进制输出的地址即可正常测试和编辑 Paper。
在 `.env` 设置 `OPENAI_API_KEY`（兼容 `OPENAI_KEY`）以及可选的 `OPENAI_BASE_URL`（兼容 `OPENAI_API_BASE`）即可为全部 AI 工作流提供默认 Provider；`FASTWRITE_OPENAI_MODEL` 可显式选择默认模型。也可为 `COMPLETION`、`AGENT`、`REVISE`、`REVIEW`、`MEMORY` 分别设置 `FASTWRITE_<WORKFLOW>_API_KEY`、`FASTWRITE_<WORKFLOW>_BASE_URL` 和 `FASTWRITE_<WORKFLOW>_MODEL`，每个字段独立回退到全局值；兼容 OpenAI 命名的 `_OPENAI_API_KEY`、`_OPENAI_BASE_URL`、`_OPENAI_MODEL` 变体。这可直接用于为 Completion 配置 DeepSeek 等 OpenAI-compatible 端点。Agent 规划与普通 AI 操作默认超时 120 秒；`/draft`、`/continue`、`/revise` 的完整文件生成默认 300 秒，可用 `FASTWRITE_AGENT_TIMEOUT_MS` 覆盖。导入私有 GitHub Repository 时设置 `FASTWRITE_GITHUB_TOKEN`。

验证 `.env` 中的真实 LLM 配置：

```bash
bun run llm:smoke
```
