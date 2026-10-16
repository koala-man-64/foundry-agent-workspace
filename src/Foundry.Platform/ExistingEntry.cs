using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Foundry.Platform;

/// <summary>
/// An existing repository file or directory opened by its exact namespaced name without following a final reparse point.
/// The handle shares reads and writes but never deletes, so the entry cannot be renamed, deleted or replaced while it is
/// held, and every check and read goes through the handle rather than the name. Intermediate components are traversed by
/// the OS, so callers pin and verify the parent chain (<see cref="DirectoryLease"/>) first.
/// </summary>
public sealed class ExistingEntry : IDisposable
{
    private const uint ReadData = 0x1, ReadAttributes = 0x80, ShareReadWrite = 0x3;
    private readonly SafeFileHandle handle;

    private ExistingEntry(SafeFileHandle handle, Native.FileInformation information)
    {
        this.handle = handle;
        IsReparsePoint = (information.Attributes & Native.FileAttributeReparsePoint) != 0;
        IsDirectory = (information.Attributes & Native.FileAttributeDirectory) != 0;
        Length = ((long)information.SizeHigh << 32) | information.SizeLow;
        Links = information.Links;
    }

    public bool IsReparsePoint { get; }
    public bool IsDirectory { get; }
    public long Length { get; }
    public uint Links { get; }

    /// <summary>The entry, or null when it or a parent is missing. Anything that is not a drive-absolute path fails closed
    /// before any open.</summary>
    public static unsafe ExistingEntry? TryOpen(string path)
    {
        ArgumentNullException.ThrowIfNull(path);
        var handle = MetadataFile.Open(path, ReadData | ReadAttributes, ShareReadWrite, Native.FileFlagBackupSemantics | Native.FileFlagOpenReparsePoint);
        if (handle.IsInvalid)
        {
            var error = Marshal.GetLastPInvokeError(); handle.Dispose();
            if (error is 2 or 3) return null;
            throw new IOException("Entry is not available for isolated access.", new Win32Exception(error));
        }
        try
        {
            Native.FileInformation information;
            if (!Native.GetFileInformation(handle, &information)) throw new IOException("Entry identity cannot be established.");
            return new(handle, information);
        }
        catch { handle.Dispose(); throw; }
    }

    /// <summary>The real path of the open entry, as fs.realpath reports it for a local drive; null when it is not one.</summary>
    public unsafe string? FinalPath()
    {
        ObjectDisposedException.ThrowIf(handle.IsClosed, this);
        var buffer = new char[512];
        while (true)
        {
            uint length;
            fixed (char* pointer = buffer) length = Native.GetFinalPathNameByHandle(handle, pointer, (uint)buffer.Length, Native.VolumeNameDos);
            if (length == 0) return null;
            if (length < buffer.Length)
            {
                var final = new string(buffer, 0, (int)length);
                return final.Length > 6 && final.StartsWith(@"\\?\", StringComparison.Ordinal) && char.IsAsciiLetter(final[4]) && final[5] == ':' ? final[4..] : null;
            }
            buffer = new char[length];
        }
    }

    /// <summary>
    /// The whole content when it is at most <paramref name="maximumBytes"/>. At most one byte more is read, so a file
    /// that grew after its size was checked cannot force an unbounded read; that extra byte rejects it.
    /// </summary>
    public byte[] ReadBounded(int maximumBytes)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(maximumBytes);
        ArgumentOutOfRangeException.ThrowIfGreaterThanOrEqual(maximumBytes, Array.MaxLength);
        ObjectDisposedException.ThrowIf(handle.IsClosed, this);
        if (IsDirectory) throw new IOException("Entry is not a file.");
        var buffer = new byte[maximumBytes + 1];
        var total = 0;
        while (total < buffer.Length)
        {
            var read = RandomAccess.Read(handle, buffer.AsSpan(total), total);
            if (read == 0) break;
            total += read;
        }
        if (total > maximumBytes) throw new InvalidDataException("Entry exceeds its size limit.");
        return buffer[..total];
    }

    public void Dispose() => handle.Dispose();
}
