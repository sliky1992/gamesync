import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";

/**
 * Optional bearer-token gate. If API_TOKEN is unset the hub is open (fine for a
 * trusted LAN); if set, every /api request must send `Authorization: Bearer <token>`.
 * The web UI reads the token from localStorage and sends it too.
 */
export async function requireToken(req: FastifyRequest, reply: FastifyReply) {
  if (!config.apiToken) return;
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== config.apiToken) {
    reply.code(401).send({ error: "unauthorized" });
  }
}

export function tokenOk(token: string | undefined) {
  if (!config.apiToken) return true;
  return token === config.apiToken;
}
