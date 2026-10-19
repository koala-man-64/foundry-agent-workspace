using Foundry.Platform;
using Foundry.Providers;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

/// <summary>
/// Rudy's drive decision (19 October 2026), call site by call site: a project may sit on a removable drive, as TypeScript
/// admits it, while network and mapped network drives (decision 8), optical drives, RAM disks and unknown or unmounted
/// roots stay refused, and the data directory, the app-owned worktree base and its hooks folder stay fixed-only. The
/// fixture's folders are given those drive types with <see cref="DriveAdmissions.Fake"/>; no physical drive is involved.
/// </summary>
public sealed class RemovableProjectDriveTests
{
    public static TheoryData<DriveType> RefusedTypes() => [DriveType.Network, DriveType.NoRootDirectory, DriveType.Unknown, DriveType.CDRom, DriveType.Ram];

    /// <summary>A mapped network drive keeps decision 8's message; every other refused type is "unavailable".</summary>
    private static string FolderRefusal(DriveType type) => type is DriveType.Network ? RepositoryFolderLease.Network : RepositoryFolderLease.Unavailable;

    private static async Task<RepositoryFixture> Repository(string prefix, string relative)
    {
        var fixture = RepositoryFixture.Create(prefix);
        fixture.Write($"{relative}/README.md", "hello\n"); fixture.Write($"{relative}/src/a.txt", "a\n"); fixture.Write($"{relative}/src/inner/b.txt", "b\n");
        await fixture.Git("-C", fixture.Local(relative), "init", "-q"); await fixture.Git("-C", fixture.Local(relative), "add", "-A");
        await fixture.Git("-C", fixture.Local(relative), "commit", "-qm", "fixture");
        return fixture;
    }

    // RepositoryFolderLease.TryOpen: the folder every project path is admitted through.

    [Fact]
    public async Task AFolderOnARemovableDriveIsAdmittedAndAFileThereIsClassified()
    {
        using var fixture = RepositoryFixture.Create("foundry-drive-folder-");
        var project = Directory.CreateDirectory(fixture.Local("usb/project")).FullName;
        fixture.Write("usb/file.txt", "x");
        using var drive = DriveAdmissions.Fake(fixture.Local("usb"), DriveType.Removable);
        await using var loop = new RuntimeLoop();
        await loop.Invoke(() =>
        {
            using (var folder = RepositoryFolderLease.Open(loop, project)) Assert.Equal(project, folder.Path);
            Assert.Null(RepositoryFolderLease.TryOpen(loop, fixture.Local("usb/file.txt")));
            return Task.FromResult(0);
        });
    }

    [Theory, MemberData(nameof(RefusedTypes))]
    public async Task AFolderOnAnyOtherDriveTypeIsRefusedBeforeAnythingOnItIsOpened(DriveType type)
    {
        using var fixture = RepositoryFixture.Create("foundry-drive-folder-refused-");
        var project = Directory.CreateDirectory(fixture.Local("drive/project")).FullName;
        fixture.Write("drive/file.txt", "x");
        using var drive = DriveAdmissions.Fake(fixture.Local("drive"), type);
        await using var loop = new RuntimeLoop();
        await loop.Invoke(() =>
        {
            Assert.Equal(FolderRefusal(type), Assert.Throws<WorkspaceReadException>(() => RepositoryFolderLease.Open(loop, project)).Message);
            // Refused before the classification probe: an existing file is not classified, as it is on a removable drive.
            Assert.Equal(FolderRefusal(type), Assert.Throws<WorkspaceReadException>(() => RepositoryFolderLease.TryOpen(loop, fixture.Local("drive/file.txt"))).Message);
            return Task.FromResult(0);
        });
    }

    // GitRepositoryLease: the folder's chain and every Git directory its pointers name (Acquire and PinnedDirectory).

    [Fact]
    public async Task GitDirectoriesOnRemovableDrivesResolveInEitherDirection()
    {
        using var fixture = RepositoryFixture.Create("foundry-drive-git-");
        // A worktree on a removable drive whose Git directories sit on a fixed one, and the reverse.
        var removableWorktree = LinkedWorktree(fixture, "usb/wt", "fixed/main");
        var fixedWorktree = LinkedWorktree(fixture, "fixed/wt", "usb/main");
        using var drive = DriveAdmissions.Fake(fixture.Local("usb"), DriveType.Removable);
        await using var loop = new RuntimeLoop();
        await loop.Invoke(() =>
        {
            foreach (var (worktree, main) in new[] { (removableWorktree, "fixed/main"), (fixedWorktree, "usb/main") })
            {
                using var folder = RepositoryFolderLease.Open(loop, worktree);
                using var lease = GitRepositoryLease.Open(loop, folder)!;
                Assert.Equal(fixture.Local(main + "/.git"), lease.Identity.Common);
                lease.Revalidate(lease.Identity);
            }
            return Task.FromResult(0);
        });
    }

