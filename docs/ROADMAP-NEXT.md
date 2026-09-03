# FastWrite 后续方向与实施计划

> 整理日期：2026-08-31
> 基线：结合 `docs/3. FastWrite.md`、当前代码、现有设计文档和公开资料整理。
> 当前验证：`bun test` 150 项通过；`bun run writing:eval` 12/12 通过，clean false positive 为 0；`bun run typecheck` 通过。

## 1. 总体判断

FastWrite 已经不再是早期设想中的“带 AI Chat 的 LaTeX 编辑器”，而是初步具备：

> 本地 LaTeX 工作区 + 可审批 Agent 修改 + 证据约束写作 + 投稿前检查

OpenAI Prism 和 Overleaf AI 已经覆盖项目级聊天、改写、引用搜索、公式生成、错误修复和多人协作。FastWrite 不应把“增加聊天入口、润色按钮或更多 Agent”作为主要方向，而应形成以下差异化定位：

> 一个能够说明“每项修改改了什么、依据什么、是否符合投稿规则，并允许作者逐项审批和追溯”的 AI 论文工作台。

核心壁垒应是：

- 本地与隐私优先；
- Evidence-grounded writing；
- 人工审批和安全回滚；
- AI 修改 provenance；
- venue-specific compliance；
- 可测量的写作正确性，而不是仅追求文本流畅度。

## 2. 已有成果

当前仓库已经具备：

- 本地目录和 GitHub 项目导入；
- 浏览器 WASM LaTeX 编译、按需 TeX 包下载、PDF Diagnostics 和 SyncTeX；
- Completion、Agent、Revise、Review 四条工作流；
- Agent Plan、多文件 ChangeSet 和逐 hunk 审批；
- hunk 编辑、冲突复核、Accept/Reject；
- Paper Memory 与 User Instructions；
- Research、Source Evidence、Claim Ledger；
- Section Contract、Argument Graph、Adversarial Memo；
- Writing Check Registry 和确定性 Writing Guard；
- 领域及 venue Writing Skills、模板和 Compliance；
- GitHub 三方同步和冲突编辑；
- 单文件发布包、CI、单元测试和 E2E 基础。

因此，`ROADMAP-WRITING-QUALITY.md` 中 W0–W5 的相当一部分已经实现，不能继续按“全部未开始”的旧状态执行。

## 3. P0：统一产品契约和项目文档

### 3.1 当前问题

仓库中的 Review 契约存在冲突：

- `DESIGN.md` 和写作质量路线图主张不冻结 PDF、不保存 PDF artifact 或 SHA；
- `RDA.md` 的验收标准要求 Review Provider 收到固定版本 PDF，并绑定 PDF 摘要；
- `DEV.md` 仍把 PDF artifact 纵向链路列为下一步；
- 当前代码保留 `ReviewSnapshot` 数据结构，测试名称也包含冻结 snapshot 的旧叙述；
- 实际 Review 接收源码和请求期 `pageText`，并非严格的 PDF 审稿；
- 路线图仍将已实现的 Claim v2、Section Contract、Writing Guard、Argument Graph 和多 pass Review 写成未来任务。

### 3.2 推荐决策

近期采用“隐私优先 Review”契约：

1. Review 使用请求发生时的项目版本源码；
2. 浏览器只上传请求期、有界的逐页 PDF 文本；
3. 数据库只保存被引用的页码、摘录、项目版本和输入边界；
4. 不保存完整 PDF；
5. targeted re-review 必须要求修改后的当前版本成功编译；
6. 若未来确实需要视觉审稿，单独设计“用户显式授权的临时 PDF artifact”。

### 3.3 交付物

- 将路线图改成 `Done / Partial / Missing / Deferred` 状态矩阵；
- 统一 `RDA.md`、`DESIGN.md`、`DEV.md` 和测试命名；
- 删除或明确标记仅供旧数据兼容的 ReviewSnapshot 语义；
- 给 Review 的输入、存储、页码证据和 targeted re-review 写出唯一契约。

## 4. P1：把 Evidence 能力做成作者工作流

当前 Claim、Evidence、Argument Graph 和 Writing Guard 已有后端骨架，下一步重点是产品化。

