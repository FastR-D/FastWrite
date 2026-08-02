# FastWrite-New 开发状态

> 产品范围与验收标准见 [RDA.md](./RDA.md)。本文只记录实现结论、复用边界和剩余工作。

## 当前实现

FastWrite-New 已收敛为三条主流程：

- **Agent**：自然语言 research brief → Outline 确认 → 多文件 ChangeSet → 逐文件/逐 hunk 审批 → WASM 编译。
- **Revise**：Editor 任意选区或当前 Section → 单一连续聊天 → Diff/手工编辑 → Accept/Reject/Rollback；下一轮基于最新候选，Accept 后新文本继续选中。
- **Review**：按 Writing Profile 进行证据审稿 → Issue → `Revise locally` 或 `Fix with Agent` → 编译和针对性复审。

共享底座包括两套项目级 Skill（Security Top-4、AI Top-Tier）、证据化 Paper Memory、版本冲突保护、托管 Git 历史、ChangeSet 审计、浏览器 WASM LaTeX、PDF Diagnostics 和双向 SyncTeX。Editor 始终编辑完整源文件，不自动分段。

## P1 完成度

| 范围 | 状态 | 说明 |
| --- | --- | --- |
| Workspace 与导入 | ✅ | 新建、导出、本地目录/GitHub 复制导入、内部目录过滤、托管 Git 历史、文件树、Outline、文件操作和自动保存 |
| Editor 与 PDF | ✅ | GitHub/VS Code 同款 Monaco、LaTeX/Markdown 高亮、WASM LaTeX、PDF/Diagnostics、双向 SyncTeX |
| Agent 初稿 | ✅ | research brief、Outline、跨文件 Diff、逐 hunk 决策、候选手工编辑、编译门禁 |
| 连续 Revise | ✅ | 单聊天、快捷 Prompt、候选链、整节选择、Accept 前不写文件、持久选区和回滚 |
| Review 闭环 | ✅ | 结构化报告、证据 Issue、本地/Agent 两类解决入口、状态与针对性复审 |
| Skill 与 Memory | ✅ | Security Top-4 四会共用一个 Profile，另有 AI Top-Tier；Skill 贯穿 Agent/Revise/Review/Completion，Memory 需证据和确认 |
| Tauri | ⏳ P2 | 复用 Web UI、Workspace API 和 WASM 编译契约，尚未开发 |

## FastWrite-V1 复用边界

直接保留或演进：

- Overleaf 式三栏布局、文件树/Outline、可拖拽分栏和紧凑工具栏经验。
- 浏览器 WASM LaTeX 资源、编译流程、PDF 预览、Diagnostics 和 SyncTeX。
- Editor/PDF 同步以及多文件论文项目的交互模型。

不复用：

- Section / Paragraph / Sentence 自动解析和卡片式 Editor。
- Diagnose / Refine / QuickFix 三模式和复杂 Prompt 配置。
- AI 直接覆盖正文、本地绝对路径挂载、窄小 Agent 弹窗。
- V1 的高按钮、大圆角和粗糙视觉细节；New 只复用成熟布局与引擎，组件按蓝色 Overleaf 风格重新打磨。

## 实现约束

- 所有来源复制到受管理 Workspace；服务器不能访问用户电脑绝对路径。
- `.git`、`.writeagent/backups` 和构建输出不导入、不显示、不参与 Main document 检测；备份使用 Workspace 外部的 `history.git`，不复制版本文件，也不修改原论文目录。
- 所有 AI 修改必须经过 ChangeSet、Diff 和用户审批。
- Revise 的原始选区用于版本校验，`workingText` 仅表示当前未接受候选；连续追问不提前写文件。
- Review 只提 Issue：单文件直接证据进入 Revise，跨文件问题进入 Agent。
- Writing Style 只通过 Skill 提供；不新增 Prompt 管理系统或 Revise 模式。
- Writing Profile 只有 `Security Top-4` 与 `AI Top-Tier` 两类；不再保存或展示 S&P、USENIX Security、CCS、NDSS 子选项，旧项目启动时统一迁移到 `Security Top-4`。

## 验证

提交前运行：

```bash
bun run typecheck
bun test
bun run build
bun run e2e:smoke
bun run e2e:cross-browser
bun run llm:smoke
```

自动验证覆盖类型、服务端 API/ChangeSet、主要浏览器流程、WASM PDF 和真实 `.env` Provider。发布前仍需用真实安全论文完成人工验收与最终视觉签收。

最近验收（2026-08-02）：`typecheck`、52 项测试、生产构建、Chromium 主流程和 `.env` 真实 LLM 9/9 均通过；此前 Firefox/WebKit 主流程也已通过。多文件初稿生成使用 300 秒默认时限，其余 Agent 默认 120 秒。

## 下一步

1. 分别用真实安全与 AI 论文验证长文上下文、Skill 输出和失败恢复，不扩展新模式。
2. 完成两类 Writing Profile 从导入、Agent 初稿、连续 Revise 到 Review 闭环的新用户人工测试。
3. P2 再开发 Tauri 生命周期、桌面文件选择、安装升级和崩溃恢复。
