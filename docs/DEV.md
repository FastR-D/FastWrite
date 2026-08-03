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
| Paper 全同步 | ⏳ P1 | FastWrite 发布到 GitHub、Git 三方冲突解决、Overleaf 手动 Pull 与冲突分支回收；尚未实现 |
| Paper 快速同步 | 📝 P2 已设计 | 直接发布到 Overleaf Git Bridge；实验性文件覆盖需先验证私有接口 |
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

## 新功能设计：Paper 同步（全同步 P1 / 快速同步 P2）

### 产品结论与外部能力边界

Paper 同步以 FastWrite 受管理 Workspace 为正常写作入口，不在每次自动保存或 AI Accept 后自动推送。全同步属于 P1：常规路径从 Workspace 向外发布；遇到 GitHub 或 Overleaf 协作修改时，允许通过独立的三方对账流程把用户确认后的远端变更写回 Workspace。任何远端内容都不能静默合并，用户必须预览并主动执行。

| 模式 | 路径 | 自动化边界 | 凭据与限制 |
| --- | --- | --- | --- |
| **全同步（P1）** | FastWrite → GitHub → Overleaf | FastWrite 自动完成 GitHub 对账和 push；Overleaf 官方 GitHub Sync 不会自动拉取，也没有公开的触发 API，因此最后一步在 UI 中进入 `awaiting-overleaf-pull`，由用户打开 Overleaf 的 Integrations → GitHub 执行 Pull | GitHub fine-grained PAT；Overleaf GitHub Sync 是 Premium 功能，且不能把一个已有 Overleaf 项目绑定到一个已有 GitHub 仓库，首次使用应从该 GitHub 仓库新建 Overleaf 项目 |
| **快速同步（P2 稳定通道）** | FastWrite → Overleaf Git Bridge | FastWrite 直接把同一份冻结快照 commit/push 到 Overleaf，不经过 GitHub | Overleaf Git authentication token（用户名固定为 `git`）；这是官方能力但仍是 Premium 功能，不是 REST API key |
| **快速同步（P2 实验通道）** | FastWrite → Overleaf 文件上传接口 | 逐文件 create/overwrite，可选择删除远端多余文件 | `overleaf-sync/olsync` 使用登录 Cookie、CSRF、私有 HTTP 接口和 Socket.IO，并没有使用 API key；接口未公开且可能随时变化，必须先完成兼容性 Spike，不能作为默认生产通道 |

这里将用户口中的 “Overleaf API key” 校正为官方 **Git authentication token**。如果实际持有的是某个 Overleaf Server Pro 或第三方服务提供的 REST API key，则通过同一个 `OverleafSyncAdapter` 增加实现，不能把 Bearer token 行为硬编码进产品主流程。

参考项目 `olsync` 只复用以下思路：远端 ZIP 快照、按路径比较文件、先创建目录再上传文件、删除需单独确认。它用项目级 `lastUpdated` 和本地 mtime 判断冲突会误判，且删除实现不能完整覆盖二进制文件；这些实现不直接移植。

### 用户流程

#### 全同步

1. 在 Project settings → Paper sync 中绑定 GitHub repository、branch、写权限 PAT 和 Overleaf project URL；服务端验证仓库访问与 branch HEAD，只保存凭据引用。
2. 用户点击顶部 `Sync`，Editor 先完成当前 850ms debounce 中尚未落盘的保存；保存失败或文件版本冲突时不允许继续。
3. 服务端创建冻结的 Workspace 快照和 SHA-256 manifest，返回新增、修改、删除、跳过文件及总大小的预览。首次同步到非空仓库必须额外确认完整 diff。
4. 执行时 fetch GitHub branch，以上次成功同步的 commit 为 base、冻结 Workspace 为 ours、当前 GitHub branch HEAD 为 theirs。远端未前进时直接构造本地 commit；远端已前进时进入下述 Git 三方对账。
5. 在隔离的 staging repository 中生成最终 tree，创建普通 commit 或带 ours/theirs 两个 parent 的 merge commit。push 前再次确认 GitHub HEAD 未变化，只使用普通 fast-forward push；没有内容变化时记录 `noop`，不创建空 commit。
6. GitHub push 成功后运行状态为 `awaiting-overleaf-pull`。UI 提供 `Open Overleaf`；用户在 Overleaf 手动 Pull 后可点击 `Mark pulled`。该确认只表示用户操作完成，不能伪装成服务端已验证的 Overleaf revision。
7. 如果 Overleaf Pull 报告 merge conflict，Overleaf 会把自身版本推到 GitHub 的新分支。用户将该分支交回 FastWrite，复用同一个三方对账器合入默认分支，再回到 Overleaf 重试 Pull。
8. preview 到执行前 Workspace 有变化时返回 `stale_sync_preview`；普通 push 已开始后允许继续编辑，但只发布冻结版本，完成后立即显示 `Unsynced changes`。冲突 finalize 的短暂临界区会锁定写操作，不能把较新的项目版本误报为已同步。

