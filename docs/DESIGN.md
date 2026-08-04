# FastWrite 系统设计

> [RDA.md](./RDA.md) 定义产品需求，[DEV.md](./DEV.md) 记录代码映射与实现状态。本文只描述长期稳定的系统边界和设计决策。

## 1. 设计原则

1. **Workspace 是正文真相**：AI 输出、Memory 和 Review 都是派生数据，不能取代论文源文件。
2. **用户控制写入**：Completion 由 `Tab` 接受；Agent 和 Revise 通过 ChangeSet 审批；Review 不写正文。
3. **上下文按任务最小化**：跨文件 Agent 可读取完整论文上下文，本地写作只读取当前 Section，Review 以冻结 PDF 为正文。
4. **所有结果绑定版本**：文件版本防止覆盖并发编辑，项目版本绑定编译、审稿与问题解决状态。
5. **证据优先**：缺少事实、结果或引用时保留 TODO、返回空建议或报告不确定性，不允许推断成论文事实。

## 2. 系统边界

```text
Web Workspace
  -> relative HTTP API
    -> Workflow Services
      -> OpenAI-compatible Providers
      -> Skill / Memory
      -> Workspace / JSON Database / PDF Artifacts
```

- Web 负责编辑、选择上下文、展示候选和收集用户决策。
- Server 负责版本校验、上下文组装、Provider 调用、状态机和文件写入。
- Provider 只返回结构化候选，不直接访问 Workspace。
- Workspace 保存论文文件；成功编译产生与项目版本绑定的 PDF artifact 和 SyncTeX；JSON Database 保存 Run、Plan、ChangeSet、Review、Memory 和版本元数据。
- Writing Skill 定义论文结构、写作风格和审稿标准，不建设第二套 Prompt 模式系统。

## 3. 四条工作流契约

| 工作流 | 输入单位 | 输出 | 写入规则 |
| --- | --- | --- | --- |
| Completion | 光标、文件版本和局部上下文 | 一条内联建议 | 用户按 `Tab` 后进入 Editor，再走普通保存 |
| Agent | 自然语言目标、项目源码和可选的用户所选审稿意见 | Plan，再生成多文件 ChangeSet | 确认 Plan 后才生成候选；只写入接受的 hunk |
| Revise | 一句、段落、连续选区或当前 Section | 单文件替换候选和理由 | Accept 后替换选区；Reject 不写入；支持 Rollback |
| Review | 当前版本 PDF 与 Skill；源码、Outline、SyncTeX 仅用于证据映射 | ReviewReport 与审稿意见 | 不直接写正文；所选意见路由到 Revise 或 Agent |

Agent 的 `draft | continue | revise` 是同一工作流的意图，不是三个独立 Agent。系统可自动判断，也允许用户显式指定。初稿和继续写作可以规划新 `.tex` / `.bib` 文件；普通修改只能处理已有文件。

## 4. 写入与审批

### Completion

建议绑定 `path + cursor + fileVersion`。新输入、光标移动、请求取消或文件版本变化都会使建议失效。接受时只插入尚未输入的后缀，避免重复文本。

### Agent 与 Revise

两者共享 `ChangeSet -> TextChange -> TextHunk`：

```text
Request -> Plan/Proposal -> Diff/Edit hunk -> Accept/Reject -> Complete review -> Compile -> Rollback
```

