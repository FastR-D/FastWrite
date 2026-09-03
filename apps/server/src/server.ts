import { createApplication } from "./app";
import { config } from "./config";
import type { Server, ServerWebSocket } from "bun";

export async function startServer() {
  const fetch = await createApplication();
  const server = Bun.serve(createServerOptions(fetch));
  console.log(`FastWrite server: http://localhost:${config.port}`);
  console.log(`Workspace data: ${config.dataDirectory}`);
  return server;
}

export function createServerOptions(fetch: Awaited<ReturnType<typeof createApplication>>) {
  const rooms = new Map<string, Set<ServerWebSocket<CollaborationSocketData>>>();
  return {
    hostname: "127.0.0.1",
    port: config.port,
    fetch(request: Request, server: Server<CollaborationSocketData>) {
      const url = new URL(request.url);
      if (url.pathname === "/api/collaboration/socket") {
        const projectId = url.searchParams.get("projectId")?.trim(); const path = url.searchParams.get("path")?.trim(); const clientId = url.searchParams.get("clientId")?.trim();
        if (!projectId || !path || !clientId) return new Response("projectId, path and clientId are required", { status: 400 });
        return server.upgrade(request, { data: { room: `${projectId}:${path}`, projectId, path, clientId } }) ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
      }
      return fetch(request);
    },
    websocket: {
      open(socket: ServerWebSocket<CollaborationSocketData>) { const room = rooms.get(socket.data.room) ?? new Set(); room.add(socket); rooms.set(socket.data.room, room); broadcast(room, { type: "presence", clientId: socket.data.clientId, state: "joined" }); },
      message(socket: ServerWebSocket<CollaborationSocketData>, message: string | Buffer) { let payload: unknown; try { payload = JSON.parse(String(message)); } catch { return; } const room = rooms.get(socket.data.room); if (!room || !payload || typeof payload !== "object") return; const type = (payload as { type?: string }).type; if (type !== "document-updated" && type !== "presence") return; broadcast(room, { ...(payload as object), clientId: socket.data.clientId }, socket); },
      close(socket: ServerWebSocket<CollaborationSocketData>) { const room = rooms.get(socket.data.room); if (!room) return; room.delete(socket); broadcast(room, { type: "presence", clientId: socket.data.clientId, state: "left" }); if (!room.size) rooms.delete(socket.data.room); }
    },
    maxRequestBodySize: config.maxFileBytes + 1024 * 1024,
    // Agent operations enforce their own workflow-specific deadlines.
    idleTimeout: 0
  };
}

interface CollaborationSocketData { room: string; projectId: string; path: string; clientId: string }
function broadcast(room: Set<ServerWebSocket<CollaborationSocketData>>, payload: object, exclude?: ServerWebSocket<CollaborationSocketData>) { const message = JSON.stringify(payload); for (const socket of room) if (socket !== exclude) socket.send(message); }

if (import.meta.main) void startServer();

export { createApplication };
