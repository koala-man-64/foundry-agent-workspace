using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Foundry.Platform;

/// <summary>File streams report broken pipes, unlike Console's silent broken-output handling.</summary>
public static partial class StandardStreams
{
    public static Stream Input() => Open(-10, FileAccess.Read);
    public static Stream Output() => Open(-11, FileAccess.Write);
    private static FileStream Open(int identifier, FileAccess access)
    {
        var handle = new SafeFileHandle(GetStdHandle(identifier), ownsHandle: false);
        if (handle.IsInvalid) { handle.Dispose(); throw new IOException("Standard stream is unavailable."); }
        try { return new FileStream(handle, access, 4096, isAsync: false); }
        catch { handle.Dispose(); throw; }
    }
    [LibraryImport("kernel32.dll", SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static partial nint GetStdHandle(int standardHandle);
}
