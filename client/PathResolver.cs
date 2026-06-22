namespace GameSync.Client;

/// <summary>
/// Resolves configured save paths that may contain Windows environment
/// variables (%APPDATA%, %USERPROFILE%, %LOCALAPPDATA%, ...) so the same game
/// can map to different real paths on different machines / user accounts.
/// </summary>
public static class PathResolver
{
    public static string Resolve(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return raw;
        var expanded = Environment.ExpandEnvironmentVariables(raw);

        // Map common tokens explicitly too (covers cross-platform dev and the
        // case where a variable isn't present in the service's environment).
        expanded = expanded
            .Replace("%APPDATA%", Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), StringComparison.OrdinalIgnoreCase)
            .Replace("%LOCALAPPDATA%", Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), StringComparison.OrdinalIgnoreCase)
            .Replace("%USERPROFILE%", Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), StringComparison.OrdinalIgnoreCase)
            .Replace("%DOCUMENTS%", Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), StringComparison.OrdinalIgnoreCase);

        if (expanded.StartsWith("~"))
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            expanded = home + expanded.Substring(1);
        }
        return expanded;
    }
}
