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
                foreach (var statement in item.RootElement.GetProperty("setup").EnumerateArray()) store.Execute(statement.GetProperty("sql").GetString()!, statement.GetProperty("values").EnumerateArray().Select(JsJson.FromElement).ToArray());
                if (item.RootElement.TryGetProperty("error", out var error)) Assert.Equal(error.GetString(), Assert.Throws<WorkspaceReadException>(() => store.Summary()).Message);
                else Assert.Equal(JsJson.Stringify(JsJson.FromElement(item.RootElement.GetProperty("expected"))), JsJson.Stringify(store.Summary()));
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }
}
