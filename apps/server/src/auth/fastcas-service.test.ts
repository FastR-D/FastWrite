import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonDatabase } from "../storage/database";
import { AuthService } from "./auth-service";
import { FastCASService, FastCASTransactions } from "./fastcas-service";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() { const path=await mkdtemp(join(tmpdir(),"fastwrite-cas-"));directories.push(path);const database=new JsonDatabase(path);await database.initialize();return {path,database}; }

test("persistent callback transaction survives restart and is consumed once", async () => {
  const {path,database}=await fixture();
  await new FastCASTransactions(database).put({state:"single-use",nonce:"nonce",verifier:"verifier",bindingHash:"browser",purpose:"login",returnTo:"/projects",expiresAt:Date.now()+300_000});
  const restarted=new JsonDatabase(path);await restarted.initialize();
  const store=new FastCASTransactions(restarted);
  const results=await Promise.all(Array.from({length:20},()=>store.take("single-use")));
  expect(results.filter(Boolean)).toHaveLength(1);
  const again=new JsonDatabase(path);await again.initialize();
  expect(await new FastCASTransactions(again).take("single-use")).toBeUndefined();
});

test("failed mutation cannot roll back a concurrent successful transaction", async () => {
  const {database}=await fixture();
  const outcomes=await Promise.allSettled([
    database.mutate(state=>{state.fastcasEvents.push({id:"failed",issuer:"cas",processedAt:new Date().toISOString()});throw Error("rollback");}),
    database.mutate(state=>{state.fastcasEvents.push({id:"committed",issuer:"cas",processedAt:new Date().toISOString()});})
  ]);
  expect(outcomes[0]!.status).toBe("rejected");expect(outcomes[1]!.status).toBe("fulfilled");
  expect(database.snapshot().fastcasEvents.map(event=>event.id)).toEqual(["committed"]);
});

test("first external user is ordinary and matching email does not merge local accounts", async () => {
  const {database}=await fixture();const auth=new AuthService(database);
  const external=await auth.loginExternal({issuer:"https://cas.test",subject:"external",email:"same@example.test",emailVerified:true,groups:[],displayName:"External"});
  expect(external.user.platformRole).toBe("user");
  const local=await auth.register({email:"same@example.test",password:"local-password-at-least-12"});
  expect(local.user.id).not.toBe(external.user.id);
  expect((await auth.login({email:"same@example.test",password:"local-password-at-least-12"})).user.id).toBe(local.user.id);
});

test("passwordless OIDC/CAS account may prove control only through a recent original-provider session", async () => {
  const {database}=await fixture(); const auth=new AuthService(database);
  const external=await auth.loginExternal({issuer:"https://original-idp.test",subject:"stable-42",email:"legacy@example.test",emailVerified:true,groups:[],displayName:"Legacy"});
  let principal=auth.principal(new Request("https://write.test",{headers:{authorization:`Bearer ${external.token}`}}))!;
  expect(auth.fastCASProofStatus(principal)).toEqual({method:"external",recent:true});
  await auth.proveFastCASAccount(principal, "");
  await expect(auth.proveFastCASAccount(principal, "invented-password")).rejects.toMatchObject({code:"external_reauthentication_required"});

  await database.mutate(state=>{ const item=state.sessions.find(item=>item.id===principal.sessionId)!; item.authenticatedAt=new Date(Date.now()-6*60_000).toISOString(); });
  const refreshed=await auth.refresh(new Request("https://write.test",{headers:{cookie:`fastwrite.refresh=${external.refreshToken}`}}));
  principal=auth.principal(new Request("https://write.test",{headers:{authorization:`Bearer ${refreshed.token}`}}))!;
  expect(auth.fastCASProofStatus(principal)).toEqual({method:"external",recent:false});
  await expect(auth.proveFastCASAccount(principal, "")).rejects.toMatchObject({code:"external_reauthentication_required"});
  const reauthenticated=await auth.loginExternal({issuer:"https://original-idp.test",subject:"stable-42",email:"legacy@example.test",emailVerified:true,groups:[],displayName:"Legacy"});
  expect(reauthenticated.user.id).toBe(external.user.id);
  principal=auth.principal(new Request("https://write.test",{headers:{authorization:`Bearer ${reauthenticated.token}`}}))!;
  await auth.proveFastCASAccount(principal, "");
});

test("recent external session cannot bypass an existing local password", async () => {
  const {database}=await fixture(); const auth=new AuthService(database);
  const external=await auth.loginExternal({issuer:"https://original-idp.test",subject:"stable-43",email:"another@example.test",emailVerified:true,groups:[],displayName:"Legacy"});
  const principal=auth.principal(new Request("https://write.test",{headers:{authorization:`Bearer ${external.token}`}}))!;
  const passwordHash=await Bun.password.hash("local-password-at-least-12",{algorithm:"argon2id"});
  await database.mutate(state=>{state.localCredentials.push({userId:external.user.id,passwordHash});});
  expect(auth.fastCASProofStatus(principal).method).toBe("password");
  await expect(auth.proveFastCASAccount(principal, "")).rejects.toMatchObject({code:"local_proof_required"});
  await auth.proveFastCASAccount(principal,"local-password-at-least-12");
});