#### Git 三方冲突与恢复

P1 不以 `remote_advanced` 作为终点，也不提供 force push。每个 GitHub binding 保存 `lastRemoteRevision` 作为共同基线，按以下规则处理：

1. **正常 fast-forward**：`theirs === base` 时，把冻结 Workspace 覆盖到 base tree 上形成 ours commit，重新检查 remote HEAD 后正常 push。
2. **远端无重叠更新**：若 `base` 是 `theirs` 的 ancestor，先创建 ours commit，再让 Git 执行三方 merge。自动 merge 成功后仍展示 `Incoming from GitHub` 文件清单；用户确认后，merged tree 同步写入 Workspace 并作为 merge commit push，保证 FastWrite、GitHub 和随后拉取的 Overleaf 内容一致。
3. **内容冲突**：自动 merge 失败时建立 `SyncConflict`。文本文件展示 base/FastWrite/GitHub 三列和合并候选，支持 `Keep FastWrite`、`Keep GitHub`、手工编辑；二进制 add/add、modify/modify 只能二选一。
4. **结构冲突**：modify/delete、rename/delete、directory/file、大小写路径碰撞和两侧不同 rename 必须逐项决定保留路径与内容；所有目标路径仍经过 Workspace 路径校验和忽略规则。
5. **历史被改写**：`base` 不是当前 remote HEAD 的 ancestor 时进入 `remote_history_rewritten`，禁止自动 merge。用户只能重新绑定/建立新 baseline，或把远端仓库导入为新 Paper 后人工比较；不能用 `--force` 绕过。
6. **最终提交**：所有冲突解决后，短暂锁定该项目写操作，重新检查 Workspace version、远端 HEAD 和每个已解决文件的 hash。任一变化都返回 `stale_sync_conflict` 并重新对账。
7. **应用与失败恢复**：确认后的 merged tree 先作为一次受审计的 bulk reconcile 原子写入 Workspace，并创建 managed Git checkpoint，再 push merge commit。push 结果不确定时立即 fetch 检查目标 commit 是否已到达；若确未到达，Workspace 保留已确认的合并结果并显示 `Unsynced`，下次从新 baseline 重试，不回滚或丢失任一侧内容。

Overleaf 冲突使用同一模型：Sync dialog 提供 `Resolve Overleaf conflict`，用户粘贴或选择 Overleaf 创建的 GitHub branch。服务端验证该分支属于已绑定 repository，计算 merge-base 后把它作为 theirs；完成合并并 push 默认分支后，用户再次在 Overleaf 执行 Pull。FastWrite 不自动删除 Overleaf 冲突分支，避免破坏取证和人工恢复。

#### 快速同步

稳定通道使用 Overleaf Git Bridge：绑定 Overleaf project URL/ID 和 Git authentication token，预览、远端 revision 检查、冻结快照、commit 和普通 push 与 GitHub 通道共用。P2 复用 P1 对账器处理 Overleaf 远端协作者修改；仍需用户确认 merged tree，不静默 pull/merge，也不使用 `--force`。

实验性文件覆盖通道必须遵循以下协议：

1. 先下载 Overleaf ZIP 与项目文件元数据，按字节 SHA-256 生成远端 manifest；不得只比较时间戳。
2. 用上次成功同步的 manifest 做基线。如果远端文件在基线后变化且本地目标内容不同，整次运行在任何上传前进入 `conflict`。
3. 预览 create/update/delete。默认只 create/update；`Mirror deletions` 必须单独勾选并二次确认，避免误删 Overleaf 独有材料。
4. 执行顺序为创建目录 → 上传新增/更新文件 → 删除已确认文件。接口不是事务性的；中途失败时运行标记为 `partial-failure`，保存每个路径的结果，重试只处理未达到目标 hash 的文件。
5. 覆盖或重命名可能破坏 Overleaf Track Changes/comments；预览必须给出目标文件级警告。不能声称文件上传通道保留 Overleaf 协作元数据。

