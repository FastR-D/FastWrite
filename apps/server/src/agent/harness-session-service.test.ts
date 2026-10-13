import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessSessionService } from "./harness-session-service";
import type { HarnessAdapter, SessionReference } from "@fastwrite/harness-core";
import { JsonDatabase } from "../storage/database";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "fastwrite-session-")); directories.push(directory);
  const database = new JsonDatabase(directory); await database.initialize();
  const adapter = { kind: "codex", async getCapabilities() { return {streaming:true,sessions:true,resume:true,approvals:true,skills:false,mcp:false}; }, async createSession(input: { cwd: string }) { return { harness: "codex" as const, sessionId: "thread-1", cwd: input.cwd }; }, async resumeSession(session: SessionReference) { return session; } } as unknown as HarnessAdapter;
  return { database, adapter, service: new HarnessSessionService(database), directory };
}

describe("HarnessSessionService", () => {
  test("persists created and resumed sessions with immutable execution binding", async () => {
    const { service, adapter, directory } = await fixture();
    const binding = { projectId: "project", actorUserId: "owner", executionSnapshotId: "snapshot" };
    const created = await service.create(adapter, { cwd: "/tmp/paper", title: "Paper" }, binding);
    expect(created.sessionId).toBe("thread-1");
    const resumed = await service.resume(adapter, created);
    expect(resumed.resumedAt).toBeString(); expect(resumed).toMatchObject(binding);
    expect(service.list()).toHaveLength(1);
    const restored = new JsonDatabase(directory); await restored.initialize();
    expect(new HarnessSessionService(restored).get("codex", "thread-1")).toMatchObject(binding);
  });

  test("rejects duplicate adapter identities without rebinding existing sessions", async () => {
    const { service, adapter } = await fixture();
    const original = await service.create(adapter, { cwd: "/tmp/first" }, { projectId: "first", actorUserId: "owner", executionSnapshotId: "pin-first" });
    await expect(service.create(adapter, { cwd: "/tmp/second" }, { projectId: "second", actorUserId: "other", executionSnapshotId: "pin-second" })).rejects.toMatchObject({ status: 409 });
    expect(service.list()).toEqual([original]);
  });

  test("rejects caller workspace changes before invoking resume and adapter identity changes afterward", async () => {
    const { service, adapter } = await fixture();
    const original = await service.create(adapter, { cwd: "/tmp/paper" });
    let calls = 0;
    adapter.resumeSession = async input => { calls++; return { ...input, sessionId: "replacement" }; };
    await expect(service.resume(adapter, { ...original, cwd: "/tmp/other" })).rejects.toMatchObject({ status: 409 });
    expect(calls).toBe(0);
    await expect(service.resume(adapter, original)).rejects.toMatchObject({ status: 502 });
    expect(calls).toBe(1); expect(service.list()).toEqual([original]);
  });

  test("does not persist creation or resume after access is revoked during remote work", async () => {
    const { service, adapter } = await fixture();
    let allowed = true;
    const validate = () => { if (!allowed) throw new Error("revoked"); };
    const create = adapter.createSession.bind(adapter);
    adapter.createSession = async input => { const result = await create(input); allowed = false; return result; };
    await expect(service.create(adapter, { cwd: "/tmp/paper" }, undefined, validate)).rejects.toThrow("revoked");
    expect(service.list()).toEqual([]);
    adapter.createSession = create; allowed = true;
    const original = await service.create(adapter, { cwd: "/tmp/paper" });
    adapter.resumeSession = async input => { allowed = false; return input; };
    await expect(service.resume(adapter, original, validate)).rejects.toThrow("revoked");
    expect(service.list()).toEqual([original]);
  });

  test("persists only trusted binding fields and rejects wrong adapter workspace", async () => {
    const { service, adapter } = await fixture();
    adapter.createSession = async () => ({ harness: "codex", sessionId: "spoof", cwd: "/tmp/paper", projectId: "injected", actorUserId: "injected", executionSnapshotId: "injected" });
    const created = await service.create(adapter, { cwd: "/tmp/paper" });
    expect(created.projectId).toBeUndefined(); expect(created.actorUserId).toBeUndefined(); expect(created.executionSnapshotId).toBeUndefined();
    adapter.createSession = async () => ({ harness: "codex", sessionId: "wrong", cwd: "/tmp/other" });
    await expect(service.create(adapter, { cwd: "/tmp/paper" })).rejects.toMatchObject({ status: 502 });
    expect(service.list()).toEqual([created]);
  });

  test("rejects replacement bindings committed while a resume is in flight", async () => {
    const { service, adapter, database } = await fixture();
    const original = await service.create(adapter, { cwd: "/tmp/paper" }, { projectId: "project", actorUserId: "first", executionSnapshotId: "first-pin" });
    adapter.resumeSession = async input => { await database.mutate(state => { state.harnessSessions[0]!.actorUserId = "second"; state.harnessSessions[0]!.executionSnapshotId = "second-pin"; }); return input; };
    await expect(service.resume(adapter, original)).rejects.toMatchObject({ status: 409 });
    expect(service.list()[0]?.resumedAt).toBeUndefined();
  });

  test("does not resurrect a bound session removed while its adapter resumes", async () => {
    const { service, adapter, database } = await fixture();
    const original = await service.create(adapter, { cwd: "/tmp/paper" });
    adapter.resumeSession = async input => { await database.mutate(state => { state.harnessSessions = []; }); return input; };
    await expect(service.resume(adapter, original)).rejects.toMatchObject({ status: 409 });
    expect(service.list()).toEqual([]);
  });
});

test("session capabilities persist only known boolean fields and refresh after resume",async()=>{
 const {service,adapter,directory}=await fixture();
 const capabilities={streaming:false,sessions:true,resume:true,approvals:true,skills:false,mcp:false,images:false,privateDiagnostic:"do-not-store"};
 adapter.getCapabilities=async()=>capabilities;
 const created=await service.create(adapter,{cwd:"/tmp/paper"});
 expect(created.capabilities).toEqual({streaming:false,sessions:true,resume:true,approvals:true,skills:false,mcp:false,images:false});
 expect(created.capabilitiesVerifiedAt).toBeString();expect(JSON.stringify(created)).not.toContain("do-not-store");
 capabilities.resume=false;
 expect(service.get("codex","thread-1")?.capabilities?.resume).toBe(true);
 await service.resume(adapter,created);
 const database=new JsonDatabase(directory);await database.initialize();
 expect(new HarnessSessionService(database).get("codex","thread-1")?.capabilities?.resume).toBe(false);
});

test("session capability snapshots retain negotiated image input without accepting truthy strings",async()=>{
 const {service,adapter}=await fixture();const original=adapter.getCapabilities.bind(adapter);
 adapter.getCapabilities=async()=>({...await original(),images:true});
 const session=await service.create(adapter,{cwd:"/tmp/images"});
 expect(session.capabilities?.images).toBe(true);
 expect(service.get("codex",session.sessionId)?.capabilities?.images).toBe(true);
 adapter.getCapabilities=async()=>({...await original(),images:"true" as never});
 await expect(service.resume(adapter,session)).rejects.toMatchObject({code:"harness_capabilities_invalid"});
});
