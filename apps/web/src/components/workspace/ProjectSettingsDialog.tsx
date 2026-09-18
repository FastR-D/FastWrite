import { useEffect, useMemo, useState } from "react";
import { Download, Save } from "lucide-react";
import { isIgnoredWorkspacePath, WRITING_PROFILES, type AgentWireApi, type PaperProject, type ProjectAclAction, type PublicationTarget, type WritingProfile, type WorkspaceTreeNode } from "@fastwrite/shared";
import { api } from "../../api/client";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { PublicationTargetFields } from "../ui/PublicationTargetFields";
import { harnessSettingsSaveDecision, type HarnessSettingsBaseline, type HarnessSettingsDraft } from "./harnessSettings";
import { responseLanguage, setResponseLanguage, type ResponseLanguage } from "../../lib/responseLanguage";

interface ProjectSettingsDialogProps {
  open: boolean;
  project: PaperProject;
  tree: WorkspaceTreeNode[];
  onClose: () => void;
  onSaved: (project: PaperProject) => void | Promise<void>;
}
interface RememberedHarnessSettings { baseURL?: string; model?: string; wireAPI?: AgentWireApi }
type AclRule = { id: string; pathPrefix: string; subjectType: "user" | "project_role" | "team_role" | "idp_group"; subjectId: string; action: ProjectAclAction; effect: "allow" | "deny" };
const ACL_ACTIONS: ProjectAclAction[] = ["read", "comment", "edit", "manage", "run_ai", "manage_harness", "export", "sync_github"];

