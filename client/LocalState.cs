using System.Text.Json;

namespace GameSync.Client;

/// <summary>
/// Persists, per game, the version this device last applied and the content
/// hash it had at that point. This is the "base version" used for optimistic
/// concurrency, and lets the watcher tell a real change from a sync-induced one.
/// </summary>
public sealed class LocalState
{
    private readonly string _file;
    private readonly object _lock = new();
    private Dictionary<int, GameState> _state = new();

    public LocalState()
    {
        var dir = Environment.GetEnvironmentVariable("GAMESYNC_STATE_DIR")
                  ?? Path.Combine(
                      Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                      "GameSync");
        Directory.CreateDirectory(dir);
        _file = Path.Combine(dir, "state.json");
        Load();
    }

    private void Load()
    {
        try
        {
            if (File.Exists(_file))
                _state = JsonSerializer.Deserialize<Dictionary<int, GameState>>(File.ReadAllText(_file))
                         ?? new();
        }
        catch { _state = new(); }
    }

    private void Save()
    {
        File.WriteAllText(_file, JsonSerializer.Serialize(_state,
            new JsonSerializerOptions { WriteIndented = true }));
    }

    public GameState Get(int gameId)
    {
        lock (_lock)
            return _state.TryGetValue(gameId, out var s) ? s : new GameState();
    }

    public void Set(int gameId, int version, string contentHash)
    {
        lock (_lock)
        {
            _state[gameId] = new GameState { SyncedVersion = version, ContentHash = contentHash };
            Save();
        }
    }
}