### 4.1 UI 与交互

- Agent Plan 中展示 Section Contract；
- 展示 required claims、allowed evidence、缺失材料和 open questions；
- Claim/Evidence 面板按 `supported / partial / unsupported / stale / orphaned` 分类；
- ChangeSet finding 可以跳转到原文 claim、实验结果、表格、BibTeX、证据和相关章节；
- warning、blocking、unresolved 和 style suggestion 使用不同视觉语义。

### 4.2 Evidence-aware Continue

`/continue` 的优先顺序调整为：

1. 有 confirmed evidence、尚未写入正文的 claim；
2. 有 claim 但支撑不足的章节；
3. 尚未解释的实验结果；
4. Motivation、Gap、Method、Experiment、Result、Conclusion 之间的关系缺口；
5. Introduction 与 Conclusion 的范围不一致；
6. 未解决的 Review Issue；
7. 最后才是单纯扩写篇幅。

### 4.3 验收标准

- 每个新章节能够追溯到 Section Contract；
- Plan 声明的 evidence dependencies 在生成后逐项验证；
- 无证据时保留 TODO 或 unresolved，不生成伪造数字、引用或实验；
- 每条 correctness finding 都能定位到原文和相关证据；
- 用户仍通过 ChangeSet 决定正文写入。

## 5. P1：建立真实论文级质量评测

现有 12 个机械 fixture 是良好起点，但不足以评价真实论文写作。

### 5.1 三层评测集

#### A. 确定性 corruption

- 保持已声明 corruption 100% 召回；
- 扩充表格、caption、appendix、跨文件术语和复合指标；
- 每条 blocking 规则必须有 clean 对照；
- CI 输出 rule-level recall 和 clean false positive。

#### B. 真实多文件论文

- 选择 10–20 个公开 LaTeX 项目；
- 覆盖 AI、系统、网络和 HCI 等现有 Skill；
- 测量编译成功率、finding 误报和 claim 重定位稳定率；
- 保存项目许可、来源和测试用途说明。

#### C. 人工写作评测

- 固定任务比较原稿、普通 LLM 和 FastWrite evidence-aware 输出；
- 双盲评价正确性、论证完整性、简洁性和引用准确性；
- 记录 AI hunk 接受率、接受后回滚率和人工修改量。

### 5.2 核心指标

- 新 citation 的元数据验证和批准率；
- 新增强 claim 的 evidence 覆盖率；
- claim 重定位稳定率；
- corruption recall 和 clean false positive；
- Plan evidence dependency 满足率；
- blocking finding 修复率；
- Abstract/Conclusion 与正文结果一致率；
- targeted re-review 解决率；
- AI hunk 接受率、接受后撤销率和每章节修订轮数。

## 6. P1：AI 修改 Provenance 与投稿合规

不同 venue 对 AI 写作的政策正在分化。FastWrite 已有 ChangeSet、Agent audit trail 和内部 Git，适合增加可验证的修改来源记录。

### 6.1 建议能力

- AI operation 的 pre-AI checkpoint；
- 模型、workflow、用户目标、输入边界和修改范围；
- hunks 的接受、编辑、拒绝记录；
- AI 是否引入新 claim、数字、引用或实验结论；
- 接受后的进一步人工修改；
- 按 venue 生成 AI usage disclosure 草稿；
- 导出可分享的 provenance dossier；
- 明确 provenance 是过程证据，不是 AI 文本检测器。

### 6.2 验收标准

- 任意已接受 AI 修改可追溯到 pre-AI、post-AI 和当前版本；
- 能区分 copy-edit、结构调整和实质内容生成；
- 能列出 AI 新增的 claim/citation/number；
- provenance 导出不包含 API key、完整 prompt 中的秘密或未经授权的论文全文。

## 7. P1：完成 Git-based Rollback

当前 Rollback 仍要求文件版本和应用片段基本保持不变，尚未达到设计中的 Git revert 语义。

### 7.1 实施内容