- Agent 必须先给出步骤、影响文件、风险和验证方式；确认前不生成文件修改。
- Revise 每轮基于最新未接受候选，连续对话不会回退到最初原文。
- Agent 候选只允许逐 hunk 编辑；已接受 hunk 必须先改为 rejected 才能编辑。编辑 pending/rejected hunk 不改变同文件其他 hunk 的 ID 或决定。局部 Revise 仍可编辑其单一完整候选。
- Agent 审核区分三个动作：`Leave review` 仅离开并保留可恢复任务；`Accept/Reject pending & complete` 只决定剩余 pending hunk 并自动完成；所有 hunk 已逐项决定后，`Complete review` 只终结 ChangeSet 状态。
- 每个 TextChange 保存 `baseVersion` 和 `baseContent`。当前文件不再匹配时，不改变 ChangeSet 为永久 conflict，也不静默合并或覆盖；服务端返回 `Current workspace -> reviewed result` diff，用户显式确认后才可覆盖。
- 覆盖确认绑定冲突文件的最新 `currentVersion`。确认后文件再次变化时旧确认立即失效，服务端返回新的 diff 与版本；所有文件验证完毕后才开始写入，冲突不得产生部分应用。
- 应用 ChangeSet 前先 flush 普通保存并创建 base checkpoint；每批接受的 hunk 随后立即形成独立 operation checkpoint，ChangeSet 保存对应 Git OID。
- Rollback 采用内部 Git 的 `revert` 语义，不使用 `reset`。系统对 operation commit 生成反向 patch，与当前 Workspace 做三方合并，然后把结果提交为新的 rollback checkpoint。
- 回滚必须保留 operation commit 之后的不相关编辑；同一 hunk 已被继续修改时暂停并要求用户解决冲突。任何情况下都不移动历史引用或执行 `reset --hard`。

### Review 闭环

```text
ReviewSnapshot(PDF) -> Review Issue -> Revise locally / Fix with Agent
               -> ChangeSet accepted -> current version compiled
               -> targeted re-review -> resolved / reopened
```

ReviewSnapshot 必须固定项目版本、成功编译记录、PDF artifact、PDF SHA-256、Skill 和源码文件摘要。Review Provider 读取原始 PDF；若 Provider 不支持 PDF 文件输入，Adapter 必须从同一 PDF 生成逐页图像和 PDF 文本，不能退化为直接审阅 LaTeX 源码。

一条**审稿意见（Review Issue）**是 ReviewReport 中的一个独立问题。它必须包含类别、严重级别、理由、影响、建议、PDF 页码和 PDF 原文；通过 SyncTeX 或文本匹配定位成功时，再附加源码路径与行号。

“用户选中的审稿意见”是本次交给 Agent 或 Revise 的一条或多条 Review Issue，不是新的领域对象。单一且有可靠源码映射的问题进入 Revise；跨文件、跨章节或多条意见进入 Agent。两条路径都应建立 IssueResolution，记录原 ReviewSnapshot、所选意见、ChangeSet 和新 PDF。修改接受后仍是 `in-revision`；新版本 PDF 编译成功后才允许 targeted re-review。只有新 PDF 已解决全部所选意见且没有明显回归时，Resolution 才进入 `resolved`。

## 5. 上下文与 Paper Memory

| 工作流 | 上下文边界 |
| --- | --- |
| Completion | 光标附近、Outline、Bib、Skill、已审核论文概览和当前 Section |
| Agent | 项目源码、Skill、完整已审核 Memory、User Instructions；从 Review 发起时增加用户选中的审稿意见及 PDF 证据 |
| Revise | 选区、同文件前后文、精确 Section、Skill、已审核论文概览和当前 Section；从 Review 发起时增加一条审稿意见及 PDF 证据 |
| Review | 当前版本的冻结 PDF、Skill；源码、Outline、SyncTeX 仅用于证据映射；不读取 Memory |
| Targeted re-review | 修改后的当前版本 PDF、原 ReviewSnapshot 与用户选中的审稿意见、Skill；不读取 Memory |

Paper Memory 是有源码证据且经用户审核的派生上下文，包含 Overview、Section 摘要和原子 Facts。其生命周期为：

```text
Extract candidates -> user review/edit -> lock/apply -> source changes mark stale
                   -> regenerate candidates -> user chooses replacement
```

