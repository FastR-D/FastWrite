# FastWrite 产品需求

## 1. 产品目标

FastWrite 是面向安全与 AI 顶会论文的 AI 写作工作台。它保留 Overleaf 熟悉的文件、源码和 PDF 工作方式，用项目级 Writing Skill 驱动三个核心功能：

1. **Agent**：从研究想法快速生成初稿，或完成跨文件修改。
2. **Revise**：围绕当前文件中的一句、几句、一段或一节连续精修。
3. **Review**：按项目 Writing Profile 审稿，形成可执行 Issue，并引导用户调用 Agent 或 Revise 逐项解决。

产品不建设复杂的 Prompt 模式系统。写作结构、语言风格和审稿标准都由项目 Skill 提供。项目只选择两类 Writing Profile：

- `security-top4`：IEEE S&P、USENIX Security、ACM CCS 和 NDSS 共用同一套安全顶会写作与审稿规范，不再区分会议子 Profile。
- `ai-top-tier`：AI 顶会共用的论文结构、实验论证、复现性、限制与审稿规范。

## 2. 工作区

界面采用紧凑的 Overleaf 式三栏布局和蓝色主题：

```text
┌──────────┬──────────────────────────┬──────────┐
│ Files    │ Editor                   │ PDF      │
│ Outline  ├──────────────────────────┤ Preview  │
│          │ Revise chat              │          │
└──────────┴──────────────────────────┴──────────┘
```

- 左侧：文件树和论文 Outline。
- 中间上方：完整源文件 Editor；不自动拆分 Section、Paragraph 或 Sentence，不使用段落卡片。
- 中间下方：单一 Revise 聊天窗口。
- 右侧：浏览器 WASM LaTeX 编译、PDF、Diagnostics 和双向 SyncTeX。
- Agent 与 Review 使用近全屏任务工作区，避免在狭窄面板中处理多文件内容。

顶层 AI 入口只使用 **Agent / Revise / Review** 三个产品术语。Academic polish、Condense 等只是 Revise 输入快捷 Prompt，不是模式；不出现 Diagnose、Refine、QuickFix。

## 3. 三条核心流程

### 3.1 Agent：快速初稿与跨文件编辑

用户先向 Agent 提交一段自然语言 research brief，其中可包含研究问题、贡献、威胁模型约束、已有材料和真实证据。Agent 必须：

1. 读取项目 Skill、Paper Memory 和现有文件。
2. 先提出论文 Outline，不立即写文件。
3. 用户确认或编辑 Outline 后生成多文件 ChangeSet。
4. 以类似代码审查的方式逐文件展示 Diff。
5. 支持逐文件、逐 hunk 接受或拒绝，并允许直接编辑候选内容。
6. 只有接受的修改才写入受管理 Workspace；随后编译 PDF。

缺少实验、引用或事实时必须保留明确 TODO，不得捏造。Review 产生的跨章节问题也复用同一个 Agent 计划、ChangeSet 和审批链路。

**验收标准**：用户能从一段 research brief 得到可编辑 Outline；生成后可依次查看每个文件；接受前源文件不变；接受局部 hunk 后只写入该部分；并发版本变化会阻止写入。

### 3.2 Revise：单文件连续精修

用户可在 Editor 中选择任意一句、几句或一段；也可一键使用光标所在的整个 Section。随后在同一个聊天窗口连续提出要求。

每轮行为：

1. Agent 读取原始选区、当前未接受候选、前后文、Section、Skill 和已确认 Memory。
2. 回复完整替换候选、修改理由和词级 Diff。
3. 用户可以继续追问；下一轮基于最新候选，而不是回到原文。
4. 用户可以手动编辑候选，然后 Accept 或 Reject。
5. Accept 后才写文件；新文本在 Editor 中继续保持选中，可立即进行下一轮精修。
6. 支持 Rollback；新建选区时开始新的 Revise 会话。

快捷 Prompt 只负责填充常用意图，例如 Academic polish、Logic check、Condense、Grammar。聊天窗口始终可输入自定义要求，不切换功能模式。

**验收标准**：连续两轮精修的第二轮收到第一轮候选；两轮未 Accept 时文件均不变；Accept 后只替换选区；焦点位于聊天窗口时 Editor 仍显示选区；整节选择不依赖自动分段 UI。

### 3.3 Review：审稿到逐项解决

Review 固定当前项目版本，读取全文、Outline、Writing Skill、Memory 和编译状态，生成证据优先的结构化报告。每个 Issue 包含严重级别、类别、理由、影响、建议及源码证据。

每个有效 Issue 提供两条明确路径：

- **Revise locally**：有单文件直接证据时，打开并选中证据文本，把建议带入 Revise 聊天。
- **Fix with Agent**：问题跨文件、跨章节或需要规划时，创建关联 Issue 的 Agent 任务。

用户按优先级逐项处理，重新编译后可进行针对性复审；只有复审确认后才应标记 resolved。Review 自身不直接改正文。

**验收标准**：Issue 可跳转到真实源码；本地路径能建立准确选区；Agent 路径保留 Issue 关联和影响文件；修改仍需 ChangeSet 审批；可区分 open、in revision、resolved 和 dismissed。

## 4. 共享约束

### Skill

Skill 贯穿 Agent、Revise、Review 和实时补全。Writing Style 以 Skill 文件提供，不建设独立 Prompt 管理页面。任何 AI 请求都记录 Skill 与版本。Security Top-4 四个会议只读取同一个共享 Profile；会议名不是额外配置维度。

### ChangeSet

所有 AI 写操作使用同一个 ChangeSet 协议：

```text
Plan/Chat → Proposed ChangeSet → Diff/Edit → Accept/Reject → Compile → Rollback
```

- AI 不直接覆盖论文。
- ChangeSet 保存基础文件版本，写入时检查冲突。
- 单文件 Revise 与多文件 Agent 使用相同的审批、审计和回滚语义。

### Paper Memory

Memory 只保存有源码证据且经用户确认的研究问题、贡献、术语、威胁模型、实验事实、限制和开放问题。未确认内容不能作为论文事实。

### 导入与部署

- Paper 支持本地目录上传和 GitHub 仓库导入。
- 两种导入都复制到受管理 Workspace；不直接编辑来源目录。
- 浏览器只通过相对 HTTP API 访问文件，兼容当前本机前后端、未来服务器部署和 Tauri。
- 服务端部署时不能读取用户电脑的绝对路径。

### PDF

浏览器 WASM LaTeX、PDF 预览、编译错误定位和双向 SyncTeX 是核心能力，必须保留。Agent/Draft 修改接受后应以当前版本编译作为完成检查。

## 5. P1 范围

| 能力 | P1 要求 |
| --- | --- |
| Workspace | 项目、受管理导入、文件树、Outline、连续源码编辑、导出 |
| Agent | research brief、Outline 确认、多文件 Diff、逐文件/逐 hunk 审批、手工编辑 |
| Revise | 任意选区/当前 Section、连续聊天、Diff、Accept/Reject/Rollback、持久选区 |
| Review | 按 Security Top-4 或 AI Top-Tier Skill 结构化审稿、证据 Issue、本地 Revise/跨文件 Agent 路由、复审 |
| Skill/Memory | Skill 全程生效；Memory 证据确认和版本记录 |
| PDF | WASM 编译、PDF、Diagnostics、双向 SyncTeX |
| 部署 | 本地目录/GitHub 复制导入；本机与服务器 Web 同一协议 |

Tauri 属于 P2。P1 不新增第四种 Agent、不恢复三模式 Revise、不实现复杂 Prompt 管理器，也不恢复自动分段 Editor。
