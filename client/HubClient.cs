using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace GameSync.Client;

/// <summary>Talks to the GameSync hub over REST and a persistent WebSocket.</summary>
public sealed class HubClient
{
    private readonly HttpClient _http;
    private readonly GameSyncOptions _opts;
    private readonly ILogger<HubClient> _log;

    public HubClient(HttpClient http, GameSyncOptions opts, ILogger<HubClient> log)
    {
        _opts = opts;
        _log = log;
        _http = http;
        _http.BaseAddress = new Uri(_opts.HubUrl.TrimEnd('/') + "/");
        if (!string.IsNullOrEmpty(_opts.ApiToken))
            _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _opts.ApiToken);
    }

    public async Task<DeviceDto?> RegisterDeviceAsync(string id, string name, CancellationToken ct)
    {
        var res = await _http.PostAsJsonAsync("api/devices/register", new { id, name }, ct);
        res.EnsureSuccessStatusCode();
        return await res.Content.ReadFromJsonAsync<DeviceDto>(cancellationToken: ct);
    }

    public async Task<List<Assignment>> GetAssignmentsAsync(string deviceId, CancellationToken ct)
    {
        return await _http.GetFromJsonAsync<List<Assignment>>(
                   $"api/sync/assignments?deviceId={Uri.EscapeDataString(deviceId)}", ct)
               ?? new();
    }

    public async Task<SyncResult?> CheckAsync(int gameId, string deviceId, string hash, int baseVersion, CancellationToken ct)
    {
        var res = await _http.PostAsJsonAsync("api/sync/check",
            new { gameId, deviceId, hash, baseVersion }, ct);
        res.EnsureSuccessStatusCode();
        return await res.Content.ReadFromJsonAsync<SyncResult>(cancellationToken: ct);
    }

    public async Task<(HttpStatusCode Status, SyncResult? Result)> UploadAsync(
        int gameId, string deviceId, int baseVersion, string contentHash, string zipPath, CancellationToken ct)
    {
        using var form = new MultipartFormDataContent
        {
            { new StringContent(gameId.ToString()), "gameId" },
            { new StringContent(deviceId), "deviceId" },
            { new StringContent(baseVersion.ToString()), "baseVersion" },
            { new StringContent(contentHash), "contentHash" },
        };
        await using var fs = File.OpenRead(zipPath);
        var fileContent = new StreamContent(fs);
        fileContent.Headers.ContentType = new MediaTypeHeaderValue("application/zip");
        form.Add(fileContent, "save", "save.zip");

        var res = await _http.PostAsync("api/sync/upload", form, ct);
        SyncResult? result = null;
        try { result = await res.Content.ReadFromJsonAsync<SyncResult>(cancellationToken: ct); }
        catch { /* non-JSON body */ }
        return (res.StatusCode, result);
    }

    /// <summary>Downloads the latest save zip; returns the server version applied.</summary>
    public async Task<int> DownloadAsync(int gameId, string destZipPath, CancellationToken ct)
    {
        using var res = await _http.GetAsync($"api/sync/download/{gameId}",
            HttpCompletionOption.ResponseHeadersRead, ct);
        res.EnsureSuccessStatusCode();
        var version = 0;
        if (res.Headers.TryGetValues("X-Save-Version", out var vals))
            int.TryParse(vals.FirstOrDefault(), out version);
        await using (var fs = File.Create(destZipPath))
            await res.Content.CopyToAsync(fs, ct);
        return version;
    }

    public async Task AckAsync(int gameId, string deviceId, int version, CancellationToken ct)
    {
        await _http.PostAsJsonAsync("api/sync/ack", new { gameId, deviceId, version }, ct);
    }

    /// <summary>
    /// Maintains a WebSocket to the hub and invokes <paramref name="onMessage"/>
    /// for each frame. The handler is given a <c>send</c> delegate so it can
    /// reply (e.g. to a browse request). Reconnects with backoff until cancelled.
    /// </summary>
    public async Task RunWebSocketAsync(
        string deviceId,
        Func<WsMessage, Func<object, Task>, Task> onMessage,
        CancellationToken ct)
    {
        var wsUrl = _opts.HubUrl.Replace("http://", "ws://").Replace("https://", "wss://").TrimEnd('/');
        var uri = new Uri($"{wsUrl}/ws?deviceId={Uri.EscapeDataString(deviceId)}&token={Uri.EscapeDataString(_opts.ApiToken)}");

        while (!ct.IsCancellationRequested)
        {
            using var ws = new ClientWebSocket();
            try
            {
                await ws.ConnectAsync(uri, ct);
                _log.LogInformation("WebSocket connected to hub");
                var sendLock = new SemaphoreSlim(1, 1);
                Func<object, Task> send = async (obj) =>
                {
                    var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(obj));
                    await sendLock.WaitAsync(ct);
                    try { await ws.SendAsync(bytes, WebSocketMessageType.Text, true, ct); }
                    finally { sendLock.Release(); }
                };
                var buffer = new byte[8192];
                while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
                {
                    using var ms = new MemoryStream();
                    WebSocketReceiveResult result;
                    do
                    {
                        result = await ws.ReceiveAsync(buffer, ct);
                        if (result.MessageType == WebSocketMessageType.Close)
                        {
                            await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", ct);
                            break;
                        }
                        ms.Write(buffer, 0, result.Count);
                    } while (!result.EndOfMessage);

                    if (ms.Length == 0) continue;
                    var json = Encoding.UTF8.GetString(ms.ToArray());
                    try
                    {
                        var msg = JsonSerializer.Deserialize<WsMessage>(json);
                        if (msg != null) await onMessage(msg, send);
                    }
                    catch (Exception ex) { _log.LogWarning(ex, "Bad WS frame: {Json}", json); }
                }
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "WebSocket error; reconnecting in 5s");
            }
            try { await Task.Delay(TimeSpan.FromSeconds(5), ct); } catch { break; }
        }
    }
}
