import { useCallback, useEffect, useId, useState } from "react";
import type { TeamSummary } from "@fastwrite/shared";
import { api } from "../../api/client";
import { modelProviderLabel, roleLabel } from "../../lib/labels";
import { userFacingError } from "../../lib/notifications";
import { HarnessProfileEditor } from "../workspace/ProjectHarnessProfile";
import { Button, Checkbox, Dialog, Field, Icon, IconButton, MultiSelect, NumberField, Select, TabBar, Table, TableCell, TableRow, TextArea, TextField, icons } from "../ui";
import styles from "./TeamsPanel.module.css";

type TeamMode = "invite" | "manage";
type Roster = Awaited<ReturnType<typeof api.teams.members>>;
type Policy = Awaited<ReturnType<typeof api.teams.policy>>;
const providers = ["codex", "claude", "openai-compatible"] as const;

export function TeamsPanel() {
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [active, setActive] = useState<{ team: TeamSummary; mode: TeamMode } | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError("");
    try { setTeams((await api.teams.list(signal)).filter(team => !team.personalUserId)); }
    catch (failure) { if ((failure as DOMException).name !== "AbortError") setError(userFacingError(failure, "无法加载团队")); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);

  return <>
    <header className={styles.heading}>
      <div className={styles.title}><h1 id="teams-title">我的团队</h1><span className={styles.count} aria-label={`${teams.length} 个团队`}>{loading ? "—" : teams.length}</span></div>
      <Button variant="primary" icon={<Icon name={icons.add} />} onClick={() => setCreating(true)}>创建团队</Button>
    </header>
    <div className={styles.listHeading}><span>团队与协作</span><IconButton label="刷新团队列表" icon={<Icon name={icons.refresh} spin={loading} />} disabled={loading} onClick={() => void load()} /></div>
    {error ? <div className="page-error" role="alert"><span>{error}</span><Button size="small" onClick={() => void load()}>重试</Button></div> : null}
    {loading && !teams.length ? <div className={styles.empty} role="status">正在加载团队…</div> : teams.length ? <Table label="团队列表" className={styles.table!} columns={["团队名称", "人数", "关联论文", "我的角色", "操作"]}>
      {teams.map(team => <TableRow key={team.id}>
        <TableCell><div className={styles.identity}><span className={styles.avatar}><Icon name={icons.organization} size={20} /></span><div><strong>{team.name}</strong><small>{team.slug}</small><span className={styles.mobileMeta}>{team.memberCount} 人 · {team.projectCount} 篇论文 · {roleLabel(team.role)}</span></div></div></TableCell>
        <TableCell><span className={styles.metric}>{team.memberCount}<small> 人</small></span></TableCell>
        <TableCell><span className={styles.metric}>{team.projectCount}<small> 篇</small></span></TableCell>
        <TableCell><span className={styles.role}>{roleLabel(team.role)}</span></TableCell>
        <TableCell><div className={styles.actions}>
          <Button size="small" variant="secondary" icon={<Icon name={icons.personAdd} />} disabled={team.role === "member"} title={team.role === "member" ? "需要团队所有者或管理员权限" : "邀请成员"} onClick={() => setActive({ team, mode: "invite" })}>邀请</Button>
          <Button size="small" variant="ghost" icon={<Icon name={icons.settingsGear} />} onClick={() => setActive({ team, mode: "manage" })}>管理</Button>
        </div></TableCell>
      </TableRow>)}
    </Table> : !error ? <div className={styles.empty}><Icon name={icons.organization} size={36} /><h2>还没有加入团队</h2><p>创建一个团队，与成员一起管理和撰写论文。</p><Button variant="secondary" icon={<Icon name={icons.add} />} onClick={() => setCreating(true)}>创建团队</Button></div> : null}
    {creating ? <CreateTeamDialog onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void load(); }} /> : null}
    {active ? <TeamDialog key={`${active.team.id}:${active.mode}`} team={active.team} mode={active.mode} onClose={() => setActive(null)} onChanged={() => void load()} /> : null}
  </>;
}

function CreateTeamDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const create = async () => {
    if (busy || !name.trim()) return;
    setBusy(true); setError("");
    try { await api.teams.create(name.trim()); onCreated(); }
    catch (failure) { setError(userFacingError(failure, "无法创建团队")); }
    finally { setBusy(false); }
  };
  return <Dialog open title="创建团队" description="为你的研究小组创建共同的论文空间。" width="small" onClose={() => { if (!busy) onClose(); }} footer={<><Button variant="ghost" disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={busy || !name.trim()} onClick={() => void create()}>创建团队</Button></>}>
    <form className={styles.form} onSubmit={event => { event.preventDefault(); void create(); }}><Field label="团队名称"><TextField aria-label="团队名称" value={name} onChange={setName} placeholder="例如：应用密码学实验室" autoFocus maxLength={120} required disabled={busy} /></Field>{error ? <div className="form-error" role="alert">{error}</div> : null}</form>
  </Dialog>;
}

function TeamDialog({ team, mode, onClose, onChanged }: { team: TeamSummary; mode: TeamMode; onClose: () => void; onChanged: () => void }) {
  const inviteFormId = useId();
  const [tab, setTab] = useState("members");
  const [roster, setRoster] = useState<Roster | null>(null);
  const [invitations, setInvitations] = useState<Awaited<ReturnType<typeof api.teams.invitations>>>([]);
  const [bindings, setBindings] = useState<Awaited<ReturnType<typeof api.teams.groupBindings>>>([]);
  const [policy, setPolicy] = useState<Policy>({ personalHarness: false });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [expiresAt, setExpiresAt] = useState("");
  const [message, setMessage] = useState("");
  const [link, setLink] = useState("");
  const [group, setGroup] = useState("");
  const [groupRole, setGroupRole] = useState<"admin" | "member">("member");
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.teams.previewGroupBindings>> | null>(null);
  const canManage = team.role === "owner" || team.role === "admin";
  const load = useCallback(async () => {
    const roster = await api.teams.members(team.id);
    setRoster(roster);
    if (mode === "invite") return;
    // Members can read the roster; invitation and group endpoints have stricter permissions.
    const [pending, groups, currentPolicy] = await Promise.all([
      roster.canManageInvitations ? api.teams.invitations(team.id) : Promise.resolve([]),
      roster.canManage ? api.teams.groupBindings(team.id) : Promise.resolve([]),
      api.teams.policy(team.id),
    ]);
    setInvitations(pending); setBindings(groups); setPolicy(currentPolicy);
  }, [team.id, mode]);
  useEffect(() => { let live = true; void load().catch(failure => { if (live) setError(userFacingError(failure, "无法加载团队信息")); }).finally(() => { if (live) setLoading(false); }); return () => { live = false; }; }, [load]);
  const act = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(""); setResult("");
    try { await operation(); }
    catch (failure) { setError(userFacingError(failure, "团队操作失败")); }
    finally { setBusy(false); }
  };
  const invite = () => act(async () => {
    const response = await api.teams.invite(team.id, { email: email.trim(), role, ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}), ...(message.trim() ? { message: message.trim() } : {}) });
    setLink(`${window.location.origin}/panel?invite=${encodeURIComponent(response.token)}`);
    setEmail(""); setExpiresAt(""); setMessage(""); setResult("邀请已创建");
  });
  const updateMember = (userId: string, nextRole: "admin" | "member") => act(async () => { await api.teams.updateMember(team.id, userId, nextRole); await load(); onChanged(); setResult("成员角色已更新"); });
  const removeMember = (userId: string) => {
    if (!window.confirm("从团队中移除此成员？")) return;
    void act(async () => { await api.teams.removeMember(team.id, userId); await load(); onChanged(); setResult("成员已移除"); });
  };
  const manageInvitation = (id: string, action: "resend" | "revoke") => act(async () => {
    if (action === "resend") { const response = await api.teams.resendInvitation(id); setLink(`${window.location.origin}/panel?invite=${encodeURIComponent(response.token)}`); }
    else await api.teams.revokeInvitation(id);
    await load(); setResult(action === "resend" ? "邀请已重新生成" : "邀请已撤销");
  });

  return <Dialog open title={mode === "invite" ? "邀请团队成员" : "管理团队"} description={team.name} width={mode === "manage" ? "large" : "medium"} className={`${styles.dialog} ${mode === "manage" ? styles.managementDialog : ""}`} onClose={() => { if (!busy) onClose(); }} footer={<>
    {result ? <span className={styles.result} role="status">{result}</span> : null}
    <Button variant="ghost" disabled={busy} onClick={onClose}>关闭</Button>
    {mode === "manage" && tab === "groups" && roster?.canManage ? <>
      <Button size="small" disabled={busy || !group.trim()} onClick={() => void act(async () => { setPreview(await api.teams.previewGroupBindings(team.id, [group.trim()])); })}>预览</Button>
      <Button size="small" variant="primary" disabled={busy || !group.trim()} onClick={() => void act(async () => { await api.teams.saveGroupBinding(team.id, "new", { idpGroup: group.trim(), role: groupRole }); setGroup(""); setPreview(null); await load(); setResult("用户组绑定已添加"); })}>添加绑定</Button>
    </> : null}
    {mode === "invite" ? <Button variant="primary" icon={<Icon name={icons.personAdd} />} disabled={busy || loading || !roster?.canManageInvitations || !email.trim()} loading={busy} type="submit" form={inviteFormId}>创建邀请</Button> : null}
  </>}>
    <div className={styles.summary}><span className={styles.avatar}><Icon name={icons.organization} size={22} /></span><div><strong>{team.name}</strong><small>{roster?.members.length ?? team.memberCount} 位成员 · {team.projectCount} 篇关联论文</small></div><span className={styles.role}>{roleLabel(team.role)}</span></div>
    {error ? <div className="form-error" role="alert">{error}</div> : null}
    {loading ? <p className={styles.muted} role="status">正在加载团队信息…</p> : mode === "invite" ? <form id={inviteFormId} className={styles.form} onSubmit={event => { event.preventDefault(); if (roster?.canManageInvitations && email.trim()) void invite(); }}>
      <Field label="成员邮箱"><TextField aria-label="成员邮箱" type="email" value={email} onChange={setEmail} placeholder="researcher@university.edu" required disabled={busy} autoFocus /></Field>
      <div className={styles.formGrid}><Field label="团队角色"><Select aria-label="团队角色" value={role} onChange={next => setRole(next as typeof role)} disabled={busy} options={[{ value: "member", label: "成员" }, { value: "admin", label: "管理员" }]} /></Field><Field label="到期时间（可选）"><TextField aria-label="到期时间" type="datetime-local" value={expiresAt} onChange={setExpiresAt} disabled={busy} /></Field></div>
      <Field label="留言（可选）"><TextArea aria-label="邀请留言" rows={3} maxLength={2000} value={message} onChange={setMessage} placeholder="和新成员说些什么…" disabled={busy} /></Field>
    </form> : <>
      <TabBar label="团队管理" activeId={tab} onSelect={setTab} tabs={[{ id: "members", label: `成员 ${roster?.members.length ?? 0}` }, ...(canManage ? [{ id: "invitations", label: "邀请记录" }, { id: "policy", label: "模型策略" }] : []), ...(roster?.canManage ? [{ id: "groups", label: "用户组绑定" }] : [])]} />
      <div className={styles.tabContent}>
        {tab === "members" ? <section aria-label="团队成员" className={styles.roster}>
          {roster?.members.map(member => <div className={styles.memberRow} key={member.userId}><span className={styles.memberAvatar}>{member.user.displayName.slice(0, 1)}</span><div className={styles.person}><strong>{member.user.displayName}</strong><small>{member.user.emailNormalized}</small></div><div className={styles.memberActions}>
            {member.role !== "owner" && roster.canManage ? <><Select aria-label={`成员角色： ${member.user.displayName}`} value={member.role} disabled={busy} onChange={value => void updateMember(member.userId, value as "admin" | "member")} options={[{ value: "member", label: "成员" }, { value: "admin", label: "管理员" }]} /><Button size="small" variant="ghost" disabled={busy} onClick={() => removeMember(member.userId)}>移除</Button></> : <span className={styles.role}>{roleLabel(member.role)}</span>}
          </div></div>)}
        </section> : tab === "invitations" ? <section aria-label="团队邀请" className={styles.roster}>
          {invitations.map(invitation => <div className={styles.memberRow} key={invitation.id}><div className={styles.person}><strong>{invitation.emailNormalized}</strong><small>{roleLabel(invitation.role)} · {invitation.acceptedAt ? "已接受" : invitation.revokedAt ? "已撤销" : Date.parse(invitation.expiresAt) <= Date.now() ? "已过期" : "待接受"}</small>{invitation.message ? <small>{invitation.message}</small> : null}</div>{!invitation.acceptedAt && !invitation.revokedAt ? <div className={styles.actions}><Button size="small" variant="ghost" disabled={busy} onClick={() => void manageInvitation(invitation.id, "resend")}>重新发送</Button><Button size="small" variant="ghost" disabled={busy} onClick={() => void manageInvitation(invitation.id, "revoke")}>撤销</Button></div> : null}</div>)}
          {!invitations.length ? <p className={styles.muted}>暂无邀请记录</p> : null}
        </section> : tab === "policy" ? <div className={styles.form}>
          <Checkbox checked={policy.personalHarness} disabled={busy} onChange={checked => setPolicy(current => ({ ...current, personalHarness: checked }))}>允许个人模型配置</Checkbox>
          <div className={styles.providerField}><Field label="允许的模型服务"><MultiSelect label="允许的模型服务" value={policy.allowedProviders ?? []} onChange={values => setPolicy(current => { const next = { ...current }; const allowed = providers.filter(provider => values.includes(provider)); if (allowed.length) next.allowedProviders = allowed; else delete next.allowedProviders; return next; })} options={providers.map(provider => ({ value: provider, label: modelProviderLabel(provider), disabled: busy }))} /></Field></div>
          <div className={styles.formGrid}><Field label="最大并发任务数"><NumberField min={1} max={100} value={policy.maxConcurrentRuns} disabled={busy} onChange={value => setPolicy(current => { const next = { ...current }; if (value === undefined) delete next.maxConcurrentRuns; else next.maxConcurrentRuns = value; return next; })} /></Field><Field label="每日预算（美元）"><NumberField min={0} step={0.01} value={policy.dailyBudgetUsd} disabled={busy} onChange={value => setPolicy(current => { const next = { ...current }; if (value === undefined) delete next.dailyBudgetUsd; else next.dailyBudgetUsd = value; return next; })} /></Field></div>
          <div><Button variant="primary" size="small" loading={busy} disabled={busy} onClick={() => void act(async () => { await api.teams.updatePolicy(team.id, policy); setResult("模型策略已保存"); })}>保存模型策略</Button></div>
          {roster?.canManage ? <div className={styles.profile}><h3>团队模型配置</h3><HarnessProfileEditor scope="team" teamId={team.id} /></div> : null}
        </div> : tab === "groups" ? <div className={styles.form}>
          <Field label="身份服务用户组"><TextField value={group} onChange={value => { setGroup(value); setPreview(null); }} placeholder="https://idp.example:lab-members" disabled={busy} /></Field>
          <Field label="映射角色"><Select aria-label="映射角色" value={groupRole} onChange={value => setGroupRole(value as typeof groupRole)} disabled={busy} options={[{ value: "member", label: "成员" }, { value: "admin", label: "管理员" }]} /></Field>
          {preview ? <p className={styles.muted}>{preview.length ? preview.map(binding => `${binding.idpGroup}（${roleLabel(binding.role)}）`).join("、") : "暂无匹配的用户组绑定"}</p> : null}
          {bindings.map(binding => <div className={styles.memberRow} key={binding.id}><div className={styles.person}><strong>{binding.idpGroup}</strong><small>{roleLabel(binding.role)}</small></div><Button size="small" variant="ghost" disabled={busy} onClick={() => void act(async () => { await api.teams.deleteGroupBinding(team.id, binding.id); await load(); onChanged(); setResult("用户组绑定已移除"); })}>移除</Button></div>)}
        </div> : null}
      </div>
    </>}
    {link ? <div className={styles.linkBox}><Field label="邀请链接（仅显示一次）"><TextField aria-label="邀请链接" readonly value={link} /></Field><Button size="small" variant="secondary" onClick={() => void act(async () => { await navigator.clipboard.writeText(link); setResult("邀请链接已复制"); })}>复制链接</Button></div> : null}
  </Dialog>;
}
