import { statusLabel } from "../../lib/labels";
import { useEffect, useMemo, useState } from "react";
import { isIgnoredWorkspacePath, WRITING_PROFILES, type AgentWireApi, type PaperProject, type ProjectAclAction, type PublicationTarget, type PublishedSkillDescriptor, type WritingProfile, type WorkspaceTreeNode } from "@fastwrite/shared";
import { api, downloadFile } from "../../api/client";
import { Button, Field, Icon, icons, Select, TextField, Link } from "../ui";
import { PublicationTargetFields } from "../ui/PublicationTargetFields";
import { harnessSettingsSaveDecision, type HarnessSettingsBaseline, type HarnessSettingsDraft } from "./harnessSettings";
import styles from "./ProjectSettingsEditor.module.css";
import { responseLanguage, setResponseLanguage, type ResponseLanguage } from "../../lib/responseLanguage";

interface ProjectSettingsEditorProps {
  project: PaperProject;
  tree: WorkspaceTreeNode[];
  onSaved: (project: PaperProject) => void | Promise<void>;
}
interface RememberedHarnessSettings { baseURL?: string; model?: string; wireAPI?: AgentWireApi }
type AclRule = { id: string; pathPrefix: string; subjectType: "user" | "project_role" | "team_role" | "idp_group"; subjectId: string; action: ProjectAclAction; effect: "allow" | "deny" };
const ACL_ACTIONS: ProjectAclAction[] = ["read", "comment", "edit", "manage", "run_ai", "manage_harness", "export", "sync_github"];

