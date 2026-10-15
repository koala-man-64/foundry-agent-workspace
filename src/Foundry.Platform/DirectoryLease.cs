using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Foundry.Platform;

/// <summary>Pins existing directory components against rename, deletion and reparse-point changes.</summary>
public sealed partial class DirectoryLease : IDisposable
{
    private readonly List<SafeFileHandle> handles = [];
    private DirectoryLease() { }
    public static DirectoryLease Acquire(string directory) => Acquire(directory, false);
    public static DirectoryLease AcquireExisting(string directory) => Acquire(directory, true);
    private static unsafe DirectoryLease Acquire(string directory, bool requireExisting)
    {
        var path = Path.GetFullPath(directory);
        var root = Path.GetPathRoot(path) ?? throw new IOException("Data identity cannot be established.");
        if (root.StartsWith("\\\\", StringComparison.Ordinal) || new DriveInfo(root).DriveType is not DriveType.Fixed) throw new IOException("Data identity cannot be established.");
        var lease = new DirectoryLease();
        try
        {
            var current = root;
            var parts = path[root.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);
            for (var index = -1; index < parts.Length; index++)
            {
                if (index >= 0) current = Path.Combine(current, parts[index]);
                // The preceding component is pinned before probing or creating its children.
                SafeFileHandle handle;
                fixed (char* name = current)
                    handle = Native.CreateFile(name, 1, 1, 0, Native.OpenExisting, Native.FileFlagBackupSemantics | 0x00200000, 0); // LIST_DIRECTORY, OPEN_REPARSE_POINT, SHARE_READ only.
                if (handle.IsInvalid)
                {
                    var error = Marshal.GetLastPInvokeError(); handle.Dispose();
                    if ((error is 2 or 3) && !requireExisting) break; // Missing component: its existing parent remains pinned.
                    throw new IOException("Data directory is not available for isolated access.", new Win32Exception(error));
                }
                lease.handles.Add(handle);
                FileInformation information;
                if (GetInformation(handle, &information) == 0) throw new IOException("Data identity cannot be established.");
                if ((information.Attributes & 0x400) != 0) throw new IOException("Reparse directories require data-adoption review.");
                if ((information.Attributes & 0x10) == 0) throw new IOException("Data identity cannot be established.");
            }
            return lease;
        }
        catch { lease.Dispose(); throw; }
    }
    public void Dispose() { foreach (var handle in handles.AsEnumerable().Reverse()) handle.Dispose(); handles.Clear(); }

    public void PinDatabase(string path) => PinDatabase(path, true);
    public void PinExistingDatabase(string path) => PinDatabase(path, false);
    private unsafe void PinDatabase(string path, bool create)
    {
        ObjectDisposedException.ThrowIf(handles.Count == 0, this);
        SafeFileHandle handle;
        if (create && !File.Exists(path)) handle = File.OpenHandle(path, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.ReadWrite);
        else
        {
            fixed (char* name = path) handle = Native.CreateFile(name, 1, 3, 0, Native.OpenExisting, 0x00200000, 0); // READ_DATA, SHARE_READ|WRITE, OPEN_REPARSE_POINT.
            if (handle.IsInvalid) { handle.Dispose(); throw new IOException("Data identity cannot be established."); }
        }
        try
        {
            FileInformation information;
            if (GetInformation(handle, &information) == 0 || (information.Attributes & 0x400) != 0 || information.Links != 1) throw new IOException("Database links are not admitted.");
            handles.Add(handle);
        }
        catch { handle.Dispose(); throw; }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation
    {
        internal uint Attributes;
        internal uint CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
        internal uint VolumeSerial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [LibraryImport("kernel32.dll", EntryPoint = "GetFileInformationByHandle", SetLastError = true)]
    private static unsafe partial int GetInformation(SafeFileHandle file, FileInformation* information);
}
