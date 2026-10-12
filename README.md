# FastWrite

需要 [Bun](https://bun.sh/) 1.3+ 和 Git。

FastCAS SDK 固定在仓库内的 `packages/fastcas-sdk`，来源为 [FastR-D/FastCAS 的 sdk/typescript](https://github.com/FastR-D/FastCAS/tree/676d49b18f700c009f1f491280a93de7da294836/sdk/typescript)，版本提交 `676d49b18f700c009f1f491280a93de7da294836`。本地使用 TypeScript 源码导出并适配严格可选属性检查；无需克隆相邻的 FastCAS 仓库或预先构建 SDK。更新 SDK 时应同步检查上游接口和身份认证契约测试。

## 开发运行

```bash
bun install
bun run dev
```

打开 <http://localhost:3002>（Vite 前端代理 API）。

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

设置 `FASTWRITE_SERVER_AUTH=true` 后，Harness 状态与 MCP 目录查询需要登录；共享 CLI 的原始会话、运行记录、事件、审批及全局 Harness 配置修改仅允许平台管理员访问。项目内 AI 操作继续遵循项目权限，指定项目的 MCP 审计需要该项目的 Harness 使用权限，全局审计仅限管理员。原始 Harness WebSocket 使用与 HTTP 相同的 `Authorization: Bearer ...` 或 `X-FastWrite-Session` 请求头认证，不接受 URL 中的登录令牌；连接在握手、历史回放、每次事件推送及定时检查时校验权限。浏览器原生 WebSocket 无法设置这些请求头，浏览器客户端可使用已认证的 HTTP 事件接口。

启用 `FASTWRITE_SERVER_AUTH=true` 时，若数据库没有有效管理员，必须同时设置 `FASTWRITE_BOOTSTRAP_ADMIN_EMAIL` 和 `FASTWRITE_BOOTSTRAP_ADMIN_PASSWORD`（自行生成至少 12 位的唯一密码），否则服务拒绝启动。没有默认管理员账号或密码；公开注册始终创建普通用户。初始化成功后可以移除这两个变量，已有管理员可正常登录。修改初始化变量不会重置已有账号密码；升级前已使用旧版默认账号的部署需单独轮换该账号密码。

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

在 `.env` 设置 `FASTWRITE_HARNESS=codex` 或 `claude`，并配置 `FASTWRITE_HARNESS_API_KEY`、可选的 `FASTWRITE_HARNESS_BASE_URL`、`FASTWRITE_HARNESS_MODEL`、`FASTWRITE_HARNESS_WIRE_API` 和 `FASTWRITE_HARNESS_TIMEOUT_MS`，即可为全部 AI 工作流配置统一 Harness。Project Settings 也可运行时配置这些 Harness 参数；API key 只保存在内存中且不会回传。Agent 规划、普通 AI 操作以及 `/draft`、`/continue`、`/revise` 的完整文件生成默认超时均为 300 秒，可用 `FASTWRITE_HARNESS_TIMEOUT_MS` 覆盖（最大 600 秒）。导入私有 GitHub Repository 时设置 `FASTWRITE_GITHUB_TOKEN`。

验证 `.env` 中的真实 LLM 配置：

```bash
bun run llm:smoke
```
