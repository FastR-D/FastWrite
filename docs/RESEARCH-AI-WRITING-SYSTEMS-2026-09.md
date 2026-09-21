# AI 辅助学术写作系统调研与 FastWrite 借鉴建议

> 调研日期：2026-09-20  
> 目标：基于 FastWrite 当前代码与公开可核验资料，比较闭源产品（包括 OpenAI Prism）和开源项目，形成可执行的功能优先级。  
> 说明：闭源产品只记录官方页面、官方文档和公开仓库明确披露的能力；不推测其内部模型、数据或实现质量。产品能力和商业套餐会变化，实施前应重新核验链接和条款。

## 0. 调研口径与证据等级

本报告不是“功能宣传册”，而是 FastWrite 的产品决策输入。资料按以下等级使用：

| 等级 | 含义 | 本报告如何使用 |
| --- | --- | --- |
| A | 官方产品页、官方文档、官方仓库/许可证 | 可以作为“公开声明的能力”，但不代表质量或可用性已验证 |
| B | 官方仓库 README、公开论文、可复现示例 | 可以作为架构/交互启发，实施前仍需在 FastWrite 环境验证 |
| C | 社区文章、演示、二手比较 | 只用于发现候选方向，不作为路线承诺 |

竞品的“支持”与 FastWrite 的“已实现”严格分开：只有仓库代码、测试或 API 契约能证明的内容才进入“当前能力”；只有经过用户审批、证据关联和回归测试的输出才可进入论文正文。这个边界尤其适用于 Prism 等闭源系统：公开页面可以证明定位和入口，不能证明模型准确率、引用真实性、隐私策略或内部实现。

### 调研范围

- 闭源/托管：OpenAI Prism、Overleaf AI、Writefull、Paperpal、Jenni、SciSpace、Elicit、Consensus、scite，以及通用编辑器 Grammarly 作为交互参照。
- 开源/可自托管：Overleaf CE、Scribe、HeyTeX、TeXlyre、La Suite Docs、mist、Collab-MD、AI Scientist-v2、Aut_Sci_Write、manuscript-writing 和学术 skills 集合。
- 基础设施：Yjs/CRDT、Git、LaTeX 编译隔离、provider adapter、PDF/OCR/文献元数据接口。
- 评估维度：写作入口、长文上下文、研究检索、PDF 证据、引用语境、审阅、版本/协作、隐私与部署、扩展治理、执行风险。

### 判断方法

每个候选能力都按四个问题判断：

1. 用户是否会在当前编辑位置立即使用它？
2. 输出是否能回到正文、`.bib`、证据或编译问题，并保留差异？
3. 输出是否能被确定性检查、人工审批和版本回滚约束？
4. 是否会引入外部数据、网络、Shell、编译或实验执行风险？

因此，“值得借鉴”不等于“照搬”：交互入口可以借鉴，闭源实现不能假设；开源代码还必须通过许可证、依赖和安全审查。

## 1. 结论先行

FastWrite 当前已经有普通 AI 写作产品最难补的基础：完整 LaTeX 工作区、浏览器/本地编译、PDF/SyncTeX、Completion、Draft/Continue/Revise/Review、Paper Memory、Research、Claim/Evidence、Section Contract、Argument Graph、Writing Guard、venue Skill、ChangeSet 审批、Git 历史、Provenance、评论和 Yjs 协作。代码与现有路线图共同表明，FastWrite 不应再把“增加一个聊天框”作为主线。

建议把产品定位收敛为：

> **一个证据可追溯、修改可审批、投稿规则可验证的本地优先论文工作台。**

竞品提供的主要启发不是功能数量，而是三个用户习惯：

1. **低摩擦入口**：选中文本就能改写，光标处就能补全，编译错误旁边就能修复，论文侧栏可以直接提问。
2. **把复杂工作流做成阶段**：研究、筛选、引用、写作、检查、修订不是一个无上下文的 Chat，而是有明确输入输出的任务。
3. **把结果放回原文**：引用、公式、表格、改写和错误修复都能直接插回文档，但用户仍能看到差异并撤销。

FastWrite 的差异化应放在竞品普遍较弱或未公开承诺的部分：

- 每个重要句子能回答“这是事实、解释还是推测，依据是哪条证据”；
- AI 只提交可审阅 ChangeSet，不直接污染正文；
- 新增数字、claim、citation、图表结论和实验结论有明确的 provenance；
- Review 能显示覆盖范围、失败的 pass 和不确定性，而不是给出没有证据的“论文质量分”；
- venue policy、匿名性、页数、模板和 AI disclosure 可以变成可验证的投稿 preflight；
- 本地/自托管/可配置模型，适合未发表论文和受限研究环境。

## 2. FastWrite 当前基线

### 2.1 已有能力（以当前代码和文档为准）

