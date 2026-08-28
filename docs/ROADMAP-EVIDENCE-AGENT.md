# FastWrite：证据驱动论文写作实施路线图

> 状态：经 Sol 架构审查后修订。
>
> 目标：在现有 Completion、统一 AgentTask、Revise、Review、Paper Memory、ChangeSet、Compliance 和 SkillRegistry 基础上，建设“文献 → 证据 → 论断 → 引用 → 修改 → 复检”的闭环。

## 1. 决策与边界

### 1.1 明确不建设的能力

- 不计算或保存 PDF SHA-256。
- 不持久化编译 PDF、PDF 页面图或 PDF 文本 artifact。
- 不冻结 PDF、Review 输入或 ReviewSnapshot。
- 新 Review 不再创建冻结 ReviewSnapshot；旧数据只做兼容读取。
- 不把旧 Review 描述为可复现的历史 PDF 审稿结果。
- 不自动接受 Agent 修改，不自动把检索结果或引用写入正文。
- 不把复杂多 Agent swarm 作为首要架构。

这里的“不持久化 PDF”特指论文编译产物。用户主动导入作为研究资料的 PDF 可以按普通 Workspace 文件保存；解析或发送给模型必须取得明确授权并受资源限制。

### 1.2 保留的现有机制

- Workspace 继续作为论文正文真相。
- 文件版本和项目版本继续用于保存、ChangeSet、编译和并发编辑安全，但不扩展为 PDF 冻结链路。
- Agent 与 Revise 继续通过 ChangeSet 和 hunk 审批写入。
- 主界面继续使用统一 `AgentTaskService`；旧 `DraftService` 只保留兼容职责。
- Skill 继续采用当前 domain + venue + manuscript stage 的组合方式。
- Paper Memory 继续只接纳有来源、经过用户审核的内容。

### 1.3 新 Review 契约

```text
Current Workspace source
  + optional transient PDF preview text
  + Skill / venue rules
  -> Review passes
  -> ReviewReport + evidence excerpts
```

- Review 以请求发生时读取到的当前源码为主要输入。
- 浏览器可以从当前 PDF 预览临时提取有界页面文本，随 Review 请求传入；服务端只在该请求内使用，不落盘、不入库、不写日志。
- 没有 PDF 页面文本时自动降级为源码 Review，并在报告中显示实际输入类型。
- ReviewReport 只持久化意见、必要证据摘录、输入类型和时间。
- Workspace 后续发生修改时，历史报告仍可查看，但 UI 标记“可能已过时”。
- Targeted re-review 检查当前内容是否解决指定问题，不宣称重现历史输入。

该契约与当前 `DESIGN.md`、`DEV.md`、`RDA.md` 的冻结 PDF 要求互斥，因此 M0 必须先同步三份文档和相关测试。

## 2. 目标架构

```text
Workspace / Editor
  -> Citation & Claim analyzers
  -> ResearchService
       -> Crossref / OpenAlex / later providers
       -> metadata cache and bounded evidence excerpts
  -> Compliance rule registry
  -> AgentTask / Revise
       -> ChangeSet
       -> hunk validation findings
       -> user approval
  -> Multi-pass Review
       -> issue resolution
       -> targeted re-review of current content
```

### 2.1 复用现有模块

| 新能力 | 现有落点 |
| --- | --- |
| 引用真实性和 claim 检查 | 扩展 `ComplianceService`，不另建平行 compliance 框架 |
| 结构化初稿与证据缺口 | 扩展 `AgentTaskRequest` / `AgentTaskPlan` |
| BibTeX 应用 | 生成现有 ChangeSet，不由 ResearchService 直接写文件 |
| Review 问题修复 | 复用 Revise / Agent 和 IssueResolution |
| Venue 可执行规则 | 扩展现有 SkillRegistry 和 venue Markdown/sidecar |
| 证据审查 | 作为 ChangeSet hunk finding 和 Review pass 输入 |

## 3. 数据与状态模型

以下为目标语义模型；实现时放入 `packages/shared`，并在 `JsonDatabase.DatabaseState` 增加对应集合。

### 3.1 文献实体与元数据来源

