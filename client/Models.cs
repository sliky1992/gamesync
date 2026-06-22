using System.Text.Json.Serialization;

namespace GameSync.Client;

public sealed class GameSyncOptions
{
    public string HubUrl { get; set; } = "http://localhost:8080";
    public string ApiToken { get; set; } = "";
    // Stable unique id for this device. Defaults to the machine name.
    public string DeviceId { get; set; } = "";
    public string DeviceName { get; set; } = "";
    public int DebounceSeconds { get; set; } = 8;
    public int PollSeconds { get; set; } = 300;
    public bool WaitForProcessExit { get; set; } = true;
    // After a game exits and its save uploads, open the hub dashboard in the
    // user's browser so they see the sync confirmation/animation.
    public bool OpenHubOnGameExit { get; set; } = true;
}

// A game this device is configured to sync (from GET /api/sync/assignments).
public sealed class Assignment
{
    [JsonPropertyName("gameId")] public int GameId { get; set; }
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("localPath")] public string LocalPath { get; set; } = "";
    [JsonPropertyName("processName")] public string? ProcessName { get; set; }
    // When false the game is mapped but the client never auto-syncs it.
    [JsonPropertyName("autoSync")] public bool AutoSync { get; set; } = true;
    [JsonPropertyName("currentVersion")] public int CurrentVersion { get; set; }
    [JsonPropertyName("syncedVersion")] public int SyncedVersion { get; set; }
}

public sealed class DeviceDto
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
}

// Response from /api/sync/check and /api/sync/upload.
public sealed class SyncResult
{
    [JsonPropertyName("action")] public string Action { get; set; } = "";
    [JsonPropertyName("currentVersion")] public int CurrentVersion { get; set; }
    [JsonPropertyName("version")] public int Version { get; set; }
    [JsonPropertyName("hash")] public string? Hash { get; set; }
    [JsonPropertyName("conflictId")] public int? ConflictId { get; set; }
}

// WebSocket message envelope from the hub.
public sealed class WsMessage
{
    [JsonPropertyName("type")] public string Type { get; set; } = "";
    [JsonPropertyName("gameId")] public int GameId { get; set; }
    [JsonPropertyName("version")] public int Version { get; set; }
    [JsonPropertyName("hash")] public string? Hash { get; set; }
    [JsonPropertyName("originDeviceId")] public string? OriginDeviceId { get; set; }
    // Request/response correlation (e.g. folder browsing).
    [JsonPropertyName("reqId")] public string? ReqId { get; set; }
    [JsonPropertyName("path")] public string? Path { get; set; }
}

public sealed class BrowseEntry
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("path")] public string Path { get; set; } = "";
    [JsonPropertyName("isDir")] public bool IsDir { get; set; }
}

// Persisted per-game local state (what version/content this device holds).
public sealed class GameState
{
    public int SyncedVersion { get; set; }
    public string ContentHash { get; set; } = "";
}
