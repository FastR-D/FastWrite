# FastWrite UI 组件更新规划

保留 VSCode 工作台的信息架构，在现有 `vscrui`、共享组件和 CSS Modules 上逐步更新。轻快感主要来自柔和选中态、有用途的功能色、清晰的输入区、适度圆角和短促反馈。编辑器、文件树、PDF 与底部面板继续保持紧凑、稳定的布局。

参考仓库与源码分析已经完成，第一批基础组件更新于 2026-11-11 实现，组件目录命名为 FastUI。下列源码比较记录规划时的依据；本批交付和验证结果见第 7 节。AI 界面拆分和后续业务面板更新继续按批次推进。

## 1 参考源码与版本

按请求统一克隆到 `reference/`，使用 `git clone --depth 1`，未改动已有 `references/`。五个仓库均核验 `--is-shallow-repository=true` 且 `rev-list --count HEAD=1`。

| 项目 | 官方仓库 | 分支 | 本轮 commit | 根许可证 |
| --- | --- | --- | --- | --- |
| assistant-ui | [assistant-ui/assistant-ui](https://github.com/assistant-ui/assistant-ui) | main | `f92028b466cba721846de6851e4dddb6c04ecfad` | MIT |
| UUPM | [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | main | `6ae86f61f520d6ca229d2f40e070410638c908c5` | MIT |
| Ayakaleaf | [ayaka-notes/ayakaleaf-pro](https://github.com/ayaka-notes/ayakaleaf-pro) | server-pro | `6ce22039d19b516354dff2a8508dd67515ded9f0` | AGPL-3.0 |
| shadcn/ui | [shadcn-ui/ui](https://github.com/shadcn-ui/ui) | main | `8ab27715521cbd4f87ae6886cd989cbb678f6de7` | MIT |
| Radix | [radix-ui/primitives](https://github.com/radix-ui/primitives) | main | `eb3a2b7091293e27df8f9ba906632d8daa3d81a3` | MIT |

机器可读清单：[reference/ui-sources.json](../reference/ui-sources.json)。本轮没有复制上游组件到产品代码，也没有安装上游依赖。需要引用源码时记录对应文件的许可与来源；Ayakaleaf 在本方案中用于研究行为和组织方式。

## 2 他们如何编写代码

### 2.1 assistant-ui 将行为原语与外观组件分层

重点入口：

- [thread.aui.tsx](../reference/assistant-ui/packages/ui/src/components/react/assistant-ui/elements/thread.aui.tsx)：组合对话容器、消息、输入框、历史加载与工具组。
- [composer.tsx](../reference/assistant-ui/packages/ui/src/components/react/assistant-ui/elements/composer.tsx)：由 props 驱动的输入框部件、附件、命令与菜单边界测量。
- [surfaces.tsx](../reference/assistant-ui/packages/ui/src/components/react/assistant-ui/elements/surfaces.tsx)：集中定义表面、按钮、交互和动画的样式片段。
- [useExternalStoreRuntime.ts](../reference/assistant-ui/packages/core/src/react/runtimes/useExternalStoreRuntime.ts)：把已有消息与事件适配到运行时。
- [useThreadViewportAutoScroll.ts](../reference/assistant-ui/packages/react/src/primitives/thread/useThreadViewportAutoScroll.ts)：对接滚动控制器、历史前插和会话切换事件。

**写法与价值。** `ThreadComponents` 提供 Welcome、AssistantMessage、ToolGroup、ComposerExtra 等插槽，默认组件可独立替换。`isNewChatView` 与 `isHistoryLoadingView` 分别判断新对话和历史加载，避免把正在获取的历史误显示为空态。消息按正文、推理、工具调用等类型组织，工具组需要用户操作时保持展开。

输入框既有纯展示部件，也有连接运行时的组件；样式与运行状态的耦合被限制在连接层。`data-slot` 作为部件标识，CSS 自定义属性控制局部最大宽度、圆角和内边距。动画样式带 `motion-reduce` 分支。滚动逻辑是独立机制，处理内容增长、运行开始、历史前插和会话切换，而非每次消息变化都直接滚到底。

**对 FastWrite 的应用。** 将 AI 界面分成 `AiThread`、`AiMessage`、`AiComposer`、`AiContextBar`、`AiRunActivity` 与 `ChangeSetCard`，底层继续组合现有共享控件。视图接收 FastWrite 的状态与回调，先拆展示层；请求、ChangeSet 决策和持久化仍由现有业务层负责。仅当后续确实要使用 assistant-ui 运行时能力时，再单独评估适配器，避免同时维护两套任务状态。

**需要调整的尺度。** 上游独立 Composer 的 24px 圆角、对话留白及语音能力适合通用聊天；FastWrite 底部面板采用更小圆角和更紧凑间距，不随 UI 更新扩展语音或会话分支功能。

### 2.2 shadcn/ui 用变体矩阵统一控件

重点入口：

- [button.tsx](../reference/shadcn-ui/apps/v4/registry/new-york-v4/ui/button.tsx)：`cva` 组织 `variant × size`，统一导出变体函数与 Button。
- [input.tsx](../reference/shadcn-ui/apps/v4/registry/new-york-v4/ui/input.tsx)：默认、焦点、禁用、无效、暗色状态集中定义。
- [dialog.tsx](../reference/shadcn-ui/apps/v4/registry/new-york-v4/ui/dialog.tsx)：Root、Trigger、Portal、Overlay、Content、Title 等薄包装。

**写法与价值。** Button 用 React 原生 props 加变体类型组成 API，通过 `data-slot`、`data-variant`、`data-size` 暴露稳定标识；外观引用 `primary`、`secondary`、`ring`、`destructive` 等语义色。Dialog 将交互交给原语，样式包装负责布局与视觉。相邻控件共享焦点、无效与禁用规则，避免每个页面自行补状态。

**对 FastWrite 的应用。** 保留 `Button` 的 `primary / secondary / ghost / danger` 调用方式，增加内部的尺寸与状态规范，统一按钮、输入框、Select 和标签的视觉矩阵；可以采用 CSS Modules 映射表实现，不要求引入 `cva` 或 Tailwind。稳定部件标识用于调试和样式边界；行为测试优先通过角色与可访问名称定位。

**需要调整的尺度。** 上游常规按钮 36px、较大的表单间距不直接覆盖工作台。FastWrite 继续保留 25px 小按钮、28px 紧凑控件，在设置表单与项目页使用 32px 的舒适尺寸。`vscrui` 已负责部分按钮的圆角与 padding，迁移时先明确样式所有权，不叠加无法胜出的单类覆盖。

### 2.3 Radix 将弹层行为拆成可组合机制

重点入口：

- [dialog.tsx](../reference/radix-primitives/packages/react/dialog/src/dialog.tsx)：受控状态、Portal、模态与非模态内容、焦点恢复。
- [dismissable-layer.tsx](../reference/radix-primitives/packages/react/dismissable-layer/src/dismissable-layer.tsx)：弹层注册、外部交互、最上层 Escape 处理。
- [focus-scope.tsx](../reference/radix-primitives/packages/react/focus-scope/src/focus-scope.tsx)：焦点限制与嵌套范围。
- [dialog.test.tsx](../reference/radix-primitives/packages/react/dialog/src/dialog.test.tsx)：通过点击、焦点、Escape 和 axe 校验用户行为。

**写法与价值。** Dialog 使用 `useControllableState` 兼容受控和非受控调用。焦点范围、关闭层、滚动锁定分开组合；嵌套 Portal 可注册为所属弹层的分支。`DismissableLayer` 只让最高层监听关闭键，并允许调用方阻止默认关闭；还兼顾 IME 的 `isComposing` 与 `keyCode === 229`。

**对 FastWrite 的应用。** 对照检查现有 Dialog、Select、QuickPick 的嵌套行为：弹窗里的下拉菜单按 Escape 应先关闭菜单，关闭后焦点应回到触发控件。先补可复现的行为场景，再决定完善共享弹层机制，或在现有公共 API 后接入必要的 Radix 原语。原语不能直接出现在业务页面中形成第二条控件入口。

**需要调整的范围。** 先覆盖已有弹窗和选择器的真实需求，不为一次样式更新移植整个底层原语体系。

### 2.4 Ayakaleaf 围绕编辑器上下文组织 AI 面板

重点入口位于 `reference/ayakaleaf-pro/services/web/modules/workbench/frontend/js/chat/`：

- [assistant-panel.tsx](../reference/ayakaleaf-pro/services/web/modules/workbench/frontend/js/chat/assistant-panel.tsx)：面板头、停靠位置和新对话。
- [chat-view.tsx](../reference/ayakaleaf-pro/services/web/modules/workbench/frontend/js/chat/chat-view.tsx)：对话、编辑器上下文与消息跟随。
- [composer.tsx](../reference/ayakaleaf-pro/services/web/modules/workbench/frontend/js/chat/composer.tsx)：选区说明、附件、2 至 8 行输入、发送与停止。
- [edit-proposal.tsx](../reference/ayakaleaf-pro/services/web/modules/workbench/frontend/js/chat/edit-proposal.tsx)：修改理由、词级 diff、应用、拒绝与撤销。
- [themed.ts](../reference/ayakaleaf-pro/services/web/modules/workbench/frontend/js/chat/themed.ts)：主次文字、表面、分隔线和增删颜色的主题适配。

**写法与价值。** 面板外壳与会话主体分开；输入框显式展示附带选区，通过 `working` 切换发送和停止。附件预览创建的 Object URL 在清理时释放。输入事件判断 IME，避免确认中文候选时发送。`useFollowBottom` 在用户离底部小于 40px 时跟随新内容，向上阅读时暂停。编辑提案把理由、差异与决策放在一个局部界面中。

**对 FastWrite 的应用。** 把“当前文件、所选段落、写作技能、参考论文”集中在输入区附近，以可移除标签和折叠摘要展示；已有 `ReferenceTags` 和 Tag 继续复用。长工具输出默认收起，错误与待用户处理的动作展开。改进消息跟随，并显式提供“回到最新”操作。候选、已接受与待编译结果应有清晰但不同的状态。

**需要调整的边界。** 上游使用 CodeMirror、Bootstrap 和 Overleaf 上下文；FastWrite 使用 Monaco 与自己的 ChangeSet、版本、审批和回滚机制。借鉴面板组织与行为，不接入其编辑实现。`themed.ts` 也说明第三方工具类可能绕过产品暗色主题；FastWrite 应把这类适配集中在 token 和组件层。

### 2.5 UUPM 是规则检索与方案生成工具

重点入口：

- [core.py](../reference/ui-ux-pro-max-skill/src/ui-ux-pro-max/scripts/core.py)：CSV 领域配置、同义词归一化、BM25、领域和技术栈检索。
- [design_system.py](../reference/ui-ux-pro-max-skill/src/ui-ux-pro-max/scripts/design_system.py)：多领域检索、产品推理规则、语义色对、设计参数与方案输出。
- [app-interface.csv](../reference/ui-ux-pro-max-skill/src/ui-ux-pro-max/data/app-interface.csv)、[ux-guidelines.csv](../reference/ui-ux-pro-max-skill/src/ui-ux-pro-max/data/ux-guidelines.csv)：具体交互规则。
- [test_data_contracts.py](../reference/ui-ux-pro-max-skill/src/ui-ux-pro-max/scripts/tests/test_data_contracts.py)：规则数据与来源契约的检查入口。

**写法与价值。** 检索引擎把可搜索字段与输出字段分开，按领域处理数据；BM25 使用词频、文档频率与长度归一化排序。生成器聚合产品、风格、颜色、字体和落地页检索结果，再套用规则。`variance / motion / density` 控制不同设计维度，语义颜色按背景与前景成对输出。这里的“生成”主要是数据检索与规则组合，不能视为针对 FastWrite 运行界面的实测设计结论。

**本轮离线试用。** 查询 `IDE scientific LaTeX writing developer tools`，设置 `variance=3`、`motion=2`、`density=8`。成功识别 `Developer Tool / IDE`，返回 Minimalism & Swiss Style、轻动效及紧凑间距；同时返回 FAQ 落地页结构、绿色强调和 ScrollReveal/GSAP 示例。这些后者不适用于当前编辑工作台，说明其结果需要按实际界面筛选。

完整输出：[uupm-design-system.json](../output/ui-reference-analysis/uupm-design-system.json)。此次没有使用 `--persist` 写入它的设计系统，也没有安装其 CLI。FastWrite 采纳规则维度、语义配色和质量检查方式，继续沿用蓝色主色、双主题和现有字体。

## 3 规划时的 FastWrite 基础与具体差距

| 位置 | 当前源码证据 | 更新方向 |
| --- | --- | --- |
| `components/ui/index.ts` | 已有 primitives、controls、feedback、chrome 统一出口 | 继续通过该入口使用共享控件，新增组件遵守现有 guard |
| `styles/tokens.css` | 已有 VSCode 语义色映射与暗色覆盖；主按钮、badge、选中态有独立前景背景配对 | 扩充尺寸、圆角、动效与低强调功能色规范，保留填充色与文字色的区别 |
| `primitives/Button.module.css` | vscrui 管 primary/secondary 外观，本地管 ghost/danger；尺寸 25/28px，部分圆角为 2px | 先统一所有变体的度量与样式所有权，再调整圆角 |
| `chrome/TabBar.module.css` | 已有平直文件标签、顶部活动线、预览斜体、未保存标记 | 保留编辑器标签结构；对话页签与文件标签分别设定外观 |
| `AiWorkspace.tsx:123` | 消息、运行状态或候选编辑状态变化时直接滚到底部 | 引入用户滚动意图，向上阅读时暂停跟随 |
| `chrome/Dialog.tsx:40` | 焦点列表只排除元素自身的 hidden；文档级 Escape 监听没有最高层判断 | 检查隐藏祖先、无可聚焦元素、嵌套菜单和焦点恢复场景 |
| `styles.css` 的项目页规则 | 渐变、半透明背景、部分 hover 边框直接写颜色 | 将页面表面与状态映射到双主题语义 token |
| `chrome/StatusBar.module.css` | 状态栏字体为 10px | 次要信息建议提高到 11px，并检查 125% 与 150% 缩放 |
| `GalleryPage.tsx` | 已有组件目录和错误、加载、禁用示例 | 扩充为尺寸、状态、双主题及典型业务组合的验收入口 |

以上 Dialog 项是静态代码发现的风险点，尚未通过浏览器重现；实施时应先确定失败场景。自动滚动项已有明确的无条件滚动代码，可直接列入行为更新。

## 4 视觉方向与组件规范

### 4.1 工作台结构

保留活动栏、左侧工具视图、中间编辑器、右侧 PDF 和底部 AI／问题／输出。保留拖动分隔、面板折叠、文件标签及 AI 全屏模式。工作台区域保持直边相接，用背景层次与必要分隔线建立区域关系；不在每个区域外围增加悬浮卡片和大间隙。

活泼感集中在选中背景、AI 的少量辅助色、项目或模板图标、输入框与完成反馈。项目页和欢迎态可比编辑器更舒展，编辑区继续优先承载正文。

### 4.2 基础规范建议

以下值是实施起点，最终以组件目录中渲染的双主题对照为准。

| 维度 | 建议 |
| --- | --- |
| 主色 | 保留当前蓝色。主操作实底，普通选中状态用柔和底色、前景与活动线组合 |
| 功能色 | 蓝色表示主要交互；低饱和紫色仅提示 AI 身份或上下文；绿／琥珀／红保留成功／警告／错误语义 |
| 色彩配对 | 每种低强调色同时定义前景、背景；实底按钮有独立前景背景对，暗色不能复用浅色文字色阶充当按钮底色 |
| 圆角 | 工作台边界与文件标签保持直边；普通控件 4px，局部卡片 6px，弹层 8px，AI 输入容器 8 至 10px；圆形用于头像或少数图标动作 |
| 尺寸 | 保留 25px 小按钮、28px 紧凑控件；设置表单和项目页提供 32px 舒适控件；触屏扩展有效命中范围 |
| 间距 | 使用 2／4／6／8／12／16／24px 阶梯；组内靠近，组间留白，不依赖密集分隔线 |
| 字体 | 保留系统字体与现有编辑器字体设置；工具文字 12 至 13px、对话正文 14px、次要注释至少 11px |
| 动效 | hover／press 100 至 140ms，局部状态或弹层 160 至 200ms；响应 reduced-motion；编辑内容区域不做缩放或弹跳 |
| 阴影 | 只在菜单、Tooltip、Dialog 等浮层体现抬升；普通工作台面板依靠表面与边界 |

颜色继续通过已有品牌色阶映射到 `--vscode-*`。FastWrite 独有的尺寸、圆角、动效和 AI 表面使用 `--fw-*`；更新 tokens 文件中“组件只读 VSCode 变量”的说明，使允许的产品扩展有明确契约。不要为同一表面建立多个含义相近的新 token。

### 4.3 组件更新清单

| 组件组 | 更新内容 | 优先级 |
| --- | --- | --- |
| Button、IconButton | 统一四变体、图标间距、loading 占位、焦点与尺寸；保持加载时宽度稳定 | P0 |
| TextField、TextArea、Select、MultiSelect、NumberField | 同尺寸对齐；统一无效、禁用、hint 与焦点；长名称和中文重排 | P0 |
| Tag、Badge、ReferenceTags | 区分计数、状态与可移除上下文；柔和背景，配图标或文本表达语义 | P0 |
| Tree、ListRow、ActivityBar | 柔和选中态；活动标识保留；键盘选中与 hover 分开；操作在 focus 时也可用 | P0 |
| TabBar、Section、StatusBar | 区分文件标签与工具切换；层级和文字密度统一；保留未保存标记 | P0 |
| Dialog、Select、QuickPick、Tooltip | 统一浮层层级和视觉；验证嵌套关闭、焦点与边界定位 | P1 |
| AiComposer、AiContextBar | 输入区整合选区、技能和参考标签；主要操作明确；次要设置收进菜单 | P1 |
| AiThread、AiMessage | 用户消息轻背景、助手正文简洁；处理新对话、加载、失败、停止与历史阅读 | P1 |
| AiRunActivity、ChangeSetCard | 工具进展默认摘要，待操作和错误展开；区分计划确认、候选接受与编译完成 | P1 |
| Alert、EmptyState、ProgressBar、Notifications | 同一错误由一个主要位置承载，提示包含下一步操作；短成功反馈避免重复弹出 | P1 |
| PDF 工具条与编译状态 | 复用紧凑工具条；编译中、成功、警告、失败、PDF 过期分别可识别 | P1 |
| 项目卡、模板卡、技能详情、设置页面 | 使用共享表面和间距；减少硬编码颜色；把功能入口与当前任务关联 | P2 |

共享层缺少且确有多个调用方时，再补 `Popover / Menu / Kbd / Toolbar`。不为本轮视觉更新引入完整后台组件库或新的动画依赖。

## 5 实施批次与代码边界

### 第一批 基础样式与组件目录

范围：`styles.css`、`styles/tokens.css`、`components/ui/`、`GalleryPage.tsx` 及其样式。

先记录现有控件的 computed style，明确 vscrui 与本地模块各自负责的属性。按按钮、表单、列表、标签的顺序更新；业务调用 API 保持兼容。组件目录增加真实的长中文、图标、加载、无效、禁用、两种密度和双主题对照。基础控件稳定后再迁移页面颜色。

完成条件：四种按钮视觉一致，相同尺寸的控件对齐；正常文字对比度目标至少 4.5:1；可见焦点和非文字控件边界目标至少 3:1；长标签不遮住操作；浅深色均可读。

### 第二批 AI 界面拆分与交互改进

范围：`components/workspace/AiWorkspace.tsx`、`AgentTaskDialog.tsx` 及新增的 AI 展示组件。

先拆消息、输入框、上下文和候选卡片，再把请求与会话管理抽到有明确职责的 hook。修改消息跟随行为，保持编辑器选区、当前候选与本地草稿恢复关系。组件只展示真实运行状态；不把尚未实现的流式输出、工具日志或上下文计数画成已有能力。

完成条件：向上阅读不被新消息拉回；回到底部可恢复跟随；停止不会提交候选；切换任务不会混用草稿；中文输入确认不触发发送。用户确认计划、接受 hunk、完成审核、编译和回滚继续遵循现有领域契约。

### 第三批 工作台与编译反馈统一

范围：`ActivityBar`、`EditorTabs`、文件树、`PdfPane`、`WorkbenchNotifications` 和已有编译助手面板。

统一工具条、标题、选中态和反馈表面。一个编译失败以“问题”面板为诊断列表、PDF 区为简洁状态与入口，通知只承担必要提醒；不要在三处重复展示完整错误。候选已接受但尚未重新编译时，继续明确 PDF 可能过期。

完成条件：完整工作台在常用桌面宽度下保持正文空间；分隔拖动、折叠、恢复与键盘操作可用；错误、过期与成功状态一致。

### 第四批 项目页与设置收尾

迁移项目页、模板入口、技能详情与设置表面的硬编码颜色，统一空态和提示语；沉淀组件规范及典型业务组合。每批控制范围，不把视觉调整与编译、协作或审批状态机改动混在同一批中。

## 6 验证与交付标准

复用现有检查，按每批实际变更选择运行：

- `bun run --filter @fastwrite/web typecheck`：组件 API 与业务调用兼容。
- `bun test ./apps/web/src/components/ui`：原始控件边界、字段关联和现有共享层约束。
- `bun run --filter @fastwrite/web e2e:components`：组件目录行为；为新增弹层行为补嵌套关闭、焦点恢复和中文输入场景。
- `bun run e2e:workbench`、`bun run e2e:bottom-panel-layout`：工作台和底部面板涉及布局时运行。
- `bun run --filter @fastwrite/web e2e:visual`：视觉回归脚本已存在，但本轮检查时 `apps/web/visual-baseline/` 目录不存在。实施首批先生成并人工审阅基线，后续明确区分预期设计变化与意外退化。

视觉检查覆盖浅／深色，1440px、1280px、1024px 桌面宽度及 720px 降级布局；320px 检查表单、弹窗和主要操作能够重排；同时检查 125%／150% 缩放、长中文、reduced-motion 和仅键盘操作。需要补测的是用户行为与主题可读性，不为每个 CSS 常量新增重复测试。

参考研究阶段完成五个浅克隆的版本核验、重点源码阅读和 UUPM 离线查询，未运行上游全量构建。实际组件更新的验证记录如下。

## 7 第一批交付记录

2026-11-11 完成基础组件更新，组件目录对外使用 **FastUI**，应用名称继续使用 FastWrite。保留底层依赖，不在界面展示其品牌名。

- 添加共享控件高度、圆角与动效 token，默认保持 28px 紧凑控件和 25px 小按钮。
- `View` 支持 `density="comfortable"`，其内的常规按钮、文本输入、Select 和 NumberField 统一使用 32px；`density="compact"` 可恢复紧凑密度。无需逐个修改业务控件。
- 四种按钮共用几何规范，底层库继续负责主、次按钮的配色。本地几何覆盖使用稳定类名限定，不依赖生成的样式 ID。
- 加载图标覆盖原内容位置，保留按钮宽度与可访问名称，通过 `aria-busy` 表达状态，加载期间禁用重复提交。
- 列表、下拉选项和活动栏使用柔和蓝色选中态；标签采用较轻边框，增加 `tone="ai"` 的低饱和紫色语义色对。
- 表单边界、图标按钮、Section 和 Dialog 统一使用共享变量；文件类型图标改用双主题色；标签、计数与状态栏文字提高到 11px。
- FastUI 目录提供浅深色切换、两种密度、长中文输入、上下文标签和可切换的加载示例，320px 宽度可重排。

验证结果：

| 检查 | 结果 |
| --- | --- |
| Web typecheck 与生产构建 | 通过；构建保留大体积 Monaco chunk 提示 |
| 共享 UI 单元检查 | 18 项通过 |
| 组件目录端到端检查 | 按钮变体一致性、两种密度对齐、加载宽度与名称、选择器、键盘和字段关联通过 |
| 浅深色无障碍检查 | axe WCAG 2 A／AA 与 2.1 AA 范围内无 critical／serious 问题 |
| FastUI 响应式 | 浅深色分别检查 1440、1024、720、320px，无页面横向溢出 |
| 工作台冒烟检查 | 在隔离数据目录下检查浅深色、1440／1280／1024／720px、主题按钮、侧栏、底部面板和设置入口 |
| 减少动效 | 已验证浏览器 reduced-motion 模式下控件过渡接近零 |

截图与检查记录保存在 `output/ui-refresh/`，包括组件目录、工作台浅深色截图和两个 `*-checks.json`。工作台冒烟只验证布局及常用交互，没有把编译成功或 AI 全链路纳入本批验收。旧视觉基线尚未建立，本批截图用于人工复核；后续完整视觉回归仍需覆盖项目页等其余路由。

## 8 第二批交付记录

2026-11-11 更新 AI 修改工作区，继续保留 VSCode 紧凑布局，以柔和蓝色消息、紫色 AI 图标、输入区上下文和结构化候选卡片建立层级。

- 拆分 `AiMessage`、`AiThread`、`AiComposer`、`AiContextBar`、`ChangeSetCard` 和 `AiRunActivity`；Agent 任务进度复用真实运行状态展示，原计划与审核流程继续保留。
- `useThreadFollow` 只在用户位于底部时跟随；向上阅读保留位置，提供“回到最新”入口，容器尺寸变化也遵循用户的跟随选择。
- `useRevisionRequest` 同时取消网络请求并使迟到结果失效。停止恢复已提交的要求，保留已有候选和手工编辑；切换修改／智能助手模式也取消当前修改请求。
- 输入框区分中文输入确认、Enter 发送和 Shift+Enter 换行，发送／停止按钮均使用显式点击行为，避免按钮原位切换造成表单再次提交。
- 各选区分别恢复历史、未发送要求与手工编辑候选，保存时检查会话已加载，防止切换期间将旧内容写入新选区。项目切换隔离工作区实例；编辑权限初始化后重新同步编辑器选区。
- 服务选择器使用共享 `Select appearance="toolbar"`，加入低饱和图标底色、轻边框、展开箭头反馈、服务说明和选中勾。字段模式保持兼容，FastUI 目录增加工具栏示例。高亮选项说明使用对应选中前景色，保证浅色对比度。

验证入口与产物：

| 检查 | 结果 |
| --- | --- |
| Web typecheck、生产构建 | 通过；保留既有 Monaco 大 chunk 提示 |
| UI、Agent 审核及命令单元检查 | 25 项通过 |
| 组件目录端到端检查 | 工具栏选项、方向键、确认、Esc 及已有控件行为通过；浅深色 axe 无 critical／serious 问题 |
| `bun run e2e:ai-workspace` | 隔离数据和确定性测试服务验证恢复、中文输入、停止与迟到响应、跨选区草稿、模式切换、手工候选持久化、接受和回滚 |
| 工作区及展开菜单 | 浅深色 1440／720px 无页面横向溢出；菜单可点击，axe 无 critical／serious 问题 |
| 工具栏选择器响应式 | FastUI 浅深色分别检查 320／720／1024／1440px，菜单可见，无页面横向溢出 |

截图及 JSON 记录位于 `output/ui-refresh-phase2/`。AI 端到端验证调用真实候选接受／回滚接口，使用本地确定性模型替身，不将外部 Codex／Claude 服务质量或真实流式传输纳入验收。本批未推进第三、四批页面迁移。

## 9 第三批交付记录

2026-11-11 统一工作台导航、页签和编译反馈，保留原有编辑器、文件树与面板交互。

- 活动栏使用内缩圆角选中面、左侧细标记与共享图标，移除覆盖选中底色的重复样式；文件树的选中态使用同一组语义色。
- 文件页签提高到 12px，保留顶部选中标记、预览斜体、未保存标记和关闭按钮。LaTeX 文件、版本对比与文档使用不同的轻量图标色；触屏环境始终显示关闭入口。FastUI 增加可操作的页签示例。
- PDF 工具栏、页码、缩放与收起按钮跟随主题，窄预览面板自动重排。适应面板按钮展示真实启用状态；移除未实现的 PDF 搜索占位按钮。
- 编译状态优先显示正在编译、编译失败与预览加载失败。PDF 对应的版本较旧时，保存文件后继续显示“PDF 待更新”，重新编译成功后清除。失败时保留已有 PDF，并注明当前显示的是上次结果。
- PDF 区只显示简短编译状态，诊断按钮直接打开“问题”或“输出”。问题面板区分错误／警告／信息图标，提供源位置与助手修复；无源位置的错误可以转到输出。预览空态不再重复完整编译错误。
- 问题列表、输出日志与网络通知改用双主题表面和共享圆角。日志与诊断使用 12px 正文，辅助位置使用 11px；网络错误继续由可关闭通知呈现。

验证入口：

| 检查 | 覆盖 |
| --- | --- |
| Web typecheck 与生产构建 | 共享组件、PDF 回调与工作台兼容；保留既有 Monaco chunk 提示 |
| UI、文件树和编译反馈单元检查 | 25 项，包括版本过期、编译中优先级、失败保留旧预览和渲染失败 |
| FastUI 组件端到端 | 新页签示例的键盘切换、关闭与重置，以及已有控件和双主题 axe 检查 |
| `bun run e2e:workbench-ui` | 隔离项目验证编译取消、PDF 渲染、页签预览／固定／关闭、活动栏、源位置跳转、面板调整与折叠、过期提示、失败入口和网络通知 |
| 响应式及无障碍 | 浅深色 1440／1280／1024／720px，另用键盘将 PDF 面板缩窄至约 320px；检查横向溢出和可见区域 axe WCAG 2 A／AA、2.1 AA |
| AI 修改区回归 | 复用 `bun run e2e:ai-workspace` 验证此前停止、草稿、候选接受与回滚行为 |

工作台 UI 回归使用可控编译响应及测试 PDF，实际运行编辑器、项目保存与诊断解析，不验证 LaTeX 引擎正确性。截图及检查记录保存在 `output/ui-refresh-phase3/`。第三批的基础工作台与编译反馈已落地；第四批项目页及设置页面迁移另行推进。

## 10 中英文字体调整

2026-11-11 根据“小字号偏细”的实际反馈调整字体。此前运行环境的英文为系统 Inter、中文回退到 Noto Sans CJK SC Regular；这次使用随应用提供的可变字体，让主要界面的字形和字重更稳定。

- 默认界面：IBM Plex Sans + Noto Sans SC，正文与输入使用 500 字重，保留标题和操作按钮的层级。共享变量集中于 `styles/tokens.css`，控件高度与密度不变。
- 源码与对比编辑器：JetBrains Mono + Noto Sans SC，450 字重、14px 字号、24px 行高；禁用代码连字。字体加载结束后通知 Monaco 重新测量，避免继续使用回退字体的字宽缓存。
- FastUI 新增 Plex／Geist／系统 UI 三组并排对照，支持把方案临时预览到整个目录；离开目录恢复应用默认，不写入个人配置。
- 字体通过固定版本的 Fontsource 包自托管，使用 Unicode 范围按需加载，运行时不调用外部字体服务。保留系统回退、`font-display: swap`，许可证与来源在 `public/licenses/fonts/`。构建产物中的所有 WOFF2 文件合计约 5 MiB，并非首屏全部请求。

验证：Web typecheck 和生产构建通过；25 项 UI／文件树／编译反馈单元检查通过；组件目录、工作台 UI、AI 修改区端到端回归通过。新增 `bun run e2e:typography` 验证浏览器实际使用自托管的中英文字体及等宽字体、500 字重、方案切换与恢复、字体下载失败时的系统回退。字体对照在浅深色 1440／1024／720／320px 无页面横向溢出，axe 检查无 critical／serious 问题。

本批截图与字体检查记录位于 `output/ui-typography/`。原有 PDF 论文内容继续使用 PDF 自身字体；本次调整应用界面和源码编辑器。

## 11 编辑器间距与证据面板容器修复

2026-11-11 根据行号截图和证据面板反馈调整布局：

- 编辑器分隔线位于折叠图标列之后，正文侧保留 8px 背景一致的留白。行号右侧至分隔线为 16px，原有折叠、评论标记及编辑器坐标保持可用。三位、四位行号均检查字形边界和鼠标首列编辑位置。
- 移除论断与证据面板的旧 360px 最大高度，使用侧栏可用高度；顶栏和状态／来源筛选为固定 flex 子项，论断列表以 `min-height: 0` 和独立 `overflow: auto` 滚动。
- 修正共享 Button 内容包装层对论断卡片的横向布局影响，论断类型与摘录纵向排列，并允许长来源路径换行。
- 新增 `bun run e2e:sidebar-evidence`，使用 72 条受控论断检查浅深色、1440×1000／720×650 布局、固定区域坐标、鼠标及键盘滚动、组合筛选与源码定位，并检查证据面板 axe 无 critical／serious 问题。

Web typecheck、生产构建、18 项共享 UI 检查及工作台端到端回归通过。独立布局回归验证行号右侧到分隔线 16px、正文留白 8px，点击后内容写入正确列。截图和检查记录位于 `output/ui-layout-fixes/`。

## 12 页签高亮与状态标记收尾

2026-11-11 将底部 AI／问题／输出页签改为与文件编辑器一致的平直表面和顶部细线，取消圆角蓝色底与底部阴影。页签撑满标题栏高度，文字水平、垂直居中；删除旧页级选中态覆盖，选中样式由共享 TabBar 管理。

文件页签的未保存标记由字体字符 `●` 改为固定 6px 的低强调灰点，避免字形或字体切换放大圆点；保留“未保存的更改”的可访问名称。页签与关闭按钮使用细矩形键盘焦点框，清除全局焦点光晕。

验证包含 18 项 UI 检查、组件目录及工作台回归、Web typecheck 和生产构建。端到端检查增加标记尺寸及焦点阴影检查，并在浅深色 1440／1280／1024／720px 核对底部页签无圆角、文字居中、未超出标题栏。截图为 `output/ui-refresh-phase3/panel-tabs-*.png` 与 `editor-tabs-*.png`。

## 13 项目列表与导入入口

2026-11-11 参考 `reference/ayakaleaf-pro` 的项目导航、搜索和表格结构，将 `/projects/` 卡片网格替换为侧栏与分隔线列表，沿用 FastUI 的配色、字体与按钮。移除旧卡片样式和加载骨架，项目列表独立滚动，页面标题、搜索排序工具栏与表头固定。

- 提供全部／本地／GitHub 来源筛选、项目／文件／来源／投稿目标搜索、最近修改／最早修改／名称排序。名称使用原生链接，支持键盘访问和新标签页打开。
- 列表显示项目名称、主文件、来源、投稿目标与修改时间；窄屏逐步收起次要列。保留新建、导入、删除确认、团队、通知、认证和邀请流程。
- 按反馈删除标题下的宣传文案。修正目录导入按钮内容包装层导致的横排和图标压缩：固定 48px 方形图标，标题和说明纵向排列，说明可换行。

新增 `bun run e2e:projects-ui`（默认使用 `http://127.0.0.1:3218`，可通过 `FASTWRITE_E2E_URL` 指定开发或预览地址）。使用受控 API 数据检查筛选排序、弹窗、删除与重试、加载与空状态，并在浅深色 1440／1024／720／390／320px 检查独立滚动、固定区域、横向溢出、导入入口尺寸及列表无障碍。截图与记录位于 `output/ui-projects/`。