同一论文可能同时来自 Crossref、OpenAlex、Semantic Scholar 和 arXiv，不能把“论文”和“查询来源”混为一个字段。

```ts
interface ResearchWork {
  id: string;
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  metadataStatus: "candidate" | "verified" | "conflicting" | "unresolved";
  publicationStatus: "normal" | "corrected" | "retracted" | "unknown";
  createdAt: string;
  updatedAt: string;
}

interface ProjectResearchWork {
  projectId: string;
  workId: string;
  status: "candidate" | "saved" | "rejected";
  citationKey?: string;
  createdAt: string;
  updatedAt: string;
}

interface ResearchIdentifier {
  workId: string;
  scheme: "doi" | "arxiv" | "openalex" | "semantic-scholar" | "url";
  value: string;
}

interface MetadataObservation {
  id: string;
  workId: string;
  provider: "crossref" | "openalex" | "semantic-scholar" | "arxiv" | "publisher" | "user";
  fields: Record<string, string | number | string[]>;
  fetchedAt: string;
}
```

规范论文去重优先级：DOI → arXiv ID → provider ID → 归一化标题、第一作者和年份。元数据冲突不得静默覆盖，必须保留 observation 并将 work 标为 `conflicting`。

### 3.2 证据

```ts
interface SourceEvidence {
  id: string;
  projectId: string;
  workId: string;
  kind: "background" | "claim" | "method" | "result" | "limitation" | "quote";
  origin: "source-text" | "registry-abstract" | "model-extraction" | "user";
  representation: "verbatim" | "paraphrase";
  status: "candidate" | "approved" | "rejected" | "stale";
  content: string;
  locatorType: "page" | "section" | "paragraph" | "abstract";
  locator: string;
  createdByRunId?: string;
  approvedAt?: string;
  createdAt: string;
  updatedAt: string;
}
```

规则：

- “元数据已验证”不等于“claim 证据已验证”。
- 注册表摘要可以支持背景筛选，不能单独支撑详细方法、结果或限制。
- 模型提炼内容默认是 candidate；只有用户批准后才可进入 Paper Memory 或作为 Agent 的事实依据。
- verbatim excerpt 必须设置长度上限并保留 locator。

### 3.3 Claim 和稳定锚点

`path + line` 会随编辑漂移，Claim 必须保存可重定位锚点。

```ts
interface ClaimAnchor {
  path: string;
  fileVersion: number;
  startOffset: number;
  endOffset: number;
  exactText: string;
  prefix: string;
  suffix: string;
}

interface PaperClaim {
  id: string;
  projectId: string;
  anchor: ClaimAnchor;
  type: "background" | "contribution" | "method" | "result" | "comparison" | "limitation";
  reviewStatus: "detected" | "needs-review" | "supported" | "partial" | "unsupported";
  anchorStatus: "current" | "stale" | "reanchored" | "orphaned";
  createdBy: "user" | "agent" | "scanner";
  createdAt: string;
  updatedAt: string;
}

type ClaimEvidenceLink =
  | { id: string; claimId: string; kind: "literature"; evidenceId: string; citationKey?: string }
  | { id: string; claimId: string; kind: "workspace"; path: string; anchor: ClaimAnchor }
  | { id: string; claimId: string; kind: "review-waiver"; reason: string; approvedByUser: true };
```

Claim 的支持状态由当前有效 link 计算，模型不能直接把 claim 标为 supported。保存文件、接受 ChangeSet、重命名或删除文件后，相关 claim 必须重新定位或变为 stale/orphaned；禁止静默指向错误文本。

### 3.4 运行状态机

```text
ResearchRun:
  planned -> running -> completed
          -> cancelled
          -> failed

Evidence:
  candidate -> approved
            -> rejected
            -> stale

ClaimScanRun:
  queued -> running -> completed
                   -> failed
                   -> cancelled

Claim anchor:
  current -> stale -> reanchored
                   -> orphaned

Review issue:
  open -> planned -> in_revision -> needs_review -> resolved
       -> dismissed (requires reason)
  resolved -> reopened
```

所有转换由服务层集中验证，HTTP PATCH 不能任意写状态。

### 3.5 ChangeSet 验证结果

