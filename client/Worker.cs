using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using Microsoft.Extensions.Logging;

namespace GameSync.Client;

/// <summary>
/// The agent. Registers the device, watches each configured save folder, and
/// reconciles with the hub: uploads local changes (after the game exits and the
/// files unlock) and applies remote changes pushed over the WebSocket.
/// </summary>
public sealed class Worker : BackgroundService
{
    private readonly ILogger<Worker> _log;
    private readonly HubClient _hub;
    private readonly LocalState _state;
    private readonly GameSyncOptions _opts;

    private readonly string _deviceId;
    private List<Assignment> _assignments = new();
    private readonly List<FileSystemWatcher> _watchers = new();

    // Per-game serialization + debounce.
    private readonly ConcurrentDictionary<int, SemaphoreSlim> _locks = new();
    private readonly ConcurrentDictionary<int, Timer> _debounce = new();

    public Worker(ILogger<Worker> log, HubClient hub, LocalState state, GameSyncOptions opts)
    {
        _log = log;
        _hub = hub;
        _state = state;
        _opts = opts;
        _deviceId = string.IsNullOrWhiteSpace(opts.DeviceId) ? Environment.MachineName : opts.DeviceId;
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        var name = string.IsNullOrWhiteSpace(_opts.DeviceName) ? _deviceId : _opts.DeviceName;
        _log.LogInformation("GameSync client starting as device '{Id}' ({Name})", _deviceId, name);

        await RetryRegister(name, ct);
        await RefreshAssignments(ct);

        // Push channel: react instantly to other devices' uploads.
        _ = _hub.RunWebSocketAsync(_deviceId, OnHubMessage, ct);

        // Initial full reconcile so we catch up on anything missed while offline.
        await ReconcileAll(ct);

        // Periodic poll: re-read assignments and reconcile (safety net + picks up
        // newly configured games / paths from the web UI).
        while (!ct.IsCancellationRequested)
        {
            try { await Task.Delay(TimeSpan.FromSeconds(_opts.PollSeconds), ct); }
            catch (OperationCanceledException) { break; }
            await RefreshAssignments(ct);
            await ReconcileAll(ct);
        }

        foreach (var w in _watchers) w.Dispose();
    }

