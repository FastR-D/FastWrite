# 已经解决的Bug和完成的开发任务  

> **状态：全部已解决，并于 2026-08-04 完成回归验证。**

## 2026-08-04 PDF 初始适配、Memory 编辑与版本设计

1. PDF 预览第一次打开时没有默认适配整个可见区域。

   **已解决（2026-08-04）**：PDF 加载第一页的原始尺寸后，会同时按预览区可用宽度和高度计算整页缩放比例；面板或全屏尺寸变化时保持自动适配，用户手动缩放后才退出自动适配模式。适配算法有独立边界测试。

2. Paper Memory 每段编辑框容易出现内部滚动条；中英文混合编辑后还需要用指定模型整理表达。

   **已解决（2026-08-04）**：Overview、Section 和 Fact 的编辑框根据实际内容自动增高，并隐藏内部纵向滚动条。保存单个编辑部分时只调用一次 Memory Provider，将中英文混合内容整理为简洁一致的学术英语，同时要求保留术语、数值、引用、不确定性和证据边界。Memory 提取、层级摘要和编辑整理统一使用 `.env` 的 `FASTWRITE_MEMORY_*` 配置，并逐字段回退全局 OpenAI-compatible 配置；API 回归覆盖三个部分的整理调用和人工锁定行为。

3. `project version 24` 的来源、展示方式及其与 Git 历史和 GitHub 同步的关系不清楚。

   **已 Justify（2026-08-04）**：Project/File version 是每次已保存 Workspace 变更递增的内部计数器，用于乐观并发控制、编译结果绑定以及 Agent/Review 快照一致性，不是发布版本或 Git commit 编号。时间戳可能重复或受时钟调整影响，不能替代该计数器；用户界面显示保存时间，不显示内部 project version。文本保存会在停止编辑两分钟后合并为一个本地 Git checkpoint，结构变更立即 checkpoint，也可从 Files 工具栏手动创建；不用 `git stash`，因为 stash 会隐藏当前工作区且不是持久历史。内部 `history.git` 不连接远端，GitHub/Overleaf 同步继续作为需要凭据、分支、冲突预览和用户确认的独立显式流程。

### 回归验证

- `bun run typecheck`：通过。
- `bun test`：79 项通过。
- `bun run build`：通过（仅保留既有的大 chunk 警告）。
- 真实浏览器：PDF 在 440x614 预览区内渲染为 395x511，宽高均适配；Memory 概览编辑框可视高度 233px、内容高度 231px，`overflow-y: hidden`，无内部滚动条。

## 2026-08-03 Revise 上下文、Memory 边界与界面发布收尾

1. Revise 在空白的 Conclusion 等段落生成文本时会保留通用占位符，没有优先利用论文证据。

   **已解决（2026-08-03）**：Revise 会识别空白或仅含 `TODO` / `TBD` / `PLACEHOLDER` 的 Section scaffold，并明确要求 Provider 保留 LaTeX 标题、从已审核的论文核心和精确当前 Section 摘要生成具体正文。服务端还会按论文文档顺序补入相邻跨文件 Section 正文；只有这些来源都不足时才允许占位符，且仍禁止编造证据、引用或结果。新增 API 回归覆盖空白 Conclusion 使用上一 Evaluation 的 18% 结果与 Conclusion Memory 摘要。

2. Paper Memory 的使用范围、编辑流程和持久化边界不清晰。

   **已解决（2026-08-03）**：只有跨文件 Agent 收到完整已审核 Memory 和 User Instructions；Revise 与 Completion 只收到已审核的论文核心和光标/选区所在的精确 Section，不读取其他 Section、未审核候选、User Instructions 或完整 Facts；Review 与 targeted re-review 只读取当前论文/编译快照。Memory 对话框为每个 Overview、Section 和 Fact 提供编辑入口，每次保存同步根目录 `memory.md`；只保存一个部分时，Reviewed Context 只持久化已锁定内容，未审核内容继续留在 Candidate Context。`docs/DESIGN.md` 与 `memory.md` 自述已同步更新。

