using Foundry.Platform;
using Foundry.Protocol;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

public sealed class WorkspaceStoreTests
{
    private static string Root
    {
        get
        {
            for (var root = new DirectoryInfo(AppContext.BaseDirectory); root is not null; root = root.Parent)
                if (File.Exists(Path.Combine(root.FullName, "Foundry.slnx"))) return root.FullName;
            throw new InvalidOperationException("Missing workspace corpus.");
        }
    }
    [Fact]
    public async Task WorkspacePrimitivesMatchNodeResultsStoredJsonAndRowIdentity()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-workspace-").FullName;
        try
        {
            var directory = Directory.CreateDirectory(Path.Combine(scratch, "Project")).FullName;
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                using var store = new Store(loop, Path.Combine(scratch, "data"), Path.Combine(scratch, "injected-root"),
                    now: () => new DateTimeOffset(2026, 1, 2, 3, 4, 5, 678, TimeSpan.Zero), id: () => Guid.Parse("00000000-0000-4000-8000-000000000002"));
                var steps = new List<object?>();
                void Record(string name, object? value) => steps.Add(new Dictionary<string, object?>
                {
                    ["name"] = name, ["value"] = value,
                    ["profiles"] = store.Rows("SELECT rowid AS _rowid,id,data FROM profiles ORDER BY rowid"),
                    ["projects"] = store.Rows("SELECT rowid AS _rowid,id,path_key,data FROM projects ORDER BY rowid"),
                    ["preferences"] = store.Rows("SELECT rowid AS _rowid,id,data FROM workspace_preferences ORDER BY rowid"),
                    ["starts"] = store.Rows("SELECT rowid AS _rowid,* FROM task_starts ORDER BY rowid")
                });
                Record("defaults", store.Preferences());
                Record("missing-profile", store.Profile("missing"));
                var profile = store.Profile(Store.FakeProfileId)!;
                profile["opaque"] = new Dictionary<string, object?> { ["future"] = new List<object?> { 1, null, "keep" } };
                store.SaveProfile(profile); Record("save-profile", store.Profile(Store.FakeProfileId));
                Record("missing-project", store.Project("missing"));
                var project = store.InsertProject(directory); Record("insert-project", project);
                Record("path-alias", store.ProjectByPath(directory.ToUpperInvariant()));
                var updated = new Dictionary<string, object?>(project) { ["name"] = "Renamed", ["hidden"] = true, ["future"] = new Dictionary<string, object?> { ["keep"] = true } };
                Record("save-project", store.SaveProject(updated));
                Record("list-projects", store.Projects());
                var preferences = store.Preferences(); preferences["mode"] = "coding";
                preferences["collapsedProjectIds"] = new List<object?> { project["id"] }; preferences["future"] = new List<object?> { true, null };
                Record("save-preferences", store.SavePreferences(preferences));
                store.ReserveTaskStart("request-1", "hash-1", "task-1"); Record("reserve", store.TaskStart("request-1"));
                store.FinishTaskStart("request-1", "failed"); Record("failed", store.TaskStart("request-1"));
                store.ClearTaskStart("request-1"); Record("retain-failed", store.TaskStart("request-1"));
                store.FinishTaskStart("request-1", "pending"); store.ClearTaskStart("request-1"); Record("clear-pending", store.TaskStart("request-1"));
                store.ReserveTaskStart("request-2", "hash-2", "task-2"); store.FinishTaskStart("request-2", "complete"); Record("complete", store.TaskStart("request-2"));
                store.ReserveTaskStart("request-3", "hash-3", "task-3"); store.FinishTaskStart("request-3", "unknown"); store.ClearTaskStart("request-3"); Record("retain-unknown", store.TaskStart("request-3"));
                Record("events", store.Rows("SELECT COUNT(*) AS count FROM events").Single());
                var key = FinalPath.Key(directory);
                object? Normalize(object? value) => value switch
                {
                    string text => text.Replace(directory, "$project", StringComparison.Ordinal).Replace(JsJson.Stringify(directory)![1..^1], "$project", StringComparison.Ordinal)
                        .Replace(key, "$project-key", StringComparison.Ordinal).Replace(JsJson.Stringify(key)![1..^1], "$project-key", StringComparison.Ordinal),
                    Dictionary<string, object?> document => document.ToDictionary(pair => pair.Key, pair => Normalize(pair.Value), StringComparer.Ordinal),
                    IEnumerable<object?> list => list.Select(Normalize).ToList(),
                    _ => value
                };
                var expected = PersistedJson.Parse(File.ReadAllText(Path.Combine(Root, "tests/p2/workspace-store-vectors.json")));
                Assert.Equal(JsJson.Stringify(expected), JsJson.Stringify(Normalize(steps)));
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task WorkspaceWritesRollBackWithoutChangingPathKeysOrRowIds()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-workspace-rollback-").FullName;
        try
        {
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                using var store = new Store(loop, Path.Combine(scratch, "data"), Path.Combine(scratch, "injected-root"));
                var project = store.InsertProject(Directory.CreateDirectory(Path.Combine(scratch, "project")).FullName);
                var before = JsJson.Stringify(store.Rows("SELECT rowid,id,path_key,data FROM projects"));
                Assert.Throws<IOException>(() => store.Transaction((Func<int>)(() =>
                {
                    store.SaveProject(new(project) { ["path"] = "changed", ["name"] = "changed" });
                    store.SavePreferences(new() { ["future"] = true });
                    store.ReserveTaskStart("request", "hash", "task");
                    throw new IOException("controlled fault");
                })));
                Assert.Equal(before, JsJson.Stringify(store.Rows("SELECT rowid,id,path_key,data FROM projects")));
                Assert.Empty(store.Rows("SELECT * FROM workspace_preferences")); Assert.Null(store.TaskStart("request"));
                var identity = store.Rows("SELECT rowid,path_key FROM projects");
                store.SaveProject(new(project) { ["path"] = "different retained spelling", ["future"] = "keep" });
                Assert.Equal(JsJson.Stringify(identity), JsJson.Stringify(store.Rows("SELECT rowid,path_key FROM projects")));
                Assert.Equal("keep", store.Project((string)project["id"]!)!["future"]);
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task PendingTaskStartsRecoverAsUnknownAndCannotBeCleared()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-workspace-recovery-").FullName;
        try
        {
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                using (var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"))) store.ReserveTaskStart("request", "hash", "task");
                using var reopened = new Store(loop, scratch, Path.Combine(scratch, "injected-root"));
                Assert.Equal("unknown", reopened.TaskStart("request")!["state"]);
                reopened.ClearTaskStart("request"); Assert.Equal("hash", reopened.TaskStart("request")!["inputHash"]);
                Assert.Throws<Microsoft.Data.Sqlite.SqliteException>(() => reopened.ReserveTaskStart("request", "another hash", "another task"));
                Assert.Equal("task", reopened.TaskStart("request")!["taskId"]);
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task OldEraAdmissionAndLoopAffinityRemainEnforced()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-workspace-era-").FullName;
        try
        {
            await using var loop = new RuntimeLoop();
            Store? owned = null;
            await loop.Invoke(() =>
            {
                using (var fresh = new Store(loop, scratch, Path.Combine(scratch, "injected-root"))) fresh.Execute("PRAGMA user_version=1");
                owned = new Store(loop, scratch, Path.Combine(scratch, "injected-root"));
                Assert.Equal(1, owned.SchemaVersion); Assert.Empty(owned.Projects()); Assert.Equal("chat", owned.Preferences()["mode"]);
                Assert.Throws<InvalidOperationException>(() => owned.Project("missing"));
                Assert.Throws<InvalidOperationException>(() => owned.SavePreferences(new()));
                Assert.Throws<InvalidOperationException>(() => owned.TaskStart("request"));
                owned.WorkspacePathKeyProbe = _ => throw new IOException("A path probe must not run outside the owning loop.");
                return Task.FromResult(0);
            });
            Assert.Throws<InvalidOperationException>(() => owned!.ProjectByPath("\\\\must-not-be-probed\\share"));
            Assert.Throws<InvalidOperationException>(() => owned!.SaveProfile(new()));
            await loop.Invoke(() => { owned!.Dispose(); return Task.FromResult(0); });
        }
        finally { Directory.Delete(scratch, true); }
    }
}