export function ProjectSettingsEditor({ project, tree, onSaved }: ProjectSettingsEditorProps) {
  const [category, setCategory] = useState("general");
  const [query, setQuery] = useState("");
  const [saved, setSaved] = useState(false);
  const harnessDraftKey = "fastwrite.harness-settings";
  const [name, setName] = useState(project.name);
  const [mainDocument, setMainDocument] = useState(project.mainDocument);
  const [profile, setProfile] = useState<WritingProfile>(project.skill.venue);
  const [publicationTarget, setPublicationTarget] = useState<PublicationTarget | undefined>(project.publicationTarget);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [agentConfigured, setAgentConfigured] = useState<boolean | null>(null);
  const [agentSource, setAgentSource] = useState<"runtime" | "environment" | "none">("none");
  const [apiKey, setApiKey] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [model, setModel] = useState("");
  const [wireAPI, setWireAPI] = useState<AgentWireApi>("chat");
  const [language, setLanguage] = useState<ResponseLanguage>(() => responseLanguage());
  const [agentBaseline, setAgentBaseline] = useState<HarnessSettingsBaseline>({ configured: null, baseURL: "", model: "", wireAPI: "chat" });
  const [savingAgent, setSavingAgent] = useState(false);
  const [agentError, setAgentError] = useState("");
  const [publishedSkills, setPublishedSkills] = useState<PublishedSkillDescriptor[]>([]);
  const [aclRules, setAclRules] = useState<AclRule[]>([]);
  const [aclAvailable, setAclAvailable] = useState<boolean | null>(null);
  const [aclDraft, setAclDraft] = useState<Omit<AclRule, "id">>({ pathPrefix: "", subjectType: "project_role", subjectId: "editor", action: "read", effect: "deny" });
  const [aclBusy, setAclBusy] = useState(false);
  const [aclError, setAclError] = useState("");
  useEffect(() => { void api.agentSkills.releases().then(setPublishedSkills).catch(() => setPublishedSkills([])); }, []);
  const texFiles = useMemo(() => [...new Set([project.mainDocument, ...flattenFiles(tree)])].filter((path) => path.toLowerCase().endsWith(".tex") && !isIgnoredWorkspacePath(path)), [tree, project.mainDocument]);

  useEffect(() => {
    setSaved(false);
  }, [name, mainDocument, profile, publicationTarget, language, apiKey, baseURL, model, wireAPI]);

  useEffect(() => {
    setAgentConfigured(null);
    setAgentSource("none");
    setApiKey("");
    let cancelled = false;
    let remembered: RememberedHarnessSettings | null = null;
    try { remembered = JSON.parse(localStorage.getItem(harnessDraftKey) ?? "null") as RememberedHarnessSettings; } catch { localStorage.removeItem(harnessDraftKey); }
    setBaseURL(remembered?.baseURL ?? "");
    setModel(remembered?.model ?? "");
    setWireAPI(remembered?.wireAPI === "responses" ? "responses" : "chat");
    setLanguage(responseLanguage());
    setAgentBaseline({ configured: null, baseURL: "", model: "", wireAPI: "chat" });
    setAgentError("");
    setAclRules([]); setAclAvailable(null); setAclError("");
    void api.agentSettings.get().then((settings) => {
      if (cancelled) return;
      setAgentConfigured(settings.configured);
      setAgentSource(settings.source);
      setBaseURL(settings.baseURL ?? "");
      setModel(settings.model ?? "");
      setWireAPI(settings.wireAPI);
      setAgentBaseline({ configured: settings.configured, baseURL: settings.baseURL ?? "", model: settings.model ?? "", wireAPI: settings.wireAPI });
    }).catch(() => { if (cancelled) return; setAgentConfigured(false); setAgentBaseline({ configured: false, baseURL: "", model: "", wireAPI: "chat" }); });
    void api.projects.acl(project.id).then((rules) => { if (!cancelled) { setAclRules(rules); setAclAvailable(true); } }).catch(() => { if (!cancelled) setAclAvailable(false); });
    return () => { cancelled = true; };
  }, [project.id]);

  const resolvedAgentDraft = (): { ok: true; draft: HarnessSettingsDraft } | { ok: false; message: string } => {
    const draft: HarnessSettingsDraft = { apiKey, baseURL, model, wireAPI };
    return { ok: true, draft };
  };


  const save = async () => {
    setSaved(false);
    setError("");
    setAgentError("");
    const resolved = resolvedAgentDraft();
    if (!resolved.ok) { setAgentError(resolved.message); return; }
    const agentDecision = harnessSettingsSaveDecision(resolved.draft, agentBaseline);
    if (agentDecision.kind === "invalid") { setCategory("ai"); setQuery(""); setAgentError(agentDecision.message); return; }
    setLoading(true);
    setResponseLanguage(language);
    try {
      if (agentDecision.kind === "save") await persistAgentSettings(agentDecision.body);
      const updated = await api.projects.update(project.id, { name: name.trim(), mainDocument, venue: profile, publicationTarget: publicationTarget ?? null });
      await onSaved(updated);
      setSaved(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "无法更新项目");
    } finally {
      setLoading(false);
    }
  };

  const saveAgentSettings = async () => {
    setAgentError("");
    const resolved = resolvedAgentDraft();
    if (!resolved.ok) { setAgentError(resolved.message); return; }
    const decision = harnessSettingsSaveDecision(resolved.draft, agentBaseline);
    if (decision.kind === "invalid") { setAgentError(decision.message); return; }
    if (decision.kind === "unchanged") return;
    setSavingAgent(true);
    try {
      await persistAgentSettings(decision.body);
    } catch (saveError) {
      setAgentError(saveError instanceof Error ? saveError.message : "无法保存智能助手设置");
    } finally {
      setSavingAgent(false);
    }
  };

  const persistAgentSettings = async (body: { apiKey: string; baseURL?: string; model?: string; wireAPI: AgentWireApi }) => {
    const settings = await api.agentSettings.save(body);
    const nextBaseURL = settings.baseURL ?? "";
    const nextModel = settings.model ?? "";
    setAgentConfigured(settings.configured);
    setAgentSource(settings.source);
    setApiKey("");
    setBaseURL(nextBaseURL);
    setModel(nextModel);
    setWireAPI(settings.wireAPI);
    localStorage.setItem(harnessDraftKey, JSON.stringify({ baseURL: nextBaseURL, model: nextModel, wireAPI: settings.wireAPI }));
    setAgentBaseline({ configured: settings.configured, baseURL: nextBaseURL, model: nextModel, wireAPI: settings.wireAPI });
  };

  const saveAcl = async () => {
    setAclError("");
    setAclBusy(true);
    try { await api.projects.saveAcl(project.id, "new", aclDraft); setAclRules(await api.projects.acl(project.id)); setAclDraft((current) => ({ ...current, pathPrefix: "" })); }
    catch (failure) { setAclError(failure instanceof Error ? failure.message : "无法保存路径规则"); }
    finally { setAclBusy(false); }
  };
  const removeAcl = async (ruleId: string) => {
    setAclError(""); setAclBusy(true);
    try { await api.projects.deleteAcl(project.id, ruleId); setAclRules((rules) => rules.filter((rule) => rule.id !== ruleId)); }
    catch (failure) { setAclError(failure instanceof Error ? failure.message : "无法移除路径规则"); }
    finally { setAclBusy(false); }
  };

  const categories = [
    { id: "general", label: "常规", keywords: "项目 名称 主文档 入口 文件" },
    { id: "writing", label: "写作", keywords: "研究 领域 投稿 目标 会议 期刊 模板 年份 稿件 阶段 论文 类别" },
    { id: "ai", label: "AI 与模型配置", keywords: "回复 语言 API 密钥 服务 地址 模型 接口 智能 助手" },
    ...(aclAvailable ? [{ id: "access", label: "访问权限", keywords: "权限 路径 规则 主体 角色 用户 团队 用户组 操作 效果 允许 拒绝" }] : []),
    { id: "backup", label: "历史与导出", keywords: "自动 Git 历史 检查点 工作区 快照 下载 归档 备份" }
  ];
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = categories.filter(item => terms.every(term => `${item.label} ${item.keywords}`.toLowerCase().includes(term)));
  const visible = (id: string) => terms.length ? matches.some(item => item.id === id) : category === id;

  return (
    <div className={styles.editor}>
      <header className={styles.header}>
        <div className={styles.title}><h1>设置</h1><span>{project.name}</span></div>
        <TextField type="search" aria-label="搜索设置" placeholder="搜索设置" value={query} onChange={setQuery} autoFocus />
        <div className={styles.scope}><span>工作区</span><small>此项目的设置</small></div>
      </header>
      <div className={styles.body}>
        <nav className={styles.navigation} aria-label="设置类别">
          {categories.map(item => <Button key={item.id} variant="ghost" aria-current={!terms.length && category === item.id ? "page" : undefined} onClick={() => { setCategory(item.id); setQuery(""); }}>{item.label}</Button>)}
        </nav>
        <div className={styles.content}>
          {terms.length && !matches.length ? <div className={styles.empty}><h2>未找到设置项</h2><p>请更换搜索词或选择其他类别。</p></div> : null}
          <section className={styles.section} hidden={!visible("general")} aria-labelledby="general-settings-title">
            <h2 id="general-settings-title">常规</h2>
            <p className={styles.description}>为工作区命名，并选择编译论文所用的源文件。</p>
        <Field label="项目名称">
          <TextField value={name} onChange={setName} />
        </Field>
        <Field label="主文档">
          <Select aria-label="主文档" value={mainDocument} onChange={setMainDocument} options={texFiles.map((path) => ({ value: path, label: path }))} placeholder="选择文档" />
        </Field>
          </section>
          <section className={styles.section} hidden={!visible("skills")} aria-labelledby="skills-settings-title">
            <h2 id="skills-settings-title">技能管理</h2>
            <p className={styles.description}>已发布技能受清单、许可证、能力、风险及审核记录约束。</p>
            <div className="settings-export">{publishedSkills.length ? publishedSkills.map((skill) => <div key={skill.id}><strong>{skill.id} · v{skill.version}</strong><span>{skill.license} · {statusLabel(skill.scope)} · {statusLabel(skill.riskLevel)} 风险 · {skill.requiresReview ? "需要审核" : "可选审核"}</span></div>) : <span>暂无已发布的技能清单。</span>}</div>
          </section>
          <section className={styles.section} hidden={!visible("writing")} aria-labelledby="writing-settings-title">
            <h2 id="writing-settings-title">写作</h2>
            <p className={styles.description}>选择写作和审稿所用的研究领域与投稿规则。</p>
        <Field label="研究领域">
          <Select aria-label="研究领域" value={profile} onChange={(next) => { const value = next as WritingProfile; setProfile(value); if (publicationTarget?.domain !== value) setPublicationTarget(undefined); }} options={WRITING_PROFILES.map((item) => ({ value: item.value, label: item.label }))} />
        </Field>
        <PublicationTargetFields profile={profile} value={publicationTarget} onChange={setPublicationTarget} />
          </section>
          <section className={styles.section} hidden={!visible("ai")} aria-labelledby="ai-settings-title">
            <h2 id="ai-settings-title">AI 与模型配置</h2>
            <p className={styles.description}>设置智能助手工作流的回复语言和模型连接。</p>
        <Field label="AI 回复语言">
          <Select aria-label="AI 回复语言" value={language} onChange={(next) => setLanguage(next as ResponseLanguage)} options={[{ value: "auto", label: "跟随用户" }, { value: "zh-CN", label: "中文" }, { value: "en-US", label: "英语" }]} />
        </Field>
        <section className="settings-agent" aria-labelledby="agent-settings-title">
          <div><strong id="agent-settings-title">模型连接</strong><span>{agentConfigured ? `配置来自 ${agentSource === "environment" ? "服务端环境" : "当前运行的服务端"}.` : "配置模型后即可启用智能助手工作流。"}</span></div>
          <Field label="API 密钥">
            <TextField type="password" value={apiKey} onChange={setApiKey} placeholder={agentConfigured ? "输入新的密钥" : "sk-…"} autoComplete="off" />
          </Field>
          <Field label="服务地址" hint="可选">
            <TextField type="url" value={baseURL} onChange={setBaseURL} placeholder="https://api.openai.com/v1" autoComplete="off" />
          </Field>
          <Field label="模型" hint="可选">
            <TextField value={model} onChange={setModel} placeholder="使用服务默认值" autoComplete="off" />
          </Field>
          <Field label="接口协议">
            <Select aria-label="接口协议" value={wireAPI} onChange={(next) => setWireAPI(next as AgentWireApi)} options={[{ value: "chat", label: "Chat Completions 接口" }, { value: "responses", label: "Responses 接口" }]} />
          </Field>
          <div className="settings-agent__actions"><Button size="small" variant="secondary" loading={savingAgent} disabled={!apiKey.trim() || loading} onClick={() => void saveAgentSettings()}>{agentConfigured ? "更换 API 密钥" : "启用智能助手"}</Button><small>密钥不会返回给客户端或写入项目文件，服务端重启后会清除。</small></div>
          {agentError ? <div className="form-error" role="alert">{agentError}</div> : null}
        </section>
          </section>
        {aclAvailable ? <section className={`${styles.section} settings-agent`} hidden={!visible("access")} aria-labelledby="acl-settings-title">
          <div><h2 id="acl-settings-title">路径访问规则</h2><span>拒绝规则优先。禁止读取某路径时，也会禁止该路径的编辑和协作。</span></div>
          <Field label="文件或目录前缀">
            <TextField value={aclDraft.pathPrefix} onChange={(next) => setAclDraft((current) => ({ ...current, pathPrefix: next }))} placeholder="restricted 或 restricted/results.tex" />
          </Field>
          <Field label="主体">
            <Select aria-label="主体" value={aclDraft.subjectType} onChange={(next) => { const subjectType = next as AclRule["subjectType"]; setAclDraft((current) => ({ ...current, subjectType, subjectId: subjectType === "project_role" ? "editor" : subjectType === "team_role" ? "member" : "" })); }} options={[{ value: "project_role", label: "项目角色" }, { value: "team_role", label: "团队角色" }, { value: "idp_group", label: "身份服务用户组" }, { value: "user", label: "用户 ID" }]} />
          </Field>
          {aclDraft.subjectType === "project_role" ? <Field label="项目角色"><Select aria-label="项目角色" value={aclDraft.subjectId} onChange={(next) => setAclDraft((current) => ({ ...current, subjectId: next }))} options={[{ value: "viewer", label: "查看者" }, { value: "commenter", label: "评论者" }, { value: "editor", label: "编辑者" }, { value: "maintainer", label: "维护者" }, { value: "owner", label: "所有者" }]} /></Field> : aclDraft.subjectType === "team_role" ? <Field label="团队角色"><Select aria-label="团队角色" value={aclDraft.subjectId} onChange={(next) => setAclDraft((current) => ({ ...current, subjectId: next }))} options={[{ value: "member", label: "成员" }, { value: "admin", label: "管理员" }, { value: "owner", label: "所有者" }]} /></Field> : aclDraft.subjectType === "idp_group" ? <Field label="身份服务用户组"><TextField value={aclDraft.subjectId} onChange={(next) => setAclDraft((current) => ({ ...current, subjectId: next }))} placeholder="https://idp.example:researchers" /></Field> : <Field label="用户 ID"><TextField value={aclDraft.subjectId} onChange={(next) => setAclDraft((current) => ({ ...current, subjectId: next }))} placeholder="user_…" /></Field>}
          <Field label="操作">
            <Select aria-label="操作" value={aclDraft.action} onChange={(next) => setAclDraft((current) => ({ ...current, action: next as ProjectAclAction }))} options={ACL_ACTIONS.map((action) => ({ value: action, label: statusLabel(action) }))} />
          </Field>
          <Field label="效果">
            <Select aria-label="效果" value={aclDraft.effect} onChange={(next) => setAclDraft((current) => ({ ...current, effect: next as AclRule["effect"] }))} options={[{ value: "deny", label: "拒绝" }, { value: "allow", label: "允许" }]} />
          </Field>
          <div className="settings-agent__actions"><Button size="small" variant="secondary" loading={aclBusy} disabled={!aclDraft.subjectId.trim()} onClick={() => void saveAcl()}>添加规则</Button></div>
          {aclRules.map((rule) => <div className="settings-export" key={rule.id}><div><strong>{statusLabel(rule.effect)} {statusLabel(rule.action)}: {rule.pathPrefix || "/"}</strong><span>{statusLabel(rule.subjectType)}: {rule.subjectId}</span></div><Button size="small" variant="ghost" disabled={aclBusy} onClick={() => void removeAcl(rule.id)}>移除</Button></div>)}
          {aclError ? <div className="form-error" role="alert">{aclError}</div> : null}
        </section> : null}
          <section className={styles.section} hidden={!visible("backup")} aria-labelledby="backup-settings-title">
            <h2 id="backup-settings-title">历史与导出</h2>
            <p className={styles.description}>保存工作历史，并下载可迁移的副本。</p>
        <div className="settings-export"><div><strong>自动记录 Git 历史</strong><span>成功保存后，将在 FastWrite 项目历史中创建本地 Git 检查点。</span></div></div>
        <div className="settings-export"><div><strong>工作区快照</strong><span>将全部源文件下载为可迁移的 tar.gz 压缩包。</span></div><Button loading={exporting} onClick={() => { setExporting(true); setError(""); void downloadFile(api.projects.exportUrl(project.id), `fastwrite-${project.id}.tar.gz`).catch(failure => setError(failure instanceof Error ? failure.message : "无法导出工作区")).finally(() => setExporting(false)); }}><Icon name={icons.cloudDownload} />导出</Button></div>
          </section>
        </div>
      </div>
      <footer className={styles.footer}>
        <div role="status">{error ? <span className="form-error" role="alert">{error}</span> : saved ? "设置已保存" : "保存后应用更改。"}</div>
        <Button variant="primary" data-save-command icon={<Icon name={icons.save} />} loading={loading} disabled={!name.trim() || !mainDocument || savingAgent} onClick={() => void save()}>保存更改</Button>
      </footer>
    </div>
  );
}

function flattenFiles(nodes: WorkspaceTreeNode[]): string[] {
  return nodes.flatMap((node) => node.type === "file" ? [node.path] : flattenFiles(node.children));
}
