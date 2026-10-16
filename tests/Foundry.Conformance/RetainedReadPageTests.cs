using Foundry.Protocol;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

public sealed class RetainedReadPageTests
{
    private static string Root
    {
        get
        {
            for (var root = new DirectoryInfo(AppContext.BaseDirectory); root is not null; root = root.Parent)
                if (File.Exists(Path.Combine(root.FullName, "Foundry.slnx"))) return root.FullName;
            throw new InvalidOperationException("Missing retained read corpus.");
        }
    }
    private static long? Number(Dictionary<string, object?> value, string key) => value.TryGetValue(key, out var field) ? checked((long)(double)field!) : null;

    [Theory]
    [InlineData("fresh"), InlineData("v1"), InlineData("v2"), InlineData("v3"), InlineData("v4"), InlineData("v5"), InlineData("v5-wal")]
    public async Task RetainedPagesMatchNodeAndPreserveOpaqueRows(string era)
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-retained-read-").FullName;
        try
        {
            if (era != "fresh")
            {
                foreach (var file in Directory.GetFiles(Path.Combine(Root, "tests/fixtures/databases", era), "workspace.db*")) File.Copy(file, Path.Combine(scratch, Path.GetFileName(file)));
                File.WriteAllText(Path.Combine(scratch, Store.IsolationMarker), Store.IsolationDeclaration);
            }
            var corpus = (Dictionary<string, object?>)PersistedJson.Parse(File.ReadAllText(Path.Combine(Root, "tests/p2/retained-read-page-vectors.json")))!;
            var stamp = (string)corpus["stamp"]!;
            var scenario = ((List<object?>)corpus["cases"]!).Cast<Dictionary<string, object?>>().Single(item => Equals(item["era"], era));
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), () => DateTimeOffset.Parse(stamp, System.Globalization.CultureInfo.InvariantCulture));
                foreach (var task in ((List<object?>)corpus["tasks"]!).Cast<Dictionary<string, object?>>()) store.SaveTask(task);
                foreach (var row in ((List<object?>)corpus["records"]!).Cast<Dictionary<string, object?>>())
                {
                    if (store.SchemaVersion >= 4)
                        store.Execute("INSERT INTO provider_requests(request_id,task_id,root_task_id,purpose,attribution_known,created_at,attempted_at,finished_at,outcome,reserved,usage_known,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,reason) VALUES($p0,$p1,$p2,'conversation',1,$p3,$p4,$p5,$p6,$p7,$p8,$p9,$p10,$p11,$p12,$p13)", row["requestId"], row["taskId"], row["rootTaskId"], stamp, Equals(row["attempted"], true) ? stamp : null, Equals(row["finished"], true) ? stamp : null, row["outcome"], row["reserved"], Equals(row["known"], true) ? 1 : 0, row["input"], row["output"], row["cacheRead"], row["cacheCreation"], row["reason"]);
                    else
                        store.Execute("INSERT INTO usage_records(id,task_id,request_id,reserved,prompt_tokens,completion_tokens,cache_read_tokens,cache_creation_tokens,usage_known,reason,created_at) VALUES($p0,$p1,$p2,$p3,$p4,$p5,$p6,$p7,$p8,$p9,$p10)", row["id"], row["taskId"], row["requestId"], row["reserved"], row["input"], row["output"], row["cacheRead"], row["cacheCreation"], Equals(row["known"], true) ? 1 : 0, row["reason"], stamp);
                }
                foreach (var row in ((List<object?>)corpus["compactions"]!).Cast<Dictionary<string, object?>>())
                    store.Execute("INSERT INTO compactions(id,task_id,from_ordinal,to_ordinal,message_ids,summary,estimated_before,estimated_after,provider_state_before,provider_state_after,created_at) VALUES($p0,$p1,1,3,$p2,CAST($p3 AS TEXT),10000,2000,$p4,$p5,$p6)", row["id"], row["taskId"], "[\"12121212-0000-4000-8000-000000000301\",\"12121212-0000-4000-8000-000000000302\",\"12121212-0000-4000-8000-000000000303\"]", System.Text.Encoding.UTF8.GetBytes((string)row["summary"]!), "{\"opaque\":\"never expose before\"}", "{\"opaque\":\"never expose after\"}", stamp);
                string Snapshot() => JsJson.Stringify(new Dictionary<string, object?> { ["tasks"] = store.Rows("SELECT * FROM tasks ORDER BY rowid"), ["usage"] = store.Rows($"SELECT * FROM {(store.SchemaVersion >= 4 ? "provider_requests" : "usage_records")} ORDER BY rowid"), ["compactions"] = store.Rows("SELECT * FROM compactions ORDER BY rowid") })!;
                Assert.Equal(65536L, store.Scalar("SELECT length(CAST(summary AS BLOB)) FROM compactions WHERE id='12121212-0000-4000-8000-000000000205'"));
                var before = Snapshot();
                var steps = ((List<object?>)scenario["steps"]!).Cast<Dictionary<string, object?>>().ToArray();
                Assert.Equal(109, steps.Length);
                foreach (var step in steps)
                {
                    var input = (Dictionary<string, object?>)step["params"]!;
                    object? value = null; string? error = null;
                    try
                    {
                        value = (string)step["method"]! switch
                        {
                            "task.usageRecords" => store.UsageRecordPage((string)input["taskId"]!, Number(input, "before"), checked((int)(Number(input, "limit") ?? 50))),
                            "task.compactions" => store.CompactionPage((string)input["taskId"]!, Number(input, "before"), checked((int)(Number(input, "limit") ?? 50))),
                            "task.compactionContent" => store.CompactionContent((string)input["taskId"]!, (string)input["compactionId"]!, Number(input, "offset") ?? 0, checked((int)(Number(input, "maxBytes") ?? 65536))),
                            _ => throw new InvalidOperationException("Missing retained read coverage.")
                        };
                    }
                    catch (WorkspaceReadException exception) { error = exception.Message; }
                    catch (InvalidOperationException exception) when (exception.Message == "Task not found.") { error = exception.Message; }
                    Assert.Equal(JsJson.Stringify(step["value"]), JsJson.Stringify(value));
                    Assert.Equal(step["error"], error);
                    Assert.Equal(before, Snapshot());
                }
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }
}
