import { createApplication } from "./app";
import { config } from "./config";
import type { Server, ServerWebSocket } from "bun";
import { harnessEventBus } from "./agent/harness-event-bus";

export async function startServer() {
  const fetch = await createApplication();
  const server = Bun.serve(createServerOptions(fetch));
  console.log(`FastWrite server: http://localhost:${config.port}`);
  console.log(`Workspace data: ${config.dataDirectory}`);
  return server;
}

export function createServerOptions(fetch: Awaited<ReturnType<typeof createApplication>>) {
  const rooms = new Map<string, Set<ServerWebSocket<CollaborationSocketData>>>();
  const harnessUnsubscribers = new Map<ServerWebSocket<SocketData>, () => void>();
  return {
    hostname: "127.0.0.1",
    port: config.port,
    fetch(request: Request, server: Server<SocketData>) {
      const url = new URL(request.url);
      if (url.pathname === "/api/collaboration/socket") {
        const projectId = url.searchParams.get("projectId")?.trim(); const path = url.searchParams.get("path")?.trim(); const clientId = url.searchParams.get("clientId")?.trim();
        if (!projectId || !path || !clientId) return new Response("projectId, path and clientId are required", { status: 400 });
        return server.upgrade(request, { data: { kind: "collaboration", room: `${projectId}:${path}`, projectId, path, clientId } }) ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
      }
      if (url.pathname === "/api/harness/socket") {
        const runId = url.searchParams.get("runId")?.trim();
        if (!runId) return new Response("runId is required", { status: 400 });
        return server.upgrade(request, { data: { kind: "harness", runId } }) ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
      }
      return fetch(request);
    },
    websocket: {
      open(socket: ServerWebSocket<SocketData>) { if (socket.data.kind === "harness") { harnessUnsubscribers.set(socket, harnessEventBus.subscribe(socket.data.runId, (event) => socket.send(JSON.stringify(event)))); void fetch(new Request(`http://fastwrite.local/api/harness-runs/${encodeURIComponent(socket.data.runId)}/events`)).then(async (response) => { if (!response.ok) return; const events = await response.json() as unknown[]; for (const event of events) socket.send(JSON.stringify(event)); }).catch(() => undefined); return; } const room = rooms.get(socket.data.room) ?? new Set(); room.add(socket as ServerWebSocket<CollaborationSocketData>); rooms.set(socket.data.room, room); broadcast(room, { type: "presence", clientId: socket.data.clientId, state: "joined" }); },
      message(socket: ServerWebSocket<SocketData>, message: string | Buffer) { if (socket.data.kind !== "collaboration") return; let payload: unknown; try { payload = JSON.parse(String(message)); } catch { return; } const room = rooms.get(socket.data.room); if (!room || !payload || typeof payload !== "object") return; const type = (payload as { type?: string }).type; if (type !== "document-updated" && type !== "presence") return; broadcast(room, { ...(payload as object), clientId: socket.data.clientId }, socket as ServerWebSocket<CollaborationSocketData>); },
      close(socket: ServerWebSocket<SocketData>) { if (socket.data.kind === "harness") { harnessUnsubscribers.get(socket)?.(); harnessUnsubscribers.delete(socket); return; } const room = rooms.get(socket.data.room); if (!room) return; room.delete(socket as ServerWebSocket<CollaborationSocketData>); broadcast(room, { type: "presence", clientId: socket.data.clientId, state: "left" }); if (!room.size) rooms.delete(socket.data.room); }
    },
    maxRequestBodySize: config.maxFileBytes + 1024 * 1024,
    // Agent operations enforce their own workflow-specific deadlines.
    idleTimeout: 0
  };
}

interface CollaborationSocketData { room: string; projectId: string; path: string; clientId: string }
type SocketData = (CollaborationSocketData & { kind: "collaboration" }) | { kind: "harness"; runId: string };
function broadcast(room: Set<ServerWebSocket<CollaborationSocketData>>, payload: object, exclude?: ServerWebSocket<CollaborationSocketData>) { const message = JSON.stringify(payload); for (const socket of room) if (socket !== exclude) socket.send(message); }

if (import.meta.main) void startServer();

export { createApplication };
