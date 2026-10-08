using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

namespace Foundry.Platform;

/// <summary>
/// DPAPI (CurrentUser) protection bound to caller-supplied entropy, and crash-safe file replacement for the credential
/// vault (docs/wpf-webview2-migration.md, "Credential vault"). Entropy is context binding, not authentication: any
/// process of the same user can produce a blob for any entropy, and DPAPI also decrypts machine-scoped blobs, so the
/// vault re-checks the binding stored inside the plaintext after decrypting.
/// </summary>
public static class ProtectedSecret
{
    /// <summary>The vault passes a SHA-256 digest; any other length means the binding was lost on the way.</summary>
    public const int EntropyLength = 32;

    public static byte[] Protect(byte[] secret, byte[] entropy)
    {
        ArgumentNullException.ThrowIfNull(secret);
        return ProtectedData.Protect(secret, CheckEntropy(entropy), DataProtectionScope.CurrentUser);
    }

    public static byte[] Unprotect(byte[] protectedSecret, byte[] entropy)
    {
        ArgumentNullException.ThrowIfNull(protectedSecret);
        return ProtectedData.Unprotect(protectedSecret, CheckEntropy(entropy), DataProtectionScope.CurrentUser);
    }

    /// <summary>
    /// Write to a new temporary file beside the target, flush it to disk, then replace the target in one write-through
    /// rename. A crash at any point leaves either the old file or the new one, never a partial file; a crash before the
    /// rename can leave a temporary ".name.*.tmp" file for the vault's startup sweep. The caller verifies the directory.
    /// </summary>
    public static void WriteAtomically(string path, ReadOnlySpan<byte> content) => WriteAtomically(path, content, beforeReplace: null);

    internal static unsafe void WriteAtomically(string path, ReadOnlySpan<byte> content, Action? beforeReplace)
    {
        var fullPath = Path.GetFullPath(path);
        var directory = Path.GetDirectoryName(fullPath) ?? throw new ArgumentException("The path has no directory.", nameof(path));
        var temporary = Path.Combine(directory, $".{Path.GetFileName(fullPath)}.{Guid.NewGuid():N}.tmp");
        var created = false;
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                created = true;
                stream.Write(content);
                stream.Flush(flushToDisk: true);
            }
            beforeReplace?.Invoke();
            fixed (char* source = temporary)
            fixed (char* target = fullPath)
            {
                if (!Native.MoveFileEx(source, target, Native.MoveFileReplaceExisting | Native.MoveFileWriteThrough))
                {
                    throw new IOException($"Replacing {fullPath} failed.", new Win32Exception(Marshal.GetLastPInvokeError()));
                }
            }
        }
        catch when (created)
        {
            TryDelete(temporary);
            throw;
        }
    }

    private static byte[] CheckEntropy(byte[] entropy)
    {
        ArgumentNullException.ThrowIfNull(entropy);
        return entropy.Length == EntropyLength ? entropy : throw new ArgumentException($"Entropy must be a {EntropyLength}-byte digest of the credential binding.", nameof(entropy));
    }

    /// <summary>Best effort: the write's own failure is the one to report. A leftover holds only the bytes the caller
    /// meant to write, which for the vault is a DPAPI blob.</summary>
    private static void TryDelete(string temporary)
    {
        try
        {
            File.Delete(temporary);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
