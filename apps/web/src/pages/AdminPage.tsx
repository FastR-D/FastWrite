import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Activity, Ban, KeyRound, RefreshCw, ShieldAlert, Users } from "lucide-react";
import { api, ApiClientError } from "../api/client";
import { Button } from "../components/ui/Button";
import { ThemeToggle } from "../components/ui/ThemeToggle";

type User = { id: string; emailNormalized: string; displayName: string; platformRole: string; status: string; createdAt: string; activeSessionCount: number };
type Audit = { id: string; actorUserId?: string; action: string; resourceType: string; resourceId: string; metadata?: Record<string, string>; createdAt: string };
type Health = { users: number; activeSessions: number; teams: number; projects: number; collaborationDocuments: number; pendingInvitations: number };
type PlatformRole = "platform_admin" | "support_auditor" | "user";
type IdentityProviders = { oidc: { configured: boolean; issuer?: string; redirectUri?: string; clientId?: string }; cas: { configured: boolean; serverUrl?: string; serviceUrl?: string }; local: { configured: boolean } };

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

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [nextHealth, nextUsers, nextAudits, nextIdentityProviders, currentUser] = await Promise.all([api.admin.health(), api.admin.users(), api.admin.audits(100), api.admin.identityProviders(), api.auth.me()]);
      setHealth(nextHealth); setUsers(nextUsers); setAudits(nextAudits);
      setIdentityProviders(nextIdentityProviders);
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

  return <main className="admin-page">
    <header className="admin-page__header">
      <a className="brand" href="/"><span className="brand__mark">F</span><span>FastWrite</span></a>
      <div><ThemeToggle /><a className="admin-page__back" href="/">Projects</a></div>
    </header>
    <section className="admin-page__intro"><div><span>Platform administration</span><h1>Operations</h1></div><Button variant="secondary" icon={<RefreshCw />} loading={loading} onClick={() => void load()}>Refresh</Button></section>
    {error ? <p className="admin-page__error" role="alert"><ShieldAlert /> {error}</p> : null}
    {health ? <section className="admin-metrics" aria-label="System health">
      <Metric icon={<Users />} label="Accounts" value={health.users} />
      <Metric icon={<Activity />} label="Active sessions" value={health.activeSessions} />
      <Metric icon={<Users />} label="Teams" value={health.teams} />
      <Metric icon={<Activity />} label="Projects" value={health.projects} />
      <Metric icon={<Activity />} label="Collaboration docs" value={health.collaborationDocuments} />
      <Metric icon={<ShieldAlert />} label="Pending invites" value={health.pendingInvitations} />
    </section> : null}
    {identityProviders ? <section className="admin-section"><header><div><h2>Identity providers</h2><p>Configuration metadata only. Client secrets and issued tokens are never shown here.</p></div></header><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Provider</th><th>Status</th><th>Public configuration</th></tr></thead><tbody><tr><td>Local accounts</td><td><span className="admin-status admin-status--active">configured</span></td><td>Break-glass sign-in enabled</td></tr><IdentityProviderRow name="OIDC" provider={identityProviders.oidc} details={[identityProviders.oidc.issuer, identityProviders.oidc.redirectUri, identityProviders.oidc.clientId].filter(Boolean).join(" · ")} /><IdentityProviderRow name="CAS" provider={identityProviders.cas} details={[identityProviders.cas.serverUrl, identityProviders.cas.serviceUrl].filter(Boolean).join(" · ")} /></tbody></table></div></section> : null}
    <section className="admin-section">
      <header><div><h2>Account controls</h2><p>Actions revoke active access immediately and require an audit reason.</p></div></header>
      {canManageAccounts ? <label className="field admin-reason"><span>Reason for the next action</span><input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} placeholder="Required for account changes" /></label> : null}
      <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Account</th><th>Role</th><th>Status</th><th>Sessions</th><th>Created</th>{canManageAccounts ? <th>Actions</th> : null}</tr></thead><tbody>{users.map((user) => <tr key={user.id}><td><strong>{user.displayName}</strong><small>{user.emailNormalized}</small></td><td>{canManageAccounts ? <select aria-label={`Platform role for ${user.emailNormalized}`} value={user.platformRole} disabled={Boolean(busyUserId)} onChange={(event) => void changeRole(user.id, event.target.value as PlatformRole)}><option value="user">User</option><option value="support_auditor">Support auditor</option><option value="platform_admin">Platform admin</option></select> : user.platformRole}</td><td><span className={`admin-status admin-status--${user.status}`}>{user.status}</span></td><td>{user.activeSessionCount}</td><td>{date(user.createdAt)}</td>{canManageAccounts ? <td><div className="admin-table__actions"><Button size="small" variant="ghost" icon={<KeyRound />} disabled={Boolean(busyUserId)} onClick={() => void act(user.id, "revoke")}>Revoke sessions</Button><Button size="small" variant="danger" icon={<Ban />} disabled={user.status !== "active" || Boolean(busyUserId)} loading={busyUserId === user.id} onClick={() => void act(user.id, "disable")}>Disable</Button></div></td> : null}</tr>)}</tbody></table></div>
    </section>
    <section className="admin-section"><header><div><h2>Recent audit events</h2><p>Metadata only. Paper content and credentials are excluded.</p></div></header><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Time</th><th>Action</th><th>Resource</th><th>Actor</th><th>Reason</th></tr></thead><tbody>{audits.map((audit) => <tr key={audit.id}><td>{date(audit.createdAt)}</td><td>{audit.action}</td><td>{audit.resourceType} <code>{audit.resourceId}</code></td><td><code>{audit.actorUserId ?? "system"}</code></td><td>{audit.metadata?.reason ?? ""}</td></tr>)}</tbody></table></div></section>
  </main>;
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: number }) { return <div className="admin-metric"><span>{icon}</span><strong>{value}</strong><small>{label}</small></div>; }
function IdentityProviderRow({ name, provider, details }: { name: string; provider: { configured: boolean }; details: string }) { return <tr><td>{name}</td><td><span className={`admin-status admin-status--${provider.configured ? "active" : "disabled"}`}>{provider.configured ? "configured" : "not configured"}</span></td><td>{details || "Environment configuration required"}</td></tr>; }
function date(value: string) { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); }
