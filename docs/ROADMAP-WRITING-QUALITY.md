# FastWrite 写作能力提升路线图

> 状态：规划草案。
>
> 调研基线：Anti-Autoresearch，commit `30c68d0204f764cc0582d5cbcac1584f5a0a726f`（2026-08-26）。
>
> 目标：在 FastWrite 现有 Agent、Research、Evidence、Claim、Memory、ChangeSet、Compliance 和 Review 基础上，建设“论证约束 → 证据支撑 → 生成 → 确定性检查 → 人工审批 → 对抗预检 → 定向修订”的完整写作闭环。

## 1. 总体判断

FastWrite 下一阶段不应继续以增加 Prompt、顶层写作模式或独立 Agent 数量为主要方向，而应建设 **Evidence-Grounded Writing Loop（证据约束的写作闭环）**。

```text
Approved Evidence / Workspace Results
                  |
                  v
             Claim Ledger
                  |
                  v
       Section & Argument Contract
                  |
                  v
        Agent Draft / Continue / Revise
                  |
                  v
              ChangeSet
                  |
                  v
  Deterministic checks + semantic warnings
                  |
                  v
            Human approval
                  |
                  v
 Compile -> Adversarial preflight -> Targeted revise
```

Anti-Autoresearch 最值得借鉴的不是“检查 AI 论文”的产品定位，而是以下工程原则：

1. 以统一 Evidence/Claim Ledger 作为所有检查和推理的中间表示。
2. 模型只提出候选和 finding，确定性代码负责门禁和状态转换。
3. 每项结论必须受当前可见证据约束，缺少材料时返回 unresolved。
4. 不同检查维度独立运行，失败、缺失和低置信度都必须显式呈现。
5. 使用 clean fixture 与 synthetic corruption 持续测量召回和误报，而不是仅凭主观样例评估。

这些原则应转化为作者侧能力：模型负责写作和解释，规则负责阻止无依据内容进入论文，用户继续掌握所有正文写入权。

## 2. 与 FastWrite 现有架构的关系

FastWrite 已经具备可承接该方向的主要骨架：

- `PaperClaim`、`SourceEvidence`、`ClaimEvidenceLink` 已存在。
- `AgentTaskPlan` 已支持 `evidenceDependencies` 和 `missingEvidence`。
- ChangeSet hunk 已支持 finding、warning 和 blocking。
- Research、Memory、Compliance、Review pass 已有数据模型和基础服务。
- Agent 和 Revise 统一经过 ChangeSet 与逐 hunk 审批。
- Workspace 和文件版本已经是正文真相及并发安全边界。

当前主要差距：

1. `ClaimService` 只通过少量结果动词识别句子，无法覆盖数字、citation、scope、caption、table cell 等可验证内容。
2. Claim 重新扫描会重建记录，缺少稳定身份匹配和 evidence link 保留机制。
3. hunk finding 目前主要检查 citation key 是否经过 Research 批准。
4. `AlignmentService` 只能发现数字和结果文件，尚不能建立用户确认的数字关联。
5. Agent Plan 虽然保存证据依赖，但生成后没有逐项验证候选是否满足。
6. Review 已有多 pass 数据结构，但 Mechanical、Evidence、Domain、Venue 还未形成真正独立、可部分失败和可追踪的执行过程。

本路线图扩展现有 `ROADMAP-EVIDENCE-AGENT.md` 的 M2、M4、M6 和 M7，不建设第二套平行 Agent 或 Review 架构。

## 3. 设计边界

### 3.1 明确不做

- 不计算或保存 PDF SHA-256。
- 不冻结 PDF、Review 输入或 ReviewSnapshot。
- 不建立 PDF artifact 版本链。
- 不引入大量独立 Agent 构成复杂 swarm。
- 不让模型直接给出自动接受、拒绝或论文合格裁决。
- 不把 AI 写作风格判断作为正文接受的 blocking 条件。
- 不执行用户实验代码，不自动把相似数字认定为同一实验结果。
- 不把低置信度 PDF 或正则提取结果显示成确定事实。
- 不自动接受 Agent 修改，不绕过现有 ChangeSet 审批。

