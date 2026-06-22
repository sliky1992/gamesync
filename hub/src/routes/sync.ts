import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requireToken } from "../auth.js";
import {
  storeTemp,
  promoteToSave,
  promoteToConflict,
  readStream,
  removeFile,
  zipMaxModTime,
} from "../storage.js";
import { broadcastSaveUpdate, broadcastToAll } from "../ws.js";

// Hash of a specific stored version (null if it doesn't exist / version 0).
async function hashOfVersion(gameId: number, version: number): Promise<string | null> {
  if (version <= 0) return null;
  const v = await prisma.saveVersion.findUnique({
    where: { gameId_version: { gameId, version } },
    select: { hash: true },
  });
  return v?.hash ?? null;
}

async function latestHash(gameId: number, currentVersion: number) {
  return hashOfVersion(gameId, currentVersion);
}

/**
 * Newest save-file modification time (epoch ms) for a stored version, used by
 * newest-wins resolution. Lazily backfills `savedAt` for legacy versions that
 * predate the field. Returns null if unknown.
 */
async function versionSavedAt(gameId: number, version: number): Promise<number | null> {
  if (version <= 0) return null;
  const v = await prisma.saveVersion.findUnique({
    where: { gameId_version: { gameId, version } },
  });
  if (!v) return null;
  if (v.savedAt) return v.savedAt.getTime();
  const t = zipMaxModTime(v.storagePath);
  if (t > 0) {
    await prisma.saveVersion.update({ where: { id: v.id }, data: { savedAt: new Date(t) } }).catch(() => {});
    return t;
  }
  return null;
}

