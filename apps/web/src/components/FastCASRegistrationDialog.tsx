import { useEffect, useState } from "react";
import { api } from "../api/client";
import { userFacingError } from "../lib/notifications";
import { Button, Dialog, Field, TextField } from "./ui";

export function FastCASRegistrationDialog() {
  const [open, setOpen] = useState(() => new URLSearchParams(window.location.search).get("fastcas") === "register");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (!open) return;
    void api.auth.fastcasRegistration().then(profile => { setEmail(profile.email); setName(profile.displayName); }).catch(error => { setError(userFacingError(error)); setExpired(true); }).finally(() => setLoading(false));
  }, [open]);
  const close = () => { if (busy) return; setOpen(false); const url = new URL(window.location.href); url.searchParams.delete("fastcas"); window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`); };
  const invalid = loading || expired || !name.trim() || !email.trim() || password.length < 12 || password !== confirmation;
  const submit = async () => {
    setBusy(true); setError("");
    try { const result = await api.auth.fastcasRegister({ email, displayName: name, password }); window.location.assign(result.url); }
    catch (error) { setError(userFacingError(error, "无法注册并绑定")); setBusy(false); }
  };
  return <Dialog open={open} title="注册并绑定 FastWrite 账号" description="你的 FastCAS 身份已验证，尚未绑定 FastWrite 账号。请填写资料，创建账号并完成绑定。" onClose={close} footer={<><Button variant="ghost" disabled={busy} onClick={close}>取消</Button>{expired ? <Button variant="primary" onClick={() => window.location.assign("/api/auth/fastcas/login?returnTo=/panel")}>重新验证 FastCAS</Button> : <Button variant="primary" form="fastcas-registration-form" type="submit" loading={busy} disabled={invalid}>注册并绑定</Button>}</>}>
    {loading ? <p role="status">正在加载 FastCAS 身份…</p> : <form id="fastcas-registration-form" className="form-stack" onSubmit={event => { event.preventDefault(); if (!busy && !invalid) void submit(); }}>
      <Field label="名称"><TextField required autoFocus value={name} onChange={setName} maxLength={100} autoComplete="name" /></Field>
      <Field label="FastWrite 登录邮箱"><TextField required type="email" value={email} onChange={setEmail} maxLength={320} autoComplete="username" /></Field>
      <Field label="密码（至少 12 个字符）"><TextField required type="password" value={password} onChange={setPassword} maxLength={1024} autoComplete="new-password" /></Field>
      <Field label="确认密码"><TextField required type="password" value={confirmation} onChange={setConfirmation} maxLength={1024} autoComplete="new-password" /></Field>
      <p>已有 FastWrite 账号？关闭此窗口并登录，在“账号认证”中绑定 FastCAS。</p>
    </form>}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
  </Dialog>;
}
