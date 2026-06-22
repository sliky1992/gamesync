import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requireToken } from "../auth.js";
import { isOnline, sendRequest } from "../ws.js";

export async function deviceRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireToken);

  // Client calls this on startup; idempotent (upsert by id).
  app.post<{ Body: { id: string; name?: string } }>("/api/devices/register", async (req, reply) => {
    const { id, name } = req.body ?? ({} as any);
    if (!id) return reply.code(400).send({ error: "id is required" });
    const device = await prisma.device.upsert({
      where: { id },
      create: { id, name: name || id },
      update: { name: name || undefined, lastSeen: new Date() },
    });
    return device;
  });

  app.get("/api/devices", async () => {
    const devices = await prisma.device.findMany({ orderBy: { createdAt: "asc" } });
    return devices.map((d) => ({ ...d, online: isOnline(d.id) || d.online }));
  });

  app.delete<{ Params: { id: string } }>("/api/devices/:id", async (req) => {
    await prisma.device.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  // Ask a device's online client to list folders at a path (for the path picker).
  // Empty/missing path => the client returns its drives + common save roots.
  app.post<{ Params: { id: string }; Body: { path?: string } }>(
    "/api/devices/:id/browse",
    async (req, reply) => {
      const id = req.params.id;
      if (!isOnline(id)) {
        req.log.info({ deviceId: id }, "browse: device offline");
        return reply.code(409).send({ error: "device is offline — start its GameSync client first" });
      }
      try {
        req.log.info({ deviceId: id, path: req.body?.path ?? "" }, "browse: asking device");
        const res = await sendRequest(id, "browse", { path: req.body?.path ?? "" });
        req.log.info({ deviceId: id }, "browse: device answered");
        return res;
      } catch (e: any) {
        // Reached the device socket but got no reply in time — the client is
        // connected but not answering (e.g. an old build without browse support).
        req.log.warn({ deviceId: id, err: e.message }, "browse: device did not answer");
        return reply.code(504).send({ error: e.message });
      }
    },
  );
}