| 领域 | 当前能力 | 主要代码/文档入口 |
| --- | --- | --- |
| 编辑与编译 | Monaco 工作台、文件树、Outline、Problems、PDF、SyncTeX、Browser WASM、Local LaTeX | `apps/web/src/components/workspace/`、`apps/server/src/compiler/`、`docs/DESIGN.md` |
| AI 写作 | Completion；Agent 的 plan -> ChangeSet -> hunk 审批；Draft、Continue、Revise；编译修复 | `apps/server/src/agent/`、`apps/web/src/components/workspace/` |
| 研究与引用 | Crossref、OpenAlex、Semantic Scholar、arXiv 检索；元数据观察、去重、DOI/撤稿/勘误状态；PDF evidence；BibTeX 候选 | `apps/server/src/research/research-service.ts`、`apps/server/src/compliance/` |
| 证据写作 | Paper Claim、Source Evidence、ClaimEvidenceLink；supported/partial/unsupported/stale/orphaned；reanchor；Section Contract；Argument Graph；Writing Guard | `apps/server/src/claims/`、`apps/server/src/writing/`、`docs/ROADMAP-WRITING-QUALITY.md` |
| 评审 | 多 pass Review、Review Issue、targeted re-review、编译后复核、机械/证据/论证/venue/对抗检查 | `apps/server/src/agent/review-service.ts`、`apps/web/src/components/workspace/ReviewDialog.tsx` |
| 记忆与上下文 | 用户指令、Paper Memory、候选抽取、逐部分审核、过时标记 | `apps/server/src/agent/memory-service.ts`、`apps/web/src/components/workspace/MemoryDialog.tsx` |
| 安全写入 | 文件/项目版本、冲突校验、逐 hunk 编辑、Accept/Reject、Git checkpoint、reverse three-way rollback | `apps/server/src/workspace/`、`docs/DESIGN.md` |
| 协作 | 只读分享、评论、账户/项目 ACL、Yjs 文本合并、presence、离线/重启持久化原型 | `apps/server/src/collaboration/`、`docs/PLAN-ACCOUNT-TEAM-COLLABORATION-AND-SKILLS.md` |
| 扩展 | versioned Skill、Harness、MCP capability allowlist、领域/venue profile | `apps/server/src/skills/`、`docs/ROADMAP-HARNESS-SKILLS-MCP.md` |

### 2.2 真实缺口不是“没有功能”

现有路线图已把不少能力标成 Done，但从作者体验看仍有四个纵向断点：

1. **能力分散**：Claim/Evidence、Research、Review、Compliance 和 ChangeSet 有数据关系，UI 还没有形成一条“选择句子 -> 查看证据 -> 生成候选 -> 审批 -> 编译 -> 复核”的连续路径。
2. **计划到生成的契约不够可见**：Agent Plan 已有 evidence dependencies，但作者不能在生成前后快速比较 required claims、allowed evidence、missing evidence 和候选新增内容。
3. **Research 到正文仍需手工搬运**：元数据核验、证据摘录、Claim 链接和 BibTeX 候选存在，但缺少类似“这篇文献支持正文哪句话”的统一引用工作台。
4. **质量结果的可解释性要前置**：Review 有多 pass 状态，产品还需要把 provider unavailable、coverage incomplete、unresolved 和 blocking 的差别变成作者可以行动的界面。

这意味着下一阶段应优先做**纵向闭环和可见性**，而不是再增加顶层 Agent 名称。

## 3. 产品版图

### 3.0 一页对比矩阵

下表只比较公开可见的产品形态，不把商业宣传等同于质量保证。`✓` 表示官方明确展示/说明，`~` 表示部分能力或需要配置，`?` 表示公开资料不足。

| 系统 | 论文/LaTeX 工作区 | 研究/PDF | 引用语境 | 选区/错误入口 | 协作 | 本地/自托管 | 对 FastWrite 的主要启发 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Prism | ✓ | ✓ | ? | ✓ | ✓ | ? | 项目级上下文、编辑-编译-问答一体化 |
| Overleaf AI | ✓ | ~ | ~ | ✓ | ✓ | CE 可自托管 | 选区动作、Error Assist、Citation reviewer、插回正文 |
| Writefull | ~ | - | - | ✓ | - | - | 学术语言、术语和句子强度保护 |
| Paperpal | ~ | ~ | ~ | ✓ | - | - | 投稿场景、语言和结构检查组合 |
| Jenni | ~ | ✓ | ~ | ✓ | ~ | - | 长文上下文、autocomplete、资料问答 |
| SciSpace | - | ✓ | ~ | ~ | - | - | PDF 逐段解释、表格/图表问答 |
| Elicit | - | ✓ | - | ~ | - | - | 问题驱动检索、筛选、字段化提取 |
| Consensus | - | ✓ | ~ | ~ | - | - | 来源和结论边界一起展示 |
| scite | - | ✓ | ✓ | ~ | - | - | 支持/反驳/提及的 citation stance |
| Scribe / HeyTeX | ✓ | - | - | ~ | ✓ | ✓ | 离线优先、provider BYOK、编译队列 |
| La Suite Docs / mist | - | - | - | ✓ | ✓ | ✓ | suggest mode、相对锚点、评论和撤权 |
| AI Scientist-v2 | ~ | ✓ | - | ~ | - | ✓ | 阶段化 pipeline、实验日志和可复现产物 |

产品矩阵说明了 FastWrite 的机会：单项产品各有强项，但公开资料中没有一个系统同时把证据关系、审批式修改、投稿规则、可回滚 provenance 和本地部署做成同一条闭环。FastWrite 应把“少数高可信工作流”做深，而不是追求菜单数量。

### 3.1 闭源/托管产品

