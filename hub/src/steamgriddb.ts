import { config } from "./config.js";

const BASE = "https://www.steamgriddb.com/api/v2";

export interface SgdbGame {
  id: number;
  name: string;
  release_date?: number;
}

export interface SgdbGrid {
  id: number;
  url: string;
  thumb: string;
  width: number;
  height: number;
}

function authHeaders() {
  if (!config.steamGridDbKey) {
    throw new Error(
      "STEAMGRIDDB_API_KEY is not set. Get a free key at https://www.steamgriddb.com/profile/preferences/api",
    );
  }
  return { Authorization: `Bearer ${config.steamGridDbKey}` };
}

async function sgdbFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`SteamGridDB ${res.status} for ${path}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { success: boolean; data: T; errors?: string[] };
  if (!json.success) {
    throw new Error(`SteamGridDB error: ${(json.errors ?? []).join(", ")}`);
  }
  return json.data;
}

/** Autocomplete search by game name. */
export function searchGames(term: string): Promise<SgdbGame[]> {
  return sgdbFetch<SgdbGame[]>(`/search/autocomplete/${encodeURIComponent(term)}`);
}

/** Vertical cover art (600x900) for a SteamGridDB game id. */
export function getCovers(gameId: number): Promise<SgdbGrid[]> {
  return sgdbFetch<SgdbGrid[]>(`/grids/game/${gameId}?dimensions=600x900&types=static`);
}

/** Whether a key is configured at all. */
export function isConfigured() {
  return Boolean(config.steamGridDbKey);
}

/** Live check: is the key present AND accepted by SteamGridDB? */
export async function testKey(): Promise<{ configured: boolean; ok: boolean; error?: string }> {
  if (!config.steamGridDbKey) {
    return { configured: false, ok: false, error: "STEAMGRIDDB_API_KEY is not set on the hub" };
  }
  try {
    await searchGames("the witcher 3");
    return { configured: true, ok: true };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const hint = msg.includes("401") || msg.includes("403") ? " (key rejected — check it's correct)" : "";
    return { configured: true, ok: false, error: msg + hint };
  }
}

/** Convenience: best cover URL for a game name, or null if nothing found. */
export async function bestCoverForName(name: string): Promise<{ steamGridId: number; coverUrl: string } | null> {
  const matches = await searchGames(name);
  if (matches.length === 0) return null;
  const game = matches[0];
  const covers = await getCovers(game.id).catch(() => [] as SgdbGrid[]);
  if (covers.length === 0) return null;
  return { steamGridId: game.id, coverUrl: covers[0].url };
}