test("recent FastCAS-only session adds a local password without merging an occupied email or changing user ID", async () => {
  const {database}=await fixture(); const auth=new AuthService(database);
  const occupied=await auth.register({email:"same@example.test",password:"occupied-password-at-least-12"});
  const now=new Date().toISOString(); const userId="user_cas_only";
  const link={id:"link-cas-only",client_id:"write",local_account_ref:userId,subject:"cas-subject",state:"active" as const,version:2,verified_at:now};
  await database.mutate(state=>{
    state.users.push({id:userId,emailNormalized:"same@example.test",displayName:"CAS user",platformRole:"user",status:"active",authzVersion:1,createdAt:now,updatedAt:now});
    state.fastcasLinks.push({issuer:"https://cas.test",userId,link});
  });
  const signedIn=await auth.loginFastCAS({issuer:"https://cas.test",subject:"cas-subject",email:"same@example.test",emailVerified:true},link);
  const principal=auth.principal(new Request("https://write.test",{headers:{authorization:`Bearer ${signedIn.token}`}}))!;
  expect(auth.fastCASProofStatus(principal)).toEqual({method:"none",recent:true});
  const result=await auth.setLocalPasswordFromFastCAS(principal,"https://cas.test","new-local-password-at-least-12");
  expect(result.loginId).toMatch(/^local-[a-f0-9]{32}@fastwrite\.invalid$/);
  expect((await auth.login({email:result.loginId,password:"new-local-password-at-least-12"})).user.id).toBe(userId);
  expect((await auth.login({email:"same@example.test",password:"occupied-password-at-least-12"})).user.id).toBe(occupied.user.id);
  expect(auth.fastCASProofStatus(principal)).toEqual({method:"password",recent:false,localLoginId:result.loginId});
  await expect(auth.setLocalPasswordFromFastCAS(principal,"https://cas.test","another-local-password-12")).rejects.toMatchObject({code:"local_login_exists"});
});

test("local password recovery rejects stale or revoked FastCAS proof", async () => {
  const {database}=await fixture(); const auth=new AuthService(database);
  const now=new Date().toISOString(); const userId="user_recovery";
  const link={id:"link-recovery",client_id:"write",local_account_ref:userId,subject:"cas-recovery",state:"active" as const,version:1,verified_at:now};
  await database.mutate(state=>{
    state.users.push({id:userId,emailNormalized:"recovery@example.test",displayName:"Recovery",platformRole:"user",status:"active",authzVersion:1,createdAt:now,updatedAt:now});
    state.fastcasLinks.push({issuer:"https://cas.test",userId,link});
  });
  const signedIn=await auth.loginFastCAS({issuer:"https://cas.test",subject:"cas-recovery",email:"recovery@example.test",emailVerified:true},link);
  const principal=auth.principal(new Request("https://write.test",{headers:{authorization:`Bearer ${signedIn.token}`}}))!;
  await database.mutate(state=>{state.sessions.find(item=>item.id===principal.sessionId)!.authenticatedAt=new Date(Date.now()-6*60_000).toISOString();});
  await expect(auth.setLocalPasswordFromFastCAS(principal,"https://cas.test","new-local-password-at-least-12")).rejects.toMatchObject({code:"fastcas_reauthentication_required"});
  await database.mutate(state=>{state.sessions.find(item=>item.id===principal.sessionId)!.authenticatedAt=new Date().toISOString(); state.fastcasLinks[0]!.link={...link,state:"revoked",version:2};});
  await expect(auth.setLocalPasswordFromFastCAS(principal,"https://cas.test","new-local-password-at-least-12")).rejects.toMatchObject({code:"fastcas_link_inactive"});
  expect(database.snapshot().localCredentials).toHaveLength(0);
});

test("unclaimed verified FastCAS email becomes the local login ID", async () => {
  const {database}=await fixture(); const auth=new AuthService(database);
  const now=new Date().toISOString(); const userId="user_verified";
  const link={id:"link-verified",client_id:"write",local_account_ref:userId,subject:"cas-verified",state:"active" as const,version:1,verified_at:now};
  await database.mutate(state=>{
    state.users.push({id:userId,emailNormalized:"verified@example.test",displayName:"Verified",platformRole:"user",status:"active",authzVersion:1,createdAt:now,updatedAt:now});
    state.fastcasLinks.push({issuer:"https://cas.test",userId,link});
  });
  const signedIn=await auth.loginFastCAS({issuer:"https://cas.test",subject:"cas-verified",email:"Verified@Example.Test",emailVerified:true},link);
  const principal=auth.principal(new Request("https://write.test",{headers:{authorization:`Bearer ${signedIn.token}`}}))!;
  const result=await auth.setLocalPasswordFromFastCAS(principal,"https://cas.test","new-local-password-at-least-12");
  expect(result.loginId).toBe("verified@example.test");
  expect((await auth.login({email:"VERIFIED@example.test",password:"new-local-password-at-least-12"})).user.id).toBe(userId);
});

