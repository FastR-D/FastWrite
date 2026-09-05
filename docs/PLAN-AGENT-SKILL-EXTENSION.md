# Agent 与 Skill 扩展规划

## 现状验收

### Revise

- 前端入口：`Revise` 工作区、段落/选区上下文、快捷操作和自由文本指令。
- API：`POST /api/projects/:projectId/revisions`，服务端生成候选 ChangeSet；接受、拒绝、逐 hunk 决策和继续对话均有接口。
- Harness：通过统一 `revise` 操作调用当前 Harness，使用 `{"replacement":string,"rationale":string}` 契约。
- 已验证：版本校验、候选不直接写文件、接受后编译联动、旧 provider 错误不再出现。
- 待补：浏览器 MCP 需要实际选择文本后验证一次 Revise；空选区、过期 fileVersion、跨文件选区需要明确可见错误。

### Agent

- 前端入口：`Agent` 工作区和 `/draft`、`/continue`、`/revise` 意图按钮。
- API：创建计划、确认计划、生成 ChangeSet、逐 hunk 接受/拒绝、取消计划、恢复未完成计划。
- Harness：计划使用 `planAgentTask`，执行使用 `generateAgentTask`；两阶段均携带领域 Skill、工作流 Skill、Memory 和 venue 约束。
- 已验证：计划→确认→生成→接受→编译的完整链路；作用域限制和工作区版本冲突保护有效。
- 待补：浏览器 MCP 分别验证三种意图、取消/恢复、空计划和越界文件错误。

## 目标架构

Agent Skill 采用三层组合，所有层都由服务端加载并记录版本/digest：

1. **领域 Skill**：研究领域术语、论证标准、常见风险和证据边界。
2. **工作流 Skill**：draft、revise、review、completion、memory 等固定流程契约。
3. **任务 Skill**：用户在 Agent 中选择的可组合能力，例如“补齐威胁模型”“设计实验方案”“整理相关工作”“检查引用完整性”。

任务 Skill 不直接写文件，必须声明：

- `id`、`version`、`description`、`supportedIntents`
- `inputSchema` 和 `outputSchema`
- `allowedScope`（项目、文件、章节）
- `requiredEvidence`、`validationCommands`、`riskLevel`
- 是否允许新建文件、是否要求 Review 后才能接受

## 第一批任务 Skill

按优先级实现：

1. `threat-model`: 资产、对手、信任边界、假设和安全属性。
2. `experiment-design`: 变量、基线、指标、重复次数、统计方法和失败条件。
3. `related-work-map`: 主题分组、差异点、引用缺口和 BibTeX 需求。
4. `claim-audit`: claim/evidence 对齐、过度声明和不可验证结果。
5. `latex-structure`: section 层级、交叉引用、图表/公式和编译安全。

## API 与数据变更

- 新增 `GET /api/agent-skills`：返回可用任务 Skill 的元数据，不返回不必要的完整指令。
- 扩展 Agent 计划请求：`taskSkillIds`、`skillOptions`、`validationMode`。
- 计划保存选中的 Skill 元数据和 digest；确认时拒绝已变更的 digest，要求重新规划。
- Harness prompt 明确要求返回任务 Skill 的结构化结果，并由服务端 schema 校验、边界裁剪和路径检查。
- Agent Run auditTrail 记录 Skill 加载、证据读取、验证命令和接受决策。

## 前端流程

1. Agent 面板展示任务 Skill 卡片和适用意图。
2. 用户选择 Skill 后显示范围、风险、所需证据和预计变更文件。
3. 创建计划前检查范围和必需证据；计划页显示 Skill 版本/digest。
4. 确认后执行，结果仍进入 ChangeSet，不直接写文件。
5. 接受前显示验证状态；高风险 Skill 强制 Review 或编译通过。

## 验收矩阵

- Revise：有选区、段落回退、空选区、过期版本、接受/拒绝、继续对话、编译。
- Agent：三种意图、五种任务 Skill、项目/文件/章节作用域、取消/恢复、越界路径、空输出、冲突恢复。
- Harness：Codex/Claude 配置读取、单次模型覆盖、事件流、失败/取消、结构化 JSON 容错。
- 安全：Skill digest 固定、路径白名单、证据边界、敏感信息不进入 prompt 或日志。
- 质量：Server/Web TypeScript、全量测试、Chrome MCP 每个关键流程至少一次。

## 实施顺序

1. 抽象 `AgentTaskSkill` 类型、目录约定和 SkillRegistry catalog。
2. 实现五个任务 Skill 及 schema/验证器。
3. 扩展 Agent API、持久化计划和审计字段。
4. 增加 Agent 面板选择器和确认前验证展示。
5. 增加服务端单测与 Chrome MCP 验收脚本。
