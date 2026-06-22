# GameSync

Self-hosted hub + Windows client for **real-time game-save sync** across devices.

Change a save on one PC → the hub stores a new version → every other device with
that game configured downloads and applies it automatically (pushed over a
WebSocket, so it happens within seconds). Each game shows cover art fetched from
SteamGridDB, and every version is kept in a **Vault** you can browse, restore, or
prune.

```
            ┌──────────────────────────── CENTRAL HUB (Docker) ───────────────────────────┐
            │  Fastify API + WebSockets   ·   SQLite (Prisma)   ·   Web dashboard          │
            │  stores versioned save zips on a volume, fetches covers from SteamGridDB     │
            └───────────────▲───────────────────────────────────────▲─────────────────────┘
                            │ REST + WebSocket                        │ REST + WebSocket
            ┌───────────────┴───────────┐             ┌───────────────┴───────────┐
            │  Windows client  (PC-A)   │             │  Windows client  (PC-B)   │
            │  FileSystemWatcher + agent│             │  FileSystemWatcher + agent│
            └───────────────────────────┘             └───────────────────────────┘
```

## Features

- **Real-time sync** — a WebSocket push applies new saves on other devices within seconds; a periodic poll is the safety net.
- **Content-hash versioning** — saves are hashed by *content* (paths + sizes + per-file SHA-256), so the same save hashes identically on every machine, independent of zip/timestamp noise.
- **Safe conflict handling** — if two devices both changed since they last synced, nothing is silently overwritten: the upload is set aside and surfaced in a **Conflicts** tab. (Optional per-game "newest-wins" mode auto-keeps the newer save by file time — see [Troubleshooting](#troubleshooting).)
- **Vault** — a tab listing every game with its full version history. Per version: **download**, **restore** (roll back to it as a new current version, re-pushed to all devices), or **delete**. Per game: **prune** to keep only the newest N. The current version is always protected.
- **Cover art & search** via SteamGridDB.
- **Lossless apply** — the client preserves file timestamps/attributes and writes saves with the user's permissions, so a synced save is byte- and metadata-identical to a manual copy.
- **Lock-safe** — the client debounces file events, waits for the game process to exit, and confirms every file is readable before zipping.

## Repository layout

| Path      | What it is |
|-----------|------------|
| `hub/`    | Docker web app: API, database, dashboard, cover lookup, sync engine (TypeScript / Fastify / Prisma / SQLite). |
| `client/` | C# (.NET 8) Windows Service agent that watches save folders and syncs. |

---

## 1. Run the hub (Docker)

```bash
cd hub
cp .env.example .env          # then edit .env — see SteamGridDB below
docker compose up -d --build
```

Open the dashboard at **http://localhost:8080**.

Data (SQLite DB + save zips) lives in the `gamesync-data` Docker volume, so it
survives container rebuilds.

### SteamGridDB cover art  ← read this if covers / search "aren't connected"

The key is read **by the hub, server-side**, from the `STEAMGRIDDB_API_KEY`
environment variable. You do **not** type it into the browser.

1. Get a free key: https://www.steamgriddb.com/profile/preferences/api
2. Put it in `hub/.env`:
   ```
   STEAMGRIDDB_API_KEY=your_key_here
   ```
3. **Restart the hub** so it picks up the new value: `docker compose up -d`
4. Verify in the dashboard: **⚙ → SteamGridDB**. It shows ✅ connected,
   ❌ no key set, or ⚠ key rejected (with the exact SteamGridDB error).

> The **API token** field in ⚙ Settings is a *different* thing — an optional
> shared secret for locking down your hub (`API_TOKEN`), not the SteamGridDB key.

### Optional: lock down the hub

Set `API_TOKEN` in `.env` to require a bearer token. Then enter the same value in
the dashboard ⚙ Settings, and set it as `ApiToken` in each client's config.

---

## 2. Add a game

1. Dashboard → **Library → + Add game**.
2. Type the name; pick the game and a cover from SteamGridDB.
3. (Optional) set the **process name** (e.g. `witcher3.exe`) — the client waits
   for it to exit before syncing, avoiding file-lock corruption.
4. Open the game card and set the **save path per device**
   (e.g. `%USERPROFILE%\Saved Games\The Witcher 3`). Env vars like `%APPDATA%`,
   `%LOCALAPPDATA%`, `%USERPROFILE%` are resolved on each device.

---

## 3. Install the Windows client

Grab `GameSyncClient-win-x64.zip` from the [Releases](../../releases) page (or
the dashboard's **Setup** tab), unzip it, and run `Install-GameSync.cmd`. It
installs a self-contained Windows Service — no .NET runtime needed on the target.

> The hub image **bundles the matching client**, so the dashboard's **Setup**
> tab serves it for download out of the box — no extra steps on a fresh deploy.

Building from source instead:

```powershell
cd client
dotnet publish -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o publish
```

See [`client/README.md`](client/README.md) for configuration (`appsettings.json`)
and manual service install. On first launch the client registers itself and
appears under **Devices**.

---

## How sync stays correct

- **Content hashing** — each save is hashed by content (stable manifest of file
  paths + sizes + per-file SHA-256), so the same save hashes identically on every
  machine.
- **Optimistic versioning** — the hub keeps a monotonic `currentVersion` per game.
  A client uploads with the version it last synced ("base").
  - base == current → accepted as a new version, pushed to other devices.
  - client behind, local unchanged → it downloads.
  - **both** changed since the base → **conflict**: kept aside and surfaced in the
    dashboard *Conflicts* tab. Resolve with **Keep server** or **Keep theirs**.
    Nothing is ever silently overwritten.
- **File locks** — the client debounces, waits for the game process to exit, and
  confirms every file is readable before zipping.

---

## Troubleshooting

**A synced save loads as "unknown save" / "corrupted" on another device.**
Fixed in the current client. The agent runs as a LocalSystem service; earlier
builds staged the extracted save under `C:\Windows\Temp` and *moved* it into the
save folder, which carried SYSTEM-only permissions so the game (running as you)
couldn't read it. The client now *copies* files into the save folder, so they
inherit your user's permissions — exactly like a manual paste. Make sure both
devices run the latest client.

**An autosave overwrote my real progress.**
That happens with **newest-wins** mode (the per-game "let a newer save overwrite"
toggle) turned on. Resolution there compares the *save file's modification time*,
and an autosave always has the freshest timestamp even if it has less progress —
so it wins. For single-player games you play across devices, turn newest-wins
**off** so a divergence raises a conflict you resolve by hand instead.

**Saves piling up.** Open the **Vault** tab and use **Prune** to keep only the
newest N versions per game.

---

## Tech

- **Hub:** TypeScript, Fastify, `@fastify/websocket`, Prisma + SQLite, vanilla-JS
  dashboard (no build step), Docker.
- **Client:** C# / .NET 8 Worker Service, `FileSystemWatcher`, published as a
  self-contained single-file Windows executable.