export function ProjectSettingsDialog({ open, project, tree, onClose, onSaved }: ProjectSettingsDialogProps) {
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
  const texFiles = useMemo(() => flattenFiles(tree).filter((path) => path.toLowerCase().endsWith(".tex") && !isIgnoredWorkspacePath(path)), [tree]);

  useEffect(() => {
    if (!open) return;
    setName(project.name);
    setMainDocument(texFiles.includes(project.mainDocument) ? project.mainDocument : preferredMainDocument(texFiles));
    setProfile(project.skill.venue);
    setPublicationTarget(project.publicationTarget);
    setError("");
    setAgentConfigured(null);
    setAgentSource("none");
    setApiKey("");
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
      setAgentConfigured(settings.configured);
      setAgentSource(settings.source);
      setBaseURL(settings.baseURL ?? "");
      setModel(settings.model ?? "");
      setWireAPI(settings.wireAPI);
      setAgentBaseline({ configured: settings.configured, baseURL: settings.baseURL ?? "", model: settings.model ?? "", wireAPI: settings.wireAPI });
    }).catch(() => { setAgentConfigured(false); setAgentBaseline({ configured: false, baseURL: "", model: "", wireAPI: "chat" }); });
    void api.projects.acl(project.id).then((rules) => { setAclRules(rules); setAclAvailable(true); }).catch(() => setAclAvailable(false));
  }, [open, project, texFiles]);

  const resolvedAgentDraft = (): { ok: true; draft: HarnessSettingsDraft } | { ok: false; message: string } => {
    const draft: HarnessSettingsDraft = { apiKey, baseURL, model, wireAPI };
    return { ok: true, draft };
  };


  const save = async () => {
    setError("");
    setAgentError("");
    const resolved = resolvedAgentDraft();
    if (!resolved.ok) { setAgentError(resolved.message); return; }
    const agentDecision = harnessSettingsSaveDecision(resolved.draft, agentBaseline);
    if (agentDecision.kind === "invalid") { setAgentError(agentDecision.message); return; }
    setLoading(true);
    setResponseLanguage(language);
    try {
      if (agentDecision.kind === "save") await persistAgentSettings(agentDecision.body);
      const updated = await api.projects.update(project.id, { name: name.trim(), mainDocument, venue: profile, publicationTarget: publicationTarget ?? null });
      await onSaved(updated);
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

  return (
    <Dialog
      open={open}
      title="Project settings"
      description="Configure the paper entry point and the Writing Skill used by Agent, Revise, and Review."
      width="small"
      onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={<Save />} loading={loading} disabled={!name.trim() || !mainDocument || savingAgent} onClick={() => void save()}>Save changes</Button></>}
    >
      <div className="settings-fields">
        <label className="field"><span>Project name</span><input value={name} onChange={(event) => setName(event.target.value)} autoFocus /></label>
        <label className="field"><span>Main document</span><select value={mainDocument} onChange={(event) => setMainDocument(event.target.value)}>{texFiles.map((path) => <option key={path} value={path}>{path}</option>)}</select></label>
        <label className="field"><span>Research domain</span><select value={profile} onChange={(event) => { const next = event.target.value as WritingProfile; setProfile(next); if (publicationTarget?.domain !== next) setPublicationTarget(undefined); }}>{WRITING_PROFILES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        <PublicationTargetFields profile={profile} value={publicationTarget} onChange={setPublicationTarget} />
        <label className="field"><span>AI response language</span><select value={language} onChange={(event) => setLanguage(event.target.value as ResponseLanguage)}><option value="auto">Follow user</option><option value="zh-CN">中文</option><option value="en-US">English</option></select></label>
        <section className="settings-agent" aria-labelledby="agent-settings-title">
          <div><strong id="agent-settings-title">Harness</strong><span>{agentConfigured ? `Configured from ${agentSource === "environment" ? "server environment" : "this running server"}.` : "Configure a Harness model to enable Agent workflows."}</span></div>
          <label className="field"><span>API key</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={agentConfigured ? "Enter a replacement key" : "sk-…"} autoComplete="off" /></label>
          <label className="field"><span>Base URL <small>optional</small></span><input type="url" value={baseURL} onChange={(event) => setBaseURL(event.target.value)} placeholder="https://api.openai.com/v1" autoComplete="off" /></label>
          <label className="field"><span>Model <small>optional</small></span><input value={model} onChange={(event) => setModel(event.target.value)} placeholder="Use provider default" autoComplete="off" /></label>
          <label className="field"><span>Wire API</span><select value={wireAPI} onChange={(event) => setWireAPI(event.target.value as AgentWireApi)}><option value="chat">Chat Completions</option><option value="responses">Responses</option></select></label>
          <div className="settings-agent__actions"><Button size="small" variant="secondary" loading={savingAgent} disabled={!apiKey.trim() || loading} onClick={() => void saveAgentSettings()}>{agentConfigured ? "Replace API key" : "Enable Agent"}</Button><small>The key is never returned or written to project files; it is cleared when the server restarts.</small></div>
          {agentError ? <div className="form-error" role="alert">{agentError}</div> : null}
        </section>
        {aclAvailable ? <section className="settings-agent" aria-labelledby="acl-settings-title">
          <div><strong id="acl-settings-title">Path access rules</strong><span>Deny rules take precedence. A read denial also blocks editing and collaboration for that path.</span></div>
          <label className="field"><span>File or directory prefix</span><input value={aclDraft.pathPrefix} onChange={(event) => setAclDraft((current) => ({ ...current, pathPrefix: event.target.value }))} placeholder="restricted or restricted/results.tex" /></label>
          <label className="field"><span>Subject</span><select value={aclDraft.subjectType} onChange={(event) => { const subjectType = event.target.value as AclRule["subjectType"]; setAclDraft((current) => ({ ...current, subjectType, subjectId: subjectType === "project_role" ? "editor" : subjectType === "team_role" ? "member" : "" })); }}><option value="project_role">Project role</option><option value="team_role">Team role</option><option value="idp_group">IdP group</option><option value="user">User ID</option></select></label>
          {aclDraft.subjectType === "project_role" ? <label className="field"><span>Project role</span><select value={aclDraft.subjectId} onChange={(event) => setAclDraft((current) => ({ ...current, subjectId: event.target.value }))}><option value="viewer">Viewer</option><option value="commenter">Commenter</option><option value="editor">Editor</option><option value="maintainer">Maintainer</option><option value="owner">Owner</option></select></label> : aclDraft.subjectType === "team_role" ? <label className="field"><span>Team role</span><select value={aclDraft.subjectId} onChange={(event) => setAclDraft((current) => ({ ...current, subjectId: event.target.value }))}><option value="member">Member</option><option value="admin">Admin</option><option value="owner">Owner</option></select></label> : aclDraft.subjectType === "idp_group" ? <label className="field"><span>IdP group</span><input value={aclDraft.subjectId} onChange={(event) => setAclDraft((current) => ({ ...current, subjectId: event.target.value }))} placeholder="https://idp.example:researchers" /></label> : <label className="field"><span>User ID</span><input value={aclDraft.subjectId} onChange={(event) => setAclDraft((current) => ({ ...current, subjectId: event.target.value }))} placeholder="user_…" /></label>}
          <label className="field"><span>Action</span><select value={aclDraft.action} onChange={(event) => setAclDraft((current) => ({ ...current, action: event.target.value as ProjectAclAction }))}>{ACL_ACTIONS.map((action) => <option key={action} value={action}>{action}</option>)}</select></label>
          <label className="field"><span>Effect</span><select value={aclDraft.effect} onChange={(event) => setAclDraft((current) => ({ ...current, effect: event.target.value as AclRule["effect"] }))}><option value="deny">Deny</option><option value="allow">Allow</option></select></label>
          <div className="settings-agent__actions"><Button size="small" variant="secondary" loading={aclBusy} disabled={!aclDraft.subjectId.trim()} onClick={() => void saveAcl()}>Add rule</Button></div>
          {aclRules.map((rule) => <div className="settings-export" key={rule.id}><div><strong>{rule.effect} {rule.action}: {rule.pathPrefix || "/"}</strong><span>{rule.subjectType.replace("_", " ")}: {rule.subjectId}</span></div><Button size="small" variant="ghost" disabled={aclBusy} onClick={() => void removeAcl(rule.id)}>Remove</Button></div>)}
          {aclError ? <div className="form-error" role="alert">{aclError}</div> : null}
        </section> : null}
        <div className="settings-export"><div><strong>Automatic Git history</strong><span>Accepted saves create local Git checkpoints in the FastWrite project history.</span></div></div>
        <div className="settings-export"><div><strong>Workspace snapshot</strong><span>Download all source files as a portable tar.gz archive.</span></div><a className="button button--secondary button--medium" href={api.projects.exportUrl(project.id)} download><Download />Export</a></div>
      </div>
      {error ? <div className="form-error" role="alert">{error}</div> : null}
    </Dialog>
  );
}

function flattenFiles(nodes: WorkspaceTreeNode[]): string[] {
  return nodes.flatMap((node) => node.type === "file" ? [node.path] : flattenFiles(node.children));
}

function preferredMainDocument(paths: string[]): string {
  return paths.find((path) => ["main.tex", "paper.tex", "document.tex"].includes(path.split("/").at(-1)?.toLowerCase() ?? "")) ?? paths[0] ?? "";
}
