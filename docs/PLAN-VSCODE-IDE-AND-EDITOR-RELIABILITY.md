# FastWrite IDE VSCode 化与编辑可靠性改造规划

日期：2026-09-17。状态：实施中；阶段验收尚未完成。原始范围与验收门槛保持不变。

## 1. 目标与范围

将工作台改为 VSCode 式「Activity Bar 图标列 + 单一主侧栏 + 多标签编辑区 + PDF 辅助区 + 可收起底部面板 + 状态栏」。左侧固定四个主要入口：**文件、Git、证据、目录**。这里的“目录”指论文结构 Outline，磁盘文件夹归“文件”。History 收入 Git 视图，以提交列表、变更文件树和主区域 diff 替代当前弹窗。

优先解决编辑正确性，再调整工作台外观。继续使用现有 Monaco 0.55.x、React 和服务端版本校验；不迁移为另一个编辑器，也不以自制行号、textarea 拼接 diff 替代 Monaco。

“同步”拆成四条独立链路验收：编辑缓冲区与服务端保存、多人/离线协作、源码与 PDF 的 SyncTeX、GitHub 远端同步。它们必须有不同的状态和错误提示。

本规划基于当前工作区代码静态阅读，包括未提交改动；尚未通过浏览器复现用户反馈。下文明确区分代码已确认的问题与需要运行时验证的假设。实施时先保留当前工作区已有修改，再按功能提交小批次变更。

## 2. 现有代码与参考 UI 结论

### 2.1 本项目

| 位置 | 已确认现状 | 改造方向 |
| --- | --- | --- |
| `apps/web/src/pages/WorkspacePage.tsx` | 文件、Outline、claims 在同一侧栏纵向堆叠；页面同时维护导航、读取、保存回调、History 等状态 | 拆出 WorkbenchShell、导航服务和各侧栏视图 |
| `apps/web/src/components/workspace/SourceEditor.tsx` | 原生 Monaco；自动换行；13px 字体/22px 行高；组件同时负责 model、保存、离线、补全、Yjs、导航 | 保留渲染组件，将文档会话、保存及协作状态移出组件 |
| `apps/web/src/styles.css` | 全局表单 reset；直接覆盖 Monaco 内部高度和 gutter 边框；中心区最小宽 360px、编辑区最小高 250px | 样式限定作用域；以容器尺寸驱动 Monaco layout |
| `WorkspacePage.tsx` 内 `HistoryDialog` | 下拉选择 checkpoint 和当前树中的文件，`pre` 展示内容 | Git 侧栏选提交，编辑标签打开真实 diff |
| `apps/server/src/workspace/git-history.ts` | 独立 `history.git`；快照时全量 add/commit；有日志和单文件读取 | 首期复用托管历史，补 changed-files、ref tree、分页和比较接口 |
| `apps/server/src/app.ts` 的 history 摘要路由 | 返回 `paths: []`；`GitHistory.summary` 同样未实现路径摘要 | 必须补后端，不能靠当前文件树推测历史变更 |
| `apps/web/src/components/workspace/PdfPane.tsx` | 已通过 compiledVersion 与 projectVersion 匹配限制 SyncTeX | 继续保留版本门禁，并加入未保存缓冲区和编译快照检查 |
| `ChangeHunkReview.tsx`、`EditableChangeReview.tsx`、`GithubSyncDialog.tsx` | 已有 AI 审阅及同步入口 | 逐步共享比较视图；业务操作仍保留各自语义 |

### 2.2 已阅读的参考实现

| 参考代码 | 可借鉴内容 | 不直接照搬的部分 |
| --- | --- | --- |
| `references/Scribe/apps/web/src/components/Editor/EditorTabs.tsx` | 多文件标签、当前标签自动滚入可见区、中键关闭、横向滚动、文件类型图标 | 标签 UI 不能替代 model/viewState 生命周期管理 |
| `references/Scribe/apps/web/src/components/VersionHistory/VersionHistory.tsx` | 历史侧栏、版本摘要、按文件选择、恢复后局部失效缓存 | 当前 diff 是空文本对快照，会把全文显示为新增，不能作为目标 diff 实现 |
| `references/overleaf/services/web/frontend/js/features/ide-react/components/history.tsx` | 历史文件树、DiffView、ChangeList 分工，历史是工作台模式 | 不迁入其完整上下文、后端与编辑器体系 |
| `references/overleaf/services/web/frontend/stories/history/document-diff-viewer.stories.tsx` | 长文、多处增删、带来源标签的差异演示用例 | 目标由 Monaco DiffEditor 提供行映射与排版 |
| `references/HeyTeX/client/src/pages/EditorPage.tsx` | Monaco + 源码/PDF 分栏、侧栏伸缩和拖动交互 | 不继续扩大单个 EditorPage 的职责，不复制复杂坐标计算 |
| `references/mist/app/components/Editor.tsx`、`app/lib/useYjsEditor.ts` | doc/awareness/provider 分离，同步状态显式化，选区随事务映射 | Tiptap/ProseMirror 绑定不适用于 Monaco；仅借鉴职责分离 |

结论：借鉴 Scribe 标签与侧栏、Overleaf 历史工作台、HeyTeX 源码/PDF 布局、mist 协作分层，采用 VSCode 的信息架构和 Monaco 原生编辑/diff 能力。上述为源码 UI 分析，不代表完成了参考项目运行截图对比。

## 3. 目标工作台与交互

```text
┌──────────────── 项目 / 快速打开 / 编译 / 布局 / 分享 ────────────────┐
│图标列│ 主侧栏           │ main.tex × │ refs.bib × │ Diff × │ PDF     │
│ 文件 │ 文件 / Git /     ├──────────────────────────────────┤         │
│ Git  │ 证据 / 目录      │ 面包屑 / 比较基线                 │         │
│ 证据 │                 │ Monaco SourceEditor / DiffEditor │         │
│ 目录 │                 │                                  │         │
│      │                 ├──────────────────────────────────┤         │
│ 设置 │                 │ AI / Problems / 编译输出（可收起）│         │
├──────┴─────────────────┴──────────────────────────────────┴─────────┤
│ 历史/远端状态 │ 保存/协作 │ Ln, Col │ UTF-8 / LF │ LaTeX │ 编译版本 │
└────────────────────────────────────────────────────────────────────┘
```

- Activity Bar 建议宽 48px，图标约 20px，命中区域至少 40px；保持可见。悬停说明、激活指示线、可访问名称和键盘焦点齐全。再次点击当前入口折叠主侧栏；切换入口恢复该视图滚动和宽度。
- 主侧栏默认 260px，建议范围 180–420px，四个视图互斥，避免文件、证据、Outline 互相抢高度。徽标区分 Git 变更数量、证据待处理数量。
- 编辑器标签支持单击预览、双击固定、编辑后固定、关闭与中键关闭；未保存显示圆点；每文件保留光标、选区、滚动、折叠和撤销栈。同名文件以路径消歧。
- 文件入口复用 FileTree，保留延迟加载、新建、重命名、删除、主文档设定。文件树展开仅修改树状态，绝不重载编辑内容。
- 证据入口承接 claims/evidence：筛选、状态、来源、关联文件和定位；位置包含文档版本，失效时提示重新定位，不跳到未经核实的旧 offset。
- 目录入口复用 OutlineTree：当前文档与项目结构切换；点击准确定位，当前章节跟随光标但不主动抢焦点。服务端大纲标明基于已保存版本，后续可补本地增量解析。
- AI 进入可折叠底部 Panel，保留已有审阅流程；Problems/编译输出共享底部空间。PDF 保持右侧辅助区，可独立隐藏；打开 diff 时空间不足默认收起 PDF，返回源码恢复之前布局。
- 窄窗口降级顺序：收起 PDF → 收起主侧栏 → 底部面板收起/切换；Activity Bar 保留入口。禁止仅靠媒体查询把侧栏永久隐藏。
- 快捷键建议：Ctrl/Cmd+P 快速打开，Ctrl/Cmd+B 侧栏，Ctrl/Cmd+Shift+E 文件，Ctrl/Cmd+Shift+G Git，Ctrl/Cmd+S 保存。浏览器无法可靠拦截的关闭标签快捷键需有按钮替代；IME 组合输入期间不处理会影响输入的快捷键。

