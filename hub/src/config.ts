import path from "node:path";

export const config = {
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? "0.0.0.0",
  // Where uploaded save zips and conflict files live (mount as a Docker volume).
  storageDir: process.env.STORAGE_DIR ?? path.resolve("storage"),
  steamGridDbKey: process.env.STEAMGRIDDB_API_KEY ?? "",
  // Optional shared secret required from clients (sent as Bearer token).
  apiToken: process.env.API_TOKEN ?? "",
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 512 * 1024 * 1024),
};
