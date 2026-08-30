# FastWrite

需要 [Bun](https://bun.sh/) 1.3+ 和 Git。

## 开发运行

```bash
bun install
bun run dev
```

打开 <http://localhost:3002>。API 默认运行于 <http://localhost:3003>。

浏览器 WASM 编译器会在编译时自动识别缺少的 TeX 包，由 FastWrite Server 从兼容的 TeX Live/CTAN 源按需下载；下载结果会在服务端和浏览器中缓存，不需要预先同步 `local-packages`。

选定 venue 的 LaTeX 模板首次成功获取后会缓存到 `FASTWRITE_DATA_DIR/templates/`（未配置时为默认数据目录）；后续初始化直接使用本地缓存，不会重复下载。

## 生产运行

```bash
bun install
bun run build
bun start
```

打开 <http://localhost:3003>。

可通过 `FASTWRITE_PORT` 修改端口，通过 `FASTWRITE_DATA_DIR` 指定 Workspace 数据目录。

## 开发说明

写作质量接口：`POST /api/projects/:projectId/writing-checks` 执行确定性检查；`GET /api/projects/:projectId/argument-graph` 获取论证关系；`POST /api/projects/:projectId/adversarial-memo` 生成仅供参考的对抗预检意见。Claim 侧栏支持 stale claim 的 reanchor；Agent 生成候选会校验 Writing Guard 与 evidence dependencies；Review 报告会显示各 pass 的完成、失败或跳过状态。评测可运行 `bun run writing:eval`。

先让Agent解决 BUG.md中问题，解决了的移到BUG-done.md。
等待期间，去测试功能，将Bug记录到BUG-new，等完成再继续下一轮Bug修改。

## 可运行发布包

```bash
bun run package:app
./app-bin/fastwrite
```

该命令生成可直接发布的单个 `app-bin/fastwrite`。Web 静态资源嵌入该二进制；外置的 `app-bin/skills/` 和 `app-bin/paperdata/` 与二进制并列，后者保存 Workspace、导入和编译缓存，重新打包不会删除它。根目录存在 `.env` 时会在首次打包时复制至 `app-bin/.env`，否则生成 `.env.example`；二进制会自动加载同级 `.env`。浏览器打开二进制输出的地址即可正常测试和编辑 Paper。

`.github/workflows/ci.yml` 会在 push 和 pull request 时自动运行类型检查、单元测试、构建和浏览器 E2E。推送与根 `package.json` 版本一致的标签（例如 `v0.1.0`）会触发 `.github/workflows/release.yml`，在完整测试通过后创建 GitHub Release，并发布 Linux x64、Windows x64、macOS Intel 和 macOS Apple Silicon 安装包。macOS 包当前未进行 Apple Developer 签名或 notarization，首次运行可能出现 Gatekeeper 提示。

在 `.env` 设置 `OPENAI_API_KEY`（兼容 `OPENAI_KEY`）以及可选的 `OPENAI_BASE_URL`（兼容 `OPENAI_API_BASE`）即可为全部 AI 工作流提供默认 Provider；`FASTWRITE_OPENAI_MODEL` 可显式选择默认模型，`FASTWRITE_OPENAI_WIRE_API` 可选择 `responses` 或 `chat`。也可为 `COMPLETION`、`AGENT`、`REVISE`、`REVIEW`、`MEMORY`、`RESEARCH` 分别设置 `FASTWRITE_<WORKFLOW>_API_KEY`、`FASTWRITE_<WORKFLOW>_BASE_URL`、`FASTWRITE_<WORKFLOW>_MODEL` 和 `FASTWRITE_<WORKFLOW>_WIRE_API`，每个字段独立回退到全局值；兼容现有 OpenAI 命名的配置别名。Project settings 也支持粘贴 Codex 风格 TOML 或等价 YAML provider 配置，并从 `model`、`base_url` 和 `wire_api` 填充设置；API key 仍单独输入且不会回传。Agent 规划、普通 AI 操作以及 `/draft`、`/continue`、`/revise` 的完整文件生成默认超时均为 300 秒，可用 `FASTWRITE_AGENT_TIMEOUT_MS` 覆盖（最大 600 秒）。导入私有 GitHub Repository 时设置 `FASTWRITE_GITHUB_TOKEN`。

验证 `.env` 中的真实 LLM 配置：

```bash
bun run llm:smoke
```
