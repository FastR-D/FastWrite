import type { PublicationTarget, ResearchDomainId } from "@fastwrite/shared";

const VENUE_ABBREVIATIONS: Readonly<Record<string, string>> = {
  "acm-mm": "ACM MM", "artificial-intelligence": "AIJ", "ase-conference": "ASE", "eurocrypt": "EUROCRYPT", "journal-of-cryptology": "JoC", "proceedings-of-the-ieee": "Proc. IEEE", "usenix-atc": "USENIX ATC", "usenix-security": "USENIX Security", "ubicomp-imwut": "IMWUT", "ieee-vis": "IEEE VIS", "network-information-security": "SEC", "computer-architecture-systems": "ARCH", "computer-networks": "NET", "software-engineering-systems-languages": "SE/PL", "database-data-mining-retrieval": "DB/DM", "theoretical-computer-science": "TCS", "graphics-multimedia": "GFX", "human-computer-interaction": "HCI", "interdisciplinary-emerging": "XDISC",
  aaai: "AAAI", acl: "ACL", asplos: "ASPLOS", cav: "CAV", ccs: "CCS", chi: "CHI", crypto: "CRYPTO", cvpr: "CVPR", dac: "DAC", eccv: "ECCV", focs: "FOCS", fse: "FSE", hpca: "HPCA", iccv: "ICCV", icde: "ICDE", iclr: "ICLR", icml: "ICML", icse: "ICSE", ijcai: "IJCAI", isca: "ISCA", issta: "ISSTA", jacm: "JACM", jmlr: "JMLR", kdd: "KDD", lics: "LICS", neurips: "NeurIPS", ndss: "NDSS", nsdi: "NSDI", oopsla: "OOPSLA", osdi: "OSDI", pldi: "PLDI", popl: "POPL", sigcomm: "SIGCOMM", siggraph: "SIGGRAPH", sigir: "SIGIR", sigmod: "SIGMOD", sosp: "SOSP", sp: "S&P", stoc: "STOC", tpami: "T-PAMI", tse: "TSE", uist: "UIST", vldb: "VLDB", www: "WWW"
};

export function venueAbbreviation(venueId: string): string {
  return VENUE_ABBREVIATIONS[venueId] ?? venueId.replace(/-/g, " ").toUpperCase();
}

export function domainAbbreviation(domain: ResearchDomainId): string {
  return VENUE_ABBREVIATIONS[domain] ?? domain.toUpperCase();
}

export function publicationTargetAbbreviation(target: PublicationTarget | undefined, fallback: ResearchDomainId): string {
  return target ? venueAbbreviation(target.venueId) : domainAbbreviation(fallback);
}

export function venueOptionLabel(venue: { value: string; label: string }): string {
  return `${venueAbbreviation(venue.value)} — ${venue.label}`;
}

