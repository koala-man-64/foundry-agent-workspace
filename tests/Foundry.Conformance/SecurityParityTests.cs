using System.Text.Json;
using Foundry.Protocol;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

public sealed class SecurityParityTests
{
    private static string Root
    {
        get
        {
            for (var root = new DirectoryInfo(AppContext.BaseDirectory); root is not null; root = root.Parent)
                if (File.Exists(Path.Combine(root.FullName, "Foundry.slnx"))) return root.FullName;
            throw new InvalidOperationException("Missing policy corpus.");
        }
    }
    public static IEnumerable<object[]> Cases()
    {
        using var corpus = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(Root, "tests/p2/security-vectors.json")));
        foreach (var entry in corpus.RootElement.EnumerateArray()) yield return [entry.GetProperty("name").GetString()!, entry.GetRawText()];
    }
    [Theory, MemberData(nameof(Cases))]
    public void PoliciesMatchCommittedNodeOutcomes(string name, string json)
    {
        Assert.NotEmpty(name);
        var item = (Dictionary<string, object?>)PersistedJson.Parse(json)!;
        var args = (List<object?>)item["arguments"]!;
        static string[] Strings(object? value) => ((List<object?>)value!).Cast<string>().ToArray();
        Dictionary<string, string[]> Edges() => ((List<object?>)args[0]!).Cast<List<object?>>().ToDictionary(pair => (string)pair[0]!, pair => Strings(pair[1]), StringComparer.Ordinal);
        object? Evaluate()
        {
            switch ((string)item["operation"]!)
            {
                case "normalizePath": return ScopePolicy.NormalizePath((string?)args[0], (bool)args[1]!);
                case "normalize": return ScopePolicy.Normalize(Strings(args[0]), (bool)args[1]!);
                case "covers": return ScopePolicy.Covers((string)args[0]!, (string)args[1]!);
                case "inScope": return ScopePolicy.InScope(Strings(args[0]), (string)args[1]!);
                case "overlap": return ScopePolicy.Overlap(Strings(args[0]), Strings(args[1]));
                case "acyclic": ScopePolicy.AssertAcyclic(Edges()); return null;
                case "ordered": return ScopePolicy.Ordered(Edges(), (string)args[1]!, (string)args[2]!);
                case "network": return NetworkPathPolicy.IsNetworkOrDevicePath((string)args[0]!);
                default: throw new ArgumentException("Unknown security operation.");
            }
        }
        Dictionary<string, object?> actual;
        try { actual = new() { ["value"] = Evaluate() }; }
        catch (InvalidOperationException error) { actual = new() { ["error"] = error.Message }; }
        Assert.Equal(JsJson.Stringify(item["expected"]), JsJson.Stringify(actual));
    }
}
