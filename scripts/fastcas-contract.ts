import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../apps/server/src/app";
import type { IdentityProvider } from "../apps/server/src/auth/identity-provider";
const issuer = process.env.FASTCAS_CONTRACT_ISSUER!;
assert.ok(issuer);
const backchannelOrigin = process.env.FASTCAS_CONTRACT_BACKCHANNEL_ORIGIN!;
assert.ok(backchannelOrigin);
const jar = new Map();
async function browser(url: string | URL, form?: Record<string, string>) {
  const response = await fetch(url, { redirect: "manual", method: form ? "POST" : "GET", headers: { cookie: [...jar].map(([key, value]) => `${key}=${value}`).join("; "), ...(form ? { "content-type": "application/x-www-form-urlencoded", origin: issuer } : {}) }, body: form ? new URLSearchParams(form) : undefined });
  for (const cookie of response.headers.getSetCookie()) { const [entry] = cookie.split(";"); const at = entry!.indexOf("="); jar.set(entry!.slice(0, at), entry!.slice(at + 1)); }
  return response;
}
async function complete(url: string | URL, email = "alice@example.test") {
  let response = await browser(url);
  assert.equal(response.status, 302);
  let login = new URL(response.headers.get("location")!, issuer);
  let body = await (await browser(login)).text();
  const request = login.searchParams.get("auth_request_id");
  if (body.includes('name="password"')) {
    const csrf = body.match(/name="csrf" value="([^"]+)"/)![1]!;
    response = await browser(issuer + "/login", { csrf, auth_request_id: request, email, password: "correct horse battery staple", action: "login" });
    assert.equal(response.status, 303);
    body = await (await browser(new URL(response.headers.get("location")!, issuer))).text();
  }
  const csrf = body.match(/name="csrf" value="([^"]+)"/)![1]!;
  response = await browser(issuer + "/login", { csrf, auth_request_id: request, action: "approve" });
  assert.equal(response.status, 303);
  response = await browser(new URL(response.headers.get("location")!, issuer));
  assert.equal(response.status, 302);
  return new URL(response.headers.get("location")!);
}
const directory = await mkdtemp(join(tmpdir(), "fastwrite-fastcas-contract-"));
const statusDone = Symbol("status contract complete");
let receiver: ReturnType<typeof Bun.serve> | undefined;
try {
  let loseActivationResponse = false;
  let providerUnavailable = false;
  const legacyOIDC: IdentityProvider = {
    beginLogin: async () => ({ kind: "redirect", url: "https://original-idp.example.test/authorize?state=legacy", binding: "legacy" }),
    finishLogin: async () => ({ issuer: "https://original-idp.example.test", subject: "legacy-user-42", email: "alice@example.test", displayName: "Legacy Alice", groups: [], emailVerified: true }),
    loginReturnTo: () => "/projects",
    logout: async () => {}
  };
  const app = await createApplication(directory, { features: { serverAuth: true }, oidcProvider: legacyOIDC, fastcasConfiguration: { issuer, clientId: "write", clientSecret: "integration-client-secret-32-characters-long", redirectUri: "http://127.0.0.1:3003/api/auth/fastcas/callback", allowLoopbackHTTP: true, allowRegistration: true, fetch: async (url, init) => {
    if (providerUnavailable) throw new Error("FastCAS deliberately unavailable during local login");
    const response = await fetch(url, init);
    if (loseActivationResponse && String(url).endsWith("/activate")) { loseActivationResponse = false; throw new Error("simulated lost activation response"); }
    return response;
  } } });
  const backchannel = new URL(backchannelOrigin);
  receiver = Bun.serve({ hostname: backchannel.hostname, port: Number(backchannel.port), fetch: app });
  const origin = "http://127.0.0.1:3003";
  const cookies = new Map<string, string>();
  let token = "";
  async function request(path: string, body?: unknown, extra: Record<string,string> = {}) {
    const response = await app(new Request(origin + path, { method: body === undefined ? "GET" : "POST", headers: { origin, "content-type": "application/json", authorization: `Bearer ${token}`, cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join("; "), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    for (const value of response.headers.getSetCookie()) { const entry = value.split(";")[0]!; const at = entry.indexOf("="); cookies.set(entry.slice(0,at),entry.slice(at+1)); }
    return response;
  }
  const password = "local-password-contract-32-characters";
  const registered = await request("/api/auth/register", { email: "alice@example.test", password, displayName: "Local Alice" });
  assert.equal(registered.status,201);
  const local = await registered.json(); token=local.token;
  const localRefresh = cookies.get("fastwrite.refresh")!;
  const created = await request("/api/projects", { name: "Original research project" });
  assert.equal(created.status,201);
  const project = await created.json();
  assert.equal((await request("/api/auth/fastcas/link", { password }, { origin: "https://attacker.test" })).status,403);
  assert.equal((await request("/api/auth/fastcas/link", { password: "wrong" })).status,401);
  const beginning = await request("/api/auth/fastcas/link", { password });
  assert.equal(beginning.status,200);
  const callback = await complete((await beginning.json()).url);
  // A changed local browser session cannot bind the original local account.
  cookies.set("fastwrite.refresh", "different-session");
  assert.equal((await request(callback.pathname+callback.search)).status,401);
  cookies.set("fastwrite.refresh",localRefresh);
  assert.equal((await request(callback.pathname+callback.search)).status,302);
  assert.equal((await request(callback.pathname+callback.search)).status,401);
  const state = await (await request("/api/auth/fastcas/status")).json();
  assert.equal(state.links.length,1); assert.equal(state.links[0].state,"active");
  assert.equal((await (await request("/api/auth/me")).json()).id,local.user.id);
  const login = await request("/api/auth/fastcas/login");
  const loginCallback = await complete(login.headers.get("location")!);
  assert.equal((await request(loginCallback.pathname+loginCallback.search)).status,302);
  const refreshed = await request("/api/auth/refresh", {});
  assert.equal(refreshed.status,200);
  const cas = await refreshed.json(); token=cas.token;
  assert.equal(cas.user.id,local.user.id);
  assert.equal(cas.user.platformRole,local.user.platformRole);
  assert.equal((await request(`/api/projects/${project.id}`)).status,200);
  const grantResponse = await request("/api/collaboration/tokens", { projectId: project.id, path: "main.tex" });
  assert.equal(grantResponse.status,200);
  const grant = await grantResponse.json();
  assert.equal((await request(`/api/collaboration/room-access?token=${encodeURIComponent(grant.token)}`)).status,200);
  if (process.env.FASTCAS_CONTRACT_STATUS_SIGNAL) {
    await writeFile(process.env.FASTCAS_CONTRACT_STATUS_SIGNAL,"ready");
    const deadline = Date.now()+8000;
    while(Date.now()<deadline && (await request("/api/auth/me")).status!==401) await Bun.sleep(50);
    assert.equal((await request("/api/auth/me")).status,401);
    token=local.token; cookies.set("fastwrite.refresh",localRefresh);
    assert.equal((await request("/api/auth/me")).status,200);
    assert.equal((await request(`/api/projects/${project.id}`)).status,200);
    const ackSignal=process.env.FASTCAS_CONTRACT_STATUS_ACK_SIGNAL;
    if(ackSignal){
      const ackDeadline=Date.now()+30000;
      while(Date.now()<ackDeadline && !(await Bun.file(ackSignal).exists())) await Bun.sleep(50);
      assert.equal(await Bun.file(ackSignal).exists(),true,"FastCAS did not acknowledge status event delivery");
    }
    console.log("FastWrite identity status contract passed: signed event revoked CAS session, local session preserved");
    throw statusDone;
  }
  const providerMe = await (await browser(issuer + "/api/v1/me")).json() as {csrf:string};
  const signedOut = await fetch(issuer + "/api/v1/me/logout-all", { method:"POST", headers:{ origin:issuer, "content-type":"application/json", "X-CSRF-Token":providerMe.csrf, cookie:[...jar].map(([key,value])=>`${key}=${value}`).join("; ") }, body:"{}" });
  assert.equal(signedOut.status,204);
  const deadline = Date.now()+5000;
  while(Date.now()<deadline && (await request("/api/auth/me")).status!==401) await Bun.sleep(50);
  assert.equal((await request("/api/auth/me")).status,401);
  assert.equal((await request(`/api/collaboration/room-access?token=${encodeURIComponent(grant.token)}`)).status,401);
  // A local session unlinks without terminating itself or changing ownership.
  token=local.token; cookies.set("fastwrite.refresh",localRefresh);
  assert.equal((await request(`/api/auth/fastcas/links/${state.links[0].id}/revoke`, { password })).status,200);
  assert.equal((await request("/api/auth/me")).status,200);
  token=cas.token;
  assert.equal((await request("/api/auth/me")).status,401);
  assert.equal((await request(`/api/collaboration/room-access?token=${encodeURIComponent(grant.token)}`)).status,401);
  const fresh = await request("/api/auth/login", { email:"alice@example.test", password });
  assert.equal(fresh.status,200); const again=await fresh.json();token=again.token;
  assert.equal(again.user.id,local.user.id);
  assert.equal((await request(`/api/projects/${project.id}`)).status,200);
  // A legacy OIDC account with no FastWrite password proves account control by
  // signing in through its original provider. The same email never merges IDs.
  const oldStart = await request("/api/auth/oidc/login");
  assert.equal(oldStart.status,302);
  const oldCallback = await request("/api/auth/oidc/callback?code=legacy-code&state=legacy");
  assert.equal(oldCallback.status,302);
  const oldSession = await (await request("/api/auth/refresh",{})).json();
  token=oldSession.token;
  assert.notEqual(oldSession.user.id,local.user.id);
  const oldProject = await (await request("/api/projects",{name:"Legacy project stays here"})).json();
  const oldStatus = await (await request("/api/auth/fastcas/status")).json();
  assert.deepEqual(oldStatus.proof,{method:"external",recent:true});
  assert.equal((await request("/api/auth/fastcas/link",{password:"incorrect"})).status,401);
  const oldLink = await request("/api/auth/fastcas/link",{password:""});
  assert.equal(oldLink.status,200);
  const oldLinkCallback = await complete((await oldLink.json()).url);
  assert.equal((await request(oldLinkCallback.pathname+oldLinkCallback.search)).status,302);
  const linkedOld = await (await request("/api/auth/fastcas/status")).json();
  assert.equal(linkedOld.links[0].state,"active");
  const originalToken=token;
  const oldCasStart=await request("/api/auth/fastcas/login");
  const oldCasCallback=await complete(oldCasStart.headers.get("location")!);
  assert.equal((await request(oldCasCallback.pathname+oldCasCallback.search)).status,302);
  const oldCasSession=await (await request("/api/auth/refresh",{})).json();
  token=oldCasSession.token;
  assert.equal(oldCasSession.user.id,oldSession.user.id);
  assert.equal((await request(`/api/projects/${oldProject.id}`)).status,200);
  assert.equal((await request(`/api/projects/${project.id}`)).status,403);
  token=originalToken;
  assert.equal((await request(`/api/auth/fastcas/links/${linkedOld.links[0].id}/revoke`,{password:""})).status,200);
  assert.equal((await request("/api/auth/me")).status,200);
  token=oldCasSession.token;
  assert.equal((await request("/api/auth/me")).status,401);
  console.log("FastWrite legacy OIDC account linked and unlinked through recent original-provider proof without changing either same-email account");
  const sameEmail = await (await request("/api/auth/register", { email:"new@example.test", password })).json();
  jar.clear(); token=""; cookies.clear();
  const signup = await request("/api/auth/fastcas/signup");
  assert.equal(signup.status,302);
  const signupCallback = await complete(signup.headers.get("location")!, "new@example.test");
  assert.equal((await request(signupCallback.pathname+signupCallback.search)).status,302);
  const newSession = await (await request("/api/auth/refresh", {})).json();
  token=newSession.token;
  assert.equal(newSession.user.platformRole,"user");
  assert.notEqual(newSession.user.id,sameEmail.user.id);
  assert.notEqual(newSession.user.id,local.user.id);
  assert.equal((await request(`/api/projects/${project.id}`)).status,403);
  assert.equal((await request("/api/teams")).status,200);
  const newStatus=await (await request("/api/auth/fastcas/status")).json();
  assert.equal(newStatus.links[0].state,"active");
  // With no local password, removing the only sign-in method is refused.
  assert.equal((await request(`/api/auth/fastcas/links/${newStatus.links[0].id}/revoke`, {password})).status,409);
  assert.deepEqual(newStatus.proof,{method:"none",recent:true});
  assert.equal((await request("/api/auth/fastcas/local-password",{password:"new-fastwrite-password-32-characters"},{origin:"https://attacker.test"})).status,403);
  const setPassword=await request("/api/auth/fastcas/local-password",{password:"new-fastwrite-password-32-characters"});
  assert.equal(setPassword.status,200);
  const localLoginId=(await setPassword.json()).loginId as string;
  assert.notEqual(localLoginId,"new@example.test"); // The existing local user owns that login address.
  const recoveredStatus=await (await request("/api/auth/fastcas/status")).json();
  assert.equal(recoveredStatus.proof.localLoginId,localLoginId);
  assert.equal(recoveredStatus.proof.method,"password");
  assert.equal((await request(`/api/auth/fastcas/links/${newStatus.links[0].id}/revoke`,{password:"new-fastwrite-password-32-characters"})).status,200);
  assert.equal((await request("/api/auth/me")).status,401);
  providerUnavailable=true;
  const recoveredLogin=await (await request("/api/auth/login",{email:localLoginId,password:"new-fastwrite-password-32-characters"})).json();
  providerUnavailable=false;
  assert.equal(recoveredLogin.user.id,newSession.user.id);
  token=recoveredLogin.token;
  assert.equal((await request(`/api/projects/${project.id}`)).status,403);
  assert.equal((await (await request("/api/auth/login",{email:"new@example.test",password})).json()).user.id,sameEmail.user.id);
  console.log("FastWrite FastCAS-only signup gained a local password and kept its account after unlinking");
  jar.clear(); token=""; cookies.clear();
  const interrupted=await request("/api/auth/fastcas/signup");
  const interruptedCallback=await complete(interrupted.headers.get("location")!,"interrupted@example.test");
  loseActivationResponse=true;
  assert.equal((await request(interruptedCallback.pathname+interruptedCallback.search)).status,500);
  const resume=await request("/api/auth/fastcas/login");
  const resumedCallback=await complete(resume.headers.get("location")!);
  assert.equal((await request(resumedCallback.pathname+resumedCallback.search)).status,302);
  const resumed=await (await request("/api/auth/refresh",{})).json();token=resumed.token;
  assert.equal(resumed.user.platformRole,"user");
  assert.equal((await (await request("/api/auth/fastcas/status")).json()).links[0].state,"active");
  console.log("FastWrite real-provider linking, signup, interrupted activation recovery, CAS login, signed global logout, revocation and local ACL contract passed");
} catch(error) { if(error!==statusDone) throw error; }
finally { receiver?.stop(true); await rm(directory,{recursive:true,force:true}); }
