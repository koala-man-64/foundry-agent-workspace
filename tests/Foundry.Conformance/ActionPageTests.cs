using Foundry.Protocol;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

public sealed class ActionPageTests
{
    private static string Root
    {
        get
        {
            for (var root = new DirectoryInfo(AppContext.BaseDirectory); root is not null; root = root.Parent)
                if (File.Exists(Path.Combine(root.FullName, "Foundry.slnx"))) return root.FullName;
            throw new InvalidOperationException("Missing Inbox corpus.");
        }
    }
    [Theory]
    [InlineData("fresh"), InlineData("v1"), InlineData("v2"), InlineData("v3"), InlineData("v4"), InlineData("v5"), InlineData("v5-wal")]
    public async Task InboxPagesMatchNodeAndPreserveAllSourceRows(string era)
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-inbox-").FullName;
        try
        {
            if (era != "fresh")
            {
                foreach (var file in Directory.GetFiles(Path.Combine(Root, "tests/fixtures/databases", era), "workspace.db*")) File.Copy(file, Path.Combine(scratch, Path.GetFileName(file)));
                File.WriteAllText(Path.Combine(scratch, Store.IsolationMarker), Store.IsolationDeclaration);
            }
            var corpus = (Dictionary<string, object?>)PersistedJson.Parse(File.ReadAllText(Path.Combine(Root, "tests/p2/action-vectors.json")))!;
            var scenario = ((List<object?>)corpus["cases"]!).Cast<Dictionary<string, object?>>().Single(item => Equals(item["era"], era));
            await using var loop = new RuntimeLoop(); Store? owned = null;
            await loop.Invoke(() =>
            {
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), () => DateTimeOffset.Parse((string)corpus["stamp"]!, System.Globalization.CultureInfo.InvariantCulture)); owned = store;
                foreach (var task in ((List<object?>)corpus["tasks"]!).Cast<Dictionary<string, object?>>()) store.SaveTask(task);
                foreach (var statement in ((List<object?>)corpus["statements"]!).Cast<Dictionary<string, object?>>())
                {
                    if (Equals(statement.GetValueOrDefault("current"), true) && store.SchemaVersion < 5) continue;
                    // Fixture SQL has only positional placeholders; JSON remains
                    // parameter data, never SQL text. Production uses named binds.
                    var sql = (string)statement["sql"]!; var parts = sql.Split('?');
                    var named = parts[0]; for (var n = 1; n < parts.Length; n++) named += "$p" + (n - 1) + parts[n];
                    var values = ((List<object?>)statement["values"]!).ToArray(); Assert.Equal(values.Length, parts.Length - 1); store.Execute(named, values);
                }
                string Snapshot()
                {
                    string[] tables = store.SchemaVersion >= 5 ? ["tasks", "intents", "events", "agent_runs", "validation_evidence", "automation_drafts"] : ["tasks", "intents", "events"];
                    return JsJson.Stringify(tables.ToDictionary(table => table, table => store.Rows("SELECT * FROM " + table + " ORDER BY rowid")))!;
                }
                var before = Snapshot(); var steps = ((List<object?>)scenario["steps"]!).Cast<Dictionary<string, object?>>().ToArray(); Assert.True(steps.Length >= 10);
                foreach (var step in steps)
                {
                    Assert.Equal(JsJson.Stringify(step["value"]), JsJson.Stringify(store.ActionPage((Dictionary<string, object?>)step["params"]!)));
                    Assert.Equal(before, Snapshot());
                }
                return Task.FromResult(0);
            });
            Assert.Throws<InvalidOperationException>(() => owned!.ActionPage(new()));
        }
        finally { Directory.Delete(scratch, true); }
    }
}
