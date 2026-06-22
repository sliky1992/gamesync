using System.Runtime.InteropServices;

namespace GameSync.Client;

/// <summary>
/// Opens a URL in the interactive user's default browser from the LocalSystem
/// service (session 0). A service can't just Process.Start a browser — it would
/// launch invisibly in session 0 — so we grab the active console session's user
/// token and CreateProcessAsUser into it. Best-effort; no-op if nobody's logged in.
/// </summary>
internal static class UserNotifier
{
    private const uint INVALID_SESSION = 0xFFFFFFFF;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_NO_WINDOW = 0x08000000;

    [DllImport("kernel32.dll")]
    private static extern uint WTSGetActiveConsoleSessionId();

    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSQueryUserToken(uint sessionId, out IntPtr token);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool CreateEnvironmentBlock(out IntPtr env, IntPtr token, bool inherit);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool DestroyEnvironmentBlock(IntPtr env);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr h);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessAsUserW(
        IntPtr hToken, string? lpApplicationName, string? lpCommandLine,
        IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles,
        uint dwCreationFlags, IntPtr lpEnvironment, string? lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string? lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    public static void OpenUrl(string url)
    {
        if (!OperatingSystem.IsWindows()) return;
        IntPtr token = IntPtr.Zero, env = IntPtr.Zero;
        try
        {
            var session = WTSGetActiveConsoleSessionId();
            if (session == INVALID_SESSION) return;            // nobody at the console
            if (!WTSQueryUserToken(session, out token)) return; // can't impersonate the user
            CreateEnvironmentBlock(out env, token, false);

            var si = new STARTUPINFO { cb = Marshal.SizeOf<STARTUPINFO>(), lpDesktop = @"winsta0\default" };
            // `start` resolves the user's default browser; CREATE_NO_WINDOW hides the cmd shell.
            var cmd = $"cmd.exe /c start \"\" \"{url}\"";
            if (CreateProcessAsUserW(token, null, cmd, IntPtr.Zero, IntPtr.Zero, false,
                    CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, env, null, ref si, out var pi))
            {
                CloseHandle(pi.hProcess);
                CloseHandle(pi.hThread);
            }
        }
        catch { /* best-effort */ }
        finally
        {
            if (env != IntPtr.Zero) DestroyEnvironmentBlock(env);
            if (token != IntPtr.Zero) CloseHandle(token);
        }
    }
}
