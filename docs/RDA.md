# FastWrite 产品需求

## 1. 产品目标

FastWrite 是面向安全与 AI 顶会论文的 AI 写作工作台。用户始终在完整 LaTeX 项目中编辑，并通过四项核心功能完成从写作到审稿的闭环：

1. **自动补全（Completion）**：在光标处预测下一句或 LaTeX 内容。
2. **Agent 初稿与修改**：生成论文初稿，继续未完成内容，或执行跨文件修改。
3. **逐段精修（Revise）**：围绕当前句子、段落或 Section 连续打磨，用户确认后再写入。
4. **自动审稿与问题解决（Review）**：根据当前源码及可选的临时 PDF 预览文本提出审稿意见，并调用 Agent 或 Revise 协助解决。

Review 以请求时读取到的 Workspace 源码为主要输入；PDF 页面文本仅按请求临时传递且有界，不保存 PDF、页面图、哈希或冻结快照。没有页面文本时自动降级为源码 Review，报告标记实际输入类型。

四项功能按明确边界共享 Writing Skill、Paper Memory 和版本信息。Agent 与 Revise 的正文修改统一使用 ChangeSet；Completion 只有在用户按下 `Tab` 后插入；Review 不直接写正文。任何流程都不得编造实验、结果或引用。

## 2. 工作区

工作区采用紧凑的三栏布局：左侧是文件与 Outline，中间是完整源码 Editor 和 `Revise / Agent` 工作区，右侧是 PDF、编译状态与 Diagnostics。Review 使用独立的宽屏工作区。

Editor 不把论文自动拆成句子或段落卡片。用户直接编辑源文件，通过选区、光标和 Outline 指定上下文。

## 3. 四项核心功能

### 3.1 自动补全

用户只需开启一个 `Complete` 开关，不选择补全类型。停止输入约 500 ms 后，系统根据文件和光标上下文自动判断：

- 普通 TeX 正文：补全自然的下一句。
- `.bib`：补全 BibTeX 条目。
- 数学环境：补全公式。
- 未完成的 LaTeX 命令：补全语法。

建议以内联虚文本显示；`Tab` 接受尚未输入的后缀，`Esc` 忽略。光标移动、继续输入或文件版本变化时，旧请求和旧建议必须失效。补全只使用附近文本、Outline、参考文献、Writing Skill，以及已审核的论文概览和当前 Section 摘要。

**验收标准**：无类型选择；建议不遮挡正文；`Tab` 不重复插入用户已经输入的前缀；过期结果不能写入错误位置；关闭开关后不再请求。

### 3.2 Agent 初稿与修改

Agent 使用同一入口处理三类任务：从 research brief 创建初稿、继续 TODO/空白章节、按自然语言要求修改现有论文。系统可自动判断任务意图，也允许用 `/draft`、`/continue`、`/revise` 明确指定。

流程固定为：

1. 读取 Writing Skill、完整已审核 Memory、User Instructions 和项目源码；若由 Review 发起，同时读取用户选中的审稿意见及其 PDF 证据。
2. 先生成计划，列出步骤、影响文件、风险和验证方式，不立即修改文件。
3. 用户确认计划后，Agent 才生成多文件 ChangeSet。
4. 用户逐文件查看 Diff，可编辑候选，并逐 hunk 接受或拒绝。
5. 只有接受的 hunk 写入 Workspace；随后立即创建内部 Git checkpoint、编译，并可回滚。

初稿和继续写作可以创建新的 `.tex` / `.bib` 文件；普通修改不得越过已确认的影响文件。缺少证据的内容保留明确 TODO。

**验收标准**：确认计划前文件不变；ChangeSet 只能包含计划中的文件；局部接受只写入对应 hunk；源文件版本变化时阻止覆盖；任务切换 Tab 后仍可恢复。

### 3.3 逐段精修

用户在 Editor 中选择一句、一个段落或若干连续段落，也可使用光标所在的整个 Section，然后在 Revise 中连续提出修改要求。

每轮精修基于当前未接受候选，而不是反复从原文开始。系统返回完整替换文本、修改理由和词级 Diff；用户可以继续追问、手工编辑候选、Accept 或 Reject。Accept 后立即创建内部 Git checkpoint，新文本继续保持选中，便于进入下一轮；已接受结果可以 Rollback。

Revise 只读取当前选区、同一文件的前后文、精确 Section、Writing Skill，以及已审核的论文概览和当前 Section 摘要，不读取其他 Section 或未审核 Memory。Academic polish、Logic check、Condense、Grammar 等只是快捷指令，不是独立模式。

**验收标准**：连续第二轮收到第一轮候选；Accept 前源文件不变；Accept 只替换原选区；Reject 不改文件；切换焦点或 Tab 不丢失对话、选区和候选。

### 3.4 自动审稿与问题解决

Review 按请求发生时读取的当前源码生成总体评价、优缺点、下一步和结构化审稿意见；可选接收有界 PDF 预览文本作为辅助，不创建冻结快照。

一条**审稿意见（Review Issue）**是报告中的一个独立、可解决问题，包含类别、严重级别、优先级、理由、影响、建议，以及 PDF 页码和原文证据。能够可靠映射时，再附加源码路径和行号。审稿意见支持筛选、手工新增、合并重复项和状态跟踪。

解决路径分为：

- **Revise locally**：PDF 证据能可靠映射到一个源码选区时，跳转并选中原文，把该条审稿意见带入 Revise。
- **Fix with Agent**：跨文件、跨章节或需要同时处理多条审稿意见时，把用户选中的意见及其 PDF 证据交给 Agent，复用计划、ChangeSet 和审批流程。

