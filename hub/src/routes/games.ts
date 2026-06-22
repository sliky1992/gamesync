import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requireToken } from "../auth.js";
import { searchGames, getCovers, bestCoverForName, testKey } from "../steamgriddb.js";
import { removeFile, copyToNewVersion } from "../storage.js";
import { broadcastSaveUpdate, broadcastToAll } from "../ws.js";

export async function gameRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireToken);

  // Diagnostic: is the SteamGridDB key configured and accepted?
  app.get("/api/sgdb/status", async () => testKey());

  // --- SteamGridDB lookups (used by the "add game" UI) -------------------
  app.get<{ Querystring: { q: string } }>("/api/sgdb/search", async (req, reply) => {
    const q = (req.query.q ?? "").trim();
    if (!q) return reply.code(400).send({ error: "q is required" });
    try {
      return await searchGames(q);
    } catch (e: any) {
      return reply.code(502).send({ error: e.message });
    }
  });

  app.get<{ Params: { sgdbId: string } }>("/api/sgdb/covers/:sgdbId", async (req, reply) => {
    try {
      return await getCovers(Number(req.params.sgdbId));
    } catch (e: any) {
      return reply.code(502).send({ error: e.message });
    }
  });

  // --- Games CRUD --------------------------------------------------------
  app.get("/api/games", async () => {
    const games = await prisma.game.findMany({
      orderBy: { name: "asc" },
      include: {
        paths: { include: { device: true } },
        _count: { select: { versions: true, conflicts: { where: { resolved: false } } } as any },
      },
    });
    return games;
  });

  app.get<{ Params: { id: string } }>("/api/games/:id", async (req, reply) => {
    const game = await prisma.game.findUnique({
      where: { id: Number(req.params.id) },
      include: {
        paths: { include: { device: true } },
        versions: { orderBy: { version: "desc" }, take: 20 },
        conflicts: { where: { resolved: false } },
      },
    });
    if (!game) return reply.code(404).send({ error: "not found" });
    return game;
  });

  // Create a game. If coverUrl/steamGridId omitted, auto-resolve from name.
  app.post<{ Body: { name: string; coverUrl?: string; steamGridId?: number; processName?: string } }>(
    "/api/games",
    async (req, reply) => {
      const { name } = req.body ?? ({} as any);
      if (!name?.trim()) return reply.code(400).send({ error: "name is required" });
      let coverUrl = req.body.coverUrl ?? null;
      let steamGridId = req.body.steamGridId ?? null;
      if (!coverUrl) {
        const found = await bestCoverForName(name).catch(() => null);
        if (found) {
          coverUrl = found.coverUrl;
          steamGridId = found.steamGridId;
        }
      }
      const game = await prisma.game.create({
        data: { name: name.trim(), coverUrl, steamGridId, processName: req.body.processName ?? null },
      });
      return game;
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { name?: string; coverUrl?: string; steamGridId?: number; processName?: string; autoSync?: boolean; overwriteStale?: boolean };
  }>("/api/games/:id", async (req) => {
    return prisma.game.update({
      where: { id: Number(req.params.id) },
      data: {
        name: req.body.name,
        coverUrl: req.body.coverUrl,
        steamGridId: req.body.steamGridId,
        processName: req.body.processName,
        autoSync: req.body.autoSync,
        overwriteStale: req.body.overwriteStale,
      },
    });
  });

  app.delete<{ Params: { id: string } }>("/api/games/:id", async (req) => {
    await prisma.game.delete({ where: { id: Number(req.params.id) } });
    return { ok: true };
  });

  // --- Vault: full version history + management --------------------------

  // Every game with its complete version list (newest first), for the Vault tab.
  app.get("/api/vault", async () => {
    const games = await prisma.game.findMany({
      orderBy: { name: "asc" },
      include: { versions: { orderBy: { version: "desc" } } },
    });
    return games.map((g) => ({
      id: g.id,
      name: g.name,
      coverUrl: g.coverUrl,
      currentVersion: g.currentVersion,
      versions: g.versions.map((v) => ({
        version: v.version,
        deviceId: v.deviceId,
        size: v.size,
        savedAt: v.savedAt,
        createdAt: v.createdAt,
      })),
    }));
  });

  // Permanently delete one stored version (never the current one).
  app.delete<{ Params: { id: string; version: string } }>(
    "/api/games/:id/versions/:version",
    async (req, reply) => {
      const gameId = Number(req.params.id);
      const version = Number(req.params.version);
      const game = await prisma.game.findUnique({ where: { id: gameId } });
      if (!game) return reply.code(404).send({ error: "game not found" });
      if (version === game.currentVersion) {
        return reply.code(400).send({ error: "cannot delete the current version" });
      }
      const sv = await prisma.saveVersion.findUnique({
        where: { gameId_version: { gameId, version } },
      });
      if (!sv) return reply.code(404).send({ error: "version not found" });
      await removeFile(sv.storagePath);
      await prisma.saveVersion.delete({ where: { id: sv.id } });
      return { ok: true };
    },
  );

  // Roll back to an older version: copy it forward as a new current version and
  // notify every device so they sync back to it. Nothing is overwritten in place.
  app.post<{ Params: { id: string; version: string } }>(
    "/api/games/:id/versions/:version/restore",
    async (req, reply) => {
      const gameId = Number(req.params.id);
      const version = Number(req.params.version);
      const game = await prisma.game.findUnique({ where: { id: gameId } });
      if (!game) return reply.code(404).send({ error: "game not found" });
      if (version === game.currentVersion) {
        return reply.code(400).send({ error: "already the current version" });
      }
      const src = await prisma.saveVersion.findUnique({
        where: { gameId_version: { gameId, version } },
      });
      if (!src) return reply.code(404).send({ error: "version not found" });

      const newVersion = game.currentVersion + 1;
      const storagePath = await copyToNewVersion(src.storagePath, gameId, newVersion);
      await prisma.$transaction([
        prisma.saveVersion.create({
          data: {
            gameId,
            version: newVersion,
            hash: src.hash,
            size: src.size,
            storagePath,
            deviceId: src.deviceId,
            savedAt: src.savedAt,
          },
        }),
        prisma.game.update({ where: { id: gameId }, data: { currentVersion: newVersion } }),
      ]);
      // originDeviceId "" excludes nobody -> every device with a path pulls it.
      await broadcastSaveUpdate({ gameId, version: newVersion, hash: src.hash, originDeviceId: "" });
      broadcastToAll({ type: "sync_event", gameId, gameName: game.name, version: newVersion, deviceId: "vault" });
      return { ok: true, version: newVersion, restoredFrom: version };
    },
  );

  // Keep only the newest N versions (plus the current one); delete the rest.
  app.post<{ Params: { id: string }; Body: { keep?: number } }>(
    "/api/games/:id/versions/prune",
    async (req, reply) => {
      const gameId = Number(req.params.id);
      const keep = Math.max(1, Math.floor(Number(req.body?.keep ?? 5)) || 1);
      const game = await prisma.game.findUnique({ where: { id: gameId } });
      if (!game) return reply.code(404).send({ error: "game not found" });
      const all = await prisma.saveVersion.findMany({
        where: { gameId },
        orderBy: { version: "desc" },
      });
      const keepVersions = new Set(all.slice(0, keep).map((v) => v.version));
      keepVersions.add(game.currentVersion); // never prune the live version
      const toDelete = all.filter((v) => !keepVersions.has(v.version));
      for (const v of toDelete) await removeFile(v.storagePath);
      if (toDelete.length) {
        await prisma.saveVersion.deleteMany({ where: { id: { in: toDelete.map((v) => v.id) } } });
      }
      return { ok: true, removed: toDelete.length };
    },
  );

  // --- Per-device path mapping (the "magic link") ------------------------
  app.put<{ Params: { id: string }; Body: { deviceId: string; localPath: string } }>(
    "/api/games/:id/paths",
    async (req, reply) => {
      const gameId = Number(req.params.id);
      const { deviceId, localPath } = req.body ?? ({} as any);
      if (!deviceId || !localPath) {
        return reply.code(400).send({ error: "deviceId and localPath are required" });
      }
      return prisma.gamePath.upsert({
        where: { gameId_deviceId: { gameId, deviceId } },
        create: { gameId, deviceId, localPath },
        update: { localPath },
      });
    },
  );

  app.delete<{ Params: { id: string; deviceId: string } }>(
    "/api/games/:id/paths/:deviceId",
    async (req) => {
      await prisma.gamePath
        .delete({
          where: { gameId_deviceId: { gameId: Number(req.params.id), deviceId: req.params.deviceId } },
        })
        .catch(() => {});
      return { ok: true };
    },
  );
}
