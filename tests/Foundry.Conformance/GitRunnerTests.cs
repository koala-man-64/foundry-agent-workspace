using System.Diagnostics;
using System.Runtime.InteropServices;
using Foundry.Platform;
using Foundry.Protocol;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

/// <summary>Native Git execution boundary: environment, executable selection, process limits, revalidation and the per-repository queue.</summary>
public sealed class GitRunnerTests
{
    private static string RealGit()
    {
        foreach (var entry in GitRunner.ProcessEnvironment()["PATH"].Split(';'))
        {
            var candidate = Path.Combine(entry.Trim().Trim('"'), "git.exe");
            if (Path.IsPathFullyQualified(candidate) && File.Exists(candidate) && FinalPath.TryResolve(candidate, out var resolved)) return resolved;
        }
        throw new InvalidOperationException("The test machine has no Git on PATH.");
    }

    private static async Task<RepositoryFixture> Repository(string prefix, params (string Name, string Text)[] files)
    {
        var fixture = RepositoryFixture.Create(prefix);
        fixture.Write("repo/README.md", "hello\n");
        foreach (var (name, text) in files) fixture.Write("repo/" + name, text);
        await fixture.Git("-C", "repo", "init", "-q"); await fixture.Git("-C", "repo", "add", "-A"); await fixture.Git("-C", "repo", "commit", "-qm", "fixture");
        return fixture;
    }

    [Fact]
    public void SanitizedEnvironmentDropsEveryGitVariableAndPinsTwoSettings()
    {
        // The names and the ones gitEnvironment() keeps come from the Node oracle.
        var sanitization = RepositoryFixture.ReadCorpus("tests/p2/repository-inspection-vectors.json").GetProperty("sanitization");
        var names = sanitization.GetProperty("names").EnumerateArray().Select(name => name.GetString()!).ToList();
        var source = names.ToDictionary(name => name, _ => "value");
        source["GIT_CONFIG_NOSYSTEM"] = "0"; source["GIT_TERMINAL_PROMPT"] = "1";
        var sanitized = GitRunner.Sanitize(source);
        Assert.Equal(sanitization.GetProperty("kept").EnumerateArray().Select(name => name.GetString()!), names.Where(sanitized.ContainsKey));
        Assert.Contains("g\u0131t_index_file", names); Assert.DoesNotContain("g\u0131t_index_file", sanitized.Keys);
        Assert.Equal("1", sanitized["GIT_CONFIG_NOSYSTEM"]); Assert.Equal("0", sanitized["GIT_TERMINAL_PROMPT"]);
        Assert.Equal(sanitization.GetProperty("kept").GetArrayLength() + 2, sanitized.Count);
    }

