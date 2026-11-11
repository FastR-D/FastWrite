# 编译环境、LaTeX 语言服务、编译助手与 MCP

项目设置的“编译环境”可选择 pdfLaTeX、XeLaTeX、LuaLaTeX。设置与项目版本一起保存；编译固定使用 latexmk，禁用项目 latexmk 配置与 shell escape。环境面板列出引擎版本、工具及沙箱状态，并可检查已保存源码声明的宏包和文档类。动态加载、字体和宏包间接依赖最终以真实编译结果为准。

默认 `system` 使用服务器已安装的 TeX Live。安装脚本为 `bun run latex:setup`；中文稿件还需中文字体及 TeX 语言包。可由运维配置多个并存的 TeX Live，配置不能由论文或用户指定任意路径：

```sh
FASTWRITE_TEX_ENVIRONMENTS='[{"id":"tl2026","label":"TeX Live 2026","binDirectory":"/opt/texlive/2026/bin/x86_64-linux","roots":["/opt/texlive"]}]'
```

需要统一、独立的容器环境时：

```sh
docker build -t fastwrite-tex:bookworm deploy/latex
FASTWRITE_TEX_ENVIRONMENTS='[{"id":"container","label":"团队统一 TeX 环境","image":"fastwrite-tex:bookworm"}]'
```

服务器需有 Docker 及访问本机 Docker daemon 的权限。生产中建议使用已审核镜像的 digest。服务不会自动拉取镜像；镜像必须预先安装。每次编译创建无网络、只读系统、限制内存/PID/CPU 的临时容器，源文件只读、输出独立挂载。取消或超时会清理容器。容器内不加载服务器模型密钥。此后端只用于编译，不允许用户提交任意容器命令。

## 编辑器

“引用”按钮或 Ctrl/Cmd+Shift+C 打开多选引用检索，支持标题、作者、年份、DOI 和 key。项目 `.bib` 使用平衡扫描器解析嵌套花括号、引号、@string、# 拼接和 crossref。重复 key 不可插入。选择期间正文变化会阻止写入。索引叠加仍有读取权限的未保存编辑缓冲；论文中的事实证据审核仍使用原有流程。

Ctrl+Space 提供命令片段、项目自定义命令、成对环境、数学命令、引用、标签、宏包、文档类、文件和 BibTeX 字段补全；引用和标签可悬停及跳转定义。支持环境/章节折叠。宏包/命令目录包含内置基础集与项目自定义定义。系统 TeX Live 环境还会扫描已安装的宏包/文档类，并静态提取项目声明加载的宏包命令；容器环境保留基础集与项目定义。任意动态宏展开不属于静态补全范围。

## 编译助手

AI 工作区工具栏的“编译助手与待审核修改”可恢复候选，包括外部 MCP 提出的修改。助手在最多 10 步内读取源文件、提出精确替换并反复编译，显式编译工具最多三次，最后对未验证候选再编译一次。所有修改先放入独立快照，通过原有 ChangeSet 接受后才修改正文。项目在运行期间发生变化时任务失败，不覆盖新正文。

“单条错误最小修复”限制一个文件、错误行附近、每个补丁最多 30 行。只有候选整体编译成功才提供修改；多文件问题可改用完整编译助手。模型、沙箱、工具缺失会明确失败，不降级为伪成功。

## 外部 MCP

项目所有者在设置的“外部 MCP”中创建 1–90 天令牌（UI 默认 30 天），选择 read/propose/compile/comment 权限。令牌仅显示一次，数据库只保存哈希。每次调用重新检查令牌、账户和项目/文件权限。可在同一面板撤销。

端点为 `/api/projects/<projectId>/mcp`，使用 MCP SDK 的无状态 Streamable HTTP，支持 initialize、tools/list、tools/call、ping 和 initialized 通知。只支持 POST；不提供长期 SSE 会话。客户端发送 `Authorization: Bearer <token>`，不能将令牌写入 URL。客户端需支持自定义 Bearer header；未实现 OAuth 动态客户端注册。

工具包括 list_files、read_file（可按行分段）、search_files、search_references、get_settings、compile、get_compile_result、propose_edit、list_comments、reply_to_comment。propose_edit 要求精确旧文和文件版本，产生待审核候选，由作者在 FastWrite 的“编译助手与待审核修改”中接受。它不会直接覆盖协作者文本。工具执行写入 MCP 审计。

当前诊断缓存只保留进程内最近 100 个项目的结果，重启后需要重新编译。
