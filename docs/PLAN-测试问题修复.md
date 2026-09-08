# 测试问题修复计划

> 来源：`docs/测试/测试记录.md`，结合 2026-09-04 `main` 分支代码核对。
> 目标：先恢复 LaTeX 导入/编译和 Agent 执行稳定性，再补齐可发现性和配置体验。

## 一、问题结论

### P0：LaTeX 缺包修复链路不可靠

- 中文模板缺少 `CJKutf8.sty`；ACM/Usenix 模板缺少 `algpseudocode.sty`。
- `Repair cache` 后仍失败，说明问题不一定是缓存，可能是包名映射、下载、解压、安装路径或 BusyTeX 搜索路径。
- 复杂模板首次编译约 50 秒，当前需要更明确的资源下载和编译阶段进度，避免被误判为卡死。

### P0：Agent 执行超时且范围控制不足

- 中文任务容易从“只扩展 Introduction”扩大到整篇论文。
- 英文明确约束后 Planning 改善，但单文件生成仍可能在 300 秒默认超时内无法返回可审批结果。
- `sample.bib` 出现 `exactly one non-empty file`，需区分模型输出协议、JSON 解析、文件校验和合并逻辑问题。
- 当前执行倾向让模型一次性生成完整文件，长 LaTeX 文件使上下文和结构化输出风险偏高。

### P1：Provider/模型兼容性和语言偏好不透明

- 不同模型表现差异尚未能定位为模型能力还是 FastWrite 解析链路。
- 结构化 JSON、LaTeX 转义、代码围栏、截断响应等情况缺少兼容性测试矩阵。
- 用户希望中文交流；当前没有持久化的语言偏好。

### P1：已有功能可发现性不足

- 项目删除 API 已存在，但测试中未发现前端入口。
- 当前有源码快照导出和 PDF 预览，但没有明显的“下载当前 PDF”入口。
- API key 不应持久化；base URL、model、wire API 可以作为非敏感配置回填。

## 二、实施顺序

## 阶段 1：LaTeX 依赖与修复链路（P0）

### 任务

1. 建立缺包 fixture 和自动化测试：`CJKutf8.sty`、`algpseudocode.sty`、`.cls`、`.bst`、字体包、嵌套依赖。
2. 记录依赖解析过程：检测到的文件名、映射到的 TeX Live/CTAN 包、下载 URL、缓存位置和安装结果。
3. 将错误拆分为：索引缺失、上游失败、压缩包/解压失败、安装路径错误、搜索路径错误、格式/引擎缺失。
4. 将 `Repair cache` 改为“清理后重新验证”：清理缓存、刷新 manifest、预下载当前源码依赖，并报告仍缺少的包。
5. 增加重复编译和损坏缓存恢复测试。

### 验收

- 中文模板连续编译 3 次成功。
- ACM/Usenix 模板修改正文后连续编译 3 次成功。
- 修复失败时明确显示具体包名和失败阶段。
- 首次下载期间展示可理解的阶段和进度。

## 阶段 2：Agent 作用域与执行稳定性（P0）

### 任务

1. Planning 保存硬性 scope：允许文件、允许 section、禁止 section、最大变更规模、是否允许新增 citation/数字/文件。
2. Execution 前后做 scope 校验；越界时生成可审阅的失败结果，不创建越界 ChangeSet。
3. 优先改为 section/局部 hunk 生成，服务端合并；完整文件生成作为兼容模式。
4. 为请求、首 token、完整 JSON、schema 校验设置阶段状态和超时；可重试的网络错误最多自动重试一次。
5. 为单文件、多文件、空文件、多文件返回、Markdown 包围 JSON、截断 JSON 增加协议测试。
6. 记录 Provider、model、耗时、返回大小、截断状态、解析错误位置、scope 校验结果。

### 验收

- “只修改 Introduction”不会修改其他 section、注释、作者信息、引用或 bibliography。
- 单文件任务在合理时间内生成可审批 ChangeSet；超时错误包含明确阶段。
- `exactly one non-empty file` 能定位到具体校验原因。
- 同一任务可重复执行，失败不会留下半成品变更。

