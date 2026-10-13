using Foundry.Protocol;
using Foundry.Runtime;
using Microsoft.Data.Sqlite;
using Xunit;

namespace Foundry.Conformance;

public sealed class TaskAccountingTests
{
    private const string TaskId = "44444444-0000-4000-8000-999999999999";
    private static readonly DateTimeOffset Timestamp = new(2026, 1, 2, 3, 4, 5, 678, TimeSpan.Zero);
    private static string Root
    {
        get
        {
            for (var root = new DirectoryInfo(AppContext.BaseDirectory); root is not null; root = root.Parent)
                if (File.Exists(Path.Combine(root.FullName, "Foundry.slnx"))) return root.FullName;
            throw new InvalidOperationException("Missing task accounting corpus.");
        }
    }
    private static Dictionary<string, object?> Corpus() => (Dictionary<string, object?>)PersistedJson.Parse(File.ReadAllText(Path.Combine(Root, "tests/p2/task-accounting-vectors.json")))!;
    private static Dictionary<string, object?> Snapshot(Store store) => new()
    {
        ["task"] = store.ReadTask(TaskId),
        ["requests"] = store.SchemaVersion >= 4 ? store.Rows("SELECT rowid AS _rowid,* FROM provider_requests WHERE request_id LIKE '44444444-%' ORDER BY rowid") : [],
        ["legacy"] = store.Rows("SELECT rowid AS _rowid,* FROM usage_records WHERE request_id LIKE '44444444-%' ORDER BY rowid"),
        ["events"] = store.Rows("SELECT * FROM events WHERE task_id=$p0 ORDER BY sequence", TaskId)
    };

