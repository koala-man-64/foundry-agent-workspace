using System.Diagnostics;
using Foundry.Platform;
using Foundry.Protocol;
using Foundry.Runtime;
using Microsoft.Data.Sqlite;
using Xunit;

namespace Foundry.Conformance;

public sealed class RepositoryFolderTests
{
    [Fact]
    public void ExistingDatabasePinAllowsSqliteWritesAndPreventsReplacementUntilReleased()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-sqlite-pin-").FullName;
        try
        {
            var data = Directory.CreateDirectory(Path.Combine(scratch, "data")).FullName;
            var file = Path.Combine(data, "workspace.db"); var moved = Path.Combine(data, "moved.db");
            using (var database = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = file, Pooling = false }.ToString()))
            {
                database.Open();
                using var command = database.CreateCommand(); command.CommandText = "CREATE TABLE fixture(value TEXT NOT NULL); INSERT INTO fixture VALUES('before');"; command.ExecuteNonQuery();
            }
            using (var lease = DirectoryLease.AcquireExisting(scratch))
            {
                lease.PinExistingDatabase(file);
                using (var database = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = file, Pooling = false }.ToString()))
                {
                    database.Open();
                    using var command = database.CreateCommand(); command.CommandText = "UPDATE fixture SET value='after';"; Assert.Equal(1, command.ExecuteNonQuery());
                    command.CommandText = "SELECT value FROM fixture;"; Assert.Equal("after", command.ExecuteScalar());
                }
                // SQLite is closed and the immediate parent is not pinned: refusal must come from the file pin.
                Assert.Throws<IOException>(() => File.Move(file, moved));
            }
            File.Move(file, moved);
            using var reopened = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = moved, Pooling = false }.ToString());
            reopened.Open(); using var read = reopened.CreateCommand(); read.CommandText = "SELECT value FROM fixture;"; Assert.Equal("after", read.ExecuteScalar());
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public void MissingTailRefusalReleasesPartialHandlesAndOptionalTailDoesNotCreateDirectories()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-missing-tail-").FullName;
        try
        {
            var parent = Directory.CreateDirectory(Path.Combine(scratch, "parent")).FullName;
            var moved = Path.Combine(scratch, "moved"); var missing = Path.Combine(parent, "missing", "child");
            Assert.Throws<IOException>(() => DirectoryLease.AcquireExisting(missing));
            Directory.Move(parent, moved); Directory.Move(moved, parent);
            using (var lease = DirectoryLease.Acquire(missing))
            {
                Assert.False(Directory.Exists(Path.Combine(parent, "missing")));
                Assert.Throws<IOException>(() => Directory.Move(parent, moved));
            }
            Directory.Move(parent, moved);
            Assert.False(Directory.Exists(Path.Combine(moved, "missing")));
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public void ExistingDatabasePinPreventsReplacementButAllowsWrites()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-file-pin-").FullName;
        try
        {
            var selected = Directory.CreateDirectory(Path.Combine(scratch, "data")).FullName;
            var file = Path.Combine(selected, "workspace.db"); var replacement = Path.Combine(selected, "replacement.db");
            File.WriteAllText(file, "fixture");
            using (var lease = DirectoryLease.AcquireExisting(scratch))
            {
                lease.PinExistingDatabase(file);
                Assert.Throws<IOException>(() => File.Move(file, replacement));
                File.WriteAllText(file, "updated fixture");
                Assert.Equal("updated fixture", File.ReadAllText(file));
            }
            File.Move(file, replacement); Assert.True(File.Exists(replacement));
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task ExistingLocalFolderStaysPinnedUntilReleased()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-folder-").FullName;
        try
        {
            var root = Directory.CreateDirectory(Path.Combine(scratch, "space 😀")).FullName;
            var moved = Path.Combine(scratch, "moved");
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                using (var folder = RepositoryFolderLease.Open(loop, root))
                {
                    Assert.Equal(FinalPath.Canonical(root), folder.Path);
                    Assert.Throws<IOException>(() => Directory.Move(root, moved));
                }
                Directory.Move(root, moved);
                Assert.Throws<IOException>(() => RepositoryFolderLease.Open(loop, Path.Combine(moved, "missing")));
                return Task.FromResult(0);
            });
            Assert.Throws<InvalidOperationException>(() => RepositoryFolderLease.Open(loop, @"\\server\never-probe"));
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Theory]
    [InlineData(@"\\server\share\folder"), InlineData("//server/share/folder"), InlineData(@"\\?\C:\folder"), InlineData(@"\??\C:\folder")]
    public async Task RawNetworkAndDevicePathsAreRefused(string path)
    {
        await using var loop = new RuntimeLoop();
        await loop.Invoke(() =>
        {
            var error = Assert.Throws<WorkspaceReadException>(() => RepositoryFolderLease.Open(loop, path));
            Assert.Equal("Projects on network shares are not supported.", error.Message);
            return Task.FromResult(0);
        });
    }

    [Fact]
    public async Task ReparseAncestorIsRefusedBeforeMissingDescendantAndSavedProjectIsUnavailable()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-folder-alias-").FullName;
        var alias = Path.Combine(scratch, "alias");
        try
        {
            var target = Directory.CreateDirectory(Path.Combine(scratch, "target")).FullName;
            var info = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe")) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            info.Arguments = "/d /c mklink /J \"" + alias + "\" \"" + target + "\"";
            using (var process = Process.Start(info)!)
            {
                var output = process.StandardOutput.ReadToEndAsync(TestContext.Current.CancellationToken); var error = process.StandardError.ReadToEndAsync(TestContext.Current.CancellationToken);
                await process.WaitForExitAsync(TestContext.Current.CancellationToken);
                Assert.True(process.ExitCode == 0, await output + await error);
            }
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                Assert.Throws<IOException>(() => DirectoryLease.Acquire(Path.Combine(alias, "missing", "child")));
                var error = Assert.Throws<WorkspaceReadException>(() => RepositoryFolderLease.Open(loop, Path.Combine(alias, "missing")));
                Assert.Equal("Projects through reparse directories are not supported.", error.Message);
                var state = Directory.CreateDirectory(Path.Combine(scratch, "state")).FullName;
                using var store = new Store(loop, state, Path.Combine(scratch, "injected-root"));
                var projectId = "18181818-0000-4000-8000-000000000001";
                var project = new Dictionary<string, object?> { ["id"] = projectId, ["path"] = alias, ["name"] = "saved", ["kind"] = "folder", ["hidden"] = false, ["opaque"] = "retained" };
                store.Execute("INSERT INTO projects(id,path_key,data) VALUES($p0,'stable-never-resolve',$p1)", projectId, JsJson.Stringify(project));
                var before = JsJson.Stringify(store.Rows("SELECT rowid,* FROM projects"));
                var summary = store.Summary(); var item = (Dictionary<string, object?>)((List<object?>)summary["projects"]!)[0]!;
                Assert.Equal("unavailable", item["kind"]); Assert.Equal("Folder is unavailable.", item["unavailableReason"]);
                Assert.Equal("retained", item["opaque"]); Assert.Equal(before, JsJson.Stringify(store.Rows("SELECT rowid,* FROM projects")));
                return Task.FromResult(0);
            });
        }
        finally
        {
            if (Directory.Exists(alias)) Directory.Delete(alias);
            Directory.Delete(scratch, true);
        }
    }
}
