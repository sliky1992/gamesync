import type { WebSocket } from "@fastify/websocket";
import { randomUUID } from "node:crypto";
import { prisma } from "./db.js";

// Tracks one persistent socket per connected device. Used to push "a new save
// is available" notifications so device B reacts the instant device A uploads.
const sockets = new Map<string, Set<WebSocket>>();

function add(deviceId: string, socket: WebSocket) {
  let set = sockets.get(deviceId);
  if (!set) {
    set = new Set();
    sockets.set(deviceId, set);
  }
  set.add(socket);
}

function remove(deviceId: string, socket: WebSocket) {
  const set = sockets.get(deviceId);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) sockets.delete(deviceId);
}

export async function registerSocket(deviceId: string, socket: WebSocket) {
  add(deviceId, socket);
  // Liveness tracking for the heartbeat below: a socket that doesn't answer a
  // ping with a pong is considered dead and pruned (see startHeartbeat).
  (socket as any).isAlive = true;
  socket.on("pong", () => {
    (socket as any).isAlive = true;
  });
  await prisma.device
    .update({ where: { id: deviceId }, data: { online: true, lastSeen: new Date() } })
    .catch(() => {});
}

export async function unregisterSocket(deviceId: string, socket: WebSocket) {
  remove(deviceId, socket);
  const stillOnline = (sockets.get(deviceId)?.size ?? 0) > 0;
  if (!stillOnline) {
    await prisma.device
      .update({ where: { id: deviceId }, data: { online: false, lastSeen: new Date() } })
      .catch(() => {});
  }
}

export function isOnline(deviceId: string) {
  return (sockets.get(deviceId)?.size ?? 0) > 0;
}

/**
 * Detect and prune dead client sockets. The TCP `close` event doesn't fire for
 * half-open connections (laptop sleep, network blips, killed client, proxy idle
 * timeouts), which would otherwise leave a device "online" forever — so its
 * Browse button stays enabled but every request to it just times out. We ping
 * each socket on an interval; any that didn't pong since the last tick is
 * terminated, which fires `close` -> unregisterSocket -> marks it offline.
 */
let heartbeat: ReturnType<typeof setInterval> | null = null;
export function startHeartbeat(intervalMs = 30000) {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    for (const set of sockets.values()) {
      for (const socket of set) {
        if ((socket as any).isAlive === false) {
          try {
            (socket as any).terminate();
          } catch {
            /* already gone */
          }
          continue;
        }
        (socket as any).isAlive = false;
        try {
          (socket as any).ping();
        } catch {
          /* socket closing; cleanup happens on close event */
        }
      }
    }
  }, intervalMs);
  heartbeat.unref?.();
}

function sendTo(deviceId: string, payload: unknown) {
  const set = sockets.get(deviceId);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const socket of set) {
    try {
      socket.send(data);
    } catch {
      /* socket closing; cleanup happens on close event */
    }
  }
}

/**
 * Notify every device that has a configured path for this game (except the
 * origin) that a new save version is available to download.
 */
export async function broadcastSaveUpdate(opts: {
  gameId: number;
  version: number;
  hash: string;
  originDeviceId: string;
}) {
  const paths = await prisma.gamePath.findMany({
    where: { gameId: opts.gameId, deviceId: { not: opts.originDeviceId } },
    select: { deviceId: true },
  });
  for (const p of paths) {
    sendTo(p.deviceId, {
      type: "save_updated",
      gameId: opts.gameId,
      version: opts.version,
      hash: opts.hash,
      originDeviceId: opts.originDeviceId,
    });
  }
}

// Tell the dashboard / clients that device presence changed.
export function broadcastToAll(payload: unknown) {
  for (const deviceId of sockets.keys()) sendTo(deviceId, payload);
}

// --- Request/response over the socket (e.g. "browse this device's folders") ---
const pending = new Map<string, { resolve: (v: any) => void; timer: NodeJS.Timeout }>();

/**
 * Send a request to a device and await its matching reply (correlated by reqId).
 * Rejects if the device is offline or doesn't answer within timeoutMs.
 */
export function sendRequest(deviceId: string, type: string, data: Record<string, unknown>, timeoutMs = 8000) {
  if (!isOnline(deviceId)) return Promise.reject(new Error("device offline"));
  const reqId = randomUUID();
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error("device is connected but didn't respond — make sure its GameSync client is running and up to date, then try again"));
    }, timeoutMs);
    pending.set(reqId, { resolve, timer });
    sendTo(deviceId, { type, reqId, ...data });
  });
}

/** Called by the WS message handler when a device replies with a reqId. */
export function resolveResponse(reqId: string, data: any) {
  const entry = pending.get(reqId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(reqId);
  entry.resolve(data);
}