| 产品 | 公开能力 | 值得借鉴 | FastWrite 的取舍 |
| --- | --- | --- | --- |
| **OpenAI Prism** | 官方公开定位为面向科学家的 AI-native LaTeX 工作空间；强调项目级上下文、自然语言写作/改写、研究与引用辅助、公式/LaTeX 帮助、实时协作和从编辑到编译的连续体验。具体模型、检索覆盖、审阅规则和内部数据流未公开。 | 把“AI 理解整篇项目”做成默认体验；把 Chat、编辑、编译和协作放在同一工作区；复杂任务以项目上下文而不是单段 prompt 驱动。 | 借鉴工作区整合和低摩擦入口；不复制云端封闭依赖。用 FastWrite 已有 Memory、Skill、Claim/Evidence、ChangeSet 做可审计版本。 |
| **Overleaf AI / AI Assist** | 官方文档明确列出 AI assistant、Error Assist、Writefull language suggestions、改写（paraphrase/concise/scientific/split/join）、标题/摘要生成、TeXGPT、公式生成、表格生成、同文档提问；选中内容会成为上下文；Citation reviewer 可扫描无支持陈述并从 Dimensions 建议文献，选中后可写入文档和 bibliography。 | AI 动作应出现在选区、错误行、Insert 菜单和侧栏等作者当前工作位置；短任务要有专用动作，不必每次写 prompt。Citation reviewer 的“扫描 -> 高亮 -> 建议 -> 插入”很适合变成证据流。 | 直接补齐选区动作和 Error Assist 的交互；引用建议必须接入 ResearchWork/SourceEvidence/批准状态，不能只把检索结果写入 `.bib`。 |
| **Writefull** | 面向学术写作的语言、语法、搭配、改写和翻译建议，深度嵌入 Overleaf 等写作环境。 | 学术英语建议应保留术语、数字、引用和句子强度；要能解释修改，而不是只返回替换文本。 | 复用 Revise Skill 和 ChangeSet；把“术语/数字/引用未变”作为确定性检查，后续再接专门学术语言 provider。 |
| **Paperpal** | 商业学术写作套件，公开宣传语言校对、学术改写、结构/清晰度、引用与投稿辅助，并覆盖 Word、Web 等入口。 | 语言质量、投稿检查、术语一致性和期刊场景应组合成任务，而不是孤立的 grammar checker。 | 不追求通用 Word 生态；优先把 venue profile、匿名性、页数、引用真实性和 AI disclosure 做成强项。 |
| **Jenni AI** | 面向论文和长文写作的编辑器，公开能力包括 AI autocomplete、段落生成/改写、引用管理、PDF/资料问答和文档级工作流。 | 长文生成需要持续上下文、来源面板、段落级接受和“继续写”队列。 | FastWrite 已有 Completion/Continue/Memory；应把 Continue 改成证据和论证缺口排序，而不是按字数扩写。 |
| **SciSpace** | 公开定位为论文阅读与研究助手，提供 PDF 问答、解释、总结、文献发现和资料对照。 | 阅读侧的逐段解释、表格/图表问答、跨论文比较是写作前的关键输入。 | 增加用户授权的 PDF evidence extraction 和表格/图注 evidence；所有摘录必须记录页码、来源和授权边界。 |
| **Elicit** | 公开定位为研究问题驱动的文献发现、筛选、表格化提取和证据综述工具。 | 研究流程应从问题、筛选标准、字段抽取到证据表，而不是只返回搜索结果。 | 可把 `ResearchRun.queryPlan` 扩展为可审核 screening protocol 和 extraction schema；不直接把模型摘要当事实。 |
| **Consensus** | 公开定位为以论文为来源的研究问答和证据摘要，强调从学术文献回答问题。 | 答案要显示来源、结论方向和证据边界；适合用来形成 research brief。 | 只借鉴证据呈现；正文写入仍必须经过 SourceEvidence + Claim link + hunk 审批。 |
| **scite** | 公开能力包括 Smart Citations：区分支持、反驳和提及某一论文的引用语境，并提供文献关系检索。 | Citation 不只是“存在/不存在”，还要表达支持、反驳、上下文和争议。 | 把 citation stance 作为后续 Evidence 类型；初期先做“引用元数据已核验”和“语境未核验”两层，不伪装成完整语义判断。 |
| **Grammarly / 通用 AI 编辑器** | 即时改写、语气、简洁、拼写和跨应用入口成熟，但不是论文证据或 LaTeX 工作流。 | 建议要快、短、可撤销；提示应根据选区和任务自动变化。 | 借鉴交互速度，不引入脱离 LaTeX 语义的全局自动改写。 |

**判断**：Prism 和 Overleaf 是工作区体验基准；Elicit、SciSpace、Consensus、scite 是研究与证据基准；Writefull、Paperpal、Jenni 是语言和长文体验基准。没有一个公开产品同时把证据、ChangeSet、版本回滚、投稿规则和自托管隐私做完整，这是 FastWrite 可占据的组合位置。

### 3.2 开源/可自托管项目