3. Paper import 页面使用了不清晰且不适合后续同步方向的文案。

   **已解决（2026-08-03）**：页面标题缩为 `WORKSPACE`，顶部标识改为 `Agentic Paper Writing`，项目页与导入弹窗移除了 “never edits / managed copy / managed paper workspace” 等表述，改为直接描述导入本地 LaTeX 目录或 GitHub Repository。

4. Review 全屏内容过宽，左右窗口折叠轨道也占用过多空间。

   **已解决（2026-08-03）**：Review 保留紧凑、宽屏、全屏三档；全屏内容最大 800px 并居中。左右折叠轨道从 24px 缩至 18px，移除竖排文字，仅保留带 tooltip 与无障碍名称的图标。真实浏览器在 1280px 视口测得 Review 宽 800px、左右各 240px；390px 移动视口无横向溢出；左右轨道均为 18px。

5. Release 需要 README，但根目录 README 同时包含开发说明。

   **已解决（2026-08-03）**：发布包使用独立的运行时 `app-bin/README.md`，不复用面向源码开发的根 README。`bun run package:app` 每次生成运行、AI 配置、`skills/` 和 `paperdata/` 升级保留说明。打包回归确认单一 198MB `fastwrite` 二进制、README、外置 Skills 和 Paper data 均存在；从发布目录启动后 `/api/health` 与内嵌首页返回 `200`。

### 回归验证

- `bun run typecheck`：通过。
- `bun test`：74 项通过。
- `bun run build`：通过（仅保留既有的大 chunk 警告）。
- `bun run package:app`：通过；发布二进制启动、Health API 和内嵌首页验证通过。
- 真实浏览器：导入文案、18px 折叠轨道、Review 桌面/移动尺寸、Memory 52 个可编辑部分与根 `memory.md` 提示均通过，控制台无 error。

## 2026-08-03 Agent、Outline 与 Paper Memory 回归

1. Editor 的 Agent 请求在切到 Review 后会丢失，切回 Agent 无法恢复。

   **已解决（2026-08-03）**：Revise 与 Agent 视图现在始终保持挂载，仅隐藏非活动视图，因此切换 Tab 不会触发 Agent 请求的清理和 abort。Agent 输入、计划、候选 ChangeSet 与进行中的请求都能在切回后继续；服务端仍以默认 120 秒的可配置上限返回明确超时错误，而非无限等待。

2. Agent 面板不应显示高度预设；全屏应限制内容宽度；重复的 `Back to revise` 应替换为命令入口。

   **已解决（2026-08-03）**：高度预设仅在 Revise 模式显示，Agent 保留拖拽分隔条。Agent 全屏时主体最大宽度为 800px 并居中；移除重复返回按钮，改为 `Draft` 命令入口。修复了保持挂载后被覆盖的 `hidden` 样式，确保当前 Tab 是唯一参与布局的工作区。

3. 左侧 Document Outline 高度不能实际调整。

   **已解决（2026-08-03）**：Outline 使用可垂直 resize 的固定初始高度；移除了阻止原生 resize 生效的固定 `flex-basis`，拖拽会真实改变区域高度，并受 120px 最小值与侧栏最大高度约束。

4. Paper Memory 缺少根目录可见文件，逐项 lock/commit 审核过重，也无法保存必须遵循的用户指令。

   **已解决（2026-08-03）**：生成 Memory 会创建根目录 `memory.md`，以完整候选形式显示；用户在对话框中一次审核并应用，随后写入 Reviewed Context。`memory.md` 的 `User Instructions` 可直接在编辑器中编辑，同步 Memory 时会保留它们，并将其作为明确的必遵循上下文传给 Draft、Agent、Revise 与 Completion。`memory.md` 被排除在 Memory 证据提取、Agent 项目源读取和 Review 快照之外，避免自我引用。

