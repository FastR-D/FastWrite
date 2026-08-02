### 功能 Bug

1. 右边编译栏报错，没法编译 PDF。

   **已解决（2026-08-02）**：实际用 PatchPoint 复现后确认 WASM 引擎本身正常，失败原因是离线 TeX Live 资源缺少 `enumitem.sty`。现已补充 `enumitem` 离线包和可重复执行的 `bun run tex:package <package>` 同步脚本；本地 manifest 使用编译资源版本号避开浏览器旧缓存。编译日志也会去掉 `[TeX]` / `[TeX ERR]` 前缀并保留最初的缺包错误，错误可点击跳到源文件行。已在浏览器中用真实 PatchPoint 项目验证，结果为 `Compiled successfully`。

2. 下面 Revise 没法打开 key，项目根目录我已经配置了全局的 env，应该首先读取根目录的 env。提示为 “Set OPENAI_API_KEY to enable AI revision”。

   **已解决（2026-08-02）**：Server 启动时先读取 FastWrite-New 根目录 `.env`，再读取启动目录；显式传入的进程环境变量拥有最高优先级。兼容 `OPENAI_API_KEY` / `OPENAI_KEY` 和 `OPENAI_BASE_URL` / `OPENAI_API_BASE`，因此从 monorepo 根目录或 `apps/server` 启动都能取得同一配置。已使用根 `.env` 完成真实 LLM smoke，Revise、Memory、Draft、Review、Agent、Targeted re-review 和 Completion 共 9/9 条链路通过。

3. 左边文件太复杂混乱。不应该显示 backup，根据 section 显示最新版本就行。旧版本整个项目用 Git 追踪（可以几分钟自动保存一次 Git，也能提供一个按钮）。

   **已解决（2026-08-02）**：Files 只展示当前工作区源码，统一过滤 `.git`、`.writeagent`、`.fastwrite`、`backup/backups` 和构建目录；导出项目也采用同一排除规则。旧版本不再复制到源码树，而是写入项目外的 managed bare Git 仓库 `history.git`。普通文本保存采用 2 分钟 debounce 自动 checkpoint；新建、重命名、删除等结构修改立即 checkpoint；Files 标题栏新增 “Save Git checkpoint” 按钮供手动保存。测试确认保存会产生 Git commit，且不会生成版本复制文件。

4. 左下的 section 视图不准确。

   **已解决（2026-08-02）**：Outline 不再按单行正则解析；现在支持跨行标题、注释屏蔽、嵌套花括号，并按主文档中 `input`、`include`、`subfile` 的实际顺序递归生成树。选择 “current section” 时，父 Section 会包含其全部 Subsection，直到下一个同级或更高级标题，而不是遇到第一个子标题就截断。已增加多行标题、跨文件顺序和父子 Section 范围测试。

### 需要 Justify 的设计

1. 上面 Complete 为啥需要区分？应该不需要用户选择 “next sentence”，默认就是补全 LaTeX，当前编辑的文件的下一句。如果当前打开的文件是 bib 就补全 citation。其他的根据上文自动判断补全就行了。

   **已解决（2026-08-02）**：删除 Completion kind 下拉框，对外只保留一个 `Complete` 开关。每次请求由服务端根据当前文件与光标上下文自动推断：`.bib` 生成 BibTeX citation 条目，数学环境补公式，未完成的 LaTeX 命令补语法，普通 TeX 正文默认只补自然的下一句。这样用户无需理解内部模式，Skill、全文 Outline、参考文献和光标上下文仍会共同约束结果。

2. Agent 模式介绍不清楚。这里是想让 Agent 自动根据用户需求帮助跨文件修改，可以是初始 Draft，也可以是后期修改。也许 Agent 模式不需要单独弹窗，而是也放在下面的聊天窗，设置一个新的 Tab。Scope、current file/Section 解析不准确。

   **已解决（2026-08-02）**：底部 AI 区域改为 `Revise / Agent` 两个 Tab，Agent 不再打开独立弹窗。Agent Tab 明确说明它既可从 research brief 创建初始 Draft，也可在后期跨文件修改论文；当前编辑文件只作为上下文提示，不再作为错误的硬 Scope。UI 已移除 `Current file / Section file / Entire project` 选择，Agent 始终读取项目并先提交 affected-files plan，用户确认后才生成 ChangeSet；Diff 中仍可逐文件、逐 hunk 审核并手工编辑，再 Accept 或 Reject。Review 的 “Fix with Agent” 会直接切到同一个 Agent Tab，并携带 Review Issue。