### 数据与模块边界

`ImportSource` 继续只描述项目最初从哪里导入，不承载可变同步状态；内部 `history.git` 继续只做本地历史，绝不添加 remote 或复用为发布仓库。新增独立记录：

```ts
type SyncMode = "full" | "quick";
type SyncTransport = "github" | "overleaf-git" | "overleaf-upload";

interface SyncBinding {
  id: string;
  projectId: string;
  transport: SyncTransport;
  target: { repository?: string; branch?: string; overleafProjectId?: string; overleafUrl?: string };
  credentialRef: string; // 仅服务端内部可见
  lastRemoteRevision?: string;
  lastManifestHash?: string;
  lastSyncedProjectVersion?: number;
  createdAt: string;
  updatedAt: string;
}

interface SyncRun {
  id: string;
  projectId: string;
  mode: SyncMode;
  transport: SyncTransport;
  status: "queued" | "preparing" | "reconciling" | "awaiting-conflict-resolution" | "pushing" | "awaiting-overleaf-pull" | "overleaf-conflict" | "succeeded" | "noop" | "conflict" | "partial-failure" | "failed" | "interrupted";
  sourceProjectVersion: number;
  sourceManifestHash: string;
  remoteRevisionBefore?: string;
  remoteRevisionAfter?: string;
  summary: { created: string[]; updated: string[]; deleted: string[]; skipped: string[]; bytes: number };
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}

interface SyncConflict {
  id: string;
  runId: string;
  source: "github-target" | "overleaf-branch";
  baseRevision: string;
  oursRevision: string;
  theirsRevision: string;
  status: "open" | "resolved" | "stale" | "applied";
  files: Array<{
    path: string;
    kind: "content" | "add-add" | "modify-delete" | "rename-delete" | "path-collision";
    binary: boolean;
    resolution?: "ours" | "theirs" | "manual";
    resolvedHash?: string;
  }>;
  createdAt: string;
  updatedAt: string;
}
```

公开 API 返回 `SyncBindingView`，只包含脱敏目标、`credentialConfigured` 和最后同步状态，不返回 `credentialRef`。`DatabaseState` 增加 `syncBindings`、`syncRuns`、`syncConflicts`；运行记录限制保留最近 50 条/项目，冲突记录在对应 run 被清理前保留，详细错误先经过 `safe-log` 脱敏。

`SyncPreview` 不长期写入 database：冻结文件和 manifest 放在 `<dataDirectory>/sync-previews/<previewId>`，默认 TTL 15 分钟。执行运行时原子地 claim 该目录；成功、失败或过期后清理，服务启动时清除遗留预览。进程重启后的旧 `previewId` 直接返回 `stale_sync_preview`，不能退化为重新读取当前 Workspace。

服务端新增以下模块，保持 transport 与编排解耦：

- `sync/sync-service.ts`：绑定、预览、预览 TTL/claim、运行状态机、单项目互斥和启动恢复；进程启动时把遗留的活动运行标为 `interrupted`，由用户重试。
- `sync/workspace-snapshot.ts`：按统一规则创建冻结目录、manifest 和 diff；复用 `isIgnoredWorkspacePath`，排除内部目录、构建输出和 symlink。
- `sync/git-transport.ts`：隔离 clone/fetch/commit/push、远端 revision 检查、超时与错误映射；GitHub 和 Overleaf Git Bridge 共用。
- `sync/git-reconciliation-service.ts`：创建 base/ours/theirs、调用 Git 三方 merge、提取 index stage 1/2/3、保存逐文件决策、校验 stale 状态并生成最终 merge commit。
- `sync/workspace-reconcile.ts`：把已确认 merged tree 作为一次 bulk operation 应用到 Workspace，统一更新文件版本、project version 和 managed Git checkpoint；不复用 AI ChangeSet，但保留同等级审计与并发校验。
- `sync/github-adapter.ts`、`sync/overleaf-git-adapter.ts`：只负责 URL、认证环境和目标能力差异。
- `sync/overleaf-upload-adapter.ts`：实验性远端 ZIP、目录/文件元数据、上传与删除；只有 Spike 通过后才启用。
- `sync/credential-store.ts`：凭据与 `database.json` 分离。开发/单机版以权限 `0600` 的 secret store 保存；服务器部署要求 `FASTWRITE_SECRET_KEY` 并使用 AES-256-GCM；未来 Tauri 实现可替换为系统 Keychain。

