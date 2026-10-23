using System.Security.Cryptography;
using Xunit;

namespace Foundry.Platform.Tests;

public sealed class ExistingEntryTests
{
    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(65_535)]
    [InlineData(65_536)]
    [InlineData(65_537)]
    [InlineData(131_072)]
    [InlineData(131_073)]
    public void StreamingHashIncludesEveryByteAcrossBlockAndEofBoundaries(int length)
    {
        var scratch = Scratch.Directory("foundry-entry-stream-").FullName;
        try
        {
            var file = Path.Combine(scratch, "content");
            var content = new byte[length];
            for (var index = 0; index < length; index++) content[index] = (byte)(index % 251);
            File.WriteAllBytes(file, content);
            using var entry = ExistingEntry.TryOpenForHash(file)!;
            using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            entry.AppendToHash(digest, length);
            Assert.Equal(SHA256.HashData(content), digest.GetHashAndReset());
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public void StreamingHashRefusesContentAboveTheRemainingBudget()
    {
        var scratch = Scratch.Directory("foundry-entry-limit-").FullName;
        try
        {
            var file = Path.Combine(scratch, "content");
            File.WriteAllBytes(file, [1, 2]);
            using var entry = ExistingEntry.TryOpen(file)!;
            using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            Assert.Throws<InvalidDataException>(() => entry.AppendToHash(digest, 1));
            Assert.Equal(SHA256.HashData([]), digest.GetHashAndReset());
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Theory]
    [InlineData(0)]
    [InlineData(65_535)]
    [InlineData(65_537)]
    [InlineData(262_144)]
    public void StreamingHashRefusesShortenedOrGrowingCapturedFiles(int changedLength)
    {
        var scratch = Scratch.Directory("foundry-entry-changing-").FullName;
        try
        {
            var file = Path.Combine(scratch, "content");
            File.WriteAllBytes(file, new byte[65_536]);
            using var entry = ExistingEntry.TryOpen(file)!;
            using (var writer = new FileStream(file, FileMode.Open, FileAccess.Write, FileShare.ReadWrite)) writer.SetLength(changedLength);
            using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            Assert.Throws<InvalidDataException>(() => entry.AppendToHash(digest, changedLength + 65_536L));
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public void StreamingHashRefusesChangedSameLengthObservations()
    {
        var scratch = Scratch.Directory("foundry-entry-write-time-").FullName;
        try
        {
            var file = Path.Combine(scratch, "content");
            File.WriteAllBytes(file, [1, 2]);
            var observed = File.GetLastWriteTimeUtc(file);
            using var entry = ExistingEntry.TryOpen(file)!;
            using (var writer = new FileStream(file, FileMode.Open, FileAccess.Write, FileShare.ReadWrite)) writer.WriteByte(3);
            File.SetLastWriteTimeUtc(file, observed.AddMinutes(1));
            using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            Assert.Throws<InvalidDataException>(() => entry.AppendToHash(digest, 2));
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public void HashReaderRefusesAlreadyOpenWriter()
    {
        var scratch = Scratch.Directory("foundry-entry-existing-writer-").FullName;
        try
        {
            var file = Path.Combine(scratch, "content");
            File.WriteAllBytes(file, [1, 2]);
            using var writer = new FileStream(file, FileMode.Open, FileAccess.Write, FileShare.ReadWrite);
            Assert.Throws<IOException>(() => ExistingEntry.TryOpenForHash(file));
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public void HashReaderPreventsConcurrentWriterAndRename()
    {
        var scratch = Scratch.Directory("foundry-entry-hash-lease-").FullName;
        try
        {
            var file = Path.Combine(scratch, "content");
            var moved = Path.Combine(scratch, "moved");
            byte[] content = [1, 2];
            File.WriteAllBytes(file, content);
            using (var entry = ExistingEntry.TryOpenForHash(file)!)
            {
                Assert.Throws<IOException>(() => { using var writer = new FileStream(file, FileMode.Open, FileAccess.Write, FileShare.ReadWrite); });
                Assert.Throws<IOException>(() => File.Move(file, moved));
                using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                entry.AppendToHash(digest, content.Length);
                Assert.Equal(SHA256.HashData(content), digest.GetHashAndReset());
            }
            // The protection is scoped to this content observation, and is released before command launch.
            File.AppendAllText(file, "released");
            File.Move(file, moved);
        }
        finally { Directory.Delete(scratch, true); }
    }
}
