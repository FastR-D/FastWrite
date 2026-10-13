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
    catch (error) { setError(error instanceof Error ? error.message : "无法更新认证信息"); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onClose={onClose} title="FastCAS 认证" description="保留现有 FastWrite 账号和项目，FastCAS 提供额外的登录方式。">
    <div className="form-stack">
      {!status ? <p>正在加载账号状态…</p> : !status.enabled ? <p>尚未配置 FastCAS，仍可使用 FastWrite 账号登录。</p> : <>
        <p>{current?.state === "active" ? "此账号已通过 FastCAS 认证。" : current ? "认证尚未完成，请检查状态以完成认证。" : "此账号尚未通过 FastCAS 认证。"}</p>
        <p>身份服务： {status.issuer}</p>
        {current?.state === "prepared" ? <Button loading={busy} onClick={() => void act(() => api.auth.fastcasReconcile(current.id))}>检查待完成的认证</Button> : null}
        {proof?.method === "password" ? <Field label="确认 FastWrite 密码"><TextField type="password" autoComplete="current-password" value={password} onChange={setPassword} /></Field> : null}
        {proof?.method === "password" && proof.localLoginId ? <p>本地登录账号： <strong>{proof.localLoginId}</strong>。请保存此账号和密码，以便在 FastCAS 不可用时登录。</p> : null}
        {proof?.method === "external" ? <p>{proof.recent ? "最近的机构或校园登录可用于确认此账号身份，有效期为五分钟。" : "请使用原机构或校园账号重新登录，并在五分钟内返回此页面。"}</p> : null}
        {proof?.method === "external" && !proof.recent && providers?.oidc ? <Button variant="secondary" onClick={() => window.location.assign("/api/auth/oidc/login?returnTo=/projects")}>重新使用机构账号登录</Button> : null}
        {proof?.method === "external" && !proof.recent && providers?.cas ? <Button variant="secondary" onClick={() => window.location.assign("/api/auth/cas/login")}>重新使用校园 CAS 登录</Button> : null}
        {proof?.method === "none" && current?.state === "active" ? <>
          <p>{proof.recent ? "请在本次 FastCAS 登录仍有效时添加本地密码，项目和账号 ID 将保持不变。" : "请重新使用 FastCAS 登录，并在五分钟内返回此页面添加本地密码。"}</p>
          {!proof.recent ? <Button variant="secondary" onClick={() => window.location.assign("/api/auth/fastcas/login?returnTo=/projects")}>重新使用 FastCAS 登录</Button> : <>
            <Field label="新的 FastWrite 密码"><TextField type="password" autoComplete="new-password" value={newPassword} onChange={setNewPassword} /></Field>
            <Button variant="secondary" disabled={newPassword.length < 12 || busy} loading={busy} onClick={() => void act(() => api.auth.fastcasSetLocalPassword(newPassword))}>添加本地登录方式</Button>
          </>}
        </> : null}
        {proof?.method === "none" && !current ? <p>没有可恢复的有效 FastCAS 认证。</p> : null}
        {current ? <Button disabled={!canChange || busy} loading={busy} onClick={() => void act(() => api.auth.fastcasRevoke(current.id, password))}>移除 FastCAS 认证</Button> : <Button variant="primary" disabled={!canChange || busy} loading={busy} onClick={() => void act(async () => { const result = await api.auth.fastcasLink(password); window.location.assign(result.url); })}>使用 FastCAS 认证此账号</Button>}
        <p>移除认证将结束此账号的 FastCAS 会话，项目和其他登录方式仍可使用。</p>
      </>}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  </Dialog>;
}
