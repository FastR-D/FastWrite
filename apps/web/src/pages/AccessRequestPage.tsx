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
    api.projects.accessRequestInfo(projectId).then(setProject).catch((failure) => setError(failure instanceof Error ? failure.message : "Could not load this project"));
  }, [account, projectId]);

  const authenticate = async () => {
    setBusy(true); setError("");
    try {
      const result = registering ? await api.auth.register({ email, password, ...(name.trim() ? { displayName: name.trim() } : {}) }) : await api.auth.login({ email, password });
      localStorage.setItem("fastwrite.session-token", result.token);
      setAccount(result.user);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not sign in"); }
    finally { setBusy(false); }
  };
  const submit = async () => {
    setBusy(true); setError("");
    try { await api.projects.requestAccess(projectId, { role, ...(message.trim() ? { message: message.trim() } : {}) }); setSubmitted(true); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not submit access request"); }
    finally { setBusy(false); }
  };

 return <div className="projects-page"><header className="projects-topbar"><Link variant="inherit" className="brand" href="/projects"><span className="brand__mark">F</span><span>FastWrite</span></Link></header><main className="projects-main"><section className="projects-section access-request-page"><Button type="button" size="small" variant="ghost" icon={<Icon name={icons.arrowLeft} />} onClick={() => navigate("/projects")}>Back to projects</Button>{!account ? <><div className="section-heading"><div><h1>{registering ? "Create an account" : "Sign in to request access"}</h1><p>Use a FastWrite account to contact this project's owners.</p></div></div><form className="form-stack access-request-form" onSubmit={(event) => { event.preventDefault(); if (!busy && email.trim() && password) void authenticate(); }}>{registering ? <Field label="Name"><TextField value={name} onChange={setName} name="name" autoComplete="name" autoFocus /></Field> : null}<Field label="Email"><TextField type="email" name="email" autoComplete="username" value={email} onChange={setEmail} autoFocus={!registering} required /></Field><Field label="Password"><TextField type="password" name="password" autoComplete={registering ? "new-password" : "current-password"} value={password} onChange={setPassword} required /></Field><div className="access-request-actions"><Button type="button" variant="ghost" onClick={() => { setRegistering((value) => !value); setError(""); }}>{registering ? "Use existing account" : "Create account"}</Button><Button type="submit" variant="primary" icon={<Icon name={icons.account} />} loading={busy} disabled={!email.trim() || !password}>{registering ? "Create account" : "Sign in"}</Button></div></form></> : submitted ? <div className="projects-empty"><div className="projects-empty__art"><Icon name={icons.send} /></div><h1>Request sent</h1><p>The project owners will be notified. You will receive an in-app notification when they decide.</p><Button type="button" variant="primary" onClick={() => navigate("/projects")}>Return to projects</Button></div> : <><div className="section-heading"><div><p className="eyebrow">PROJECT ACCESS</p><h1>{project?.name ?? "Loading project..."}</h1><p>Request the minimum role needed for your work. Project contents are not shown until access is approved.</p></div></div><div className="form-stack access-request-form"><Field label="Requested role"><Select aria-label="Requested role" value={role} onChange={(next) => setRole(next as typeof role)} options={[{ value: "viewer", label: "Viewer" }, { value: "commenter", label: "Commenter" }, { value: "editor", label: "Editor" }]} /></Field><Field label="Message for the project owners"><TextArea rows={5} maxLength={2000} value={message} onChange={setMessage} placeholder="Briefly explain why you need access." /></Field><Button type="button" variant="primary" icon={<Icon name={icons.send} />} loading={busy} disabled={!project} onClick={() => void submit()}>Request access</Button></div></>}{error ? <div className="page-error" role="alert">{error}</div> : null}</section></main></div>;
}