### 回归验证

- `bun run typecheck`：通过。
- `bun test`：73 项通过。
- 真实浏览器：Agent Tab 切换后输入仍保留；Agent 模式不显示高度预设；全屏主体居中且宽度为 800px；完整 Memory 候选审核界面与 `memory.md` 入口正常渲染。

## 2026-08-03 发布包回归

1. `app-bin` 的 release 应将 Web 与 FastWrite 打包为单个可发布二进制；Skills 与 Paper data 应位于二进制同级的外置目录，以便只发布一个 binary 并按需替换附属目录。

   **已解决（2026-08-03）**：`bun run package:app` 现在将完整 Web 静态资源嵌入 `app-bin/fastwrite`，发布目录不再包含 `web/` 或 `start.sh`。`skills/`、`paperdata/` 与二进制并列，已有旧 `.fastwrite-data` 会迁移为 `paperdata`；重新打包只替换二进制和 Skills，不会删除 Paper data。二进制自动加载同级 `.env`，可直接用 `./app-bin/fastwrite` 启动。

   **验证（2026-08-03）**：发布目录仅含 `fastwrite`（198MB）、`skills/`、`paperdata/` 和可选 `.env`。直接运行二进制确认数据目录为 `app-bin/paperdata`；`/api/health`、内嵌首页、前端脚本与 TeX bundle 均返回 `200`，真实浏览器已加载完整项目页。

## 2026-08-03 PDF 预览回归

1. PDF 面板进入全屏时会连续闪烁数秒才稳定显示。

   **已解决（2026-08-03）**：全屏按钮现在调用浏览器原生 Fullscreen API，而不再把面板尺寸变化误作全屏。宽度适配使用 PDF 原始页面尺寸计算，避开 `ResizeObserver` 根据已缩放画布反复重算造成的闪烁。真实浏览器已验证可进入、退出全屏，PDF 稳定显示。

2. PDF 的 Focus 图标应定位左侧当前选中文本，但当前位置和词语不准确。

   **已解决（2026-08-03）**：定位优先使用编辑器当前选区的文件和起始行；PDF 到源码的反向跳转则按画布实际边界映射回未缩放的 PDF viewport 坐标，避免页面缩放或边距导致的偏移。按钮已明确为 `Locate editor selection in PDF`。

3. 浏览器 WASM 编译时底部出现 PDF LaTeX 错误；需要确认其来源与状态呈现，避免误导为本地 LaTeX 依赖。

   **已解决（2026-08-03）**：Browser WASM 成功后会隐藏早期失败编译 pass 遗留的 error diagnostics，仅保留实际 warning 与原始日志。真实浏览器重新编译 PatchPoint 后显示 `Compiled successfully` 和 2 条 warning，不再显示 PDF LaTeX error。

4. 编译引擎应支持本地 LaTeX，并提供合理的配置入口。

   **已解决（2026-08-03）**：PDF 编译栏提供按项目保存的 `Browser WASM` / `Local LaTeX` 选择。Local LaTeX 使用主机的 `latexmk` 或 `pdflatex` 在隔离临时工作区编译；缺少 TeX 包时会准确提示包名及“安装该包或切换 Browser WASM”。本机验证发现 `enumitem.sty` 未安装，错误提示正确且不显示浏览器缓存修复操作。

### 回归验证

- `bun run typecheck`：通过。
- `bun test`：72 项通过。
- `bun run build`：通过。
- 真实浏览器：Browser WASM 成功编译、全屏进入与退出、本地 TeX 缺包提示均通过。


## 2026-08-02

### 功能 Bug

