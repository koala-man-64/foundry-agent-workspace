using Foundry.Protocol;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

public sealed class TaskStoreTests
{
    private const string TaskId = "11111111-0000-4000-8000-000000000001";
    private const string MessageId = "11111111-0000-4000-8000-000000000003";
    private static readonly DateTimeOffset Timestamp = new(2026, 1, 2, 3, 4, 5, 678, TimeSpan.Zero);
    private static string Root
    {
        get
        {
            for (var root = new DirectoryInfo(AppContext.BaseDirectory); root is not null; root = root.Parent)
                if (File.Exists(Path.Combine(root.FullName, "Foundry.slnx"))) return root.FullName;
            throw new InvalidOperationException("Missing task corpus.");
        }
    }
    private static Dictionary<string, object?> NewTask(string status = "idle") => new()
    {
        ["id"] = TaskId, ["title"] = "Fixture", ["workspaceKind"] = "none", ["profileId"] = Store.FakeProfileId,
        ["status"] = status, ["createdAt"] = Clock.Iso(Timestamp), ["updatedAt"] = Clock.Iso(Timestamp),
        ["tokenBudget"] = 4096, ["usedTokens"] = 0, ["mode"] = "chat"
    };
    private static Dictionary<string, object?> NewMessage(string content = "fixture", string status = "complete") => new()
    {
        ["id"] = MessageId, ["taskId"] = TaskId, ["role"] = "user", ["content"] = content,
        ["createdAt"] = Clock.Iso(Timestamp), ["status"] = status
    };
    private static Dictionary<string, object?> Snapshot(Store store, object? value) => new()
    {
        ["value"] = value,
        ["tasks"] = store.Rows("SELECT rowid AS _rowid,* FROM tasks WHERE id LIKE '11111111-%' ORDER BY rowid"),
        ["messages"] = store.Rows("SELECT rowid AS _rowid,* FROM messages WHERE id LIKE '11111111-%' ORDER BY rowid"),
        ["events"] = store.Rows("SELECT * FROM events WHERE task_id LIKE '11111111-%' ORDER BY sequence"),
        ["fts"] = store.SchemaVersion >= 5 ? store.Rows("SELECT rowid AS _rowid,* FROM messages_fts WHERE message_id LIKE '11111111-%' ORDER BY rowid") : [],
        ["generations"] = store.SchemaVersion >= 5 ? store.Rows("SELECT * FROM workspace_read_meta") : []
    };

