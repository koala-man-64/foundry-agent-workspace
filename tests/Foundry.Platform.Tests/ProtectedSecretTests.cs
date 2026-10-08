using System.Security.Cryptography;
using System.Text;
using Xunit;

namespace Foundry.Platform.Tests;

/// <summary>Spike S7: DPAPI bound to entropy, and the vault's crash-safe replacement.</summary>
public sealed class ProtectedSecretTests
{
    private static readonly byte[] Entropy = SHA256.HashData(Encoding.UTF8.GetBytes("profile-id\0responses|https://example.services.ai.azure.com/|deployment"));

    [Fact]
    public void ALongSecretRoundTrips()
    {
        var secret = Encoding.UTF8.GetBytes(string.Concat(Enumerable.Range(0, 8192).Select(index => (char)('a' + (index % 26)))) + "é€🔑");
        var protectedSecret = ProtectedSecret.Protect(secret, Entropy);
        Assert.False(protectedSecret.AsSpan().IndexOf(secret.AsSpan(0, 64)) >= 0, "The protected blob contains plaintext.");
        Assert.Equal(secret, ProtectedSecret.Unprotect(protectedSecret, Entropy));
    }

    [Fact]
    public void OtherEntropyDoesNotDecrypt()
    {
        var protectedSecret = ProtectedSecret.Protect([1, 2, 3], Entropy);
        var otherBinding = SHA256.HashData(Encoding.UTF8.GetBytes("profile-id\0responses|https://other.services.ai.azure.com/|deployment"));
        Assert.ThrowsAny<CryptographicException>(() => ProtectedSecret.Unprotect(protectedSecret, otherBinding));
    }

    [Fact]
    public void ATamperedBlobDoesNotDecrypt()
    {
        var protectedSecret = ProtectedSecret.Protect([1, 2, 3], Entropy);
        protectedSecret[^1] ^= 0x5a;
        Assert.ThrowsAny<CryptographicException>(() => ProtectedSecret.Unprotect(protectedSecret, Entropy));
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(0)]
    [InlineData(31)]
    [InlineData(33)]
    public void EntropyMustBeABindingDigest(int length)
    {
        // A dropped or truncated binding must fail loudly rather than silently weaken the profile check.
        var entropy = length < 0 ? null! : new byte[length];
        Assert.ThrowsAny<ArgumentException>(() => ProtectedSecret.Protect([1, 2, 3], entropy));
        Assert.ThrowsAny<ArgumentException>(() => ProtectedSecret.Unprotect([1, 2, 3], entropy));
    }

    [Fact]
    public void AFailedRenameKeepsTheOldFileAndRemovesTheTemporary()
    {
        var directory = Scratch.Directory("foundry-secret-locked-").FullName;
        var target = Path.Combine(directory, "credential.bin");
        ProtectedSecret.WriteAtomically(target, [1, 2, 3]);
        using (File.Open(target, FileMode.Open, FileAccess.Read, FileShare.None))
        {
            Assert.Throws<IOException>(() => ProtectedSecret.WriteAtomically(target, [9, 9]));
        }
        Assert.Equal([1, 2, 3], File.ReadAllBytes(target));
        Assert.Equal(["credential.bin"], Directory.EnumerateFileSystemEntries(directory).Select(Path.GetFileName));
    }

    [Fact]
    public void WriteAtomicallyCreatesAndReplaces()
    {
        var directory = Scratch.Directory("foundry-secret-write-").FullName;
        var target = Path.Combine(directory, "credential.bin");
        ProtectedSecret.WriteAtomically(target, [1, 2, 3]);
        Assert.Equal([1, 2, 3], File.ReadAllBytes(target));
        ProtectedSecret.WriteAtomically(target, [4, 5]);
        Assert.Equal([4, 5], File.ReadAllBytes(target));
        Assert.Equal(["credential.bin"], Directory.EnumerateFileSystemEntries(directory).Select(Path.GetFileName));
    }

    [Fact]
    public void AFailureBeforeTheRenameKeepsTheOldFileAndRemovesTheTemporary()
    {
        var directory = Scratch.Directory("foundry-secret-fault-").FullName;
        var target = Path.Combine(directory, "credential.bin");
        ProtectedSecret.WriteAtomically(target, [1, 2, 3]);
        string? temporary = null;
        var failure = Assert.Throws<IOException>(() => ProtectedSecret.WriteAtomically(target, [9, 9, 9, 9], () =>
        {
            temporary = Assert.Single(Directory.EnumerateFiles(directory, ".credential.bin.*.tmp"));
            Assert.Equal([9, 9, 9, 9], File.ReadAllBytes(temporary)); // Flushed before the rename.
            throw new IOException("injected");
        }));
        Assert.Equal("injected", failure.Message);
        Assert.NotNull(temporary);
        Assert.Equal([1, 2, 3], File.ReadAllBytes(target));
        Assert.Equal(["credential.bin"], Directory.EnumerateFileSystemEntries(directory).Select(Path.GetFileName));
    }
}