### 3.2 保持不变

- Workspace 是论文正文真相。
- 文件版本和项目版本继续承担并发校验与状态关联。
- Agent、Revise 和 Research 产生的正文修改必须进入 ChangeSet。
- Paper Memory 只接纳有来源并经过用户确认的内容。
- 缺少事实或引用时保留普通文本 TODO 或 unresolved finding，不伪造 citation。
- Review 继续是辅助判断，不替代作者、审稿人或领域专家。

## 4. 目标数据模型

### 4.1 Claim Ledger v2

扩展 `PaperClaim`，使其能够表达：

- 语义类型：background、contribution、method、result、comparison、limitation。
- 表面类型：number、scope、citation、caption、table-cell、artifact-reference。
- 数值信息：raw、normalized、unit、metric、direction、aggregation。
- 关联信息：citation keys、table/figure label、section、evidence links。
- 提取信息：extractor、confidence、anchor status。

Claim 使用现有稳定锚点：

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
```

重新扫描时按照路径、规范化文本、前后文和局部位置匹配旧 claim，尽量保留 claim ID、人工状态和 evidence links；无法重定位时标记 stale/orphaned，不静默绑定到其他文本。

不引入 source/PDF 哈希作为 Claim 或 Review 的必要身份字段。

### 4.2 Section Contract

Agent 在写作前为目标章节生成可审核、可执行的章节契约：

```ts
interface SectionContract {
  path: string;
  purpose: string;
  requiredClaimIds: string[];
  allowedEvidenceIds: string[];
  requiredTablesOrFigures: string[];
  terminology: string[];
  openQuestions: string[];
  targetWords?: number;
}
```

Section Contract 约束“该章节要完成什么论证”，而不是保存一段新的自由文本 Prompt。它应作为 `AgentTaskPlan` 的扩展字段，继续使用现有 Plan 确认流程。

### 4.3 Argument Graph

在 Claim Ledger 上增加轻量关系，不引入通用图数据库：

```text
Motivation -> Gap -> Contribution -> Method
                           |
                           v
                      Experiment
                           |
                           v
                    Result -> Conclusion
