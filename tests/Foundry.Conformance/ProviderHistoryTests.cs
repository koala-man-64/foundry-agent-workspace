using Foundry.Protocol;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

public sealed class ProviderHistoryTests
{
    private static readonly DateTimeOffset Timestamp = new(2026, 1, 2, 3, 4, 5, 678, TimeSpan.Zero);
    private static string Root
    {
        get
        {
            for (var root = new DirectoryInfo(AppContext.BaseDirectory); root is not null; root = root.Parent)
                if (File.Exists(Path.Combine(root.FullName, "Foundry.slnx"))) return root.FullName;
            throw new InvalidOperationException("Missing provider history corpus.");
        }
    }
    public static IEnumerable<object[]> Vectors()
    {
        var cases = (List<object?>)PersistedJson.Parse(File.ReadAllText(Path.Combine(Root, "tests/p2/provider-history-vectors.json")))!;
        if (cases.Count != 144) throw new InvalidOperationException("Incomplete provider history coverage.");
        return cases.Select(item => new object[] { item! });
    }

    [Theory]
    [MemberData(nameof(Vectors))]
    public void CompleteMessageCompactionMatchesCommittedNode(Dictionary<string, object?> vector)
    {
        var before = JsJson.Stringify(vector);
        var messages = ((List<object?>)vector["messages"]!).Cast<Dictionary<string, object?>>();
        var compactions = ((List<object?>)vector["compactions"]!).Cast<Dictionary<string, object?>>();
        Assert.Equal(JsJson.Stringify(vector["expected"]), JsJson.Stringify(ProviderHistory.ApplyCompactions(messages, compactions)));
        Assert.Equal(before, JsJson.Stringify(vector));
    }

    [Theory]
    [InlineData("fresh"), InlineData("v1"), InlineData("v2"), InlineData("v3"), InlineData("v4"), InlineData("v5"), InlineData("v5-wal")]
    public async Task RetainedHistoryAndOpaqueNativeStateMatchNodeWithoutDatabaseWrites(string era)
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-retained-history-").FullName;
        try
        {
            if (era != "fresh")
            {
                foreach (var file in Directory.GetFiles(Path.Combine(Root, "tests/fixtures/databases", era), "workspace.db*")) File.Copy(file, Path.Combine(scratch, Path.GetFileName(file)));
                File.WriteAllText(Path.Combine(scratch, Store.IsolationMarker), Store.IsolationDeclaration);
            }
            var corpus = (Dictionary<string, object?>)PersistedJson.Parse(File.ReadAllText(Path.Combine(Root, "tests/p2/retained-history-vectors.json")))!;
            var cases = (List<object?>)corpus["cases"]!; Assert.Equal(7, cases.Count);
            var scenario = cases.Cast<Dictionary<string, object?>>().Single(item => Equals(item["era"], era));
            await using var loop = new RuntimeLoop(); Store? owned = null;
            await loop.Invoke(() =>
            {
                owned = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), () => Timestamp);
                var taskId = (string)((Dictionary<string, object?>)corpus["task"]!)["id"]!;
                owned.SaveTask((Dictionary<string, object?>)corpus["task"]!);
                foreach (var message in ((List<object?>)corpus["messages"]!).Cast<Dictionary<string, object?>>()) owned.SaveMessage(message);
                var record = (Dictionary<string, object?>)scenario["compaction"]!;
                owned.Execute("INSERT INTO compactions(id,task_id,from_ordinal,to_ordinal,message_ids,summary,estimated_before,estimated_after,provider_state_before,provider_state_after,created_at) VALUES($p0,$p1,$p2,$p3,$p4,$p5,$p6,$p7,NULL,$p8,$p9)",
                    record["id"], record["taskId"], record["fromOrdinal"], record["toOrdinal"], JsJson.Stringify(record["messageIds"]), record["summary"], record["estimatedTokensBefore"], record["estimatedTokensAfter"], JsJson.Stringify(corpus["state"]), record["createdAt"]);
                owned.Execute("INSERT OR REPLACE INTO intents VALUES($p0,'provider.context',$p1,'complete')", taskId, JsJson.Stringify(corpus["state"]));
                string Snapshot() => JsJson.Stringify(new Dictionary<string, object?>
                {
                    ["messages"] = owned.Rows("SELECT * FROM messages WHERE task_id=$p0 ORDER BY ordinal", taskId),
                    ["compactions"] = owned.Rows("SELECT * FROM compactions WHERE task_id=$p0 ORDER BY from_ordinal", taskId),
                    ["state"] = owned.Rows("SELECT * FROM intents WHERE id=$p0", taskId)
                })!;
                var before = Snapshot();
                var actual = new Dictionary<string, object?>
                {
                    ["messages"] = owned.MessagesWithOrdinals(taskId), ["compactions"] = owned.ReadCompactions(taskId), ["state"] = owned.ReadProviderState(taskId),
                    ["emptyMessages"] = owned.MessagesWithOrdinals("missing"), ["emptyCompactions"] = owned.ReadCompactions("missing"), ["missingState"] = owned.ReadProviderState("missing"),
                    ["providerHistory"] = ProviderHistory.ApplyCompactions(owned.MessagesWithOrdinals(taskId), owned.ReadCompactions(taskId))
                };
                Assert.Equal(JsJson.Stringify(scenario["expected"]), JsJson.Stringify(actual));
                var copy = owned.ReadProviderState(taskId)!; copy["future"] = false;
                Assert.Equal(JsJson.Stringify(corpus["state"]), JsJson.Stringify(owned.ReadProviderState(taskId)));
                Assert.Equal(before, Snapshot());
                return Task.FromResult(0);
            });
            Assert.Throws<InvalidOperationException>(() => owned!.MessagesWithOrdinals("off-loop"));
            Assert.Throws<InvalidOperationException>(() => owned!.ReadCompactions("off-loop"));
            Assert.Throws<InvalidOperationException>(() => owned!.ReadProviderState("off-loop"));
            await loop.Invoke(() => { owned!.Dispose(); return Task.FromResult(0); });
        }
        finally { Directory.Delete(scratch, true); }
    }
}