    [Theory, MemberData(nameof(RefusedTypes))]
    public async Task AGitDirectoryOnAnyOtherDriveTypeIsRefused(DriveType type)
    {
        using var fixture = RepositoryFixture.Create("foundry-drive-git-refused-");
        var worktree = LinkedWorktree(fixture, "usb/wt", "other/main");
        using var removable = DriveAdmissions.Fake(fixture.Local("usb"), DriveType.Removable);
        using var other = DriveAdmissions.Fake(fixture.Local("other"), type);
        await using var loop = new RuntimeLoop();
        await loop.Invoke(() =>
        {
            using var folder = RepositoryFolderLease.Open(loop, worktree);
            Assert.Equal(FolderRefusal(type), Assert.Throws<WorkspaceReadException>(() => GitRepositoryLease.Open(loop, folder)).Message);
            return Task.FromResult(0);
        });
    }

    /// <summary>A hand-built linked worktree: <paramref name="worktree"/>'s gitdir and common directory are in <paramref name="main"/>.</summary>
    private static string LinkedWorktree(RepositoryFixture fixture, string worktree, string main)
    {
        var folder = Directory.CreateDirectory(fixture.Local(worktree)).FullName;
        var gitDirectory = Directory.CreateDirectory(fixture.Local(main + "/.git/worktrees/wt")).FullName;
        File.WriteAllText(Path.Combine(folder, ".git"), $"gitdir: {gitDirectory}\n");
        File.WriteAllText(Path.Combine(gitDirectory, "commondir"), "../..\n");
        return folder;
    }

    // RepositoryPaths.SameFolder: project spellings by identity; the app-owned worktree folder stays fixed-only.

    [Fact]
    public void SameFolderAdmitsARemovableDriveOnlyForProjects()
    {
        using var fixture = RepositoryFixture.Create("foundry-drive-same-");
        var folder = Directory.CreateDirectory(fixture.Local("usb/Folder")).FullName;
        Assert.True(RepositoryPaths.SameFolder(folder, folder, DriveAdmission.Fixed));
        using var drive = DriveAdmissions.Fake(fixture.Local("usb"), DriveType.Removable);
        Assert.True(RepositoryPaths.SameFolder(fixture.Local("usb/FOLDER"), folder, DriveAdmission.Project));
        Assert.False(RepositoryPaths.SameFolder(fixture.Local("usb/FOLDER"), folder, DriveAdmission.Fixed));
    }

    [Theory, MemberData(nameof(RefusedTypes))]
    public void SameFolderRefusesAnyOtherDriveType(DriveType type)
    {
        using var fixture = RepositoryFixture.Create("foundry-drive-same-refused-");
        var folder = Directory.CreateDirectory(fixture.Local("drive/Folder")).FullName;
        using var drive = DriveAdmissions.Fake(fixture.Local("drive"), type);
        Assert.False(RepositoryPaths.SameFolder(folder, folder, DriveAdmission.Project));
    }

    [Fact]
    public async Task TheAppOwnedWorktreeFolderMatchesOnlyOnAFixedDrive()
    {
        using var fixture = RepositoryFixture.Create("foundry-drive-own-worktree-");
        var taskId = Guid.NewGuid().ToString();
        var worktree = Directory.CreateDirectory(fixture.Local("wt/" + taskId)).FullName;
        await using var loop = new RuntimeLoop();
        await loop.Invoke(() =>
        {
            var service = new RepositoryService(loop, fixture.Local("wt"), fixture.Environment);
            Assert.True(service.IsOwnWorktree(taskId, worktree));
            using (DriveAdmissions.Fake(fixture.Local("wt"), DriveType.Removable)) Assert.False(service.IsOwnWorktree(taskId, worktree));
            return Task.FromResult(0);
        });
    }

    // RepositoryPaths.SameFolder from the project channel and the folder-chat retry: both compare a saved spelling.