test("cutover callback state is acknowledged only after primary persistence commits", async () => {
  const {database}=await fixture();
  let persisted: ReturnType<JsonDatabase["snapshot"]> | undefined;
  database.setPrimaryPersistence(async () => { throw Error("primary unavailable"); });
  const store = new FastCASTransactions(database);
  const transaction={state:"cutover",nonce:"nonce",verifier:"verifier",bindingHash:"browser",purpose:"login" as const,returnTo:"/",expiresAt:Date.now()+300_000};
  await expect(store.put(transaction)).rejects.toThrow("primary unavailable");
  expect(database.snapshot().fastcasTransactions).toHaveLength(0);
  database.setPrimaryPersistence(async state => {persisted=state;});
  await store.put(transaction);
  expect(persisted!.fastcasTransactions).toHaveLength(1);
  await store.take("cutover");
  expect(persisted!.fastcasTransactions).toHaveLength(0);
});

test("FastCAS signup is disabled by default without any discovery request", async () => {
  const {database}=await fixture();
  const service=new FastCASService({issuer:"https://cas.test",clientId:"write",redirectUri:"https://write.test/callback"},database,new AuthService(database));
  await expect(service.beginRegistration()).rejects.toMatchObject({code:"fastcas_signup_disabled"});
  expect(database.snapshot().users).toHaveLength(0);
  expect(database.snapshot().fastcasTransactions).toHaveLength(0);
});

test("signed logout revokes only matching FastCAS sessions and deduplicates atomically", async () => {
  const {database}=await fixture();
  const service=new FastCASService({issuer:"https://cas.test",clientId:"write",redirectUri:"https://write.test/callback"},database,new AuthService(database));
  const now=new Date().toISOString();
  await database.mutate(state => {
    state.fastcasLinks.push({issuer:"https://cas.test",userId:"user-a",link:{id:"link-a",client_id:"write",subject:"subject-a",local_account_ref:"user-a",state:"active",version:2,verified_at:now}});
    for(const [id,source,sid] of [["cas-a","fastcas","sid-a"],["cas-b","fastcas","sid-b"],["local","local",""]] as const) {
      state.sessions.push({id,userId:"user-a",tokenHash:id,expiresAt:new Date(Date.now()+100000).toISOString(),createdAt:now,authSource:source,casIssuer:"https://cas.test",casLinkId:"link-a",casSid:sid});
    }
  });
  Object.assign(service.sdk,{verifyLogout:async()=>({id:"logout-a",subject:"subject-a",sessionId:"sid-a",expiresAt:Date.now()+300000})});
  await service.handleLogout("signed");
  await service.handleLogout("signed");
  const sessions=database.snapshot().sessions;
  expect(sessions.find(item=>item.id==="cas-a")?.revokedAt).toBeTruthy();
  expect(sessions.find(item=>item.id==="cas-b")?.revokedAt).toBeUndefined();
  expect(sessions.find(item=>item.id==="local")?.revokedAt).toBeUndefined();
  expect(database.snapshot().fastcasEvents).toHaveLength(1);
});

test("identity disable event revokes only FastCAS sourced sessions", async () => {
  const {database}=await fixture();
  const service=new FastCASService({issuer:"https://cas.test",clientId:"write",redirectUri:"https://write.test/callback"},database,new AuthService(database));
  const now=new Date().toISOString();
  await database.mutate(state => {
    state.fastcasLinks.push({issuer:"https://cas.test",userId:"user-a",link:{id:"link-a",client_id:"write",subject:"subject-a",local_account_ref:"user-a",state:"active",version:2,verified_at:now}});
    for (const [id,source] of [["cas","fastcas"],["local","local"]] as const) state.sessions.push({id,userId:"user-a",tokenHash:id,expiresAt:new Date(Date.now()+100000).toISOString(),createdAt:now,authSource:source,casIssuer:"https://cas.test",casLinkId:"link-a"});
  });
  Object.assign(service.sdk,{handleNotification:async (_raw:string,apply:(event:object)=>Promise<void>)=>apply({id:"status-a",type:"identity.status_changed",subject:"subject-a",status:"disabled",version:2})});
  await service.handleEvent("signed");
  await service.handleEvent("signed");
  expect(database.snapshot().sessions.find(item=>item.id==="cas")?.revokedAt).toBeTruthy();
  expect(database.snapshot().sessions.find(item=>item.id==="local")?.revokedAt).toBeUndefined();
  expect(database.snapshot().fastcasLinks[0]?.link.state).toBe("active");
  expect(database.snapshot().fastcasEvents).toHaveLength(1);
});