## 阶段 3：Provider 兼容性与中文偏好（P1）

### 任务

1. 建立 DeepSeek、GLM 和默认 Provider 的兼容性矩阵。
2. 统一结构化输出解析和错误分类，处理代码围栏、额外文本、LaTeX 转义和截断。
3. 增加语言偏好：跟随用户、中文、English；写入 Revise、Review、Agent prompt。
4. 仅持久化 base URL、model、wire API；API key 只保留在运行时。

### 验收

- 每个 Provider 的失败都能区分模型输出不合规与 FastWrite 解析失败。
- 用户选择中文后，AI 解释和状态消息使用中文；论文正文语言仍遵循用户任务要求。
- 重启页面后非敏感配置可回填，API key 不落盘。

## 阶段 4：功能可发现性和回归验收（P1/P2）

### 任务

1. 在项目列表或项目设置增加删除项目入口，二次确认并说明恢复语义。
2. 在 PDF 预览工具栏增加下载当前成功编译 PDF。
3. 增加项目删除、PDF 下载、配置回填的 E2E 测试。
4. 将测试记录转为逐项验收表，记录复现步骤、修复版本和回归结果。

## 三、暂不作为首轮修复

- 不先简单提高 Agent 总超时时间；应先降低单次生成复杂度并改善阶段诊断。
- 不保存完整 PDF 或 API key。
- 不把 Research 已验证的检索能力作为当前阻塞项；出版平台直连属于后续增强。
- Memory 延迟需要单独做性能基准，不与当前 LaTeX/Agent 稳定性混修。

## 四、首轮交付定义

首轮完成条件：阶段 1 和阶段 2 的自动化测试通过；两类缺包模板和 Introduction 单文件任务完成回归；失败结果包含可定位诊断；不引入 API key 持久化或超出用户 scope 的自动修改。

## 五、剩余问题的详细落地方案

### 5.1 LaTeX 缺包与 Repair cache

#### 实施步骤

1. 建立两个最小真实 fixture：一个使用 `CJKutf8.sty`，一个使用 `algpseudocode.sty`，都覆盖首次编译、修改正文后再次编译、清缓存后重编译和损坏缓存恢复。
2. 校验文件名到包名的映射，优先使用 `file-to-package.json`、TeX Live 文件数据库和 CTAN metadata，不能只按 style 文件名拼接包名。重点确认 `CJKutf8.sty -> CJK/cjk`、`algpseudocode.sty -> algorithmicx`。
3. 对每个依赖记录检测文件、解析包、下载地址、解压文件、安装路径和最终搜索路径，重点排查 TDS ZIP 多嵌套目录。
4. 将 Repair cache 改为：清理缓存、刷新 manifest、重扫源码依赖、下载所需包、验证文件存在、再触发编译。
5. 返回结构化修复结果：`repaired`、`requiredPackages`、`installedFiles`、`missingFiles` 和按 `lookup/download/extract/install/verify` 分类的失败信息。
6. 使用 Playwright 验证新上下文首次编译、点击 Repair、自动重编译、刷新后复用缓存以及上游失败提示。

#### 完成门槛

- 两个 fixture 各连续编译 3 次成功。
- Repair 后无需手动刷新页面即可成功编译。
- 错误同时包含缺失文件、候选包和失败阶段。
- 缓存复用、缓存损坏恢复和上游不可用均有自动化覆盖。

### 5.2 Agent section 级硬约束、局部 hunk 与阶段性超时

#### 请求契约

将 scope 扩展为：

```ts
scope: {
  type: "file" | "section" | "project";
  path?: string;
  section?: { heading: string; level?: number; startLine?: number; endLine?: number };
  forbiddenPaths?: string[];
  forbiddenSections?: string[];
  maxChangedLines?: number;
  allowNewCitations?: boolean;
  allowNewNumbers?: boolean;
}
```

