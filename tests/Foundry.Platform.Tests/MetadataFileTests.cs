using Xunit;

namespace Foundry.Platform.Tests;

public sealed class MetadataFileTests
{
    private const int Limit = 16_384;

    [Fact]
    public async Task ProbeReportsKindsWithoutFollowingTheFinalComponent()
    {
        var scratch = Scratch.Directory("foundry-metadata-probe-").FullName;
        var link = Path.Combine(scratch, "link");
        try
        {
            var directory = Directory.CreateDirectory(Path.Combine(scratch, "directory")).FullName;
            var file = Path.Combine(scratch, "file"); File.WriteAllText(file, "gitdir: x");
            await CreateJunction(link, directory);
            Assert.Equal(MetadataEntryKind.File, MetadataFile.Probe(file));
            Assert.Equal(MetadataEntryKind.Directory, MetadataFile.Probe(directory));
            Assert.Equal(MetadataEntryKind.Reparse, MetadataFile.Probe(link));
            Assert.Equal(MetadataEntryKind.Missing, MetadataFile.Probe(Path.Combine(scratch, "missing")));
            Assert.Equal(MetadataEntryKind.Missing, MetadataFile.Probe(Path.Combine(scratch, "missing", "child")));
        }
        finally { DeleteLink(link); Directory.Delete(scratch, true); }
    }

