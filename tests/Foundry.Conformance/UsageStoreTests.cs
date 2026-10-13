using Foundry.Protocol;
using Foundry.Runtime;
using Microsoft.Data.Sqlite;
using Xunit;

namespace Foundry.Conformance;

public sealed class UsageStoreTests
{
    private static readonly DateTimeOffset Timestamp = new(2026, 1, 2, 3, 4, 5, 678, TimeSpan.Zero);
    private static string Root
    {
        get
        {
            for (var root = new DirectoryInfo(AppContext.BaseDirectory); root is not null; root = root.Parent)
                if (File.Exists(Path.Combine(root.FullName, "Foundry.slnx"))) return root.FullName;
            throw new InvalidOperationException("Missing usage corpus.");
        }
    }
    private static Dictionary<string, object?> Profile(string? effort = null) => new()
    {
        ["id"] = "fixture", ["name"] = "Fixture 😀", ["apiKind"] = "fake", ["deployment"] = "fixture",
        ["endpoint"] = "", ["contextLimit"] = 32000, ["outputLimit"] = 2048, ["effort"] = (object?)effort ?? Undefined.Value
    };
    private static Dictionary<string, object?> NewTask() => new()
    {
        ["id"] = "22222222-root", ["title"] = "Root 😀", ["profileId"] = "fixture", ["status"] = "idle",
        ["createdAt"] = Clock.Iso(Timestamp), ["updatedAt"] = Clock.Iso(Timestamp), ["tokenBudget"] = 4096, ["usedTokens"] = 0
    };
    private static List<Dictionary<string, object?>> Rows(Store store) => store.SchemaVersion >= 4
        ? store.Rows("SELECT rowid AS _rowid,* FROM provider_requests WHERE request_id LIKE '22222222-%' ORDER BY rowid") : [];
    private static void CopyEra(string era, string scratch)
    {
        if (era == "fresh") return;
        foreach (var file in Directory.GetFiles(Path.Combine(Root, "tests/fixtures/databases", era), "workspace.db*")) File.Copy(file, Path.Combine(scratch, Path.GetFileName(file)));
        File.WriteAllText(Path.Combine(scratch, Store.IsolationMarker), Store.IsolationDeclaration);
    }

