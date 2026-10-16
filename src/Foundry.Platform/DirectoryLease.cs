using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Foundry.Platform;

/// <summary>Pins existing directory components against rename, deletion and reparse-point changes.</summary>
public sealed class DirectoryLease : IDisposable
{
    private readonly List<SafeFileHandle> handles = [];
    private DirectoryLease() { }
    private const uint ShareRead = 1, ShareReadWrite = 3;
    public static DirectoryLease Acquire(string directory) => Acquire(directory, false, ShareRead);
    public static DirectoryLease AcquireExisting(string directory) => Acquire(directory, true, ShareRead);

    /// <summary>
    /// As <see cref="AcquireExisting"/>, but entries inside the pinned directories may still be renamed or replaced
    /// (Git's lock-file renames open the target directory for writing). The pinned components themselves still cannot be
    /// renamed or deleted, because no handle shares delete access.
    /// </summary>
    public static DirectoryLease AcquireExistingSharingWrites(string directory) => Acquire(directory, true, ShareReadWrite);

    private static unsafe DirectoryLease Acquire(string directory, bool requireExisting, uint share)
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
                // The preceding component is pinned before probing or creating its children. The namespaced name is opened
                // exactly as spelled: Win32 would strip a trailing space or dot and verify a different entry than the one
                // later traversal reaches.
                SafeFileHandle handle;
                fixed (char* name = MetadataFile.Namespaced(current))
                    handle = Native.CreateFile(name, 1, share, 0, Native.OpenExisting, Native.FileFlagBackupSemantics | 0x00200000, 0); // LIST_DIRECTORY, OPEN_REPARSE_POINT, never SHARE_DELETE.
                if (handle.IsInvalid)
                {
                    var error = Marshal.GetLastPInvokeError(); handle.Dispose();
                    if ((error is 2 or 3) && !requireExisting) break; // Missing component: its existing parent remains pinned.
                    throw new IOException("Data directory is not available for isolated access.", new Win32Exception(error));
                }
                lease.handles.Add(handle);
                Native.FileInformation information;
                if (!Native.GetFileInformation(handle, &information)) throw new IOException("Data identity cannot be established.");
                if ((information.Attributes & Native.FileAttributeReparsePoint) != 0) throw new ReparsePointException();
                if ((information.Attributes & Native.FileAttributeDirectory) == 0) throw new IOException("Data identity cannot be established.");
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
            Native.FileInformation information;
            if (!Native.GetFileInformation(handle, &information) || (information.Attributes & Native.FileAttributeReparsePoint) != 0 || information.Links != 1) throw new IOException("Database links are not admitted.");
            handles.Add(handle);
        }
        catch { handle.Dispose(); throw; }
    }
}

/// <summary>A path component is a reparse point (junction, symbolic link, mount point or cloud placeholder); only
/// physical local entries are admitted.</summary>
public sealed class ReparsePointException() : IOException("Reparse directories require data-adoption review.");