- 未审核候选不能作为论文事实。
- 锁定内容不会在重新生成时被静默覆盖，冲突只作为 candidate 展示。
- 编辑单个 Memory 部分时，可调用 Memory Provider 统一学术英语表达，但必须保留术语、数字、引用、不确定性和证据边界。
- 根目录 `memory.md` 是用户可见的持久化表示；User Instructions 只提供给跨文件 Agent。
- `memory.md` 排除在 Memory 提取、Agent 源文件和 Review 快照之外，避免自我引用。

## 6. 版本、Git 与同步

### 版本与编译

- `PaperFile.version` 是文件级乐观并发令牌，用于保存、Completion、选区和 ChangeSet 校验。
- `PaperProject.version` 是项目级单调计数器，用于绑定编译记录、ReviewSnapshot、已接受的 Agent 修改和 IssueResolution；它不是 Git commit 或同步版本。
- Review 必须使用当前项目版本的成功编译 PDF；source-only 只能作为开发诊断，不能生成正式 ReviewReport。
- Targeted re-review 必须使用修改之后、当前项目版本的新 PDF，并与原 ReviewSnapshot 和所选审稿意见比较。

### 内部 Git 历史

每个项目使用无 remote 的 `history.git` 保存完整 Workspace tree。Editor 仍按文件版本正常保存；Git 只做恢复和审计，不参与每次按键保存。

- 普通文本从第一次未 checkpoint 修改开始计时，在停止保存两分钟或累计十分钟时创建一个聚合 checkpoint，以先到者为准。
- 文件结构变化、AI ChangeSet 接受、Rollback、手动 checkpoint 和 GitHub Sync 前立即提交。
- AI operation 前后的 checkpoint 必须隔离，使每个 ChangeSet 能绑定明确的 `baseCheckpointOid` 和一个或多个 `appliedCheckpointOid`。
- 恢复任意旧版本都采用“restore as new commit”，不移动 branch，不删除之后的历史。
- 内部 message 可以稳定、机械化并默认隐藏；这些 commit 永不进入公开仓库。

### GitHub 同步

GitHub Sync 使用独立的 staging repository 和 `lastSyncedCommit`，不复用 `history.git`。内部 autosave checkpoint 无需 rebase，也不能被 cherry-pick 或 push 到远端。当前本地/单机服务使用 `FASTWRITE_GITHUB_TOKEN`；服务器部署后再接 GitHub App 或 OAuth。用户界面不要求用户输入 Git 命令。

顶层只有一个手动 `Sync` 按钮。一次 Sync 是可持久化、可恢复的状态机：

```text
save local -> internal checkpoint -> fetch GitHub -> three-way merge
           -> resolve conflicts if needed -> apply locally -> compile
           -> create at most one public commit -> fast-forward push
```

| 对账结果 | 行为 |
| --- | --- |
| 本地与 GitHub 均无变化 | 直接进入 `Synced` |
| 仅 GitHub 有变化 | 写回 Workspace、checkpoint 并编译；不创建空 commit |
| 仅本地有变化 | 编译后创建一条公开 commit 并推送 |
| 双方有非重叠变化 | 自动合并、写回并编译，再创建一条公开 commit 并推送 |
| 存在冲突 | 暂停在同一 Sync 对话框，解决后继续原流程 |

每个文本冲突按冲突块展示 Base、FastWrite 和 GitHub 三个版本，并提供始终可编辑的最终结果。用户可在结果中逐行或逐句保留、删除、改写任一侧内容，也可自由输入新的合并文本；合并不局限于整文件或整侧二选一。`Keep FastWrite` 和 `Keep GitHub` 只把当前冲突块的一侧内容填入结果区，是便捷起点而非唯一解决方式。只有每个文本冲突块都有已确认的可编辑结果，且全部结构冲突已显式解决，`Apply & continue sync` 才可用；它是同一流程的继续操作，不是第二个顶层按钮。用户可见状态为 `Not configured / Unsynced / Saving / Fetching GitHub / Merging / Resolve conflicts / Compiling / Pushing / Synced / Failed`。

