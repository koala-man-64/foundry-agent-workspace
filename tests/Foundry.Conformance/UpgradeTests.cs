using Foundry.Platform;
using Foundry.Runtime;
using Microsoft.Data.Sqlite;
using Xunit;

namespace Foundry.Conformance;

public sealed class UpgradeTests
{
    [Fact]
    public void BackupVerificationDistinguishesLargeIntegersAndSchemaObjects()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p1-verify-").FullName;
        try
        {
            using var first = SqliteSetup.Open(Path.Combine(scratch, "a.db"), SqliteOpenMode.ReadWriteCreate);
            using var second = SqliteSetup.Open(Path.Combine(scratch, "b.db"), SqliteOpenMode.ReadWriteCreate);
            using var a = first.CreateCommand(); using var b = second.CreateCommand();
            a.CommandText = b.CommandText = "CREATE TABLE retained(value); INSERT INTO retained(rowid,value) VALUES(9007199254740992,9007199254740992),(1,'text'),(2,X'00FF');";
            a.ExecuteNonQuery(); b.ExecuteNonQuery();
            Assert.Equal(Store.DatabaseContract(first), Store.DatabaseContract(second));
            b.CommandText = "UPDATE retained SET value=9007199254740993 WHERE rowid=9007199254740992"; b.ExecuteNonQuery();
            Assert.NotEqual(Store.DatabaseContract(first), Store.DatabaseContract(second));
            b.CommandText = "UPDATE retained SET value=9007199254740992,rowid=9007199254740993 WHERE rowid=9007199254740992"; b.ExecuteNonQuery();
            Assert.NotEqual(Store.DatabaseContract(first), Store.DatabaseContract(second));
            b.CommandText = "UPDATE retained SET rowid=9007199254740992 WHERE rowid=9007199254740993; CREATE INDEX retained_index ON retained(value);"; b.ExecuteNonQuery();
            Assert.NotEqual(Store.DatabaseContract(first), Store.DatabaseContract(second));
            b.CommandText = "DROP INDEX retained_index; CREATE TRIGGER retained_trigger AFTER INSERT ON retained BEGIN SELECT 1; END;"; b.ExecuteNonQuery();
            Assert.NotEqual(Store.DatabaseContract(first), Store.DatabaseContract(second));
        }
        finally { Directory.Delete(scratch, true); }
    }

    private static string Fixture(string era)
    {
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "Foundry.slnx"))) root = root.Parent;
        return Path.Combine(root!.FullName, "tests/fixtures/databases", era);
    }
    [Theory]
    [InlineData("v1"), InlineData("v2"), InlineData("v3"), InlineData("v4"), InlineData("v5-wal")]
    public async Task VerifiedWalAwareBackupAndExplicitUpgrade(string era)
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p1-upgrade-").FullName;
        try
        {
            foreach (var file in Directory.GetFiles(Fixture(era), "workspace.db*")) File.Copy(file, Path.Combine(scratch, Path.GetFileName(file)));
            File.WriteAllText(Path.Combine(scratch, Store.IsolationMarker), Store.IsolationDeclaration);
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"));
                var version = store.SchemaVersion;
                var backup = version < 5 ? store.UpgradeToCurrent() : store.Backup();
                Assert.Equal(version, backup.Version);
                ProtectedDirectory.Verify(Path.GetDirectoryName(backup.Path)!);
                using var copy = SqliteSetup.Open(backup.Path, SqliteOpenMode.ReadOnly);
                using var command = copy.CreateCommand(); command.CommandText = "PRAGMA user_version";
                Assert.Equal((long)version, command.ExecuteScalar());
                command.CommandText = "SELECT COUNT(*) FROM tasks";
                Assert.Equal(store.Scalar("SELECT COUNT(*) FROM tasks"), command.ExecuteScalar());
                Assert.Equal(5, store.SchemaVersion);
                Assert.Empty(store.Rows("PRAGMA foreign_key_check"));
                Assert.NotNull(store.Scalar("SELECT 1 FROM sqlite_master WHERE name='messages_fts'"));
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Theory]
    [InlineData(StoreFault.BackupProtection), InlineData(StoreFault.BackupCopy), InlineData(StoreFault.BackupVerification), InlineData(StoreFault.UpgradeAfterDdl)]
    public async Task FailedUpgradeLeavesVersionAndDataIntact(StoreFault fault)
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p1-upgrade-fault-").FullName;
        try
        {
            File.Copy(Path.Combine(Fixture("v1"), "workspace.db"), Path.Combine(scratch, "workspace.db"));
            File.WriteAllText(Path.Combine(scratch, Store.IsolationMarker), Store.IsolationDeclaration);
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"));
                var tasks = store.Rows("SELECT rowid,id,data FROM tasks ORDER BY rowid");
                Assert.Throws<IOException>(() => store.UpgradeToCurrent(fault));
                Assert.Equal(1, store.SchemaVersion);
                Assert.Equal(1L, store.Scalar("PRAGMA user_version"));
                Assert.Null(store.Scalar("SELECT 1 FROM sqlite_master WHERE name='projects'"));
                Assert.Equal(Foundry.Protocol.JsJson.Stringify(tasks), Foundry.Protocol.JsJson.Stringify(store.Rows("SELECT rowid,id,data FROM tasks ORDER BY rowid")));
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }
}
