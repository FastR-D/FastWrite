# FastWrite

需要 [Bun](https://bun.sh/) 1.3+ 和 Git。

FastCAS SDK 使用 npm 包 [`@fastrd/fastcas`](https://www.npmjs.com/package/@fastrd/fastcas)，随 `bun install` 安装。可选的 FastCAS 登录配置见 [FastCAS 接入说明](docs/FASTCAS.md)。

项目的「文献与证据」面板支持连接 FastRead，同步论文和逐页证据，并将写作反馈传回阅读笔记。配对方式和接口见 [FastRead 联动](docs/FASTREAD-INTEGRATION.md)。

## 开发运行

```bash
bun install
bun run dev
```

打开 <http://localhost:3002>。开发模式只监听这一个 HTTP 端口，页面、API 和 WebSocket 共用入口；Vite 通过本地 Unix socket 连接 API，保留热更新。请在仓库根目录启动，避免单独启动前端。`bun run dev` 自动进入专用开发管理员 `Admin (开发)`，可查看全部项目，并通过 `/admin` 查看平台全局信息。

`bun run main` 启动相同的前后端开发服务，但使用正常登录流程并强制开启服务端认证；开发管理员的令牌在此模式下无效。两个命令使用相同的数据目录。首次运行 `main` 且没有正式管理员时，需要设置 `FASTWRITE_BOOTSTRAP_ADMIN_EMAIL` 和 `FASTWRITE_BOOTSTRAP_ADMIN_PASSWORD`（至少 12 位），之后使用该账号登录；开发管理员不计作正式管理员，也没有可用于正常登录的默认密码。

工作区 PDF 预览使用服务器 LaTeX 编译，需要安装 `latexmk`、所选引擎（pdfLaTeX / XeLaTeX / LuaLaTeX）以及论文使用的 TeX 包。项目设置可选择引擎和管理员配置的系统或 Docker 环境，并检查工具与宏包依赖。启用 `FASTWRITE_SERVER_AUTH=true` 时强制使用 Linux `bubblewrap` 沙箱，宿主机必须允许其创建隔离命名空间；缺少沙箱会拒绝编译。Windows 本地开发如需在开启鉴权的情况下编译，应把服务部署到具备这些依赖的 Linux/WSL 环境。单人、受信任的本地模式可使用宿主编译，但不会加载项目的 latexmk 配置或启用 shell escape。

选定 venue 的 LaTeX 模板首次成功获取后会缓存到 `FASTWRITE_DATA_DIR/templates/`（未配置时为默认数据目录）；后续初始化直接使用本地缓存，不会重复下载。

## 生产运行

```bash
bun install
bun run build
bun start
```

打开 <http://localhost:3002>。

可通过 `FASTWRITE_PORT` 修改端口，通过 `FASTWRITE_DATA_DIR` 指定 Workspace 数据目录。

设置 `FASTWRITE_SERVER_AUTH=true` 后，Harness 状态与 MCP 目录查询需要登录；共享 CLI 的原始会话、运行记录、事件、审批及全局 Harness 配置修改仅允许平台管理员访问。项目内 AI 操作继续遵循项目权限，指定项目的 MCP 审计需要该项目的 Harness 使用权限，全局审计仅限管理员。原始 Harness WebSocket 使用与 HTTP 相同的 `Authorization: Bearer ...` 或 `X-FastWrite-Session` 请求头认证，不接受 URL 中的登录令牌；连接在握手、历史回放、每次事件推送及定时检查时校验权限。浏览器原生 WebSocket 无法设置这些请求头，浏览器客户端可使用已认证的 HTTP 事件接口。

启用 `FASTWRITE_SERVER_AUTH=true` 时，若数据库没有有效管理员，必须同时设置 `FASTWRITE_BOOTSTRAP_ADMIN_EMAIL` 和 `FASTWRITE_BOOTSTRAP_ADMIN_PASSWORD`（自行生成至少 12 位的唯一密码），否则服务拒绝启动。没有默认管理员账号或密码。部署模式（`FASTWRITE_SERVER_AUTH=true` 或 `NODE_ENV=production`）关闭普通用户注册入口及 `/api/auth/register` 接口；本地未开启鉴权时仍可注册普通用户。管理员在 `/panel` 左侧“用户管理”中新增、编辑、删除用户或管理团队成员资格，操作需要填写审计原因；删除前需先转移用户拥有的项目和团队，不能删除自己或停用最后一位有效管理员。初始化成功后可以移除这两个变量，已有管理员可正常登录。修改初始化变量不会重置已有账号密码；升级前已使用旧版默认账号的部署需单独轮换该账号密码。

## 开发说明

原始 Claude Harness 已内置 CLI 执行桥接，无需注入 SDK 才能发送消息。它要求 Claude Code 2.1.286 或更新版本，支持文本流、会话恢复和取消；使用 `--bare` 并关闭工具、MCP 和项目配置自动加载。此模式需要按 Claude 的提供商要求配置凭据（如 `ANTHROPIC_API_KEY`），不使用订阅登录。审批、自动加载技能及 MCP 能力会报告为不支持；需要这些能力时可注入完整的 `ClaudeSdkBridge`。CLI 参数与事件格式参考 [Claude 官方程序化调用文档](https://code.claude.com/docs/en/headless)。FastWrite 写作 API 的 `FASTWRITE_HARNESS_*` 配置与原始 CLI 凭据是分别配置的。

当前运行时由单个服务进程处理任务队列和邮件；不要设置 `FASTWRITE_JOB_WORKER_MODE=external` 或另外启动 `worker:jobs` / `worker:mail`。这些入口现在会明确拒绝启动，避免独立进程使用过期 JSON 快照覆盖数据。PostgreSQL mirror/cutover 配置仍使用本地队列快照，不代表已经支持分布式 worker。每个数据目录仅运行一个服务；检测到其他写入者时会拒绝保存过期状态。若进程被强制终止留下 `database.json.write.lock`，先停止使用此目录的全部进程，再移除该锁文件并重启。

写作质量接口：`POST /api/projects/:projectId/writing-checks` 执行确定性检查；`GET /api/projects/:projectId/argument-graph` 获取论证关系；`POST /api/projects/:projectId/adversarial-memo` 生成仅供参考的对抗预检意见。Claim 侧栏支持 stale claim 的 reanchor；Agent 生成候选会校验 Writing Guard 与 evidence dependencies；Review 报告会显示各 pass 的完成、失败或跳过状态。评测可运行 `bun run writing:eval`。

工作区 Skill 面板可打开中央只读 tab 查看每项完整内容，使用 header 右侧按钮确认或清空选择。可选择科学论文写作、文献综合、引用核验、结构化评审、学术表达精修、审稿回复和研究型内容写作等任务 Skill，可同时选择多个。新增 Skill 的上游来源、授权、逐项取舍和实测结果见 [Agent 写作 Skill 调研](docs/RESEARCH-AGENT-WRITING-SKILLS-2026-11.md)。已登录本机 Codex 后，可运行 `bun run skills:eval:codex --phase=adapted`，直接复用 Codex 配置验证中英文合成写作样例；复现方式与结果边界见 [评测说明](evaluation/agent-writing-skills/README.md)。

科研帖子与收藏提炼的六个阶段入口已接入内置 Skill：文献入稿、搭建主线、撰写实验、解读结果、核对图注、全文复核。来源分析、适用边界和真实 Codex 验收见 [调研与集成记录](docs/RESEARCH-SOCIAL-WRITING-SKILLS-2026-11.md)；复测命令为 `bun run skills:eval:social`。

IDE 的“参考论文”侧栏支持上传或拖放 PDF、LaTeX（.tex/.latex）、包含 TeX/PDF 的 ZIP，也可粘贴 LaTeX 源码，或通过 DOI、arXiv ID、HTTPS 全文链接导入（文件上限 30 MB）。多入口压缩包需要选择主文件；解析后可按全文、章节、PDF 页码或原文选段设置参考范围，并选择借鉴结构、段落、论述或表达。保存后，写作区会显示参考标签；侧栏可指定当前选区、章节、文件或整篇论文作为写作目标。Draft/Continue/Agent 和 Revise 使用参考写法，超过局部精修长度限制的当前章节会交给限定章节范围的 Agent，结果继续通过原有 ChangeSet 审核；Completion 只读取已缓存的精简写法，可先点击“准备写作参考”。扫描 PDF 无文本时需要提供有文字层的 PDF 或 TeX 源码；DOI 导入需要可直接下载的 PDF 全文，不提供 OCR 或 TAR/RAR 导入。

参考材料保存在 `FASTWRITE_DATA_DIR/projects/<projectId>/reference-papers/`，与正文 `workspace/` 分开，避免进入正文编译、GitHub 同步、Paper Memory 或事实证据。备份项目文件时需复制整个项目目录，包括参考材料；现有 JSON 数据库备份不包含原始文件或解析文件。普通论文 ZIP 导出仍只包含正文工作区。验证参考功能可运行 `bun test apps/server/src/references`、`bun run references:eval` 和构建后的 `bun run e2e:references`。配置真实模型后，`bun run references:eval -- --live` 会使用合成论文验证真实模型的参考写作链路。

## LaTeX 工具与外部 Agent

编辑器支持项目 BibTeX 多选检索与插入（Ctrl/Cmd+Shift+C），以及命令、成对环境、数学符号、引用、标签、文件、宏包和文档类补全（Ctrl+Space）。索引叠加未保存的授权编辑缓冲；重复引用标识和过期选区会阻止插入。

AI 工具栏的“编译助手与待审核修改”支持读取源码、检查错误、生成局部候选并重复编译；单条错误最小修复必须在隔离副本中编译通过，接受后才改变正文。外部客户端可在项目设置创建带 read/propose/compile/comment 权限的 MCP 令牌，使用标准 Streamable HTTP 操作该项目；提出的修改通过同一面板审核。

部署配置、协议边界及静态补全范围见 [编译环境与 MCP 说明](docs/COMPILATION-AND-MCP.md)。浏览器回归运行 `bun run build && bun run e2e:latex-services`，使用独立临时数据、真实本地编译器和固定模型替身。

## 多人论文协作

登录后打开项目，文本文件自动使用 Yjs 实时协作。顶部“协作”或左侧协作图标打开常驻面板：

- **成员与分享**：查看在线成员及其文件、行号，点击跳转；邀请成员，调整编辑／审阅／查看权限，处理访问申请并转移所有权。所有者可创建只读或可评论的访客链接，填写链接说明、设置失效时间、复制或撤销链接。文件级 ACL 继续生效。
- **编辑、审阅与查看**：在协作侧栏切换模式，编辑者可使用三种模式；审阅者默认进入跟踪修订模式，不能直接写正文或增删文件；查看者只读。审阅模式支持直接输入增删、撤销和自动保存，改动会成为带作者的待审核建议，接受前不改变正文或 PDF。
- **讨论**：选择正文后发表评论或建议替换文本，也可选择“项目讨论”发送不关联选区的讨论。支持回复、@ 提及、搜索、文件／状态筛选、解决与重新打开。正文下划线及行号旁标记可打开讨论；提及与回复通知可直接跳转到讨论。
- **修改建议**：有对应文件编辑权限的成员逐项接受或拒绝。原文发生重叠修改时，系统保留建议并阻止过期内容覆盖正文；可核对后重新关联选区。跟踪修订会同步合作者对正文的独立更改；已有修订被处理后，可保留本地副本并开始下一轮，剩余建议继续保留在讨论中。
- **外部反馈与 PDF**：通过分享链接提交的访客反馈会出现在项目内，可定位并解决；访客姓名由其自行填写。审阅者与查看者自动读取团队最新成功编译的 PDF，不创建编译任务。服务端同时检查该 PDF 包含的源文件访问权限。
- **历史版本**：保存命名版本，或查看服务端每分钟检查并保存的有变化协作状态。版本保留源文件、二进制附件、主文件设置、评论、修订状态及访客反馈，支持作者／时间显示、文件对比、单文件或整项目恢复。恢复前显示变化范围并自动保存副本；确认期间若正文或讨论改变，会要求刷新预览。恢复不会回退成员权限或分享设置。升级前的普通 Git 版本仍可查看和恢复源文件，但不含当时的讨论快照。

断线时保留正文与修订的本地草稿，恢复连接后合并更新；正文的协作撤销只影响本人的编辑。AI ChangeSet 审批、普通文件保存、历史恢复及 GitHub 同步确认进入同一项目队列，更新同一协作文档并推送给在线成员。讨论、在线列表、权限、共享 PDF 和审阅草稿约每 3 秒刷新，正文与光标通过 WebSocket 实时同步。通知设置可分别控制评论提及及讨论回复／建议审批。

部署仍遵循上文的单服务进程、单数据目录要求。匿名本机模式使用普通文件编辑；多人权限、邀请、修订与实时协作需要登录身份。单个修订草稿上限为 200 万字符、1,000 处更改；重叠输入保存在本地，需核对后继续。

回归测试：`bun run test`、`bun run typecheck`、`bun run build`、`bun run security:check`。启动测试服务后设置 `FASTWRITE_E2E_URL`（默认 `http://127.0.0.1:3221`），运行 `bun run e2e:paper-collaboration`，使用独立作者、审阅者和查看者会话验证跟踪修订、实时广播、权限升级、离线合并、共享 PDF 及整项目恢复。

## 备份恢复

数据库备份恢复必须停服执行，在线恢复接口返回 `409 offline_restore_required`。源码目录中运行：

```bash
bun run backup:restore -- --data-dir /absolute/path/to/paperdata --file /absolute/path/to/backup.json --confirm replace-database
```

对象存储备份可把 `--file` 换成 `--object-key backups/backup-name.json`，并提供部署时相同的 `FASTWRITE_OBJECT_STORE_*` 配置。命令校验备份格式和当前 schema，保存恢复前的安全副本，再替换数据库；完成后重新启动服务。JSON 备份仅包含数据库，项目文件需另外备份并放回匹配的数据目录。服务和恢复命令使用 `.fastwrite-process.lock` 互斥；若被强制终止留下锁文件，须确认该目录的全部进程已停止后再移除。旧版本备份应先使用匹配版本恢复，再按升级流程迁移。

## 检查与模型配置

`.github/workflows/ci.yml` 会在 push 和 pull request 时自动运行类型检查、单元测试、构建和浏览器 E2E。本地可运行 `bun run ci:check` 执行同一组校验。

| 命令 | 覆盖范围 |
| --- | --- |
| `bun run test` | 服务端、前端状态与共享库的确定性测试；已安装的三种 LaTeX 引擎会执行真实编译。 |
| `bun run e2e:smoke` | 构建后的关键浏览器流程：登录、保存与撤销、导出、编译与审核边界、刷新与离线权限、GitHub 导入。 |
| `bun run e2e:projects-ui` | 项目列表的筛选、排序、删除、对话框和无障碍回归。 |
| `bun run e2e:cross-browser` | 构建后在 Chrome、Firefox、WebKit 上复用同一冒烟流程。 |

浏览器冒烟和项目列表测试会启动临时服务、使用随机端口，并在结束后清理数据；无须另开开发服务。默认使用 Playwright Chromium，可设置 `FASTWRITE_E2E_BROWSER=chrome` 使用本机 Chrome。CI 固定 Ubuntu 24.04 和 Bun 版本，安装三种 LaTeX 引擎并检查依赖。外部网站、真实模型质量评测和专门的视觉／性能脚本按需运行；历史调研数据不作为单元测试输入。


在 `.env` 设置 `FASTWRITE_HARNESS=codex` 或 `claude`，并配置 `FASTWRITE_HARNESS_API_KEY`、可选的 `FASTWRITE_HARNESS_BASE_URL`、`FASTWRITE_HARNESS_MODEL`、`FASTWRITE_HARNESS_WIRE_API` 和 `FASTWRITE_HARNESS_TIMEOUT_MS`，即可为全部 AI 工作流配置统一 Harness。Project Settings 也可运行时配置这些 Harness 参数；API key 只保存在内存中且不会回传。Agent 规划、普通 AI 操作以及 `/draft`、`/continue`、`/revise` 的完整文件生成默认超时均为 300 秒，可用 `FASTWRITE_HARNESS_TIMEOUT_MS` 覆盖（最大 600 秒）。导入私有 GitHub Repository 时设置 `FASTWRITE_GITHUB_TOKEN`。

验证 `.env` 中的真实 LLM 配置：

```bash
bun run llm:smoke
```