公开 commit message 由系统生成。每次 Sync 最多创建一条 FastWrite commit；若最终主分支只需一条记录，使用独立同步分支和 GitHub Squash Merge。后台只能只读检查远端状态，不能自动 push；共享历史永不 rebase 或 force-push。

GitHub 是 FastWrite 与 Overleaf 的交换层：FastWrite Sync 后由用户在 Overleaf 手动 Pull；Overleaf 修改由用户 Push 到 GitHub 后，再通过 FastWrite Sync 合并回来。FastWrite 不调用或伪装 Overleaf 的同步操作。

## 7. 冲突模型

| 场景 | Base | Current | Incoming |
| --- | --- | --- | --- |
| Editor stale save | 打开文件时内容 | Workspace 当前内容 | 用户尚未保存的修改 |
| ChangeSet Accept | ChangeSet 基础内容 | Workspace 当前内容 | AI 候选 |
| Git Rollback | operation 应用后 tree | 当前 Workspace | operation 应用前 tree |
| GitHub Sync | `lastSyncedCommit` | 当前 Workspace 快照 | 最新远端 HEAD |

- 非重叠文本修改可以自动三方合并，结果必须可查看；只有冲突项要求用户决策。
- ChangeSet 审核采用更严格的覆盖确认：发现 Workspace 与已审核状态不一致时，展示 `Current workspace -> reviewed result`，保持任务可继续审核；只有携带最新文件版本的显式确认才写入 reviewed result。令牌过期时重新展示 diff，不复用旧确认。
- 每个重叠文本冲突块使用 Base / FastWrite（Current）/ GitHub（Incoming）对照和可编辑结果。结果按普通文本编辑，允许逐行或逐句组合两侧内容、删除不需要的句子、改写措辞或输入全新内容，不要求接受完整一侧。
- `Keep FastWrite` / `Keep GitHub` 仅替换当前冲突块的可编辑结果；用户仍可在其基础上继续修改。每个文本冲突块必须有已确认结果，不能仅靠关闭对话框或保留未处理的 conflict marker 视为解决。
- 二进制内容不能逐行合并；rename/delete、modify/delete 和路径碰撞必须显式选择保留、删除、重命名或目标路径，适用时还必须填写最终路径/名称。
- 冲突 marker 与临时 Git index 不得写入正式 Workspace。全部文本结果和结构选择完成后，在项目级写锁内再次校验文件版本、项目版本和远端 HEAD，再一次性应用结果。
- 合并结果先写回 Workspace 并创建内部 checkpoint，再编译和同步，确保 Workspace 与 GitHub 的最终 tree 一致。若应用前 Workspace 版本已变化，则重新对账。
- 远端在 fetch 与 push 之间前进时，fast-forward push 失败，当前 Sync 重新 fetch 并进入新一轮对账；用户已解决的选择保留为候选，但必须重新验证。

## 8. 恢复与失败边界

- Agent 与 Review 长任务可取消并受超时限制；取消或失败不得产生可审批的 ChangeSet 或 Review。Completion 的旧响应由光标和文件版本校验丢弃。
- Agent Plan、Run、ChangeSet 和 Review 持久化到服务端，可在重新进入工作区后恢复。
- Revise 的选区、对话和当前候选按项目保存在前端；切换 Revise/Agent Tab 不应中断仍在运行的任务。
- 编译失败不会回滚已确认文本，但会阻止审稿意见进入复审完成状态，并将错误交给 PDF Diagnostics 处理。
- 普通保存遇到 Git 失败时正文仍保留，但 UI 必须显示 History degraded 并重试；依赖 Git OID 的 AI Accept、Rollback 和 Sync 在 operation checkpoint 成功前不能报告完成。
- GitHub 同步冲突使用独立的 SyncConflict，不复用 AI ChangeSet；Overleaf Sync 与 Tauri 是后续边界，也不扩展新的写作模式。
