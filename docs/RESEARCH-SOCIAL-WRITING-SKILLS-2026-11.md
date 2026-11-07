# 从科研帖子与收藏到 FastWrite 写作流程

调研日期：2026-11-08。本轮重点是把实操建议变成写作系统中可选择、可审阅、可测试的行为。前一轮 GitHub Skill 调研见 [既有报告](RESEARCH-AGENT-WRITING-SKILLS-2026-11.md)。

## 本轮落地

新增六个自包含任务 Skill，沿用任务规划 → 作者确认 → 生成 ChangeSet 的现有流程。侧栏增加六个写作阶段快捷入口，点击会明确替换当前选择，仍受最多五个 Skill、项目间选择隔离与持久化规则约束。不是自动执行所有阶段。

| 入口 | 新 Skill | 稿件中的实际行为 | 对应规则 / 案例 |
| --- | --- | --- | --- |
| 文献入稿 | `paper-reading-notes` | 标记阅读范围；抽取带来源定位的材料，再写可用段落，避免堆摘要 | R01–02 / reading-zh,en |
| 搭建主线 | `evidence-storyline` | 从具体问题、现有限制连接到方法与实际贡献；对齐摘要、引言、主图、结论 | R03–04 / story-zh,en |
| 撰写实验 | `experiment-reporting` | 按研究问题组织已完成实验；披露设置、预算差异与复现缺口 | R05–06 / experiment-zh,en |
| 解读结果 | `results-discussion` | 写关键比较、效应和解释；保留代价与负结果，区分观测与机制 | R07–08 / results-zh,en |
| 核对图注 | `figure-caption-audit` v1.0.1 | 核对样本单位、误差定义和数值配对；未看图不声称目检 | R09–10 / figure-zh,en |
| 全文复核 | `manuscript-consistency` | 定位跨章节主张冲突，做最小必要修改，保留作者已确认内容 | R11–12 / consistency-zh,en |

快捷入口按需组合前一轮的文献综合、科学写作、表达精修 Skill。正文输出采用作者语言与现有格式；卡片、比较依据、缺失材料放在任务说明，避免把论文写成审计清单。所有 Skill 保留 LaTeX、数字、标签及已批准书目键，不为新颖性或流畅性编造事实。

## 调研范围与证据层级

完整采样口径见 [sampling.json](../evaluation/social-research-skills/sampling.json)，检索记录见 [queries.json](../evaluation/social-research-skills/queries.json)。这些数字分层记录，不能相加后当作“全部精读篇数”。

- 公开搜索：16 批、64 个检索式，去重得到 173 个 URL。它们包含广告、不相关内容和访问受限页；32 次打开中取得 13 份正文节选，19 次被阻止。其余 141 条只有索引摘录，未作为规则来源。
- Edge 登录态收藏：知乎主收藏筛过 194 条标题，选出 30 条宽口径候选；精读其中 7 篇可见文字正文，其中 2 篇读取评论。小红书收藏及公开搜索共记录 98 个候选，71 个来自收藏；精读 11 篇可见文字正文，其中 9 篇来自收藏，6 篇读取可见或展开后的评论。
- 小红书长手册共显示 47 张图，本轮仅看第 1、2 张；作者在评论中确认存在重复图片。不能把正文、平台 AI 总结或封面当成全部图文已读。所有平台“点点”AI 总结均排除。
- 来源分析账本共 34 条：31 条帖子正文或正文节选记录，加 3 条原始指导资料。25 条选作规则来源，9 条排除或留作范围外参考。每条记录都保留采用点、拒绝点和访问层级，未存帖子或评论全文。

用户界面显示的小红书收藏 868 篇、知乎主收藏 5609 条，均未全部遍历。本轮是有边界的采样迭代，偏向中文计算机/机器学习实践，不能称为全站、全收藏或跨学科穷尽调研。评论展示的总数不是阅读数；账本中的 `methodCommentsCoded` 是人工归类的有效建议单元，既不是独立作者数，也不是统计样本量。

## 实操建议如何转成写作行为

### 从“自己觉得顺”转为“读者能顺着证据理解”

