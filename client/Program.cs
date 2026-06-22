using GameSync.Client;

var builder = Host.CreateApplicationBuilder(args);

// Run as a Windows Service when installed via sc.exe; runs as a console app
// otherwise (handy for development).
builder.Services.AddWindowsService(o => o.ServiceName = "GameSync");

var opts = builder.Configuration.GetSection("GameSync").Get<GameSyncOptions>() ?? new GameSyncOptions();
builder.Services.AddSingleton(opts);
builder.Services.AddSingleton<LocalState>();
builder.Services.AddHttpClient<HubClient>();
builder.Services.AddHostedService<Worker>();

var host = builder.Build();
host.Run();