| 项目 | 公开能力/架构 | 可借鉴内容 | 许可证/风险 |
| --- | --- | --- | --- |
| **Overleaf Community Edition** | 成熟的在线实时协作 LaTeX 编辑、项目文件、编译、分享和版本能力。 | LaTeX 项目模型、编译日志、SyncTeX、多人写作 UX 和模板生态。 | AGPL-3.0；官方 README 明确警告 Community Edition 无 sandbox compile 时不适合不可信多租户。不能直接嵌入业务代码；编译隔离是生产阻断项。 |
| **Scribe** | 自称可拥有的协作 LaTeX 编辑器：React + Rust、Yjs、离线优先、Tauri 桌面、Supabase/Postgres、Redis 编译队列、可配置 OpenAI/Anthropic/Gemini/Ollama/LM Studio 等 provider，并打包 Tectonic。 | 单机包与服务器协同、离线 mirror、provider BYOK、编译队列和桌面分支。 | AGPL-3.0；“AI 作为可配置 provider”适合 FastWrite，但不能直接复制其业务代码。 |
| **HeyTeX / TeXlyre 生态** | Monaco/VS Code 风格界面、LaTeX/Typst 双引擎、WASM/服务端编译、模板库、Yjs 实时协作、SyncTeX。 | 双引擎和模板选择器、快速客户端编译、编辑器信息架构。 | AGPL 或各组件不同；需逐库核验。Typst 不是 FastWrite 当前目标，不能因 UI 相似而扩大范围。 |
| **La Suite Docs** | MIT 的协作文本平台；Yjs、presence、评论、离线、细粒度 ACL、可配置 AI gateway/provider、选择文本替换和 AI cursor。 | 评论锚点、协作权限、AI provider 抽象、选区 AI 操作和离线体验。 | 主项目 MIT，但部分导出依赖有不同许可证；富文本模型不能直接替代 LaTeX 源码模型。 |
| **mist** | MIT 的极简实时 Markdown 编辑器；Yjs/TipTap、suggest mode、CriticMarkup、线程评论、highlight anchoring、预览和自动过期。 | “suggest mode”比直接改正文更适合多人审阅；评论应锚定文本而非固定行号。 | MIT；产品故意简化为公开 URL，不能照搬其安全模型。 |
| **Collab-MD** | 文件系统/Git 驱动的人机协作 Markdown：浏览器编辑、AI 通过文件/API 写入、WebSocket 广播、每次保存提交 Git。 | 最小可解释的 AI -> 文件 -> Git -> 广播链路；适合测试 provenance 和回滚语义。 | 项目较小、无账户和权限；只适合作为概念参考。 |
| **AI Scientist-v2** | 开源自动科研系统：生成研究想法、通过 agentic tree search 探索、运行实验、分析数据、生成论文；README 明确提示需在受控 sandbox 运行，并披露 Responsible AI 衍生许可证和 AI 使用披露要求。 | 研究想法、实验、分析、写作、审稿的阶段化 pipeline；每次运行有文件化日志和可复现参数。 | 不适合直接放入 FastWrite 的普通写作请求；执行代码、联网和 GPU 是高风险能力，必须独立沙箱和显式授权。 |
| **Aut_Sci_Write** | 开源 academic research skills suite，公开描述涵盖文献检索/下载、PDF extraction、figure cropping、review writing、Zotero sync、PPT/HTML。 | skill taxonomy、外部工具 adapter、PDF/图表处理、Zotero 集成和研究产物导出。 | 外部来源下载和写入 Zotero 需要用户授权、许可审查和来源审计。 |
| **manuscript-writing** | 可安装 `SKILL.md`，分 revision/review 两种模式；要求 verified facts、标记 Needs Verification、保留原文、按 checklist 做精度/证据/结构审阅。 | 非常接近 FastWrite 的证据边界：review 不改源文、revision 保留原意、无法核验就标记。 | MIT；可吸收为 FastWrite Skill fixture 或规则，不应与现有 Revise/Review 形成第二套协议。 |
| **qinyan-academic-skills / medical-research-skills** | 大量可安装、多语言、按学术研究生命周期组织的 skill，覆盖文献、写作、基金、生物信息、临床、数据分析等。 | 领域 taxonomy、skill manifest、技能发现和领域 profile。 | 数量多不等于质量高；必须 license review、fixture、工具 allowlist、版本和回滚后才能进入 registry。 |

### 3.3 开源基础设施的共同规律

- **Yjs/CRDT 解决编辑合并，不解决论文事实**：FastWrite 的 `PaperFile.version`、Git checkpoint、Claim anchor 和 Review project version 仍需保持不同职责。
- **Git 解决审计和恢复，不等于实时协作**：AI operation、人工编辑、远端同步和 CRDT flush 需要明确事件边界。
- **AI provider 抽象降低锁定，但不自动提高正确性**：模型能力必须被 Skill、evidence dependency、deterministic checks 和审批约束。
- **“无账号/公开 URL”适合 demo，不适合未发表论文**：ACL、路径过滤、room token、撤权和审计必须在服务端成立。
- **自动科研项目最值得借鉴的是 pipeline 和日志，不是自动执行本身**：代码执行、网络访问、数据下载和实验结果写回应是单独的受控能力。

## 4. 功能对照与借鉴判断