收藏中的 [GPT 写作磨合记录](https://zhuanlan.zhihu.com/p/2096577424561529120) 提供了与本系统贴近的问题：结果先堆出来、设置含糊、段落各自通顺却无法形成证据链。其正文强调读者理解顺序、图文一致与证据层级；评论提醒长提示、过度公式化和防御措辞也可能损害表达，作者也承认没有公平对比验证效果。

据此拆为按阶段使用的短 Skill，保留可执行的检查和交付格式，不复制整篇提示词，不固定三遍改稿，也不增加强制公式。正文提供实际段落，任务说明承载核查信息。

### 从句式与故事转为可核对的问题和贡献

[引言问题句式帖](https://www.xiaohongshu.com/explore/6ac757fa0000000015002b34) 和 [投稿反思](https://www.xiaohongshu.com/explore/6a58fc7f000000001101299b) 的共同价值是把问题后果、研究目标和结论联系起来。评论对套路化制造问题提出质疑。系统因此要求缺口有已核验工作支持，贡献落到实际结果，禁止凭句型生成“首次”或“无人研究”。

### 从总分涨跌转为问题、设置、观测和解释

[bad idea 与未调好模型](https://www.xiaohongshu.com/explore/6a83d7e3000000002c005508)、[从异常积累 idea](https://www.xiaohongshu.com/explore/6ab0d325000000003303cf07) 及 [结果是否必须涨点](https://www.zhihu.com/question/1949767673585054728/answer/2096305852961636737) 提供了拆指标、看失败和检验中间信号的思路。转入写作系统后，要求保留探索性质、比较条件与负结果；建议实验放在说明中，不写成已完成。另用 [Karpathy 原文](https://karpathy.github.io/2019/04/25/recipe/) 与 [Tuning Playbook](https://github.com/google-research/tuning_playbook) 对照诊断与调参的边界，没有将训练诊断等同于泛化证明。

### 从“顶刊感”转为图表能否支撑具体主张

小红书绘图推广里的字体、变量表、坐标与图例检查可以提取，但“顶刊级”外观和私信领取 Skill 不作为质量证据。图注 Skill 加入样本单位、误差定义、对象与数值配对及实际可见范围。使用 [NeurIPS 原始 Checklist](https://neurips.cc/public/guides/PaperChecklist) 对照主张范围、设置与误差信息；该指导只在适用语境下使用，不把会场规则复制为所有论文的硬要求。

### 明确拒绝的热门建议

不导入固定基线/文献数量、随意替换模块后包装新颖性、多数指标上涨即足够、事后找子集掩盖负结果、凭措辞猜测审稿人身份、按学者人脉删引，以及唯一提示词或录用效果承诺。广告和个人经历可以启发需求，不能成为普遍效果证明。

## Codex 实测与迭代

执行器为 [social-writing-skills-eval.ts](../scripts/social-writing-skills-eval.ts)，直接调用已认证的本地 Codex CLI。每个 Skill 使用两条中英文、针对当前写作阶段的合成案例；未将收藏原文、私密账户数据送入测试。测试会话禁止工具、网络、文件改动与子代理，并检查事件记录。

共 16 次真实模型调用：第一轮 6 个基线 + 6 个 Skill；第二轮图注与全文复核各重跑基线/Skill。最终选用的六份 Skill 输出，12 个案例的 **132/132 个有界检查通过**，工具调用为零。结果与当前 Skill 文本、对应案例哈希逐项核对，见 [最终汇总](../evaluation/social-research-skills/codex-summary.json)。

人工复读发现了自动门槛漏掉的问题：第一轮图注答案把未明确配对的两个值直接分配给 A、B。将图注 Skill 升至 v1.0.1，明确禁止按出现顺序配值，增加更明确的未知配对反例，再用 Codex 重跑；最终稿保留了配对未知，也没有给方法排名。

另修正两类检查器误判：统一长度下限拒绝了一条符合“最小修订”要求的短句；关键词检查漏掉了正确表达的聚合层级和配对未知。原始报告全部保留。图注第二轮只因关键词误判重检时，执行器核对模型可见输入与 Skill 哈希未变，不计为模型调用。不是修改答案以通过检查。

这些结果属于合成验收，不能证明提高真实投稿质量或优于通用基线。基线多数也通过；没有据此做效果排名。自动门槛之外仍需作者审阅科学判断，真实稿件、其他学科和长期使用表现尚待后续样本验证。

复现：

```bash
bun run skills:eval:social --phase=adapted --output=/tmp/fastwrite-social-retest.json
bun run test
bun run typecheck
bun run --filter '@fastwrite/web' build
bun run --filter '@fastwrite/server' build
bun run e2e:skills
```

最终检查记录：426 个单元/集成测试通过；全工作区类型检查、前后端构建通过；端到端检查覆盖 13 个新增写作 Skill 的界面选择及真实应用规划/生成输入，并覆盖阶段快捷选择、持久化、项目隔离和五项上限。端到端模型提供者为确定性 fixture，不把该检查声称为真实模型生成；真实模型验收由前述 Codex 执行器完成。截图位于 `output/skills/writing-stages.png`。

## 文件与后续边界

- [reviews.json](../evaluation/social-research-skills/reviews.json)：公共原文链接、访问范围、自写方法摘要和拒绝项。
- [rules.json](../evaluation/social-research-skills/rules.json)：12 条规则到来源、Skill 和案例的映射。
- [integrations.json](../evaluation/social-research-skills/integrations.json)：集成版本及来源索引；每个 Skill 也有 `provenance.json`。
- [sources.json](../evaluation/social-research-skills/sources.json)：公开发现索引，明确区分打开正文、索引摘录与访问阻止。

只保存所选公共来源及自写方法归纳，未导出个人主页链接、登录令牌、无关收藏、私信或原文全文；未向社交账户发消息或领取私信资料。帖子与评论可变，本轮仅记录访问日期，不声称来源已永久锁定。未访问的旧收藏和其他收藏夹仍是后续待筛选范围，优先扩展其他学科的反例及真实稿件验收。