1. 右边编译栏报错，没法编译 PDF。

   **已解决（2026-08-02，2026-08-03 回归通过）**：实际用 PatchPoint 复现后确认 WASM 引擎本身正常，失败原因是 TeX 资源缺少 `enumitem.sty`。现在编译器会识别缺包，由 Server 从兼容的 TeX Live/CTAN 源按需下载，并在服务端和浏览器中缓存；编译资源版本号可避开旧缓存。编译日志也会去掉 `[TeX]` / `[TeX ERR]` 前缀并保留最初的缺包错误，错误可点击跳到源文件行。已再次通过真实浏览器 WASM 编译验证，结果为 `Compiled successfully`，PDF 可正常显示。

2. 下面 Revise 没法打开 key，项目根目录我已经配置了全局的 env，应该首先读取根目录的 env。提示为 “Set OPENAI_API_KEY to enable AI revision”。

   **已解决（2026-08-02，2026-08-03 回归通过）**：Server 启动时优先读取 FastWrite-New 根目录 `.env`，根配置不存在时再回退到启动目录；显式传入的进程环境变量拥有最高优先级。兼容 `OPENAI_API_KEY` / `OPENAI_KEY` 和 `OPENAI_BASE_URL` / `OPENAI_API_BASE`，因此从项目根目录或 `apps/server` 启动都能取得同一配置。已分别从这两个目录验证根 `.env` 中的 key 和 base URL 均已加载；此前的真实 LLM smoke 中 Revise、Memory、Draft、Review、Agent、Targeted re-review 和 Completion 共 9/9 条链路通过。

3. 左边文件太复杂混乱。不应该显示 backup，根据 section 显示最新版本就行。旧版本整个项目用 Git 追踪（可以几分钟自动保存一次 Git，也能提供一个按钮）。

   **已解决（2026-08-02）**：Files 只展示当前工作区源码，统一过滤 `.git`、`.writeagent`、`.fastwrite`、`backup/backups` 和构建目录；导出项目也采用同一排除规则。旧版本不再复制到源码树，而是写入项目外的 managed bare Git 仓库 `history.git`。普通文本保存采用 2 分钟 debounce 自动 checkpoint；新建、重命名、删除等结构修改立即 checkpoint；Files 标题栏新增 “Save Git checkpoint” 按钮供手动保存。测试确认保存会产生 Git commit，且不会生成版本复制文件。

4. 左下的 section 视图不准确。

   **已解决（2026-08-02）**：Outline 不再按单行正则解析；现在支持跨行标题、注释屏蔽、嵌套花括号，并按主文档中 `input`、`include`、`subfile` 的实际顺序递归生成树。选择 “current section” 时，父 Section 会包含其全部 Subsection，直到下一个同级或更高级标题，而不是遇到第一个子标题就截断。已增加多行标题、跨文件顺序和父子 Section 范围测试。

### 需要 Justify 的设计

1. 上面 Complete 为啥需要区分？应该不需要用户选择 “next sentence”，默认就是补全 LaTeX，当前编辑的文件的下一句。如果当前打开的文件是 bib 就补全 citation。其他的根据上文自动判断补全就行了。

   **已解决（2026-08-02）**：删除 Completion kind 下拉框，对外只保留一个 `Complete` 开关。每次请求由服务端根据当前文件与光标上下文自动推断：`.bib` 生成 BibTeX citation 条目，数学环境补公式，未完成的 LaTeX 命令补语法，普通 TeX 正文默认只补自然的下一句。这样用户无需理解内部模式，Skill、全文 Outline、参考文献和光标上下文仍会共同约束结果。

2. Agent 模式介绍不清楚。这里是想让 Agent 自动根据用户需求帮助跨文件修改，可以是初始 Draft，也可以是后期修改。也许 Agent 模式不需要单独弹窗，而是也放在下面的聊天窗，设置一个新的 Tab。Scope、current file/Section 解析不准确。

   **已解决（2026-08-02）**：底部 AI 区域改为 `Revise / Agent` 两个 Tab，Agent 不再打开独立弹窗。Agent Tab 明确说明它既可从 research brief 创建初始 Draft，也可在后期跨文件修改论文；当前编辑文件只作为上下文提示，不再作为错误的硬 Scope。UI 已移除 `Current file / Section file / Entire project` 选择，Agent 始终读取项目并先提交 affected-files plan，用户确认后才生成 ChangeSet；Diff 中仍可逐文件、逐 hunk 审核并手工编辑，再 Accept 或 Reject。Review 的 “Fix with Agent” 会直接切到同一个 Agent Tab，并携带 Review Issue。