| 功能簇 | 竞品成熟度 | FastWrite 当前 | 建议 |
| --- | --- | --- | --- |
| 选区改写/学术润色 | Overleaf、Writefull、Paperpal、Jenni 成熟 | Revise/Skill/ChangeSet 已有 | **P0 体验补齐**：选区浮动动作、短任务模板、流式候选、保留数字/引用/术语的 diff 规则。 |
| 文档级 AI 对话 | Prism、Overleaf、Jenni、SciSpace | Agent/Research/Review 分散存在 | **P1 统一入口**：同一侧栏按上下文切换“当前选区/当前 section/整个项目/证据库”，输出仍路由到任务协议。 |
| Completion | Prism、Overleaf、Jenni 等常见 | 已有 Completion | **P0 优化**：延迟、拒绝 stale response、BibTeX/公式/LaTeX 环境识别、低打扰设置。 |
| Error Assist | Overleaf 成熟 | 有 compile repair、PDF diagnostics | **P0 打磨**：在 Problems 行直接生成最小 ChangeSet，显示日志证据、影响范围、编译前后差异和一键回滚。 |
| 公式/表格/图表生成 | Overleaf 明确提供公式/表格；Prism 公开强调科学写作上下文 | Diagram、LaTeX 结构已有，但跨输入转换仍有限 | **P1**：自然语言/图片/CSV -> 可编辑 LaTeX 候选；必须带 schema、单位、caption、来源和编译验证，不直接覆盖。 |
| 文献搜索 | Elicit、SciSpace、Consensus、Aut_Sci_Write 强 | 4 个元数据 provider + cache | **P0/P1**：query plan、筛选标准、结果去重、来源状态、失败 provider 可见；后续加可配置 provider。 |
| PDF 阅读与证据摘录 | SciSpace、Elicit、Aut_Sci_Write 强 | PDF evidence 基础能力 | **P0**：选页/选段摘录、页码与来源锚点、verbatim/paraphrase 区分、用户批准后进入 Evidence。 |
| Citation 检查与插入 | Overleaf Dimensions、scite、FastWrite compliance | 元数据核验和 BibTeX 已有 | **P0**：引用缺失扫描、citation -> evidence -> claim -> sentence 路径、支持/反驳/提及 stance（先标 unknown，不伪造）。 |
| 长文规划与继续写作 | Prism、Jenni、AI Scientist pipeline | Draft/Continue/Section Contract 已有 | **P0**：计划前后 diff；按证据、实验、论证缺口排序 Continue；缺证据时输出 TODO/unresolved。 |
| Review/批评 | AI Scientist、manuscript-writing、Overleaf citation reviewer | Review 多 pass、Writing Guard 已有 | **P0**：coverage dashboard、issue evidence jump、targeted re-review、部分失败不可显示 clean。 |
| Provenance/AI disclosure | 开源 AI Scientist 有披露要求；多数商业工具公开信息有限 | ChangeSet/Git/audit 基础已有 | **P0**：operation dossier、模型/Skill/provider/输入边界、AI 新增 claim/数字/citation 分类、按 venue 导出 disclosure。 |
| 实时协作 | Overleaf、Scribe、HeyTeX、Docs、mist 强 | Yjs/ACL/评论基础已有 | **P1**：稳定化 room auth、评论相对锚点、断网/重连/撤权 E2E；不把 AI 写权限提升为普通协作者。 |
| Offline/桌面 | Scribe、HeyTeX、Docs 有经验 | 单机发布包、浏览器缓存基础 | **P1/P2**：本地 provider 和离线队列；服务器模式先保证历史、同步和权限，不急于打包第二套编辑器。 |
| 模板/venue | Overleaf、HeyTeX 强 | bundled templates、publication target、compliance 已有 | **P0**：模板来源/版本/信任等级可见；把检查结果变成可修复 finding。 |
| Skills/扩展 | Aut_Sci_Write、qinyan、medical skills 强 | Skill registry/Harness/MCP 已有 | **P1**：manifest + license + capabilities + fixture + eval + release/rollback；数量服从质量。 |
| 自动执行实验 | AI Scientist-v2 强但高风险 | 不执行用户实验代码 | **P3/独立产品边界**：仅做沙箱任务、用户授权、资源/网络配额和 artifact 绑定；不混入普通写作 Agent。 |

## 4.1 FastWrite 代码映射：已有、缺口与验收信号

| 竞品启发 | FastWrite 当前落点 | 仍需补强的产品问题 | 可观测验收信号 |
| --- | --- | --- | --- |
| Prism 的项目级上下文 | `AgentTaskPlan`、Paper Memory、Skill、Review 输入边界 | 作者不知道当前任务带入了哪些文件、claim 和 evidence | 生成前显示上下文清单；超出 scope 的输入/输出被拒绝 |
| Overleaf 的选区动作 | `Revise`/`Continue`/ChangeSet API 和 Workspace 选区 | 动作入口分散，短任务仍需打开对话框 | 选区可直接发起改写/精简/拆分/翻译；返回逐 hunk diff |
| Error Assist | LaTeX compile diagnostics、compile repair | 日志与最小修复候选之间的路径不够短 | 每个 Problems finding 能生成有界 ChangeSet，编译失败可一键回滚 |
| Elicit 的研究协议 | `ResearchRun.queryPlan`、screening、extraction fields | 研究计划、筛选决定、证据摘录还未形成统一工作台 | 每个纳入/排除决定有理由、时间、来源和可导出审计记录 |
| SciSpace 的 PDF 阅读 | `SourceEvidence`、PDF evidence reader | 页码/段落/表格图注摘录的交互和授权提示需强化 | 摘录含 locator、source hash、verbatim/paraphrase 和批准状态 |
| scite 的 citation stance | citation stance 基础模型/路线 | 未判断不能被显示为支持或反驳 | 未核验显示 `unknown`；stance 变更可追溯且不改变 metadata verification |
| Overleaf citation reviewer | metadata providers、BibTeX、claim/evidence link | 缺失引用扫描到正文插入仍有断点 | 建议文献先成 candidate，批准后才生成 `.bib`/正文 ChangeSet |
| La Suite/mist 的协作 | Yjs、评论、ACL、离线 shell | 相对锚点、撤权、断线恢复和多节点压力仍需 E2E | 重连不丢编辑；撤权立即阻断写入；评论不因行号变化漂移 |
| AI Scientist 的 pipeline | job queue、experiment runner、artifacts | 执行权限、网络、资源和结果 provenance 需独立展示 | 未授权任务不能启动；artifact 绑定 commit/input hash；超额自动终止 |