- ChangeSet 应用前 checkpoint OID；
- 每批 accepted hunk 的 operation commit OID；
- 基于 operation commit 的 reverse three-way merge；
- 保留 operation 之后的不相关修改；
- 同一区域再次修改时进入可编辑冲突解决；
- History list、版本比较和 restore-as-new-commit；
- Git checkpoint 失败时显式进入 History degraded 状态。

### 7.2 验收标准

- AI 修改后编辑其他文件或其他段落，仍能安全回滚 AI 修改；
- 同一段被继续修改时不覆盖后续内容；
- 回滚形成新 commit，不 reset、不重写历史；
- 多文件 ChangeSet 不发生部分回滚。

## 8. P2：Review 升级为可验证 Preflight

Review 不应只生成一份似乎权威的总评，而应展示实际覆盖程度。

### 8.1 独立 Pass

```text
Mechanical
  -> Evidence
  -> Argument
  -> Domain
  -> Venue
  -> Adversarial
  -> Deterministic synthesis
```

每个 pass 独立记录：

- completed、failed、skipped；
- provider/model；
- 输入边界；
- issue IDs；
- error 或 unavailable reason。

### 8.2 产品规则

- 单个 pass 失败时保留其他 pass 结果；
- 覆盖不完整时不能显示 clean 类结论；
- blocking/major issue 必须附 Workspace、Claim 或 PDF pageText 证据；
- 语义判断默认 warning/unresolved；
- 不提供论文接收概率或自动 verdict；
- Issue 必须经过修改、编译和 targeted re-review 才能 resolved。

## 9. P2：Research 与引用管理纵向打通

FastWrite 的优势应是 citation grounding，而不是单纯返回更多搜索结果。

建议实现：

- DOI、arXiv、Crossref、OpenAlex 或 Semantic Scholar 元数据核验；
- 文献去重、版本关系、撤稿或勘误提示；
- 用户授权的 PDF 段落级 evidence extraction；
- Evidence → Claim → Citation → 正文的可追踪关系；
- 一键生成 BibTeX，但默认仍需用户批准；
- 展示“一篇论文具体支持了正文中的哪句话”。

## 10. P3：多人协作与 Local-first

多人实时协作暂不进入最高优先级。应先完成 Git-based Rollback、provenance 和操作审计，再逐步建设：

1. 只读分享；
2. 评论和审核链接；
3. presence；
4. 最后引入实时共同编辑。

可以评估 Yjs，但必须先定义：

- CRDT 更新与 `PaperFile.version` 的关系；
- ChangeSet base 使用文本版本还是 Yjs state vector；
- Agent 多文件修改是否进入项目级事务；
- 远程修改与 hunk 审批如何合并；
- CRDT 历史、内部 Git 和 GitHub Sync 的职责边界。

不建议采用“编辑文件时锁住整个文件”的长期方案，它与 Agent 多文件修改和离线编辑冲突较大。

## 11. 分阶段计划

### 阶段一：收敛基础，4 周

- 统一 Review、Snapshot 和 PDF artifact 契约；
- 重写路线图状态；
- 完成 Git operation checkpoint 和三方 Rollback；
- 将 writing eval 作为正式 CI gate；
- 建立第一批真实多文件论文回归集。

退出门槛：

- 产品文档只有一个 Review 契约；
- AI 修改在后续无关编辑后仍可回滚；
- writing eval 和真实项目回归稳定运行；
- 全部现有测试、类型检查和构建通过。

### 阶段二：差异化闭环，4–6 周

- Claim/Evidence 面板；
- Section Contract Plan UI；
- finding 到 claim/evidence/source 跳转；
- Evidence-aware `/continue`；
- 多 pass Review 覆盖状态；
- AI provenance 和 venue disclosure 导出。

退出门槛：

- 用户可从章节计划追踪到 claim 和 evidence；
- 新增强 claim 无依据时会被阻止或明确标记；
- Review 部分失败不会伪装成无问题；
- 任意 AI 修改可生成审计摘要。

### 阶段三：扩展生态，6 周以上

- Zotero/Crossref/OpenAlex/DOI 引用链；
- 用户授权的临时 PDF 视觉审稿；
- 评论、只读分享和审稿协作；
- 再评估基于 Yjs 的多人实时编辑；
- 图表、公式和实验结果导入 Skills。