## 2026-08-03

1. 自动补全需要以虚文本显示在当前句子后面，且 Tab 不能重复插入已输入前缀；需要确认其 `.env` Provider 和延迟行为。

   **已解决（2026-08-03）**：Completion 建议现在通过 Monaco 的 `after` decoration 以内联虚文本显示，不再渲染独立浮层。按 `Tab` 时会计算建议与光标前文本的最大重叠，只插入尚未输入的后缀；`Esc` 清除建议，屏幕阅读器仍能获知可接受状态。请求维持 500ms debounce、上一请求可取消；Completion 使用独立 `FASTWRITE_COMPLETION_*` 配置，未配置时回退全局 `.env`，可直接指向 DeepSeek 等 OpenAI-compatible endpoint。补全前缀去重单测通过。

2. Paper Memory 的 Sections 卡片重叠、Facts 的含义不清，且 Review 名称容易与 Agent Review 混淆。

   **已解决（2026-08-03）**：Sections、Facts 和候选列表都使用可收缩的固定高度滚动区，Grid 行按内容高度排列；修复了 `overflow: hidden` 导致 section 卡片被压缩到单行的根因。Facts 保持类别、状态、来源和确认/拒绝操作；原 `Review` Tab 更名为 `Memory changes`，其中只显示重新生成的 Memory 候选差异，而非 Agent 审稿建议。真实浏览器检查确认 17 个 Sections 的 531px 容器可滚动 5027px 内容，卡片不再重叠。

3. `.env` 中需支持自动补全、Agent modifying、Refine、Review 和 Memory 分别配置 model/API。

   **已解决（2026-08-03）**：服务端为 `COMPLETION`、`AGENT`（含 Draft）、`REVISE`、`REVIEW`（含 targeted re-review）、`MEMORY` 创建独立 Provider。每个工作流支持 `FASTWRITE_<WORKFLOW>_API_KEY`、`_BASE_URL`、`_MODEL`，也兼容 `_OPENAI_*` 形式；每个字段独立回退 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `FASTWRITE_OPENAI_MODEL`。`README.md` 和 `DEV.md` 已提供配置示例，配置解析单测覆盖字段级覆盖与全局回退。

4. 右侧 Paper 编译很慢，长时间没有完成，PDF 很久没有显示出来。

   **已解决（2026-08-03）**：定位到 React Strict Mode 的 effect 重挂载会取消首次自动编译，而旧的 `hasCompiled` 守卫阻止第二次启动，导致界面永久停在 `Preparing workspace snapshot…`。清理时现在允许第二次挂载重试；被取消的编译也会恢复到正确状态，而不会留下 loading 假象。浏览器在刷新后自动完成 PatchPoint 的 Browser WASM 编译，显示 6 页 PDF 与 `Compiled successfully`；快照阶段还会显示已读取文件数，资源下载和真实编译继续显示独立进度。

5. Paper Memory 的 `Save & lock` 按钮文字颜色不对，显示为灰色且难以辨认。

   **已解决（2026-08-03）**：Memory 面板明确约束 primary 按钮及其文本为白色，避免被局部样式覆盖。真实浏览器检查确认 `Save & lock` 为 `rgb(255,255,255)`、不透明、未禁用，背景为蓝色。

