import { statusLabel, roleLabel } from "../lib/labels";
import { HarnessProfileEditor } from "../components/workspace/ProjectHarnessProfile";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, ApiClientError } from "../api/client";
import type { SupportAccessRequest } from "@fastwrite/shared";
import { Button, Field, Icon, Link, Select, Table, TableCell, TableRow, TextField, ThemeToggle, icons } from "../components/ui";

type User = { id: string; emailNormalized: string; displayName: string; platformRole: string; status: string; createdAt: string; activeSessionCount: number };
type Audit = { id: string; actorUserId?: string; action: string; resourceType: string; resourceId: string; metadata?: Record<string, string>; createdAt: string };
type Health = { users: number; activeSessions: number; teams: number; projects: number; collaborationDocuments: number; pendingInvitations: number; mail?: { configured: boolean; pending: number; sent: number; failed: number }; postgres?: { configured: boolean; healthy: boolean; failures: number; lastError?: string }; jobs?: { queued: number; running: number; failed: number } };
type PlatformRole = "platform_admin" | "support_auditor" | "user";
type IdentityProviders = { oidc: { configured: boolean; issuer?: string; redirectUri?: string; clientId?: string }; cas: { configured: boolean; serverUrl?: string; serviceUrl?: string }; local: { configured: boolean } };
type DeadLetter = { id: string; kind: string; status: string; attempts: number; error?: string; createdAt: string; updatedAt: string };

