using Foundry.Protocol;
using Foundry.Runtime;
using Foundry.Providers;
using System.Runtime.CompilerServices;
using Xunit;

namespace Foundry.Conformance;

public sealed class VisibilityTests
{
    private static string Root
    {
        get
        {
            for (var root = new DirectoryInfo(AppContext.BaseDirectory); root is not null; root = root.Parent)
                if (File.Exists(Path.Combine(root.FullName, "Foundry.slnx"))) return root.FullName;
            throw new InvalidOperationException("Missing visibility corpus.");
        }
    }
    private const string Prefix = "13131313-0000-4000-8000-";
    [Theory]
    [InlineData("fresh"), InlineData("v1"), InlineData("v2"), InlineData("v3"), InlineData("v4"), InlineData("v5"), InlineData("v5-wal")]
    public async Task VisibilityAndFeatureHistoryMatchNodeWithoutDismissingObligations(string era)
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-visibility-").FullName;
        try
        {
            if (era != "fresh")
            {
                foreach (var file in Directory.GetFiles(Path.Combine(Root, "tests/fixtures/databases", era), "workspace.db*")) File.Copy(file, Path.Combine(scratch, Path.GetFileName(file)));
                File.WriteAllText(Path.Combine(scratch, Store.IsolationMarker), Store.IsolationDeclaration);
            }
            var corpus = (Dictionary<string, object?>)PersistedJson.Parse(File.ReadAllText(Path.Combine(Root, "tests/p2/visibility-vectors.json")))!;
            var scenario = ((List<object?>)corpus["cases"]!).Cast<Dictionary<string, object?>>().Single(item => Equals(item["era"], era));
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), () => DateTimeOffset.Parse((string)corpus["stamp"]!, System.Globalization.CultureInfo.InvariantCulture));
                foreach (var task in ((List<object?>)corpus["tasks"]!).Cast<Dictionary<string, object?>>()) store.SaveTask(task);
                store.Execute("INSERT INTO intents(id,kind,state,data) VALUES($p0,'tool.approval','awaiting-approval',$p1)", Prefix + "000000000101", JsJson.Stringify(new { taskId = Prefix + "000000000001", retained = "pending" }));
                store.Execute("INSERT INTO intents(id,kind,state,data) VALUES($p0,'git.push','unknown',$p1)", Prefix + "000000000102", JsJson.Stringify(new { taskId = Prefix + "000000000002", retained = "unknown" }));
                var preserved = JsJson.Stringify(store.Rows("SELECT * FROM intents WHERE id LIKE '13131313-%' ORDER BY rowid"));
                var steps = ((List<object?>)scenario["steps"]!).Cast<Dictionary<string, object?>>().ToArray(); Assert.Equal(74, steps.Length);
                foreach (var step in steps)
                {
                    var input = (Dictionary<string, object?>)step["params"]!; object? value = null; string? error = null;
                    try
                    {
                        switch ((string)step["method"]!)
                        {
                            case "features.get": value = store.FeatureSnapshot(); break;
                            case "features.set": value = store.SetFeature(input); break;
                            case "task.setArchived":
                                if (Equals(input["archived"], true) && Equals(store.FeatureState("archive")["enabled"], false)) throw new WorkspaceReadException("Archive admission is paused. Restore and pending-work access remain available.");
                                value = store.SetArchived((string)input["taskId"]!, (bool)input["archived"]!); break;
                            default: throw new InvalidOperationException("Missing visibility coverage.");
                        }
                    }
                    catch (WorkspaceReadException exception) { error = exception.Message; }
                    catch (InvalidOperationException exception) when (exception.Message == "Task not found.") { error = exception.Message; }
                    Assert.Equal(JsJson.Stringify(step["value"]), JsJson.Stringify(value)); Assert.Equal(step["error"], error);
                    Assert.Equal(JsJson.Stringify(step["tasks"]), JsJson.Stringify(store.Rows("SELECT data FROM tasks WHERE id LIKE '13131313-%' ORDER BY rowid").Select(row => PersistedJson.Parse((string)row["data"]!)).ToList()));
                    Assert.Equal(JsJson.Stringify(step["features"]), JsJson.Stringify(store.FeatureSnapshot()));
                    Assert.Equal(preserved, JsJson.Stringify(store.Rows("SELECT * FROM intents WHERE id LIKE '13131313-%' ORDER BY rowid")));
                }
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task ChildAndFeatureHistoryFailuresRollBackCompletely()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-visibility-rollback-").FullName;
        try
        {
            await using var loop = new RuntimeLoop(); await loop.Invoke(() =>
            {
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"));
                var corpus = (Dictionary<string, object?>)PersistedJson.Parse(File.ReadAllText(Path.Combine(Root, "tests/p2/visibility-vectors.json")))!;
                foreach (var task in ((List<object?>)corpus["tasks"]!).Cast<Dictionary<string, object?>>()) store.SaveTask(task);
                var rows = JsJson.Stringify(store.Rows("SELECT * FROM tasks ORDER BY rowid")); var events = JsJson.Stringify(store.Rows("SELECT * FROM events ORDER BY sequence"));
                store.Execute("CREATE TRIGGER visibility_fail BEFORE UPDATE ON tasks WHEN NEW.id='13131313-0000-4000-8000-000000000003' BEGIN SELECT RAISE(ABORT,'injected child failure'); END");
                Assert.Throws<Microsoft.Data.Sqlite.SqliteException>(() => store.SetArchived(Prefix + "000000000002", true));
                Assert.Equal(rows, JsJson.Stringify(store.Rows("SELECT * FROM tasks ORDER BY rowid"))); Assert.Equal(events, JsJson.Stringify(store.Rows("SELECT * FROM events ORDER BY sequence")));
                store.Execute("CREATE TRIGGER feature_fail BEFORE INSERT ON workspace_feature_history BEGIN SELECT RAISE(ABORT,'injected history failure'); END");
                var features = JsJson.Stringify(store.FeatureSnapshot());
                Assert.Throws<Microsoft.Data.Sqlite.SqliteException>(() => store.SetFeature(new() { ["feature"] = "archive", ["enabled"] = false }));
                Assert.Equal(features, JsJson.Stringify(store.FeatureSnapshot()));
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task ArchiveDoesNotCancelActiveProviderOrDismissPendingWork()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-live-visibility-").FullName;
        try
        {
            await using var loop = new RuntimeLoop(); Store? store = null; DevelopmentChat? chat = null;
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var completed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            async IAsyncEnumerable<ProviderChatEvent> Stream(IReadOnlyList<ProviderMessage> _, ProviderContinuation? __, [EnumeratorCancellation] CancellationToken token)
            {
                entered.SetResult(); await release.Task.WaitAsync(token);
                yield return new ProviderText("retained response");
                yield return new ProviderDone(new ProviderContinuation("fake", new Dictionary<string, object?> { ["stage"] = "chat", ["calls"] = new List<object?>() }));
            }
            await loop.Invoke(() =>
            {
                store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), publish: item => { if (item.Type == "task.completed") completed.TrySetResult(); });
                chat = new DevelopmentChat(loop, store, Stream); return Task.FromResult(0);
            });
            try
            {
                var task = (Dictionary<string, object?>)(await loop.Invoke(() => chat!.Dispatch("task.start", (Dictionary<string, object?>)Contracts.Validate("rpc task.start", new Dictionary<string, object?> { ["requestId"] = Prefix + "000000000901", ["projectId"] = null, ["profileId"] = Store.FakeProfileId, ["mode"] = "chat", ["content"] = "hello" })!)))!;
                await entered.Task.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
                await loop.Invoke(async () =>
                {
                    var taskId = (string)task["id"]!;
                    store!.Execute("INSERT INTO intents(id,kind,state,data) VALUES($p0,'tool.approval','awaiting-approval',$p1)", Prefix + "000000000902", JsJson.Stringify(new { taskId }));
                    var pending = JsJson.Stringify(store.Rows("SELECT * FROM provider_requests"));
                    await chat!.Dispatch("task.setArchived", new() { ["taskId"] = taskId, ["archived"] = true });
                    Assert.Equal("running", store.ReadTask(taskId)["status"]); Assert.Equal(pending, JsJson.Stringify(store.Rows("SELECT * FROM provider_requests")));
                    Assert.Equal("awaiting-approval", store.Scalar("SELECT state FROM intents WHERE id=$p0", Prefix + "000000000902"));
                    await chat.Dispatch("features.set", new() { ["feature"] = "archive", ["enabled"] = false });
                    await Assert.ThrowsAsync<WorkspaceReadException>(() => chat.Dispatch("task.setArchived", new() { ["taskId"] = taskId, ["archived"] = true }));
                    await chat.Dispatch("task.setArchived", new() { ["taskId"] = taskId, ["archived"] = false });
                    Assert.Equal("running", store.ReadTask(taskId)["status"]); return 0;
                });
                release.SetResult(); await completed.Task.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
                await loop.Invoke(() => { Assert.Equal("idle", store!.ReadTask((string)task["id"]!)["status"]); Assert.Equal("completed", store.Rows("SELECT outcome FROM provider_requests").Single()["outcome"]); return Task.FromResult(0); });
            }
            finally { release.TrySetResult(); await loop.Invoke(async () => { try { await chat!.Shutdown(); } finally { store!.Dispose(); } return 0; }); }
        }
        finally { Directory.Delete(scratch, true); }
    }
}
