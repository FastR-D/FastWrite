import { createApplication } from "./app";
import { config } from "./config";
import type { Server, ServerWebSocket } from "bun";
import { harnessEventBus } from "./agent/harness-event-bus";
import * as Y from "yjs";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { writeSyncStep1, writeSyncStep2, writeUpdate, messageYjsSyncStep1, messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MAX_COLLABORATION_FRAME_BYTES = 5 * 1024 * 1024;
const PRESENCE_EXPIRY_MS = 30_000;

export async function startServer() {
  const fetch = await createApplication();
  const server = Bun.serve(createServerOptions(fetch));
  const mailTimer = setInterval(() => { void fetch.dispatchMail(); }, 15_000);
  mailTimer.unref?.();
  console.log(`FastWrite server: http://localhost:${config.port}`);
  console.log(`Workspace data: ${config.dataDirectory}`);
  if (config.features.multiNodeCollaboration && !config.redisUrl) console.warn("FASTWRITE_MULTI_NODE_COLLABORATION is enabled but FASTWRITE_REDIS_URL is not configured; collaboration remains single-node.");
  return server;
}

export function createServerOptions(fetch: (request: Request) => Promise<Response>) {
  const rooms = new Map<string, Set<ServerWebSocket<CollaborationSocketData>>>();
  const harnessUnsubscribers = new Map<ServerWebSocket<SocketData>, () => void>();
  const collaborationReauthorizationTimers = new Map<ServerWebSocket<CollaborationSocketData>, ReturnType<typeof setInterval>>();
  const reauthorizeCollaborationSocket = async (socket: ServerWebSocket<CollaborationSocketData>) => {
    const access = await fetch(new Request(`http://fastwrite.local/api/collaboration/room-access?token=${encodeURIComponent(socket.data.roomToken)}`));
    if (!access.ok) socket.close(4003, "Collaboration access revoked");
    return access.ok;
  };
  const presenceExpiryTimer = setInterval(() => {
    const deadline = Date.now() - PRESENCE_EXPIRY_MS;
    for (const room of rooms.values()) for (const socket of room) if (socket.data.lastActivityAt < deadline) socket.close(4008, "Collaboration presence expired");
  }, 5_000);
  presenceExpiryTimer.unref?.();
  return {
    hostname: "127.0.0.1",
    port: config.port,
    async fetch(request: Request, server: Server<SocketData>) {
      const url = new URL(request.url);
      if (url.pathname === "/api/collaboration/socket") {
        const clientId = url.searchParams.get("clientId")?.trim(); const roomToken = url.searchParams.get("token")?.trim();
        if (!clientId || !roomToken) return new Response("clientId and token are required", { status: 400 });
        const access = await fetch(new Request(`http://fastwrite.local/api/collaboration/room-access?token=${encodeURIComponent(roomToken)}`));
        if (!access.ok) return new Response("Collaboration access denied", { status: access.status });
        const identity = await access.json() as { projectId: string; path: string; scope: "read" | "write"; userId: string; displayName: string; color: string };
        return server.upgrade(request, { data: { kind: "collaboration", room: `${identity.projectId}:${identity.path}`, clientId, roomToken, lastActivityAt: Date.now(), ...identity } }) ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
      }
      if (url.pathname === "/api/harness/socket") {
        const runId = url.searchParams.get("runId")?.trim();
        if (!runId) return new Response("runId is required", { status: 400 });
        return server.upgrade(request, { data: { kind: "harness", runId } }) ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
      }
      const response = await fetch(request);
      const persistedRoom = request.method === "POST" && url.pathname.match(/^\/api\/projects\/([^/]+)\/collaboration(?:\/persist)?$/);
      if (response.ok && persistedRoom) {
        const state = await response.clone().json() as { path: string; update: string };
        const room = rooms.get(`${decodeURIComponent(persistedRoom[1]!)}:${state.path}`);
        if (room) {
          const encoder = encoding.createEncoder(); encoding.writeVarUint(encoder, MESSAGE_SYNC); writeUpdate(encoder, Buffer.from(state.update, "base64"));
          const payload = encoding.toUint8Array(encoder);
          // HTTP persistence can arrive before WS reconnect. Peers still need the update.
          await Promise.all([...room].map(async socket => {
            try { if (await reauthorizeCollaborationSocket(socket)) socket.send(payload); } catch { socket.close(1011, "Collaboration update unavailable"); }
          }));
        }
      }
      return response;
    },
    websocket: {
      open(socket: ServerWebSocket<SocketData>) { if (socket.data.kind === "harness") { harnessUnsubscribers.set(socket, harnessEventBus.subscribe(socket.data.runId, (event) => socket.send(JSON.stringify(event)))); void fetch(new Request(`http://fastwrite.local/api/harness-runs/${encodeURIComponent(socket.data.runId)}/events`)).then(async (response) => { if (!response.ok) return; const events = await response.json() as unknown[]; for (const event of events) socket.send(JSON.stringify(event)); }).catch(() => undefined); return; } const collaborationSocket = socket as ServerWebSocket<CollaborationSocketData>; const room = rooms.get(socket.data.room) ?? new Set(); room.add(collaborationSocket); rooms.set(socket.data.room, room); collaborationReauthorizationTimers.set(collaborationSocket, setInterval(() => { void reauthorizeCollaborationSocket(collaborationSocket).catch(() => collaborationSocket.close(1011, "Collaboration authorization unavailable")); }, 60_000)); for (const peer of room) if (peer !== collaborationSocket && peer.data.awarenessUpdate) collaborationSocket.send(peer.data.awarenessUpdate); void sendSyncStep1(fetch, collaborationSocket).catch(() => collaborationSocket.close(1011, "Collaboration state unavailable")); },
      async message(socket: ServerWebSocket<SocketData>, message: string | Buffer) { if (socket.data.kind !== "collaboration" || typeof message === "string") return; const collaborationSocket = socket as ServerWebSocket<CollaborationSocketData>; if (!await reauthorizeCollaborationSocket(collaborationSocket).catch(() => { collaborationSocket.close(1011, "Collaboration authorization unavailable"); return false; })) return; const bytes = new Uint8Array(message); if (bytes.byteLength < 2 || bytes.byteLength > MAX_COLLABORATION_FRAME_BYTES) { collaborationSocket.close(1003, "Invalid collaboration frame"); return; } try { const decoder = decoding.createDecoder(bytes); const type = decoding.readVarUint(decoder); if (type === MESSAGE_SYNC) { const syncType = decoding.readVarUint(decoder); if (syncType === messageYjsSyncStep1) { const stateVector = decoding.readVarUint8Array(decoder); await sendSyncStep2(fetch, collaborationSocket, stateVector); return; } if (syncType !== messageYjsSyncStep2 && syncType !== messageYjsUpdate) throw new Error("Unknown Yjs sync message"); const update = decoding.readVarUint8Array(decoder); if (socket.data.scope !== "write") { if (syncType === messageYjsSyncStep2) return; collaborationSocket.close(4003, "Collaboration write access denied"); return; } await persistUpdate(fetch, collaborationSocket, update); const room = rooms.get(socket.data.room); if (room) broadcastBinary(room, Buffer.from(bytes), collaborationSocket); return; } if (type === MESSAGE_AWARENESS) { const update = sanitizeAwareness(decoder, collaborationSocket); if (!update) return; collaborationSocket.data.awarenessUpdate = update; collaborationSocket.data.lastActivityAt = Date.now(); const room = rooms.get(socket.data.room); if (room) broadcastBinary(room, update, collaborationSocket); return; } throw new Error("Unknown collaboration message"); } catch { collaborationSocket.close(1003, "Invalid collaboration message"); } },
      close(socket: ServerWebSocket<SocketData>) { if (socket.data.kind === "harness") { harnessUnsubscribers.get(socket)?.(); harnessUnsubscribers.delete(socket); return; } const collaborationSocket = socket as ServerWebSocket<CollaborationSocketData>; const timer = collaborationReauthorizationTimers.get(collaborationSocket); if (timer) clearInterval(timer); collaborationReauthorizationTimers.delete(collaborationSocket); const room = rooms.get(socket.data.room); if (!room) return; room.delete(collaborationSocket); const removal = removeAwareness(collaborationSocket); if (removal) broadcastBinary(room, removal); if (!room.size) rooms.delete(socket.data.room); }
    },
    maxRequestBodySize: config.maxFileBytes + 1024 * 1024,
    // Agent operations enforce their own workflow-specific deadlines.
    idleTimeout: 0
  };
}

interface CollaborationSocketData { room: string; projectId: string; path: string; clientId: string; roomToken: string; scope: "read" | "write"; userId: string; displayName: string; color: string; lastActivityAt: number; awarenessClientId?: number; awarenessClock?: number; awarenessUpdate?: Buffer }
type SocketData = (CollaborationSocketData & { kind: "collaboration" }) | { kind: "harness"; runId: string };
function broadcastBinary(room: Set<ServerWebSocket<CollaborationSocketData>>, payload: Buffer, exclude?: ServerWebSocket<CollaborationSocketData>) { for (const socket of room) if (socket !== exclude) socket.send(payload); }
async function roomDocument(fetch: (request: Request) => Promise<Response>, socket: ServerWebSocket<CollaborationSocketData>) { const response = await fetch(new Request("http://fastwrite.local/api/collaboration/room-state", { headers: { "x-fastwrite-room-token": socket.data.roomToken } })); if (!response.ok) throw new Error("Room state unavailable"); const state = await response.json() as { update: string }; const document = new Y.Doc(); Y.applyUpdate(document, Buffer.from(state.update, "base64")); return document; }
async function sendSyncStep1(fetch: (request: Request) => Promise<Response>, socket: ServerWebSocket<CollaborationSocketData>) { const encoder = encoding.createEncoder(); encoding.writeVarUint(encoder, MESSAGE_SYNC); writeSyncStep1(encoder, await roomDocument(fetch, socket)); socket.send(encoding.toUint8Array(encoder)); }
async function sendSyncStep2(fetch: (request: Request) => Promise<Response>, socket: ServerWebSocket<CollaborationSocketData>, stateVector: Uint8Array) { const encoder = encoding.createEncoder(); encoding.writeVarUint(encoder, MESSAGE_SYNC); writeSyncStep2(encoder, await roomDocument(fetch, socket), stateVector); socket.send(encoding.toUint8Array(encoder)); }
async function persistUpdate(fetch: (request: Request) => Promise<Response>, socket: ServerWebSocket<CollaborationSocketData>, update: Uint8Array) { const persisted = await fetch(new Request("http://fastwrite.local/api/collaboration/room-update", { method: "POST", headers: { "content-type": "application/json", "x-fastwrite-room-token": socket.data.roomToken }, body: JSON.stringify({ update: Buffer.from(update).toString("base64") }) })); if (!persisted.ok) throw new Error("Collaboration update rejected"); socket.data.lastActivityAt = Date.now(); }
function sanitizeAwareness(decoder: decoding.Decoder, socket: ServerWebSocket<CollaborationSocketData>): Buffer | null { decoder = decoding.createDecoder(decoding.readVarUint8Array(decoder)); if (decoding.readVarUint(decoder) !== 1) return null; const clientId = decoding.readVarUint(decoder); const clock = decoding.readVarUint(decoder); const value = decoding.readVarString(decoder); if (socket.data.awarenessClientId !== undefined && socket.data.awarenessClientId !== clientId) return null; let state: unknown; try { state = JSON.parse(value); } catch { return null; } if (!state || typeof state !== "object") return null; const candidate = state as { cursor?: { anchor?: unknown; head?: unknown } }; const cursor = candidate.cursor && typeof candidate.cursor.anchor === "string" && candidate.cursor.anchor.length <= 2_048 && typeof candidate.cursor.head === "string" && candidate.cursor.head.length <= 2_048 ? { anchor: candidate.cursor.anchor, head: candidate.cursor.head } : undefined; socket.data.awarenessClientId = clientId; socket.data.awarenessClock = Math.max(socket.data.awarenessClock ?? 0, clock); const encoder = encoding.createEncoder(); encoding.writeVarUint(encoder, 1); encoding.writeVarUint(encoder, clientId); encoding.writeVarUint(encoder, socket.data.awarenessClock); encoding.writeVarString(encoder, JSON.stringify({ user: { id: socket.data.userId, name: socket.data.displayName, color: socket.data.color, path: socket.data.path }, ...(cursor ? { cursor } : {}) })); return awarenessFrame(encoding.toUint8Array(encoder)); }
function removeAwareness(socket: ServerWebSocket<CollaborationSocketData>): Buffer | null { if (socket.data.awarenessClientId === undefined) return null; const encoder = encoding.createEncoder(); encoding.writeVarUint(encoder, 1); encoding.writeVarUint(encoder, socket.data.awarenessClientId); encoding.writeVarUint(encoder, (socket.data.awarenessClock ?? 0) + 1); encoding.writeVarString(encoder, "null"); return awarenessFrame(encoding.toUint8Array(encoder)); }

function awarenessFrame(update: Uint8Array): Buffer { const encoder = encoding.createEncoder(); encoding.writeVarUint(encoder, MESSAGE_AWARENESS); encoding.writeVarUint8Array(encoder, update); return Buffer.from(encoding.toUint8Array(encoder)); }

if (import.meta.main) void startServer();

export { createApplication };
