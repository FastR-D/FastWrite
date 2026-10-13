import { useEffect, useState } from "react";
import { api } from "../api/client";
import { Button, Field, Icon, icons, Link, Select, TextArea, TextField } from "../components/ui";
import { navigate } from "../lib/navigation";

export function AccessRequestPage({ projectId }: { projectId: string }) {
  const [account, setAccount] = useState<{ displayName: string } | null>(null);
  const [project, setProject] = useState<{ id: string; name: string } | null>(null);
  const [role, setRole] = useState<"editor" | "commenter" | "viewer">("commenter");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [registering, setRegistering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!localStorage.getItem("fastwrite.session-token")) return;
    api.auth.me().then((user) => setAccount(user)).catch(() => localStorage.removeItem("fastwrite.session-token"));
  }, []);
  useEffect(() => {
    if (!account) return;
    api.projects.accessRequestInfo(projectId).then(setProject).catch((failure) => setError(failure instanceof Error ? failure.message : "无法加载此项目"));
  }, [account, projectId]);

  const authenticate = async () => {
    setBusy(true); setError("");
    try {
      const result = registering ? await api.auth.register({ email, password, ...(name.trim() ? { displayName: name.trim() } : {}) }) : await api.auth.login({ email, password });
      localStorage.setItem("fastwrite.session-token", result.token);
      setAccount(result.user);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "无法登录"); }
    finally { setBusy(false); }
  };
  const submit = async () => {
    setBusy(true); setError("");
    try { await api.projects.requestAccess(projectId, { role, ...(message.trim() ? { message: message.trim() } : {}) }); setSubmitted(true); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "无法提交访问申请"); }
    finally { setBusy(false); }
  };

 return <div className="projects-page"><header className="projects-topbar"><Link variant="inherit" className="brand" href="/projects"><span className="brand__mark">F</span><span>FastWrite</span></Link></header><main className="projects-main"><section className="projects-section access-request-page"><Button type="button" size="small" variant="ghost" icon={<Icon name={icons.arrowLeft} />} onClick={() => navigate("/projects")}>返回项目列表</Button>{!account ? <><div className="section-heading"><div><h1>{registering ? "创建账号" : "登录以申请访问"}</h1><p>使用 FastWrite 账号联系此项目的所有者。</p></div></div><form className="form-stack access-request-form" onSubmit={(event) => { event.preventDefault(); if (!busy && email.trim() && password) void authenticate(); }}>{registering ? <Field label="名称"><TextField value={name} onChange={setName} name="name" autoComplete="name" autoFocus /></Field> : null}<Field label="邮箱"><TextField type="email" name="email" autoComplete="username" value={email} onChange={setEmail} autoFocus={!registering} required /></Field><Field label="密码"><TextField type="password" name="password" autoComplete={registering ? "new-password" : "current-password"} value={password} onChange={setPassword} required /></Field><div className="access-request-actions"><Button type="button" variant="ghost" onClick={() => { setRegistering((value) => !value); setError(""); }}>{registering ? "使用已有账号" : "创建账号"}</Button><Button type="submit" variant="primary" icon={<Icon name={icons.account} />} loading={busy} disabled={!email.trim() || !password}>{registering ? "创建账号" : "登录"}</Button></div></form></> : submitted ? <div className="projects-empty"><div className="projects-empty__art"><Icon name={icons.send} /></div><h1>申请已发送</h1><p>项目所有者将收到通知，处理后你会收到站内通知。</p><Button type="button" variant="primary" onClick={() => navigate("/projects")}>返回项目列表</Button></div> : <><div className="section-heading"><div><p className="eyebrow">项目访问</p><h1>{project?.name ?? "正在加载项目…"}</h1><p>请申请工作所需的最低权限，批准访问后才能查看项目内容。</p></div></div><div className="form-stack access-request-form"><Field label="申请角色"><Select aria-label="申请角色" value={role} onChange={(next) => setRole(next as typeof role)} options={[{ value: "viewer", label: "查看者" }, { value: "commenter", label: "评论者" }, { value: "editor", label: "编辑者" }]} /></Field><Field label="给项目所有者的留言"><TextArea rows={5} maxLength={2000} value={message} onChange={setMessage} placeholder="简要说明需要访问的原因。" /></Field><Button type="button" variant="primary" icon={<Icon name={icons.send} />} loading={busy} disabled={!project} onClick={() => void submit()}>申请访问</Button></div></>}{error ? <div className="page-error" role="alert">{error}</div> : null}</section></main></div>;
}