Prompt 中的“不要新增未验证引用”不是充分门禁。生成候选后必须检查新增 citation、BibTeX、数字和强 claim。

```ts
interface HunkFinding {
  id: string;
  source: "claim" | "citation" | "review" | "compliance";
  referenceId: string;
  status: "pass" | "warning" | "blocking";
  message: string;
}
```

- finding 绑定到 TextHunk，显示在现有审批界面。
- 有 blocking finding 时禁止普通 Accept。
- 若产品允许用户覆盖，必须使用单独的显式确认并记录理由；不得把普通 Accept 当作覆盖授权。

## 4. 存储、迁移与容量边界

当前 `JsonDatabase` 每次 mutation 会重写整个 `database.json`，不能直接保存整篇文献文本、嵌入向量、API 原始响应或无限增长的运行记录。

### 4.1 M0 必须增加

- `schemaVersion` 和按版本执行的显式迁移函数。
- 旧数据库无损升级、迁移失败保留原文件、重新启动可恢复。
- JSON 只保存规范元数据、短证据摘录、状态和关联。
- 项目删除时级联清理 Research、Evidence、Claim 和运行记录。
- 对每项目文献数、证据数、单条摘录长度和运行历史数量设置可配置上限。
- 对高频 claim 扫描结果批量写入，避免每条 finding 单独 flush。

### 4.2 暂不引入

- 全文向量索引。
- 把 PDF 文本写入 `database.json`。
- 保存第三方 API 的完整原始响应。
- 未经测量即引入新的数据库产品。

只有 M5 验证全文检索确有必要且 JSON 结构无法承载时，再为索引设计独立存储；Workspace 和 JSON Database 的正文/状态职责保持不变。

## 5. 服务、API 与 Provider 边界

### 5.1 ResearchService

ResearchService 负责外部检索、规范化、去重、缓存和候选生成；不直接修改 `.tex` 或 `.bib`。

首批内部工具：

```text
search_works(query)
resolve_identifier(identifier)
compare_metadata(workId)
extract_citation_context(projectId, citationKey)
propose_bibtex_change(workId, targetBibPath)
```

BibTeX 应用必须生成 ChangeSet 并经过现有审批流程。

### 5.2 最小 API

```text
POST   /api/projects/:id/research-runs
POST   /api/projects/:id/research-runs/:runId/confirm
POST   /api/projects/:id/research-runs/:runId/cancel

GET    /api/projects/:id/research-works
POST   /api/projects/:id/research-works/import
PATCH  /api/projects/:id/research-works/:workId

GET    /api/projects/:id/evidence
PATCH  /api/projects/:id/evidence/:evidenceId

POST   /api/projects/:id/claim-scans
GET    /api/projects/:id/claims
PATCH  /api/projects/:id/claims/:claimId
POST   /api/projects/:id/claims/:claimId/links
DELETE /api/projects/:id/claims/:claimId/links/:linkId

POST   /api/projects/:id/research-works/:workId/bibtex-changes
```

所有请求必须有运行时校验。共享 TypeScript interface 只提供编译期类型，不能替代 HTTP 输入校验；M0 应引入统一 schema 库或集中式解析函数。

### 5.3 Provider 配置

在现有 completion、agent、revise、review、memory 之外增加 `research` 工作流配置：

```text
FASTWRITE_RESEARCH_API_KEY
FASTWRITE_RESEARCH_BASE_URL
FASTWRITE_RESEARCH_MODEL
```

元数据搜索和确定性检查不依赖 LLM。LLM 仅用于查询规划、候选证据提炼和语义审查；未配置 Research Provider 时，手工搜索、元数据验证和审批流程仍可工作。

## 6. 临时 PDF 预览输入

如果 M6 保留 PDF 辅助 Review，采用请求期通路：

```text
PdfPane
  -> 使用现有 pdfjs 提取有界 pageText[]
  -> ReviewDialog 随请求提交
  -> ReviewService 只在内存中使用
  -> 请求结束立即丢弃
```

约束：