## 12. 暂不优先

- 增加更多顶层写作模式；
- 大量独立 Agent 或复杂 swarm；
- AI 自动接受正文修改；
- 自动生成接收概率或投稿 verdict；
- 将风格判断设为 blocking；
- 自动执行用户实验代码；
- 在基础回滚和审计未完成前建设实时多人编辑；
- 与 Prism、Overleaf 正面竞争通用云端 LaTeX 编辑器功能数量。

## 13. 调研来源

## 14. 当前状态矩阵（2026-08-31）

| 能力 | 状态 | 可验证实现 |
| --- | --- | --- |
| Review 输入与存储契约 | Done | 请求期有界 `pageText`，不持久化 PDF；报告记录输入类型、pass 状态和边界 |
| Evidence/Claim 作者工作流 | Done | supported/partial/unsupported/stale/orphaned 分类、reanchor、Section Contract、finding 状态语义与 evidence anchor 跳转均已接入 |
| Evidence-aware Continue | Done | confirmed 未写入 claim、支撑不足、实验结果、论证缺口、范围不一致、Review Issue、篇幅扩写按顺序评分，并在生成后校验 dependency |
| Git history checkpoint | Done | pre-accept/apply/rollback OID、History API、文件预览和 restore-as-new-commit |
| Git reverse three-way rollback | Done | 保留后续无关编辑；同区冲突返回 base/applied/current 三方内容并接受显式编辑结果；回滚形成新 checkpoint |
| Review Preflight 多 pass | Done | 七阶段状态、provider/model、输入边界、issue IDs、失败原因已记录并展示；覆盖失败时禁止 clean 结论 |
| Provenance 与 disclosure | Done | dossier、audit trail、checkpoint OID、hunk 新增内容分类 |
| 引用元数据核验 | Done | DOI/arXiv/OpenAlex/Semantic Scholar 搜索与去重、Crossref/OpenAlex/S2 一致性、撤稿/勘误提示、授权 PDF evidence、批准后 BibTeX ChangeSet |
| 真实论文质量评测 | Done | 10 项固定 SHA 与真实基线；显式引擎/预处理/工具链分类后，可执行项目编译成功率 100%（6/6），4 项工具链 unavailable，claim 重定位稳定率 0.848 |
| 只读分享/评论 | Done | 哈希 token、到期/撤销、只读文件页、评论权限及公开审核页面 |
| 实时 CRDT 协作 | Done | Yjs 文档合并、Monaco 同步、WebSocket 房间通知、presence、远端行标记及 `PaperFile.version` 落盘边界 |

- [OpenAI Prism](https://openai.com/index/introducing-prism/)
- [Prism 产品页](https://openai.com/prism/)
- [Overleaf AI features](https://docs.overleaf.com/integrations-and-add-ons/ai-features)
- [Overleaf AI assistant](https://docs.overleaf.com/integrations-and-add-ons/ai-features/ai-assistant)
- [Writefull for Overleaf](https://docs.overleaf.com/integrations-and-add-ons/ai-features/writefull)
- [The AI Scientist-v2](https://github.com/sakanaai/ai-scientist-v2)
- [Yjs documentation](https://docs.yjs.dev/)
- [Yjs offline support](https://docs.yjs.dev/getting-started/allowing-offline-editing)
- [SwiftLaTeX](https://github.com/SwiftLaTeX/SwiftLaTeX)
- [NeurIPS 2026 Position Paper Track AI policy](https://blog.neurips.cc/2026/06/02/ai-generated-papers-in-the-neurips-2026-position-paper-track/)
- [NeurIPS 2026 Main Track Handbook](https://neurips.cc/Conferences/2026/MainTrackHandbook)
- [NeurIPS Paper Checklist](https://neurips.cc/public/guides/PaperChecklist)
- [CSCW 2026 LLM policy](https://cscw.acm.org/2026/papers.html)
- [HalluCitation Matters](https://aclanthology.org/2026.acl-long.2189.pdf)
- [SciHal25 Shared Task](https://aclanthology.org/2025.sdp-1.29.pdf)