    private async Task RetryRegister(string name, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await _hub.RegisterDeviceAsync(_deviceId, name, ct);
                _log.LogInformation("Registered with hub");
                return;
            }
            catch (Exception ex)
            {
                _log.LogWarning("Hub not reachable ({Msg}); retrying in 10s", ex.Message);
                try { await Task.Delay(TimeSpan.FromSeconds(10), ct); } catch { return; }
            }
        }
    }

    private async Task RefreshAssignments(CancellationToken ct)
    {
        try
        {
            _assignments = await _hub.GetAssignmentsAsync(_deviceId, ct);
            SetupWatchers();
            _log.LogInformation("Loaded {Count} game assignment(s)", _assignments.Count);
        }
        catch (Exception ex)
        {
            _log.LogWarning("Failed to load assignments: {Msg}", ex.Message);
        }
    }

    private void SetupWatchers()
    {
        foreach (var w in _watchers) w.Dispose();
        _watchers.Clear();

        foreach (var a in _assignments)
        {
            if (!a.AutoSync)
            {
                _log.LogInformation("Auto-sync disabled for '{Game}'; not watching", a.Name);
                continue;
            }
            var path = PathResolver.Resolve(a.LocalPath);
            if (!Directory.Exists(path))
            {
                _log.LogInformation("Save path for '{Game}' not present yet: {Path}", a.Name, path);
                continue;
            }
            try
            {
                var watcher = new FileSystemWatcher(path)
                {
                    IncludeSubdirectories = true,
                    NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName |
                                   NotifyFilters.DirectoryName | NotifyFilters.Size,
                    EnableRaisingEvents = true,
                };
                var gameId = a.GameId;
                watcher.Changed += (_, _) => OnLocalChange(gameId);
                watcher.Created += (_, _) => OnLocalChange(gameId);
                watcher.Deleted += (_, _) => OnLocalChange(gameId);
                watcher.Renamed += (_, _) => OnLocalChange(gameId);
                _watchers.Add(watcher);
            }
            catch (Exception ex)
            {
                _log.LogWarning("Could not watch {Path}: {Msg}", path, ex.Message);
            }
        }
    }

    // Debounce: collapse a burst of file events into a single sync after the
    // folder has been quiet for DebounceSeconds.
    private void OnLocalChange(int gameId)
    {
        var timer = _debounce.GetOrAdd(gameId, _ => new Timer(_ => OnDebounceElapsed(gameId), null, Timeout.Infinite, Timeout.Infinite));
        timer.Change(TimeSpan.FromSeconds(_opts.DebounceSeconds), Timeout.InfiniteTimeSpan);
    }

    private async void OnDebounceElapsed(int gameId)
    {
        var a = _assignments.FirstOrDefault(x => x.GameId == gameId);
        if (a == null || !a.AutoSync) return;
        try { await SyncGame(a, CancellationToken.None); }
        catch (Exception ex) { _log.LogError(ex, "Sync failed for '{Game}'", a.Name); }
    }

    private async Task OnHubMessage(WsMessage msg, Func<object, Task> send)
    {
        switch (msg.Type)
        {
            case "save_updated":
                if (msg.OriginDeviceId == _deviceId) return; // our own upload
                var a = _assignments.FirstOrDefault(x => x.GameId == msg.GameId);
                if (a == null || !a.AutoSync) return;
                _log.LogInformation("Hub pushed new save for '{Game}' (v{V}) — pulling", a.Name, msg.Version);
                try { await SyncGame(a, CancellationToken.None); }
                catch (Exception ex) { _log.LogError(ex, "Pull failed for '{Game}'", a.Name); }
                break;

            case "browse":
                await HandleBrowse(msg, send);
                break;
        }
    }

    // Respond to a hub "browse" request with the folders at the given path so the
    // dashboard's path picker can navigate this device's real filesystem.
    private async Task HandleBrowse(WsMessage msg, Func<object, Task> send)
    {
        var raw = msg.Path ?? "";
        _log.LogInformation("Browse request from hub for path '{Path}' (reqId {ReqId})", raw, msg.ReqId);
        try
        {
            if (string.IsNullOrWhiteSpace(raw))
            {
                await send(new
                {
                    type = "browse_result",
                    reqId = msg.ReqId,
                    path = "",
                    parent = (string?)null,
                    roots = CommonRoots(),
                    entries = Array.Empty<BrowseEntry>(),
                });
                return;
            }

            var path = PathResolver.Resolve(raw);

            // Listing can block on slow/network paths; bound it so we always
            // reply before the hub times out (5s budget against an 8s timeout).
            var listTask = Task.Run(() =>
            {
                var dirs = Directory.GetDirectories(path)
                    .Select(d => new BrowseEntry { Name = Path.GetFileName(d), Path = d, IsDir = true })
                    .OrderBy(e => e.Name, StringComparer.OrdinalIgnoreCase);
                var files = Directory.GetFiles(path)
                    .Select(f => new BrowseEntry { Name = Path.GetFileName(f), Path = f, IsDir = false })
                    .OrderBy(e => e.Name, StringComparer.OrdinalIgnoreCase);
                return dirs.Concat(files).ToArray();
            });
            if (!listTask.Wait(TimeSpan.FromSeconds(5)))
            {
                await send(new { type = "browse_result", reqId = msg.ReqId, path = raw, error = "listing this folder timed out" });
                return;
            }

            await send(new
            {
                type = "browse_result",
                reqId = msg.ReqId,
                path,
                parent = Directory.GetParent(path)?.FullName,
                roots = Array.Empty<object>(),
                entries = listTask.Result,
            });
        }
        catch (Exception ex)
        {
            await send(new { type = "browse_result", reqId = msg.ReqId, path = raw, error = ex.Message });
        }
    }

    private static object[] CommonRoots()
    {
        var roots = new List<object>();
        void Add(string name, string p) { if (!string.IsNullOrEmpty(p)) roots.Add(new { name, path = p }); }
        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        Add("User folder", profile);
        Add("Documents", Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments));
        Add("Saved Games", string.IsNullOrEmpty(profile) ? "" : Path.Combine(profile, "Saved Games"));
        Add("AppData (Roaming)", Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData));
        Add("AppData (Local)", Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));

        // Drive enumeration can BLOCK on disconnected mapped network drives
        // (DriveInfo.IsReady waits for the network). That would stall the whole
        // browse reply and the hub would time out, leaving the picker spinning
        // forever. Bound it: collect drives on a worker and give up after 3s so
        // we always answer with at least the user-folder shortcuts above.
        try
        {
            var driveTask = Task.Run(() =>
            {
                var list = new List<(string Name, string Path)>();
                foreach (var d in DriveInfo.GetDrives())
                {
                    try
                    {
                        if (d.IsReady) list.Add(($"Drive {d.Name}", d.RootDirectory.FullName));
                    }
                    catch { /* skip a drive that errors */ }
                }
                return list;
            });
            if (driveTask.Wait(TimeSpan.FromSeconds(3)))
                foreach (var d in driveTask.Result) Add(d.Name, d.Path);
        }
        catch { /* ignore */ }
        return roots.ToArray();
    }

    private async Task ReconcileAll(CancellationToken ct)
    {
        foreach (var a in _assignments)
        {
            if (!a.AutoSync) continue;
            try { await SyncGame(a, ct); }
            catch (Exception ex) { _log.LogError(ex, "Reconcile failed for '{Game}'", a.Name); }
        }
    }

    /// <summary>Core reconcile for one game: ask the hub what to do, then do it.</summary>
    private async Task SyncGame(Assignment a, CancellationToken ct)
    {
        var gate = _locks.GetOrAdd(a.GameId, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct);
        try
        {
            var path = PathResolver.Resolve(a.LocalPath);
            var localHash = SyncEngine.ComputeContentHash(path);
            var st = _state.Get(a.GameId);

            var check = await _hub.CheckAsync(a.GameId, _deviceId, localHash, st.SyncedVersion, ct);
            if (check == null) return;

            switch (check.Action)
            {
                case "download":
                    await DoDownload(a, path, ct);
                    break;

                case "upload":
                case "conflict":
                    if (string.IsNullOrEmpty(localHash))
                    {
                        _log.LogDebug("Nothing to upload for '{Game}' (no local save)", a.Name);
                        break;
                    }
                    await DoUpload(a, path, localHash, st.SyncedVersion, ct);
                    break;

                case "up_to_date":
                default:
                    // Persist the agreed version so future checks have a correct base.
                    if (check.CurrentVersion > 0)
                        _state.Set(a.GameId, check.CurrentVersion, localHash);
                    break;
            }
        }
        finally { gate.Release(); }
    }

    private async Task DoUpload(Assignment a, string path, string localHash, int baseVersion, CancellationToken ct)
    {
        if (!await WaitUntilSyncSafe(a, path, ct))
        {
            _log.LogInformation("Save for '{Game}' still busy/locked; will retry on next change", a.Name);
            return;
        }

        var zip = SyncEngine.CreateZip(path);
        try
        {
            var (status, result) = await _hub.UploadAsync(a.GameId, _deviceId, baseVersion, localHash, zip, ct);
            if (status == HttpStatusCode.OK && result != null)
            {
                if (result.Action == "accepted")
                {
                    _state.Set(a.GameId, result.Version, localHash);
                    _log.LogInformation("Uploaded '{Game}' as v{V}", a.Name, result.Version);
                    // The game just exited and its save is safely up — pop the hub so
                    // the user sees the sync (only for games with a tracked process,
                    // so periodic/background uploads don't open the browser).
                    if (_opts.OpenHubOnGameExit && !string.IsNullOrWhiteSpace(a.ProcessName))
                    {
                        var url = $"{_opts.HubUrl.TrimEnd('/')}/?synced={a.GameId}&v={result.Version}";
                        UserNotifier.OpenUrl(url);
                    }
                }
                else if (result.Action == "up_to_date")
                {
                    _state.Set(a.GameId, result.Version, localHash);
                }
            }
            else if (status == HttpStatusCode.Conflict && result != null)
            {
                if (result.Action == "download")
                {
                    await DoDownload(a, path, ct);
                }
                else
                {
                    _log.LogWarning("Conflict for '{Game}' (#{Id}) — resolve it in the hub UI",
                        a.Name, result.ConflictId);
                }
            }
            else
            {
                _log.LogWarning("Upload for '{Game}' returned {Status}", a.Name, status);
            }
        }
        finally
        {
            try { File.Delete(zip); } catch { }
        }
    }

    private async Task DoDownload(Assignment a, string path, CancellationToken ct)
    {
        var tmp = Path.Combine(Path.GetTempPath(), $"gamesync-dl-{Guid.NewGuid():N}.zip");
        try
        {
            var version = await _hub.DownloadAsync(a.GameId, tmp, ct);
            SyncEngine.ApplyZip(tmp, path);
            var newHash = SyncEngine.ComputeContentHash(path);
            _state.Set(a.GameId, version, newHash);
            await _hub.AckAsync(a.GameId, _deviceId, version, ct);
            _log.LogInformation("Applied '{Game}' v{V} from hub", a.Name, version);
            // The folder may have just been created (first pull) — make sure it's watched.
            SetupWatchers();
        }
        finally
        {
            try { File.Delete(tmp); } catch { }
        }
    }

    /// <summary>
    /// Wait until it's safe to read the save: the game process (if known) has
    /// exited, and every file in the folder can be opened. Bounded retries so a
    /// permanently-locked file doesn't hang the agent forever.
    /// </summary>
    private async Task<bool> WaitUntilSyncSafe(Assignment a, string path, CancellationToken ct)
    {
        if (_opts.WaitForProcessExit && !string.IsNullOrWhiteSpace(a.ProcessName))
        {
            var procName = Path.GetFileNameWithoutExtension(a.ProcessName);
            for (var i = 0; i < 120 && IsRunning(procName); i++) // up to ~10 min
            {
                _log.LogDebug("Waiting for '{Proc}' to exit before syncing '{Game}'", procName, a.Name);
                try { await Task.Delay(TimeSpan.FromSeconds(5), ct); } catch { return false; }
            }
        }

        for (var i = 0; i < 6; i++)
        {
            if (SyncEngine.IsReadable(path)) return true;
            try { await Task.Delay(TimeSpan.FromSeconds(2), ct); } catch { return false; }
        }
        return SyncEngine.IsReadable(path);
    }

    private static bool IsRunning(string processName)
    {
        try { return Process.GetProcessesByName(processName).Length > 0; }
        catch { return false; }
    }
}
