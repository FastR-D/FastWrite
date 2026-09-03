# FastWrite Harness / Skill / MCP 迁移规划

> 状态：基础迁移已落地；真实 Harness E2E 待环境验收  
> 参考实现：`~/FastPPT` 的 `harness-core`、`harness-claude`、`harness-codex` 与 `fastppt-skill`

## 目标

将 FastWrite 当前基于 OpenAI SDK 的“一次请求一次响应”模型，迁移为基于 Harness 的持久会话、流式事件、审批、取消、恢复和 Skill 调用模型。

所有论文工作流 Prompt（Draft、Revise、Review、Completion、Memory、Compile Repair）迁移为可版本化、可审计的 Skill；MCP 作为受权限控制的工具层接入。

## 目标架构

```text
Web
  └─ FastWrite API / WebSocket
       ├─ SessionService
       ├─ RunService
       ├─ ApprovalService
       ├─ SkillRegistry
       ├─ McpRegistry
       └─ HarnessAdapterRegistry
            ├─ Claude Agent SDK Adapter
            └─ Codex App-Server Adapter
```

原则：

- Provider 协议细节只存在对应 Harness adapter 中。
- Web 与论文业务服务只依赖统一 Harness 接口。
- 业务代码不再拼接完整 Prompt；Prompt、工具权限和输出约束由 Skill 提供。
- Provider 历史由 Claude/Codex 持有；FastWrite 保存会话引用、运行状态、事件摘要和审计信息。
- 文件写入继续通过 ChangeSet 和显式审批完成。

## 当前差距

- `apps/server/src/agent/provider.ts` 直接使用 OpenAI SDK。
- Draft、Revise、Review、Completion、Memory 各自维护 Prompt。
- 没有持久 Session、统一流式事件、Harness 能力探测、审批、恢复和运行槽位。
- `SkillRegistry` 目前主要读取 Markdown 与 venue 文件，尚未成为 Harness 的 Skill 安装/调用入口。
- MCP 尚未形成统一注册、能力发现、权限和审计模型。

现有 Draft/Review/ChangeSet/Compile 确定性业务逻辑保留，迁移重点是其上游的模型调用与运行管理。

## 实施阶段

### Phase 1：协议与运行模型

新增 `packages/harness-protocol` 与 `packages/harness-core`，定义：

- `HarnessKind`、`HarnessStatus`、`HarnessCapabilities`
- Session、Run、Approval、SkillInvocation、MCP 状态
- 统一事件：`session.created`、`run.started`、`assistant.message.delta`、`tool.requested`、`approval.requested`、`run.completed`、`run.failed`、`run.cancelled`、`harness.disconnected`

先使用 Fake Harness 完成协议、事件排序、去重、取消和超时测试。

### Phase 2：Prompt 迁移为 Skill

建议目录：

```text
skills/
  _shared/academic-writing/SKILL.md
  _shared/evidence-boundary/SKILL.md
  _shared/latex-safety/SKILL.md
  _shared/change-set-review/SKILL.md
  draft/SKILL.md
  revise/SKILL.md
  review/SKILL.md
  completion/SKILL.md
  memory-extract/SKILL.md
  memory-polish/SKILL.md
  compile-repair/SKILL.md
```

每个 Skill 包含：`id`、`version`、适用任务、上下文要求、禁止事项、MCP 白名单、输出协议、失败条件、证据边界和 LaTeX 安全规则。

`draft` Skill 必须明确禁止 `TODO`、`TBD`、`FIXME`、`PLACEHOLDER`、`[insert ...]` 和空模板；证据缺失时只能写已知事实与限制。服务端仍保留确定性占位符硬校验。

### Phase 3：Managed Skill Registry

参考 FastPPT 实现 `SkillManifest`、`SkillInstaller`、digest 和冲突保护：

- 扫描内置及工作区 Skill。
- 校验 ID、版本、路径包含关系和符号链接逃逸。
- 安装到 `.claude/skills/<id>` 与 `.agents/skills/<id>`。
- 支持 dry-run、安装、升级、冲突和安全清理。
- 每个 Run 固定不可变 Skill registry snapshot。
- 记录 `resolved`、`unknown`、`failed` 状态及 invocation mechanism。

### Phase 4：Claude Harness Adapter

新增 `packages/harness-claude`，使用 Claude Agent SDK，不调用 CLI、不解析 ANSI 输出。

