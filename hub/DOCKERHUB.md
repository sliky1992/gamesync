# GameSync Hub

Self-hosted hub for **real-time game-save sync** across devices. This image is the
central server: a Fastify API + WebSocket sync engine, a SQLite database (Prisma),
and a web dashboard. Pair it with the **Windows client** to sync game saves between
PCs automatically.

📦 **Source, full docs & Windows client:** https://github.com/sliky1992/gamesync

---

## Quick start

```bash
docker run -d --name gamesync-hub \
  -p 8080:8080 \
  -v gamesync-data:/data \
  -e STEAMGRIDDB_API_KEY=your_key_here \
  --restart unless-stopped \
  sliky1992/gamesync-hub:latest
```

Open the dashboard at **http://localhost:8080**.

Or with Docker Compose:

```yaml
services:
  hub:
    image: sliky1992/gamesync-hub:latest
    container_name: gamesync-hub
    ports:
      - "8080:8080"
    environment:
      STEAMGRIDDB_API_KEY: "${STEAMGRIDDB_API_KEY:-}"
      API_TOKEN: "${API_TOKEN:-}"
    volumes:
      - gamesync-data:/data
    restart: unless-stopped

volumes:
  gamesync-data:
```

---

## Configuration

| Env var               | Default                | Purpose |
|-----------------------|------------------------|---------|
| `STEAMGRIDDB_API_KEY` | _(empty)_              | Free key from [SteamGridDB](https://www.steamgriddb.com/profile/preferences/api) for cover art & search. Read server-side. |
| `API_TOKEN`           | _(empty)_              | Optional shared secret. If set, clients and the dashboard must send it as a bearer token. |
| `MAX_UPLOAD_BYTES`    | `536870912` (512 MB)   | Max save-upload size. |
| `DATABASE_URL`        | `file:/data/gamesync.db` | SQLite location (inside the volume). |
| `STORAGE_DIR`         | `/data/storage`        | Where versioned save zips are stored (inside the volume). |
| `PORT`                | `8080`                 | HTTP/WebSocket port. |

- **Port:** `8080` (HTTP + WebSocket).
- **Volume:** `/data` — holds the SQLite DB and all save versions. Back this up; it's your data.

---

## Tags

- `latest`, `1.0.1` — `linux/amd64`.
- `1.0.0` — previous release.

## What's new

**1.0.1** — Bundles Windows client **1.0.1**, which fixes a device showing
**offline** in the hub even though its service is running: if the client's
WebSocket connection died silently (PC sleep, network re-route, Wi-Fi drop) it
could block forever and never reconnect. The client now runs an application-level
heartbeat and reconnects when the link goes dead. (The hub server itself is
unchanged; update your Windows clients to 1.0.1 from the **Setup** tab or GitHub
Releases.)

---

## What it does

- **Real-time sync** — pushes new saves to other devices over a WebSocket within seconds.
- **Content-hash versioning** — same save hashes identically on every machine; safe conflict handling (nothing silently overwritten).
- **Vault** — browse every saved version per game: download, restore (roll back), or prune.
- **SteamGridDB** cover art and search.

To sync a machine, install the **Windows client** from the
[GitHub Releases](https://github.com/sliky1992/gamesync/releases) page (or the
dashboard's **Setup** tab) and point it at this hub.
