# Harness Settings 全量迁移规划

## 目标

移除 Project Settings 中的 Agent provider 概念和旧 OpenAI provider 配置体系，所有模型调用统一经过 Claude/Codex Harness。设置页负责选择 Harness、模型和运行参数；开发模式保留 Vite 前端，不执行前端构建。

## 目标架构

```text
Project Settings
      |
      v
Harness Settings API
      |
      v
HarnessRegistry -> ClaudeHarnessAdapter / CodexHarnessAdapter
      |
      v
HarnessRunService
      |
      v
Draft / Review / Revise / Memory / Completion / AgentTask
```

业务服务只依赖统一 `AgentGateway` 或 `HarnessRunService`，不得直接依赖 OpenAI SDK、OpenAI wire API 或 provider 配置解析器。

## HarnessSettings

```ts
interface HarnessSettings {
  harness: "claude" | "codex";
  model?: string;
  apiKey?: string;
  baseURL?: string;
  wireAPI?: "responses" | "chat";
  timeoutMs?: number;
}
```

约束：

- `harness` 默认 `codex`，不再接受 `legacy`。
- `model` 是默认模型，单次 `SendMessageInput.model` 可覆盖。
- API key 只保存在运行时内存，不写入项目文件或 API 响应。
- `timeoutMs` 限制在 1 秒至 10 分钟。
- `baseURL` 必须是 HTTP/HTTPS 绝对 URL。
- `wireAPI` 仅作为需要远程兼容接口的 Harness 参数。

## API

保留并规范化：

- `GET /api/harness-settings`：返回 Harness 类型、脱敏状态、模型、Base URL、Wire API、超时、能力和版本。
- `PUT /api/harness-settings`：更新运行时配置；API key 只接受输入，不返回。
- `POST /api/harnesses/:kind/sessions`：创建 Harness 会话。
- `POST /api/harnesses/:kind/sessions/:sessionId/messages`：发送消息，支持 `model` 覆盖。
- `GET /api/harnesses`：返回每个 Harness 的状态和能力。

删除：

- `/api/agent-settings` 路由。
- `AgentSettingsInput`、`AgentSettingsBaseline` 和 provider 专用解析接口。

## 前端设置页

Project Settings 的 Harness 区域只显示：

1. Harness 类型：Codex / Claude。
2. Model。
3. API key。
4. Base URL。
5. Wire API。
6. Timeout。
7. Harness 状态、版本和能力。
8. 测试连接按钮。

移除：

- “Agent provider” 文案。
- “OpenAI-compatible” 文案。
- Codex TOML/YAML provider 配置文本框。
- `parseCodexProviderConfig` 及相关 UI 测试。

## 服务端改造

### 配置和启动

- 新增 `harnessSettings()` 配置解析。
- `createApplication()` 按 `harness` 创建并注册适配器。
- 运行时更新设置后重建或更新适配器配置。
- 默认模型和超时由 `HarnessRunService` 注入。

### 业务调用

- Draft、Review、Revise、Memory、Completion、AgentTask 全部通过 Harness Gateway。
- 删除业务服务中的 `provider` 解包逻辑。
- 每个 Run 保存 Harness、模型和配置快照。
- Harness 不可用时返回明确的 degraded/unavailable 状态。

### 适配器

Codex 和 Claude 适配器都支持：

- 默认模型。
- 单次模型覆盖。
- 超时和取消。
- Skill snapshot。
- MCP 工具调用。
- Approval 请求和恢复。

## 配置变量

统一使用：

- `FASTWRITE_HARNESS=codex|claude`
- `FASTWRITE_HARNESS_MODEL`
- `FASTWRITE_HARNESS_API_KEY`
- `FASTWRITE_HARNESS_BASE_URL`
- `FASTWRITE_HARNESS_WIRE_API=responses|chat`
- `FASTWRITE_HARNESS_TIMEOUT_MS`

删除 `FASTWRITE_OPENAI_*`、`OPENAI_*` 及按 workflow 的 provider 配置读取；迁移期间只提供一次性兼容提示，不继续写入新状态。

## 开发端口

- Vite 前端：`3002`。
- API 服务：`3003`。
- `scripts/dev.ts` 同时启动两者，Vite 通过 proxy 转发 `/api`。
- 不运行 `vite build`，不提交或依赖静态构建产物。

## 实施阶段

### 阶段一：设置模型和 API

- 新增 Harness Settings 类型、校验和 API。
- 前端设置页改用 Harness 字段。
- 删除 Agent provider 文案和 provider config 解析器。

### 阶段二：适配器配置

- Claude/Codex adapter 接收默认模型、超时和运行时配置。
- Harness Registry 支持配置更新和状态探测。
- 补充连接测试和模型透传测试。

### 阶段三：业务服务迁移

- 统一 AgentGateway 接口。
- 迁移 Draft、Review、Revise、Memory、Completion、AgentTask。
- 删除所有 `AgentProvider` 解包和直接调用。

### 阶段四：删除旧体系

- 删除 `OpenAIAgentProvider`、provider wire API 实现及测试。
- 删除 legacy 类型、路由、环境变量和兼容代码。
- 更新 README、示例环境文件和部署文档。

### 阶段五：验收

- Harness Settings API 测试。
- Settings UI 保存、刷新、脱敏测试。
- Codex/Claude smoke 测试。
- Skill、MCP、Approval、取消、超时和恢复测试。
- `bun test` 全量通过。
- `bun run dev` 验证 Vite `3002` 与 API `3003`。

## 完成标准

- 仓库中不再出现面向用户的 Agent provider 设置。
- 业务模型调用不再直接依赖 OpenAI provider。
- 所有 Run 均可追踪 Harness、模型和 Skill snapshot。
- API key 不回传、不落盘。
- Vite 开发模式可直接运行，无需 build。