实现会话创建/恢复、流式消息、工具调用、`canUseTool` 审批、取消、断线恢复、能力探测和安全环境变量白名单。

### Phase 5：Codex Harness Adapter

新增 `packages/harness-codex`，接入 Codex app-server JSON-RPC：

- Session resume/fork。
- 事件流转换、工具审批、Skill typed input 或 `$skill-name` 调用。
- 处理进程退出、超时、取消和重连。
- 不再直接访问 OpenAI-compatible relay。

优先实现此阶段，以绕开当前 OpenAI-compatible endpoint 返回的 Codex 客户端 403。

### Phase 6：MCP Registry 与权限

新增 `McpRegistry`、`McpServerDefinition`、`McpCapability` 和 `McpPermissionPolicy`。

首批工具：workspace 读/搜/写、LaTeX 编译、PDF 诊断、论文检索、Paper Memory、ChangeSet。

要求：Skill 声明工具白名单；写入必须经过 ChangeSet；发布、删除、GitHub push 必须审批；参数经过 schema 校验；每次调用写入审计；错误信息脱敏。

### Phase 7：业务服务迁移

新增 `HarnessRunService`，将 `DraftService`、`ReviseService`、`ReviewService`、`CompletionService`、`MemoryService`、`AgentTaskService` 的模型调用统一改为：

```text
业务服务 → HarnessRunService → HarnessAdapter
```

统一流程：加载上下文 → 解析 Skill → 创建/恢复 Session → 发送结构化消息 → 收集事件 → 解析结构化结果 → 确定性校验 → 生成 ChangeSet → 用户审批。

业务结果使用结构化类型：`DraftPlanResult`、`DraftFilesResult`、`RevisionProposalResult`、`ReviewReportResult`、`MemoryResult`、`CompletionResult`。

### Phase 8：API、WebSocket 与前端

增加 Harness、Session、Run、Approval API，并提供 `workspace`、`sessions`、`runs:<id>`、`approvals`、`harnesses`、`skills`、`mcp` WebSocket topic。

前端改为乐观显示用户消息、实时显示 assistant delta/工具调用/Skill 状态/审批卡片，并支持断线恢复；现有 ChangeSet 审阅界面保留。

### Phase 9：兼容与切换

短期保留 `OpenAIAgentProvider` 作为 legacy adapter，通过 `FASTWRITE_HARNESS=claude|codex|legacy` 切换。所有业务服务改依赖统一 `AgentGateway`，待两种 Harness 和 E2E 验收后移除 legacy Provider。

## 测试计划

### 单元与 Adapter

- 协议 schema、事件排序/去重、Session/Run 状态机、slot 限制。
- Skill manifest、digest、冲突、路径安全。
- MCP 参数 schema、权限拒绝和审计。
- Fake Claude SDK 与 Fake Codex app-server：流式输出、审批、取消、恢复、进程退出和 malformed event。
- `/draft` 占位内容硬拒绝。

### Chrome MCP E2E

创建项目 → 输入 `/draft` → 流式计划 → 审阅 outline → 生成 ChangeSet → 检查无占位符 → 接受文件 → 编译 PDF → Review → Issue Resolution → 修订 → 重新编译 → targeted re-review → 刷新并恢复 Session。

### 真实 Harness Smoke

分别运行 Codex 和 Claude Harness smoke，输出 Session、Run、Skill、Tool、Approval 审计摘要，不输出 Prompt、API key 或论文全文。Harness 不可用时必须显示 degraded 状态。

## 里程碑与验收

1. Harness protocol、Fake adapter、事件模型。
2. Skill Registry 与全部 Prompt 迁移。
3. Codex app-server adapter。
4. Claude Agent SDK adapter。
5. MCP Registry、权限与审批。
6. 业务服务、WebSocket、前端和 Chrome E2E 全面切换。

最终验收：

- 业务代码不直接 import `openai`。
- 所有 LLM 工作流 Prompt 来自 Skill。
- 每个 Run 有不可变 Skill snapshot、Harness/Session/MCP 审计。
- 支持流式响应、取消、恢复和审批。
- `/draft` 永远拒绝 TODO 与模板占位内容。
- Harness 不可用时真实显示 degraded。
- Claude/Codex provider 细节完全隔离在 adapter。
- Chrome MCP 能完成从创建项目到编译成稿的完整流程。
- 现有测试保持通过，并新增 Harness、Skill、MCP 和 E2E 测试。