## 4. Git 侧栏与 VSCode diff 体验

### 4.1 首期 Git 视图

从上到下组织为：仓库/模式标题、操作栏、当前变更、历史提交、远端同步状态。

当前项目的托管 `history.git` 与 GitHub 同步不是同一个用户可操作 index。首期清晰标注“托管历史”，保留“创建检查点”措辞；Changes 表示相对选定基线的内容差异，**不虚构 Stage/Unstage/分支切换功能**。GitHub 的拉取、推送和冲突状态可复用现有对话框入口。未来真 SCM 模式要单独设计 index、分支、暂存和自动快照兼容性。

历史列表显示摘要、短 OID、时间、自动/手动来源；作者等字段有后端数据后再显示。默认最新在上，可分页、按文件过滤。点击提交展开实际变更文件，含 A/M/D/R 标记和旧路径；根提交相对空树。自动快照目前约两分钟静默后触发，必须让用户理解基线变化，不把自动历史当作手动提交。

### 4.2 比较语义

| 入口 | 左侧 original | 右侧 modified | 编辑权限 |
| --- | --- | --- | --- |
| 当前变更 | 明确 OID 的基线内容 | 当前工作缓冲区，含未保存修改 | 左只读，右可编辑 |
| 某次历史提交 | 父提交内容 | 所选提交内容 | 双侧只读 |
| 与当前比较 | 所选历史提交 | 当前工作缓冲区 | 左只读，右可编辑 |
| 两次提交比较 | 用户选定旧提交 | 用户选定新提交 | 双侧只读 |
| AI 修改预览（后续接入） | 提案绑定的 baseVersion | 提案内容 | 按现有审阅权限，接受前验证版本 |

使用 `monaco.editor.createDiffEditor`：宽屏并排、窄屏 inline，可切换；独立行号、行内增删、折叠未变更区域、上一个/下一个差异、差异概览、复制与选区。滚动映射交给 Monaco，不自行按 scrollTop 比例同步。

右侧可编辑时直接复用工作文件 model，保存走同一 DocumentSession；immutable 历史 model 用独立 URI，包含 projectId/OID/path/side，避免污染源码撤销栈。diff 关闭仅释放自身引用，不能 dispose 仍被源码标签使用的 model。

新增/删除用“文件不存在”的元数据区分空文件；重命名显示 oldPath → path；二进制文件显示元信息/图片预览，不灌入文本编辑器。加载、读取失败、权限错误与确实不存在分别显示。

恢复从 diff 操作栏发起，先展示目标与影响；存在本地脏内容时可保存检查点、另存副本或取消。服务端带 expectedVersion 做原子版本校验，过期进入冲突比较；成功生成新历史提交。首期整文件恢复，hunk 恢复后置，避免未定义补丁上下文时覆盖新内容。历史已删除文件的恢复需支持重新创建，不能要求当前文件必须存在。

### 4.3 后端增量能力（拟议，不是现有接口）

- 扩展 history list：cursor 分页、parentOids、来源；不能继续只在最近 200 条中认定 OID 是否有效。仓库授权与可达性校验由服务端统一完成。
- 实现 history summary/changed-files：返回 path、oldPath、A/M/D/R、binary、必要的增删统计；从 Git 对应提交计算。现有路由的 `paths: []` 与服务层占位一并修复。
- 提供历史 tree 与 ref 文件读取：支持当前树中已删除或尚未加载的路径；明确 404 文件缺失与其他失败。
- 比较请求统一 baseRef/targetRef/path；响应固定两端身份、存在性、内容/二进制元数据。工作缓冲区留在客户端；与服务端工作树比较时带 projectVersion，避免把不同时刻的数据拼接。
- 保留现有 checkpoint/historyFile/restore API 的兼容性，新增字段在 `packages/shared/src/models.ts` 与 `apps/web/src/api/client.ts` 对齐；权限复用项目权限体系。
- 读取历史不修改 index；写快照继续串行。路径按仓库相对路径校验，Git 调用用参数数组和路径分隔符，不拼接 shell；列表使用 NUL 分隔解析，覆盖空格、中文和特殊字符文件名。

## 5. 编辑区问题：证据、修复与验证

### 5.1 已确认的高风险数据流

| 优先级 | 源码证据与触发条件 | 修复要求 |
| --- | --- | --- |
| P0 | SourceEditor 的 document effect：同路径内容不同即 `model.setValue(document.content)`；保存 A 在途时输入 B，A 返回后 onSaved 回写 props，可能用 A 覆盖 B | 保存 ACK 只推进对应 revision 的基线；禁止把自己的旧 ACK 当作外部全文更新 |
| P0 | WorkspacePage 文件读取 effect 依赖 `tree`；onSaved 调 refreshWorkspace 更新 tree，展开目录也 commitTree | 内容读取由文档身份/显式失效触发；树元数据与内容缓存分离；读取结果受 request generation 保护 |
| P0 | selectNode 直接切路径，切换 model 时 dispose；850ms 保存 timer 在切 model 分支没有明确的逐文件交接 | 文档会话独立于可见 editor，待保存内容在切换后继续可靠保存；缓存脏 model，关闭前等待保存或保留本地草稿 |
| P0 | save 每次 abort 前请求；update 提前捕获 baseVersion；AbortError 即返回 | 每文件单飞保存队列，后续修改合并；发出请求时取最新 ACK 版本。取消网络等待不代表服务端未写入；flush 不得把取消当成功 |
| P0 | save 返回便标 saved、清离线草稿，未比较期间是否有更新；onSaved 的刷新异常也进入 save catch | saved 由已确认 revision 与当前 revision 相等推导；草稿按 revision 清理；保存成功与元数据刷新失败分开 |
| P0 | 开启协作但 ready 前仍走保存回退；IndexedDB/握手内容随后回填 model；协作 flush 经 HTTP，与 WS 更新没有显式 ACK barrier | 协作初始化和重连期间保留输入，不并行使用两个内容权威；flush 等待对应更新被服务端确认并持久化 |
| P1 | navigateToPath 用固定 120ms 触发 targetLine；targetSelection effect 随版本/内容重跑 | 用一次性导航 requestId，等待正确 model ready 后执行并消费，重复点击同一行也有效 |
| P1 | model 切换销毁且滚动归零；projectId 改变但同 path 时当前 pathChanged 判断不足 | 文档身份为 projectId + 规范化 path；缓存 viewState/model；跨项目隔离资源与异步回调 |

上述问题可以从代码确认存在触发路径，但用户当前行号/点击偏移的具体主因还需要运行时复现，不能全部归因于 CSS 或 Monaco。

### 5.2 行号、点击命中与布局诊断

1. 建立固定样本文档：至少 1,000 行，跨 9/10、99/100 行位数，包含长行软换行、中文、emoji、Tab、空行、CRLF；测试开始/中段/末尾。
2. 对照 Monaco `getLayoutInfo()`、`getScrolledVisiblePosition()`、`getTargetAtClientPoint()` 与实际 DOM rect。以字符中心点击断言 position；软换行仍属于同一逻辑行，不给视觉折行另编源码行号。
3. 检查全局 `font: inherit`、focus shadow、box-sizing 与 Monaco 输入层；审计 `.monaco-editor-host .overflow-guard` 高度覆盖及 gutter border。只修已验证污染，禁止通过累加 margin/padding 抵消坐标偏差。
4. 容器链明确 `min-width: 0; min-height: 0`、flex/grid 收缩和溢出策略；消除多面板最小尺寸总和超过窗口的情况。验证分隔条伪元素是否覆盖 gutter/首字符命中区。
5. 字体加载完成调用 `monaco.editor.remeasureFonts()`；主题、缩放、侧栏/PDF/底部面板切换后核验 layout。以 automaticLayout 为基础，必要时补 ResizeObserver + requestAnimationFrame，不创建互相竞争的多套尺寸监听。
6. 原生 Monaco 行号由 `lineNumbers`、`lineNumbersMinChars` 等选项管理；后续启用 glyphMargin 展示变更/诊断时分配明确宽度，不混用行号与图标。
7. 测试浏览器 80/100/125/150% 缩放、不同 DPR、连续拖动、侧栏快速收放、隐藏后恢复、中文 IME。补全文字和远端标签也纳入点击测试，避免 injected text 改变命中行为。