- 不上传完整 PDF。
- 不保存 pageText、页面图、哈希或 PDF artifact。
- 限制页数、单页字符数和总请求体大小。
- pageText 不进入数据库、Agent audit trail 或日志。
- 缺少 pageText 时降级为源码 Review。
- `ReviewEvidence.page` 仅作为当前预览中的辅助定位。

建议的 ReviewEvidence：

```ts
interface ReviewEvidence {
  path?: string;
  line?: number;
  excerpt: string;
  page?: number;
  source: "latex" | "pdf-preview" | "citation" | "compliance";
  inferred: boolean;
}
```

`path` 改为可选时，必须同步修改 Review UI 的文件筛选、跳转按钮、Agent 路由和序列化兼容逻辑。

## 7. Skill 与 Compliance 演进

保留现有目录：

```text
skills/
  _shared/
  <domain>/
    SKILL.md
    references/
      profile.md
      venues/
        <venue>.md
        <venue>.rules.json   # 可选 sidecar
```

组合关系固定为：

```text
academic base
  + 一个 research domain
  + 一个 publication venue
  + 一个 manuscript stage
```

不支持同时叠加多个 venue overlay。实施路径：

1. 将现有 `ComplianceService` 中的确定性检查拆成规则注册表。
2. SkillRegistry 加载 venue frontmatter 或同目录 rules sidecar。
3. 规则返回稳定 ID、状态、证据、来源 URL、适用阶段和修复建议。
4. 首批为现有 AI、安全、HCI Skill 补充 fixture 和可执行规则，不重新建设领域体系。

优先检查：citation/BibTeX、TODO、required sections、anonymity、template、page limit、figure/table/cross-reference、Abstract 与结果数字一致性，以及强 claim 证据提示。

模型判断“引用是否支持 claim”默认只能产生 `unresolved`；只有确定性规则或用户确认才能产生阻塞性事实结论。

## 8. Agent、Revise 与 Review 的产品约束

### 8.1 统一 AgentTask

- 结构化 research brief 扩展现有 `AgentTaskRequest`，不新建 Draft Agent 状态机。
- Plan 同时返回 affected files、validation、evidence dependencies 和 missing evidence。
- 用户只需一次确认 Plan，然后生成 ChangeSet。
- 旧 `DraftService` 不承载新能力。

```ts
interface EvidenceDependency {
  step: string;
  requiredClaimIds: string[];
  missingEvidence: string[];
}
```

### 8.2 Revise

不新增 Clarity、Evidence-aware、Reviewer response 三个顶层模式或 Tab。它们作为内部 `revisionPolicy`：

- 默认 UI 仍是一个 Revise 输入框。
- 快捷按钮只填充指令和约束。
- 从 Review Issue 发起时自动使用 reviewer-response policy。
- policy 改变 Provider 约束和生成后验证，不建立新产品入口。

### 8.3 Review

```text
Pass A: deterministic mechanical/compliance
Pass B: claim/citation evidence
Pass C: domain review
Pass D: venue review
Pass E: synthesis and deduplication
Pass F: issue resolution and targeted re-review
```

- Pass A/B 不依赖模型。
- Pass C/D 分开调用 Provider，失败互不覆盖。
- ReviewRun 支持部分完成，保留成功 pass 的结果。
- 合并重复意见必须保留每个来源和历史。
- Revise locally 与 Fix with Agent 都创建 IssueResolution。
- Issue 不能通过普通状态下拉直接变为 resolved；必须经过修改、`needs_review` 和复检，或作为 dismissed 填写理由。
- `citation`、`compliance`、`structure` 等来源通过 finding source 表示，并明确映射到 Review category，避免无限扩张类别枚举。

## 9. 安全、隐私和外部依赖

- 外部访问只允许 Crossref、OpenAlex、Semantic Scholar、arXiv 等固定域名。
- 每次重定向重新校验目标，禁止任意 URL 抓取，防止 SSRF。
- 设置连接/读取超时、并发上限、指数退避、429 `Retry-After`、缓存 TTL 和短期熔断。
- API key 只保存在服务端，不进入前端响应、审计文本和日志。
- 外部论文文本属于不可信数据，不能作为 Agent 指令；进入 Prompt 时与 system/user instructions 明确隔离，防止 prompt injection。
- 本地 PDF 解析限制文件大小、页数、解压资源和处理时间。
- 把本地论文全文发送给 LLM Provider 前必须取得用户明确同意。
- 区分注册表摘要、开放全文和受版权限制全文；限制保存和展示的 verbatim excerpt 长度。
- 项目删除必须级联清理研究数据。
- 如果产品转为多人服务，必须先增加项目级身份认证和授权；当前仅凭 projectId 的 API 不适合作为多租户安全边界。