    [Theory]
    [InlineData("fresh"), InlineData("v1"), InlineData("v2"), InlineData("v3"), InlineData("v4"), InlineData("v5"), InlineData("v5-wal")]
    public async Task AdmissionAttemptSettlementAndRestartMatchCommittedNodeEra(string era)
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-usage-era-").FullName;
        try
        {
            CopyEra(era, scratch);
            var corpus = (List<object?>)PersistedJson.Parse(File.ReadAllText(Path.Combine(Root, "tests/p2/usage-store-vectors.json")))!;
            Assert.Equal(7, corpus.Count);
            var scenario = corpus.Cast<Dictionary<string, object?>>().Single(item => Equals(item["era"], era));
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                var current = Timestamp;
                using (var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), () => current))
                {
                    var root = NewTask(); store.SaveTask(root);
                    var child = new Dictionary<string, object?>(root) { ["id"] = "22222222-child", ["title"] = "Child", ["rootTaskId"] = root["id"], ["parentTaskId"] = root["id"], ["role"] = "child" };
                    store.SaveTask(child);
                    store.Execute("INSERT INTO usage_records(id,task_id,request_id,reserved,usage_known,reason,created_at) VALUES($p0,$p1,$p2,12,0,$p3,$p4)", "22222222-legacy-row", root["id"], "22222222-legacy", "retained legacy unknown", Clock.Iso(Timestamp));
                    var steps = ((List<object?>)scenario["steps"]!).Cast<Dictionary<string, object?>>().ToArray();
                    Assert.Equal(26, steps.Length);
                    for (var index = 0; index < steps.Length; index++)
                    {
                        current = Timestamp.AddSeconds(index);
                        var operation = (Dictionary<string, object?>)steps[index]["operation"]!;
                        var requestId = "22222222-" + operation["id"];
                        object? value = null; string? error = null;
                        try
                        {
                            switch ((string)operation["kind"]!)
                            {
                                case "begin": store.BeginUsage(requestId, operation.GetValueOrDefault("task") as Dictionary<string, object?>, Profile(operation.GetValueOrDefault("effort") as string), (double)operation["reserved"]!, (string)operation["purpose"]!); break;
                                case "attempt": store.AttemptUsage(requestId); break;
                                case "finish": value = store.FinishUsage(requestId, operation.GetValueOrDefault("detail") as Dictionary<string, object?>, (string)operation["outcome"]!, operation.GetValueOrDefault("reason") as string, operation.GetValueOrDefault("metadata") as Dictionary<string, object?>); break;
                                case "has": value = store.HasUsage(requestId); break;
                                default: throw new InvalidOperationException("Missing usage operation coverage.");
                            }
                        }
                        catch (SqliteException exception) when (exception.SqliteErrorCode == 19 && Equals(operation["id"], "probe")) { error = "duplicate"; }
                        catch (InvalidOperationException exception) when (exception.Message == "Invalid usage reservation.") { error = exception.Message; }
                        var actual = new Dictionary<string, object?> { ["value"] = value, ["error"] = error, ["rows"] = Rows(store) };
                        Assert.Equal(JsJson.Stringify(steps[index]["expected"]), JsJson.Stringify(actual));
                    }
                }
                current = Timestamp.AddMinutes(1);
                using var recovered = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), () => current);
                Assert.Equal(JsJson.Stringify(scenario["recovered"]), JsJson.Stringify(Rows(recovered)));
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task OuterAndSavepointRollbackRestoreAdmissionAttemptAndSettlement()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-usage-rollback-").FullName;
        try
        {
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), () => Timestamp);
                Assert.Throws<IOException>(() => store.Transaction((Func<int>)(() => { store.BeginUsage("22222222-lost", null, Profile(), 12, "probe"); throw new IOException("rollback"); })));
                Assert.False(store.HasUsage("22222222-lost"));
                store.BeginUsage("22222222-kept", null, Profile(), 12, "probe");
                var original = JsJson.Stringify(Rows(store));
                store.Transaction(() =>
                {
                    Assert.Throws<IOException>(() => store.Immediate((Func<int>)(() =>
                    {
                        store.AttemptUsage("22222222-kept"); store.FinishUsage("22222222-kept", null, "cancelled");
                        store.BeginUsage("22222222-nested", null, Profile(), 1, "probe"); throw new IOException("savepoint");
                    })));
                    Assert.Equal(original, JsJson.Stringify(Rows(store)));
                    return 0;
                });
                Assert.Throws<SqliteException>(() => store.Transaction(() => { store.AttemptUsage("22222222-kept"); store.BeginUsage("22222222-kept", null, Profile(), 12, "probe"); return 0; }));
                Assert.Equal(original, JsJson.Stringify(Rows(store)));
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task CommittedSettlementSurvivesPublicationFailureWithoutSettlingTwice()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-usage-delivery-").FullName;
        try
        {
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), () => Timestamp, publish: _ => throw new IOException("delivery"));
                store.BeginUsage("22222222-kept", null, Profile(), 12, "probe");
                Assert.Throws<EventDeliveryException>(() => store.Transaction(() => { Assert.True(store.FinishUsage("22222222-kept", null, "failed")); store.Event("fixture.changed", null); return 0; }));
                Assert.False(store.FinishUsage("22222222-kept", null, "completed"));
                Assert.Equal("failed", Rows(store).Single()["outcome"]);
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Theory]
    [InlineData("fresh"), InlineData("v3")]
    public async Task AffinityIsRequiredEvenWhenLedgerIsDisabled(string era)
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-usage-affinity-").FullName;
        try
        {
            CopyEra(era, scratch); await using var loop = new RuntimeLoop(); Store? store = null;
            await loop.Invoke(() =>
            {
                store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"));
                foreach (var invalid in new[] { double.NaN, double.PositiveInfinity, double.NegativeInfinity })
                    if (era == "fresh") Assert.Throws<InvalidOperationException>(() => store.BeginUsage("bad", null, Profile(), invalid, "probe"));
                    else store.BeginUsage("bad", null, Profile(), invalid, "probe");
                return Task.FromResult(0);
            });
            Assert.Throws<InvalidOperationException>(() => store!.BeginUsage("id", null, Profile(), 0, "probe"));
            Assert.Throws<InvalidOperationException>(() => store!.AttemptUsage("id"));
            Assert.Throws<InvalidOperationException>(() => store!.FinishUsage("id", null, "failed"));
            Assert.Throws<InvalidOperationException>(() => store!.HasUsage("id"));
            await loop.Invoke(() => { store!.Dispose(); return Task.FromResult(0); });
        }
        finally { Directory.Delete(scratch, true); }
    }
}
