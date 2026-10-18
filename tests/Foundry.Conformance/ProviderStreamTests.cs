using Foundry.Protocol;
using Foundry.Providers;
using Xunit;

namespace Foundry.Conformance;

/// <summary>
/// The Responses and Anthropic parsers against the committed Node outcomes (tests/p2/provider-streams.test.ts), through the
/// recording handler of <see cref="ProviderTransportTests"/>. A case with a follow-up builds the next request from native's
/// own continuation and a result for each of its calls, and must send TypeScript's body byte for byte.
/// </summary>
public sealed class ProviderStreamTests
{
    private const string Corpus = "tests/p2/provider-stream-vectors.json";

    public static IEnumerable<object[]> Cases()
    {
        var corpus = (Dictionary<string, object?>)PersistedJson.Parse(File.ReadAllText(Path.Combine(RepositoryFixture.Root, Corpus)))!;
        foreach (var item in ((List<object?>)corpus["cases"]!).Cast<Dictionary<string, object?>>()) yield return [(string)item["name"]!, JsJson.Stringify(item)!];
    }

    [Fact]
    public void VectorsAreBoundToTheProviderSources() => RepositoryFixture.AssertOracleSources(RepositoryFixture.ReadCorpus(Corpus));

    [Theory, MemberData(nameof(Cases))]
    public async Task StreamsAndTheirNextRequestsMatchCommittedNodeOutcomes(string name, string json)
    {
        Assert.NotEmpty(name);
        var item = (Dictionary<string, object?>)PersistedJson.Parse(json)!;
        var input = (Dictionary<string, object?>)item["input"]!;
        var expected = (Dictionary<string, object?>)item["expected"]!;
        var outcome = await ProviderTransportTests.Run(input, Requests(expected.GetValueOrDefault("requests")));
        var actual = new Dictionary<string, object?> { ["requests"] = outcome.Requests, ["events"] = outcome.Events, ["error"] = outcome.Error };
        if (input.GetValueOrDefault("followUp") is Dictionary<string, object?> followUp && outcome.Events.OfType<ProviderDone>().FirstOrDefault()?.Continuation is { } continuation)
        {
            var calls = ((List<object?>)((Dictionary<string, object?>)continuation.Data!)["calls"]!).Cast<Dictionary<string, object?>>().ToList();
            var errors = Equals(followUp.GetValueOrDefault("errors"), true);
            var next = new Dictionary<string, object?>
            {
                ["kind"] = input["kind"], ["tools"] = input.GetValueOrDefault("tools", Undefined.Value), ["messages"] = followUp["messages"],
                ["continuation"] = new Dictionary<string, object?> { ["apiKind"] = continuation.ApiKind, ["data"] = continuation.Data },
                ["response"] = new Dictionary<string, object?> { ["status"] = 400d, ["body"] = new List<object?>() }, ["credential"] = "{credential}",
                ["toolResults"] = calls.Select((call, position) => (object?)new Dictionary<string, object?>
                {
                    ["id"] = call["id"], ["name"] = call["name"],
                    ["content"] = errors && position % 2 == 1 ? "User rejected this action." : JsJson.Stringify(new Dictionary<string, object?> { ["ok"] = true, ["position"] = (double)position }),
                    ["isError"] = errors && position % 2 == 1,
                }).ToList(),
            };
            if (next["tools"] is Undefined) next.Remove("tools");
            actual["followUp"] = (await ProviderTransportTests.Run(next, Requests(expected.GetValueOrDefault("followUp")))).Requests;
        }
        Assert.Equal(JsJson.Stringify(expected), JsJson.Stringify(actual));
    }

    private static List<Dictionary<string, object?>> Requests(object? value) => (value as List<object?>)?.Cast<Dictionary<string, object?>>().ToList() ?? [];
}
