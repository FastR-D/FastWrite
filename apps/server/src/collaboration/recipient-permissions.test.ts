import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { writeUpdate } from "y-protocols/sync";
import { createApplication } from "../app";
import { createServerOptions } from "../server";

for (const kind of ["document", "awareness"] as const) test(`revoked recipients cannot receive subsequent ${kind} frames`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "fastwrite-recipient-"));
  let server: ReturnType<typeof Bun.serve> | undefined;
  const sockets: WebSocket[] = [];
  const documents: Y.Doc[] = [];
  try {
    const app = await createApplication(directory, { features: { serverAuth: true }, bootstrapAdmin: { email: "admin@example.test", password: "fixture-password-long-enough" } });
    const request = (path: string, token?: string, method = "GET", body?: unknown) => app(new Request("http://test" + path, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }));
    const json = async (path: string, token?: string, method = "GET", body?: unknown) => {
      const response = await request(path, token, method, body); expect(response.status).toBeLessThan(300); return await response.json() as any;
    };
    const register = (name: string) => json("/api/auth/register", undefined, "POST", { email: name + "@example.test", password: "fixture-password-long-enough" });
    const owner = await register("owner"), member = await register("member"), observer = await register("observer");
    const project = await json("/api/projects", owner.token, "POST", { name: "Recipient permissions" });
    const base = "/api/projects/" + project.id;
    for (const account of [member, observer]) {
      const invite = await json(base + "/invitations", owner.token, "POST", { email: account.user.emailNormalized, role: "editor" });
      await json("/api/invitations/" + invite.token + "/accept", account.token, "POST");
    }
    server = Bun.serve({ ...createServerOptions(app), hostname: "127.0.0.1", port: 0 });
    const initial = await json(base + "/collaboration?path=main.tex", owner.token);
    const connect = async (token: string) => {
      const grant = await json("/api/collaboration/tokens", token, "POST", { projectId: project.id, path: "main.tex" });
      const doc = new Y.Doc(); documents.push(doc); Y.applyUpdate(doc, Buffer.from(initial.update, "base64"));
      const socket = new WebSocket(`ws://127.0.0.1:${server!.port}/api/collaboration/socket?clientId=${crypto.randomUUID()}&token=${encodeURIComponent(grant.token)}`);
      socket.binaryType = "arraybuffer"; sockets.push(socket);
      const peer = { socket, doc, markerSeen: false, closeCode: 0 };
      socket.onclose = event => { peer.closeCode = event.code; };
      socket.onmessage = event => {
        const bytes = new Uint8Array(event.data);
        const decoder = decoding.createDecoder(bytes);
        if (decoding.readVarUint(decoder) === 0) {
          const type = decoding.readVarUint(decoder);
          if (type === 1 || type === 2) Y.applyUpdate(doc, decoding.readVarUint8Array(decoder));
          peer.markerSeen ||= doc.getText("content").toString().includes("PRIVATE_AFTER_REVOCATION");
        } else peer.markerSeen ||= new TextDecoder().decode(bytes).includes("PRIVATE_AFTER_REVOCATION");
      };
      await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject; });
      return peer;
    };
    const sender = await connect(owner.token), revoked = await connect(member.token), allowed = await connect(observer.token);
    await json(base + "/acl/new", owner.token, "PUT", { pathPrefix: "main.tex", subjectType: "user", subjectId: member.user.id, action: "read", effect: "deny" });
    expect((await request(base + "/file?path=main.tex", member.token)).status).toBe(403);
    const frame = encoding.createEncoder();
    if (kind === "document") {
      sender.doc.getText("content").insert(0, "PRIVATE_AFTER_REVOCATION\n");
      encoding.writeVarUint(frame, 0); writeUpdate(frame, Y.encodeStateAsUpdate(sender.doc));
    } else {
      const awareness = encoding.createEncoder();
      encoding.writeVarUint(awareness, 1); encoding.writeVarUint(awareness, 42); encoding.writeVarUint(awareness, 1);
      encoding.writeVarString(awareness, JSON.stringify({ cursor: { anchor: "PRIVATE_AFTER_REVOCATION", head: "head" } }));
      encoding.writeVarUint(frame, 1); encoding.writeVarUint8Array(frame, encoding.toUint8Array(awareness));
    }
    sender.socket.send(encoding.toUint8Array(frame));
    for (let attempt = 0; attempt < 100 && (!allowed.markerSeen || !revoked.closeCode); attempt++) await Bun.sleep(10);
    expect(allowed.markerSeen).toBe(true);
    expect(revoked.closeCode).toBe(4003);
    expect(revoked.markerSeen).toBe(false);
  } finally { for (const socket of sockets) socket.close(); server?.stop(true); for (const doc of documents) doc.destroy(); await rm(directory, { recursive: true, force: true }); }
});
