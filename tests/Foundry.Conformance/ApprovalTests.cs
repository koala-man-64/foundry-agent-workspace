using System.Globalization;
using Foundry.Protocol;
using Foundry.Providers;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

/// <summary>
/// Approval records against the committed Node steps (tests/p2/approvals.test.ts): task.approvals, approval.get and
/// approval.content through DevelopmentChat, which never rewrite a row, then approval.reconcile with the exact approval
/// row and event rows it records, in fresh data and copies of all six fixture eras.
/// </summary>
public sealed class ApprovalTests
{
    private static readonly Dictionary<string, object?> Corpus = (Dictionary<string, object?>)PersistedJson.Parse(File.ReadAllText(Path.Combine(RepositoryFixture.Root, "tests/p2/approval-vectors.json")))!;

    [Fact]
    public void OracleSourceBindingsAreCurrent()
    {
        var corpus = RepositoryFixture.ReadCorpus("tests/p2/approval-vectors.json");
        Assert.Equal(1, corpus.GetProperty("schemaVersion").GetInt32());
        RepositoryFixture.AssertOracleSources(corpus);
    }

    /// <summary>
    /// Native difference: a stored approval that is not valid JSON is not answered as a refusal. It faults the request, which
    /// ends the development runtime as every native read of malformed persisted data does; TypeScript answers with its
    /// parser's message. The page skips such a row in both runtimes.
    /// </summary>
    [Fact]
    public async Task AMalformedStoredApprovalFaultsInsteadOfBeingAnswered()
    {
        using var fixture = RepositoryFixture.Create("foundry-p2-approvals-malformed-");
        var data = Directory.CreateDirectory(fixture.Local("data")).FullName;
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            using var store = new Store(loop, data, Path.Combine(fixture.Scratch, "injected-root"));
            var chat = new DevelopmentChat(loop, store);
            var task = ((List<object?>)Corpus["tasks"]!).Cast<Dictionary<string, object?>>().First(item => Equals(item["workspaceKind"], "none"));
            store.SaveTask(new(task));
            store.Execute("INSERT INTO intents VALUES ('13131313-0000-4000-8000-000000000318','tool.approval','not json','unknown')");
            var parameters = new Dictionary<string, object?> { ["taskId"] = task["id"], ["approvalId"] = "13131313-0000-4000-8000-000000000318" };
            await Assert.ThrowsAnyAsync<System.Text.Json.JsonException>(() => chat.Dispatch("approval.get", parameters));
            await Assert.ThrowsAnyAsync<System.Text.Json.JsonException>(() => chat.Dispatch("approval.reconcile", parameters));
            Assert.Empty((List<object?>)((Dictionary<string, object?>)(await chat.Dispatch("task.approvals", new() { ["taskId"] = task["id"] }))!)["approvals"]!);
            return 0;
        });
    }

    [Theory]
    [InlineData("fresh"), InlineData("v1"), InlineData("v2"), InlineData("v3"), InlineData("v4"), InlineData("v5"), InlineData("v5-wal")]
    public async Task ApprovalsMatchNodeAndReadsNeverRewriteRows(string era)
    {
        var scenario = ((List<object?>)Corpus["cases"]!).Cast<Dictionary<string, object?>>().Single(item => Equals(item["era"], era));
        var stamp = DateTimeOffset.Parse((string)Corpus["stamp"]!, CultureInfo.InvariantCulture);
        using var fixture = RepositoryFixture.Create("foundry-p2-approvals-");
        foreach (var (name, text) in (Dictionary<string, object?>)Corpus["files"]!) fixture.Write("work/" + name, (string)text!);
        var work = fixture.Local("work");
        var data = Directory.CreateDirectory(fixture.Local("data")).FullName;
        if (era != "fresh")
        {
            foreach (var file in Directory.GetFiles(Path.Combine(RepositoryFixture.Root, "tests/fixtures/databases", era), "workspace.db*")) File.Copy(file, Path.Combine(data, Path.GetFileName(file)));
            File.WriteAllText(Path.Combine(data, Store.IsolationMarker), Store.IsolationDeclaration);
        }
        object? Expand(object? value) => PersistedJson.Parse(JsJson.Stringify(value)!.Replace("{work}", work.Replace("\\", "\\\\", StringComparison.Ordinal), StringComparison.Ordinal));
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            using var store = new Store(loop, data, Path.Combine(fixture.Scratch, "injected-root"), () => stamp);
            var chat = new DevelopmentChat(loop, store, (messages, continuation, token) => new FakeChatProvider().StreamTurn(messages, continuation, token), () => stamp, null, fixture.Environment);
            Assert.Equal(scenario["schema"], (double)store.SchemaVersion);
            foreach (var task in ((List<object?>)Corpus["tasks"]!).Cast<Dictionary<string, object?>>()) store.SaveTask((Dictionary<string, object?>)Expand(task)!);
            foreach (var item in ((List<object?>)Corpus["approvals"]!).Cast<Dictionary<string, object?>>())
                store.Execute("INSERT INTO intents VALUES ($p0,'tool.approval',$p1,$p2)", item["id"], item["data"] is string raw ? raw : JsJson.Stringify(Expand(item["data"])), item["state"]);
            string Rows() => JsJson.Stringify(new Dictionary<string, object?>
            {
                ["intents"] = store.Rows("SELECT rowid AS _rowid,* FROM intents WHERE kind='tool.approval' ORDER BY rowid"), ["events"] = store.Rows("SELECT * FROM events ORDER BY sequence"),
            })!;
            async Task<(object? Value, string? Error)> Act(Dictionary<string, object?> step)
            {
                try { return (fixture.Normalize(await chat.Dispatch((string)step["method"]!, new((Dictionary<string, object?>)step["params"]!))), null); }
                catch (InvalidOperationException error) when (error is WorkspaceReadException || error.Message == "Task not found.") { return (null, error.Message); }
            }
            var before = Rows();
            var position = 0;
            foreach (var step in ((List<object?>)scenario["steps"]!).Cast<Dictionary<string, object?>>())
            {
                var (value, error) = await Act(step);
                var label = $"{era} read #{position++} {step["method"]}";
                Assert.True(JsJson.Stringify(step["value"]) == JsJson.Stringify(value), $"{label}: expected {JsJson.Stringify(step["value"])}\nactual   {JsJson.Stringify(value)}");
                Assert.True(Equals(step["error"], error), $"{label}: expected error {step["error"]}, actual {error}");
            }
            Assert.Equal(before, Rows());
            position = 0;
            foreach (var step in ((List<object?>)scenario["reconciled"]!).Cast<Dictionary<string, object?>>())
            {
                var eventsBefore = (long)store.Scalar("SELECT COALESCE(MAX(sequence),0) FROM events")!;
                var (value, error) = await Act(step);
                var label = $"{era} reconcile #{position++}";
                Assert.True(JsJson.Stringify(step["value"]) == JsJson.Stringify(value), $"{label}: expected {JsJson.Stringify(step["value"])}\nactual   {JsJson.Stringify(value)}");
                Assert.True(Equals(step["error"], error), $"{label}: expected error {step["error"]}, actual {error}");
                var row = store.Rows("SELECT * FROM intents WHERE id=$p0", ((Dictionary<string, object?>)step["params"]!)["approvalId"]).SingleOrDefault();
                Assert.True(JsJson.Stringify(step["row"]) == JsJson.Stringify(fixture.Normalize(row)), $"{label}: row expected {JsJson.Stringify(step["row"])}\nactual   {JsJson.Stringify(fixture.Normalize(row))}");
                var events = store.Rows("SELECT * FROM events WHERE sequence>$p0 ORDER BY sequence", eventsBefore);
                Assert.True(JsJson.Stringify(step["events"]) == JsJson.Stringify(fixture.Normalize(events)), $"{label}: events expected {JsJson.Stringify(step["events"])}\nactual   {JsJson.Stringify(fixture.Normalize(events))}");
            }
            return 0;
        });
    }
}