所有 Git 凭据通过临时 `GIT_ASKPASS` 或仅对子进程生效的认证 header 注入，remote URL、命令参数、stdout/stderr、API 响应和日志中都不能出现 token。临时凭据文件使用 `0700` 临时目录、`0600` 文件并在 `finally` 清理。

### 文件规则与冲突策略

- GitHub、Overleaf 和 Export 使用同一份 `isIgnoredWorkspacePath` 语义；`.git`、`.writeagent`、`.fastwrite`、备份、构建输出、`node_modules`、`_minted-*`、`.DS_Store` 和 symlink 永不外发。
- manifest 记录规范化相对路径、字节数、SHA-256，不读取用户电脑绝对路径。发现大小写路径冲突、非法路径、Git LFS pointer 或 `.gitmodules` 时预检失败。
- Overleaf 官方建议 GitHub Sync 单次变更少于 100 个文件、项目小于 100 MB；超过时预览显示阻断性风险，不能静默推送。目标返回的真实 size/file-count 限制要映射为稳定错误码。
- 同一项目只允许一个活动 `SyncRun`；用 `Idempotency-Key` 防止双击重复 push。不同项目可并行。
- 永不 force push。远端 revision 前进时进入三方对账；认证失效、branch 保护、rate limit、文件限制、历史改写和网络超时分别返回可恢复错误，不笼统显示 `Sync failed`。
- 普通文本冲突不把 Git conflict marker 写入真实 Workspace；marker 只存在隔离 staging，UI 保存的是结构化 resolution 和最终内容。二进制与路径冲突不能伪造自动合并。
- 远端冲突不走 AI ChangeSet，因为同步不是 AI 写作操作；使用独立 `SyncConflict` 审批链。只有用户确认的 merged tree 才能写回 Workspace，且必须产生 managed Git checkpoint 和审计记录。
- branch protection 要求 PR 时 P1 返回 `branch_protected` 和目标 branch 信息，由用户在 GitHub 完成受保护分支流程后重新同步；P1 不自动创建 PR、不绕过保护规则，也不把候选 commit 显示成“已同步到 Overleaf”。

### HTTP API 与 UI

新增 API：

```text
GET    /api/projects/:projectId/sync
PUT    /api/projects/:projectId/sync/bindings/:transport
DELETE /api/projects/:projectId/sync/bindings/:transport
POST   /api/projects/:projectId/sync/preview
POST   /api/projects/:projectId/sync-runs
GET    /api/projects/:projectId/sync-runs/:runId
POST   /api/projects/:projectId/sync-runs/:runId/mark-overleaf-pulled
POST   /api/projects/:projectId/sync-runs/:runId/report-overleaf-conflict
GET    /api/projects/:projectId/sync-conflicts/:conflictId
PATCH  /api/projects/:projectId/sync-conflicts/:conflictId
POST   /api/projects/:projectId/sync-conflicts/:conflictId/finalize
```

`preview` 返回短期有效的 `previewId`、冻结 `sourceProjectVersion`、Git base/remote revision 和双向 diff；`sync-runs` 必须携带该 `previewId`，若 Workspace version、远端 revision 或预览 TTL 已变化则返回 `409 stale_sync_preview`。`PATCH sync-conflicts` 接受逐文件 decision 与手工合并内容，每次写入校验 conflict revision；`finalize` 只有在所有文件已解决时可执行。长操作返回 `202`，Web 端轮询运行状态；导航离开不取消服务端 reconciliation/push。

Workspace 顶部在 Project settings 按钮左侧增加 `CloudUpload` 图标按钮和状态点，状态固定为 `Not configured / Unsynced / Reconciling / Resolve conflicts / Syncing / Awaiting Overleaf pull / Overleaf conflict / Synced / Failed`。点击打开单一 Sync dialog：用 segmented control 选择 Full/Quick，展示绑定目标、最近一次结果和 outgoing/incoming diff；命令使用 `Preview`、`Sync to GitHub`、`Resolve conflicts`、`Sync to Overleaf`、`Open Overleaf`。绑定和换 token 放在 Project settings 的 Paper sync 区域，不把 token 再显示到运行对话框。

