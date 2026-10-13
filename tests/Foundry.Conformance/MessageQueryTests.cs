using System.Text;
using Foundry.Protocol;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

public sealed class MessageQueryTests
{
    private static readonly DateTimeOffset Timestamp = new(2026, 1, 2, 3, 4, 5, 678, TimeSpan.Zero);
    private static string Root
    {
        get
        {
            for (var root = new DirectoryInfo(AppContext.BaseDirectory); root is not null; root = root.Parent)
                if (File.Exists(Path.Combine(root.FullName, "Foundry.slnx"))) return root.FullName;
            throw new InvalidOperationException("Missing message query corpus.");
        }
    }
    private static long? Ordinal(Dictionary<string, object?> input, string field) => input.TryGetValue(field, out var value) ? checked((long)(double)value!) : null;

    [Theory]
    [InlineData("fresh"), InlineData("v1"), InlineData("v2"), InlineData("v3"), InlineData("v4"), InlineData("v5"), InlineData("v5-wal")]
    public async Task BoundedHistoryAndChunksMatchCommittedNodeWithoutChangingDocuments(string era)
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-message-query-").FullName;
        try
        {
            if (era != "fresh")
            {
                foreach (var file in Directory.GetFiles(Path.Combine(Root, "tests/fixtures/databases", era), "workspace.db*")) File.Copy(file, Path.Combine(scratch, Path.GetFileName(file)));
                File.WriteAllText(Path.Combine(scratch, Store.IsolationMarker), Store.IsolationDeclaration);
            }
            var corpus = (Dictionary<string, object?>)PersistedJson.Parse(File.ReadAllText(Path.Combine(Root, "tests/p2/message-query-vectors.json")))!;
            var cases = (List<object?>)corpus["cases"]!;
            Assert.Equal(7, cases.Count);
            var scenario = cases.Cast<Dictionary<string, object?>>().Single(item => Equals(item["era"], era));
            await using var loop = new RuntimeLoop(); Store? owned = null;
            await loop.Invoke(() =>
            {
                owned = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), () => Timestamp);
                foreach (var task in ((List<object?>)corpus["tasks"]!).Cast<Dictionary<string, object?>>()) owned.SaveTask(task);
                foreach (var message in ((List<object?>)corpus["messages"]!).Cast<Dictionary<string, object?>>()) owned.SaveMessage(message);
                foreach (var patch in ((List<object?>)scenario["sizingPatches"]!).Cast<Dictionary<string, object?>>())
                {
                    var messageId = (string)patch["messageId"]!;
                    var source = ((List<object?>)corpus["messages"]!).Cast<Dictionary<string, object?>>().Single(message => Equals(message["id"], messageId));
                    var sized = new Dictionary<string, object?>(source) { ["opaque"] = new string('x', checked((int)(double)patch["opaqueLength"]!)) };
                    owned.Execute("UPDATE messages SET data=$p0 WHERE id=$p1", JsJson.Stringify(sized), messageId);
                }
                var before = JsJson.Stringify(owned.Rows("SELECT rowid AS _rowid,* FROM messages WHERE id LIKE '33333333-%' ORDER BY rowid"));
                var redactor = new Redactor(); redactor.Add((string)corpus["secret"]!);
                var steps = ((List<object?>)scenario["steps"]!).Cast<Dictionary<string, object?>>().ToArray();
                Assert.Equal(era == "fresh" ? 40 : 11, steps.Length);
                foreach (var step in steps)
                {
                    var query = (Dictionary<string, object?>)step["query"]!;
                    var input = (Dictionary<string, object?>)query["params"]!;
                    object? value = null; string? error = null;
                    try
                    {
                        value = (string)query["method"]! switch
                        {
                            "task.messages" => owned.MessagePage((string)input["taskId"]!, checked((int)(Ordinal(input, "limit") ?? 50)), Ordinal(input, "before"), Ordinal(input, "through"), redactor),
                            "task.messageContent" => owned.MessageContent((string)input["taskId"]!, (string)input["messageId"]!, Ordinal(input, "offset") ?? 0, checked((int)(Ordinal(input, "maxBytes") ?? 65536)), redactor),
                            _ => throw new InvalidOperationException("Missing message query coverage.")
                        };
                        Assert.True(Encoding.UTF8.GetByteCount(JsJson.Stringify(value)!) <= 256 * 1024);
                    }
                    catch (WorkspaceReadException exception) { error = exception.Message; }
                    catch (InvalidOperationException exception) when (exception.Message == "Task not found.") { error = exception.Message; }
                    Assert.Equal(JsJson.Stringify(step["expected"]), JsJson.Stringify(new Dictionary<string, object?> { ["value"] = value, ["error"] = error }));
                }
                Assert.Equal(before, JsJson.Stringify(owned.Rows("SELECT rowid AS _rowid,* FROM messages WHERE id LIKE '33333333-%' ORDER BY rowid")));
                return Task.FromResult(0);
            });
            Assert.Throws<InvalidOperationException>(() => owned!.MessagePage("off-loop"));
            Assert.Throws<InvalidOperationException>(() => owned!.MessageContent("off-loop", "message"));
            await loop.Invoke(() => { owned!.Dispose(); return Task.FromResult(0); });
        }
        finally { Directory.Delete(scratch, true); }
    }
}