    [Theory]
    [InlineData(0), InlineData(1), InlineData(Limit - 1), InlineData(Limit)]
    public void ReadBoundedReturnsWholeContentUpToTheLimit(int length)
    {
        var scratch = Scratch.Directory("foundry-metadata-read-").FullName;
        try
        {
            var file = Path.Combine(scratch, "commondir");
            var content = new byte[length]; for (var index = 0; index < length; index++) content[index] = (byte)('a' + index % 26);
            File.WriteAllBytes(file, content);
            using var pinned = PinnedMetadataFile.OpenExisting(file);
            Assert.Equal(content, pinned.ReadBounded(Limit));
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Theory]
    [InlineData(Limit + 1), InlineData(64 * 1024 * 1024)]
    public void ReadBoundedRejectsAnyByteBeyondTheLimit(long length)
    {
        var scratch = Scratch.Directory("foundry-metadata-oversize-").FullName;
        try
        {
            var file = Path.Combine(scratch, "commondir");
            using (var stream = File.Create(file)) stream.SetLength(length);
            using var pinned = PinnedMetadataFile.OpenExisting(file);
            Assert.Throws<InvalidDataException>(() => pinned.ReadBounded(Limit));
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public void PinRefusesWritersRenamesAndDeletesUntilDisposed()
    {
        var scratch = Scratch.Directory("foundry-metadata-pin-").FullName;
        try
        {
            var file = Path.Combine(scratch, ".git"); var moved = Path.Combine(scratch, "moved");
            File.WriteAllText(file, "gitdir: ../main/.git");
            using (var pinned = PinnedMetadataFile.OpenExisting(file))
            {
                Assert.Throws<IOException>(() => File.AppendAllText(file, "\ngrowth"));
                Assert.Throws<IOException>(() => File.Move(file, moved));
                Assert.Throws<IOException>(() => File.Delete(file));
                Assert.Equal("gitdir: ../main/.git"u8.ToArray(), pinned.ReadBounded(Limit));
            }
            File.AppendAllText(file, "\ngrowth");
            File.Move(file, moved);
            File.Delete(moved);
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public void OpenFailsClosedWhileAWriterHoldsTheFile()
    {
        var scratch = Scratch.Directory("foundry-metadata-writer-").FullName;
        try
        {
            var file = Path.Combine(scratch, ".git");
            File.WriteAllText(file, "gitdir: x");
            using (new FileStream(file, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite))
                Assert.Throws<IOException>(() => PinnedMetadataFile.OpenExisting(file));
            using var pinned = PinnedMetadataFile.OpenExisting(file);
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task OpenRefusesDirectoriesAndDirectoryJunctions()
    {
        var scratch = Scratch.Directory("foundry-metadata-kind-").FullName;
        var link = Path.Combine(scratch, "link");
        try
        {
            var directory = Directory.CreateDirectory(Path.Combine(scratch, "directory")).FullName;
            await CreateJunction(link, directory);
            Assert.Throws<IOException>(() => PinnedMetadataFile.OpenExisting(directory));
            Assert.Throws<IOException>(() => PinnedMetadataFile.OpenExisting(link));
            Assert.Throws<IOException>(() => PinnedMetadataFile.OpenExisting(Path.Combine(scratch, "missing")));
        }
        finally { DeleteLink(link); Directory.Delete(scratch, true); }
    }

    [Fact]
    public void OpenRefusesAFileSymbolicLink()
    {
        var scratch = Scratch.Directory("foundry-metadata-symlink-").FullName;
        try
        {
            var target = Path.Combine(scratch, "target"); File.WriteAllText(target, "gitdir: x");
            var link = Path.Combine(scratch, "link");
            try { File.CreateSymbolicLink(link, target); }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                Assert.Skip($"File symbolic links need Developer Mode or elevation: {exception.Message}");
            }
            Assert.Equal(MetadataEntryKind.Reparse, MetadataFile.Probe(link));
            Assert.Throws<ReparsePointException>(() => PinnedMetadataFile.OpenExisting(link));
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Theory]
    [InlineData(@"\\server\share\.git"), InlineData("//server/share/.git"), InlineData(@"\\?\C:\x\.git"), InlineData(@"\\.\C:\x"), InlineData("relative\\.git"), InlineData(@"\x\.git")]
    public void OnlyDriveAbsolutePathsAreOpened(string path)
    {
        Assert.Throws<IOException>(() => MetadataFile.Probe(path));
        Assert.Throws<IOException>(() => PinnedMetadataFile.OpenExisting(path));
        Assert.Throws<IOException>(() => DirectoryLease.AcquireExisting(path));
    }

    [Fact]
    public void PathsBeyondMaxPathAreOpenedExactly()
    {
        var scratch = Scratch.Directory("foundry-metadata-long-").FullName;
        try
        {
            var deep = Directory.CreateDirectory(Path.Combine(scratch, string.Join('\\', Enumerable.Repeat(new string('d', 60), 5)))).FullName;
            var file = Path.Combine(deep, "commondir"); File.WriteAllText(file, "../..");
            Assert.True(file.Length > 300);
            Assert.Equal(MetadataEntryKind.Directory, MetadataFile.Probe(deep));
            Assert.Equal(MetadataEntryKind.File, MetadataFile.Probe(file));
            using (DirectoryLease.AcquireExisting(deep))
            using (var pinned = PinnedMetadataFile.OpenExisting(file))
                Assert.Equal("../.."u8.ToArray(), pinned.ReadBounded(Limit));
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Theory]
    [InlineData(@"C:\repo\wt", "../main/.git", @"C:\repo\main\.git")]
    [InlineData(@"C:\repo\wt", "C:/repo/main/.git/worktrees/wt", @"C:\repo\main\.git\worktrees\wt")]
    [InlineData(@"C:\repo\wt", @"\other\.git", @"C:\other\.git")]
    [InlineData(@"C:\repo\wt", "/other/.git", @"C:\other\.git")]
    [InlineData(@"C:\repo\wt", "./x/../main/.git", @"C:\repo\wt\main\.git")]
    [InlineData(@"C:\repo\wt", "C:main", @"C:\repo\wt\main")]
    [InlineData(@"C:\repo\wt", "c:", @"c:\repo\wt")]
    [InlineData(@"C:\repo\.git", "../..", @"C:\")]
    [InlineData(@"C:\repo\.git", "../../../..", @"C:\")]
    [InlineData(@"C:\repo\wt", "D:/elsewhere", @"D:\elsewhere")]
    public void ReferencesResolveAsNodePathWin32Resolve(string basePath, string reference, string expected) =>
        Assert.Equal(expected, PathReference.Resolve(basePath, reference));

    [Theory]
    [InlineData("D:main"), InlineData("d:"), InlineData("Z:..")]
    public void DriveRelativeReferencesToAnotherDriveAreRefused(string reference) =>
        Assert.Null(PathReference.Resolve(@"C:\repo\wt", reference));

    private static string Comspec => Environment.GetEnvironmentVariable("ComSpec") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");

    private static Task<string> CreateJunction(string link, string target) =>
        Scratch.Run(Comspec, $"\"{Comspec}\" /d /c mklink /J \"{link}\" \"{target}\"", Path.GetDirectoryName(link)!, Scratch.Environment(Path.GetDirectoryName(link)!));

    private static void DeleteLink(string link)
    {
        if (Directory.Exists(link)) Directory.Delete(link);
    }
}