冲突解决使用近全屏工作区而不是窄 Dialog：左侧列出冲突文件和类型，中间使用 Monaco merge/diff editor，底部提供 `Keep FastWrite`、`Keep GitHub/Overleaf`、`Accept manual merge`，二进制文件显示双方 hash/size/预览并仅提供二选一。所有冲突解决前禁用 `Finalize merge`；关闭页面后决策仍从 `SyncConflict` 恢复。

`SourceEditor` 增加显式 `flushPendingSave()` 契约；打开预览前必须等待它成功。运行中允许继续编辑，但对话框固定显示正在发布的 project version，完成后按当前 version 重新计算顶部脏状态。

### 实现阶段

1. **P1.1 全同步底座 + 无冲突纵切**：在 shared models/database 加 binding/run；实现 SecretStore、WorkspaceSnapshot、GitTransport、GitHub adapter、API、Sync dialog 和 private bare-repository 集成测试。交付“绑定 → 预览 → 普通 push → Awaiting Overleaf pull → Mark pulled”的完整路径。
2. **P1.2 GitHub 三方对账**：实现 base/ours/theirs commit、自动 merge、`SyncConflict`、文本手工合并、二进制与结构冲突选择、stale 校验、bulk Workspace reconcile 和 merge commit。覆盖远端只改、两侧同改、modify/delete、rename/delete、历史改写、push 竞态和网络结果不确定。
3. **P1.3 Overleaf 冲突回收**：增加 Overleaf URL、Open/Mark pulled、`report-overleaf-conflict` 和冲突分支选择；把 Overleaf branch 接入同一个对账器，完成“合入默认分支 → 重试 Overleaf Pull”的闭环。这里不调用未公开 Overleaf 接口假装自动 Pull。
4. **P1.4 全同步验收与发布**：补 shared/server/web 单测、API 集成测试、Chromium/Firefox/WebKit E2E、凭据泄漏测试，以及真实 private GitHub + Overleaf Premium 项目的双人并发 smoke；更新 README 的 PAT 权限、Overleaf 建项、冲突恢复和 branch protection 限制。
5. **P2.0 快速同步外部能力 Spike**：用一次性 Overleaf 项目验证官方 Git Bridge token；抓包确认当前 Overleaf Cloud 是否仍支持 ZIP、project metadata、folder、upload、delete 以及二进制文件覆盖。若只能取得会话 Cookie/CSRF，则实验通道保持 feature flag 关闭，不能在 UI 中称为 API key。
6. **P2.1 快速同步稳定通道**：复用 GitTransport 和 P1 对账器实现 Overleaf Git Bridge adapter，覆盖远端前进、空 diff、认证过期和 main/master 兼容。
7. **P2.2 实验性文件覆盖**：仅在 P2.0 通过时实现 Upload adapter、远端 ZIP 三方 hash、删除确认、partial-failure 重试和 feature flag；否则保留接口，不阻塞稳定通道发布。

### 验收重点

- 未配置凭据、凭据错误、只读 GitHub token、Overleaf token 过期都得到可操作错误，任何日志/API/database 都搜索不到明文 token。
- 相同快照连续同步第二次为 `noop`；首次非空远端必须预览确认；远端在 preview 或 conflict resolution 后推进时不产生 push。
- 创建、修改、重命名、删除、二进制图片、嵌套目录、忽略目录和超过目标限制均有测试；远端失败不会改 Workspace 或内部 `history.git`。
- GitHub 仅有远端变更时能形成待确认 merged tree；两侧同一文本、二进制和结构冲突都必须解决后才可 push，最终 Workspace tree 与 GitHub commit tree 的 manifest 完全一致。
- preview 后、执行前的编辑会使预览失效；冲突 finalize 临界区阻止并发写入；普通 push 开始后的新编辑保留为 `Unsynced changes`。双击按钮只产生一个 commit/run，任何路径都不执行 force push。
- 全同步在 GitHub push 后只显示 `Awaiting Overleaf pull`，用户确认前不显示 `Synced`；快速同步只有远端 revision 成功更新后才显示成功。
- Overleaf Pull 冲突分支能被导入同一冲突工作区，合并默认分支后可重试 Pull；历史改写、受保护分支和 push 结果不确定都有无数据丢失的恢复测试。
- 实验性文件上传在任一路径失败后显示已完成/未完成清单，重试幂等；没有通过真实 Overleaf smoke 时不得默认开启。