## 10. 实施里程碑

### M0：契约与基础设施

范围：

- 同步 ROADMAP、DESIGN、DEV、RDA 的新 Review 契约。
- 新 Review 停止创建冻结 ReviewSnapshot；旧数据兼容读取。
- 定义 Research、Evidence、Claim、Review 状态机。
- 为 JsonDatabase 增加 schemaVersion、迁移、容量限制和级联删除。
- 抽取共享 LaTeX/BibTeX 分析模块，供 Compliance、Research 和 Agent validation 复用。
- 增加 HTTP 输入运行时校验。

退出门槛：

- 旧 `database.json` 可无损加载，迁移失败不会覆盖原文件。
- 新 Review 不持久化 PDF、页面文本、哈希或冻结快照。
- 现有 Completion、Agent、Revise、Review、Memory 和 Sync 回归测试保持通过。

### M1：Citation Evidence 最小纵向闭环

范围：

- 复用现有 Crossref 校验，增加 OpenAlex 作为补充来源。
- 从当前 `.tex/.bib` 提取 citation context。
- 显示规范元数据候选、来源和冲突。
- 用户批准 BibTeX 候选后生成 ChangeSet。
- 实现缓存、限流、取消、失败回退和来源标记。
- 第一版以手工搜索/导入为主，不要求 Agent 查询计划。

退出门槛：

- 可从正文 citation 跳到真实元数据和附近 claim。
- 外部服务不可用时返回 unresolved，不阻塞本地编辑。
- ResearchService 不能直接写 `.bib`。
- 用户批准前候选引用不进入 Agent 事实上下文。

### M2：Claim Ledger

范围：

- 实现 ClaimAnchor、重新定位和 stale/orphaned 状态。
- 优先扫描当前文件以及 Abstract、Introduction、Conclusion 中的高风险 claim。
- 实现 literature/workspace evidence link 和带理由 waiver。
- Monaco 只加载当前打开文件的 decorations。
- 把 claim/citation finding 接入 Compliance。

退出门槛：

- 文件编辑后 claim 不会静默指向错误文本。
- 每条 supported claim 都有当前有效的 evidence link。
- 模型语义判断不会被显示为确定性 verified/error。
- 大型项目编辑器滚动和输入延迟不明显退化。

### M3：Executable Compliance 与 Skill

范围：

- 把 ComplianceService 拆成可注册检查器。
- 保留现有 Skill 目录和加载规则。
- venue frontmatter/sidecar 增加规则版本、来源和适用阶段。
- 首先稳定 citation、TODO、required sections、anonymity 和 cross-reference 检查。
- 为现有 AI、安全、HCI Skill 增加首批 fixture。

退出门槛：

- 每项检查返回稳定 ID、状态、证据、规则来源和修复建议。
- 未配置模型时所有确定性检查仍可运行。
- Venue 规则缺失或过期时返回 unresolved，不伪造合规结论。

### M4：Evidence-aware Agent

范围：

- 扩展统一 AgentTaskPlan，不增加新的 Agent 入口。
- 加入 evidence dependencies 和 missing evidence。
- 为 ChangeSet hunk 增加 HunkFinding。
- 对新增 citation、BibTeX、数字和强 claim 做生成后检查。
- Revise 使用内部 revisionPolicy，不增加模式 Tab。

退出门槛：

- 未批准 citation 产生 blocking finding，不能普通 Accept。
- 缺少事实依据时保留 TODO 或 blocking finding。
- Agent Plan 只经过现有的一次确认。
- accepted hunk、conflict review 和 rollback 语义不被破坏。

### M5：Research 工作区扩展

范围：