    [Theory]
    [InlineData("fresh"), InlineData("v1"), InlineData("v2"), InlineData("v3"), InlineData("v4"), InlineData("v5"), InlineData("v5-wal")]
    public async Task TaskMessageProjectionsAndEventsMatchEachCommittedNodeEra(string era)
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-task-era-").FullName;
        try
        {
            if (era != "fresh")
            {
                foreach (var file in Directory.GetFiles(Path.Combine(Root, "tests/fixtures/databases", era), "workspace.db*")) File.Copy(file, Path.Combine(scratch, Path.GetFileName(file)));
                File.WriteAllText(Path.Combine(scratch, Store.IsolationMarker), Store.IsolationDeclaration);
            }
            var corpus = (List<object?>)PersistedJson.Parse(File.ReadAllText(Path.Combine(Root, "tests/p2/task-store-vectors.json")))!;
            Assert.Equal(7, corpus.Count);
            var scenario = corpus.Cast<Dictionary<string, object?>>().Single(item => Equals(item["era"], era));
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), now: () => Timestamp);
                var initialVersion = store.SchemaVersion;
                var steps = ((List<object?>)scenario["steps"]!).Cast<Dictionary<string, object?>>().ToArray();
                Assert.Equal(22, steps.Length);
                foreach (var step in steps)
                {
                    var operation = (Dictionary<string, object?>)step["operation"]!;
                    var input = (Dictionary<string, object?>)operation["value"]!;
                    object? value;
                    if (Equals(operation["kind"], "message")) { store.SaveMessage(input); value = null; }
                    else
                    {
                        var task = Equals(operation["kind"], "patch") ? store.ReadTask(TaskId) : new Dictionary<string, object?>();
                        foreach (var pair in input) task[pair.Key] = pair.Value;
                        if (Equals(operation.GetValueOrDefault("omitArchive"), true)) task.Remove("archivedAt");
                        value = store.SaveTask(task, operation.GetValueOrDefault("transition") as Dictionary<string, object?>);
                    }
                    Assert.Equal(JsJson.Stringify(step["expected"]), JsJson.Stringify(Snapshot(store, value)));
                }
                Assert.Equal(initialVersion, store.SchemaVersion);
                Assert.Equal(initialVersion, (long)store.Scalar("PRAGMA user_version")!);
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task OuterAndNestedRollbackDiscardTaskMessageIndexesAndNotifications()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-task-rollback-").FullName;
        try
        {
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                var delivered = new List<WorkspaceEvent>();
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), now: () => Timestamp, publish: delivered.Add);
                Assert.Throws<IOException>(() => store.Transaction((Func<int>)(() =>
                {
                    store.SaveTask(NewTask()); store.SaveMessage(NewMessage()); Assert.Empty(delivered);
                    throw new IOException("outer fault");
                })));
                Assert.Empty(delivered); Assert.Empty(store.Rows("SELECT * FROM tasks")); Assert.Empty(store.Rows("SELECT * FROM messages_fts"));
                store.Transaction(() =>
                {
                    store.SaveTask(NewTask());
                    Assert.Throws<IOException>(() => store.Immediate((Func<int>)(() =>
                    {
                        store.SaveTask(NewTask("running")); store.SaveMessage(NewMessage()); throw new IOException("savepoint fault");
                    })));
                    Assert.Equal("idle", store.ReadTask(TaskId)["status"]); Assert.Empty(delivered);
                    return 0;
                });
                Assert.Equal("task.created", Assert.Single(delivered).Type);
                Assert.Empty(store.Rows("SELECT * FROM messages")); Assert.Empty(store.Rows("SELECT * FROM messages_fts"));
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task FailedSearchProjectionUpdateRestoresExactPriorMessageAndIndex()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-message-fault-").FullName;
        try
        {
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                var delivered = new List<WorkspaceEvent>();
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), now: () => Timestamp, publish: delivered.Add);
                store.SaveTask(NewTask()); store.SaveMessage(NewMessage("retained", "streaming")); delivered.Clear();
                var before = JsJson.Stringify(Snapshot(store, null));
                store.Execute("CREATE TRIGGER fixture_fault BEFORE UPDATE ON workspace_read_meta BEGIN SELECT RAISE(ABORT,'projection fault'); END");
                Assert.Throws<Microsoft.Data.Sqlite.SqliteException>(() => store.SaveMessage(NewMessage("replacement", "complete")));
                Assert.Equal(before, JsJson.Stringify(Snapshot(store, null))); Assert.Empty(delivered);
                store.Execute("DROP TRIGGER fixture_fault"); store.SaveMessage(NewMessage("api_key=fixture-secret-value"));
                Assert.Equal("message.completed", Assert.Single(delivered).Type);
                Assert.Equal("api_key=[REDACTED]", store.Scalar("SELECT content FROM messages_fts WHERE message_id=$p0", MessageId));
                Assert.Contains("fixture-secret-value", (string)store.Scalar("SELECT data FROM messages WHERE id=$p0", MessageId)!);
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task DeliveryFailureKeepsCommittedTaskAndAffinityGuardsEveryOperation()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-task-delivery-").FullName;
        try
        {
            await using var loop = new RuntimeLoop(); Store? owned = null;
            await loop.Invoke(() =>
            {
                owned = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), publish: _ => throw new IOException("delivery fault"));
                Assert.Throws<EventDeliveryException>(() => owned.SaveTask(NewTask()));
                Assert.Equal("idle", owned.ReadTask(TaskId)["status"]);
                Assert.Equal(1L, owned.Scalar("SELECT COUNT(*) FROM tasks")); Assert.Equal(1L, owned.Scalar("SELECT COUNT(*) FROM events"));
                Assert.Throws<InvalidOperationException>(() => owned.ReadGitTask(TaskId));
                Assert.Equal("Task not found.", Assert.Throws<InvalidOperationException>(() => owned.ReadTask("missing")).Message);
                return Task.FromResult(0);
            });
            Assert.Throws<InvalidOperationException>(() => owned!.ReadTask(TaskId));
            Assert.Throws<InvalidOperationException>(() => owned!.SaveTask(NewTask()));
            Assert.Throws<InvalidOperationException>(() => owned!.SaveMessage(NewMessage()));
            await loop.Invoke(() => { owned!.Dispose(); return Task.FromResult(0); });
        }
        finally { Directory.Delete(scratch, true); }
    }
}
