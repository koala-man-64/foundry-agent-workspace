using System.Globalization;
using System.Text.Json;
using Foundry.Protocol;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

public sealed class LegacyTaskPageTests
{
    private static string Root
    {
        get
        {
            for (var root = new DirectoryInfo(AppContext.BaseDirectory); root is not null; root = root.Parent)
                if (File.Exists(Path.Combine(root.FullName, "Foundry.slnx"))) return root.FullName;
            throw new InvalidOperationException("Missing legacy memory corpus.");
        }
    }
    private static string Key(int n) => "99999999-0000-4000-8000-" + n.ToString("000000000000", CultureInfo.InvariantCulture);
    private static Dictionary<string, object?> TaskAt(int n, int count, string stamp)
    {
        var start = new DateTimeOffset(2024, 1, 1, 0, 0, 0, TimeSpan.Zero);
        var task = new Dictionary<string, object?>
        {
            ["id"] = Key(n + 1), ["title"] = "Large legacy " + n.ToString(CultureInfo.InvariantCulture), ["profileId"] = Store.FakeProfileId, ["status"] = n % 3 == 0 ? "failed" : "idle",
            ["createdAt"] = Clock.Iso(start.AddSeconds(n * 7919 % count)), ["updatedAt"] = Clock.Iso(start.AddSeconds(n * 3571 % count)), ["tokenBudget"] = 100000, ["usedTokens"] = 0,
            ["mode"] = n % 2 == 0 ? "chat" : "coding", ["workspaceKind"] = "git", ["projectPath"] = @"C:\fixture-legacy-memory",
            ["worktreePath"] = @"C:\fixture-legacy-memory\wt", ["branch"] = "codex/fixture", ["baseCommit"] = new string('0', 40)
        };
        if (n % 5 == 0) task["archivedAt"] = stamp;
        if (n % 17 == 0) task["parentTaskId"] = Key(count + 1);
        task["retained"] = new Dictionary<string, object?> { ["index"] = n, ["opaque"] = new string('x', 1024) };
        return task;
    }

    [Theory]
    [InlineData("v1"), InlineData("v2"), InlineData("v3"), InlineData("v4")]
    public async Task LargeLegacyPageMatchesWholeHistoryReferenceAndReleasesReader(string era)
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-large-legacy-").FullName;
        try
        {
            foreach (var file in Directory.GetFiles(Path.Combine(Root, "tests/fixtures/databases", era), "workspace.db*")) File.Copy(file, Path.Combine(scratch, Path.GetFileName(file)));
            File.WriteAllText(Path.Combine(scratch, Store.IsolationMarker), Store.IsolationDeclaration);
            var corpus = (Dictionary<string, object?>)PersistedJson.Parse(File.ReadAllText(Path.Combine(Root, "tests/p2/legacy-task-page-vectors.json")))!;
            var count = Convert.ToInt32(corpus["count"], CultureInfo.InvariantCulture); Assert.Equal(20000, count);
            var stamp = (string)corpus["stamp"]!; var timestamp = DateTimeOffset.Parse(stamp, CultureInfo.InvariantCulture);
            var scenario = ((List<object?>)corpus["cases"]!).Cast<Dictionary<string, object?>>().Single(item => Equals(item["era"], era));
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), () => timestamp);
                store.Transaction(() =>
                {
                    for (var n = 0; n < count; n++) { var task = TaskAt(n, count, stamp); store.Execute("INSERT INTO tasks(id,data) VALUES($p0,$p1)", task["id"], JsJson.Stringify(task)); }
                    return 0;
                });
                var before = store.Scalar("SELECT COUNT(*) FROM tasks");
                var steps = ((List<object?>)scenario["steps"]!).Cast<Dictionary<string, object?>>().ToArray(); Assert.Equal(10, steps.Length);
                foreach (var step in steps)
                {
                    var page = store.TaskPage((Dictionary<string, object?>)Contracts.Validate("rpc workspace.tasks", step["params"])!);
                    Assert.Equal(step["hash"], Compatibility.Hash(page));
                    Assert.Equal(JsJson.Stringify(step["ids"]), JsJson.Stringify(((List<object?>)page["tasks"]!).Cast<Dictionary<string, object?>>().Select(task => task["id"]).ToList()));
                    Assert.Equal(before, store.Scalar("SELECT COUNT(*) FROM tasks"));
                }
                store.Execute("INSERT INTO tasks(id,data) VALUES($p0,'{bad')", Key(count + 2));
                Assert.Throws<JsonException>(() => store.TaskPage((Dictionary<string, object?>)Contracts.Validate("rpc workspace.tasks", new Dictionary<string, object?> { ["projectPath"] = @"C:\fixture-legacy-memory", ["limit"] = 1 })!));
                store.Execute("DELETE FROM tasks WHERE id=$p0", Key(count + 2));
                Assert.Equal(before, store.Scalar("SELECT COUNT(*) FROM tasks"));
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }
}
