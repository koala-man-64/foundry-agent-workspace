using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Foundry.Platform;

public enum MetadataEntryKind { Missing, File, Directory, Reparse }

/// <summary>
/// Small metadata files such as Git pointers, inspected without following a final reparse point. Intermediate
/// components are traversed by the OS, so callers pin and verify the parent chain (DirectoryLease) first.
/// </summary>
public static class MetadataFile
{
    internal const uint ReadData = 0x1, ReadAttributes = 0x80, ShareRead = 0x1, ShareAll = 0x7;

    /// <summary>What the path names. Missing parents count as missing; any other open failure throws.</summary>
    public static unsafe MetadataEntryKind Probe(string path)
    {
        ArgumentNullException.ThrowIfNull(path);
        using var handle = Open(path, ReadAttributes, ShareAll, Native.FileFlagBackupSemantics | Native.FileFlagOpenReparsePoint);
        if (handle.IsInvalid)
        {
            var error = Marshal.GetLastPInvokeError();
            if (error is 2 or 3) return MetadataEntryKind.Missing;
            throw new IOException("Metadata identity cannot be established.", new Win32Exception(error));
        }
        var attributes = Attributes(handle);
        if ((attributes & Native.FileAttributeReparsePoint) != 0) return MetadataEntryKind.Reparse;
        return (attributes & Native.FileAttributeDirectory) != 0 ? MetadataEntryKind.Directory : MetadataEntryKind.File;
    }

    internal static unsafe SafeFileHandle Open(string path, uint access, uint share, uint flags)
    {
        fixed (char* name = Namespaced(path)) return Native.CreateFile(name, access, share, 0, Native.OpenExisting, flags, 0);
    }

    /// <summary>
    /// Node's toNamespacedPath for a drive-absolute path. Win32 normalization (stripping trailing dots and spaces,
    /// mapping reserved device names, the MAX_PATH limit) never applies, so the entry opened is exactly the one named.
    /// Anything else fails closed: UNC and device paths are refused before any open.
    /// </summary>
    internal static string Namespaced(string path) =>
        path.Length >= 3 && char.IsAsciiLetter(path[0]) && path[1] == ':' && path[2] == '\\'
            ? @"\\?\" + path
            : throw new IOException("Metadata identity cannot be established.");

    internal static unsafe uint Attributes(SafeFileHandle handle)
    {
        Native.FileInformation information;
        if (!Native.GetFileInformation(handle, &information)) throw new IOException("Metadata identity cannot be established.");
        return information.Attributes;
    }
}

/// <summary>
/// A metadata file held open with read-only sharing, so no writer, rename or delete can change it until disposal.
/// Opening fails closed while another handle already has it open for writing.
/// </summary>
public sealed class PinnedMetadataFile : IDisposable
{
    private readonly SafeFileHandle handle;
    private PinnedMetadataFile(SafeFileHandle handle) => this.handle = handle;

    public static PinnedMetadataFile OpenExisting(string path)
    {
        ArgumentNullException.ThrowIfNull(path);
        var handle = MetadataFile.Open(path, MetadataFile.ReadData | MetadataFile.ReadAttributes, MetadataFile.ShareRead, Native.FileFlagOpenReparsePoint);
        if (handle.IsInvalid)
        {
            var error = Marshal.GetLastPInvokeError(); handle.Dispose();
            throw new IOException("Metadata is not available for isolated access.", new Win32Exception(error));
        }
        try
        {
            // Re-checked on the handle: the entry a caller probed may have been swapped before this open.
            var attributes = MetadataFile.Attributes(handle);
            if ((attributes & Native.FileAttributeReparsePoint) != 0) throw new ReparsePointException();
            if ((attributes & Native.FileAttributeDirectory) != 0) throw new IOException("Metadata identity cannot be established.");
            return new(handle);
        }
        catch { handle.Dispose(); throw; }
    }

    /// <summary>
    /// The whole content when it is at most <paramref name="maximumBytes"/>. At most one byte more is ever read, so a
    /// large or growing file cannot force an unbounded read; that extra byte rejects it.
    /// </summary>
    public byte[] ReadBounded(int maximumBytes)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(maximumBytes);
        ArgumentOutOfRangeException.ThrowIfGreaterThanOrEqual(maximumBytes, Array.MaxLength);
        ObjectDisposedException.ThrowIf(handle.IsClosed, this);
        var buffer = new byte[maximumBytes + 1];
        var total = 0;
        while (total < buffer.Length)
        {
            var read = RandomAccess.Read(handle, buffer.AsSpan(total), total);
            if (read == 0) break;
            total += read;
        }
        if (total > maximumBytes) throw new InvalidDataException("Metadata exceeds its size limit.");
        return buffer[..total];
    }

    public void Dispose() => handle.Dispose();
}
