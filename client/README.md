# GameSync Windows Client

A lightweight .NET 8 agent that watches your game-save folders and syncs them
with the GameSync hub. Runs as a **Windows Service** (or as a console app for
testing). Works on Linux too for development.

## Configuration

Edit `appsettings.json` (or override any value with an environment variable using
`GameSync__<Key>`, e.g. `GameSync__HubUrl`):

| Setting              | Default                  | Meaning |
|----------------------|--------------------------|---------|
| `HubUrl`             | `http://localhost:8080`  | Base URL of the hub. |
| `ApiToken`           | `""`                     | Bearer token, only if the hub sets `API_TOKEN`. |
| `DeviceId`           | machine name             | Stable unique id for this device. |
| `DeviceName`         | machine name             | Friendly name shown in the dashboard. |
| `DebounceSeconds`    | `8`                      | Quiet period after the last file change before syncing. |
| `PollSeconds`        | `300`                    | Safety-net reconcile interval (WebSocket handles real-time). |
| `WaitForProcessExit` | `true`                   | Wait for the game's process (set per game on the hub) to exit before syncing. |

## Build & run (development)

```bash
dotnet build -c Release
dotnet bin/Release/net8.0/GameSync.Client.dll
```

It registers with the hub, then appears under **Devices** in the dashboard. Map a
save path to this device on each game's card, and sync begins.

## Install as a Windows Service

Publish a self-contained binary, then register it with `sc.exe`:

```powershell
dotnet publish -c Release -r win-x64 --self-contained false -o C:\Program Files\GameSync

sc.exe create GameSync binPath= "C:\Program Files\GameSync\GameSync.Client.exe" start= auto
sc.exe start GameSync
```

Put your `appsettings.json` next to the exe. Logs go to the Windows Event Log
(and stdout when run from a console).

To update settings: edit `appsettings.json`, then `sc.exe stop GameSync` /
`sc.exe start GameSync`.

To remove: `sc.exe delete GameSync`.

## What it does

- Fetches its assignments (`GET /api/sync/assignments`) — the games + local paths
  configured for this device on the hub.
- Watches each folder with `FileSystemWatcher`; on change (debounced, after the
  game exits and files unlock) it uploads a new version.
- Holds a WebSocket to the hub; when another device uploads, it downloads and
  applies the new save in place (preserving the folder so the watcher keeps
  working).
- Persists per-game sync state under `%ProgramData%\GameSync\state.json`
  (override with the `GAMESYNC_STATE_DIR` env var).
