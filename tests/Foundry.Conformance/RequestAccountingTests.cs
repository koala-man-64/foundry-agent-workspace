using Foundry.Protocol;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

public sealed class RequestAccountingTests
{
    private static string Root
    {
        get
        {
            for (var root = new DirectoryInfo(AppContext.BaseDirectory); root is not null; root = root.Parent)
                if (File.Exists(Path.Combine(root.FullName, "Foundry.slnx"))) return root.FullName;
            throw new InvalidOperationException("Missing accounting corpus.");
        }
    }
    public static IEnumerable<object[]> Cases()
    {
        var corpus = (List<object?>)PersistedJson.Parse(File.ReadAllText(Path.Combine(Root, "tests/p2/request-accounting-vectors.json")))!;
        foreach (var item in corpus.Cast<Dictionary<string, object?>>()) yield return [(string)item["name"]!, JsJson.Stringify(item)!];
    }
    [Theory, MemberData(nameof(Cases))]
    public void ContextReservationsAndProviderMeasurementsMatchNode(string name, string json)
    {
        Assert.NotEmpty(name);
        var item = (Dictionary<string, object?>)PersistedJson.Parse(json)!;
        var value = (Dictionary<string, object?>)item["value"]!;
        Dictionary<string, object?> actual;
        try
        {
            object? result = (string)item["operation"]! switch
            {
                "estimateContext" => RequestAccounting.EstimateContext(value),
                "estimateRequest" => RequestAccounting.EstimateRequest(value),
                "reserveRequest" => RequestAccounting.ReserveRequest((Dictionary<string, object?>)item["task"]!, value),
                "measuredUsage" => RequestAccounting.MeasuredUsage(value),
                _ => throw new NotSupportedException("Unknown accounting operation.")
            };
            actual = new() { ["value"] = result };
        }
        catch (InvalidOperationException error) { actual = new() { ["error"] = error.Message }; }
        Assert.Equal(JsJson.Stringify(item["expected"]), JsJson.Stringify(actual));
    }
    [Theory]
    [InlineData(double.NaN), InlineData(double.PositiveInfinity), InlineData(double.NegativeInfinity)]
    public void NonFiniteInjectedMeasurementsNeverBecomeKnownUsage(double invalid)
    {
        Assert.Null(RequestAccounting.MeasuredUsage(new Dictionary<string, object?> { ["inputTokens"] = invalid, ["outputTokens"] = 0d }));
        var normalized = RequestAccounting.MeasuredUsage(new Dictionary<string, object?> { ["inputTokens"] = 10d, ["outputTokens"] = 5d, ["cacheReadTokens"] = invalid });
        Assert.NotNull(normalized); Assert.IsType<Undefined>(normalized["cacheReadTokens"]);
    }
}
