import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client";
import { userFacingError } from "../../lib/notifications";
import { roleLabel, statusLabel } from "../../lib/labels";
import { Button, Dialog, Field, Icon, Select, Table, TableCell, TableRow, TextField, icons } from "../ui";
import styles from "./UserManagementPanel.module.css";

type User = Awaited<ReturnType<typeof api.admin.users>>[number];
type Action = { type: "create" } | { type: "edit" | "teams" | "delete"; user: User };
export function UserManagementPanel({ currentUserId }: { currentUserId?: string | undefined }) {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setUsers(await api.admin.users()); } catch (error) { setError(userFacingError(error, "无法加载用户")); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const visible = users.filter(user => `${user.displayName} ${user.emailNormalized} ${user.localLoginId ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <>
    <header className={styles.heading}><div><h1 id="users-title">用户管理</h1><p>管理 FastWrite 账号及团队成员资格。</p></div><Button variant="primary" icon={<Icon name={icons.personAdd} />} onClick={() => setAction({ type: "create" })}>新增用户</Button></header>
    <div className={styles.toolbar}><TextField type="search" aria-label="搜索用户" placeholder="搜索名称或邮箱…" value={query} onChange={setQuery} /><Button variant="ghost" loading={loading} icon={<Icon name={icons.refresh} />} onClick={() => void load()}>刷新</Button></div>
    {error ? <p className="page-error" role="alert">{error}</p> : null}
    {loading ? <p role="status">正在加载用户…</p> : <Table label="用户列表" className={styles.usersTable!} columns={["用户", "平台角色", "状态", "有效会话", "创建时间", "操作"]}>
      {visible.map(user => <TableRow key={user.id}><TableCell><strong>{user.displayName}</strong><small className={styles.email}>{user.localLoginId ?? user.emailNormalized}</small></TableCell><TableCell>{roleLabel(user.platformRole)}</TableCell><TableCell>{statusLabel(user.status)}</TableCell><TableCell>{user.activeSessionCount}</TableCell><TableCell>{new Date(user.createdAt).toLocaleDateString("zh-CN")}</TableCell><TableCell><div className={styles.actions}>
        <Button size="small" variant="ghost" icon={<Icon name={icons.edit} />} aria-label={`编辑 ${user.displayName}`} onClick={() => setAction({ type: "edit", user })}>编辑</Button>
        <Button size="small" variant="ghost" icon={<Icon name={icons.organization} />} aria-label={`团队管理 ${user.displayName}`} onClick={() => setAction({ type: "teams", user })}>团队管理</Button>
        <Button size="small" variant="danger" icon={<Icon name={icons.trash} />} aria-label={`删除 ${user.displayName}`} onClick={() => setAction({ type: "delete", user })}>删除</Button>
      </div></TableCell></TableRow>)}
    </Table>}
    {!loading && !error && !visible.length ? <p className={styles.empty}>{query ? "没有匹配的用户。" : "暂无用户。"}</p> : null}
    {action ? <UserActionDialog key={action.type + ("user" in action ? action.user.id : "")} action={action} onClose={() => setAction(null)} onUpdated={() => { if (action.type === "edit" && action.user.id === currentUserId) { localStorage.removeItem("fastwrite.session-token"); window.location.assign("/panel"); return; } setAction(null); void load(); }} /> : null}
  </>;
}
function UserActionDialog({ action, onClose, onUpdated }: { action: Action; onClose: () => void; onUpdated: () => void }) {
  const user = "user" in action ? action.user : undefined;
  const [email, setEmail] = useState(user?.localLoginId ?? user?.emailNormalized ?? "");
  const [name, setName] = useState(user?.displayName ?? "");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState(user?.platformRole ?? "user");
  const [status, setStatus] = useState(user?.status ?? "active");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [teams, setTeams] = useState<Awaited<ReturnType<typeof api.admin.userTeams>>>([]);
  const [teamsLoading, setTeamsLoading] = useState(action.type === "teams");
  useEffect(() => {
    if (action.type !== "teams") return;
    void api.admin.userTeams(action.user.id).then(setTeams).catch(error => setError(userFacingError(error))).finally(() => setTeamsLoading(false));
  }, [action]);
  const validReason = reason.trim().length >= 8;
  const save = async () => {
    setBusy(true); setError("");
    try {
      if (action.type === "delete") await api.admin.deleteUser(action.user.id, reason);
      else if (action.type === "create" || action.type === "edit") {
        const body = { email, displayName: name, platformRole: role as "user" | "platform_admin" | "support_auditor", status: status as "active" | "disabled", reason, ...(password ? { password } : {}) };
        if (action.type === "create") await api.admin.createUser(body); else await api.admin.updateUser(action.user.id, body);
      }
      onUpdated();
    } catch (error) { setError(userFacingError(error, "操作失败")); } finally { setBusy(false); }
  };
  const saveTeam = async (teamId: string, nextRole: string) => {
    if (!user) return;
    setBusy(true); setError("");
    try { await api.admin.setUserTeam(user.id, teamId, nextRole as "owner" | "admin" | "member" | "", reason); setTeams(await api.admin.userTeams(user.id)); }
    catch (error) { setError(userFacingError(error, "团队管理失败")); } finally { setBusy(false); }
  };
  const title = { create: "新增用户", edit: "编辑用户", teams: "用户团队管理", delete: "删除用户" }[action.type];
  const invalid = !validReason || ((action.type === "create" || action.type === "edit") && (!email.trim() || !name.trim() || (action.type === "create" || Boolean(password)) && password.length < 12));
  return <Dialog open title={title} description={user ? `${user.displayName} · ${user.localLoginId ?? user.emailNormalized}` : "创建账号后，用户即可使用邮箱和密码登录。"} onClose={() => { if (!busy) onClose(); }} width={action.type === "teams" ? "large" : "medium"} footer={<><Button variant="ghost" disabled={busy} onClick={onClose}>{action.type === "teams" ? "完成" : "取消"}</Button>{action.type !== "teams" ? <Button type="submit" form="admin-user-form" variant={action.type === "delete" ? "danger" : "primary"} loading={busy} disabled={invalid}>{action.type === "delete" ? "确认删除" : "保存"}</Button> : null}</>}>
    <form id="admin-user-form" className="form-stack" onSubmit={event => { event.preventDefault(); if (!busy && !invalid && action.type !== "teams") void save(); }}>
      {action.type === "create" || action.type === "edit" ? <>
        <Field label="名称"><TextField required autoFocus value={name} onChange={setName} maxLength={100} /></Field>
        <Field label="邮箱"><TextField required type="email" autoComplete="off" value={email} onChange={setEmail} maxLength={320} /></Field>
        <Field label={action.type === "create" ? "初始密码（至少 12 个字符）" : "重置密码（留空则保留）"}><TextField required={action.type === "create"} type="password" autoComplete="new-password" value={password} onChange={setPassword} maxLength={1024} /></Field>
        <Field label="平台角色"><Select value={role} onChange={setRole} options={[{ value: "user", label: "用户" }, { value: "support_auditor", label: "支持审计员" }, { value: "platform_admin", label: "平台管理员" }]} /></Field>
        <Field label="账号状态"><Select value={status} onChange={setStatus} options={[{ value: "active", label: "正常" }, { value: "disabled", label: "停用" }]} /></Field>
        {action.type === "edit" ? <p>保存后会撤销该用户的现有会话，需要重新登录。</p> : null}
      </> : action.type === "delete" ? <p>删除后该账号将无法登录。请先转移此用户拥有的项目和团队，历史操作记录会保留。</p> : null}
      <Field label="操作原因（至少 8 个字符）"><TextField required value={reason} onChange={setReason} maxLength={500} placeholder="填写原因以保留审计记录" /></Field>
      {action.type === "teams" ? teamsLoading ? <p role="status">正在加载团队…</p> : teams.length ? <div className={styles.teamList}>{teams.map(team => <div className={styles.team} key={team.id}><strong>{team.name}</strong><Select aria-label={`${team.name} 成员角色`} value={team.role} disabled={busy || !validReason} onChange={value => void saveTeam(team.id, value)} options={[{ value: "", label: "未加入" }, { value: "member", label: "成员" }, { value: "admin", label: "管理员" }, { value: "owner", label: "所有者" }]} /></div>)}</div> : <p>暂无可管理的团队，请先在“团队与协作”中创建团队。</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </form>
  </Dialog>;
}