export async function syncRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireToken);

  /**
   * Everything a single device needs to sync: its games, the resolved-on-client
   * local path, the process to wait for, and current/synced versions.
   */
  app.get<{ Querystring: { deviceId: string } }>("/api/sync/assignments", async (req, reply) => {
    const deviceId = req.query.deviceId;
    if (!deviceId) return reply.code(400).send({ error: "deviceId required" });
    const paths = await prisma.gamePath.findMany({
      where: { deviceId },
      include: { game: true },
    });
    return paths.map((p) => ({
      gameId: p.gameId,
      name: p.game.name,
      localPath: p.localPath,
      processName: p.game.processName,
      autoSync: p.game.autoSync,
      currentVersion: p.game.currentVersion,
      syncedVersion: p.syncedVersion,
    }));
  });

  /**
   * Lightweight pre-flight: client reports its local hash and the version it
   * last synced; server replies with what to do. No file transfer.
   * action: up_to_date | upload | download | conflict
   */
  app.post<{ Body: { gameId: number; deviceId: string; hash?: string; baseVersion?: number } }>(
    "/api/sync/check",
    async (req, reply) => {
      const { gameId, deviceId } = req.body ?? ({} as any);
      const hash = req.body.hash ?? null;
      const baseVersion = req.body.baseVersion ?? 0;
      if (!gameId || !deviceId) return reply.code(400).send({ error: "gameId and deviceId required" });

      const game = await prisma.game.findUnique({ where: { id: gameId } });
      if (!game) return reply.code(404).send({ error: "game not found" });

      const Cs = game.currentVersion;
      const Hs = await latestHash(gameId, Cs);

      // Client has no local save: pull if the server has one, else nothing to do.
      if (!hash) {
        return { action: Cs > 0 ? "download" : "up_to_date", currentVersion: Cs, hash: Hs };
      }
      // Server has no save yet but client does: upload.
      if (Cs === 0) {
        return { action: "upload", currentVersion: Cs, hash: Hs };
      }
      if (hash === Hs) {
        await prisma.gamePath
          .updateMany({
            where: { gameId, deviceId },
            data: { syncedVersion: Cs, lastSynced: new Date() },
          })
          .catch(() => {});
        return { action: "up_to_date", currentVersion: Cs, hash: Hs };
      }
      // Local differs from server's latest.
      if (baseVersion >= Cs) {
        return { action: "upload", currentVersion: Cs, hash: Hs };
      }
      // Server moved ahead since this client last synced.
      const baseHash = await hashOfVersion(gameId, baseVersion);
      if (hash && hash === baseHash) {
        // Client's local copy is unchanged, just stale -> safe to pull.
        return { action: "download", currentVersion: Cs, hash: Hs };
      }
      // Both sides differ. Normally a conflict — but if this game is in
      // newest-wins mode, ask the client to upload so the hub can compare the
      // two saves' modification times and keep the more recent one.
      if (game.overwriteStale) {
        return { action: "upload", currentVersion: Cs, hash: Hs };
      }
      return { action: "conflict", currentVersion: Cs, hash: Hs };
    },
  );

  /**
   * Upload a zipped save. Multipart: fields gameId, deviceId, baseVersion,
   * optional force=1; plus one file part ("save"). Server hashes the bytes
   * itself and runs the same decision logic as /check.
   */
  app.post("/api/sync/upload", async (req, reply) => {
    let gameId = 0;
    let deviceId = "";
    let baseVersion = 0;
    let force = false;
    let contentHash = "";
    let upload: { tmpPath: string; hash: string; size: number } | null = null;

    const parts = (req as any).parts();
    for await (const part of parts) {
      if (part.type === "file") {
        // Must consume the stream; store to temp (we decide its fate after).
        upload = await storeTemp(gameId || 0, deviceId || "unknown", part.file);
      } else {
        const v = String(part.value);
        if (part.fieldname === "gameId") gameId = Number(v);
        else if (part.fieldname === "deviceId") deviceId = v;
        else if (part.fieldname === "baseVersion") baseVersion = Number(v);
        else if (part.fieldname === "force") force = v === "1" || v === "true";
        else if (part.fieldname === "contentHash") contentHash = v;
      }
    }

    if (!gameId || !deviceId || !upload) {
      if (upload) await removeFile(upload.tmpPath);
      return reply.code(400).send({ error: "gameId, deviceId and a file are required" });
    }

    const game = await prisma.game.findUnique({ where: { id: gameId } });
    if (!game) {
      await removeFile(upload.tmpPath);
      return reply.code(404).send({ error: "game not found" });
    }

    const Cs = game.currentVersion;
    const Hs = await latestHash(gameId, Cs);
    // Prefer the client's deterministic content hash (stable across machines);
    // fall back to the server-computed zip hash for ad-hoc clients (e.g. curl).
    const Hc = contentHash || upload.hash;
    // Newest save-file time inside this upload (for newest-wins resolution).
    const uploadSavedAt = zipMaxModTime(upload.tmpPath);

    // Promote the temp upload to a new accepted version (shared by the
    // fast-forward and newest-wins-accept paths).
    const acceptUpload = async () => {
      const newVersion = Cs + 1;
      const storagePath = await promoteToSave(upload!.tmpPath, gameId, newVersion);
      await prisma.$transaction([
        prisma.saveVersion.create({
          data: {
            gameId,
            version: newVersion,
            hash: Hc,
            size: upload!.size,
            storagePath,
            deviceId,
            savedAt: uploadSavedAt ? new Date(uploadSavedAt) : null,
          },
        }),
        prisma.game.update({ where: { id: gameId }, data: { currentVersion: newVersion } }),
        prisma.gamePath.updateMany({
          where: { gameId, deviceId },
          data: { syncedVersion: newVersion, lastSynced: new Date() },
        }),
      ]);
      await broadcastSaveUpdate({ gameId, version: newVersion, hash: Hc, originDeviceId: deviceId });
      // Tell every open dashboard so it can play the "save -> cloud" animation.
      broadcastToAll({ type: "sync_event", gameId, gameName: game.name, version: newVersion, deviceId });
      return { action: "accepted", version: newVersion, hash: Hc };
    };

    // Identical to current server state -> nothing to do.
    if (Hc === Hs) {
      await removeFile(upload.tmpPath);
      await prisma.gamePath
        .updateMany({ where: { gameId, deviceId }, data: { syncedVersion: Cs, lastSynced: new Date() } })
        .catch(() => {});
      return { action: "up_to_date", version: Cs, hash: Hs };
    }

    const fastForward = Cs === 0 || baseVersion >= Cs || force;
    if (fastForward) {
      return await acceptUpload();
    }

    // baseVersion < Cs and content differs. If the client's bytes equal the
    // version it claims to be based on, it just needs to pull.
    const baseHash = await hashOfVersion(gameId, baseVersion);
    if (Hc === baseHash) {
      await removeFile(upload.tmpPath);
      return reply.code(409).send({ action: "download", currentVersion: Cs, hash: Hs });
    }

    // Newest-wins mode: both sides changed, so compare the saves' file times and
    // keep whichever is more recent. Ties / unknown times fall through to a
    // conflict so nothing is silently lost.
    if (game.overwriteStale) {
      const latestT = await versionSavedAt(gameId, Cs);
      if (uploadSavedAt && latestT != null && uploadSavedAt !== latestT) {
        if (uploadSavedAt > latestT) {
          return await acceptUpload(); // this device's save is newer -> it wins
        }
        await removeFile(upload.tmpPath); // hub's save is newer -> device pulls it
        return reply.code(409).send({ action: "download", currentVersion: Cs, hash: Hs });
      }
      // equal or unknown timestamps -> fall through to conflict
    }

    // True conflict: both sides changed. Keep the upload for manual recovery.
    const ts = Date.now();
    const storagePath = await promoteToConflict(upload.tmpPath, gameId, deviceId, ts);
    const conflict = await prisma.conflict.create({
      data: {
        gameId,
        deviceId,
        storagePath,
        hash: Hc,
        size: upload.size,
        baseVersion,
        serverVersion: Cs,
      },
    });
    return reply.code(409).send({
      action: "conflict",
      conflictId: conflict.id,
      currentVersion: Cs,
      hash: Hs,
    });
  });

  // Download the latest (or a specific) save version.
  app.get<{ Params: { gameId: string }; Querystring: { version?: string } }>(
    "/api/sync/download/:gameId",
    async (req, reply) => {
      const gameId = Number(req.params.gameId);
      const game = await prisma.game.findUnique({ where: { id: gameId } });
      if (!game || game.currentVersion === 0) return reply.code(404).send({ error: "no save" });
      const version = req.query.version ? Number(req.query.version) : game.currentVersion;
      const sv = await prisma.saveVersion.findUnique({
        where: { gameId_version: { gameId, version } },
      });
      if (!sv) return reply.code(404).send({ error: "version not found" });
      reply
        .header("Content-Type", "application/zip")
        .header("X-Save-Version", String(sv.version))
        .header("X-Save-Hash", sv.hash);
      return reply.send(readStream(sv.storagePath));
    },
  );

  // Client confirms it has applied a version (so the UI shows it in sync).
  app.post<{ Body: { gameId: number; deviceId: string; version: number } }>(
    "/api/sync/ack",
    async (req, reply) => {
      const { gameId, deviceId, version } = req.body ?? ({} as any);
      if (!gameId || !deviceId || !version) return reply.code(400).send({ error: "missing fields" });
      await prisma.gamePath
        .updateMany({ where: { gameId, deviceId }, data: { syncedVersion: version, lastSynced: new Date() } })
        .catch(() => {});
      return { ok: true };
    },
  );

  // --- Conflicts ---------------------------------------------------------
  app.get("/api/conflicts", async () => {
    return prisma.conflict.findMany({
      where: { resolved: false },
      include: { game: true },
      orderBy: { createdAt: "desc" },
    });
  });

  app.get<{ Params: { id: string } }>("/api/conflicts/:id/download", async (req, reply) => {
    const c = await prisma.conflict.findUnique({ where: { id: Number(req.params.id) } });
    if (!c) return reply.code(404).send({ error: "not found" });
    reply.header("Content-Type", "application/zip");
    return reply.send(readStream(c.storagePath));
  });

  // keep = "server" (discard the conflicting upload) | "client" (promote it).
  app.post<{ Params: { id: string }; Body: { keep: "server" | "client" } }>(
    "/api/conflicts/:id/resolve",
    async (req, reply) => {
      const id = Number(req.params.id);
      const c = await prisma.conflict.findUnique({ where: { id } });
      if (!c) return reply.code(404).send({ error: "not found" });

      if (req.body?.keep === "client") {
        const game = await prisma.game.findUnique({ where: { id: c.gameId } });
        const newVersion = (game?.currentVersion ?? 0) + 1;
        const storagePath = await promoteToSave(c.storagePath, c.gameId, newVersion);
        const savedMs = zipMaxModTime(storagePath);
        await prisma.$transaction([
          prisma.saveVersion.create({
            data: {
              gameId: c.gameId,
              version: newVersion,
              hash: c.hash,
              size: c.size,
              storagePath,
              deviceId: c.deviceId,
              savedAt: savedMs ? new Date(savedMs) : null,
            },
          }),
          prisma.game.update({ where: { id: c.gameId }, data: { currentVersion: newVersion } }),
          prisma.conflict.update({ where: { id }, data: { resolved: true } }),
        ]);
        await broadcastSaveUpdate({
          gameId: c.gameId,
          version: newVersion,
          hash: c.hash,
          originDeviceId: c.deviceId,
        });
        return { ok: true, version: newVersion };
      }

      // keep server: discard the rejected upload.
      await removeFile(c.storagePath);
      await prisma.conflict.update({ where: { id }, data: { resolved: true } });
      return { ok: true };
    },
  );
}