```

关系只保存必要的 claim ID、关系类型、来源和状态，例如：

```ts
interface ClaimRelation {
  id: string;
  projectId: string;
  fromClaimId: string;
  toClaimId: string;
  type: "motivates" | "addresses" | "implements" | "evaluates" | "supports" | "limits";
  status: "candidate" | "confirmed" | "stale";
  origin: "scanner" | "agent" | "user";
}
```

模型产生的关系默认是 candidate；只有用户确认或确定性结构能够支持时，才进入 confirmed。

### 4.4 Writing Finding

继续复用 `HunkFinding`，必要时扩展以下信息：

```ts
interface WritingFinding {
  id: string;
  ruleId: string;
  source: "claim" | "citation" | "numeric" | "structure" | "review" | "compliance" | "style";
  status: "pass" | "warning" | "blocking" | "unresolved";
  message: string;
  anchors: ClaimAnchor[];
  referenceIds: string[];
  confidence: "high" | "medium" | "low";
  suggestedAction?: string;
}
```

门禁规则：

| Finding 类型 | 默认处理 |
| --- | --- |
| 确定性、低误报、直接影响正确性 | blocking |
| 需要语义判断或外部材料 | warning / unresolved |
| 风格和表达偏好 | suggestion，不阻止接受 |
| 锚点缺失或提取置信度低 | 降级为 unresolved |

## 5. 实施阶段

### W0：写作质量评测基线

周期：1 周。

范围：

- 新建 `writing-eval` fixtures 和运行入口。
- 准备至少一份 clean 多文件 LaTeX 论文。
- 通过机械变异注入已知写作缺陷。
- 输出每项规则的召回、额外 finding 和 clean false positive。
- 将确定性规则评测接入 CI。

首批变异：

1. Abstract 数字与结果表不一致。
2. 相对提升百分比计算错误。
3. citation key 不存在或未批准。
4. 删除 `\label`，制造悬空 `\ref`。
5. 同一术语或 acronym 出现不同定义。
6. Conclusion 引入正文未支持的新结论。
7. 插入 TODO、占位引用或模板残留。
8. 插入没有证据支撑的 SOTA、comprehensive 等强范围词。

退出门槛：

- 每个已上线确定性规则都有 clean 和 corruption fixture。
- 已声明支持的 corruption 召回率为 100%。
- clean fixtures 不产生 blocking 误报。
- 每条 finding 都可定位到文件和原文锚点。

### W1：Claim Ledger v2

周期：2 周。

范围：

- 将 LaTeX/BibTeX 提取逻辑抽为共享 analyzer。
- 提取 contribution、method、result、comparison 和 limitation 句子。
- 提取 number、citation、scope、caption、table cell 和 label/ref。
- 解析 metric、unit、direction、aggregation 等数值属性。
- 实现旧 claim 匹配、重新定位、stale 和 orphaned。
- 保留人工确认状态和 evidence links。
- Claim scan 使用批量数据库 mutation，避免逐项重写数据库。

退出门槛：

- 常规局部编辑后，未改变的 claim 保持原 ID。
- 删除、移动或改写 claim 后不会静默绑定错误文本。
- Claim extractor 对 fixture 输出稳定。
- 低置信度提取不会产生 blocking finding。

### W2：Deterministic Writing Guard

周期：2 周。

建立统一 `WritingCheckRegistry`，供 Compliance、Agent、Revise 和 Review 调用。

首批检查器：

- citation key 和 BibTeX entry 的存在性、批准状态与重复情况；
- `\ref`、`\label`、figure/table 引用完整性；
- Abstract、正文、表格和 Conclusion 的相同指标数值一致性；
- 相对提升和绝对提升计算；
- 百分数、point、倍数等单位一致性；
- higher/lower-is-better 方向；
- acronym、组件名称和核心术语漂移；
- TODO、占位文本和模板残留；
- 新增强 claim 是否拥有有效 evidence link；
- 已有 evidence link 是否因文件变化而 stale。

只有以下低误报情况默认 blocking：

- 新增 citation 未经批准或 BibTeX key 不存在；
- 悬空 `\ref` 或重复冲突 `\label`；
- 明确的算术矛盾；
- 同一确定指标在明确对应位置出现不可解释的冲突；
- 必需 evidence link 已失效。

范围夸大、baseline 不充分、novelty 可疑、论证跳跃和风格问题默认 warning 或 suggestion。

退出门槛：

- Agent 与 Revise 生成或编辑 hunk 后都重新运行相关检查。
- blocking finding 不能通过普通 Accept。
- 编辑 hunk 消除问题后，旧 finding 会被重新计算并清除。
- 检查器可以在未配置 LLM 时完整运行。

### W3：Evidence-aware Drafting

周期：2–3 周。

生成流程：

1. Agent Plan 建立 Section Contract 和 argument obligations。
2. 对照 Claim Ledger 检查 required claims 和 allowed evidence。
3. 在 Plan 中明确 missing evidence 和 open questions。
4. 用户确认 Plan 后，每次只生成一个目标文件。
5. 对候选运行 Writing Guard。
6. 允许模型根据确定性 finding 修复一次内存中的候选。
7. 修复后的内容仍作为 ChangeSet 提交人工审批，不自动写入 Workspace。

`/continue` 的选段和计划优先级调整为：

1. 尚未覆盖的 confirmed claim；
2. 缺少支持或只得到部分支持的章节；
3. 尚未解释的实验结果；
4. Motivation、Gap、Method、Experiment 之间缺失的关系；
5. Introduction 与 Conclusion 之间不一致的范围；
6. Review 尚未解决的问题；
7. 最后才是单纯扩写篇幅。

缺少证据时：

- 不生成伪造 citation key；
- 不把假设写成已完成实验；
- 使用普通文本 TODO 或 Plan missing evidence；
- 将对应 hunk 标为 warning/blocking，取决于问题是否为确定性事实。

退出门槛：

- 每个新章节都能追溯到 Section Contract。
- Plan 声明的 evidence dependencies 会在生成后被逐项验证。
- Agent 不会因缺少材料而伪造数字、引用或实验结果。
- 单文件生成、ChangeSet、冲突处理和 Rollback 语义保持不变。

### W4：Argument Graph 与作者侧对抗预检

周期：2 周。

检查维度：

- 引言提出的问题是否由方法实际处理；
- contribution 是否有方法、实验或证明承接；
- experiment 是否测量了声称的机制；
- ablation 是否隔离了对应组件；
- conclusion 是否超出结果支持范围；
- limitation 是否覆盖主要外部有效性边界；
- Related Work 是否形成差异论证，而不是文献罗列；
- 方法、实验和结果之间是否存在术语或范围漂移。

增加 advisory-only 的 `Hostile Reviewer Memo`：

1. 使用新的请求线程生成最强、证据受限的拒稿理由。
2. 另一个 pass 把理由拆为 supported、contested、missing-evidence 和 style-only。
3. 所有意见必须引用现有 claim 或 Workspace 锚点。
4. Memo 不产生自动 verdict，不改变 finding severity，不直接修改正文。
5. 用户可以选择具体意见进入现有 Revise 或 Agent IssueResolution 流程。

退出门槛：

- 每个 major argument warning 都有可查看的 claim 关系和原文证据。
- 无证据的语义意见降级为 suggestion/unresolved。
- 对抗预检不会影响正文，除非用户显式选择并审批修改。

### W5：多阶段 Preflight Review

周期：2 周。

将 Review 落实为独立 pass：

```text
Pass A: Mechanical
Pass B: Evidence
Pass C: Argument
Pass D: Domain
Pass E: Venue
Pass F: Adversarial advisory
Pass G: Deterministic synthesis
```

- Mechanical：编译、引用、交叉引用、TODO、格式和模板规则。
- Evidence：claim、citation、workspace result 和 approved evidence 的支持关系。
- Argument：论证链、范围、数字一致性和结论边界。
- Domain：领域正确性、实验设计和主要 baseline。
- Venue：目标会议约束和审稿偏好。
- Adversarial：最强反对意见，仅作 advisory。
- Synthesis：按稳定规则合并重复问题，保留来源和 pass provenance。

每个 pass 独立记录：

- completed、failed、skipped；
- 实际 provider/model；
- 输入边界；
- issue IDs；
- error 或 unavailable 原因。

单个 Provider pass 失败时，保留其他 pass 结果，不得将失败显示为“没有问题”，也不得在覆盖不完整时给出 clean 类结论。

退出门槛：

- 每条 blocking/major issue 都有 Workspace 或 Claim 证据。
- 任一 pass 失败不会丢弃其他结果。
- Review Issue 仍必须经过修改、编译和 targeted re-review 才能 resolved。
- PDF 预览文本继续只在请求期使用，不落盘、不哈希、不冻结。

### W6：产品整合与质量度量

周期：1–2 周。

UI 不增加新的顶层写作模式，继续使用现有 Agent、Revise、Review、Research 和 Compliance 入口。

建议增加：

- Claim/Evidence 侧边列表：按 current、partial、unsupported、stale 分类。
- Section Contract 预览：在确认 Agent Plan 时展示章节义务和缺失证据。
- hunk finding 跳转：从 finding 定位 claim、evidence、表格或 citation。
- Continue next section 建议：根据 argument gap 和 evidence readiness 排序。
- Preflight 覆盖状态：显示哪些 pass 成功、失败或未运行。
- warning 与 blocking 的清晰区分，style suggestion 与 correctness finding 隔离。

核心指标：

- 新增 citation 的批准与元数据验证率。
- 新增强 claim 的 evidence 覆盖率。
- Claim 重新扫描后的稳定重定位率。
- 确定性规则 corruption recall 和 clean false-positive 数量。
- Agent Plan evidence dependency 满足率。
- 带 blocking finding 的 hunk 数量、修复率和人工覆盖率。
- Abstract/Conclusion 与正文结果的一致率。
- Review pass 成功率、部分失败保留率和 targeted re-review 解决率。
- AI hunk 接受率、接受后撤销率和每章节平均修订轮数。

## 6. 推荐执行顺序

```text
W0 Evaluation baseline
  -> W1 Claim Ledger v2
  -> W2 Deterministic Writing Guard
  -> W3 Evidence-aware Drafting
  -> W4 Argument Graph / Adversarial preflight
  -> W5 Multi-pass Review
  -> W6 Product integration and metrics