### 5.3 DocumentSession 与保存协议

建议会话字段：`key(projectId,path)`、`model`、`viewState`、`localRevision`、`ackedRevision`、`serverVersion`、`baseContent`、`inFlight`、`pendingSnapshot`、`syncMode`、`error`。UI 中 dirty 表示尚有未确认本地修改，与 Git 相对提交的 modified 不混淆。

本地编辑 → revision 增加 → 排入 debounce → 单飞提交快照(revision/content/baseVersion) → ACK 更新 serverVersion/baseContent → 若仍有更新则继续提交。ACK 不替换当前 model。失败保留最新文本和草稿，409 展示 base/ours/theirs，不要求用户“重新打开”丢掉草稿。

`flush()` 捕获调用时 revision，直到该 revision 或更高 revision 获得持久化确认才 resolve；失败 reject 并由编译/切换/检查点等调用者展示错误。持续编辑时避免无限等待“永远最新”；编译消费一个明确版本的快照。

外部更新只在 clean 时增量应用；dirty 时做合并/冲突处理。需要更新内容时区分来源和撤销语义，不用 setValue 重建日常编辑状态。异步请求都绑定会话身份和 generation，迟到结果不能写入另一项目或文件。

离线草稿恢复只在首次打开且尚无新输入时自动应用；否则先比较或合并。baseVersion 不匹配也要保留并提供恢复入口，不能静默忽略。脏会话不可被 LRU 淘汰；干净、无人引用的 model 可限额释放。

### 5.4 协作、编译和 PDF 同步

- 抽出 CollaborationProvider：初始化、IndexedDB ready、WS synced、pending updates、持久化 ACK、重连分别建模。协作模式以 Y.Text 为内容权威；REST 模式以 DocumentSession 为权威，模式切换需完成交接。
- 评估成熟 Monaco/Yjs binding 与现有手工绑定的适配；无论选择何者，都需覆盖本地增量、远端 delta、相对选区、撤销来源和反馈回路。当前前后缀裁剪后的单次替换不能作为全部协作语义的保证。
- 协作状态至少区分“已缓存本机”“已同步到服务端”“已持久化到文件”。连接 open 或收到 sync 消息不能直接等同于已保存。
- 编译前 flush 所需文档/协作更新，取得明确 projectVersion，再读取一致源码快照；旧编译请求完成时不能覆盖较新结果。编译日志、PDF、SyncTeX 同属于同一快照身份。
- 保留现有 activeSyncTex 的版本检查，并考虑未保存编辑：buffer dirty 时提示 PDF 过期，提供保存并编译；不能仅因服务端 projectVersion 尚未变化便允许旧映射误跳。
- PDF → 源码通过统一导航服务等待目标 model；源码 → PDF 使用该编译版本的文件路径与逻辑行。缩放、旋转、页坐标换算单独测试，不与编辑器滚动互相联动。

## 6. 建议代码拆分

以下均为拟新增模块名，可随实现调整；不以机械拆文件代替职责收敛。

```text
components/workbench/
  WorkbenchShell.tsx       ActivityBar.tsx       PrimarySidebar.tsx
  EditorTabs.tsx           EditorArea.tsx        WorkbenchStatusBar.tsx
  SourceControlView.tsx    EvidenceView.tsx      OutlineView.tsx
  HistoryList.tsx          ChangedFilesTree.tsx WorkspaceDiffEditor.tsx
lib/editor/
  documentSession.ts      documentRegistry.ts   saveQueue.ts
  navigationController.ts collaborationProvider.ts
```

`SourceEditor.tsx` 保留 Monaco 创建、绑定 model、命令和 decorations；`WorkspacePage.tsx` 负责项目级组装，不再成为每次击键后的数据回流中心。布局状态（侧栏宽度/面板）、文档状态（revision/model）、服务器状态（树/历史/项目版本）分开存储。沿用现有依赖，是否增加状态库由实施需求决定。

## 7. 分阶段交付与依赖

| 阶段 | 工作与主要涉及文件 | 完成门槛 |
| --- | --- | --- |
| P0-A：复现与止损 | SourceEditor、WorkspacePage：旧 ACK 覆盖、tree 重读、跨文件 timer、保存队列；增加有针对性的回归 | 延迟/乱序保存与切文件不丢字，失败不假报成功 |
| P0-B：会话与同步 | documentRegistry/saveQueue/provider、offlineDrafts、协作服务；统一 flush 与导航 | 多标签保留内容/撤销/位置，离线重连与协作持久化通过 |
| P1-A：编辑布局 | styles、SourceEditor、WorkbenchShell、PanelDivider | 行号与点击坐标、IME、缩放/拖动通过浏览器矩阵 |
| P1-B：工作台外壳 | Activity Bar、四侧栏、标签、状态栏、底部 Panel/PDF 布局 | 四入口可键盘操作，布局恢复，窄屏入口不丢失 |
| P2-A：历史 API | git-history、workspace-service、app 路由、shared models/client | 提交真实 changed-files、历史 tree、分页、删除/重命名及冲突恢复 |
| P2-B：Git/diff | SourceControlView、HistoryList、WorkspaceDiffEditor | 三类比较（历史/当前/两提交）正确，恢复有版本保护 |
| P3：统一与收尾 | AI/GitHub 比较接入、性能/无障碍、清理旧 HistoryDialog | 全套回归通过，无重复保存链路，无 model/provider 泄漏 |

依赖：P0-A → P0-B；P1-A 与 P1-B 基于会话边界实施；P2-A 可独立于外壳准备，P2-B 必须等待会话与 API 稳定；P3 最后。每阶段独立可回滚，优先交付可靠编辑，再交付外观。切换新旧外壳也必须共用同一保存实现，避免维护两种数据正确性。

## 8. 验收矩阵与测试策略

| 场景 | 操作 | 必须满足 |
| --- | --- | --- |
| 保存过程中继续输入 | 人为延迟响应 2 秒，A 保存时继续输入 B | model 最终为 A+B；旧 ACK 不清除 dirty；服务端最终与 buffer 一致 |
| 切文件 | 输入后不足 850ms 切 A→B→A；保存中连续切换 | 内容、光标、滚动、撤销保留；无串文件写入 |
| 树与元数据 | 输入中展开目录、刷新项目、更新 Outline | 无内容重置，无光标跳跃；不额外 GET 当前文件内容 |
| 离线恢复 | 断网编辑、重新打开、重连时继续输入 | 草稿可恢复；新输入不被晚到草稿覆盖；旧版本进入比较 |
| 协作 | 两浏览器同文件交错输入/删除，断连再连接 | 双端收敛；不重复内容；本地 undo 不撤销对方操作 |
| 保存持久化 | WS 更新与 HTTP flush 人为交错 | flush 只在目标 revision 持久化后成功；编译读到该快照 |
| 点击与行号 | 多种缩放/DPR、长行软换行、100/1000 行 | 点击字符中心得到预期 line/column；逻辑行号正确，不遮挡 |
| IME 与补全 | 中文组合输入期间保存/远端更新/显示补全 | 不截断组合文本、不错误触发命令、不意外移动光标 |
| 导航 | 连点相同行；慢速跨文件；证据与 PDF 定位 | 按 requestId 仅执行正确请求，无 120ms 假设、无焦点反复抢占 |
| diff 正确性 | A/M/D/R、空文件、首提交、中文路径、二进制 | 两端基线可见且正确，新增/删除不误当空文件读取成功 |
| diff 与编辑共享 | 在可编辑 diff 输入，切源码，保存，再切回来 | 同一个工作 model 与撤销栈；历史只读；关闭 diff 不销毁源码 |
| 恢复冲突 | 本地脏文本或服务端版本变化后恢复 | 无静默覆盖；409 保留本地数据；成功创建新历史提交 |
| SyncTeX | dirty buffer、过期 PDF、缩放及多文件 include | 过期映射被阻止；新快照双向定位正确 |
| 资源生命周期 | 连续打开/关闭 source/diff 50 次、切项目 | 无重复 URI/监听，关闭项目后关联 model/provider 释放 |