// Fixed display labels for API values. Stored values and protocol IDs stay intact.
const STATUS_LABELS: Readonly<Record<string, string>> = {
  idle: "待开始", ready: "就绪", preparing: "准备中", queued: "排队中", running: "运行中", pending: "待处理",
  planned: "已规划", proposed: "待审核", "waiting-approval": "待批准", "partially-accepted": "部分已接受",
  completed: "已完成", complete: "已完成", success: "成功", succeeded: "已完成", passed: "已通过", failed: "失败", error: "错误",
  cancelled: "已取消", skipped: "已跳过", unavailable: "不可用", missing: "缺失", degraded: "服务异常",
  active: "有效", disabled: "已停用", inactive: "未启用", revoked: "已撤销", expired: "已过期",
  accepted: "已接受", rejected: "已拒绝", approved: "已批准", denied: "已拒绝", confirmed: "已确认",
  candidate: "候选", saved: "已保存", imported: "已导入", invalid: "无效", stale: "已过期",
  open: "待处理", resolved: "已解决", dismissed: "已忽略", needs_review: "待审核", "needs-review": "待审核",
  reopened: "已重新打开", in_revision: "修改中", supported: "已获支持", partial: "部分支持", unsupported: "缺少支持",
  current: "当前", reanchored: "已重新定位", orphaned: "锚点缺失", "missing-source": "源文件缺失",
  cited: "已引用", "not-cited": "未引用", "missing-citation": "缺少引用", "missing-citations": "缺少引用",
  verified: "已核实", conflicting: "存在冲突", unresolved: "未解决", unknown: "未知",
  supports: "支持", contradicts: "反驳", mentions: "提及", uncertain: "待确定", included: "已纳入", excluded: "已排除",
  uploading: "上传中", parsing: "解析中", "needs-input": "需要补充信息", refreshing: "刷新中",
  low: "低", medium: "中", high: "高", critical: "极高", read: "只读", comment: "可评论",
  blocking: "阻塞", major: "严重", minor: "轻微", suggestion: "建议", info: "信息", warning: "警告",
  published: "已发表", retracted: "已撤稿", corrected: "已更正", "preprint": "预印本",
  draft: "起草", continue: "续写", revise: "修改", review: "审稿", completion: "补全", memory: "论文记忆",
  create: "创建", replace: "替换", delete: "删除", edit: "编辑", invite: "邀请", approve: "批准", compile: "编译",
  section: "章节", page: "页码", paragraph: "段落", abstract: "摘要", background: "背景", contribution: "贡献",
  method: "方法", result: "结果", comparison: "比较", limitation: "局限性", quote: "摘录",
  "source-text": "来源原文", "registry-abstract": "文献库摘要", "model-extraction": "模型提取", user: "用户",
  verbatim: "原文摘录", paraphrase: "转述", fact: "事实", terminology: "术语", decision: "决定", constraint: "约束",
  "run_ai": "运行 AI", "run_compile": "运行编译", "manage": "管理", allow: "允许", deny: "拒绝",
  project_role: "项目角色", team_role: "团队角色", idp_group: "身份服务用户组",
  system: "系统", team: "团队", project: "项目", reference: "参考资料", manuscript: "稿件", host: "本机",
  "strong-accept": "强烈建议接收", accept: "建议接收", "weak-accept": "倾向接收", borderline: "需要讨论",
  "weak-reject": "倾向拒稿", reject: "建议拒稿", "strong-reject": "强烈建议拒稿", "major-revision": "需要大修", "minor-revision": "需要小修",
  novelty: "创新性", soundness: "可靠性", "technical-depth": "技术深度", "threat-model": "威胁模型",
  evaluation: "评估", reproducibility: "可复现性", "related-work": "相关工作", clarity: "清晰度", ethics: "伦理",
  "plan-created": "已创建计划", "skill-loaded": "已加载技能", "execution-started": "开始执行", "generation-progress": "生成进度", "changes-proposed": "已提出更改", "hunk-accepted": "修改块已接受", "hunk-rejected": "修改块已拒绝",
  mechanical: "源文件检查", evidence: "证据检查", argument: "论证检查", domain: "领域审查", venue: "投稿规则", adversarial: "反例检查", synthesis: "综合审稿",
  "writing-guard": "写作规则检查", "evidence-check": "证据校验", "argument-check": "论证校验", "review-agent": "智能审稿", "claim-adversary": "论断反例检查", "review-synthesis": "审稿汇总",
  "rolled-back": "已回滚", "compile_failed": "编译失败", "needs-human": "需要人工处理", "pending-check": "待检查", "not-applicable": "不适用",
  overview: "概述", instructions: "指令", methodology: "方法", findings: "发现", limitations: "局限性",
  connected: "已连接", connecting: "连接中", disconnected: "未连接", local: "本地", online: "在线", offline: "离线"
};
export function statusLabel(value: string | null | undefined): string { return value ? STATUS_LABELS[value] ?? value : "未记录"; }

const ROLE_LABELS: Readonly<Record<string, string>> = {
  user: "用户", support_auditor: "支持审计员", platform_admin: "平台管理员",
  owner: "所有者", maintainer: "维护者", editor: "编辑者", commenter: "评论者", viewer: "查看者", member: "成员", admin: "管理员"
};
export function roleLabel(value: string): string { return ROLE_LABELS[value] ?? value; }

export function modelProviderLabel(value: string): string {
  return value === "openai-compatible" ? "OpenAI 兼容服务" : value === "codex" ? "Codex" : value === "claude" ? "Claude" : value;
}
