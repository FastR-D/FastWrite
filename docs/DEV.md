# FastWrite-New 开发设计

> 产品需求与验收标准见 [RDA.md](./RDA.md)。本文只记录四项核心功能的实现边界。

## 1. 总体架构

```text
React Workspace
  -> relative HTTP API
    -> Completion / AgentTask / Revise / Review Service
      -> workflow-specific OpenAI-compatible Provider
      -> Workspace + JSON Database + Skill + Memory
```

- `apps/web`：Monaco Editor、AI 工作区、Diff 审批和 Review UI。
- `apps/server/src/app.ts`：HTTP 路由与服务装配。
- `apps/server/src/agent`：四项 AI 服务、Provider、Skill、Memory 和 ChangeSet。
- `packages/shared`：请求、状态、ChangeSet、Review Issue 等共享模型。
- Workspace 文件是正文真相；JSON Database 保存 Run、Plan、ChangeSet、Review 和版本元数据。

## 2. 四项功能设计

### 2.1 自动补全

调用链：

```text
SourceEditor -> POST /api/projects/:id/completions
             -> CompletionService -> provider.complete
             -> Monaco inline decoration
```

`SourceEditor` 在编辑后 500 ms 发起请求，并在新输入、移动光标或卸载时取消旧请求。请求携带 `path + cursor + fileVersion + kind:auto`；服务端再次校验文件版本。

`CompletionService` 根据扩展名、数学环境和未闭合命令推断 `sentence | citation | formula | latex`。上下文上限为光标前 2500 字符、后 600 字符、Bib 8000 字符，返回建议最多 2000 字符。前端用 `completionSuffix` 去除已输入前缀，再由 `Tab` 插入；`Esc` 清除。

### 2.2 Agent 初稿与修改

主调用链：

```text
AgentTaskWorkspace
  -> POST /agent-tasks                 # 规划
  -> AgentTaskService.plan
  -> POST /agent-tasks/:planId/confirm # 执行已确认计划
  -> AgentTaskService.confirm
  -> ChangeSet -> editable hunk diff -> hunk decisions -> explicit finish
```

`AgentTaskService` 将任务归类为 `draft | continue | revise`。它读取项目文本文件（排除 `memory.md`，总上下文最多 500 KB）、完整已审核 Memory、User Instructions、Skill，以及可选的用户所选审稿意见。计划输出 `steps / affectedFiles / risks / validation`；只有 `draft` 和 `continue` 可在项目级 Scope 新建 `.tex` 或 `.bib`。

执行阶段只接受计划内文件，生成整文件候选，再拆为文本 hunk。Agent UI 只编辑单个 pending/rejected hunk；accepted hunk 必须先切换为 rejected，且编辑不得重建其他 hunk 或清除既有决定。逐 hunk 决策复用 `ReviseService` 的 ChangeSet 写入、冲突检查与回滚逻辑。`Leave review` 只切回 Revise，任务可恢复；全局 pending 决策会自动 finish；没有 pending 时 `Complete review` 只终结审核状态。由 Review 发起时同时维护 `IssueResolution` 状态和证据关联。

`DraftService` 与 `/drafts` API 保留兼容，但当前主界面统一使用 `AgentTaskService`，避免初稿和后期修改形成两套产品入口。

### 2.3 逐段精修

调用链：

```text
AiWorkspace/Revise -> POST /api/projects/:id/revisions
                   -> ReviseService.propose
                   -> one-file ChangeSet -> Accept/Reject/Rollback
```

前端保存选区、对话和当前候选。后续请求把上一轮 `workingText` 与最近对话一并发送，因此每轮继续修改最新候选。候选未接受时只存在于 ChangeSet 和前端状态中。

服务端校验选区文本、偏移和 `fileVersion`，输入上限为 12000 字符；对话保留最近 8 轮，较早内容压缩为摘要。上下文只包含同文件前后文、精确 Section、Skill、已审核论文概览和当前 Section 摘要。输出是单文件完整替换与 rationale，并转换为词级 Diff/文本 hunk。

### 2.4 自动审稿与问题解决

调用链：

```text
ReviewDialog -> POST /api/projects/:id/reviews
             -> ReviewService.run -> ReviewSnapshot + ReviewReport + Issues
Issue -> Revise locally
      -> Fix with Agent -> AgentTaskService -> IssueResolution
      -> compile -> targeted re-review
```