测试分层：保存队列/导航 generation/草稿决策用确定性单元测试；history/ref/restore/协作 ACK 用服务端集成测试；Monaco 行号、点击、IME 和双浏览器协作用真实浏览器测试，不能用 jsdom 或截图替代命中验证。

使用现有 `bun run typecheck`、`bun test`、`bun run build`；扩展 `scripts/e2e-smoke.sh` 和 `scripts/e2e-cross-browser.sh` 或加入专用编辑器回归脚本。截图用于外观对比，文本、光标位置、服务端内容与版本必须有实际断言。当前文档阶段不宣称这些测试已通过。

性能建议验收样本：1MB/10,000 行文本、20 个标签、长历史分页。记录输入到绘制、切标签、diff 首次可用时间和内存基线；目标本地已缓存标签切换 p95 <100ms（约定测试机），大文件 diff 不阻塞主编辑输入。具体阈值在 P0 建立基线后固定。

## 9. 首个实施批次

1. 增加“旧保存响应不能覆盖新输入”“tree 刷新不重载 buffer”“850ms 内切文件不丢数据”三个确定性回归场景。
2. 落地最小 DocumentSession 和逐文件 saveQueue，移除 onSaved → document 全文回填与 tree → readFile 的耦合。
3. 在真实浏览器复现行号/点击偏移，记录计算尺寸与命中位置，再修 CSS/布局；不要先靠调字号掩盖问题。
4. 上述门槛通过后接 Activity Bar 与 Git/diff。最终交付应同时包含可靠编辑、四入口侧栏、真实历史变更和可验证的比较恢复流程。

## 10. 实施记录

### 2026-09-17：P0 保存会话基础

- 已新增 `apps/web/src/lib/editor/documentSession.ts`：独立于可见编辑器的逐文档单飞保存、revision ACK、发送时读取最新 serverVersion、捕获调用 revision 的 flush、失败保留缓冲区并支持显式重试。
- 新增确定性测试验证旧 ACK 不覆盖新输入、后续保存使用 ACK 版本、失败不假报成功，以及两个文档的 debounce 互不取消。`bun test apps/web/src/lib/editor/documentSession.test.ts`：3 项通过、14 个断言。
- **尚未接入 SourceEditor**，因此上述测试仅证明会话模块协议，不能证明页面保存缺陷已修复。下一步将会话与 Monaco model registry 接入，拆除旧保存实现，解除 tree 与内容读取耦合，再运行实际编辑器回归。
- P0-A/P0-B、P1、P2、P3 及浏览器验收矩阵均仍未完成；不以模块单元测试代替端到端验收。

### 2026-09-17：接入保存会话与导航

- REST 编辑已接入 `DocumentSession`，删除 SourceEditor 原有 abort/save timer 链路。文本文件切换缓存 model/viewState；未显示文件的队列继续保存，flush 等待当前组件持有的所有会话。自己的 ACK 不再经 WorkspacePage 回写正文；元数据刷新失败不撤销保存成功。
- WorkspacePage 的正文读取不再依赖 tree；已取消读取的迟到结果会被丢弃。外部版本更新仅在 clean 会话接受；dirty 会话保留本地内容并报错。
- 草稿写入按会话串行，旧 ACK 的清理不会越过后续草稿写入；IndexedDB 操作等待 transaction complete。首次草稿读取用 revision 防止覆盖新输入。旧版本草稿仍保留，但比较/恢复 UI 尚待接入。
- 新增 `navigationController.ts`：最新请求优先，手动选文件取消旧导航，重复同一位置有新 requestId；SourceEditor 在目标 project/path 的 model ready 后消费一次。移除了 120ms 延时，搜索和 Outline/PDF 使用统一入口。选区定位增加一次性消费和版本验证；证据/评论全部定位语义仍需后续统一。
- 新增 `scripts/e2e-editor-reliability.mjs`（`bun run e2e:editor`），通过 `FASTWRITE_E2E_URL` 指定已运行的独立测试服务（默认 `http://127.0.0.1:3217`），默认使用本机 Chrome，可用 `FASTWRITE_E2E_CHANNEL` 指定。脚本创建测试项目，不应对生产服务执行。新增 Playwright 测试依赖。
- Chrome 实际断言：保存响应延迟 2 秒期间输入 B、model 可见文本与服务端一致；展开目录和保存刷新不 GET 正文；850ms 内切 A→B→A 后保存及 undo 保留；无串文件写入；网络保存失败保留可见文本且显式重试成功。最终连续两次通过。过程中曾出现一次无堆栈的 `Canceled` 页面异常，开启堆栈记录后暂未重现；生命周期压力验收不能据此宣称通过。
- 验证：编辑/导航单元测试 7 项、29 个断言通过；`bun run typecheck`、`bun run build` 通过；`bun run test` 186 项、1701 个断言通过。原有 test 脚本的路径没有 `./`，Bun 将其当作名称过滤并匹配 references，现改为明确目录。裸 `bun test` 仍会扫描第三方参考项目，不能用它的失败推断本项目测试失败。
- **剩余范围不变**：registry 尚需从渲染组件抽出以跨 source/diff/标签共享引用，图片视图切换及项目退出的资源策略需完善；协作 provider/持久化 ACK、冲突三方比较、离线恢复入口、编译一致快照与 dirty SyncTeX 门禁、四入口外壳、历史 API/diff/恢复、布局命中矩阵与性能/泄漏验收仍未完成。当前不能标记 P0-B 或整份规划完成。

### 2026-09-17：历史后端、恢复门禁与编译快照

- `GitHistory` 和 history summary 路由的 `paths: []` 占位已移除。真实 Git diff-tree 提供 A/M/D/R/T、旧路径、二进制标记和增删统计；根提交按空树处理，比较支持明确的 `empty` 基线。NUL 分隔解析保留中文、空格、方括号和冒号等路径字符；pathspec 使用 literal 模式。
- 新增 `history-page`、`history-compare`、`history/:oid/tree`、`history/:oid/side`，shared 类型与客户端对齐，原 history/list/file/restore 接口保留。分页 cursor 固定 HEAD、偏移和文件过滤条件，新快照不会改变已开始的分页序列。OID 通过 commit 解析及 HEAD 可达性校验，不再限于最近 200 条；测试包含 202 次提交及不可达对象拒绝。
- 历史 side 明确区分不存在、空文本和二进制元信息；旧 file 接口不存在返回 404，二进制返回 415。summary/tree/side/compare 的路径权限检查覆盖删除文件和重命名前路径。只读历史操作不修改 Git index，已用前后字节断言验证。
- 新增逐项目 `ProjectQueue`：文件写入、重命名/删除、同步应用、历史快照、恢复、版本化读取和编译源码复制共用队列。重入仅限当前有效作用域；背景历史计时器强制排队。并发相同 baseVersion 的保存只有一个成功。
- restore 新增可选 expectedVersion（旧客户端兼容）；新客户端恢复带预览时的版本，脏缓冲区暂禁恢复并提示保存检查点/取消。服务端在队列内校验版本、预读所有历史源，支持重建当前已删除文件；成功恢复始终生成新提交，包括同内容恢复。真正的 diff 恢复工具栏、另存副本与三方冲突 UI 尚未完成。
- 编译服务通过 `copySnapshot` 获取同一时刻的源码副本、mainDocument 和 projectVersion，响应增加 snapshotId。PDF 前端编译前等待编辑器 flush，采用服务端返回版本关联结果、日志记录与 SyncTeX，并阻止迟到请求错误覆盖较新状态。dirty 缓冲区禁用旧映射，显示“Save and compile”。协作持久化 ACK 和跨 SourceEditor 卸载的 registry 尚未完成，不能把此处 REST 验证推广到全部协作场景。
- 新增 `e2e:compile-snapshot`（默认独立服务 `http://127.0.0.1:3218`，可设 FASTWRITE_E2E_URL）：真实 Chrome/本机 LaTeX 断言初始映射可用、输入后立即禁用、保存 ACK 被扣留时不发编译请求、响应 snapshotId/projectVersion 正确、新 PDF 映射恢复可用。
- 已捕获并定位前述 `Canceled`：Monaco 0.55.1 wordHighlighter 对 Delayer.trigger 的 Promise 缺少取消处理。通过 `patches/monaco-editor@0.55.1.patch` 与 Bun patchedDependencies 修复三处调用，使用 Monaco 自身 onUnexpectedError 忽略取消、继续上报真实错误；不关闭单词高亮、不使用全局吞异常处理器。补丁后编辑器 Chrome 回归通过，新增 50 次快速源码切换无页面异常断言。
- **P2-A 仍有剩余项**：当前工作树比较的 projectVersion 响应契约、Git/diff 前端接入及恢复完整交互；P0-B 协作和 registry、P1 工作台与布局矩阵、P2-B/P3 的范围不变。50 次源码切换不代表 source/diff/provider 泄漏矩阵已验收。
- 本批最终验证：`bun run test` 195 项、1771 个断言通过；`bun run typecheck`、`bun run build`、`git diff --check` 通过。Chrome 编辑可靠性（含 50 次切换）和编译快照两套脚本通过；尚未执行完整跨浏览器/缩放/IME/双浏览器协作矩阵。

