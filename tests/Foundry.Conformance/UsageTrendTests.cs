using Foundry.Protocol;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

public sealed class UsageTrendTests
{
    private static string Root
    {
        get
        {
            for (var root = new DirectoryInfo(AppContext.BaseDirectory); root is not null; root = root.Parent)
                if (File.Exists(Path.Combine(root.FullName, "Foundry.slnx"))) return root.FullName;
            throw new InvalidOperationException("Missing usage trend corpus.");
        }
    }
    [Theory]
    [InlineData("fresh"), InlineData("v1"), InlineData("v2"), InlineData("v3"), InlineData("v4"), InlineData("v5"), InlineData("v5-wal")]
    public async Task UsageGroupingAndAttributionMatchNodeWithoutChangingLedgers(string era)
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-usage-trend-").FullName;
        try
        {
            if (era != "fresh")
            {
                foreach (var file in Directory.GetFiles(Path.Combine(Root, "tests/fixtures/databases", era), "workspace.db*")) File.Copy(file, Path.Combine(scratch, Path.GetFileName(file)));
                File.WriteAllText(Path.Combine(scratch, Store.IsolationMarker), Store.IsolationDeclaration);
            }
            var corpus = (Dictionary<string, object?>)PersistedJson.Parse(File.ReadAllText(Path.Combine(Root, "tests/p2/usage-trend-vectors.json")))!;
            var scenario = ((List<object?>)corpus["cases"]!).Cast<Dictionary<string, object?>>().Single(item => Equals(item["era"], era));
            await using var loop = new RuntimeLoop(); Store? owned = null;
            await loop.Invoke(() =>
            {
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), () => DateTimeOffset.Parse((string)corpus["stamp"]!, System.Globalization.CultureInfo.InvariantCulture)); owned = store;
                foreach (var task in ((List<object?>)corpus["tasks"]!).Cast<Dictionary<string, object?>>()) store.SaveTask(task);
                foreach (var statement in ((List<object?>)corpus["statements"]!).Cast<Dictionary<string, object?>>())
                {
                    if (!Equals(statement["current"], store.SchemaVersion >= 4)) continue;
                    var parts = ((string)statement["sql"]!).Split('?'); var sql = parts[0];
                    for (var n = 1; n < parts.Length; n++) sql += "$p" + (n - 1) + parts[n];
                    var values = ((List<object?>)statement["values"]!).ToArray(); Assert.Equal(parts.Length - 1, values.Length); store.Execute(sql, values);
                }
                string Snapshot() => JsJson.Stringify(new Dictionary<string, object?> { ["tasks"] = store.Rows("SELECT * FROM tasks ORDER BY rowid"), ["usage"] = store.Rows("SELECT * FROM " + (store.SchemaVersion >= 4 ? "provider_requests" : "usage_records") + " ORDER BY rowid") })!;
                var before = Snapshot(); var steps = ((List<object?>)scenario["steps"]!).Cast<Dictionary<string, object?>>().ToArray(); Assert.True(steps.Length > 80);
                foreach (var step in steps)
                {
                    object? value = null; string? error = null;
                    try { value = store.UsageTrend((Dictionary<string, object?>)step["params"]!); }
                    catch (WorkspaceReadException exception) { error = exception.Message; }
                    catch (InvalidOperationException exception) when (exception.Message == "Task not found.") { error = exception.Message; }
                    Assert.Equal(step["error"], error); Assert.Equal(JsJson.Stringify(step["value"]), JsJson.Stringify(value)); Assert.Equal(before, Snapshot());
                }
                return Task.FromResult(0);
            });
            Assert.Throws<InvalidOperationException>(() => owned!.UsageTrend(new()));
        }
        finally { Directory.Delete(scratch, true); }
    }
}