## 4.2 关键产品原则

1. **上下文先于生成**：任务开始前展示 scope、来源、模型/provider、Skill、证据依赖和预计写入路径。
2. **候选先于正文**：所有正文、`.bib`、表格、公式和图注变更均先进入 ChangeSet；AI 没有“直接保存正文”的旁路。
3. **元数据、支持关系、立场三条链分开**：DOI/作者/年份核验不等于某个 claim 被支持，也不等于引用在语境中支持该 claim。
4. **失败必须可见**：provider unavailable、输入不完整、证据缺失、编译失败、部分复核不能汇总成“通过”。
5. **外部能力最小授权**：网络检索、PDF 下载、Zotero/GROBID/Pandoc、Shell、编译和实验执行都要有独立开关、范围、日志和撤销。
6. **确定性检查保护模型输出**：数字、单位、引用键、LaTeX 环境、术语、匿名性和页数等可机械验证的内容，不依赖模型自评。

## 5. 建议实现路线

### 5.0 优先级决策框架

优先级不是按竞品热度排序，而是按“用户收益 × 可验证性 ÷ 风险与工程跨度”排序：

| 层级 | 时间目标 | 进入条件 | 退出条件 |
| --- | --- | --- | --- |
| P0 | 4–6 周 | 复用现有 Claim/Evidence/ChangeSet/Review/Research API | 一条从选区或 finding 到审批、编译、复核的闭环可演示且有测试 |
| P1 | 6–12 周 | P0 的事件、权限和 provenance 稳定 | 研究协议、PDF 证据、协作和 Skill 治理可在受控 staging 验证 |
| P2 | 之后 | 有明确用户需求和部署边界 | 适配器、桌面/离线、本地模型有恢复、撤权和迁移演练 |
| P3 | 独立轨道 | 单独的安全评审和资源预算 | 实验执行与普通写作 Agent 完全隔离，不能互相绕过授权 |

### 5.1 推荐的最小可行闭环

以“当前句子存在一个未支持陈述”为例，目标链路应固定为：

`选择句子 -> 查看 claim/evidence 状态 -> 搜索或打开来源 -> 批准摘录 -> 生成 citation/改写候选 -> 查看 hunk 和 claim/number/citation delta -> 审批 -> 编译 -> targeted review -> provenance dossier`

这条链路同时验证了竞品最有价值的入口和 FastWrite 的差异化约束。没有必要先做一个泛化聊天页；聊天只是该流程的一个输入方式。

### P0：把现有能力变成连续写作闭环（4–6 周）

#### A. Evidence cockpit

在 Workspace 侧栏或底部面板增加统一的 Evidence cockpit，至少包含：

- 当前章节的 Section Contract、required claims、allowed evidence、open questions；
- Claim 状态：supported、partial、unsupported、stale、orphaned；
- 每条 claim 的正文锚点、数字/引用、证据摘录、来源页码和最近一次检查；
- “生成候选”前的 evidence dependencies；“候选生成”后的新增 claim/number/citation diff；
- finding 直接跳回正文、`.bib`、实验结果、图表或 source evidence。

验收：用户不打开数据库或日志，也能从一句正文跳到证据，再跳到一条待审批修改；无证据不能悄悄变成确定陈述。

#### B. Citation/evidence 流程

借鉴 Overleaf Citation reviewer、Elicit、SciSpace、scite，但按 FastWrite 的证据边界实现：

1. 扫描 unsupported statement 和 citation key；
2. 从 Research providers 返回候选文献并展示 provider、元数据状态和来源 URL；
3. 用户选择论文后，授权导入 PDF 或文本摘录；
4. 形成 SourceEvidence，记录 locator、representation、source hash/来源标识和授权时间；
5. 用户批准 Evidence，再建立 ClaimEvidenceLink；
6. 生成 BibTeX 和正文 citation 只进入 ChangeSet；
7. 显示“引用存在”与“引用支持该句”是两个不同状态。

#### C. Error Assist 与短动作

在 Problems/PDF diagnostics 旁提供：Explain、Fix minimally、Preserve semantics、Retry compile。输入只包含有界日志、相关文件和选中错误，输出必须是最小 ChangeSet，接受后自动编译并记录 operation checkpoint。

选区浮动菜单提供：Polish、Make concise、Make scientific、Split、Join、Translate、Check support。每个动作使用已有 Revise Skill，不引入新的自由格式 Agent。

#### D. Evidence-aware Continue

将 Continue 的候选排序固定为：

1. 已确认但尚未写入的 claim；
2. 有 claim 但 evidence 不足的章节；
3. 尚未解释的实验结果、表格和图；
4. Motivation -> Gap -> Contribution -> Method -> Experiment -> Result -> Conclusion 的关系缺口；
5. 摘要/结论与正文范围或数字不一致；
6. 未解决的 Review Issue；
7. 最后才是无目标扩写。