### 2026-09-17：四入口工作台与历史 diff 接入

- 阅读 Overleaf history 的文件树/DiffView/ChangeList 分工以及 HeyTeX EditorPage 入口，与前述 Scribe 标签交互对照后接入组件。新增 `ActivityBar`、`SourceControlView`、`WorkspaceDiffEditor`、`EditorTabs`、`QuickOpenDialog`；Monaco worker/语言/主题配置抽到 `lib/editor/monaco.ts` 共享。
- Activity Bar 固定 48px，文件/Git/证据/目录四入口互斥，有可访问名称、激活状态、焦点和命中区域；重复点击折叠侧栏。视图保持挂载以保留滚动，宽度按视图在会话内保留。去掉媒体查询永久隐藏侧栏/PDF，改为窄屏状态降级，入口可重新打开。
- 源码标签支持单击预览替换、双击固定、编辑后固定、未保存圆点、同名路径消歧、中键/按钮关闭，以及键盘左右/Home/End。关闭前 flush，失败保留标签及本地文本；等待保存期间按最新标签状态关闭，避免旧闭包抹掉新打开标签。当前缓存仍在 SourceEditor 内，不能据此宣称 registry/LRU/provider 生命周期已完成。
- Ctrl/Cmd+B、Shift+E/G、P 已接入；快速打开读取完整文件树并按路径筛选，支持键盘定位和输入法组合保护。底部 AI 面板可以收起，保持其状态；加入保存、Ln/Col、UTF-8、项目/PDF 版本状态栏。Problems/编译输出切换尚未迁入底部面板；完整布局持久化/恢复仍待收尾。
- Git 侧栏消费真实分页历史和 changed-files，显示托管历史语义、手动/自动来源、OID/时间、路径筛选、A/M/D/R/T 和重命名前路径，保留 GitHub sync 入口；创建检查点先 flush。
- 点击历史变更文件在主区域使用原生 Monaco DiffEditor，比对父提交与所选提交（根提交为空树）。支持自动并排/inline、手动切换、折叠未变更区、前后差异、两端身份/不存在标识及二进制元信息。不可变历史 model 使用独立 URI，关闭时只释放自己的 model；源码视图保持挂载，返回后使用原 model。
- 恢复入口已迁至 diff 工具栏，显示文件/提交/影响，支持取消和“保存检查点后恢复”；携带预览时 expectedVersion，409 保持比较打开且不改服务端文本。成功后刷新目标文件并返回源码。旧 HistoryDialog 及纯 pre 历史预览已删除；另存副本和 409 三方比较尚待完成。
- 新增 `e2e:workbench`（与其他脚本相同，通过 FASTWRITE_E2E_URL 指向独立测试服务）：真实 Chrome 断言预览/固定/中键关闭、快速打开、AI 面板收放、四侧栏互斥、真实历史 diff/inline、恢复过期拒绝、保存检查点后恢复、源码保留、快捷键及 640px 窄屏入口。此脚本与保存可靠性（含 50 次源码切换）、编译快照脚本在最新构建上均通过。
- 最终验证：`bun run test` 196 项、1775 个断言通过；`bun run typecheck`、`bun run build` 通过。当前仍不满足全部规划：需要 project-owned registry 与可编辑 current-buffer diff、两提交选择、多 diff 标签、协作 provider/ACK、离线与冲突比较完整 UI、证据/Outline 完整语义、底部 Problems/编译输出、行号/点击/IME/缩放/DPR 矩阵、source/diff/provider 泄漏与性能验收，以及 AI/GitHub 比较复用。

### 2026-09-17：项目级共享 model 与可编辑工作缓冲区 diff

- 新增 `DocumentRegistry`，由项目持有 Monaco model、DocumentSession、viewState、草稿写入与引用计数。REST 保存直接订阅 model，不再依赖 SourceEditor 挂载；源码和工作缓冲区 diff 共享同一 model、保存队列与撤销栈。图片切换、关闭源码标签后仍可保存 diff 编辑。
- registry 按规范化 project/path 隔离，缓存命中不重复 GET 正文；保留打开标签及 dirty/saving/pending-draft model，只淘汰无引用的干净缓存。项目退出等待保存与本地草稿落盘，StrictMode 重放或退出期间重新进入项目会保留资源；并发 close 合并，订阅仅在最终释放时清理。完整泄漏矩阵仍待验证。
- Git 增加打开文件与最新/指定检查点比较入口。历史 original 使用独立只读 model，working modified 租用 registry model，显示尚未保存的文字；关闭 diff 只释放租约。协作模式目前明确只读预览，待项目级 provider/持久化 ACK 实现后开放编辑，不能将 REST 成果视为协作验收。
- Monaco 补丁增加 DiffEditor 布局更新时的 aria-label 回退，避免仅更新布局选项后可访问名称消失；保留此前 wordHighlighter 取消处理。
- 新增 `e2e:shared-buffer`：Chrome 验证扣留保存时 diff 包含未保存文字、source/modified 精确 model ID 相等、SourceEditor 实际卸载后 diff 保存、重开源码 undo/redo、debounce 内切图片不丢保存和撤销栈，无页面异常。增强脚本在生产构建与开发 StrictMode 均通过。
- 本批基础验证：`bun run test` 196 项、1775 个断言通过；typecheck/build 与 diff 检查通过；生产 workbench、editor reliability、compile snapshot、shared buffer 四套脚本通过。最后的 close 交接修正后，typecheck 与 StrictMode shared-buffer 再次通过。
- 尚未完成：协作 provider 与 ACK barrier、离线冲突草稿的持久保留/恢复 UI、REST 三方冲突、完整当前变更与版本化工作树比较、两提交选择与多 diff 标签、证据/Outline 版本定位、Problems/编译输出与布局持久化、AI/GitHub 比较复用，以及点击/IME/缩放/DPR、双端协作、性能与资源泄漏全部门槛。整份规划继续实施中。

### 2026-09-17：协作显式保存的持久化屏障