- 增加可编辑查询计划和 ResearchRun。
- 接入 Semantic Scholar 和 arXiv。
- 实现跨 provider 去重、项目收藏、引用关系和证据卡片。
- 本地 PDF 采用受限、显式授权、按需提取。
- 根据实际检索质量和数据规模评估是否需要全文索引。

退出门槛：

- 并发导入不会产生重复 ResearchWork。
- 所有 evidence 保留来源、representation 和审批状态。
- 取消或失败的 ResearchRun 不产生已批准证据或正文修改。
- 达到容量上限时给出明确提示，不造成 database.json 无界增长。

### M6：多阶段 Review

范围：

- Mechanical、Evidence、Domain、Venue pass 分开运行。
- 支持部分成功、问题合并去重和有针对性的复检。
- 修正 ReviewIssue / IssueResolution 状态机。
- 两条修复路径都创建 IssueResolution。
- 可选接收浏览器临时提取的有界 PDF 页面文本。

退出门槛：

- 每条 blocking/major issue 有可查看证据。
- 任一 Provider pass 失败不会丢弃其他成功结果。
- Issue 不能绕过复检直接 resolved。
- PDF 页面文本在请求结束后不可从数据库、文件和日志中找到。

### M7：论文—代码—结果对齐（实验性）

范围：

- 先做确定性的数字一致性、文件发现和引用完整性。
- 论文数字与结果文件的关联由用户确认。
- 根据误报率再评估脚本识别、图表重建和受限执行。
- 与核心写作路线分开记录实验指标。

退出门槛：

- 系统不会把相似数字自动认定为同一实验结果。
- 没有用户授权时不执行代码。
- 实验性 finding 不作为硬性 submission blocker。

## 11. 测试策略

### 单元测试

- DOI、arXiv ID、标题/作者/年份归一化和去重。
- 元数据冲突、retraction/correction 状态和来源保留。
- BibTeX/citation context 解析，包括 natbib、biblatex、多 key 和注释。
- ClaimAnchor 重新定位、stale、orphaned 和文件 rename/delete。
- 状态机非法转换拒绝。
- HunkFinding 和人工覆盖理由。
- Skill rule 加载、venue stage 和规则过期降级。

### 服务集成测试

- 外部 API 429、超时、部分失败、缓存命中和取消。
- Research → 用户审批 → BibTeX ChangeSet → Accept 的完整链路。
- Agent 新增 citation → validation → blocking/accept override。
- Review 各 pass 部分成功、合并去重和 targeted re-review。
- 旧 database.json 迁移、失败恢复和项目级级联删除。

### E2E

- 在现有三栏 Workspace 内完成搜索、审阅文献、批准证据、生成 BibTeX diff、定位 claim 和解决 Review Issue。
- 验证刷新、取消任务和切换项目后状态可恢复。
- 验证键盘操作、屏幕阅读器标签和大型项目 Monaco 性能。
- 验证 PDF 临时文本未进入服务端持久化和日志。

## 12. 衡量指标

- 新增 citation 的元数据验证率。
- 高风险 claim 的人工审核率和证据覆盖率。
- citation-claim mismatch 的人工确认准确率。
- 重复 ResearchWork 率和元数据冲突率。
- Agent hunk 接受率、blocking finding 率和人工覆盖率。
- 被用户撤销的 AI 修改比例。
- ReviewIssue 证据附着率和复检通过率。
- 外部 API 成功率、缓存命中率、P95 延迟和取消成功率。
- database.json 大小和 mutation P95 写入时间。
- Monaco claim decorations 对输入和滚动延迟的影响。

## 13. 执行顺序

```text
M0 契约/迁移
  -> M1 Citation Evidence 最小闭环
  -> M2 Claim Ledger
  -> M3 Executable Compliance/Skill
  -> M4 Evidence-aware Agent
  -> M5 Research Agent 扩展
  -> M6 Multi-pass Review
  -> M7 Paper-Code Alignment（实验性）
```

当前立即执行 M0 和 M1。先复用已有 Crossref、Compliance、ChangeSet 和三栏 UI，完成“正文 citation → 元数据与上下文 → 用户审批 → BibTeX ChangeSet”的纵向闭环；全文索引、引用图扩展和本地 PDF 深度解析在该闭环稳定后再评估。
