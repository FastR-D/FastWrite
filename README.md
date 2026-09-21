# FastWrite

需要 [Bun](https://bun.sh/) 1.3+、Git、tar，以及运行服务器的机器上可执行的 LaTeX 工具链。推荐安装 TeX Live 或 MiKTeX，并将 `latexmk`、`pdflatex`、`bibtex` 加入 PATH。浏览器不再包含 WASM 编译器。

## 开发运行

```bash
bun install
bun run dev
```

打开 <http://localhost:3002>（Vite 前端代理 API）。

PDF 由服务器本地 LaTeX 编译器生成。Ubuntu/Debian 可先安装 `sudo apt-get install latexmk texlive-latex-extra texlive-fonts-recommended texlive-science`；Windows 可安装 MiKTeX 和 Perl（latexmk 需要），macOS 可安装 MacTeX。缺少模板依赖时，按编译日志补装对应 TeX 包。无 LaTeX 时仍可编辑和导出源码，但不能生成 PDF 或执行要求当前版本编译成功的定向复审。

Review 默认附带当前成功编译版本的分页文本（最多 20 页、合计 200,000 字符）；源码审稿会明确区分。分页文本不包含图像视觉或版式信息。

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

在 `.env` 设置 `FASTWRITE_HARNESS_API_KEY`、`FASTWRITE_HARNESS_BASE_URL`、`FASTWRITE_HARNESS_MODEL` 和 `FASTWRITE_HARNESS_WIRE_API=chat`（也支持 `responses`），可直接使用兼容 API，例如 Qwen 的兼容接口。Project Settings 的运行时参数优先于环境配置，API key 只保存在内存中且不会回传；重启后恢复环境配置。配置状态表示已选择连接方式，不代表模型调用已验证成功。

未提供 API key 时，使用 `FASTWRITE_HARNESS=codex` 或 `claude` 对应的已安装且独立认证的 CLI。CLI 与直接 API 是两条明确的执行路径。Agent 规划和文件生成默认超时 300 秒，可用 `FASTWRITE_HARNESS_TIMEOUT_MS` 覆盖（最大 600 秒）。导入私有 GitHub Repository 时设置 `FASTWRITE_GITHUB_TOKEN`。

Qwen3 系列的 Chat Completions 调用使用 `enable_thinking=false`，避免思考过程耗尽交互式写作期限；其他模型不发送该供应商参数。

验证 `.env` 中的真实 LLM 配置：

```bash
bun run llm:smoke
```
