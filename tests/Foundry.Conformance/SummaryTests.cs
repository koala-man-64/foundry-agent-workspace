using System.Text.Json;
using Foundry.Protocol;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

public sealed class SummaryTests
{
    private static string Root
    {
        get
        {
            var root = new DirectoryInfo(AppContext.BaseDirectory);
            while (root is not null && !File.Exists(Path.Combine(root.FullName, "Foundry.slnx"))) root = root.Parent;
            return root!.FullName;
        }
    }
    public static IEnumerable<object[]> Cases()
    {
        using var vectors = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(Root, "tests/p1/summary-vectors.json")));
        foreach (var item in vectors.RootElement.EnumerateArray()) yield return [item.GetProperty("name").GetString()!, item.GetRawText()];
    }
    [Theory, MemberData(nameof(Cases))]
    public async Task SummaryMatchesTypeScript(string name, string json)
    {
        Assert.NotEmpty(name);
        using var item = JsonDocument.Parse(json);
        var scratch = Directory.CreateTempSubdirectory("foundry-p1-summary-").FullName;
        try
        {
            if (item.RootElement.TryGetProperty("era", out var era))
            {
                foreach (var file in Directory.GetFiles(Path.Combine(Root, "tests/fixtures/databases", era.GetString()!), "workspace.db*")) File.Copy(file, Path.Combine(scratch, Path.GetFileName(file)));
                File.WriteAllText(Path.Combine(scratch, Store.IsolationMarker), Store.IsolationDeclaration);
            }
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"));
                // Era databases retain synthetic paths from their generator's machine.
                // Materialize private project directories in this disposable copy;
                // normalize only their paths back to the committed wire expectations.
                var projectPaths = new Dictionary<string, string>(StringComparer.Ordinal);
                Assert.True(Foundry.Platform.FinalPath.TryResolve(scratch, out var scratchCanonical));
                if (item.RootElement.TryGetProperty("era", out _) && store.SchemaVersion >= 3)
                {
                    foreach (var row in store.Rows("SELECT id,data FROM projects"))
                    {
                        using var document = JsonDocument.Parse((string)row["data"]!);
                        var project = (Dictionary<string, object?>)JsJson.FromElement(document.RootElement)!;
                        var relative = Path.Combine("projects", projectPaths.Count.ToString(System.Globalization.CultureInfo.InvariantCulture));
                        var folder = Directory.CreateDirectory(Path.Combine(scratch, relative)).FullName;
                        Assert.True(Foundry.Platform.FinalPath.TryResolve(folder, out var canonical));
                        Assert.Equal(relative, Path.GetRelativePath(scratchCanonical, canonical));
                        projectPaths.Add(canonical, (string)project["path"]!);
                        project["path"] = canonical;
                        store.Execute("UPDATE projects SET data=$p0 WHERE id=$p1", JsJson.Stringify(project), row["id"]);
                    }
                }
                foreach (var statement in item.RootElement.GetProperty("setup").EnumerateArray()) store.Execute(statement.GetProperty("sql").GetString()!, statement.GetProperty("values").EnumerateArray().Select(JsJson.FromElement).ToArray());
                if (item.RootElement.TryGetProperty("error", out var error)) Assert.Equal(error.GetString(), Assert.Throws<WorkspaceReadException>(() => store.Summary()).Message);
                else
                {
                    var summary = store.Summary();
                    foreach (var value in (List<object?>)summary["projects"]!)
                    {
                        var project = (Dictionary<string, object?>)value!;
                        if (projectPaths.TryGetValue((string)project["path"]!, out var original)) project["path"] = original;
                    }
                    Assert.Equal(JsJson.Stringify(JsJson.FromElement(item.RootElement.GetProperty("expected"))), JsJson.Stringify(summary));
                    if (projectPaths.Count > 0)
                    {
                        var missing = projectPaths.First().Key;
                        Assert.StartsWith(scratchCanonical + Path.DirectorySeparatorChar, missing, StringComparison.OrdinalIgnoreCase);
                        Directory.Delete(missing);
                        var unavailable = ((List<object?>)store.Summary()["projects"]!).Cast<Dictionary<string, object?>>().Single(project => (string)project["path"]! == missing);
                        Assert.Equal("unavailable", unavailable["kind"]);
                        Assert.Equal("Folder is unavailable.", unavailable["unavailableReason"]);
                    }
                }
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }
}
