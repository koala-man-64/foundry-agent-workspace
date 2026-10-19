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

    // Every chain sits on a fixed drive unless its caller names another admission: the data directory, the app-owned
    // folders under it and local-path push remotes stay fixed-only; project paths pass DriveAdmission.Project.
    public static DirectoryLease Acquire(string directory) => Acquire(directory, false, ShareRead, DriveAdmission.Fixed);
    public static DirectoryLease AcquireExisting(string directory) => Acquire(directory, true, ShareRead, DriveAdmission.Fixed);

    /// <summary>
    /// As <see cref="AcquireExisting"/>, but entries inside the pinned directories may still be renamed or replaced
    /// (Git's lock-file renames open the target directory for writing). The pinned components themselves still cannot be
    /// renamed or deleted, because no handle shares delete access.
    /// </summary>
    public static DirectoryLease AcquireExistingSharingWrites(string directory) => AcquireExistingSharingWrites(directory, DriveAdmission.Fixed);

    /// <summary>As <see cref="AcquireExistingSharingWrites(string)"/>, on any drive type <paramref name="drives"/> admits.</summary>
    public static DirectoryLease AcquireExistingSharingWrites(string directory, DriveAdmission drives) => Acquire(directory, true, ShareReadWrite, drives);

    /// <summary>
    /// As <see cref="Acquire"/> (missing trailing components are allowed and stay unpinned), but sharing writes: other
    /// processes may still rename or create entries inside every pinned directory, which a long-lived lease on a chain up
    /// to the drive root must allow. The pinned components themselves still cannot be renamed or deleted.
    /// </summary>
    public static DirectoryLease AcquireSharingWrites(string directory) => Acquire(directory, false, ShareReadWrite, DriveAdmission.Fixed);

    private static unsafe DirectoryLease Acquire(string directory, bool requireExisting, uint share, DriveAdmission drives)
    {
        // GetFullPath strips a trailing dot or space from the last component, so it would pin a different entry than the
        // one named ("a " would pin a decoy "a"). Intermediate components are kept and opened literally below.
        var trimmed = directory.TrimEnd('\\', '/');
        var last = trimmed[(trimmed.LastIndexOfAny(['\\', '/']) + 1)..];
        if (last is not ("." or "..") && (last.EndsWith('.') || last.EndsWith(' '))) throw new IOException("Data identity cannot be established.");
        var path = Path.GetFullPath(directory);
        var root = Path.GetPathRoot(path) ?? throw new IOException("Data identity cannot be established.");
        // The drive type is read before any component is opened, so a refused drive is never touched.
        if (root.StartsWith("\\\\", StringComparison.Ordinal) || !drives.Admits(path)) throw new IOException("Data identity cannot be established.");
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

    /// <summary>
    /// The identity of every pinned handle, the drive root first: its volume serial number and 128-bit file identifier
    /// (FileIdInfo), which unlike the 64-bit index stays unique on ReFS. Two directory spellings name the same folder
    /// exactly when their sequences are equal: the same root, the same depth, and the same object at every prefix.
    /// </summary>
    public unsafe IReadOnlyList<FileIdentity> Identities()
    {
        ObjectDisposedException.ThrowIf(handles.Count == 0, this);
        var identities = new List<FileIdentity>(handles.Count);
        foreach (var handle in handles)
        {
            Native.FileIdInformation information;
            if (!Native.GetFileInformationByHandleEx(handle, Native.FileIdInformationClass, &information, (uint)sizeof(Native.FileIdInformation)))
                throw new IOException("Data identity cannot be established.");
            identities.Add(new(information.VolumeSerialNumber, new UInt128(information.FileIdHigh, information.FileIdLow)));
        }
        return identities;
    }

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

/// <summary>A volume serial number and 128-bit file identifier: one file system object, whatever spelling reaches it.</summary>
public readonly record struct FileIdentity(ulong Volume, UInt128 File);

/// <summary>A path component is a reparse point (junction, symbolic link, mount point or cloud placeholder); only
/// physical local entries are admitted.</summary>
public sealed class ReparsePointException() : IOException("Reparse directories require data-adoption review.");