每次 Continue 先显示“为什么推荐这个位置”，再进入现有 Plan/ChangeSet。

#### E. Provenance dossier

对每次 AI operation 保存并可导出：

- pre-AI checkpoint、post-AI/applied checkpoint、当前版本；
- workflow、模型、provider、Skill 版本、用户目标、上下文边界；
- 每个 hunk 的 proposed/accepted/edited/rejected；
- 新增或改变的 claim、数字、引用、实验结论；
- 接受后人工修改和回滚事件；
- venue-specific AI usage disclosure 草稿。

不要做“AI 文本检测器”。Provenance 是过程记录，不能宣称能识别文本是否由 AI 生成。

#### F. 评测和可观测性

在现有 `writing:eval` 上增加：

- citation metadata precision/recall；
- claim anchor 稳定率和 evidence link 保留率；
- plan dependency 满足率；
- unsupported claim 阻断率；
- compile repair 一次成功率和回滚率；
- Review pass coverage、unavailable 比例和 clean 结论误报率；
- AI hunk 接受率、接受后撤销率、人工二次编辑量。

### P1：形成研究型工作台（6–10 周）

- **Research protocol**：查询计划、纳入/排除标准、字段抽取 schema、筛选结果审计；
- **PDF reading/evidence**：页级/段级/表格/图注摘录，授权、来源和置信度明确；
- **Citation stance**：支持/反驳/提及/未判断，先从用户确认和 provider evidence 开始；
- **表格/公式/图表助手**：自然语言或图片/CSV 输入，schema + preview + editable LaTeX + compile check；
- **Review coverage UI**：Mechanical/Evidence/Argument/Domain/Venue/Adversarial 的独立状态和失败原因；
- **Comments 与 Issue Resolution**：评论、Review Issue、Claim、ChangeSet 使用统一可重定位锚点；
- **Skill marketplace（受治理）**：manifest、版本、license、capability、MCP allowlist、fixture、eval、回滚；
- **协作可靠性**：room token、路径 ACL、相对位置评论、离线恢复、撤权、重连和大型文档性能。

### P2：生态和部署优势（10 周以后）

- Zotero 双向同步（默认只读，写回需显式授权）；
- DOI/Crossref/OpenAlex/Semantic Scholar/GROBID/Pandoc adapter；
- 只读审稿链接、评论导出、provenance dossier 分享；
- Tauri/桌面离线编译与本地模型 provider；
- 服务器版 PostgreSQL、对象存储、队列、隔离编译 worker；
- 可选 Typst/Markdown 导入导出，但不改变 LaTeX 论文主模型。

### P3：谨慎评估

- AI 运行实验、自动下载数据、自动改代码并生成结果；
- 自动决定论文是否“可接收”、生成接收概率；
- 全文无审批自动重写；
- 多 Agent swarm；
- 为追求功能数量而复制 Prism/Overleaf 的云端通用编辑器；
- AI 文本检测器或以风格分数作为 blocking 条件。

## 6. 产品交互建议

### 6.1 一个侧栏，多个明确上下文

借鉴 Prism/Overleaf 的侧栏入口，但避免无边界 Chat。侧栏顶部显示上下文范围：`Selection`、`Section`、`Paper`、`Evidence`、`Review issue`。每次运行展示输入边界和输出类型：`Suggestion`、`ChangeSet`、`Evidence candidate`、`Review finding`。

### 6.2 三种结果必须区分

| 结果 | 是否写正文 | 用户动作 |
| --- | --- | --- |
| Suggestion | 否 | 接受后进入编辑器/ChangeSet |
| Evidence candidate | 否 | 核验来源、批准或拒绝 |
| ChangeSet | 否，直到审批 | 逐 hunk 接受、编辑、拒绝、编译 |
| Approved source | 是 | 进入正常版本、Git 和 Review 闭环 |

### 6.3 不确定性要可见且可行动

- `verified`：有明确来源和定位；
- `supported`：已批准 Evidence 与 Claim 关联；
- `candidate`：模型或外部 provider 提出，尚未批准；
- `unresolved`：需要用户补材料或判断；
- `stale`：来源/正文版本改变，需重新核验；
- `blocking`：确定性规则阻止投稿或写入；
- `warning`：需要作者判断，不自动阻止。

不要把这些状态折叠成一个绿色分数。

## 7. 架构与安全约束

1. **Provider 可替换，证据模型不可绕过**：OpenAI/Claude/本地模型都必须返回统一结构，不能直接写 Workspace。
2. **网络检索、PDF 下载、Zotero 写入、GitHub push、Shell/实验执行全部经过 MCP capability allowlist 和用户授权**。
3. **未发表论文默认最小上下文、可选本地 provider、明确数据处理提示**。不要复制 Overleaf AI 的“内容会发送给第三方”作为默认假设。
4. **LaTeX 编译必须隔离**。Overleaf CE README 已明确指出未 sandbox compile 会暴露容器资源；FastWrite 服务器模式上线前必须有 worker/container/资源限制。
5. **CRDT、PaperFile.version、PaperProject.version、Git OID 各自承担不同职责**，不以任意一个字段冒充全部历史。
6. **技能生态必须供应链治理**：manifest、固定版本、license、权限、输入/输出 schema、测试 fixture、评测结果和撤销机制缺一不可。
7. **外部论文来源的 license 和 robots/terms 必须可审计**；不能因为能下载就默认可以长期存储或转发。