    [Fact]
    public async Task InheritedGitVariablesCannotRedirectTheRepository()
    {
        using var fixture = await Repository("foundry-p2-git-environment-");
        await fixture.Git("init", "-q", "other");
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            var inherited = new Dictionary<string, string>(fixture.Environment(), StringComparer.OrdinalIgnoreCase)
            {
                ["GIT_DIR"] = fixture.Local("other/.git"), ["GIT_WORK_TREE"] = fixture.Local("other"), ["GIT_INDEX_FILE"] = fixture.Local("other/index"),
                ["GIT_CONFIG_PARAMETERS"] = "'core.hooksPath=elsewhere'",
            };
            var service = new RepositoryService(loop, fixture.Local("wt"), () => inherited);
            var launches = new List<ProcessSpec>();
            service.Git.Launching = launches.Add;
            using var admission = await service.RequireRepository(fixture.Local("repo"));
            Assert.Equal(fixture.Local("repo/.git").Replace('\\', '/'), JsJson.Trim((await service.Run(admission, ["rev-parse", "--absolute-git-dir"])).Stdout));
            Assert.Equal(service.Git.HooksPath, JsJson.Trim((await service.Run(admission, ["config", "--get", "core.hooksPath"])).Stdout));
            Assert.Equal(Path.Join(fixture.Local("wt"), ".empty-git-hooks"), service.Git.HooksPath);
            var last = launches[^1];
            Assert.DoesNotContain(last.Environment.Keys, name => name.StartsWith("GIT_", StringComparison.OrdinalIgnoreCase) && name is not ("GIT_CONFIG_NOSYSTEM" or "GIT_TERMINAL_PROMPT"));
            Assert.Equal("1", last.Environment["GIT_CONFIG_NOSYSTEM"]); Assert.Equal("0", last.Environment["GIT_TERMINAL_PROMPT"]);
            Assert.Equal(fixture.Local("repo"), last.WorkingDirectory);
            Assert.StartsWith(GitRunner.Quote(last.Application) + " --literal-pathspecs --no-pager -c " + GitRunner.Quote("core.hooksPath=" + service.Git.HooksPath) + " -c core.fsmonitor= -c credential.helper= ", last.CommandLine, StringComparison.Ordinal);
            return 0;
        });
    }

    [Fact]
    public async Task ExecutableLookupSkipsRepositoryRelativeAndNetworkEntries()
    {
        using var fixture = await Repository("foundry-p2-git-lookup-");
        var real = RealGit();
        Directory.CreateDirectory(fixture.Local("repo/bin")); File.Copy(real, fixture.Local("repo/bin/git.exe"));
        await using var loop = new RuntimeLoop();
        await loop.Invoke(() =>
        {
            Dictionary<string, string> With(string path) => new(fixture.Environment(), StringComparer.OrdinalIgnoreCase) { ["PATH"] = path };
            var path = $"relative\\bin;\"{fixture.Local("repo/bin")}\";\\\\server\\share\\bin;  \"{Path.GetDirectoryName(real)}\"  ";
            var service = new RepositoryService(loop, fixture.Local("wt"), () => With(path));
            Assert.Equal(real, service.Git.Executable(fixture.Local("repo")));
            // The selection is remembered; a later repository that contains it is refused rather than re-resolved.
            var inside = Assert.Throws<InvalidOperationException>(() => service.Git.Executable(Path.GetDirectoryName(real)!));
            Assert.Equal("Git executable resolves inside the selected repository.", inside.Message);
            var missing = new RepositoryService(loop, fixture.Local("wt"), () => With(fixture.Local("repo/bin")));
            var error = Assert.Throws<InvalidOperationException>(() => missing.Git.Executable(fixture.Local("repo")));
            Assert.Equal("A Git executable was not found in an absolute PATH entry outside the selected repository.", error.Message);
            // As in TypeScript, a failed lookup is remembered for the life of the service.
            Assert.Throws<InvalidOperationException>(() => missing.Git.Executable(fixture.Local("other")));
            return Task.FromResult(0);
        });
    }

    [Fact]
    public async Task TimeoutTerminatesTheWholeProcessTree()
    {
        using var fixture = await Repository("foundry-p2-git-timeout-");
        await using var loop = new RuntimeLoop();
        var elapsed = await loop.Invoke(async () =>
        {
            var service = new RepositoryService(loop, fixture.Local("wt"), fixture.Environment);
            using var admission = await service.RequireRepository(fixture.Local("repo"));
            var clock = Stopwatch.StartNew();
            // The alias runs through Git's shell; sleep is a grandchild that keeps the output pipes open until the job dies.
            var error = await Assert.ThrowsAsync<GitCommandException>(() => service.Run(admission, ["-c", "alias.hang=!sleep 60", "hang"], options: new(TimeSpan.FromSeconds(1))));
            Assert.StartsWith("Git command failed:", error.Message, StringComparison.Ordinal);
            return clock.Elapsed;
        });
        Assert.True(elapsed < TimeSpan.FromSeconds(30), $"The tree outlived its timeout: {elapsed}.");
    }

    [Fact]
    public async Task FailuresAfterTheFinalBoundaryNeverClaimThatNothingChanged()
    {
        using var fixture = await Repository("foundry-p2-git-mutation-timeout-");
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            var service = new RepositoryService(loop, fixture.Local("wt"), fixture.Environment);
            using var admission = await service.RequireRepository(fixture.Local("repo"));
            var started = false;
            // The command mutates, then outlives its timeout: the ref lands although the run fails.
            var error = await Assert.ThrowsAsync<GitCommandException>(() => service.Run(admission,
                ["-c", "alias.mutate=!git update-ref refs/heads/probe HEAD && sleep 60", "mutate"], options: new(TimeSpan.FromSeconds(5), BeforeMutation: () => started = true)));
            // The runner reports the failure without an outcome; only a caller that knows its boundary may classify, and
            // with the final boundary passed that classification is unknown.
            Assert.IsNotType<RepositoryException>(error);
            Assert.True(started);
            return 0;
        });
        Assert.Contains("refs/heads/probe", await fixture.GitOutput("-C", "repo", "show-ref"), StringComparison.Ordinal);
    }

    [Fact]
    public async Task OutputOverflowTruncatesOnlyWhenPermittedAndNonZeroExitOnlyWhenAllowed()
    {
        using var fixture = await Repository("foundry-p2-git-output-", ("big.txt", new string('x', 300 * 1024)));
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            var service = new RepositoryService(loop, fixture.Local("wt"), fixture.Environment);
            using var admission = await service.RequireRepository(fixture.Local("repo"));
            var truncated = await service.Run(admission, ["cat-file", "-p", "HEAD:big.txt"], permitTruncation: true);
            Assert.True(truncated.Truncated); Assert.Equal(GitRunner.MaximumOutputBytes, truncated.Stdout.Length); Assert.Equal(0L, truncated.ExitCode);
            var refused = await Assert.ThrowsAsync<GitCommandException>(() => service.Run(admission, ["cat-file", "-p", "HEAD:big.txt"]));
            Assert.Equal("Git command failed: ", refused.Message);
            Assert.Equal(1L, (await service.Run(admission, ["config", "--get", "no.such"], allowNonZero: true)).ExitCode);
            Assert.Equal("Git command failed: ", (await Assert.ThrowsAsync<GitCommandException>(() => service.Run(admission, ["config", "--get", "no.such"]))).Message);
            var failed = await Assert.ThrowsAsync<GitCommandException>(() => service.Run(admission, ["rev-parse", "--verify", "missing^{commit}"]));
            Assert.Equal("Git command failed: fatal: Needed a single revision", failed.Message);
            Assert.Equal("Git command failed: The argument must be a string without null bytes.", (await Assert.ThrowsAsync<GitCommandException>(() => service.Run(admission, ["log", "a\0b"]))).Message);
            return 0;
        });
    }

    [Fact]
    public async Task IdentityChangesAreRefusedBeforeLaunchAndAfterExit()
    {
        using var fixture = await Repository("foundry-p2-git-revalidate-");
        await fixture.Git("init", "-q", "other");
        var commondir = fixture.Local("repo/.git/commondir");
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            var service = new RepositoryService(loop, fixture.Local("wt"), fixture.Environment);
            var order = new List<string>();
            service.Git.Launching = _ => order.Add("launch");
            using (var admission = await service.RequireRepository(fixture.Local("repo")))
            {
                await service.Run(admission, ["rev-parse", "HEAD"], options: new(BeforeMutation: () => order.Add("final boundary")));
                Assert.Equal(["launch", "launch", "launch", "final boundary", "launch"], order);
                // Pins leave the Git directory writable, so a new commondir is a real identity change that revalidation must see.
                File.WriteAllText(commondir, "../../other/.git\n");
                order.Clear();
                var before = await Assert.ThrowsAsync<WorkspaceReadException>(() => service.Run(admission, ["rev-parse", "HEAD"]));
                Assert.Equal("Project channel identity changed during admission.", before.Message);
                Assert.Empty(order);
                File.Delete(commondir);
                service.Git.Launching = _ => File.WriteAllText(commondir, "../../other/.git\n");
                var after = await Assert.ThrowsAsync<GitCommandException>(() => service.Run(admission, ["rev-parse", "HEAD"]));
                Assert.Equal("Git command failed: Project channel identity changed during admission.", after.Message);
                File.Delete(commondir);
                service.Git.Launching = null;
                var boundary = await Assert.ThrowsAsync<GitCommandException>(() => service.Run(admission, ["rev-parse", "HEAD"], options: new(BeforeMutation: () => throw new WorkspaceReadException("Project channel identity changed during admission."))));
                Assert.Equal("Git command failed: Project channel identity changed during admission.", boundary.Message);
            }
            return 0;
        });
    }

    [Fact]
    public async Task RepositoryQueueSerializesPerCommonRepository()
    {
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            var scratch = Path.GetTempPath();
            var service = new RepositoryService(loop, Path.Combine(scratch, "unused-worktrees"));
            var events = new List<string>();
            var releaseFirst = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var releaseOther = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var firstStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var otherStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var first = service.Serialize<int>("common", async () =>
            {
                // Registered before it starts, even with no predecessor, as TypeScript's .then defers.
                Assert.True(service.IsSerializing("common"));
                events.Add("first start"); firstStarted.SetResult(); await releaseFirst.Task; events.Add("first fail"); throw new RepositoryException("first failed");
            });
            var second = service.Serialize("common", () => { events.Add("second start"); return Task.FromResult(2); });
            var other = service.Serialize("other", async () => { events.Add("other start"); otherStarted.SetResult(); await releaseOther.Task; return 3; });
            Assert.Empty(events);
            Assert.True(service.IsSerializing("common")); Assert.True(service.IsSerializing("other"));
            await firstStarted.Task; await otherStarted.Task;
            Assert.Equal(["first start", "other start"], events);
            releaseFirst.SetResult();
            await Assert.ThrowsAsync<RepositoryException>(() => first);
            Assert.Equal(2, await second);
            Assert.Equal(["first start", "other start", "first fail", "second start"], events);
            Assert.False(service.IsSerializing("common"));
            releaseOther.SetResult(); Assert.Equal(3, await other);
            Assert.False(service.IsSerializing("other"));
            return 0;
        });
    }

    [Fact]
    public async Task IntentsUseTheTypeScriptDocumentAndStates()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-intents-").FullName;
        try
        {
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                var ids = new Queue<Guid>([Guid.Parse("19191919-0000-4000-8000-000000000001")]);
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), id: () => ids.Dequeue());
                var intent = store.Intent("worktree.create", new Dictionary<string, object?> { ["taskId"] = "t", ["projectPath"] = "C:\\x", ["requestId"] = "r" });
                Assert.Equal("19191919-0000-4000-8000-000000000001", intent);
                var row = store.Rows("SELECT id,kind,data,state FROM intents WHERE id=$p0", intent).Single();
                Assert.Equal("{\"taskId\":\"t\",\"projectPath\":\"C:\\\\x\",\"requestId\":\"r\"}", row["data"]);
                Assert.Equal("pending", row["state"]); Assert.Equal(0L, store.UnknownWorktreeIntents());
                store.FinishIntent(intent, "unknown"); Assert.Equal(1L, store.UnknownWorktreeIntents());
                store.FinishIntent(intent, "complete"); Assert.Equal(0L, store.UnknownWorktreeIntents());
                Assert.Throws<ArgumentOutOfRangeException>(() => store.FinishIntent(intent, "failed"));
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Theory]
    [InlineData(""), InlineData("plain"), InlineData("a b"), InlineData("a\tb"), InlineData("a\"b"), InlineData("a\\b"), InlineData("a\\\"b"), InlineData("a b\\"),
     InlineData("a b\\\\"), InlineData("\\\\server\\x y"), InlineData("ends\\"), InlineData("\""), InlineData("\\\""), InlineData("日本 語"), InlineData("core.hooksPath=C:\\a b\\.empty-git-hooks")]
    public void QuotingRoundTripsThroughTheWindowsArgumentParser(string argument)
    {
        var parsed = Split("x.exe " + GitRunner.Quote(argument) + " tail");
        Assert.Equal(["x.exe", argument, "tail"], parsed);
    }

    [Fact]
    public async Task RepositoryOperationsRequireTheOwningLoop()
    {
        await using var loop = new RuntimeLoop();
        var service = await loop.Invoke(() => Task.FromResult(new RepositoryService(loop, Path.Combine(Path.GetTempPath(), "unused"))));
        Assert.Throws<InvalidOperationException>(() => new RepositoryService(loop, "C:\\unused"));
        Assert.Equal("Runtime state requires its owning loop.", Assert.Throws<InvalidOperationException>(() => service.ListFiles("C:\\never-probe")).Message);
        Assert.Equal("Runtime state requires its owning loop.", (await Assert.ThrowsAsync<InvalidOperationException>(() => service.Serialize("key", () => Task.FromResult(0)))).Message);
    }

    [Fact]
    public async Task ExistingEntriesAreOpenedWithoutFollowingAndCannotBeReplacedWhileHeld()
    {
        using var fixture = RepositoryFixture.Create("foundry-p2-existing-entry-");
        fixture.Write("dir/file.txt", "content");
        await fixture.Junction("link", "dir");
        Assert.Null(ExistingEntry.TryOpen(fixture.Local("dir/missing.txt")));
        Assert.Null(ExistingEntry.TryOpen(fixture.Local("missing/file.txt")));
        using (var link = ExistingEntry.TryOpen(fixture.Local("link"))!) Assert.True(link.IsReparsePoint);
        using (var directory = ExistingEntry.TryOpen(fixture.Local("dir"))!)
        {
            Assert.True(directory.IsDirectory); Assert.Equal(fixture.Local("dir"), directory.FinalPath());
            Assert.Throws<IOException>(() => directory.ReadBounded(1));
        }
        using (var file = ExistingEntry.TryOpen(fixture.Local("dir/file.txt"))!)
        {
            Assert.False(file.IsDirectory); Assert.False(file.IsReparsePoint); Assert.Equal(7, file.Length); Assert.Equal(1u, file.Links);
            Assert.Equal("content", System.Text.Encoding.UTF8.GetString(file.ReadBounded(7)));
            Assert.Throws<InvalidDataException>(() => file.ReadBounded(6));
            Assert.Throws<IOException>(() => File.Move(fixture.Local("dir/file.txt"), fixture.Local("dir/moved.txt")));
            Assert.Throws<IOException>(() => File.Delete(fixture.Local("dir/file.txt")));
            File.WriteAllText(fixture.Local("dir/file.txt"), "writers are shared");
        }
        Assert.Throws<IOException>(() => ExistingEntry.TryOpen(@"\\server\share\file.txt"));
        // NUL is refused before any open; Win32 would otherwise truncate the name and open "file.txt".
        Assert.Throws<IOException>(() => ExistingEntry.TryOpen(fixture.Local("dir/file.txt") + "\0zzz"));
    }

    private static string[] Split(string commandLine)
    {
        var pointer = CommandLineToArgvW(commandLine, out var count);
        if (pointer == IntPtr.Zero) throw new InvalidOperationException("CommandLineToArgvW failed.");
        try { return [.. Enumerable.Range(0, count).Select(index => Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer, index * IntPtr.Size))!)]; }
        finally { LocalFree(pointer); }
    }

#pragma warning disable SYSLIB1054 // A test-only parser oracle; the test project does not enable unsafe code for generated interop.
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CommandLineToArgvW(string commandLine, out int count);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);
#pragma warning restore SYSLIB1054
}
