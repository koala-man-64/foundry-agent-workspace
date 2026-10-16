using System.Diagnostics;
using System.Security.Cryptography;
using Foundry.Platform;
using Foundry.Runtime;
using Microsoft.Data.Sqlite;
using Xunit;

namespace Foundry.Conformance;

public sealed class AdmissionTests
{
    [Fact]
    public async Task LinkedFreshMarkerCannotOverwriteItsTargetOrCreateDatabase()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p1-marker-").FullName;
        try
        {
            var selected = Directory.CreateDirectory(Path.Combine(scratch, "isolated")).FullName;
            var sentinel = Path.Combine(scratch, "sentinel.txt");
            File.WriteAllText(sentinel, "SENTINEL");
            await Link("/H", Path.Combine(selected, Store.IsolationMarker), sentinel);
            await using var loop = new RuntimeLoop();
            await Assert.ThrowsAsync<IOException>(() => loop.Invoke(() => { using var store = new Store(loop, selected, Path.Combine(scratch, "injected-root")); return Task.FromResult(0); }));
            Assert.Equal("SENTINEL", File.ReadAllText(sentinel));
            Assert.False(File.Exists(Path.Combine(selected, "workspace.db")));
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task NestedFreshPathIsCreatedAndLeasePreventsReplacement()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p1-admit-").FullName;
        var selected = Path.Combine(scratch, "missing", "nested");
        try
        {
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                using var store = new Store(loop, selected, Path.Combine(scratch, "injected-root"));
                Assert.Equal(5, store.SchemaVersion);
                Assert.Throws<IOException>(() => Directory.Move(selected, selected + "-moved"));
                Assert.Throws<IOException>(() => File.Move(Path.Combine(selected, "workspace.db"), Path.Combine(selected, "replacement.db")));
                return Task.FromResult(0);
            });
            Directory.Move(selected, selected + "-moved");
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Theory]
    [InlineData("unmarked"), InlineData("newer"), InlineData("fenced"), InlineData("root")]
    public async Task RefusedDataIsUnchanged(string kind)
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p1-refuse-").FullName;
        var database = Path.Combine(scratch, "workspace.db");
        try
        {
            using (var connection = SqliteSetup.Open(database, SqliteOpenMode.ReadWriteCreate))
            {
                using var command = connection.CreateCommand();
                command.CommandText = "CREATE TABLE retained(value); INSERT INTO retained VALUES('fixture'); PRAGMA user_version=" + (kind == "newer" ? "6" : "5") + ";";
                if (kind == "fenced") command.CommandText += "CREATE TABLE runtime_meta(value);";
                command.ExecuteNonQuery();
            }
            if (kind != "unmarked") File.WriteAllText(Path.Combine(scratch, Store.IsolationMarker), Store.IsolationDeclaration);
            var before = SHA256.HashData(File.ReadAllBytes(database));
            await using var loop = new RuntimeLoop();
            await Assert.ThrowsAsync<InvalidOperationException>(() => loop.Invoke(() =>
            {
                using var store = new Store(loop, scratch, kind == "root" ? scratch : Path.Combine(scratch, "injected-root"));
                return Task.FromResult(0);
            }));
            Assert.Equal(before, SHA256.HashData(File.ReadAllBytes(database)));
            Assert.False(File.Exists(database + "-wal"));
            Assert.False(File.Exists(database + "-shm"));
        }
        finally { Directory.Delete(scratch, true); }
    }

    private static async Task Link(string kind, string link, string target)
    {
        var info = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe")) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        info.Arguments = "/d /c mklink " + kind + " \"" + link + "\" \"" + target + "\"";
        using var process = Process.Start(info)!;
        var output = process.StandardOutput.ReadToEndAsync(TestContext.Current.CancellationToken);
        var error = process.StandardError.ReadToEndAsync(TestContext.Current.CancellationToken);
        await process.WaitForExitAsync(TestContext.Current.CancellationToken);
        Assert.True(process.ExitCode == 0, await output + await error);
    }

    [Fact]
    public async Task JunctionAliasesClassifyPendingAndHardlinkedDatabaseIsRefused()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p1-alias-").FullName;
        try
        {
            var root = Directory.CreateDirectory(Path.Combine(scratch, "injected-root")).FullName;
            var alias = Path.Combine(scratch, "alias");
            await Link("/J", alias, root);
            Assert.Equal(DataDisposition.AdoptionPending, DataClassifier.Inspect(alias, root).Disposition);
            Assert.Throws<ReparsePointException>(() => DirectoryLease.Acquire(alias));
            var selected = Directory.CreateDirectory(Path.Combine(scratch, "isolated")).FullName;
            var source = Path.Combine(scratch, "source.db");
            using (var connection = SqliteSetup.Open(source, SqliteOpenMode.ReadWriteCreate))
            {
                using var command = connection.CreateCommand(); command.CommandText = "PRAGMA user_version=5"; command.ExecuteNonQuery();
            }
            await Link("/H", Path.Combine(selected, "workspace.db"), source);
            File.WriteAllText(Path.Combine(selected, Store.IsolationMarker), Store.IsolationDeclaration);
            var before = SHA256.HashData(File.ReadAllBytes(source));
            var inspected = false;
            Assert.Throws<IOException>(() => DataClassifier.Inspect(selected, root, _ => { inspected = true; return (5, false); }));
            Assert.False(inspected); // Neither SQLite nor the injected opener is reached.
            await using var loop = new RuntimeLoop();
            await Assert.ThrowsAsync<IOException>(() => loop.Invoke(() => { using var store = new Store(loop, selected, root); return Task.FromResult(0); }));
            Assert.Equal(before, SHA256.HashData(File.ReadAllBytes(source)));
            Directory.Delete(alias); // Remove only the junction, preserving its target.
        }
        finally { Directory.Delete(scratch, true); }
    }
}
