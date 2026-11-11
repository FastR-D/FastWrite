import { useEffect, useId, useState } from "react";
import { WRITING_PROFILES, type PaperProject, type ProjectAccess, type PublicationTarget, type TeamSummary, type WritingProfile } from "@fastwrite/shared";
import { api } from "../../api/client";
import { userFacingError } from "../../lib/notifications";
import { Button, Dialog, Field, Icon, Select, TextArea, TextField, icons } from "../ui";
import { PublicationTargetFields } from "../ui/PublicationTargetFields";
import styles from "./ProjectActionDialog.module.css";

export type ProjectAction = "edit" | "transfer" | "invite";
const titles: Record<ProjectAction, string> = { edit: "编辑项目", transfer: "转移团队", invite: "邀请协作者" };

export function ProjectActionDialog({ project, action, onClose, onUpdated }: {
  project: PaperProject;
  action: ProjectAction;
  onClose: () => void;
  onUpdated: (project: PaperProject) => void;
}) {
  const formId = useId();
  const [access, setAccess] = useState<ProjectAccess | null>(null);
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState(project.name);
  const [mainDocument, setMainDocument] = useState(project.mainDocument);
  const [profile, setProfile] = useState<WritingProfile>(project.skill.id);
  const [target, setTarget] = useState<PublicationTarget | undefined>(project.publicationTarget);
  const [teamId, setTeamId] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"maintainer" | "editor" | "commenter" | "viewer">("editor");
  const [expiresAt, setExpiresAt] = useState("");
  const [message, setMessage] = useState("");
  const [invitationLink, setInvitationLink] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setLoadFailed(false); setError("");
    void (async () => {
      try {
        const next = await api.projects.access(project.id, undefined, controller.signal);
        if (controller.signal.aborted) return;
        setAccess(next);
        if (action === "transfer" && next.canManage) {
          const items = await api.teams.list(controller.signal);
          if (!controller.signal.aborted) setTeams(items);
        }
      } catch (failure) {
        if (!controller.signal.aborted) { setLoadFailed(true); setError(userFacingError(failure, "无法加载项目信息")); }
      } finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [project.id, action, attempt]);

  const allowed = action === "invite" ? access?.canInvite : access?.canManage;
  const availableTeams = teams.filter(team => !team.personalUserId && team.id !== project.teamId && (team.role === "owner" || team.role === "admin"));
  const selectedTeam = availableTeams.find(team => team.id === teamId);
  const valid = action === "edit" ? Boolean(name.trim() && mainDocument.trim()) : action === "transfer" ? Boolean(selectedTeam) : Boolean(email.trim());
  const submit = async () => {
    if (busy || loading || loadFailed || !allowed || !valid) return;
    setBusy(true); setError("");
    try {
      if (action === "edit") {
        const updated = await api.projects.update(project.id, {
          name: name.trim(),
          ...(mainDocument.trim() !== project.mainDocument ? { mainDocument: mainDocument.trim() } : {}),
          ...(profile !== project.skill.id ? { venue: profile } : {}),
          ...(JSON.stringify(target) !== JSON.stringify(project.publicationTarget) ? { publicationTarget: target ?? null } : {}),
        });
        onUpdated(updated); onClose();
      } else if (action === "transfer" && selectedTeam) {
        const updated = await api.projects.transferToTeam(project.id, selectedTeam.id);
        onUpdated(updated); onClose();
      } else if (action === "invite") {
        const response = await api.projects.invite(project.id, {
          email: email.trim(), role,
          ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
          ...(message.trim() ? { message: message.trim() } : {}),
        });
        setInvitationLink(`${window.location.origin}/panel?invite=${encodeURIComponent(response.token)}`);
        setEmail(""); setMessage(""); setExpiresAt(""); setCopied(false);
      }
    } catch (failure) { setError(userFacingError(failure, action === "edit" ? "无法保存项目" : action === "transfer" ? "无法转移项目" : "无法创建邀请")); }
    finally { setBusy(false); }
  };

  return <Dialog open title={titles[action]} description={project.name} width="medium" className={`${styles.dialog} ${action === "transfer" ? styles.transfer : ""}`} onClose={() => { if (!busy) onClose(); }} footer={<>
    <Button variant="ghost" disabled={busy} onClick={onClose}>{action === "invite" ? "关闭" : "取消"}</Button>
    <Button variant="primary" type="submit" form={formId} loading={busy} disabled={loading || loadFailed || !allowed || !valid || busy} icon={<Icon name={action === "edit" ? icons.edit : action === "transfer" ? icons.arrowBoth : icons.personAdd} />}>{action === "edit" ? "保存修改" : action === "transfer" ? "确认转移" : "创建邀请"}</Button>
  </>}>
    {error ? <div className="form-error" role="alert">{error}{loadFailed ? <Button size="small" variant="ghost" onClick={() => setAttempt(value => value + 1)}>重试</Button> : null}</div> : null}
    {loading ? <p className={styles.muted} role="status">正在加载项目信息…</p> : !loadFailed && !allowed ? <p className={styles.muted}>{action === "invite" ? "你没有邀请协作者的权限。" : "你没有管理此项目的权限。"}</p> : !loadFailed ? <form id={formId} className={styles.form} onSubmit={event => { event.preventDefault(); void submit(); }}>
      {action === "edit" ? <>
        <Field label="项目名称"><TextField aria-label="项目名称" value={name} onChange={setName} maxLength={200} disabled={busy} required autoFocus /></Field>
        <Field label="主文档" hint="项目中已存在的 .tex 文件路径。"><TextField aria-label="主文档" value={mainDocument} onChange={setMainDocument} placeholder="main.tex" disabled={busy} required /></Field>
        <div className={styles.fieldset}>
          <Field label="研究领域"><Select aria-label="研究领域" value={profile} onChange={value => { setProfile(value as WritingProfile); setTarget(undefined); }} options={WRITING_PROFILES.map(item => ({ value: item.value, label: item.label }))} disabled={busy} /></Field>
          <PublicationTargetFields disabled={busy} profile={profile} value={target} onChange={setTarget} />
        </div>
      </> : action === "transfer" ? <>
        <div className={styles.project}><Icon name={icons.fileText} size={22} /><div><strong>{project.name}</strong><small>{project.teamId ? teams.find(team => team.id === project.teamId)?.name ?? "团队项目" : "个人项目"}</small></div></div>
        {availableTeams.length ? <><Field label="目标团队"><Select aria-label="目标团队" value={teamId} onChange={setTeamId} disabled={busy} placeholder="选择接收项目的团队" options={availableTeams.map(team => ({ value: team.id, label: team.name, description: `${team.memberCount} 位成员 · ${team.projectCount} 篇论文` }))} /></Field><p className={styles.muted}>转移后，目标团队成员将按团队权限访问此项目。</p></> : <p className={styles.muted}>暂无可接收项目的团队。请先创建团队，或成为目标团队的所有者、管理员。</p>}
      </> : <>
        <Field label="成员邮箱"><TextField aria-label="成员邮箱" type="email" value={email} onChange={setEmail} placeholder="researcher@university.edu" disabled={busy} required autoFocus /></Field>
        <div className={styles.grid}>
          <Field label="项目角色"><Select aria-label="项目角色" value={role} onChange={value => setRole(value as typeof role)} disabled={busy} options={[{ value: "maintainer", label: "维护者" }, { value: "editor", label: "编辑者" }, { value: "commenter", label: "审阅者" }, { value: "viewer", label: "查看者" }]} /></Field>
          <Field label="到期时间（可选）"><TextField aria-label="到期时间" type="datetime-local" value={expiresAt} onChange={setExpiresAt} disabled={busy} /></Field>
        </div>
        <Field label="留言（可选）"><TextArea aria-label="邀请留言" value={message} onChange={setMessage} rows={3} maxLength={2000} disabled={busy} /></Field>
        {invitationLink ? <div className={styles.linkBox}><strong role="status">邀请已创建</strong><Field label="邀请链接（仅显示一次）"><TextField aria-label="邀请链接" value={invitationLink} readonly /></Field><Button size="small" variant="secondary" disabled={busy} onClick={() => { void navigator.clipboard.writeText(invitationLink).then(() => setCopied(true)).catch(failure => setError(userFacingError(failure, "复制失败，请手动复制链接"))); }}>{copied ? "已复制" : "复制链接"}</Button></div> : null}
      </>}
    </form> : null}
  </Dialog>;
}
