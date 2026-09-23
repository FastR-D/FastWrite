import { useEffect, useState } from "react";
import { api } from "../api/client";
import { Button, Dialog, Field, TextField } from "./ui";

export function FastCASDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.auth.fastcasStatus>>>();
  const [providers, setProviders] = useState<Awaited<ReturnType<typeof api.auth.providers>>>();
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setPassword(""); setNewPassword(""); setError(""); void api.auth.fastcasStatus().then(setStatus).catch(error => setError(error.message)); void api.auth.providers().then(setProviders).catch(() => {}); } }, [open]);
  const current = status?.links.find(link => link.state !== "revoked");
  const proof = status?.proof;
  const canChange = proof?.method === "password" ? Boolean(password) : proof?.method === "external" && proof.recent;
  async function act(operation: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await operation(); setStatus(await api.auth.fastcasStatus()); setPassword(""); setNewPassword(""); }
    catch (error) { setError(error instanceof Error ? error.message : "Unable to update authentication"); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onClose={onClose} title="FastCAS authentication" description="Keep your FastWrite account and projects. FastCAS adds an optional sign-in method.">
    <div className="form-stack">
      {!status ? <p>Loading account status…</p> : !status.enabled ? <p>FastCAS is not configured. Your FastWrite login remains available.</p> : <>
        <p>{current?.state === "active" ? "This account is authenticated with FastCAS." : current ? "Authentication is pending. Check its status to complete it." : "This account is not authenticated with FastCAS."}</p>
        <p>Identity service: {status.issuer}</p>
        {current?.state === "prepared" ? <Button loading={busy} onClick={() => void act(() => api.auth.fastcasReconcile(current.id))}>Check pending authentication</Button> : null}
        {proof?.method === "password" ? <Field label="Confirm your FastWrite password"><TextField type="password" autoComplete="current-password" value={password} onChange={setPassword} /></Field> : null}
        {proof?.method === "password" && proof.localLoginId ? <p>Local sign-in ID: <strong>{proof.localLoginId}</strong>. Keep this ID and your password for sign-in if FastCAS is unavailable.</p> : null}
        {proof?.method === "external" ? <p>{proof.recent ? "Your recent organization or campus sign-in proves this existing account for the next five minutes." : "Sign in again with your original organization or campus account, then return here within five minutes."}</p> : null}
        {proof?.method === "external" && !proof.recent && providers?.oidc ? <Button variant="secondary" onClick={() => window.location.assign("/api/auth/oidc/login?returnTo=/projects")}>Sign in again with organization</Button> : null}
        {proof?.method === "external" && !proof.recent && providers?.cas ? <Button variant="secondary" onClick={() => window.location.assign("/api/auth/cas/login")}>Sign in again with campus CAS</Button> : null}
        {proof?.method === "none" && current?.state === "active" ? <>
          <p>{proof.recent ? "Add a local password while this FastCAS sign-in is recent. Your projects and account ID will stay the same." : "Sign in with FastCAS again, then return within five minutes to add a local password."}</p>
          {!proof.recent ? <Button variant="secondary" onClick={() => window.location.assign("/api/auth/fastcas/login?returnTo=/projects")}>Sign in again with FastCAS</Button> : <>
            <Field label="New FastWrite password"><TextField type="password" autoComplete="new-password" value={newPassword} onChange={setNewPassword} /></Field>
            <Button variant="secondary" disabled={newPassword.length < 12 || busy} loading={busy} onClick={() => void act(() => api.auth.fastcasSetLocalPassword(newPassword))}>Add local sign-in method</Button>
          </>}
        </> : null}
        {proof?.method === "none" && !current ? <p>There is no active FastCAS authentication to recover.</p> : null}
        {current ? <Button disabled={!canChange || busy} loading={busy} onClick={() => void act(() => api.auth.fastcasRevoke(current.id, password))}>Remove FastCAS authentication</Button> : <Button variant="primary" disabled={!canChange || busy} loading={busy} onClick={() => void act(async () => { const result = await api.auth.fastcasLink(password); window.location.assign(result.url); })}>Authenticate this account with FastCAS</Button>}
        <p>Removing authentication ends FastCAS sessions for this account. Your projects and other sign-in methods remain available.</p>
      </>}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  </Dialog>;
}
