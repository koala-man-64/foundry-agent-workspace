using System.Runtime.InteropServices;

[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]

namespace Foundry.Spikes.Toast;

/// <summary>shell32 and user32 entry points for the toast spike. Blittable signatures only.</summary>
internal static partial class Native
{
    private const uint FlashTray = 0x2;
    private const uint FlashUntilForeground = 0xC;

    [StructLayout(LayoutKind.Sequential)]
    private struct FlashInfo
    {
        public uint Size;
        public nint Window;
        public uint Flags;
        public uint Count;
        public uint Timeout;
    }

    /// <summary>Groups this process's windows under the spike's AUMID, as the product will under its own.</summary>
    [LibraryImport("shell32.dll", EntryPoint = "SetCurrentProcessExplicitAppUserModelID", StringMarshalling = StringMarshalling.Utf16)]
    public static partial int SetAppUserModelId(string appId);

    /// <summary>QUERY_USER_NOTIFICATION_STATE: whether Windows would show a banner right now.</summary>
    [LibraryImport("shell32.dll", EntryPoint = "SHQueryUserNotificationState")]
    private static partial int QueryUserNotificationState(out int state);

    [LibraryImport("user32.dll")]
    public static partial nint GetForegroundWindow();

    [LibraryImport("user32.dll", EntryPoint = "FlashWindowEx")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool FlashWindow(ref FlashInfo info);

    public static string NotificationState() =>
        QueryUserNotificationState(out var state) != 0 ? "unknown" : state switch
        {
            1 => "not present (screen saver or lock screen)",
            2 => "busy (a full-screen app)",
            3 => "running a full-screen Direct3D app",
            4 => "presentation mode",
            5 => "accepts notifications",
            6 => "quiet time",
            7 => "a Windows Store app is in front",
            _ => $"state {state}",
        };

    /// <summary>The fallback's taskbar flash: the button flashes until the window comes to the front.</summary>
    public static void FlashTaskbar(nint window)
    {
        var info = new FlashInfo { Size = (uint)Marshal.SizeOf<FlashInfo>(), Window = window, Flags = FlashTray | FlashUntilForeground };
        FlashWindow(ref info);
    }
}