```

W0 必须先于大规模规则开发，W1 与 W2 可以部分并行。W3 依赖 W1/W2 的稳定输出；W4/W5 在写作闭环稳定后再增加语义审查，避免先扩张模型调用再补证据基础。

## 7. 第一个 Sprint

首个 Sprint 建议限制在以下五项：

1. 建立 clean fixture 与至少 6 个 synthetic corruption。
2. 将 Claim scanner 扩展为 number、citation、scope、table 和 caption 提取器。
3. 实现重新扫描时的 claim ID 和 evidence link 保留。
4. 增加数值一致性、悬空引用和术语漂移三个确定性检查器。
5. 将检查结果接入现有 hunk finding 和 Review Evidence pass。

完成标准：

- 全部现有测试通过。
- 新规则有对应 clean/corruption 测试。
- blocking finding 可以阻止普通 Accept，编辑修复后自动清除。
- 没有新增 PDF SHA、PDF artifact、版本冻结或自动写入路径。

完成该 Sprint 后，FastWrite 将从“能够生成整篇 LaTeX”进入“能够持续写作，并说明每个关键论断由什么支撑”的阶段。

## 8. 调研来源

- [Anti-Autoresearch repository](https://github.com/wanshuiyin/Anti-Autoresearch)
- [Design notes](https://github.com/wanshuiyin/Anti-Autoresearch/blob/30c68d0204f764cc0582d5cbcac1584f5a0a726f/DESIGN.md)
- [Integrity Forensics Contract](https://github.com/wanshuiyin/Anti-Autoresearch/blob/30c68d0204f764cc0582d5cbcac1584f5a0a726f/references/integrity-forensics-contract.md)
- [Observability Levels](https://github.com/wanshuiyin/Anti-Autoresearch/blob/30c68d0204f764cc0582d5cbcac1584f5a0a726f/references/observability-levels.md)
- [Reviewer Independence](https://github.com/wanshuiyin/Anti-Autoresearch/blob/30c68d0204f764cc0582d5cbcac1584f5a0a726f/references/reviewer-independence.md)
- [Deterministic Eval Harness](https://github.com/wanshuiyin/Anti-Autoresearch/blob/30c68d0204f764cc0582d5cbcac1584f5a0a726f/eval/run_eval.py)
- [Limitations](https://github.com/wanshuiyin/Anti-Autoresearch/blob/30c68d0204f764cc0582d5cbcac1584f5a0a726f/docs/limitations.md)
- [FastWrite Evidence Agent Roadmap](./ROADMAP-EVIDENCE-AGENT.md)
- [FastWrite System Design](./DESIGN.md)
