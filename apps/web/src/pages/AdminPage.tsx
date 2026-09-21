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
      setError(failure instanceof ApiClientError && failure.status === 403 ? "Administrator access is required." : failure instanceof Error ? failure.message : "Unable to load administrator data.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const act = async (userId: string, operation: "disable" | "revoke") => {
    if (reason.trim().length < 8) { setError("Provide a reason of at least 8 characters."); return; }
    setBusyUserId(userId); setError("");
    try {
      if (operation === "disable") await api.admin.disableUser(userId, reason); else await api.admin.revokeSessions(userId, reason);
      setReason("");
      await load();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Administrator action failed."); }
    finally { setBusyUserId(""); }
  };

  const changeRole = async (userId: string, role: PlatformRole) => {
    if (reason.trim().length < 8) { setError("Provide a reason of at least 8 characters."); return; }
    setBusyUserId(userId); setError("");
    try {
      await api.admin.updatePlatformRole(userId, role, reason);
      setReason("");
      await load();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Administrator action failed."); }
    finally { setBusyUserId(""); }
  };

  const canManageAccounts = platformRole === "platform_admin";
  const retryJob = async (jobId: string) => { setRetryingJobId(jobId); setError(""); try { await api.admin.retryJob(jobId); await load(); } catch (failure) { setError(failure instanceof Error ? failure.message : "Unable to retry job."); } finally { setRetryingJobId(""); } };
  const createBackup = async () => { setError(""); try { const result = await api.admin.createBackup(); setBackup(result); } catch (failure) { setError(failure instanceof Error ? failure.message : "Backup failed."); } };
  const decideSupport = async (item: SupportAccessRequest, approved: boolean) => { setSupportBusyId(item.id); setError(""); try { const result = await api.admin.decideSupportAccess(item.id, approved); if (result.token) window.prompt("One-time support access token. Copy it now; it will not be shown again.", result.token); await load(); } catch (failure) { setError(failure instanceof Error ? failure.message : "Support access decision failed."); } finally { setSupportBusyId(""); } };
  const revokeSupport = async (item: SupportAccessRequest) => { setSupportBusyId(item.id); setError(""); try { await api.admin.revokeSupportAccess(item.id); await load(); } catch (failure) { setError(failure instanceof Error ? failure.message : "Support access revoke failed."); } finally { setSupportBusyId(""); } };

  return <main className="admin-page">
    <header className="admin-page__header">
      <Link variant="inherit" className="brand" href="/"><span className="brand__mark">F</span><span>FastWrite</span></Link>
      <div><ThemeToggle /><Link className="admin-page__back" href="/">Projects</Link></div>
    </header>
    <section className="admin-page__intro"><div><span>Platform administration</span><h1>Operations</h1></div><Button variant="secondary" icon={<Icon name={icons.refresh} />} loading={loading} onClick={() => void load()}>Refresh</Button></section>
    {error ? <p className="admin-page__error" role="alert"><Icon name={icons.shield} /> {error}</p> : null}
    {health ? <section className="admin-metrics" aria-label="System health">
      <Metric icon={<Icon name={icons.organization} />} label="Accounts" value={health.users} />
      <Metric icon={<Icon name={icons.pulse} />} label="Active sessions" value={health.activeSessions} />
      <Metric icon={<Icon name={icons.organization} />} label="Teams" value={health.teams} />
      <Metric icon={<Icon name={icons.pulse} />} label="Projects" value={health.projects} />
      <Metric icon={<Icon name={icons.pulse} />} label="Collaboration docs" value={health.collaborationDocuments} />
      <Metric icon={<Icon name={icons.shield} />} label="Pending invites" value={health.pendingInvitations} />
      {health.mail ? <Metric icon={<Icon name={icons.pulse} />} label="Pending mail" value={health.mail.pending} /> : null}
      {health.jobs ? <Metric icon={<Icon name={icons.pulse} />} label="Queued jobs" value={health.jobs.queued} /> : null}
      {health.postgres ? <Metric icon={<Icon name={icons.database} />} label={health.postgres.healthy ? "Postgres healthy" : health.postgres.configured ? "Postgres degraded" : "Postgres off"} value={health.postgres.failures} /> : null}
    </section> : null}
    {identityProviders ? <section className="admin-section"><header><div><h2>Identity providers</h2><p>Configuration metadata only. Client secrets and issued tokens are never shown here.</p></div></header><div className="admin-table-wrap"><Table label="Identity providers" columns={["Provider", "Status", "Public configuration"]}><TableRow><TableCell>Local accounts</TableCell><TableCell><span className="admin-status admin-status--active">configured</span></TableCell><TableCell>Break-glass sign-in enabled</TableCell></TableRow><IdentityProviderRow name="OIDC" provider={identityProviders.oidc} details={[identityProviders.oidc.issuer, identityProviders.oidc.redirectUri, identityProviders.oidc.clientId].filter(Boolean).join(" · ")} /><IdentityProviderRow name="CAS" provider={identityProviders.cas} details={[identityProviders.cas.serverUrl, identityProviders.cas.serviceUrl].filter(Boolean).join(" · ")} /></Table></div></section> : null}
    <section className="admin-section">
      <header><div><h2>Account controls</h2><p>Actions revoke active access immediately and require an audit reason.</p></div></header>
      {canManageAccounts ? <Field label="Reason for the next action" className="admin-reason"><TextField value={reason} onChange={setReason} maxLength={500} placeholder="Required for account changes" /></Field> : null}
      <div className="admin-table-wrap"><Table label="Account controls" columns={canManageAccounts ? ["Account", "Role", "Status", "Sessions", "Created", "Actions"] : ["Account", "Role", "Status", "Sessions", "Created"]}>{users.map((user) => <TableRow key={user.id}><TableCell><strong>{user.displayName}</strong><small>{user.emailNormalized}</small></TableCell><TableCell>{canManageAccounts ? <Select aria-label={`Platform role for ${user.emailNormalized}`} value={user.platformRole} disabled={Boolean(busyUserId)} onChange={(next) => void changeRole(user.id, next as PlatformRole)} options={[{ value: "user", label: "User" }, { value: "support_auditor", label: "Support auditor" }, { value: "platform_admin", label: "Platform admin" }]} /> : user.platformRole}</TableCell><TableCell><span className={`admin-status admin-status--${user.status}`}>{user.status}</span></TableCell><TableCell>{user.activeSessionCount}</TableCell><TableCell>{date(user.createdAt)}</TableCell>{canManageAccounts ? <TableCell><div className="admin-table__actions"><Button size="small" variant="ghost" icon={<Icon name={icons.key} />} disabled={Boolean(busyUserId)} onClick={() => void act(user.id, "revoke")}>Revoke sessions</Button><Button size="small" variant="danger" icon={<Icon name={icons.circleSlash} />} disabled={user.status !== "active" || Boolean(busyUserId)} loading={busyUserId === user.id} onClick={() => void act(user.id, "disable")}>Disable</Button></div></TableCell> : null}</TableRow>)}</Table></div>
    </section>
    {canManageAccounts ? <section className="admin-section"><header><div><h2>Operations backup</h2><p>Creates a metadata-preserving database backup for maintenance recovery.</p></div><Button variant="secondary" icon={<Icon name={icons.fileZip} />} onClick={() => void createBackup()}>Create backup</Button></header>{backup ? <p className="admin-status admin-status--active">Created {backup.path} ({backup.bytes} bytes)</p> : null}</section> : null}
    <section className="admin-section"><header><div><h2>Support access</h2><p>Requests are project-scoped, time-limited, read-only, and never expose manuscript content in this list.</p></div></header><div className="admin-table-wrap"><Table label="Support access requests" columns={["Ticket", "Project", "Scope", "Status", "Expires", "Actions"]}>{supportAccess.map((item) => <TableRow key={item.id}><TableCell><strong>{item.ticketId}</strong><small>{item.reason}</small></TableCell><TableCell><code>{item.projectId}</code></TableCell><TableCell><code>{item.pathPrefix || "/"}</code></TableCell><TableCell><span className={`admin-status admin-status--${item.status}`}>{item.status}</span></TableCell><TableCell>{date(item.expiresAt)}</TableCell><TableCell>{item.status === "pending" && canManageAccounts ? <div className="admin-table__actions"><Button size="small" variant="secondary" loading={supportBusyId === item.id} onClick={() => void decideSupport(item, true)}>Approve</Button><Button size="small" variant="ghost" disabled={Boolean(supportBusyId)} onClick={() => void decideSupport(item, false)}>Deny</Button></div> : item.status === "approved" && canManageAccounts ? <Button size="small" variant="danger" loading={supportBusyId === item.id} onClick={() => void revokeSupport(item)}>Revoke</Button> : <span className="admin-status admin-status--disabled">read-only</span>}</TableCell></TableRow>)}</Table></div></section>
    <section className="admin-section"><header><div><h2>Dead-letter jobs</h2><p>Jobs here exhausted their bounded retries and require an explicit platform-admin retry.</p></div></header><div className="admin-table-wrap"><Table label="Dead-letter jobs" columns={["Job", "Kind", "Attempts", "Error", "Updated", "Action"]}>{deadLetters.map((job) => <TableRow key={job.id}><TableCell><code>{job.id}</code></TableCell><TableCell>{job.kind}</TableCell><TableCell>{job.attempts}</TableCell><TableCell>{job.error ?? ""}</TableCell><TableCell>{date(job.updatedAt)}</TableCell><TableCell>{canManageAccounts ? <Button size="small" variant="secondary" loading={retryingJobId === job.id} disabled={Boolean(retryingJobId)} onClick={() => void retryJob(job.id)}>Retry</Button> : <span className="admin-status admin-status--disabled">read-only</span>}</TableCell></TableRow>)}</Table></div></section>
    <section className="admin-section"><header><div><h2>Recent audit events</h2><p>Metadata only. Paper content and credentials are excluded.</p></div></header><div className="admin-table-wrap"><Table label="Recent audit events" columns={["Time", "Action", "Resource", "Actor", "Reason"]} stripped>{audits.map((audit) => <TableRow key={audit.id}><TableCell>{date(audit.createdAt)}</TableCell><TableCell>{audit.action}</TableCell><TableCell>{audit.resourceType} <code>{audit.resourceId}</code></TableCell><TableCell><code>{audit.actorUserId ?? "system"}</code></TableCell><TableCell>{audit.metadata?.reason ?? ""}</TableCell></TableRow>)}</Table></div></section>
  </main>;
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: number }) { return <div className="admin-metric"><span>{icon}</span><strong>{value}</strong><small>{label}</small></div>; }
function IdentityProviderRow({ name, provider, details }: { name: string; provider: { configured: boolean }; details: string }) { return <TableRow><TableCell>{name}</TableCell><TableCell><span className={`admin-status admin-status--${provider.configured ? "active" : "disabled"}`}>{provider.configured ? "configured" : "not configured"}</span></TableCell><TableCell>{details || "Environment configuration required"}</TableCell></TableRow>; }
function date(value: string) { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); }
