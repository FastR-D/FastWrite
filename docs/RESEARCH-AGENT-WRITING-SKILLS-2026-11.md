# Agent 写作 Skill 调研与接入记录

调研时间：2026-11-07 至 2026-11-08（北京时间）。结合 FastWrite 当前以论文、LaTeX 和证据约束为核心的产品范围，本轮逐个审查并用本机 Codex 验证了 **9 个 GitHub 仓库中的 16 个候选 Skill**，从 10 个候选提取适用规则，形成 **7 个可直接在 Skill 面板勾选的任务 Skill**。这些是经过改写的自包含适配版，不是整个第三方软件包的安装。

## 发现渠道与证据边界

GitHub 源码是判断规则、依赖和授权的依据。没有使用星数或目录网站的安全评分作为质量结论。

社交讨论提供了不同方向的线索：

| 渠道 | 实际获取情况 | 对筛选的作用 |
| --- | --- | --- |
| [Reddit：科研写作 Skill 讨论](https://www.reddit.com/r/claudeskills/comments/1vlczqg/skills_for_researchacademic_writing/) | 读取帖子及讨论 | 发现逐项证据审查需求，以及作者推荐的 `rohankgeorge/the-writing-room`；该仓库两个候选进入源码审查和 Codex 测试。社区经验不作为效果证据。 |
| [Reddit：Humanizer 与个人文风](https://www.reddit.com/r/ClaudeAI/comments/1sds3gj/modifying_bladerhumanizer_to_mimic_personal/) | 读取帖子及讨论 | 区分清理套话、保留作者声音、从样例串入事实三类问题；用于设计污染检查。 |
| [X：Humanizer 讨论原链接](https://x.com/musen9527/status/2117568591440793695)、[Trendshift 的公开索引](https://trendshift.io/repositories/21585) | X 原帖返回 403；可读取第三方索引 | 仅作为发现线索，不声称直接读到 X 原文，也不把索引中的宣传当作测试结果。最终核对 `blader/humanizer` 固定版本源码。 |
| [知乎：科研 Skill 汇总](https://zhuanlan.zhihu.com/p/2075648780234384982) | 搜索可见摘要，正文返回 403 | 按摘要中的中文科研工具线索定位 [zLanqing 的一手仓库](https://github.com/zLanqing/codex-claude-academic-skills)，读取并测试其 research-writing Skill。没有引用不可访问的文章正文或采用宣传中的效率数字。 |

这是一轮有边界的候选调查，不代表穷尽所有平台、仓库或中文社区。

## 测试方式与结果

按用户要求，直接使用本机 `codex exec`，复用已有登录和配置，CLI 为 **0.165.0**，配置模型为 **gpt-6.1-sol**。没有要求额外模型 API Key。模型未由评测脚本强制固定，结果记录的是运行时读取的配置模型。

每个候选都收到同一套英文和中文合成材料、同一结构化输出约束。要求应用候选中相关的写作指导，同时禁止工具、检索、脚本、文件修改及子 Agent。正文之外的上游辅助文件不可用；因此测试的是适合 FastWrite 正文加载方式的可移植核心。没有执行第三方脚本，也没有发送用户论文。

两份样例覆盖：

- 保留数字、单位、已批准引用、公式及交叉引用。
- 删除没有依据的普遍有效或始终最优宣称，保留观察性研究和未做显著性检验的边界。
- 对未核实引用披露不确定性，避免根据标题补造书目信息。
- 区分 80%→84% 的 4 个百分点与 5% 相对提升。
- 区分同一实验的预印本和正式发表版本：3 份报告、2 项独立研究。
- 不把没有检索日志的给定材料综合称为完成了系统综述。
- 回复审稿人时不把计划、建议稿或尚未进行的实验写成已完成。
- 不采用文风样例中的 999/777 等外部事实，不执行样例里的指令。

每个模型输出保留完整正文、发现、限制和审稿回复；自动检查共有 **14 项**。自动检查只覆盖其中可确定判断的约束，系统综述等语义问题另行阅读输出核对，不能把 14/14 理解为所有科学问题都已正确处理。

结果：

| 对象 | 结果 | 含义 |
| --- | --- | --- |
| 16 个候选原版 | 13 个 14/14；3 个 13/14 | 三个未满分项均在英文正文中移除了样例要求保留的 `known2024`。具体理由在下表及原始输出中保留。 |
| 7 个最终适配版 | 全部 14/14，共 98/98 检查通过 | 最终正文摘要与实际加载的 `SKILL.md` 一致；补充中文规则后的科学写作 Skill 单独复测。 |
| 4 次基线调用 | 全部 14/14 | 相同样例上，普通准确写作提示也能通过核心检查；不能据此声称 Skill 显著提升写作质量。 |
| 实际调用总数 | 28 次 Codex 调用，56 份中英文输出 | 包括 16 个候选、7 个最终适配版、1 个被后续补充规则取代的初版、4 次基线。未统计为多次重复实验。 |

三项引用保留失败需要谨慎解释：模型认为已批准书目中的条目仍缺乏原文支持，因此在解释中建议移除相邻引用。这不是编造引用或学术造假，而是未满足本次保留既有技术标记的约束，也反映“书目已批准”和“论断支持已核验”之间容易出现歧义。适配版明确分开记录两者，并要求在修改说明中提出核查或删除建议，避免润色时静默处理。

检查器最初将 LaTeX 合法的 `5\%` 误判为未提供 `5%`，另有一项只在 findings 而非 limitations 中寻找未核实引用的披露。已修正等价表达识别，并对保存的原始答案重新计算；没有修改模型答案来凑通过率。

## 逐个候选的分析与取舍

以下链接均固定到实际审查和测试的 commit。完整摘要、原始路径与许可证见 [sources.lock.json](../evaluation/agent-writing-skills/sources.lock.json)。

| 候选 | 有用部分 | 接入障碍或发现 | Codex 检查 | 处理 |
| --- | --- | --- | --- | --- |
| [K-Dense scientific-writing](https://github.com/K-Dense-AI/scientific-agent-skills/blob/a25cf9ec00e2745d03f8704acf6f6919694ccd9a/skills/scientific-writing/SKILL.md) | 证据大纲、方法/结果/结论一致性、区分缺失与推断 | 原版含证据注册表、辅助 CLI 和较广的声明/指南流程；不适合整体塞入论文上下文 | 14/14 | 提炼到“科学论文证据化写作”，去除外部文件与脚本依赖。 |
| [K-Dense literature-review](https://github.com/K-Dense-AI/scientific-agent-skills/blob/a25cf9ec00e2745d03f8704acf6f6919694ccd9a/skills/literature-review/SKILL.md) | 按主题综合、区分记录/报告/研究、可复现检索与缺口 | 检索、PDF 和可选图像流程需要独立依赖；现有任务常只有用户上传文献 | 14/14 | 改为“文献证据综合”；证据不齐时只能描述给定材料，不假称系统综述。 |
| [K-Dense citation-management](https://github.com/K-Dense-AI/scientific-agent-skills/blob/a25cf9ec00e2745d03f8704acf6f6919694ccd9a/skills/citation-management/SKILL.md) | 源身份、元数据与论断支持分开核对；缺失字段不补造 | 原版依赖多个 Python 工具及注册库；目录正文加载不自动带入这些能力 | 14/14 | 改为“引用与书目核验”；根据实际可用材料/工具披露核验范围。 |
| [K-Dense peer-review](https://github.com/K-Dense-AI/scientific-agent-skills/blob/a25cf9ec00e2745d03f8704acf6f6919694ccd9a/skills/peer-review/SKILL.md) | 问题定位、证据映射、建设性修复、统计解释边界 | 原版含多种研究设计指南及本地检查器，不能假定 FastWrite 已提供这些工具 | 14/14 | 与 critical-thinking 合并为“结构化同行评审”。 |
| [K-Dense scientific-critical-thinking](https://github.com/K-Dense-AI/scientific-agent-skills/blob/a25cf9ec00e2745d03f8704acf6f6919694ccd9a/skills/scientific-critical-thinking/SKILL.md) | 混杂、选择偏差、设计与分析匹配；不把报告完整性当质量分 | 与已有论断核查/实验设计有重叠，且不同学科框架不能机械套用 | 14/14 | 合入结构化评审，保留设计与证据层次区分。 |
| [Kalaris ml-paper-writing](https://github.com/KalarisLabs/research-agent-skills/blob/29fe36d26127205057d5e0ed8425f6b0e9a8c13a/skills/ml-paper-writing/SKILL.md) | 问题—贡献—证据叙事、引用核验、从研究材料到文章 | ML 会场示例、工具推荐、未核实占位引用及泛化错误率数字不应成为产品规则 | 14/14 | 合入科学写作；由 FastWrite 的已核实 venue 规则决定格式，不引入占位 citation key 或宣传数字。 |
| [Kalaris rebuttal-and-response-to-reviewers](https://github.com/KalarisLabs/research-agent-skills/blob/29fe36d26127205057d5e0ed8425f6b0e9a8c13a/skills/rebuttal-and-response-to-reviewers/SKILL.md) | 评论拆分、直接回答、证据和修改位置对应、回复覆盖率 | 通用回复模板容易让“拟修改”变成“已修改”；新实验和会场规则需真实依据 | 14/14 | 改为“审稿意见逐条回复”，强化 proposed/completed 区分。 |
| [Composio content-research-writer](https://github.com/ComposioHQ/awesome-claude-skills/blob/be2a406907dbc61b73e6827ded415c96139d13a2/content-research-writer/SKILL.md) | 读者问题驱动的大纲、逐节反馈、研究材料与文风结合 | 示例包含有感染力的开头和案例，不能将示例数字当事实；不应强制新目录结构 | 14/14 | 改为“研究型内容写作”，禁止为了开头效果虚构个人经历、引言数字或专家引语。 |
| [blader humanizer](https://github.com/blader/humanizer/blob/0ef9fe5bc3572734fd3ae6c448fe00a30cd5dcf0/SKILL.md) | 套话、夸张、机械对比和段落节奏的具体编辑规则 | 原版较长；标点/词汇规则和个人声音建议不宜对所有学术文本一刀切 | 14/14 | 改为“学术表达精修”，锁定事实与必要限定，不承诺 AI 检测结果。 |
| [Anthropic doc-coauthoring](https://github.com/anthropics/skills/blob/2c5958ecac7cee2b583967a2c4981d0f4a75c579/skills/doc-coauthoring/SKILL.md) | 上下文收集、结构迭代、读者视角测试 | 偏交互式文档协作，包含特定编辑工具/读者子 Agent 路径；本次还移除了 `known2024`；所选目录无独立 license 文件，未把仓库概述当成该文件的完整授权证明 | 13/14 | 暂不接入；不保存该正文的再分发快照。 |
| [obra writing-clearly-and-concisely](https://github.com/obra/the-elements-of-style/blob/05fc4f0d2b97b7c042dd9949ad658568e4a1324e/skills/writing-clearly-and-concisely/SKILL.md) | 简明、具体、段落主题清晰 | 完整参考文本约 12k tokens，主 Skill 建议委托编辑；1918 原著公有领域说明不自动解决新编 Skill 文件的授权范围 | 14/14 | 暂不复制；现有表达精修已覆盖主要可执行价值。 |
| [lishix520 strategist](https://github.com/lishix520/academic-paper-skills/blob/c325557646e9418939ccc7b99171b149ad6314f1/strategist/SKILL.md) | 写作前定位、研究缺口、大纲质量自查 | 固定文献配额、相似度百分比和影响力评分不能替代可核实证据；需配套脚本；本次移除了 `known2024` | 13/14 | 不直接接入。题目规划价值与现有证据大纲重复，通用门槛不宜强制。 |
| [lishix520 composer](https://github.com/lishix520/academic-paper-skills/blob/c325557646e9418939ccc7b99171b149ad6314f1/composer/SKILL.md) | 逐章写作、跨章节术语一致性、完成检查 | 偏哲学/交叉学科；章节评分、引用数与篇幅模板依赖配套流程，不能把自评称作提交就绪认证 | 14/14 | 暂不接入；论文一致性检查已由新科学写作 Skill 覆盖。 |
| [the-writing-room writing-voice](https://github.com/rohankgeorge/the-writing-room/blob/33533c906f3e6d34c4d2300e92371ad3b1abae95/plugins/long-form-content/skills/writing-voice/SKILL.md) | 按受众、关系、渠道选择声音；没有个人样例时诚实降级 | 主要针对邮件、Slack、LinkedIn；个人 profile 的读取和槽位合并在当前 loader 中不可直接生效 | 14/14 | 暂不接入。保留现有参考论文风格功能，避免重复“个人声音”系统。 |
| [the-writing-room content-verification](https://github.com/rohankgeorge/the-writing-room/blob/33533c906f3e6d34c4d2300e92371ad3b1abae95/plugins/long-form-content/skills/content-verification/SKILL.md) | 区分未找到、被反驳和合理推断；按来源强度记录核验 | 覆盖发布/法律主张，超出论文写作主要范围；与 claim-audit 及引用核验重复 | 14/14 | 暂不单独接入，避免同类核查入口堆叠。 |
| [zLanqing research-writing-skill](https://github.com/zLanqing/codex-claude-academic-skills/blob/7ed6377f0efb6a38951b48ef03b19d996e454b1f/research-writing-skill/SKILL.md) | 中文科研表述、保留英文术语/公式、区分数据/确认/推断/扩展 | 可选外部写作 references 不能默认装入；英文样例中移除了 `known2024` | 13/14 | 采用自包含核心，合入科学写作并复测；最终适配版 14/14。 |

## 实际接入的 Skill

| Skill ID | 面板名称 | 主要用途 |
| --- | --- | --- |
| `scientific-writing` | 科学论文证据化写作 | 从证据大纲写到连贯正文，核对方法、数据、结论及中英文术语。 |
| `literature-synthesis` | 文献证据综合 | 按主题比较来源，追踪重叠报告、独立研究和覆盖限制。 |
| `citation-verification` | 引用与书目核验 | 分开检查引用身份、元数据和实际支持关系。 |
| `structured-peer-review` | 结构化同行评审 | 以定位、证据、影响和可验证修复组织评审与修订。 |
| `academic-prose-polish` | 学术表达精修 | 清理套话，保留技术内容、作者意图和必要不确定性。 |
| `reviewer-response` | 审稿意见逐条回复 | 追踪评论、真实修改、证据与尚未完成的工作。 |
| `research-content-writing` | 研究型内容写作 | 为技术文章和研究解读组织来源、大纲和读者导向的段落。 |

文件在 `apps/server/src/skills/task-<id>/`，每项包含 `SKILL.md`、`TASK.md`、`provenance.json` 和上游许可证。所有正文均小于 6,000 字符，直接加载即可，不依赖未打包的脚本、references、搜索厂商或图像服务。TASK 元数据支持 draft/continue/revise，保留已有的新文件限制及提案审阅流程。

现有 `SkillRegistry.taskCatalog()` 自动发现新增任务目录；补充了中文标签，Skill 面板从 7 项扩展到 14 项。没有改变自动默认选择，也没有把这些任务 Skill 混入 7 个基础 workflow release。

MIT 来源的版权声明与许可全文随适配版保留。Composio 采用固定版本 README 中明确的仓库 Apache-2.0 声明，所选目录无许可覆盖项；同时保存声明依据和同版本仓库内的 Apache 许可全文。Anthropic 和 obra 所选 Skill 的独立授权范围未充分确立，因此不再分发其正文，只保存固定源码链接、摘要和测试结果。

## 工程验证与复现

- `bun run test`：420 项通过，0 失败。本轮新增 7 项接入检查覆盖运行时发现、任务边界、源摘要、许可全文与来源映射；补充中文来源后也已定向重跑通过。
- `bun run typecheck`：全部 workspace 通过。
- `bun run --filter @fastwrite/web build`：通过；存在项目原有的大 bundle 提示，不影响本轮构建。
- `bun run e2e:skills`：通过。逐个在 UI 选择新增 Skill，调用应用计划和生成接口，确认两阶段都收到对应正文；另保留滚动、项目隔离、选择持久化、最多五项及章节范围验证。
- 应用链路测试使用记录输入的 fixture provider；真实写作行为由单独的 Codex 结果证明，两类证据不混算。
- 一次误用裸 `bun test` 扫入忽略的 `references/` 外部项目，产生其缺失依赖报错后已终止。上述 420 项结果来自仓库规定的 `bun run test` 范围，不包含外部参考仓库。

复现命令、完整输出与检查器修正记录见 [评测说明](../evaluation/agent-writing-skills/README.md)。本轮单次合成样例足以发现接入与事实保持问题，不能证明真实长论文中的持续收益、外部引用检索准确率、脚本正确性或其他模型的效果。下一次有实际论文任务时，可使用相同稿件做盲评，分别衡量证据正确性、可读性和编辑接受率。