- 新增 `collaboration/persist` API 与 shared 请求/响应类型。客户端在 flush 调用时捕获完整 Yjs update（包含删除信息）和 documentId；服务端按项目串行合并到当前 CRDT，持久化 update 并写入工作文件后返回 fileVersion、内容与合并状态。HTTP 不再依赖尚未确认到达的 WS 更新，重复投递按 CRDT 语义幂等。
- 文档身份不匹配返回 409；缺少依赖的部分 CRDT update 返回 409；不可解码更新返回 400；路径写权限与现有项目 ACL 一致。失败不返回持久化成功。
- SourceEditor 的协作显式 flush 已使用该 API，初始化未完成时拒绝保存/编译，旧 ACK 不替换 model；响应期间输入仍保持 dirty。重连发现服务端文档被替换时进入冲突提示。旧无屏障 flush API 暂保留兼容，但当前显式保存调用已移除。
- 新增 `e2e:collaboration-barrier`，在独立 3221 服务用真实 Chrome/认证账号拦截 WS 更新与 HTTP 响应：WS 未送达时 flush 确认文件包含目标文字、旧 ACK 不清除后续输入、第二次 flush 保存新文字、延迟 WS 重复投递不重复文本，全部通过且无页面异常。
- 服务端集成测试覆盖双客户端未投递修改合并、删除、重复投递、错误身份、缺依赖/无效 update、受限路径拒绝；重启回归验证 CRDT 与文件内容一致。全套测试 197 项、1790 个断言通过；随后增强重启测试单独通过（6 个断言）。typecheck/build 与 diff 检查通过。
- 此批仅证明显式保存屏障，不代表 P0-B 完成：协作仍由 SourceEditor 持有，初始化前输入、IndexedDB 权威交接、跨文件/图片/diff 的 provider 生命周期、自动保存状态、远端相对选区与完整本地 undo、双浏览器离线收敛尚需改造验证。协作 diff 只读限制继续保留，不能视为最终交付。

### 2026-09-17：项目级协作 provider、共享 diff 与双端回归

- 对照 mist 的 doc/awareness/provider 分层及上游 `yjs/y-monaco/src/y-monaco.js` 的选区保存与 delta 绑定方式，新增 `lib/editor/collaborationProvider.ts`。provider 由 registry entry 持有，管理 Y.Doc、按 documentId 隔离的 IndexedDB、WS 重连、awareness、Y.UndoManager 与持久化屏障；可见 source/diff editor 仅挂接选区与命令。移除 SourceEditor 内 WS/IndexedDB 生命周期、全文 `saveCollaborative` 回退和重复的正文保存回调。
- 初始化前 model 输入经同一草稿队列保留，等待 CRDT ready 后，仅在原始基线匹配时增量合并；若本地与服务端同时改变，保留本地文本并报冲突，不用迟到握手覆盖。发现协作版本落后于工作文件或文档身份被替换时拒绝继续覆盖。完整冲突比较/恢复 UI、REST 与协作来回切换的服务端交接仍未验收。
- 本地 model changes 按 offset 逆序写入 Y.Text；远端 delta 增量应用到同一 model。初次实现的相对选区在内部事务中被重置，真实浏览器复现后改为 beforeAllTransactions 捕获、文本观察器应用后恢复；现已验证远端文首插入后光标仍绑定原文字。source/diff 的 undo/redo 均使用仅跟踪本地 origin 的 Y.UndoManager。
- 协作保存使用 DocumentSession 单飞队列与前批持久化屏障；另跟踪 CRDT revision，覆盖文本相同但结构/删除信息改变的情况。provider 保存串行，ACK 只确认其捕获状态。registry 的 aggregate dirty、关闭等待及 LRU 也计入未确认 CRDT 更新。状态区分初始化、连接、本地待持久化、离线与文件已持久化。
- 移除协作 working diff 的临时只读限制。源码关闭或切换图片后，同一 provider/model 继续接收远端变化和保存，独立 diff 可编辑、广播、持久化及本地 undo。历史 original 仍只读。
- 断网回归发现 HTTP 在 WS 重连前持久化后，握手可能不再重发该状态，导致其他在线客户端漏更新。服务端现会将成功 HTTP 协作保存结果广播给重新授权通过的在线房间成员；已验证离线/在线双方编辑合并并对端可见。同时修复 awareness 的标准 length-prefixed 编解码，使用服务端可信身份显示协作者。
- 新增 `e2e:collaboration-provider`：两个真实 Chrome context 验证握手前输入不走 REST、双端收敛、相对光标、远端替换 delta、本地 undo 不撤销对方、redo、源码卸载后保存/接收远端修改、共享 model 身份、独立可编辑协作 diff、断网重连合并与 awareness。生产构建全部通过；测试中未出现 REST 全文保存请求或页面异常。
- 本批测试：`bun run test` 197 项、1793 个断言通过，typecheck/build 通过；生产 Chrome 的 provider、持久化屏障、REST shared-buffer、编辑可靠性（含 50 次切换）、compile-snapshot 均通过。开发 StrictMode 回归另发现 Vite API 代理未启用 WS，已补 `ws: true`，完整双浏览器 provider 脚本在开发 StrictMode 下也已通过。
- 尚不能标记 P0-B 或整份规划完成：需要离线重开与冲突草稿恢复 UI、完整模式交接、IME 与多选区/撤销边界、source/diff/provider 泄漏矩阵，以及其他阶段既定的 Git 当前变更/两提交/多 diff、Evidence/Outline、底部面板与布局、AI/GitHub 复用、缩放/DPR/命中和性能验收。

### 2026-09-17：持久恢复副本与 REST 三方冲突处理

- `offlineDrafts` 升级为 IndexedDB v2，保留原活动草稿 store，增加按文档索引的独立 recoveries store。草稿存储 baseContent/baseVersion；旧数据缺少 baseContent 时明确显示基线文本不可用，不伪造比较基线。事务 complete 才认定本地写入成功。
- registry 在首次草稿读取与恢复归档完成前，阻止新的草稿写入/ACK 清理越过它。旧草稿先持久归档；只有 REST、基线版本相同且读取期间无新 revision 时自动应用，否则仅保留比较入口。恢复副本不会被后续 ACK、活动草稿更新或重开页面清掉；显式删除恢复副本与工作缓冲区分离。已持久归档的干净 model 可 LRU 释放，仍在读取/dirty 的 model 不可淘汰。
- 新增 `DocumentRecoveryDialog` 和可复用的原生 Monaco `TextModelComparison`：Base vs local、Server vs local、Server vs editable result，显示基线/本地/服务端身份；支持切换并排/inline、前后差异、使用本地/服务端文本、手动编辑结果、带版本保护地应用并保存、另存新文件、下载及显式删除保存副本。未应用的手工结果在关闭/切换副本前另存本地恢复记录。
- `DocumentSession.resolveConflict` 仅接受用户已审阅的基线，验证本地 expectedRevision、无在途保存及服务端版本不倒退；新结果仍 dirty，条件保存 ACK 后才清除。应用前归档原 buffer，用 Monaco undoable edit 更新 model，409 保留结果和原稿，不静默覆盖新服务端文字。比较加载失败不再用空服务端内容假装成功。
- 真实浏览器发现父组件释放 model 早于 DiffEditor cleanup 的异常；共享比较组件在 setModel 前注册 model disposal 解绑，关闭/切换和 StrictMode 回归现无该异常。Ctrl/Cmd+S 在恢复窗口调用其保存命令，不保存底层源码；组合输入不触发全局保存或 Dialog Escape/Tab 处理。
- 新增 `e2e:document-recovery`：Chrome 验证三方引用、Ctrl+S 合并保存、比较后服务端再次变化时拒绝覆盖、另存恢复副本、延迟 IndexedDB 读取不覆盖新输入、旧版本草稿跨 ACK/刷新保留，以及实际断网输入落盘、重开恢复和重试保存。生产构建和开发 StrictMode 两套均通过。
- 本批验证：`bun run test` 199 项、1807 个断言；typecheck/build、diff 检查通过；最新构建的双浏览器 collaboration-provider 和 REST shared-buffer 回归也通过。
- 仍有明确边界：协作发生初始化/代际冲突时此窗口已可比较、保留和另存，但原协作文档的直接合并按钮尚未开放；完整 REST/CRDT 模式交接仍待实现。当前离线重开测试在网络恢复后加载工作区元数据，尚未证明完全断网重载工作区；PWA shell/项目元数据离线入口、遗失/删除路径的全项目恢复入口及完整资源矩阵仍待验收。其余 Git、多 diff、Evidence/Outline、底部面板与布局、AI/GitHub、命中/IME/缩放/DPR 和性能范围保持不变，整份规划仍未完成。