调研依据（2026-08-03）：[Overleaf GitHub synchronization](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/github-synchronization)、[Overleaf Git integration](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration)、[Git authentication tokens](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration/git-integration-authentication-tokens) 和 [overleaf-sync/olsync](https://github.com/moritzgloeckl/overleaf-sync/tree/master/olsync)。

## 实现约束

- 所有来源复制到受管理 Workspace；服务器不能访问用户电脑绝对路径。
- `.git`、`.writeagent/backups` 和构建输出不导入、不显示、不参与 Main document 检测；备份使用 Workspace 外部的 `history.git`，不复制版本文件，也不修改原论文目录。
- 所有 AI 修改必须经过 ChangeSet、Diff 和用户审批。
- Revise 的原始选区用于版本校验，`workingText` 仅表示当前未接受候选；连续追问不提前写文件。
- Review 只提 Issue：单文件直接证据进入 Revise，跨文件问题进入 Agent。
- Writing Style 只通过 Skill 提供；不新增 Prompt 管理系统或 Revise 模式。
- Writing Profile 只有 `Security Top-4` 与 `AI Top-Tier` 两类；不再保存或展示 S&P、USENIX Security、CCS、NDSS 子选项，旧项目启动时统一迁移到 `Security Top-4`。
- Paper 同步始终以受管理 Workspace 的冻结快照为 ours；内部 `history.git` 不连接远端。远端变化只有经过 `SyncConflict`/merged-tree 预览、用户确认和版本复检后才能 bulk reconcile 回 Workspace，不能静默写入或绕过文件版本控制。
- GitHub/Overleaf 凭据只保存在服务端 SecretStore，不进入项目模型、导出包、运行日志或前端持久化；全同步不能把用户手动 Overleaf Pull 误报为已自动完成。

## AI Provider 配置

全局 `.env` 配置继续适用于所有 AI 调用：

```dotenv
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1
FASTWRITE_OPENAI_MODEL=gpt-5.6
```

自动补全、跨文件 Agent（含 Draft）、Revise、Review（含 targeted re-review）和 Paper Memory 可使用不同的 OpenAI-compatible Provider。为任意一个工作流设置下列字段即可覆盖全局值，未设置的字段仍各自回退到全局配置：

```dotenv
FASTWRITE_COMPLETION_API_KEY=...
FASTWRITE_COMPLETION_BASE_URL=https://api.deepseek.com/v1
FASTWRITE_COMPLETION_MODEL=deepseek-v4-flash

FASTWRITE_AGENT_API_KEY=...
FASTWRITE_AGENT_BASE_URL=...
FASTWRITE_AGENT_MODEL=...
FASTWRITE_REVISE_API_KEY=...
FASTWRITE_REVIEW_API_KEY=...
FASTWRITE_MEMORY_API_KEY=...
```

`API_KEY`、`BASE_URL` 与 `MODEL` 均可独立覆盖。也兼容 `FASTWRITE_<WORKFLOW>_OPENAI_API_KEY`、`_OPENAI_BASE_URL` 与 `_OPENAI_MODEL` 形式。支持的 `<WORKFLOW>` 为 `COMPLETION`、`AGENT`、`REVISE`、`REVIEW`、`MEMORY`。

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

1. 按 P1.1 → P1.4 实现 Paper 全同步，先交付无冲突 GitHub push，再完成 GitHub 三方对账和 Overleaf 冲突分支回收；P1 发布门禁包含真实双人并发冲突 smoke。
2. 分别用真实安全与 AI 论文验证长文上下文、Skill 输出和失败恢复，不扩展新模式。
3. 完成两类 Writing Profile 从导入、Agent 初稿、连续 Revise 到 Review 闭环的新用户人工测试。
4. P2 再做快速同步能力 Spike 和 Overleaf Git Bridge/file upload adapter；未经验证不承诺“API key 文件覆盖”。
5. P2 开发 Tauri 生命周期、桌面文件选择、安装升级和崩溃恢复；SecretStore 在 Tauri 中切换到系统 Keychain。
