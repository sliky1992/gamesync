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
            // A WS-protocol keep-alive ping also nudges NATs/proxies to hold the
            // connection open. (It is NOT enough on its own to detect a silently
            // dropped link on .NET 8 — there's no KeepAliveTimeout until .NET 9 —
            // so the application-level heartbeat below does the actual liveness check.)
            ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(15);
            // Cancelled when this connection dies/needs to reconnect; the heartbeat
            // task trips it so a wedged ReceiveAsync unblocks. Linked to ct so a real
            // shutdown cancels it too.
            using var recvCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            try
            {
                // Bound the connect too, so a dead network path can't wedge this loop.
                using (var connectCts = CancellationTokenSource.CreateLinkedTokenSource(ct))
                {
                    connectCts.CancelAfter(TimeSpan.FromSeconds(20));
                    await ws.ConnectAsync(uri, connectCts.Token);
                }
                _log.LogInformation("WebSocket connected to hub");
                var sendLock = new SemaphoreSlim(1, 1);
                Func<object, Task> send = async (obj) =>
                {
                    var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(obj));
                    await sendLock.WaitAsync(ct);
                    try { await ws.SendAsync(bytes, WebSocketMessageType.Text, true, ct); }
                    finally { sendLock.Release(); }
                };

                // Active liveness probe. Without this, a half-open TCP link (PC sleep,
                // Tailscale re-route, Wi-Fi drop) leaves the client blocked in
                // ReceiveAsync forever — it never reconnects, so the hub shows the
                // device offline until the service is restarted. We periodically send
                // {"type":"ping"} (the hub replies with a pong frame) and treat ANY
                // inbound frame as proof of life. If nothing arrives for too long, the
                // link is dead: cancel recvCts to break the receive and reconnect.
                long lastActivityTicks = DateTime.UtcNow.Ticks;
                var heartbeat = Task.Run(async () =>
                {
                    try
                    {
                        while (!recvCts.IsCancellationRequested)
                        {
                            await Task.Delay(TimeSpan.FromSeconds(15), recvCts.Token);
                            var idle = DateTime.UtcNow - new DateTime(Interlocked.Read(ref lastActivityTicks), DateTimeKind.Utc);
                            if (idle > TimeSpan.FromSeconds(40)) { recvCts.Cancel(); break; }
                            try { await send(new { type = "ping" }); }
                            catch { recvCts.Cancel(); break; }
                        }
                    }
                    catch (OperationCanceledException) { /* normal: shutting this socket down */ }
                });

                try
                {
                    var buffer = new byte[8192];
                    while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
                    {
                        using var ms = new MemoryStream();
                        WebSocketReceiveResult result;
                        do
                        {
                            result = await ws.ReceiveAsync(buffer, recvCts.Token);
                            Interlocked.Exchange(ref lastActivityTicks, DateTime.UtcNow.Ticks);
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
                            // "pong" replies (and our own pings) carry no action; the
                            // activity timestamp above already counted them as alive.
                            if (msg != null && msg.Type != "pong") await onMessage(msg, send);
                        }
                        catch (Exception ex) { _log.LogWarning(ex, "Bad WS frame: {Json}", json); }
                    }
                }
                finally { recvCts.Cancel(); }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception ex)
            {
                // Reaches here on a connect timeout or a heartbeat-triggered abort too —
                // both just mean "reconnect", which the loop does after the delay.
                _log.LogWarning(ex, "WebSocket error; reconnecting in 5s");
            }
            try { await Task.Delay(TimeSpan.FromSeconds(5), ct); } catch { break; }
        }
    }
}