### 2026-09-18：两提交选择与多比较标签

- 新增 `history-changes?baseRef&targetRef`，返回解析后的固定 OID 和真实净变更列表。与单提交 summary 共用 Git diff-tree 的 NUL 解析、重命名和 numstat 逻辑；两端均校验可达性，返回路径及重命名前路径复用项目读取权限检查。接口与 shared/client 类型对齐。
- Git 侧栏新增 Original/Modified checkpoint 选择器，使用已加载历史分页中的 OID，已选端点在筛选/刷新后仍保留明确身份。比较结果包括 A/M/D/R/T 与 binary 标识，点击文件打开对应端点的只读 Monaco diff；同提交明确显示无差异。反向比较保留用户选择的左右方向，不擅自按时间重排。
- 源码与 diff 共用 Open editors 标签栏。diff 标签以两端 ref/path/oldPath 去重，标签显示路径及基线身份；支持切换、键盘导航、中键和关闭按钮。多个 diff 保持挂载，各自保留 model 与布局选择，避免切换时重建编辑器；滚动/选区完整矩阵仍待验证。返回源码仅切换可见视图，不丢弃其他比较。工作缓冲区 diff 关闭前 flush，失败保留；跨项目迟到关闭不会改写新项目标签。
- 增加 Git 集成测试，比较非相邻提交的净变化（包含中间修改后撤回）、新增/删除、中文重命名、反向比较及相同提交。新增 `e2e:two-checkpoints`：真实 Chrome 验证所选 OID 的两端正文而非父提交替代、rename oldPath、方向反转、无差异、多 diff 精确 model 身份保留、相同比较复用和中键仅关闭目标标签，全部通过。
- 本批验证：全套 200 tests / 1814 assertions 通过；typecheck/build、diff 检查通过。最新多标签构建的 two-checkpoints、workbench 与 shared-buffer 浏览器回归均通过。隐藏 diff 增加 provider 变更订阅后，two-checkpoints 与双浏览器 collaboration-provider 再次通过。
- P2-B 仍有剩余：完整当前变更列表与版本化工作树比较、恢复另存副本/冲突流程进一步统一、多比较生命周期/性能压力矩阵。协作模式交接、完全离线工作区、Evidence/Outline、底部面板/布局、AI/GitHub 比较复用及完整命中/IME/缩放/DPR/性能门槛仍按原规划推进，未标记全部完成。

### 2026-09-18：当前工作树变更与未保存 buffer 叠加

- 新增 `history-working-changes` 与 `history-working-compare`。服务端用临时 `GIT_INDEX_FILE` 读取 HEAD、对工作区执行 add -A、write-tree，产生只读的 tree OID；不会创建提交、移动 HEAD 或修改托管历史的 index。响应含明确 baseRef、projectVersion 和 snapshotId；路径与重命名前路径继续逐项走读取权限检查。
- 工作树比较请求必须携带列表获取时的 projectVersion，版本变化返回 409，禁止把不同时间的变更列表和文件端点拼在一起。新增/删除/重命名/二进制都用存在性与元信息建模，删除文件的右侧明确是固定版本保存树中的不存在状态。
- Git 侧栏新增 Current changes：默认最新 checkpoint，也可选择任意已加载基线；列出服务端保存工作树的 A/M/D/R/T，并在其上叠加 registry 中每个 dirty Monaco buffer（不限于当前打开标签）。未保存 buffer 以同一历史基线读取 original，比较右侧复用共享 model；保存树比较独立只读，避免把删除或未打开文件假装成空文本。
- Current changes 刷新不快照、不改历史 HEAD；增量加载/保存后自动更新，打开 diff 时保留 request 的 projectVersion 和端点身份。两端 history diff、working buffer diff 和 saved-tree diff 通过标签 key 区分，不互相覆盖。
- GitHistory 单元测试覆盖未 checkpoint 的 A/M/D/R、重命名旧路径、删除 comparison、隔离 index 与 HEAD 不变。新增 `e2e:current-changes`：Chrome 验证保存树 A/M/D/R、未保存 model overlay、版本化删除侧、重命名 oldPath 和只读刷新，全部通过。
- 本批验证：全套 201 tests / 1819 assertions、typecheck/build、diff 检查通过；two-checkpoints 多 diff 与 shared-buffer 浏览器回归也通过。当前变更的性能基线、20 标签/长历史压力以及完整恢复工作流仍待验收；计划其余 Evidence/Outline、底部布局、AI/GitHub 复用、协作模式交接、离线工作区、命中/IME/缩放/DPR 与性能项未完成。

### 2026-09-18：证据锚点验证与双模式目录

- 对照 Overleaf outline 的树形职责，目录侧栏现在有“Current document”和“Project structure”两种明确模式，状态持久化。Project structure 标注为保存的 workspace version；Current document 对 registry 中当前 buffer 做本地 LaTex heading 解析，包含未保存章节。两种模式都随 cursor 标记当前标题，点击标题使用统一 navigation request 定位而不抢编辑器焦点。
- 修复 claim ledger 的定位错误：原实现无论 anchor 内容和版本都导航到第 1 行。现在 claim 点击先读取 registry/服务端文档，核验 anchor.fileVersion、offset 和 exactText；版本不同、文本不匹配或 stale/reanchored 时调用服务端 reanchor，只有新 anchor 经再次验证后才构造带 fileVersion 的 TextSelection。无法验证或 source orphaned 时显示错误，绝不使用旧 offset。
- 证据项目的 title 和内容明确显示来源路径、保存版本与验证/重锚状态；stale/orphaned 不再暗中当作 current。reanchor 后刷新 ledger 对应项，支持已有 supported 状态的服务端降级语义。
- 新增 `e2e:evidence-outline`：真实 Chrome 验证保存目录语义、未保存 current-buffer heading、标题定位与光标跟随、服务端前缀插入导致 claim 版本变化后准确 reanchor 和 Monaco 选区。测试确认目标由第 5 行移动到第 6 行而非第 1 行，anchor 版本同时更新。
- 本批验证：全套 201 tests / 1819 assertions、typecheck/build、diff 检查通过；evidence-outline、editor reliability（50 次切换）与 current-changes 浏览器回归通过。并发执行 current-changes 与另一工作区脚本时出现过一次等待超时，顺序重跑通过，尚未将其当作并发隔离验收；完整多窗口项目并发、Evidence 筛选/来源关联和性能/泄漏矩阵仍待补齐。其余计划范围继续未完成。

### 2026-09-18：底部 Problems/Output 面板与项目布局恢复

- `PdfPane` 将解析后的 LaTeX diagnostics、受限 compiler log、编译版本和进度上报给工作台；底部区域新增 AI、Problems、Output 三个可键盘访问的标签，共享同一可收起和可调整高度的 panel。Problems 支持带路径/行号诊断回到源码，Output 保留最近 24,000 个字符，PDF 内部不再重复弹出诊断浮层。
- 侧栏视图、侧栏/PDF/底部尺寸、outline 模式与折叠状态、底部活动标签均改为按项目保存；响应式尺寸只影响当前显示，不再把窄屏临时状态写回用户布局。活动栏持续可见，窄屏仍能进入四个工作区视图。
- 本批验证：`bun run typecheck`、`bun run build`、`git diff --check` 通过。底部标签的真实浏览器恢复/编译失败定位矩阵仍待补充，整份规划继续未完成。

### 2026-09-18：Evidence 筛选与来源关联

- Evidence 侧栏增加状态筛选（needs-review、supported、partial、unsupported、stale、orphaned）和来源文件筛选，保留保存版本、来源路径及锚点验证状态；筛选为空时显示明确空结果，不隐藏错误状态。
- 本批验证：`bun run test` 201 tests / 1819 assertions、`bun run typecheck`、`git diff --check` 通过。Evidence 筛选的真实浏览器操作、离线完整工作区重载、IME/缩放/DPR、泄漏矩阵与性能压力仍待验收。

