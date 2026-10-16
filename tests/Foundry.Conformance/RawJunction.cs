using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Foundry.Conformance;

/// <summary>
/// Creates a mount-point junction at an exact namespaced name, including names Win32 would otherwise normalize ("a ",
/// "b.."), which mklink cannot create. No elevation is needed for mount points.
/// </summary>
internal static class RawJunction
{
    private const uint GenericWrite = 0x40000000, OpenExisting = 3, BackupSemantics = 0x02000000, OpenReparsePoint = 0x00200000;
    private const uint SetReparsePoint = 0x000900A4, MountPointTag = 0xA0000003;

    public static void Create(string link, string target)
    {
        Directory.CreateDirectory(@"\\?\" + link);
        var substitute = Encoding.Unicode.GetBytes(@"\??\" + target);
        var print = Encoding.Unicode.GetBytes(target);
        var dataLength = 8 + substitute.Length + 2 + print.Length + 2;
        var buffer = new byte[8 + dataLength];
        BitConverter.TryWriteBytes(buffer.AsSpan(0), MountPointTag);
        BitConverter.TryWriteBytes(buffer.AsSpan(4), (ushort)dataLength);
        BitConverter.TryWriteBytes(buffer.AsSpan(10), (ushort)substitute.Length);
        BitConverter.TryWriteBytes(buffer.AsSpan(12), (ushort)(substitute.Length + 2));
        BitConverter.TryWriteBytes(buffer.AsSpan(14), (ushort)print.Length);
        substitute.CopyTo(buffer, 16);
        print.CopyTo(buffer, 16 + substitute.Length + 2);
        using var handle = CreateFile(@"\\?\" + link, GenericWrite, 0, 0, OpenExisting, BackupSemantics | OpenReparsePoint, 0);
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastPInvokeError());
        if (!DeviceIoControl(handle, SetReparsePoint, buffer, (uint)buffer.Length, 0, 0, out _, 0)) throw new Win32Exception(Marshal.GetLastPInvokeError());
    }

    /// <summary>Removes the junction itself, never its target.</summary>
    public static void Delete(string link)
    {
        if (Directory.Exists(@"\\?\" + link)) Directory.Delete(@"\\?\" + link);
    }

    // CLR string and array marshalling keeps this test-only helper within the project's settings (no unsafe code).
    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string name, uint access, uint share, nint security, uint disposition, uint flags, nint template);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeviceIoControl(SafeFileHandle device, uint code, [In, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 3)] byte[] input,
        uint inputSize, nint output, uint outputSize, out uint returned, nint overlapped);
}
