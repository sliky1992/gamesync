import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { config } from "./config.js";

export async function ensureStorage() {
  await fsp.mkdir(path.join(config.storageDir, "saves"), { recursive: true });
  await fsp.mkdir(path.join(config.storageDir, "conflicts"), { recursive: true });
  await fsp.mkdir(path.join(config.storageDir, "tmp"), { recursive: true });
  await fsp.mkdir(path.join(config.storageDir, "downloads"), { recursive: true });
}

export async function ensureStorageTmp() {
  await fsp.mkdir(path.join(config.storageDir, "tmp"), { recursive: true });
}

function savePath(gameId: number, version: number) {
  return path.join(config.storageDir, "saves", `game-${gameId}-v${version}.zip`);
}

function conflictPath(gameId: number, deviceId: string, ts: number) {
  const safeDevice = deviceId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(config.storageDir, "conflicts", `game-${gameId}-${safeDevice}-${ts}.zip`);
}

/**
 * Stream an incoming upload to disk while hashing it. Returns the final path,
 * sha256 hex hash, and byte size. We hash server-side so we never trust the
 * client's claimed hash for the stored record.
 */
async function streamToFile(stream: NodeJS.ReadableStream, dest: string) {
  const hash = createHash("sha256");
  let size = 0;
  stream.on("data", (chunk: Buffer) => {
    size += chunk.length;
    hash.update(chunk);
  });
  await pipeline(stream, fs.createWriteStream(dest));
  return { hash: hash.digest("hex"), size };
}

/**
 * Stream an upload to a temp file first (we don't yet know whether it becomes a
 * new version or a conflict, and multipart fields may arrive after the file).
 * Caller then promotes it with promoteToSave/promoteToConflict.
 */
export async function storeTemp(gameId: number, deviceId: string, stream: NodeJS.ReadableStream) {
  const safe = deviceId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const dest = path.join(config.storageDir, "tmp", `up-${gameId}-${safe}-${process.hrtime.bigint()}.zip`);
  const { hash, size } = await streamToFile(stream, dest);
  return { tmpPath: dest, hash, size };
}

export async function promoteToSave(tmpPath: string, gameId: number, version: number) {
  const dest = savePath(gameId, version);
  await fsp.rename(tmpPath, dest);
  return dest;
}

export async function promoteToConflict(tmpPath: string, gameId: number, deviceId: string, ts: number) {
  const dest = conflictPath(gameId, deviceId, ts);
  await fsp.rename(tmpPath, dest);
  return dest;
}

export function readStream(storagePath: string) {
  return fs.createReadStream(storagePath);
}

/**
 * Copy an existing version's zip to a fresh version slot. Used by "restore":
 * rolling an old save back becomes a new monotonic version pointing at the same
 * bytes, so the optimistic-versioning invariants are preserved.
 */
export async function copyToNewVersion(srcStoragePath: string, gameId: number, version: number) {
  const dest = savePath(gameId, version);
  await fsp.copyFile(srcStoragePath, dest);
  return dest;
}

/**
 * Newest file modification time (epoch ms) recorded inside a zip, read from its
 * central directory (no decompression, no dependency). Returns 0 if it can't be
 * determined. DOS timestamps are local-time with 2s resolution; we interpret
 * them as UTC purely so comparisons between two saves are consistent/orderable.
 */
export function zipMaxModTime(zipPath: string): number {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(zipPath);
  } catch {
    return 0;
  }
  // Find End Of Central Directory (sig 0x06054b50), scanning back from the end.
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return 0;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16); // central directory start
  const CEN = 0x02014b50;
  let max = 0;
  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== CEN) break;
    const dosTime = buf.readUInt16LE(off + 12);
    const dosDate = buf.readUInt16LE(off + 14);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const year = ((dosDate >> 9) & 0x7f) + 1980;
    const month = (dosDate >> 5) & 0x0f;
    const day = dosDate & 0x1f;
    const hour = (dosTime >> 11) & 0x1f;
    const min = (dosTime >> 5) & 0x3f;
    const sec = (dosTime & 0x1f) * 2;
    if (month >= 1 && day >= 1) {
      const t = Date.UTC(year, month - 1, day, hour, min, sec);
      if (t > max) max = t;
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return max;
}

export async function removeFile(storagePath: string) {
  await fsp.rm(storagePath, { force: true });
}