前端从 outline 或编辑器选区提交 section，不依赖自然语言推断。Planning 必须持久化允许文件、允许 section、禁止文件/section、最大变更规模和 citation/number/file 策略。

#### 执行与校验

1. 普通 revise 优先提取目标 section，模型只返回 section replacement 或 patch；完整文件生成仅保留给 draft/兼容模式。
2. 生成前验证路径、目标 section 和 scope；生成后验证 diff 未跨越 section 边界、非目标区域 hash 不变、变更行数未超限、无禁止 citation/数字/文件。
3. 校验失败不创建 ChangeSet、不写入工作区，保留可诊断的失败结果。
4. 输出协议采用 `{ path, section, replacement, rationale }`，专门测试空文件、多文件、路径不符、截断 JSON 和 Markdown 包围 JSON。

#### 阶段性超时

拆分为连接 15 秒、首 token 45 秒、stream idle 30 秒、单文件完整输出 180 秒、多文件总任务上限 600 秒、解析/校验 10 秒。Agent run 记录 `phase`、开始时间、结束时间和状态；网络错误最多重试一次，schema 或 scope 错误不盲目重试。

#### 完成门槛

- “只修改 Introduction”在服务端保证其他 section、作者、注释、引用和 bibliography 不变。
- 超时能指出具体阶段。
- 失败不会留下半成品文件或 ChangeSet。
- `exactly one non-empty file` 能指出具体违反字段。

### 5.3 Provider 兼容性矩阵

覆盖默认 OpenAI-compatible Provider、DeepSeek、GLM、Codex Harness 和 Claude Harness。使用脱敏固定 fixture 分四层验证：协议格式、Planning 字段、Execution 单/局部/多文件输出、语义安全（scope、citation、数字、LaTeX 注释）。

CI 输出 provider/model/operation、协议成功率、scope 成功率、schema 成功率、citation/数字安全和 timeout 分类。失败必须归类为 Provider 请求、响应截断、格式不兼容、FastWrite 解析、scope 校验或合并失败；不得只显示统一的 Agent failed。不得保存 API key、完整论文或敏感 prompt。

### 5.4 中文回复偏好

增加 `responseLanguage: "auto" | "zh-CN" | "en-US"`。`auto` 根据用户最近消息选择语言；该设置只影响解释、计划、Review、Research 和错误信息，不改变论文正文语言，除非任务明确要求。配置保存在前端 `localStorage`，请求携带至服务端，统一注入 Revise、Agent、Review、Research 和 Compile Repair prompt。测试中文消息、英文正文、强制中文、刷新后保持和敏感信息不泄漏。

### 5.5 真实浏览器 E2E

固定 Chromium、Firefox、WebKit，新上下文和已有缓存两种状态，覆盖在线及模拟上游失败。核心流程包括：中文/ACM 模板导入、缺包 Repair、修改后重编译、PDF 下载、Introduction section Agent 计划/执行/审批、越界修改拒绝、项目删除确认/取消/刷新、非敏感配置回填和中文回复偏好。

E2E 门槛：Repair 后编译成功，下载文件存在且 MIME 为 `application/pdf`，删除后项目不可打开，越界 Agent 修改被服务端拒绝，API key 不出现在 localStorage、网络响应或导出包中，三种浏览器关键流程结果一致。

## 六、后续实施批次

1. **批次 A：LaTeX**：先完成真实 fixture、包映射、安装路径、Repair 验证和浏览器回归。
2. **批次 B：Agent**：扩展 scope 契约，落地 section 提取、局部 patch、hash 校验和阶段性 timeout。
3. **批次 C：Provider**：建立录制响应矩阵和异常格式分类，不依赖真实 API 才能运行。
4. **批次 D：语言偏好**：完成设置、prompt 注入、状态文案和持久化测试。
5. **批次 E：发布门禁**：串联 Chromium/Firefox/WebKit 全量 E2E。

批次 A 和 B 是稳定性阻塞项，应先于 C、D、E；不能通过单纯延长总 timeout 或只增加 UI 提示替代服务端校验和真实编译验证。