    /// <summary>The project channel compares the approved spelling by identity only when it differs from the canonical path
    /// (AgentChannel.Project), as an 8.3 spelling does.</summary>
    [Fact]
    public async Task AProjectChannelAdmitsAShortSpellingOfAFolderOnARemovableDrive()
    {
        using var fixture = RepositoryFixture.Create("foundry-drive-channel-");
        var project = Directory.CreateDirectory(fixture.Local("usb/a project folder")).FullName;
        Directory.CreateDirectory(Path.Combine(project, ".git"));
        var shortName = ShortPath(project);
        if (shortName is null || string.Equals(shortName, project, StringComparison.OrdinalIgnoreCase)) Assert.Skip("This volume does not generate short (8.3) names.");
        var data = Directory.CreateDirectory(fixture.Local("data")).FullName;
        // One drive, whichever spelling reaches it.
        using var drive = DriveAdmissions.Fake(fixture.Local("usb"), DriveType.Removable);
        using var shortDrive = DriveAdmissions.Fake(Path.GetDirectoryName(shortName)!, DriveType.Removable);
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            using var store = new Store(loop, data, Path.Combine(fixture.Scratch, "injected-root"));
            var chat = new DevelopmentChat(loop, store, (request, token) => new FakeChatProvider().StreamTurn(request, token), null, null, fixture.Environment);
            const string TaskId = "78787878-0000-4000-8000-000000000001";
            store.SaveTask(new()
            {
                ["id"] = TaskId, ["title"] = "Short spelling", ["profileId"] = Store.FakeProfileId, ["status"] = "running", ["createdAt"] = "2026-01-01T00:00:00.000Z",
                ["updatedAt"] = "2026-01-01T00:00:00.000Z", ["tokenBudget"] = 100000d, ["usedTokens"] = 0d, ["mode"] = "coding", ["workspaceKind"] = "git", ["projectPath"] = shortName,
                ["worktreePath"] = project, ["branch"] = "fixture", ["baseCommit"] = new string('a', 40),
            });
            var view = (Dictionary<string, object?>)(await chat.Dispatch("channel.get", new() { ["taskId"] = TaskId }))!;
            Assert.Single((List<object?>)view["participants"]!);
            await chat.Shutdown();
            return 0;
        });
    }

    /// <summary>A failed start's retry admits the saved folder again by identity (DevelopmentChat.RequireRetryableFolder)
    /// before it reaches the same refusal.</summary>
    [Fact]
    public async Task AFailedStartInAProjectOnARemovableDriveIsRetried()
    {
        using var fixture = await Repository("foundry-drive-retry-", "usb/repo");
        var data = Directory.CreateDirectory(fixture.Local("data")).FullName;
        using var drive = DriveAdmissions.Fake(fixture.Local("usb"), DriveType.Removable);
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            using var store = new Store(loop, data, Path.Combine(fixture.Scratch, "injected-root"));
            var chat = new DevelopmentChat(loop, store, null, null, null, fixture.Environment);
            try
            {
                var projectId = (string)((Dictionary<string, object?>)(await chat.Dispatch("project.add", new() { ["path"] = fixture.Local("usb/repo") }))!)["id"]!;
                var parameters = new Dictionary<string, object?>
                {
                    ["requestId"] = "78787878-0000-4000-8000-000000000002", ["projectId"] = projectId, ["content"] = "Hello", ["profileId"] = Store.FakeProfileId, ["mode"] = "coding", ["tokenBudget"] = 1024d,
                };
                const string Budget = "Insufficient task budget for the conservative request reservation.";
                Assert.Equal(Budget, (await Record.ExceptionAsync(() => chat.Dispatch("task.start", parameters)))!.Message);
                Assert.Equal("failed", store.Scalar("SELECT state FROM task_starts"));
                Assert.Equal(Budget, (await Record.ExceptionAsync(() => chat.Dispatch("task.start", parameters)))!.Message);
            }
            finally { await chat.Shutdown(); }
            return 0;
        });
    }

    private static string? ShortPath(string path)
    {
        var buffer = new char[1024];
        var length = GetShortPathName(path, buffer, (uint)buffer.Length);
        return length == 0 || length >= buffer.Length ? null : new string(buffer, 0, (int)length);
    }

#pragma warning disable SYSLIB1054 // A test-only probe; the test project does not enable unsafe code for generated interop.
    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
    private static extern uint GetShortPathName(string longPath, char[] shortPath, uint length);