6. 需要将应用打包至外部 `app-bin` 目录，能从该目录正常测试和使用工具修改 Paper，`.env` 也应放在那里。

   **已解决（2026-08-03）**：新增 `bun run package:app`。该命令创建被 Git 忽略的 `app-bin/`，其中包含独立 `fastwrite` 可执行文件、Web 静态资源、Skills 与 `start.sh`；根目录有 `.env` 时会复制到 `app-bin/.env`，否则生成 `.env.example`。启动脚本固定从 `app-bin/.env` 读取配置，并把 Workspace 数据放在 `app-bin/.fastwrite-data`。已通过 `FASTWRITE_PORT=3024 ./app-bin/start.sh` 验证 `/api/health` 与 `/` 均返回 `200`，后者提供 FastWrite 页面。

7. Paper Memory 不工作。

   **已解决（2026-08-03 后续验证）**：新增 `Overview / Sections / Facts / Memory changes` 分层视图和分块提取；事实具备稳定 key、来源、人工编辑/锁定和 freshness 状态。重新生成会去重并保留锁定内容，将冲突放入候选 `Memory changes`，而不会静默覆盖。Agent/Draft 使用全部已确认 Memory；Completion/Revise 只使用当前文件相关的确认内容；Review 与 targeted re-review 直接读取当前 paper/PDF 快照，不使用 Memory。各 Tab 用途和工作流使用范围已写入 `docs/DESIGN.md`，并在界面中随 Tab 显示简短说明。

8. PDF 区域初始不编译、缺少服务器编译、跳转不准且不适配宽度。

   **已解决**：项目打开时自动编译；可在 Browser WASM 和 Server LaTeX 间切换。服务器编译在受控的临时工作区运行 `latexmk` 或 `pdflatex`。PDF 点击按实际画布和 PDF viewport 映射 SyncTeX；Fit to width 会监听右侧面板尺寸并重新计算缩放。

9. Revise / Agent 面板无法调整高度或全屏，选区会遮挡聊天。

   **已解决**：增加可拖动且支持方向键的水平分隔条，高度保存到 `localStorage`；全屏为保留状态的应用内 overlay，支持 Escape 退出。选区移至独立 context strip，消息列表不再被 sticky 元素覆盖。

10. Revise 多轮会话不能清空或刷新恢复。

   **已解决**：每轮以最新候选作为 `workingText`，Accept 前不写文件；Clear 会在存在未接受 ChangeSet 时确认。会话、选区快照和候选存储在本地，恢复前验证文件版本与原始文本；服务端会压缩较早历史并保留最近对话。

11. Agent 入口重复，无法统一创建、续写和修改。

   **已解决**：移除独立 Draft 入口，统一为 Agent Tab composer。服务端会识别 `draft`、`continue`、`revise`，支持 `/draft`、`/continue`、`/revise` 覆盖；前两种模式可计划受控的新 `.tex` / `.bib` 文件，所有改动仍经过 Plan 和 ChangeSet 审批。

12. `bun run dev` 不稳定显示访问地址。

   **已解决**：根级 dev 编排器会预检端口、等待 Web/API ready 后输出实际 URL，并在退出或关键子进程异常时收敛所有 watcher。TypeScript watch 保留输出，Vite 不再清屏。

13. Agent/Review 窗口尺寸不可控，且 Paper Memory 的使用范围不透明。

   **已解决（2026-08-03）**：Review 默认使用宽屏而非全屏，标题栏提供紧凑、宽屏、全屏三档图标控制，并按项目保存偏好。底部 AI 工作区保留拖拽与全屏，同时新增 Compact / Comfortable / Tall 高度预设，Agent Tab 可直接使用。服务端回归测试确认 Agent/Draft 接收全量确认 Memory，Completion/Revise 只接收当前文件范围的内容，Review 不接收 Memory；浏览器实测确认三档 Review 窗口、Agent 高度预设和 Paper Memory 说明均可用。

### 回归验证

- `bun test`：72 项通过。
- `bun run typecheck`：通过。
- `bun run build`：通过。
- 浏览器冒烟覆盖自动编译、SyncTeX 双向跳转、Revise 宽屏/窄屏布局、统一 Agent composer、Review 尺寸控制和 Paper Memory 分层说明。