目标设计要求 `ReviewService` 读取当前 `projectVersion` 对应的 PDF artifact；源码、Outline 和 SyncTeX 只用于把 PDF 页码与原文映射回源码。ReviewEvidence 应保存 PDF 页码与 PDF excerpt，并可选保存源码路径和行号。

当前实现尚未达到该设计：浏览器编译的 PDF 只保存在前端 Blob URL；服务器编译返回 `pdfBase64` 后也不持久化。`CompileRecord` 只有状态和摘要，`ReviewAgentInput` 实际只有 `documents + outline`，targeted re-review 同样只读取源码；`sourceOnly` 还可以生成正式报告。因此现状是源码审稿原型，不是 PDF 审稿。

需新增 PDF artifact 持久化：Browser WASM 编译成功后上传 PDF/SyncTeX，Server LaTeX 在临时目录清理前保存同样的 artifact；`CompileRecord` 引用 artifact ID 和 SHA-256。随后扩展 `ReviewSnapshot`、`ReviewAgentInput` 与 `ReviewEvidence`，让 Provider 实际接收 PDF 或由该 PDF 生成的逐页图像与文本，并记录页码证据；`sourceOnly` 只能保留为开发诊断，不能生成正式 ReviewReport。

一条 Review Issue 是报告中的单条审稿意见；“用户选中的审稿意见”是本次送往 Agent 或 Revise 的一条或多条意见。两条解决路径都应创建 `IssueResolution`。当前仅 Agent 路径保存 Resolution；Revise 路径和基于新 PDF 的 targeted re-review 仍需补齐。

## 3. 共享设计

### 上下文边界

| 工作流 | 可读取上下文 |
| --- | --- |
| Completion | 光标附近、Outline、Bib、Skill、已审核概览和当前 Section |
| Agent | 项目源码、Skill、完整已审核 Memory、User Instructions；从 Review 发起时增加用户选中的审稿意见与 PDF 证据 |
| Revise | 选区、同文件前后文、精确 Section、Skill、已审核概览和当前 Section；从 Review 发起时增加一条审稿意见与 PDF 证据 |
| Review | 当前版本 PDF、Skill；源码、Outline、SyncTeX 仅用于证据映射；不读取 Memory |
| Targeted re-review | 新 PDF、原 ReviewSnapshot、用户选中的审稿意见、Skill；不读取 Memory |

`memory.md` 不进入源码上下文，避免自我引用。缺少证据时返回空建议、保留 TODO 或报告不确定性，不得补造事实。

### ChangeSet

Agent 和 Revise 共享 `ChangeSet -> TextChange -> TextHunk` 模型。正常审核状态为 `proposed / partially-accepted / accepted / rejected / rolled-back`；旧数据仍兼容 `conflict`，但新的并发冲突不持久化该状态。每个变更保存 `baseVersion / baseContent / currentVersion`。Workspace 不再匹配已审核状态时，`decide` 返回 `changeset_conflict_review_required`，其中包含当前内容、reviewed result 和最新版本；前端展示重新 diff，只有 `overwriteConflicts: [{ path, currentVersion }]` 显式确认后才覆盖。确认是 CAS 令牌，文件再次变化后必须重新确认；服务端先验证所有触及文件，再执行任何写入。接受、hunk 编辑、hunk 决策、审核完成、编译和回滚写入 Agent audit trail。

### Provider 配置

`completion`、`agent`、`revise`、`review`、`memory` 分别创建 Provider。每条工作流读取：

```text
FASTWRITE_<WORKFLOW>_API_KEY
FASTWRITE_<WORKFLOW>_BASE_URL
FASTWRITE_<WORKFLOW>_MODEL
```

每个字段独立回退到 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`FASTWRITE_OPENAI_MODEL`，并兼容现有 OpenAI 别名。Agent 规划与普通 AI 操作默认超时 120 秒；统一 Agent 的 `/draft`、`/continue`、`/revise` 完整文件生成及兼容 `/drafts` API 默认 300 秒。请求取消和超时必须返回明确状态。

### 保存、Git 与冲突

当前保存链路是：Editor 停止输入 850 ms 后用 `baseVersion` 保存；服务端写文件并递增 file/project version；文本保存继续重置两分钟 timer，空闲后 `git add -A` 整个 Workspace 并提交。创建、上传、重命名、删除和手动 checkpoint 会立即提交。`history.git` 是无 remote 的项目外仓库，内部 message 不会出现在 GitHub。

