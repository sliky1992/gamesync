import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import fastifyWebsocket from "@fastify/websocket";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { ensureStorage } from "./storage.js";
import { tokenOk } from "./auth.js";
import { registerSocket, unregisterSocket, broadcastToAll, resolveResponse, startHeartbeat } from "./ws.js";
import { deviceRoutes } from "./routes/devices.js";
import { gameRoutes } from "./routes/games.js";
import { syncRoutes } from "./routes/sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  await ensureStorage();

  const app = Fastify({ logger: true, bodyLimit: 5 * 1024 * 1024 });

  await app.register(fastifyMultipart, {
    limits: { fileSize: config.maxUploadBytes, files: 1 },
  });
  await app.register(fastifyWebsocket);

  // Prune dead client sockets so a device that dropped without a clean close
  // doesn't stay "online" (which would leave its Browse button enabled but
  // unresponsive). Pings every 30s; terminates sockets that miss a pong.
  startHeartbeat(Number(process.env.WS_HEARTBEAT_MS ?? 30000));

  // Health check.
  app.get("/api/health", async () => ({ ok: true, time: new Date().toISOString() }));

  // Persistent client connection: GET /ws?deviceId=...&token=...
  app.register(async (scoped) => {
    scoped.get("/ws", { websocket: true }, async (socket, req) => {
      const url = new URL(req.url, "http://localhost");
      const deviceId = url.searchParams.get("deviceId");
      const token = url.searchParams.get("token") ?? undefined;
      if (!deviceId || !tokenOk(token)) {
        socket.close(1008, "unauthorized or missing deviceId");
        return;
      }
      await registerSocket(deviceId, socket);
      broadcastToAll({ type: "device_online", deviceId });
      socket.send(JSON.stringify({ type: "hello", deviceId }));

      socket.on("message", (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg?.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
          // Replies to hub-initiated requests (e.g. folder browsing).
          else if (msg?.reqId) resolveResponse(msg.reqId, msg);
        } catch {
          /* ignore malformed frames */
        }
      });

      socket.on("close", async () => {
        await unregisterSocket(deviceId, socket);
        broadcastToAll({ type: "device_offline", deviceId });
      });
    });
  });

  await app.register(deviceRoutes);
  await app.register(gameRoutes);
  await app.register(syncRoutes);

  // Serve client downloads (the Windows client zip) from the data volume so it
  // persists across container rebuilds. Registered first / more specific.
  await app.register(fastifyStatic, {
    root: path.join(config.storageDir, "downloads"),
    prefix: "/downloads/",
    decorateReply: false,
  });

  // Serve the dashboard SPA.
  await app.register(fastifyStatic, {
    root: path.join(__dirname, "..", "public"),
    prefix: "/",
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api") || req.url.startsWith("/ws")) {
      reply.code(404).send({ error: "not found" });
    } else {
      reply.sendFile("index.html");
    }
  });

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`GameSync hub listening on http://${config.host}:${config.port}`);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
