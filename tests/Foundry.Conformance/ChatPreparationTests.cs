using Foundry.Protocol;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

public sealed class ChatPreparationTests
{
    private static string Root
    {
        get
        {
            for (var root = new DirectoryInfo(AppContext.BaseDirectory); root is not null; root = root.Parent)
                if (File.Exists(Path.Combine(root.FullName, "Foundry.slnx"))) return root.FullName;
            throw new InvalidOperationException("Missing preparation corpus.");
        }
    }
    [Theory]
    [InlineData("fresh"), InlineData("v1"), InlineData("v2"), InlineData("v3"), InlineData("v4"), InlineData("v5"), InlineData("v5-wal")]
    public async Task ChatPreparationMatchesNodeGatesAndDoesNotRewriteRetainedState(string era)
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-chat-preparation-").FullName;
        try
        {
            if (era != "fresh")
            {
                foreach (var file in Directory.GetFiles(Path.Combine(Root, "tests/fixtures/databases", era), "workspace.db*")) File.Copy(file, Path.Combine(scratch, Path.GetFileName(file)));
                File.WriteAllText(Path.Combine(scratch, Store.IsolationMarker), Store.IsolationDeclaration);
            }
            var corpus = (Dictionary<string, object?>)PersistedJson.Parse(File.ReadAllText(Path.Combine(Root, "tests/p2/chat-preparation-vectors.json")))!;
            var cases = (List<object?>)corpus["cases"]!; Assert.Equal(7, cases.Count);
            var scenario = cases.Cast<Dictionary<string, object?>>().Single(item => Equals(item["era"], era));
            await using var loop = new RuntimeLoop(); Store? owned = null;
            await loop.Invoke(() =>
            {
                owned = new Store(loop, scratch, Path.Combine(scratch, "injected-root"));
                var task = (Dictionary<string, object?>)corpus["task"]!; var taskId = (string)task["id"]!;
                owned.SaveTask(task);
                foreach (var message in ((List<object?>)corpus["messages"]!).Cast<Dictionary<string, object?>>()) owned.SaveMessage(message);
                var steps = ((List<object?>)scenario["steps"]!).Cast<Dictionary<string, object?>>().ToArray(); Assert.Equal(96, steps.Length);
                foreach (var step in steps)
                {
                    var current = new Dictionary<string, object?>(task);
                    if (Equals(step["omitMode"], true)) current.Remove("mode");
                    owned.SaveTask(current);
                    owned.Execute("DELETE FROM intents WHERE id IN ($p0,$p1)", taskId, "preparation-approval");
                    if (step["state"] is not null) owned.Execute("INSERT INTO intents VALUES($p0,'provider.context',$p1,'complete')", taskId, JsJson.Stringify(step["state"]));
                    if (step["approval"] is Dictionary<string, object?> approval) owned.Execute("INSERT INTO intents VALUES($p0,'tool.approval',$p1,$p2)", "preparation-approval", JsJson.Stringify(approval["data"]), approval["sql"]);
                    var before = JsJson.Stringify(owned.Rows("SELECT * FROM intents ORDER BY rowid"));
                    object? value = null; string? error = null;
                    try { value = owned.PrepareChatRequest(taskId, (Dictionary<string, object?>)corpus["profile"]!, "fixture", "new 😀"); }
                    catch (InvalidOperationException exception) when (exception.Message.StartsWith("This task has ", StringComparison.Ordinal)) { error = exception.Message; }
                    Assert.Equal(JsJson.Stringify(step["expected"]), JsJson.Stringify(new Dictionary<string, object?> { ["value"] = value, ["error"] = error, ["blockingUnknown"] = owned.HasBlockingUnknown(taskId) }));
                    Assert.Equal(before, JsJson.Stringify(owned.Rows("SELECT * FROM intents ORDER BY rowid")));
                }
                return Task.FromResult(0);
            });
            Assert.Throws<InvalidOperationException>(() => owned!.PrepareChatRequest("off-loop", new(), "fixture", "text"));
            Assert.Throws<InvalidOperationException>(() => owned!.HasBlockingUnknown("off-loop"));
            await loop.Invoke(() => { owned!.Dispose(); return Task.FromResult(0); });
        }
        finally { Directory.Delete(scratch, true); }
    }
}
