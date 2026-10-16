using System.Globalization;
using Foundry.Protocol;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

public sealed class WorkspacePageTests
{
    private static string Root
    {
        get
        {
            for (var root = new DirectoryInfo(AppContext.BaseDirectory); root is not null; root = root.Parent)
                if (File.Exists(Path.Combine(root.FullName, "Foundry.slnx"))) return root.FullName;
            throw new InvalidOperationException("Missing workspace page corpus.");
        }
    }

    [Theory]
    [InlineData("fresh"), InlineData("v1"), InlineData("v2"), InlineData("v3"), InlineData("v4"), InlineData("v5"), InlineData("v5-wal")]
    public async Task WorkspacePagesMatchNodeAndNeverRewriteRetainedRows(string era)
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-pages-").FullName;
        try
        {
            if (era != "fresh")
            {
                foreach (var file in Directory.GetFiles(Path.Combine(Root, "tests/fixtures/databases", era), "workspace.db*")) File.Copy(file, Path.Combine(scratch, Path.GetFileName(file)));
                File.WriteAllText(Path.Combine(scratch, Store.IsolationMarker), Store.IsolationDeclaration);
            }
            var corpus = (Dictionary<string, object?>)PersistedJson.Parse(File.ReadAllText(Path.Combine(Root, "tests/p2/workspace-page-vectors.json")))!;
            var timestamp = DateTimeOffset.Parse((string)corpus["timestamp"]!, CultureInfo.InvariantCulture);
            var scenario = ((List<object?>)corpus["cases"]!).Cast<Dictionary<string, object?>>().Single(item => Equals(item["era"], era));
            var steps = ((List<object?>)scenario["steps"]!).Cast<Dictionary<string, object?>>().ToArray(); Assert.True(steps.Length >= 50);
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), () => timestamp);
                var projectPaths = new Dictionary<string, string>(StringComparer.Ordinal);
                Assert.True(Foundry.Platform.FinalPath.TryResolve(scratch, out var scratchCanonical));
                if (store.SchemaVersion >= 3) foreach (var row in store.Rows("SELECT id,data FROM projects"))
                {
                    var project = (Dictionary<string, object?>)PersistedJson.Parse((string)row["data"]!)!;
                    var relative = Path.Combine("projects", projectPaths.Count.ToString(CultureInfo.InvariantCulture));
                    var folder = Directory.CreateDirectory(Path.Combine(scratch, relative)).FullName;
                    Assert.True(Foundry.Platform.FinalPath.TryResolve(folder, out var canonical));
                    Assert.Equal(relative, Path.GetRelativePath(scratchCanonical, canonical));
                    projectPaths.Add(canonical, (string)project["path"]!); project["path"] = canonical;
                    store.Execute("UPDATE projects SET data=$p0 WHERE id=$p1", JsJson.Stringify(project), row["id"]);
                }
                foreach (var task in ((List<object?>)corpus["tasks"]!).Cast<Dictionary<string, object?>>()) store.SaveTask(task);
                foreach (var profile in ((List<object?>)corpus["profiles"]!).Cast<Dictionary<string, object?>>()) store.SaveProfile(profile);
                foreach (var row in ((List<object?>)corpus["eventRows"]!).Cast<Dictionary<string, object?>>()) store.Execute("INSERT INTO events(type,task_id,data,created_at) VALUES($p0,$p1,$p2,$p3)", row["type"], row["taskId"], row["data"], (string)corpus["timestamp"]!);
                string Snapshot() => JsJson.Stringify(new { tasks = store.Rows("SELECT * FROM tasks ORDER BY rowid"), events = store.Rows("SELECT * FROM events ORDER BY sequence"), profiles = store.Rows("SELECT * FROM profiles ORDER BY rowid") })!;
                var before = Snapshot();
                foreach (var step in steps)
                {
                    var method = (string)step["method"]!; var p = (Dictionary<string, object?>)Contracts.Validate("rpc " + method, step["params"])!;
                    object? value = null; string? error = null;
                    var limit = p.TryGetValue("limit", out var count) ? Convert.ToInt32(count, CultureInfo.InvariantCulture) : 50;
                    try
                    {
                        value = method switch
                        {
                            "workspace.profiles" => store.ProfilePage((string?)p.GetValueOrDefault("after"), limit),
                            "workspace.projects" => store.ProjectPage((string?)p.GetValueOrDefault("after"), limit),
                            "profile.read" => store.ProfileRead((string)p["profileId"]!),
                            "workspace.tasks" => store.TaskPage(p),
                            "workspace.events" => store.EventPage(Convert.ToInt64(p["after"], CultureInfo.InvariantCulture), limit, (string?)p.GetValueOrDefault("taskId")),
                            "task.timeline" => store.TimelinePage((string)p["taskId"]!, p.TryGetValue("before", out var boundary) ? Convert.ToInt64(boundary, CultureInfo.InvariantCulture) : null, limit),
                            _ => throw new NotSupportedException("Missing query coverage.")
                        };
                    }
                    catch (InvalidOperationException exception) { error = exception.Message; }
                    if (method == "workspace.projects" && value is Dictionary<string, object?> page)
                        foreach (var project in ((List<object?>)page["projects"]!).Cast<Dictionary<string, object?>>())
                            if (projectPaths.TryGetValue((string)project["path"]!, out var original)) project["path"] = original;
                    Assert.Equal(JsJson.Stringify(step["value"]), JsJson.Stringify(value)); Assert.Equal(step["error"], error);
                    Assert.Equal(before, Snapshot());
                }
                if (projectPaths.Count > 0)
                {
                    var missing = projectPaths.Keys.First(); Assert.Equal(Path.Combine("projects", "0"), Path.GetRelativePath(scratchCanonical, missing));
                    Directory.Delete(missing, true);
                    var unavailable = ((List<object?>)store.ProjectPage()["projects"]!).Cast<Dictionary<string, object?>>().Single(project => Equals(project["path"], missing));
                    Assert.Equal("unavailable", unavailable["kind"]); Assert.Equal("Folder is unavailable.", unavailable["unavailableReason"]);
                    Assert.Equal(before, Snapshot());
                }
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }
}