export function AdminPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [audits, setAudits] = useState<Audit[]>([]);
  const [identityProviders, setIdentityProviders] = useState<IdentityProviders | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reason, setReason] = useState("");
  const [busyUserId, setBusyUserId] = useState("");
  const [platformRole, setPlatformRole] = useState("");
  const [backup, setBackup] = useState<{ path: string; bytes: number } | null>(null);
  const [deadLetters, setDeadLetters] = useState<DeadLetter[]>([]);
  const [retryingJobId, setRetryingJobId] = useState("");
  const [supportAccess, setSupportAccess] = useState<SupportAccessRequest[]>([]);
  const [supportBusyId, setSupportBusyId] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [nextHealth, nextUsers, nextAudits, nextIdentityProviders, nextDeadLetters, nextSupportAccess, currentUser] = await Promise.all([api.admin.health(), api.admin.users(), api.admin.audits(100), api.admin.identityProviders(), api.admin.deadLetters(), api.admin.supportAccess(), api.auth.me()]);
      setHealth(nextHealth); setUsers(nextUsers); setAudits(nextAudits);
      setIdentityProviders(nextIdentityProviders);
      setDeadLetters(nextDeadLetters);
      setSupportAccess(nextSupportAccess);
      setPlatformRole(currentUser.platformRole);
    } catch (failure) {
      setError(failure instanceof ApiClientError && failure.status === 403 ? "需要管理员权限。" : failure instanceof Error ? failure.message : "无法加载管理数据。");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const act = async (userId: string, operation: "disable" | "revoke") => {
    if (reason.trim().length < 8) { setError("请填写至少 8 个字符的原因。"); return; }
    setBusyUserId(userId); setError("");
    try {
      if (operation === "disable") await api.admin.disableUser(userId, reason); else await api.admin.revokeSessions(userId, reason);
      setReason("");
      await load();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "管理操作失败。"); }
    finally { setBusyUserId(""); }
  };

  const changeRole = async (userId: string, role: PlatformRole) => {
    if (reason.trim().length < 8) { setError("请填写至少 8 个字符的原因。"); return; }
    setBusyUserId(userId); setError("");
    try {
      await api.admin.updatePlatformRole(userId, role, reason);
      setReason("");
      await load();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "管理操作失败。"); }
    finally { setBusyUserId(""); }
  };

  const canManageAccounts = platformRole === "platform_admin";
  const retryJob = async (jobId: string) => { setRetryingJobId(jobId); setError(""); try { await api.admin.retryJob(jobId); await load(); } catch (failure) { setError(failure instanceof Error ? failure.message : "无法重试任务。"); } finally { setRetryingJobId(""); } };
  const createBackup = async () => { setError(""); try { const result = await api.admin.createBackup(); setBackup(result); } catch (failure) { setError(failure instanceof Error ? failure.message : "备份失败。"); } };
  const decideSupport = async (item: SupportAccessRequest, approved: boolean) => { setSupportBusyId(item.id); setError(""); try { const result = await api.admin.decideSupportAccess(item.id, approved); if (result.token) window.prompt("这是一次性支持访问令牌，请立即复制，之后不会再次显示。", result.token); await load(); } catch (failure) { setError(failure instanceof Error ? failure.message : "支持访问审批失败。"); } finally { setSupportBusyId(""); } };
  const revokeSupport = async (item: SupportAccessRequest) => { setSupportBusyId(item.id); setError(""); try { await api.admin.revokeSupportAccess(item.id); await load(); } catch (failure) { setError(failure instanceof Error ? failure.message : "无法撤销支持访问。"); } finally { setSupportBusyId(""); } };

  return <main className="admin-page">
    <header className="admin-page__header">
      <Link variant="inherit" className="brand" href="/"><span className="brand__mark">F</span><span>FastWrite</span></Link>
      <div><ThemeToggle /><Link className="admin-page__back" href="/">项目</Link></div>
    </header>
    <section className="admin-page__intro"><div><span>平台管理</span><h1>操作记录</h1></div><Button variant="secondary" icon={<Icon name={icons.refresh} />} loading={loading} onClick={() => void load()}>刷新</Button></section>
    {error ? <p className="admin-page__error" role="alert"><Icon name={icons.shield} /> {error}</p> : null}
    {health ? <section className="admin-metrics" aria-label="系统健康状态">
      <Metric icon={<Icon name={icons.organization} />} label="账号" value={health.users} />
      <Metric icon={<Icon name={icons.pulse} />} label="有效会话" value={health.activeSessions} />
      <Metric icon={<Icon name={icons.organization} />} label="团队" value={health.teams} />
      <Metric icon={<Icon name={icons.pulse} />} label="项目" value={health.projects} />
      <Metric icon={<Icon name={icons.pulse} />} label="协作文档" value={health.collaborationDocuments} />
      <Metric icon={<Icon name={icons.shield} />} label="待接受邀请" value={health.pendingInvitations} />
      {health.mail ? <Metric icon={<Icon name={icons.pulse} />} label="待发送邮件" value={health.mail.pending} /> : null}
      {health.jobs ? <Metric icon={<Icon name={icons.pulse} />} label="排队任务" value={health.jobs.queued} /> : null}
      {health.postgres ? <Metric icon={<Icon name={icons.database} />} label={health.postgres.healthy ? "Postgres 运行正常" : health.postgres.configured ? "Postgres 服务异常" : "Postgres 未启用"} value={health.postgres.failures} /> : null}
    </section> : null}
    {canManageAccounts ? <section className="admin-section"><HarnessProfileEditor scope="system"/></section> : null}
    {identityProviders ? <section className="admin-section"><header><div><h2>身份服务</h2><p>仅显示配置信息，不会显示客户端密钥和已签发令牌。</p></div></header><div className="admin-table-wrap"><Table label="身份服务" columns={["服务", "状态", "公开配置"]}><TableRow><TableCell>本地账号</TableCell><TableCell><span className="admin-status admin-status--active">已配置</span></TableCell><TableCell>已启用应急登录</TableCell></TableRow><IdentityProviderRow name="OIDC" provider={identityProviders.oidc} details={[identityProviders.oidc.issuer, identityProviders.oidc.redirectUri, identityProviders.oidc.clientId].filter(Boolean).join(" · ")} /><IdentityProviderRow name="CAS" provider={identityProviders.cas} details={[identityProviders.cas.serverUrl, identityProviders.cas.serviceUrl].filter(Boolean).join(" · ")} /></Table></div></section> : null}
    <section className="admin-section">
      <header><div><h2>账号管理</h2><p>操作会立即撤销当前访问权限，需要填写审计原因。</p></div></header>
      {canManageAccounts ? <Field label="本次操作原因" className="admin-reason"><TextField value={reason} onChange={setReason} maxLength={500} placeholder="修改账号时必填" /></Field> : null}
      <div className="admin-table-wrap"><Table label="账号管理" columns={canManageAccounts ? ["账号", "角色", "状态", "会话", "已创建", "操作"] : ["账号", "角色", "状态", "会话", "已创建"]}>{users.map((user) => <TableRow key={user.id}><TableCell><strong>{user.displayName}</strong><small>{user.emailNormalized}</small></TableCell><TableCell>{canManageAccounts ? <Select aria-label={`平台角色： ${user.emailNormalized}`} value={user.platformRole} disabled={Boolean(busyUserId)} onChange={(next) => void changeRole(user.id, next as PlatformRole)} options={[{ value: "user", label: "用户" }, { value: "support_auditor", label: "支持审计员" }, { value: "platform_admin", label: "平台管理员" }]} /> : roleLabel(user.platformRole)}</TableCell><TableCell><span className={`admin-status admin-status--${user.status}`}>{statusLabel(user.status)}</span></TableCell><TableCell>{user.activeSessionCount}</TableCell><TableCell>{date(user.createdAt)}</TableCell>{canManageAccounts ? <TableCell><div className="admin-table__actions"><Button size="small" variant="ghost" icon={<Icon name={icons.key} />} disabled={Boolean(busyUserId)} onClick={() => void act(user.id, "revoke")}>撤销会话</Button><Button size="small" variant="danger" icon={<Icon name={icons.circleSlash} />} disabled={user.status !== "active" || Boolean(busyUserId)} loading={busyUserId === user.id} onClick={() => void act(user.id, "disable")}>停用</Button></div></TableCell> : null}</TableRow>)}</Table></div>
    </section>
    {canManageAccounts ? <section className="admin-section"><header><div><h2>运维备份</h2><p>创建保留元数据的数据库备份，用于维护恢复。</p></div><Button variant="secondary" icon={<Icon name={icons.fileZip} />} onClick={() => void createBackup()}>创建备份</Button></header>{backup ? <p className="admin-status admin-status--active">已创建 {backup.path} ({backup.bytes} 字节）</p> : null}</section> : null}
    <section className="admin-section"><header><div><h2>支持访问</h2><p>访问申请限定项目范围和有效期，仅允许读取，此列表不会显示稿件内容。</p></div></header><div className="admin-table-wrap"><Table label="支持访问申请" columns={["工单", "项目", "范围", "状态", "到期时间", "操作"]}>{supportAccess.map((item) => <TableRow key={item.id}><TableCell><strong>{item.ticketId}</strong><small>{item.reason}</small></TableCell><TableCell><code>{item.projectId}</code></TableCell><TableCell><code>{item.pathPrefix || "/"}</code></TableCell><TableCell><span className={`admin-status admin-status--${item.status}`}>{statusLabel(item.status)}</span></TableCell><TableCell>{date(item.expiresAt)}</TableCell><TableCell>{item.status === "pending" && canManageAccounts ? <div className="admin-table__actions"><Button size="small" variant="secondary" loading={supportBusyId === item.id} onClick={() => void decideSupport(item, true)}>批准</Button><Button size="small" variant="ghost" disabled={Boolean(supportBusyId)} onClick={() => void decideSupport(item, false)}>拒绝</Button></div> : item.status === "approved" && canManageAccounts ? <Button size="small" variant="danger" loading={supportBusyId === item.id} onClick={() => void revokeSupport(item)}>撤销</Button> : <span className="admin-status admin-status--disabled">只读</span>}</TableCell></TableRow>)}</Table></div></section>
    <section className="admin-section"><header><div><h2>重试耗尽的任务</h2><p>这些任务已达到重试次数上限，需要平台管理员手动重试。</p></div></header><div className="admin-table-wrap"><Table label="重试耗尽的任务" columns={["任务", "类型", "尝试次数", "错误", "更新时间", "操作"]}>{deadLetters.map((job) => <TableRow key={job.id}><TableCell><code>{job.id}</code></TableCell><TableCell>{statusLabel(job.kind)}</TableCell><TableCell>{job.attempts}</TableCell><TableCell>{job.error ?? ""}</TableCell><TableCell>{date(job.updatedAt)}</TableCell><TableCell>{canManageAccounts ? <Button size="small" variant="secondary" loading={retryingJobId === job.id} disabled={Boolean(retryingJobId)} onClick={() => void retryJob(job.id)}>重试</Button> : <span className="admin-status admin-status--disabled">只读</span>}</TableCell></TableRow>)}</Table></div></section>
    <section className="admin-section"><header><div><h2>最近审计事件</h2><p>仅显示元数据，不包含论文内容和凭据。</p></div></header><div className="admin-table-wrap"><Table label="最近审计事件" columns={["时间", "操作", "资源", "操作人", "原因"]} stripped>{audits.map((audit) => <TableRow key={audit.id}><TableCell>{date(audit.createdAt)}</TableCell><TableCell>{audit.action}</TableCell><TableCell>{audit.resourceType} <code>{audit.resourceId}</code></TableCell><TableCell><code>{audit.actorUserId ?? "系统"}</code></TableCell><TableCell>{audit.metadata?.reason ?? ""}</TableCell></TableRow>)}</Table></div></section>
  </main>;
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: number }) { return <div className="admin-metric"><span>{icon}</span><strong>{value}</strong><small>{label}</small></div>; }
function IdentityProviderRow({ name, provider, details }: { name: string; provider: { configured: boolean }; details: string }) { return <TableRow><TableCell>{name}</TableCell><TableCell><span className={`admin-status admin-status--${provider.configured ? "active" : "disabled"}`}>{provider.configured ? "已配置" : "未配置"}</span></TableCell><TableCell>{details || "需要配置环境变量"}</TableCell></TableRow>; }
function date(value: string) { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" }); }