“用户选中的审稿意见”不是额外类型，只是本次交给 Agent 或 Revise 处理的一条或多条 Review Issue。修改后必须生成新的成功编译 PDF，再针对这些原始意见进行 targeted re-review。只有新 PDF 中问题已解决且没有明显回归时才标记 `resolved`；否则重新打开。Review 不直接修改正文，也不读取 Paper Memory。

**验收标准**：Review Provider 实际收到固定版本 PDF 或由该 PDF 渲染的页面；报告绑定 PDF 摘要；每条意见引用真实页码和 PDF 原文；可映射的证据能跳转到源码；所选意见与后续 Agent/Revise 修改及复审保持关联；没有新 PDF 时不能完成复审。

## 4. 共享约束

### Writing Skill

项目先选择 CCF 研究领域，再选择具体会议或期刊及投稿阶段。领域 Skill 与 venue 规则共同约束 Completion、Agent、Revise 和 Review；每次 Agent Run 记录 Skill、版本及 publication target。

### Paper Memory

Memory 只保存有源码证据且经用户审核的论文核心、Section 摘要和事实。Agent 使用完整已审核 Memory 与 User Instructions；Completion 和 Revise 只使用论文核心及当前 Section；Review 不使用 Memory。

### ChangeSet 与版本

Agent 和 Revise 的写操作遵循：

```text
Request -> Plan/Proposal -> ChangeSet -> Diff/Edit -> Accept/Reject -> Compile -> Rollback
```

ChangeSet 保存基础文件版本和对应的内部 Git checkpoint。写入前必须检查版本冲突；项目版本用于保存、编译结果和 Review 快照的一致性，不作为用户可见的同步版本。

Rollback 必须基于内部 Git，采用 `revert` 语义而不是 `reset`：对该 ChangeSet 的 operation commit 生成反向修改，并把回滚结果提交为新的 checkpoint。后续不相关编辑必须保留；同一区域已被继续修改时进入三方冲突处理，不能覆盖后续内容，也不能仅因存在后续编辑就拒绝整个回滚。

### Git 历史、GitHub 同步与冲突

- 每个项目的 `history.git` 是无 remote 的内部恢复仓库。普通文本在停止修改两分钟后合并为一个 checkpoint；持续编辑时最迟十分钟保存一次。新建、上传、重命名、删除、AI Accept、Rollback、手动 checkpoint 和 Sync 前立即 checkpoint。
- 内部 checkpoint message 只用于恢复和审计，对用户隐藏，永远不推送到 GitHub，也不需要 rebase。
- 顶层只提供一个手动 `Sync` 按钮，不向用户暴露 Pull、Push、Rebase 或 Git 命令，也不在后台自动推送。后台只能只读检查远端状态。
- 一次 Sync 固定执行：保存本地修改并 checkpoint -> 获取 GitHub -> 以 `lastSyncedCommit` 为基线三方合并 -> 必要时在同一对话框解决冲突 -> 写回 Workspace -> 编译 -> 如有本地净变化则创建一条公开 commit 并 fast-forward push。
- 只有 GitHub 变化时更新本地 Workspace，不创建空 commit；只有本地变化或双方非重叠变化时自动完成同步，每次最多产生一条 FastWrite commit。
- 冲突时暂停在当前 Sync 流程。每个文本冲突块同时展示 Base、FastWrite 和 GitHub 内容，并提供可编辑的最终结果；用户可以逐行或逐句保留、删除、改写任一侧内容，也可以直接输入新的合并文本。`Keep FastWrite` 和 `Keep GitHub` 只是一键填充当前冲突块的快捷操作，不限制用户手工合并。每个文本冲突都确认结果，且二进制、rename/delete、modify/delete 和路径冲突都完成显式结构选择（必要时指定最终路径/名称）后，才可用 `Apply & continue sync` 继续。
- 若远端在 fetch 后再次变化，系统重新获取并对账，绝不 force-push。若最终主分支只希望保留一条 FastWrite 记录，使用独立同步分支和 GitHub Squash Merge，不改写共享历史。

### 论文与编译

项目支持本地目录和 GitHub 仓库复制导入。浏览器 WASM 与本地 LaTeX 编译、PDF Diagnostics 和双向 SyncTeX 是四项功能的验证底座。GitHub Sync 是 Workspace 支撑能力，不新增写作模式；GitHub 可作为 FastWrite 与 Overleaf 的交换层，但 Overleaf 端的 Pull/Push 仍由用户在 Overleaf 手动触发。Tauri 仍属后续范围。

## 5. P1 范围

| 功能 | P1 要求 |
| --- | --- |
| 自动补全 | 自动意图、内联虚文本、取消与过期保护、Tab/Esc |
| Agent 初稿与修改 | 计划确认、多文件 ChangeSet、逐 hunk 审批、编辑与回滚 |
| 逐段精修 | 任意选区/当前 Section、连续对话、Diff、Accept/Reject/Rollback |
| 自动审稿闭环 | 当前源码、可选临时 PDF 预览、证据摘录、Revise/Agent 路由、针对性复审 |
| Git 历史与同步 | 内部聚合 checkpoint、Git-based revert、单一手动 Sync、单次最多一条公开 commit、三方冲突处理 |

P1 不新增更多 AI 模式，不恢复自动分段 Editor，也不建设复杂 Prompt 管理器。