    [Theory]
    [InlineData("fresh"), InlineData("v1"), InlineData("v2"), InlineData("v3"), InlineData("v4"), InlineData("v5"), InlineData("v5-wal")]
    public async Task SingleTaskBudgetAndTerminalLedgerMatchCommittedNodeEra(string era)
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-task-accounting-").FullName;
        try
        {
            if (era != "fresh")
            {
                foreach (var file in Directory.GetFiles(Path.Combine(Root, "tests/fixtures/databases", era), "workspace.db*")) File.Copy(file, Path.Combine(scratch, Path.GetFileName(file)));
                File.WriteAllText(Path.Combine(scratch, Store.IsolationMarker), Store.IsolationDeclaration);
            }
            var corpus = Corpus(); var scenarios = (List<object?>)corpus["cases"]!;
            Assert.Equal(7, scenarios.Count);
            var scenario = scenarios.Cast<Dictionary<string, object?>>().Single(item => Equals(item["era"], era));
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                var current = Timestamp; var nextId = 1;
                Guid NewId() => Guid.Parse($"44444444-0000-4000-8000-{nextId++:000000000000}");
                var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), () => current, NewId);
                try
                {
                    var task = (Dictionary<string, object?>)corpus["task"]!; store.SaveTask(task); nextId = 1;
                    var handles = new Dictionary<string, TaskReservation>();
                    var steps = ((List<object?>)scenario["steps"]!).Cast<Dictionary<string, object?>>().ToArray();
                    Assert.Equal(15, steps.Length);
                    for (var index = 0; index < steps.Length; index++)
                    {
                        current = Timestamp.AddSeconds(index);
                        var operation = (Dictionary<string, object?>)steps[index]["operation"]!;
                        var key = operation.GetValueOrDefault("key") as string;
                        object? value = null; string? error = null;
                        try
                        {
                            switch ((string)operation["kind"]!)
                            {
                                case "admit":
                                    var request = new Dictionary<string, object?>((Dictionary<string, object?>)corpus["request"]!);
                                    var profile = new Dictionary<string, object?>((Dictionary<string, object?>)request["profile"]!);
                                    if (operation.TryGetValue("contextLimit", out var limit)) profile["contextLimit"] = limit;
                                    request["profile"] = profile;
                                    var handle = store.AdmitTaskRequest(task, request); handles[key!] = handle; value = handle; break;
                                case "attempt": store.AttemptUsage(handles[key!].RequestId); break;
                                case "settle": value = store.SettleTaskRequest(TaskId, handles[key!], operation.GetValueOrDefault("detail") as Dictionary<string, object?>, (string)operation["outcome"]!, operation.GetValueOrDefault("reason") as string, operation.GetValueOrDefault("metadata") as Dictionary<string, object?>); break;
                                case "patch": store.SaveTask(new(store.ReadTask(TaskId)) { ["usedTokens"] = operation["usedTokens"] }); break;
                                default: throw new InvalidOperationException("Missing task accounting operation coverage.");
                            }
                        }
                        catch (InvalidOperationException exception) when (exception.Message.StartsWith("Conservative context limit reached.", StringComparison.Ordinal) || exception.Message.StartsWith("Insufficient task budget", StringComparison.Ordinal)) { error = exception.Message; }
                        var actual = new Dictionary<string, object?> { ["value"] = value, ["error"] = error };
                        foreach (var field in Snapshot(store)) actual[field.Key] = field.Value;
                        Assert.Equal(JsJson.Stringify(steps[index]["expected"]), JsJson.Stringify(actual));
                    }
                    store.Dispose(); current = Timestamp.AddMinutes(1);
                    store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), () => current, NewId);
                    Assert.Equal(JsJson.Stringify(scenario["recovered"]), JsJson.Stringify(Snapshot(store)));
                    Assert.Equal(scenario["settledAfterRecovery"], store.SettleTaskRequest(TaskId, handles["pending"], null, "cancelled", "after restart"));
                    Assert.Equal(JsJson.Stringify(scenario["afterRecoverySettlement"]), JsJson.Stringify(Snapshot(store)));
                }
                finally { store.Dispose(); }
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task AdmissionAndSettlementFaultsRollbackBudgetLedgerAndEvents()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-task-accounting-fault-").FullName;
        try
        {
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), () => Timestamp, () => Guid.Parse("44444444-0000-4000-8000-000000000001"));
                var corpus = Corpus(); var task = (Dictionary<string, object?>)corpus["task"]!; var request = (Dictionary<string, object?>)corpus["request"]!;
                store.SaveTask(task); var original = JsJson.Stringify(Snapshot(store));
                store.Execute("CREATE TRIGGER fail_admission BEFORE INSERT ON provider_requests BEGIN SELECT RAISE(ABORT,'admission fault'); END");
                Assert.Throws<SqliteException>(() => store.AdmitTaskRequest(task, request));
                Assert.Equal(original, JsJson.Stringify(Snapshot(store)));
                store.Execute("DROP TRIGGER fail_admission");
                var handle = store.AdmitTaskRequest(task, request); var reserved = JsJson.Stringify(Snapshot(store));
                Assert.Throws<SqliteException>(() => store.AdmitTaskRequest(task, request));
                Assert.Equal(reserved, JsJson.Stringify(Snapshot(store)));
                store.Execute("CREATE TRIGGER fail_settlement BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT,'settlement fault'); END");
                Assert.Throws<SqliteException>(() => store.SettleTaskRequest(TaskId, handle, new Dictionary<string, object?> { ["inputTokens"] = 7, ["outputTokens"] = 5 }, "completed"));
                Assert.Equal(reserved, JsJson.Stringify(Snapshot(store)));
                store.Execute("DROP TRIGGER fail_settlement");
                Assert.Throws<IOException>(() => store.Immediate((Func<int>)(() => { Assert.True(store.SettleTaskRequest(TaskId, handle, null, "cancelled")); throw new IOException("outer rollback"); })));
                Assert.Equal(reserved, JsJson.Stringify(Snapshot(store)));
                Assert.True(store.SettleTaskRequest(TaskId, handle, new Dictionary<string, object?> { ["inputTokens"] = 7, ["outputTokens"] = 5 }, "completed"));
                Assert.False(store.SettleTaskRequest(TaskId, handle, null, "cancelled"));
                Assert.Equal(15d, store.ReadTask(TaskId)["usedTokens"]);
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task PublicationFailureCannotRerunAnAlreadyCommittedSettlement()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-task-accounting-publish-").FullName;
        try
        {
            await using var loop = new RuntimeLoop(); Store? owned = null;
            await loop.Invoke(() =>
            {
                var fail = false;
                owned = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), () => Timestamp, publish: _ => { if (fail) throw new IOException("delivery fault"); });
                var corpus = Corpus(); var task = (Dictionary<string, object?>)corpus["task"]!; var request = (Dictionary<string, object?>)corpus["request"]!;
                owned.SaveTask(task); var handle = owned.AdmitTaskRequest(task, request);
                fail = true;
                Assert.Throws<EventDeliveryException>(() => owned.Transaction(() => { Assert.True(owned.SettleTaskRequest(TaskId, handle, null, "cancelled")); owned.Event("fixture.changed", null, TaskId); return 0; }));
                Assert.False(owned.SettleTaskRequest(TaskId, handle, null, "completed"));
                return Task.FromResult(0);
            });
            Assert.Throws<InvalidOperationException>(() => owned!.AdmitTaskRequest(new(), new Dictionary<string, object?>()));
            Assert.Throws<InvalidOperationException>(() => owned!.SettleTaskRequest(TaskId, new TaskReservation(1, "id"), null, "failed"));
            Assert.Throws<InvalidOperationException>(() => owned!.SaveUsageRecord(new()));
            await loop.Invoke(() => { owned!.Dispose(); return Task.FromResult(0); });
        }
        finally { Directory.Delete(scratch, true); }
    }
}