### 2026-09-18：底部面板布局浏览器验收

- 新增 `e2e:bottom-panel-layout`：真实 Chrome 验证 AI/Problems/Output 标签切换、面板收起/恢复、项目级活动标签刷新恢复、窄屏活动栏可达以及 Evidence 入口可用；页面无异常。
- 本批验证：`FASTWRITE_E2E_URL=http://127.0.0.1:3218 node scripts/e2e-bottom-panel-layout.mjs` 通过。20 标签性能压力、IME/缩放/DPR、离线完整工作区重载和资源泄漏矩阵仍待验收。

### 2026-09-18：Evidence 筛选浏览器回归

- 扩展 `e2e:evidence-outline` 覆盖 Evidence 侧栏的状态和来源筛选：确认筛选不会扩大结果集，恢复全量筛选后目标 claim 可见；与已有锚点重锚、版本和 Monaco 选区测试串联执行。
- 本批验证：`FASTWRITE_E2E_URL=http://127.0.0.1:3223 node scripts/e2e-evidence-outline.mjs` 通过，页面无异常。20 标签性能、IME/缩放/DPR、完全离线工作区重载和资源泄漏矩阵仍待验收。

### 2026-09-18：编辑器缩放、DPR 与中文输入矩阵

- 新增 `e2e:editor-matrix`：真实 Chrome（DPR 2）逐步验证 80%、100%、125%、150% 页面缩放下 Monaco 编辑器和行号仍可见；输入中文文本后内容完整保留，Ctrl/Cmd+P 快速打开仍可用，页面无异常。
- 本批验证：`FASTWRITE_E2E_URL=http://127.0.0.1:3223 node scripts/e2e-editor-matrix.mjs` 通过。完整原生 IME composition 事件、DPR 1/1.5/3、20 标签性能、完全离线工作区重载和资源泄漏矩阵仍待验收。

### 2026-09-18：GitHub 冲突复用 Monaco 比较内核

- GitHub 文本冲突界面复用现有 `TextModelComparison`：Common base 保留只读参考，FastWrite 与 GitHub 使用 Monaco diff editor，保留原有 Keep/Edit merged result 决策和服务端协议。恢复对话框与 GitHub Sync 现在共享同一模型生命周期、布局和跳转能力。
- 文本冲突模型使用独立 URI，卸载时由比较组件先解绑再释放，避免与共享源码 model 混淆；二进制和删除/修改冲突仍使用原有显式选择流程。
- 本批验证：`bun run typecheck`、`bun run build`、`git diff --check` 通过。GitHub 真实冲突浏览器脚本、AI 提案完全切换 Monaco diff、IME/多 DPR、20 标签性能与资源泄漏矩阵仍待验收。

### 2026-09-18：大型文本与多 DPR 编辑器矩阵

- 新增 `e2e:large-document` 并通过真实 Chrome 验收 10,000 行、1,179,999 字节文档：打开 `114.4ms`、文末输入 `115.2ms`、切换普通文件 `82.6ms`。
- 扩展 `e2e:editor-matrix` 到 DPR `1/1.5/2/3`，并在每个 DPR 下验证 80/100/125/150% 页面缩放、行号、中文文本、快速打开和 composition start/update/end 生命周期；四个上下文均通过且无页面异常。
- 当前 composition 验证使用浏览器 `CompositionEvent` 生命周期回放加实际文本输入，证明编辑器事件处理路径；仍需具备真实操作系统输入法的原生 IME 设备覆盖，不能把此脚本等同于 OS IME 验收。
- 本批回归：`bun run e2e:editor-matrix` 通过（4 个 DPR 上下文），`bun run test` 通过（201 tests / 1819 assertions），`bun run typecheck` 与 `git diff --check` 通过。

### 2026-09-18：AI 提案复用 Monaco 比较内核

- `EditableChangeReview` 的提案审阅视图现在复用共享 `TextModelComparison`，显示原始文本与 Agent proposal 的 Monaco diff；每个提案使用独立 URI，切换文件或修改 proposal 时先卸载 diff，再释放两个模型。
- 原有逐 hunk Accept/Reject、单 hunk 编辑和可编辑 proposal textarea 保持不变，因此 Monaco diff 只负责统一比较显示，不改变 ChangeSet 决策与服务端协议。
- 验证：`bun run typecheck`、`bun run build`、`git diff --check` 通过。真实 Agent proposal 浏览器流程仍待补充，尤其需要确认提案生成后 Monaco diff 可见、编辑模式切换不会遗留模型。

### 2026-09-18：离线工作区快照实现

- 新增 `offlineWorkspace.ts`，在成功加载项目元数据、根目录树、Outline、claims 和已读取文本正文后写入按项目隔离的本地快照。
- `WorkspacePage` 在 API 初始化或文件读取失败时恢复快照和已缓存正文，保留主编辑器入口；若正文没有本地缓存则明确显示加载错误，不伪造空文件。
- `bun run typecheck` 通过。离线浏览器脚本曾在当前已运行的旧前端服务上无法观察到新 snapshot 写入，因此未将完全离线重载标记为通过；需要在包含最新构建的新服务上重跑真实浏览器验收。
- 新增 `offlineWorkspace.test.ts` 覆盖项目/路径隔离及损坏记录处理；定向测试 2 项、6 个断言通过。该单测不替代断网 reload 的真实浏览器验收。
- 最新全量 `bun run test`：203 tests / 1825 assertions，全部通过；`bun run typecheck` 与 `git diff --check` 同样通过。

### 2026-09-18：源码切换资源基线

- 扩展 `e2e:editor` 的 50 次源码 A/B 切换回归，记录切换前后 `.source-editor-container .monaco-editor` 实例数并要求保持一致。
- 最新 Chrome 结果通过：source Monaco 实例数前后均为 `1`，无页面异常，保存、撤销、失败重试和跨文件隔离断言继续通过。
- 该指标覆盖源码视图的 DOM/editor 实例累积；diff model、DocumentRegistry 条目和 Yjs provider 的完整 dispose/socket 矩阵仍需独立验收。
- `TextModelComparison` 现导出 `textModelComparisonStats` 创建/销毁计数，供真实 diff 生命周期测试读取；`bun run typecheck` 与 `git diff --check` 通过。尚未将计数接入浏览器压力脚本。

### 2026-09-18：20 标签切换性能基线

- 新增并执行 `e2e:workbench-performance`：创建 20 个根目录文本文件，在真实 Chrome 中逐个打开并等待对应 Monaco editor 可见，记录每次切换耗时。
- 验收结果：20/20 标签通过，p95 `122.7ms`，最大值 `123.1ms`，低于当前脚本的 `<1000ms` smoke 门槛。测试使用 `FASTWRITE_E2E_URL=http://127.0.0.1:3223`，无页面异常。
- 该结果证明常规 20 标签切换基线，不替代 1MB/10k 行文档、长历史、DPR/IME 和资源泄漏矩阵，后者仍待完成。

### 2026-09-18：大型文档性能基线

- 新增 `e2e:large-document`：生成并上传 10,000 行、1,179,999 字节的 LaTex 文件，在真实 Chrome 中验证打开、文末输入和切换回普通文件；所有阶段均等待实际 Monaco aria textbox 或渲染文本，而非只测请求完成。
- 验收结果：首次 workspace 打开 `1603.1ms`，打开大型文件 `114.4ms`，文末输入并渲染 `115.2ms`，切换回普通文件 `82.6ms`。各项低于脚本中的打开 `<5s`、输入/切换 `<1s` smoke 门槛。
- 该基线覆盖主编辑器在大型文本下保持可输入和可切换；大文件首次 diff、长 Git 历史和资源生命周期压力仍待完成。

### 2026-09-18：专项回归复跑

- 最新端口顺序运行 `e2e-editor-reliability`、`e2e-large-document`、`e2e-editor-matrix` 均通过。编辑可靠性继续报告 source Monaco 实例数 `1`；大型文档本次打开 `110.6ms`、输入 `125.9ms`、切换 `106.6ms`；四档 DPR 与四档页面缩放的 composition 生命周期均通过。