## 8. 直接进入下一期 Backlog 的条目

| 优先级 | 条目 | 产出 |
| --- | --- | --- |
| P0 | Evidence cockpit | Claim/Evidence/Section Contract/Review/ChangeSet 的统一面板与跳转 |
| P0 | Citation reviewer v1 | unsupported statement 扫描、候选文献、批准 Evidence、BibTeX ChangeSet |
| P0 | Problems Error Assist | 有界日志 -> 最小修复 ChangeSet -> 编译 -> 回滚 |
| P0 | Selection AI actions | 选区改写、精简、学术化、拆分/合并、翻译、support check |
| P0 | Continue ranking | 证据/论证缺口优先，生成前后依赖验证 |
| P0 | Provenance dossier | operation checkpoint、模型/Skill、hunk 决策、claim/citation/number delta、disclosure |
| P0 | Review coverage | pass 状态、provider error、输入边界、未完成覆盖禁止 clean |
| P0 | Eval expansion | 真实多文件论文、citation/claim/compile/review 指标进入 CI |
| P1 | Research protocol | query plan、筛选、字段抽取、来源审计 |
| P1 | Evidence reader | 页/段/表格/图注摘录和批准流程 |
| P1 | Citation stance | 支持/反驳/提及/未判断 |
| P1 | Table/equation assistant | 图片/CSV/自然语言到可编辑、可编译 LaTeX |
| P1 | Skill governance | manifest、license、capability、fixture、eval、release/rollback |
| P1 | Collaboration hardening | room auth、相对锚点、离线、重连、撤权和大型文档性能 |
| P2 | Zotero/Pandoc/GROBID adapters | 可授权的外部研究工具链 |
| P2 | Desktop/local model | 单机隐私与离线闭环 |
| P3 | Sandboxed experiment runner | 与普通写作 Agent 隔离的实验自动化 |

## 9. 明确不建议做的事情

- 再创建一个独立的“论文 Agent”“引用 Agent”“审稿 Agent”而不共享 Claim/Evidence/ChangeSet；
- 允许 AI 直接覆盖文件，或用一个 Accept 按钮绕过 hunk 审批和编译；
- 将模型生成的引用、数字、表格结果当作已验证事实；
- 把引用数量、语言流畅度或模型自评汇总成论文质量分；
- 在 Git rollback、provenance、编译隔离和权限模型未稳定前优先做实时多人炫技功能；
- 为了兼容开源 skill 数量而放宽网络、Shell、写外部服务和执行代码权限；
- 直接复用 AGPL 项目的业务代码或不核查依赖许可证。

## 10. 来源与核验入口

### 官方产品和文档

- [OpenAI Prism 产品页](https://openai.com/prism/)
- [OpenAI Introducing Prism](https://openai.com/index/introducing-prism/)
- [Overleaf AI features](https://docs.overleaf.com/integrations-and-add-ons/ai-features)
- [Overleaf AI assistant](https://docs.overleaf.com/integrations-and-add-ons/ai-features/ai-assistant)
- [Writefull for Overleaf](https://docs.overleaf.com/integrations-and-add-ons/ai-features/writefull)
- [Elicit](https://elicit.com/)
- [Consensus](https://consensus.app/)
- [SciSpace](https://typeset.io/)
- [scite](https://scite.ai/)
- [Paperpal](https://paperpal.com/)
- [Jenni AI](https://jenni.ai/)

### 开源项目、论文和实现参考

- [Overleaf Community Edition](https://github.com/overleaf/overleaf)
- [Scribe](https://github.com/sunnyallana/scribe)
- [HeyTeX](https://github.com/phucdhh/HeyTeX)
- [TeXlyre](https://github.com/TeXlyre/texlyre)
- [La Suite Docs](https://github.com/suitenumerique/docs)
- [mist](https://github.com/inanimate-tech/mist)
- [Collab-MD](https://github.com/lumenwrites/collab-md)
- [AI Scientist-v2](https://github.com/SakanaAI/AI-Scientist-v2)
- [Aut_Sci_Write](https://github.com/ShZhao27208/Aut_Sci_Write)
- [manuscript-writing](https://github.com/YSLAB-ai/manuscript-writing)
- [qinyan-academic-skills](https://github.com/LeonChaoX/qinyan-academic-skills)
- [medical-research-skills](https://github.com/aipoch/medical-research-skills)
- [Yjs](https://github.com/yjs/yjs)
- [FastWrite writing-quality roadmap](./ROADMAP-WRITING-QUALITY.md)
- [FastWrite next roadmap](./ROADMAP-NEXT.md)
- [FastWrite collaboration/skills plan](./PLAN-ACCOUNT-TEAM-COLLABORATION-AND-SKILLS.md)

## 11. 最终产品判断

FastWrite 不需要证明自己比 Prism 更会“生成一篇论文”，也不需要比 Overleaf 多几十个 AI 菜单。更有价值的目标是：

> **作者提出问题，系统找到可核验材料；作者写下论断，系统显示证据边界；AI 提出修改，作者逐项审批；论文准备投稿，系统给出可追溯的检查结果。**

如果只能做一件事，优先完成 Evidence cockpit + Citation reviewer + Provenance dossier 的闭环。这三项会把 FastWrite 已经存在但分散的技术能力变成竞品难以用一个通用 Chat 复制的产品体验。
