using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Foundry.Platform;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

public sealed class GitRepositoryLeaseTests
{
    private static string Root
    {
        get
        {
            for (var root = new DirectoryInfo(AppContext.BaseDirectory); root is not null; root = root.Parent)
                if (File.Exists(Path.Combine(root.FullName, "Foundry.slnx"))) return root.FullName;
            throw new InvalidOperationException("Missing Git identity corpus.");
        }
    }

    private static readonly JsonElement Corpus = ReadCorpus();
    private static JsonElement ReadCorpus()
    {
        using var document = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(Root, "tests/p2/git-identity-vectors.json")));
        return document.RootElement.Clone();
    }

    public static IEnumerable<object[]> Cases()
    {
        var index = 0;
        foreach (var item in Corpus.GetProperty("cases").EnumerateArray()) yield return [item.GetProperty("name").GetString()!, index++];
    }

    [Theory, MemberData(nameof(Cases))]
    public async Task FixtureTreesMatchCommittedNodeOutcomesOrTheirApprovedDifference(string name, int index)
    {
        var item = Corpus.GetProperty("cases")[index];
        Assert.Equal(name, item.GetProperty("name").GetString());
        var expected = item.TryGetProperty("native", out var native) ? native.GetProperty("outcome") : item.GetProperty("expected");
        var scratch = NewScratch();
        var links = new List<string>();
        try
        {
            await Build(scratch, item.GetProperty("tree"), links);
            await using var loop = new RuntimeLoop();
            var outcome = await loop.Invoke(() => Task.FromResult(Admit(loop, Path.Combine(scratch, item.GetProperty("project").GetString()!.Replace('/', '\\')), scratch)));
            if (expected.TryGetProperty("identity", out var identity))
            {
                Assert.Null(outcome.Error);
                Assert.Equal(
                    new[] { identity.GetProperty("path").GetString(), identity.GetProperty("root").GetString(), identity.GetProperty("gitDirectory").GetString(), identity.GetProperty("common").GetString() },
                    outcome.Identity);
            }
            else if (expected.TryGetProperty("error", out var error)) Assert.Equal(error.GetString(), outcome.Error);
            else
            {
                // Node raised a raw filesystem error (ENOENT, EISDIR); native must refuse, with its own fixed message.
                Assert.True(expected.TryGetProperty("systemError", out _));
                Assert.NotNull(outcome.Error);
            }
        }
        finally { Remove(scratch, links); }
    }

    [Fact]
    public void OracleSourceBindingsAreCurrent()
    {
        Assert.Equal(1, Corpus.GetProperty("schemaVersion").GetInt32());
        Assert.True(Corpus.GetProperty("cases").GetArrayLength() >= 40);
        foreach (var source in Corpus.GetProperty("oracle").GetProperty("sources").EnumerateArray())
            Assert.Equal(source.GetProperty("sha256").GetString(), Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(Path.Combine(Root, source.GetProperty("path").GetString()!)))));
        // Every native difference names its reason; nothing else may diverge.
        foreach (var item in Corpus.GetProperty("cases").EnumerateArray())
            if (item.TryGetProperty("native", out var native)) Assert.False(string.IsNullOrWhiteSpace(native.GetProperty("difference").GetString()));
    }

    [Fact]
    public async Task EveryPointerAndDirectoryStaysPinnedUntilDisposal()
    {
        var scratch = NewScratch();
        try
        {
            var (main, worktree, gitDirectory) = LinkedWorktree(scratch);
            var pointer = Path.Combine(worktree, ".git"); var commondir = Path.Combine(gitDirectory, "commondir");
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                using (var folder = RepositoryFolderLease.Open(loop, worktree))
                {
                    using (var lease = GitRepositoryLease.Open(loop, folder)!)
                    {
                        var common = lease.Identity.Common;
                        Assert.Equal(Path.Combine(main, ".git"), common);
                        Assert.Throws<IOException>(() => File.AppendAllText(pointer, "\ngitdir: elsewhere"));
                        Assert.Throws<IOException>(() => File.Delete(pointer));
                        Assert.Throws<IOException>(() => File.WriteAllText(commondir, "../../../../other/.git"));
                        Assert.Throws<IOException>(() => File.Delete(commondir));
                        Assert.Throws<IOException>(() => File.Move(commondir, commondir + ".moved"));
                        Assert.Throws<IOException>(() => Directory.Move(gitDirectory, gitDirectory + "-moved"));
                        Assert.Throws<IOException>(() => Directory.Move(common, Path.Combine(main, "git-moved")));
                        Assert.Throws<IOException>(() => Directory.Move(main, main + "-moved"));
                        // Git's lock-file protocol still works inside the pinned Git and common directories.
                        foreach (var (directory, name) in new[] { (gitDirectory, "index"), (common, "HEAD") })
                        {
                            File.WriteAllText(Path.Combine(directory, name), "before");
                            File.WriteAllText(Path.Combine(directory, name + ".lock"), "after");
                            File.Move(Path.Combine(directory, name + ".lock"), Path.Combine(directory, name), overwrite: true);
                            Assert.Equal("after", File.ReadAllText(Path.Combine(directory, name)));
                        }
                    }
                    // Released while the folder lease (which pins only the worktree folder chain) is still held.
                    File.AppendAllText(pointer, "\n");
                    File.Move(commondir, commondir + ".moved"); File.Move(commondir + ".moved", commondir);
                    File.WriteAllText(commondir, "../..");
                    Directory.Move(Path.Combine(main, ".git"), Path.Combine(main, "git-moved"));
                }
                // The folder lease pinned the worktree folder chain, including the scratch directory.
                Directory.Move(main, main + "-moved");
                File.Move(pointer, pointer + ".moved");
                return Task.FromResult(0);
            });
        }
        finally { Remove(scratch, []); }
    }

    [Fact]
    public async Task RevalidationMatchesOnlyTheSameCompleteBinding()
    {
        var scratch = NewScratch();
        try
        {
            var (_, worktree, gitDirectory) = LinkedWorktree(scratch);
            Directory.CreateDirectory(Path.Combine(scratch, "other", ".git"));
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                using var folder = RepositoryFolderLease.Open(loop, worktree);
                GitAdmissionIdentity admitted;
                using (var lease = GitRepositoryLease.Open(loop, folder)!)
                {
                    admitted = lease.Identity;
                    lease.Revalidate(admitted);
                    lease.Revalidate(admitted with { });
                    foreach (var stale in new GitAdmissionIdentity?[] { null, admitted with { Common = admitted.GitDirectory }, admitted with { Common = "" }, admitted with { Path = admitted.Path.ToUpperInvariant() } })
                        Assert.Equal("Project channel identity changed during admission.", Assert.Throws<WorkspaceReadException>(() => lease.Revalidate(stale)).Message);
                }
                File.WriteAllText(Path.Combine(gitDirectory, "commondir"), "../../../../other/.git");
                using (var rebound = GitRepositoryLease.Open(loop, folder)!)
                {
                    Assert.Equal(Path.Combine(scratch, "other", ".git"), rebound.Identity.Common);
                    Assert.Equal("Project channel identity changed during admission.", Assert.Throws<WorkspaceReadException>(() => rebound.Revalidate(admitted)).Message);
                }
                return Task.FromResult(0);
            });
        }
        finally { Remove(scratch, []); }
    }

    [Fact]
    public async Task FailedResolutionReleasesEveryPartialPin()
    {
        var scratch = NewScratch();
        try
        {
            var (main, worktree, gitDirectory) = LinkedWorktree(scratch);
            var pointer = Path.Combine(worktree, ".git"); var commondir = Path.Combine(gitDirectory, "commondir");
            File.WriteAllText(commondir, "../../../../missing/.git");
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                using var folder = RepositoryFolderLease.Open(loop, worktree);
                Assert.Equal("Project folder is unavailable.", Assert.Throws<WorkspaceReadException>(() => GitRepositoryLease.Open(loop, folder)).Message);
                File.AppendAllText(pointer, "\n");
                File.Move(commondir, commondir + ".moved"); File.Move(commondir + ".moved", commondir);
                Directory.Move(gitDirectory, gitDirectory + "-moved"); Directory.Move(gitDirectory + "-moved", gitDirectory);
                Directory.Move(Path.Combine(main, ".git"), Path.Combine(main, "git-moved"));
                return Task.FromResult(0);
            });
        }
        finally { Remove(scratch, []); }
    }

    [Fact]
    public async Task LeaseIsOwnedByItsLoop()
    {
        var scratch = NewScratch();
        try
        {
            var (_, worktree, _) = LinkedWorktree(scratch);
            await using var loop = new RuntimeLoop();
            var folder = await loop.Invoke(() => Task.FromResult(RepositoryFolderLease.Open(loop, worktree)));
            Assert.Throws<InvalidOperationException>(() => GitRepositoryLease.Open(loop, folder));
            var lease = await loop.Invoke(() => Task.FromResult(GitRepositoryLease.Open(loop, folder)!));
            Assert.Throws<InvalidOperationException>(() => lease.Revalidate(lease.Identity));
            Assert.Throws<InvalidOperationException>(lease.Dispose);
            await loop.Invoke(() => { lease.Dispose(); lease.Dispose(); folder.Dispose(); return Task.FromResult(0); });
            await loop.Invoke(() => { Assert.Throws<ObjectDisposedException>(() => lease.Revalidate(lease.Identity)); return Task.FromResult(0); });
        }
        finally { Remove(scratch, []); }
    }

    [Fact]
    public async Task FolderWithoutRepositoryHasNoLease()
    {
        var scratch = NewScratch();
        try
        {
            for (var ancestor = new DirectoryInfo(scratch); ancestor is not null; ancestor = ancestor.Parent)
                if (Path.Exists(Path.Combine(ancestor.FullName, ".git"))) Assert.Skip($"The scratch directory is inside a repository at {ancestor.FullName}.");
            var folder = Directory.CreateDirectory(Path.Combine(scratch, "plain")).FullName;
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                using var lease = RepositoryFolderLease.Open(loop, folder);
                Assert.Null(GitRepositoryLease.Open(loop, lease));
                return Task.FromResult(0);
            });
        }
        finally { Remove(scratch, []); }
    }

    private const string Invalid = "Invalid Git project metadata.";
    private const string Reparse = "Projects through reparse directories are not supported.";

    [Theory]
    [InlineData("a ")]
    [InlineData("b..")]
    public async Task NamesWin32WouldNormalizeCannotRedirectVerificationToADecoy(string alias)
    {
        var scratch = NewScratch();
        var link = Path.Combine(scratch, alias);
        try
        {
            // The normalized name is a plain decoy; the exact name is a junction. Verifying one and traversing the other
            // would admit an alias (or reach a network target) unchecked.
            var target = Directory.CreateDirectory(Path.Combine(scratch, "target", "inner", ".git")).Parent!.Parent!.FullName;
            Directory.CreateDirectory(Path.Combine(scratch, alias.TrimEnd(' ', '.'), "inner", ".git"));
            RawJunction.Create(link, target);
            var (_, worktree, gitDirectory) = LinkedWorktree(scratch);
            Assert.Throws<ReparsePointException>(() => DirectoryLease.AcquireExisting(Path.Combine(link, "inner")));
            // As the last component the exact name is refused outright rather than normalized onto the decoy.
            foreach (var final in new[] { link, link + "\\" })
            {
                Assert.Throws<IOException>(() => DirectoryLease.AcquireExisting(final));
                Assert.Throws<IOException>(() => DirectoryLease.AcquireExistingSharingWrites(final));
                Assert.Throws<IOException>(() => DirectoryLease.Acquire(final));
            }
            using (DirectoryLease.AcquireExisting(Path.Combine(scratch, alias.TrimEnd(' ', '.')))) { }
            using (DirectoryLease.AcquireExisting(Path.Combine(scratch, "target", "inner", "."))) { }
            using (DirectoryLease.AcquireExisting(Path.Combine(scratch, "target", "inner", ".git", ".."))) { }
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                Assert.Equal(Reparse, Assert.Throws<WorkspaceReadException>(() => RepositoryFolderLease.Open(loop, Path.Combine(link, "inner"))).Message);
                using var folder = RepositoryFolderLease.Open(loop, worktree);
                File.WriteAllText(Path.Combine(worktree, ".git"), $"gitdir: ../{alias}/inner/.git");
                Assert.Equal(Invalid, Assert.Throws<WorkspaceReadException>(() => GitRepositoryLease.Open(loop, folder)).Message);
                File.WriteAllText(Path.Combine(worktree, ".git"), "gitdir: ../main/.git/worktrees/wt");
                File.WriteAllText(Path.Combine(gitDirectory, "commondir"), $"../../../../{alias}/inner/.git");
                Assert.Equal(Invalid, Assert.Throws<WorkspaceReadException>(() => GitRepositoryLease.Open(loop, folder)).Message);
                return Task.FromResult(0);
            });
        }
        finally { RawJunction.Delete(link); Remove(scratch, []); }
    }

    [Theory]
    [InlineData("gitdir: ../main/.git/worktrees/wt.")]
    [InlineData("gitdir: ../main /.git/worktrees/wt")]
    [InlineData("gitdir: ../main./.git/worktrees/wt")]
    [InlineData("gitdir: ../main/.git/worktrees/wt:stream")]
    [InlineData("gitdir: ../nul")]
    [InlineData("gitdir: ../main/con.txt/x")]
    [InlineData("gitdir: ../COM\u00b9")]
    public async Task NamesWin32WouldReadAsAnotherEntryAreRefusedAsInvalidMetadata(string contents)
    {
        var scratch = NewScratch();
        try
        {
            var (_, worktree, _) = LinkedWorktree(scratch);
            File.WriteAllText(Path.Combine(worktree, ".git"), contents);
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                using var folder = RepositoryFolderLease.Open(loop, worktree);
                Assert.Equal(Invalid, Assert.Throws<WorkspaceReadException>(() => GitRepositoryLease.Open(loop, folder)).Message);
                return Task.FromResult(0);
            });
        }
        finally { Remove(scratch, []); }
    }

    [Fact]
    public async Task PathsBeyondMaxPathResolveLikeShortOnes()
    {
        var scratch = NewScratch();
        try
        {
            var deep = Directory.CreateDirectory(Path.Combine(scratch, string.Join('\\', Enumerable.Repeat(new string('d', 60), 5)))).FullName;
            var (main, worktree, gitDirectory) = LinkedWorktree(deep);
            Assert.True(gitDirectory.Length > 300);
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                using var folder = RepositoryFolderLease.Open(loop, worktree);
                using var lease = GitRepositoryLease.Open(loop, folder)!;
                Assert.Equal(new GitAdmissionIdentity(worktree, worktree, gitDirectory, Path.Combine(main, ".git")), lease.Identity);
                return Task.FromResult(0);
            });
        }
        finally { Remove(scratch, []); }
    }

    [Fact]
    public void SerializationKeyIsTheEcmaScriptLowercaseCommonDirectory()
    {
        // Node: "C:\\Repo\\\u0130\\\u03a3\u0391\u03a3\\.git".toLowerCase(), with U+0130's full mapping and the final-sigma rule.
        var identity = new GitAdmissionIdentity(@"C:\Repo", @"C:\Repo", @"C:\Repo\.git", "C:\\Repo\\\u0130\\\u03a3\u0391\u03a3\\.git");
        Assert.Equal("c:\\repo\\i\u0307\\\u03c3\u03b1\u03c2\\.git", identity.SerializationKey);
    }

    private sealed record Outcome(string?[]? Identity, string? Error);

    private static Outcome Admit(RuntimeLoop loop, string project, string scratch)
    {
        RepositoryFolderLease folder;
        try { folder = RepositoryFolderLease.Open(loop, project); }
        catch (Exception exception) when (exception is WorkspaceReadException or IOException) { return new(null, exception.Message); }
        using (folder)
        {
            try
            {
                using var lease = GitRepositoryLease.Open(loop, folder) ?? throw new InvalidOperationException("Fixture tree has no repository.");
                var identity = lease.Identity;
                return new([Relative(identity.Path, scratch), Relative(identity.Root, scratch), Relative(identity.GitDirectory, scratch), Relative(identity.Common, scratch)], null);
            }
            catch (WorkspaceReadException exception) { return new(null, exception.Message); }
        }
    }

    private static string Relative(string value, string scratch) =>
        value == scratch ? "{scratch}" : value.StartsWith(scratch + "\\", StringComparison.Ordinal) ? "{scratch}" + value[scratch.Length..] : value;

    private static string NewScratch() => FinalPath.Canonical(Directory.CreateTempSubdirectory("foundry-p2-git-identity-").FullName);

    private static (string Main, string Worktree, string GitDirectory) LinkedWorktree(string scratch)
    {
        var main = Path.Combine(scratch, "main"); var worktree = Directory.CreateDirectory(Path.Combine(scratch, "wt")).FullName;
        var gitDirectory = Directory.CreateDirectory(Path.Combine(main, ".git", "worktrees", "wt")).FullName;
        File.WriteAllText(Path.Combine(worktree, ".git"), "gitdir: ../main/.git/worktrees/wt\n");
        File.WriteAllText(Path.Combine(gitDirectory, "commondir"), "../..\n");
        return (main, worktree, gitDirectory);
    }

    private static string OtherDrive(string scratch)
    {
        foreach (var letter in "QRSTUVWXYZ")
            if (char.ToUpperInvariant(scratch[0]) != letter && !Directory.Exists($"{letter}:\\")) return $"{letter}:";
        throw new InvalidOperationException("No unused drive letter for the cross-drive case.");
    }

    private static string Expand(string text, string scratch) =>
        text.Replace("{scratch/}", scratch.Replace('\\', '/'), StringComparison.Ordinal).Replace("{scratch-nodrive}", scratch[2..], StringComparison.Ordinal)
            .Replace("{scratch}", scratch, StringComparison.Ordinal).Replace("{other-drive}", OtherDrive(scratch), StringComparison.Ordinal)
            .Replace("{drive}", scratch[..2], StringComparison.Ordinal);

    private static async Task Build(string scratch, JsonElement tree, List<string> links)
    {
        foreach (var step in tree.EnumerateArray())
        {
            if (step.TryGetProperty("dir", out var directory)) Directory.CreateDirectory(Local(scratch, directory));
            else if (step.TryGetProperty("file", out var file))
            {
                var target = Local(scratch, file);
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                var bytes = Encoding.UTF8.GetBytes(Expand(step.GetProperty("text").GetString()!, scratch));
                if (step.TryGetProperty("pad", out var pad)) bytes = [.. bytes, .. Enumerable.Repeat((byte)0x20, pad.GetInt32() - bytes.Length)];
                File.WriteAllBytes(target, bytes);
            }
            else if (step.TryGetProperty("junction", out var junction))
            {
                var link = Local(scratch, junction);
                await Run(Comspec, ["/d", "/c", "mklink", "/J", link, Local(scratch, step.GetProperty("target"))], scratch);
                links.Add(link);
            }
            else
            {
                string[] fixture = ["-c", $"core.hooksPath={Path.Combine(scratch, "no-fixture-hooks")}", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main",
                    "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];
                await Run("git", [.. fixture, .. step.GetProperty("git").EnumerateArray().Select(argument => argument.GetString()!)], scratch);
            }
        }
    }

    private static string Local(string scratch, JsonElement relative) => Path.Combine(scratch, relative.GetString()!.Replace('/', '\\'));

    private static string Comspec => Environment.GetEnvironmentVariable("ComSpec") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");

    private static async Task Run(string application, IEnumerable<string> arguments, string workingDirectory)
    {
        var info = new ProcessStartInfo(application) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = workingDirectory };
        foreach (var argument in arguments) info.ArgumentList.Add(argument);
        foreach (var name in info.Environment.Keys.Where(key => key.StartsWith("GIT_", StringComparison.OrdinalIgnoreCase)).ToList()) info.Environment.Remove(name);
        using var process = Process.Start(info)!;
        var output = process.StandardOutput.ReadToEndAsync(TestContext.Current.CancellationToken); var error = process.StandardError.ReadToEndAsync(TestContext.Current.CancellationToken);
        await process.WaitForExitAsync(TestContext.Current.CancellationToken);
        Assert.True(process.ExitCode == 0, $"{application} exited with {process.ExitCode}: {await output}{await error}");
    }

    private static void Remove(string scratch, List<string> links)
    {
        foreach (var link in links) if (Directory.Exists(link)) Directory.Delete(link);
        // Git writes read-only object files.
        foreach (var file in new DirectoryInfo(scratch).EnumerateFiles("*", new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = FileAttributes.ReparsePoint }))
            file.Attributes = FileAttributes.Normal;
        Directory.Delete(scratch, true);
    }
}