#pragma warning restore SYSLIB1054

    // RepositoryService.IsGitWorkingTree: Git's reported top level is opened only on a drive a project may sit on.

    [Fact]
    public async Task ARepositoryOnARemovableDriveIsAGitWorkingTree()
    {
        using var fixture = await Repository("foundry-drive-working-tree-", "usb/repo");
        Directory.CreateDirectory(fixture.Local("usb/plain"));
        using var drive = DriveAdmissions.Fake(fixture.Local("usb"), DriveType.Removable);
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            var service = new RepositoryService(loop, fixture.Local("wt"), fixture.Environment);
            Assert.True(await service.IsGitWorkingTree(fixture.Local("usb/repo")));
            Assert.False(await service.IsGitWorkingTree(fixture.Local("usb/plain")));
            Assert.False(await service.IsGitWorkingTree(fixture.Local("usb/repo/src")));
            return 0;
        });
    }

    [Theory, MemberData(nameof(RefusedTypes))]
    public async Task ARepositoryOnAnyOtherDriveTypeIsRefused(DriveType type)
    {
        using var fixture = await Repository("foundry-drive-working-tree-refused-", "drive/repo");
        using var drive = DriveAdmissions.Fake(fixture.Local("drive"), type);
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            var service = new RepositoryService(loop, fixture.Local("wt"), fixture.Environment);
            Assert.Equal(FolderRefusal(type), (await Assert.ThrowsAsync<WorkspaceReadException>(() => service.IsGitWorkingTree(fixture.Local("drive/repo")))).Message);
            return 0;
        });
    }

    // RepositoryService.OpenSafe: the parent chain of every file read, listing and edit inside an admitted root.

    [Fact]
    public async Task FilesOnARemovableDriveAreListedAndRead()
    {
        using var fixture = await Repository("foundry-drive-files-", "usb/repo");
        using var drive = DriveAdmissions.Fake(fixture.Local("usb"), DriveType.Removable);
        await using var loop = new RuntimeLoop();
        await loop.Invoke(() =>
        {
            var service = new RepositoryService(loop, fixture.Local("wt"), fixture.Environment);
            Assert.Equal("a\n", service.ReadFile(fixture.Local("usb/repo"), "src/a.txt")["content"]);
            Assert.Equal(["src/inner/b.txt"], service.ListFiles(fixture.Local("usb/repo"), "src/inner").Select(entry => (string)entry["path"]!));
            return Task.FromResult(0);
        });
    }

    /// <summary>The root is admitted on a removable drive; the folder holding the entry reports another type, so only
    /// OpenSafe's own chain check can refuse it.</summary>
    [Theory, MemberData(nameof(RefusedTypes))]
    public async Task FilesBeneathAnyOtherDriveTypeAreRefused(DriveType type)
    {
        using var fixture = await Repository("foundry-drive-files-refused-", "usb/repo");
        using var drive = DriveAdmissions.Fake(fixture.Local("usb"), DriveType.Removable);
        using var inner = DriveAdmissions.Fake(fixture.Local("usb/repo/src"), type);
        await using var loop = new RuntimeLoop();
        await loop.Invoke(() =>
        {
            var service = new RepositoryService(loop, fixture.Local("wt"), fixture.Environment);
            Assert.Equal(RepositoryService.Missing, Assert.Throws<WorkspaceReadException>(() => service.ReadFile(fixture.Local("usb/repo"), "src/a.txt")).Message);
            Assert.Equal(RepositoryService.Missing, Assert.Throws<WorkspaceReadException>(() => service.ListFiles(fixture.Local("usb/repo"), "src/inner")).Message);
            Assert.Equal("hello\n", service.ReadFile(fixture.Local("usb/repo"), "README.md")["content"]);
            return Task.FromResult(0);
        });
    }

    // CommandRunner.AdmitWorkingDirectory: a command's working directory inside the admitted root.

    [Fact]
    public async Task ACommandWorkingDirectoryOnARemovableDriveIsAdmitted()
    {
        using var fixture = await Repository("foundry-drive-command-", "usb/repo");
        using var drive = DriveAdmissions.Fake(fixture.Local("usb"), DriveType.Removable);
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            var repositories = new RepositoryService(loop, fixture.Local("wt"), fixture.Environment);
            var prepared = await new CommandRunner(loop, repositories, fixture.Environment).Prepare(fixture.Local("usb/repo"), new("[Console]::Out.WriteLine('x')", "src", [], 10_000));
            Assert.Equal(fixture.Local("usb/repo/src"), prepared.Cwd);
            return 0;
        });
    }

    [Theory, MemberData(nameof(RefusedTypes))]
    public async Task ACommandWorkingDirectoryOnAnyOtherDriveTypeIsRefused(DriveType type)
    {
        using var fixture = await Repository("foundry-drive-command-refused-", "usb/repo");
        using var drive = DriveAdmissions.Fake(fixture.Local("usb"), DriveType.Removable);
        using var inner = DriveAdmissions.Fake(fixture.Local("usb/repo/src"), type);
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            var repositories = new RepositoryService(loop, fixture.Local("wt"), fixture.Environment);
            var runner = new CommandRunner(loop, repositories, fixture.Environment);
            var refused = await Assert.ThrowsAsync<WorkspaceReadException>(() => runner.Prepare(fixture.Local("usb/repo"), new("[Console]::Out.WriteLine('x')", "src", [], 10_000)));
            Assert.Equal(RepositoryService.Unreadable, refused.Message);
            Assert.Equal(fixture.Local("usb/repo"), (await runner.Prepare(fixture.Local("usb/repo"), new("[Console]::Out.WriteLine('x')", "", [], 10_000))).Cwd);
            return 0;
        });
    }

    // Task worktree creation end to end: a project on a removable drive gets its worktree in the fixed app-owned base.

    [Fact]
    public async Task AProjectOnARemovableDriveGetsATaskWorktree()
    {
        using var fixture = await Repository("foundry-drive-task-", "usb/repo");
        using var drive = DriveAdmissions.Fake(fixture.Local("usb"), DriveType.Removable);
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            var service = new RepositoryService(loop, fixture.Local("wt"), fixture.Environment);
            var taskId = Guid.NewGuid().ToString();
            var created = await service.CreateTaskWorktree(fixture.Local("usb/repo"), taskId, null);
            Assert.Equal(fixture.Local("wt/" + taskId), created.WorktreePath);
            Assert.True(File.Exists(Path.Combine(created.WorktreePath, "src", "a.txt")));
            Assert.True(service.IsOwnWorktree(taskId, created.WorktreePath));
            return 0;
        });
    }

    // The app-owned folders and the data directory stay fixed-only.

    [Fact]
    public async Task TheWorktreeBaseOnARemovableDriveIsRefusedBeforeAnyMutation()
    {
        using var fixture = await Repository("foundry-drive-task-base-", "repo");
        using var drive = DriveAdmissions.Fake(fixture.Local("wt"), DriveType.Removable);
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            var service = new RepositoryService(loop, fixture.Local("wt"), fixture.Environment);
            var refused = await Assert.ThrowsAsync<RepositoryException>(() => service.CreateTaskWorktree(fixture.Local("repo"), Guid.NewGuid().ToString(), null));
            Assert.Equal("The app-owned worktree folder is unavailable.", refused.Message);
            Assert.Equal("none", refused.Outcome);
            return 0;
        });
    }

    [Fact]
    public async Task TheHooksFolderOnARemovableDriveRefusesEveryGitLaunch()
    {
        using var fixture = await Repository("foundry-drive-hooks-", "repo");
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            var service = new RepositoryService(loop, fixture.Local("wt"), fixture.Environment);
            Directory.CreateDirectory(service.Git.HooksPath);
            var launches = 0; service.Git.Launching = _ => launches++;
            Assert.NotEmpty(await service.HeadCommit(fixture.Local("repo")));
            var before = launches;
            using (DriveAdmissions.Fake(fixture.Local("wt"), DriveType.Removable))
            {
                var refused = await Assert.ThrowsAsync<GitCommandException>(() => service.HeadCommit(fixture.Local("repo")));
                Assert.Equal("Git command failed: " + service.Git.HooksNotEmptyMessage, refused.Message);
            }
            Assert.Equal(before, launches);
            return 0;
        });
    }

    [Fact]
    public async Task TheDataDirectoryStillRefusesARemovableDrive()
    {
        using var fixture = RepositoryFixture.Create("foundry-drive-data-");
        var data = Directory.CreateDirectory(fixture.Local("usb/data")).FullName;
        var root = fixture.Local("injected-root");
        await using var loop = new RuntimeLoop();
        await loop.Invoke(() =>
        {
            using (DriveAdmissions.Fake(fixture.Local("usb"), DriveType.Removable))
            {
                Assert.Throws<IOException>(() => DataClassifier.Inspect(data, root));
                Assert.Throws<IOException>(() => new Store(loop, data, root));
            }
            using (var store = new Store(loop, data, root))
            using (DriveAdmissions.Fake(fixture.Local("usb"), DriveType.Removable))
                Assert.Throws<IOException>(() => store.Backup());
            return Task.FromResult(0);
        });
    }
}