当前仍有以下缺口：

- ChangeSet Rollback 不调用 Git，而是用 `baseContent` 反向写文件；接受后只要文件再变化就返回 `version_conflict`。
- Git checkpoint 失败只写日志，正文保存仍返回成功；目前没有 history list/restore API，也不返回 commit OID。
- 纯两分钟 debounce 在持续编辑时可能一直不 checkpoint；结构操作还会顺带提交尚未到期的文本修改。
- 文件保存和多文件 ChangeSet 缺少覆盖“校验到写入”全过程的项目级锁，不能视为原子事务。
- GitHub 导入复制源码并过滤 `.git`，同时保存实际分支和导入 commit；该 commit 后续作为 `lastSyncedCommit`。顶层 `Sync` 已实现远端获取、三方合并、冲突恢复、编译门禁和 fast-forward push。

后续 Git-based Rollback 仍需要扩展 `GitHistory`：checkpoint 返回 OID，支持历史列表、operation checkpoint、基于 commit 的 reverse three-way merge 和 restore-as-new-commit。`ChangeSet` 记录 `baseCheckpointOid / appliedCheckpointOids`；普通编辑采用“两分钟空闲或十分钟累计”的双阈值。当前 GitHub Sync 已使用项目级串行队列隔离 start、resolve 和 finalize。

GitHub Sync 是一个服务端编排流程和一个顶层 `Sync` 按钮，不拆成面向用户的 Pull/Push 命令。`GithubSyncRun` 持久化冲突、待编译、完成、远端变化或失败状态，以及基线、远端 HEAD 和项目版本；独立 staging repository 以 `lastSyncedCommit / Workspace / remote HEAD` 三方对账，避免污染 Workspace 和内部 `history.git`。

无冲突时流程自动进入编译；仅远端变化时写回 Workspace、checkpoint 并编译，不创建空 commit；需要上传时一次 Sync 最多创建一个公开 commit 并 normal fast-forward push。冲突保存为可恢复的 `GithubSyncConflict`。前端在同一对话框逐个展示文本冲突块的 Base、FastWrite 和 GitHub 内容以及可编辑结果；结果是普通文本，可逐行或逐句组合、删除、改写或重新输入。`Keep FastWrite / Keep GitHub` 只为当前冲突块填充一侧内容，不能替代手工合并能力。二进制、rename/delete、modify/delete 和路径碰撞使用显式结构选择，必要时收集最终路径/名称。所有文本结果和结构选择完成前禁用 `Apply & continue sync`；完成后调用它恢复原 Sync，且任何 conflict marker 或临时 Git index 都不得进入 Workspace。finalize 会在项目级串行队列内复查项目版本和远端 HEAD；远端前进时停止当前流程并要求重新 Sync，不 force-push。当前认证读取 `FASTWRITE_GITHUB_TOKEN`，服务器部署的 GitHub App/OAuth 仍是后续工作。

内部 checkpoint 永不 push 或 rebase。最终需要一条主分支记录时使用独立同步分支和 GitHub Squash Merge。GitHub 可作为 Overleaf 的交换层：FastWrite Sync 到 GitHub，Overleaf 端仍由用户手动 Pull；Overleaf 修改 Push 到 GitHub 后，再由 FastWrite Sync 合并回来。

## 4. 当前状态

Completion、Agent、Revise 和 GitHub Sync 主流程已实现，但 Rollback 目前还不是 Git-based。Review 的报告、审稿意见管理和 Agent 路由已有源码审稿原型，但 PDF artifact、PDF Provider 输入、PDF 页码证据、Revise Resolution 和基于新 PDF 的 targeted re-review 尚未完成。

最近一次回归记录见 [BUG-done.md](./BUG-done.md)：2026-08-04 通过 `bun run typecheck`、102 项 `bun test`、`bun run build`、源码服务器完整 Chromium smoke，以及同一套直接运行在 `app-bin/fastwrite` 上的 release smoke。这些测试未覆盖 PDF 作为 Review Provider 输入；下一步应先完成 PDF 审稿纵向链路，再做真实安全/AI 论文验收。Tauri 仍属于独立后续范围。
