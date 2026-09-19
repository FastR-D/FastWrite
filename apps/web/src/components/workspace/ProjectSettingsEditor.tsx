import { useEffect, useMemo, useState } from "react";
import { isIgnoredWorkspacePath, WRITING_PROFILES, type AgentWireApi, type PaperProject, type ProjectAclAction, type PublicationTarget, type WritingProfile, type WorkspaceTreeNode } from "@fastwrite/shared";
import { api } from "../../api/client";
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
  const [aclRules, setAclRules] = useState<AclRule[]>([]);
  const [aclAvailable, setAclAvailable] = useState<boolean | null>(null);
  const [aclDraft, setAclDraft] = useState<Omit<AclRule, "id">>({ pathPrefix: "", subjectType: "project_role", subjectId: "editor", action: "read", effect: "deny" });
  const [aclBusy, setAclBusy] = useState(false);
  const [aclError, setAclError] = useState("");
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
      setError(saveError instanceof Error ? saveError.message : "Could not update project");
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
      setAgentError(saveError instanceof Error ? saveError.message : "Could not save Agent settings");
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
    catch (failure) { setAclError(failure instanceof Error ? failure.message : "Could not save path rule"); }
    finally { setAclBusy(false); }
  };
  const removeAcl = async (ruleId: string) => {
    setAclError(""); setAclBusy(true);
    try { await api.projects.deleteAcl(project.id, ruleId); setAclRules((rules) => rules.filter((rule) => rule.id !== ruleId)); }
    catch (failure) { setAclError(failure instanceof Error ? failure.message : "Could not remove path rule"); }
    finally { setAclBusy(false); }
  };

  const categories = [
    { id: "general", label: "General", keywords: "project name main document entry file" },
    { id: "writing", label: "Writing", keywords: "research domain publication target conference journal template year manuscript stage paper track" },
    { id: "ai", label: "AI & Harness", keywords: "response language api key base url model wire chat completions responses agent" },
    ...(aclAvailable ? [{ id: "access", label: "Access", keywords: "permissions path rules subject role user team group action effect allow deny" }] : []),
    { id: "backup", label: "History & Export", keywords: "automatic git history checkpoint workspace snapshot download archive backup" }
  ];
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = categories.filter(item => terms.every(term => `${item.label} ${item.keywords}`.toLowerCase().includes(term)));
  const visible = (id: string) => terms.length ? matches.some(item => item.id === id) : category === id;

  return (
    <div className={styles.editor}>
      <header className={styles.header}>
        <div className={styles.title}><h1>Settings</h1><span>{project.name}</span></div>
        <TextField type="search" aria-label="Search settings" placeholder="Search settings" value={query} onChange={setQuery} autoFocus />
        <div className={styles.scope}><span>Workspace</span><small>Settings for this project</small></div>
      </header>
      <div className={styles.body}>
        <nav className={styles.navigation} aria-label="Settings categories">
          {categories.map(item => <Button key={item.id} variant="ghost" aria-current={!terms.length && category === item.id ? "page" : undefined} onClick={() => { setCategory(item.id); setQuery(""); }}>{item.label}</Button>)}
        </nav>
        <div className={styles.content}>
          {terms.length && !matches.length ? <div className={styles.empty}><h2>No settings found</h2><p>Try a different search or choose a category.</p></div> : null}
          <section className={styles.section} hidden={!visible("general")} aria-labelledby="general-settings-title">
            <h2 id="general-settings-title">General</h2>
            <p className={styles.description}>Name your workspace and choose the source file used to compile your paper.</p>
        <Field label="Project name">
          <TextField value={name} onChange={setName} />
        </Field>
        <Field label="Main document">
          <Select aria-label="Main document" value={mainDocument} onChange={setMainDocument} options={texFiles.map((path) => ({ value: path, label: path }))} placeholder="Choose a document" />
        </Field>
          </section>
          <section className={styles.section} hidden={!visible("writing")} aria-labelledby="writing-settings-title">
            <h2 id="writing-settings-title">Writing</h2>
            <p className={styles.description}>Choose the research domain and publication guidance used when writing and reviewing.</p>
        <Field label="Research domain">
          <Select aria-label="Research domain" value={profile} onChange={(next) => { const value = next as WritingProfile; setProfile(value); if (publicationTarget?.domain !== value) setPublicationTarget(undefined); }} options={WRITING_PROFILES.map((item) => ({ value: item.value, label: item.label }))} />
        </Field>
        <PublicationTargetFields profile={profile} value={publicationTarget} onChange={setPublicationTarget} />
          </section>
          <section className={styles.section} hidden={!visible("ai")} aria-labelledby="ai-settings-title">
            <h2 id="ai-settings-title">AI & Harness</h2>
            <p className={styles.description}>Set the response language and model connection for Agent workflows.</p>
        <Field label="AI response language">
          <Select aria-label="AI response language" value={language} onChange={(next) => setLanguage(next as ResponseLanguage)} options={[{ value: "auto", label: "Follow user" }, { value: "zh-CN", label: "中文" }, { value: "en-US", label: "English" }]} />
        </Field>
        <section className="settings-agent" aria-labelledby="agent-settings-title">
          <div><strong id="agent-settings-title">Harness</strong><span>{agentConfigured ? `Configured from ${agentSource === "environment" ? "server environment" : "this running server"}.` : "Configure a Harness model to enable Agent workflows."}</span></div>
          <Field label="API key">
            <TextField type="password" value={apiKey} onChange={setApiKey} placeholder={agentConfigured ? "Enter a replacement key" : "sk-…"} autoComplete="off" />
          </Field>
          <Field label="Base URL" hint="optional">
            <TextField type="url" value={baseURL} onChange={setBaseURL} placeholder="https://api.openai.com/v1" autoComplete="off" />
          </Field>
          <Field label="Model" hint="optional">
            <TextField value={model} onChange={setModel} placeholder="Use provider default" autoComplete="off" />
          </Field>
          <Field label="Wire API">
            <Select aria-label="Wire API" value={wireAPI} onChange={(next) => setWireAPI(next as AgentWireApi)} options={[{ value: "chat", label: "Chat Completions" }, { value: "responses", label: "Responses" }]} />
          </Field>
          <div className="settings-agent__actions"><Button size="small" variant="secondary" loading={savingAgent} disabled={!apiKey.trim() || loading} onClick={() => void saveAgentSettings()}>{agentConfigured ? "Replace API key" : "Enable Agent"}</Button><small>The key is never returned or written to project files; it is cleared when the server restarts.</small></div>
          {agentError ? <div className="form-error" role="alert">{agentError}</div> : null}
        </section>
          </section>
        {aclAvailable ? <section className={`${styles.section} settings-agent`} hidden={!visible("access")} aria-labelledby="acl-settings-title">
          <div><h2 id="acl-settings-title">Path access rules</h2><span>Deny rules take precedence. A read denial also blocks editing and collaboration for that path.</span></div>
          <Field label="File or directory prefix">
            <TextField value={aclDraft.pathPrefix} onChange={(next) => setAclDraft((current) => ({ ...current, pathPrefix: next }))} placeholder="restricted or restricted/results.tex" />
          </Field>
          <Field label="Subject">
            <Select aria-label="Subject" value={aclDraft.subjectType} onChange={(next) => { const subjectType = next as AclRule["subjectType"]; setAclDraft((current) => ({ ...current, subjectType, subjectId: subjectType === "project_role" ? "editor" : subjectType === "team_role" ? "member" : "" })); }} options={[{ value: "project_role", label: "Project role" }, { value: "team_role", label: "Team role" }, { value: "idp_group", label: "IdP group" }, { value: "user", label: "User ID" }]} />
          </Field>
          {aclDraft.subjectType === "project_role" ? <Field label="Project role"><Select aria-label="Project role" value={aclDraft.subjectId} onChange={(next) => setAclDraft((current) => ({ ...current, subjectId: next }))} options={[{ value: "viewer", label: "Viewer" }, { value: "commenter", label: "Commenter" }, { value: "editor", label: "Editor" }, { value: "maintainer", label: "Maintainer" }, { value: "owner", label: "Owner" }]} /></Field> : aclDraft.subjectType === "team_role" ? <Field label="Team role"><Select aria-label="Team role" value={aclDraft.subjectId} onChange={(next) => setAclDraft((current) => ({ ...current, subjectId: next }))} options={[{ value: "member", label: "Member" }, { value: "admin", label: "Admin" }, { value: "owner", label: "Owner" }]} /></Field> : aclDraft.subjectType === "idp_group" ? <Field label="IdP group"><TextField value={aclDraft.subjectId} onChange={(next) => setAclDraft((current) => ({ ...current, subjectId: next }))} placeholder="https://idp.example:researchers" /></Field> : <Field label="User ID"><TextField value={aclDraft.subjectId} onChange={(next) => setAclDraft((current) => ({ ...current, subjectId: next }))} placeholder="user_…" /></Field>}
          <Field label="Action">
            <Select aria-label="Action" value={aclDraft.action} onChange={(next) => setAclDraft((current) => ({ ...current, action: next as ProjectAclAction }))} options={ACL_ACTIONS.map((action) => ({ value: action, label: action }))} />
          </Field>
          <Field label="Effect">
            <Select aria-label="Effect" value={aclDraft.effect} onChange={(next) => setAclDraft((current) => ({ ...current, effect: next as AclRule["effect"] }))} options={[{ value: "deny", label: "Deny" }, { value: "allow", label: "Allow" }]} />
          </Field>
          <div className="settings-agent__actions"><Button size="small" variant="secondary" loading={aclBusy} disabled={!aclDraft.subjectId.trim()} onClick={() => void saveAcl()}>Add rule</Button></div>
          {aclRules.map((rule) => <div className="settings-export" key={rule.id}><div><strong>{rule.effect} {rule.action}: {rule.pathPrefix || "/"}</strong><span>{rule.subjectType.replace("_", " ")}: {rule.subjectId}</span></div><Button size="small" variant="ghost" disabled={aclBusy} onClick={() => void removeAcl(rule.id)}>Remove</Button></div>)}
          {aclError ? <div className="form-error" role="alert">{aclError}</div> : null}
        </section> : null}
          <section className={styles.section} hidden={!visible("backup")} aria-labelledby="backup-settings-title">
            <h2 id="backup-settings-title">History & Export</h2>
            <p className={styles.description}>Keep a local history of your work and download a portable copy.</p>
        <div className="settings-export"><div><strong>Automatic Git history</strong><span>Accepted saves create local Git checkpoints in the FastWrite project history.</span></div></div>
        <div className="settings-export"><div><strong>Workspace snapshot</strong><span>Download all source files as a portable tar.gz archive.</span></div><Link variant="button" href={api.projects.exportUrl(project.id)} download><Icon name={icons.cloudDownload} />Export</Link></div>
          </section>
        </div>
      </div>
      <footer className={styles.footer}>
        <div role="status">{error ? <span className="form-error" role="alert">{error}</span> : saved ? "Settings saved" : "Save to apply your changes."}</div>
        <Button variant="primary" data-save-command icon={<Icon name={icons.save} />} loading={loading} disabled={!name.trim() || !mainDocument || savingAgent} onClick={() => void save()}>Save changes</Button>
      </footer>
    </div>
  );
}

function flattenFiles(nodes: WorkspaceTreeNode[]): string[] {
  return nodes.flatMap((node) => node.type === "file" ? [node.path] : flattenFiles(node.children));
}
