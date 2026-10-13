using Foundry.Protocol;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

public sealed class SearchPageTests
{
    private static string Root
    {
        get
        {
            for (var root = new DirectoryInfo(AppContext.BaseDirectory); root is not null; root = root.Parent)
                if (File.Exists(Path.Combine(root.FullName, "Foundry.slnx"))) return root.FullName;
            throw new InvalidOperationException("Missing search corpus.");
        }
    }
    [Theory]
    [InlineData("fresh"), InlineData("v1"), InlineData("v2"), InlineData("v3"), InlineData("v4"), InlineData("v5"), InlineData("v5-wal")]
    public async Task SearchPhasesAndFiltersMatchNodeWithoutSourceChanges(string era)
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-search-").FullName;
        try
        {
            if (era != "fresh")
            {
                foreach (var file in Directory.GetFiles(Path.Combine(Root, "tests/fixtures/databases", era), "workspace.db*")) File.Copy(file, Path.Combine(scratch, Path.GetFileName(file)));
                File.WriteAllText(Path.Combine(scratch, Store.IsolationMarker), Store.IsolationDeclaration);
            }
            var corpus = (Dictionary<string, object?>)PersistedJson.Parse(File.ReadAllText(Path.Combine(Root, "tests/p2/search-vectors.json")))!;
            var scenario = ((List<object?>)corpus["cases"]!).Cast<Dictionary<string, object?>>().Single(item => Equals(item["era"], era));
            await using var loop = new RuntimeLoop(); Store? owned = null;
            await loop.Invoke(() =>
            {
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), () => DateTimeOffset.Parse((string)corpus["stamp"]!, System.Globalization.CultureInfo.InvariantCulture)); owned = store;
                foreach (var task in ((List<object?>)corpus["tasks"]!).Cast<Dictionary<string, object?>>()) store.SaveTask(task);
                foreach (var message in ((List<object?>)corpus["messages"]!).Cast<Dictionary<string, object?>>()) store.SaveMessage(message);
                string Snapshot()
                {
                    var rows = new Dictionary<string, object?> { ["tasks"] = store.Rows("SELECT * FROM tasks ORDER BY rowid"), ["messages"] = store.Rows("SELECT * FROM messages ORDER BY rowid") };
                    if (store.SchemaVersion >= 5) rows["fts"] = store.Rows("SELECT rowid,* FROM messages_fts ORDER BY rowid");
                    return JsJson.Stringify(rows)!;
                }
                var before = Snapshot(); var steps = ((List<object?>)scenario["steps"]!).Cast<Dictionary<string, object?>>().ToArray(); Assert.True(steps.Length > 40);
                foreach (var step in steps)
                {
                    if (step.GetValueOrDefault("append") is Dictionary<string, object?> append)
                    {
                        store.SaveTask((Dictionary<string, object?>)append["task"]!); store.SaveMessage((Dictionary<string, object?>)append["message"]!); before = Snapshot();
                    }
                    object? value = null; string? error = null;
                    try { value = store.SearchPage((Dictionary<string, object?>)step["params"]!); }
                    catch (WorkspaceReadException exception) { error = exception.Message; }
                    Assert.Equal(step["error"], error); Assert.Equal(JsJson.Stringify(step["value"]), JsJson.Stringify(value)); Assert.Equal(before, Snapshot());
                }
                return Task.FromResult(0);
            });
            Assert.Throws<InvalidOperationException>(() => owned!.SearchPage(new()));
        }
        finally { Directory.Delete(scratch, true); }
    }
}
