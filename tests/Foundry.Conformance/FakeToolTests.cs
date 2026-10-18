using Foundry.Protocol;
using Foundry.Providers;
using Xunit;

namespace Foundry.Conformance;

/// <summary>The offline provider's tool stages against the committed Node events (tests/p2/fake-tools.test.ts).</summary>
public sealed class FakeToolTests
{
    private const string Corpus = "tests/p2/fake-tool-vectors.json";

    public static IEnumerable<object[]> Cases()
    {
        var corpus = (Dictionary<string, object?>)PersistedJson.Parse(File.ReadAllText(Path.Combine(RepositoryFixture.Root, Corpus)))!;
        foreach (var item in ((List<object?>)corpus["cases"]!).Cast<Dictionary<string, object?>>()) yield return [(string)item["name"]!, JsJson.Stringify(item)!];
    }

    [Fact]
    public void VectorsAreBoundToTheProviderSources() => RepositoryFixture.AssertOracleSources(RepositoryFixture.ReadCorpus(Corpus));

    [Theory, MemberData(nameof(Cases))]
    public async Task ToolStagesMatchCommittedNodeEventsAndErrors(string name, string json)
    {
        Assert.NotEmpty(name);
        var item = (Dictionary<string, object?>)PersistedJson.Parse(json)!;
        var input = (Dictionary<string, object?>)item["input"]!;
        var messages = ((List<object?>)input["messages"]!).Cast<Dictionary<string, object?>>().Select(message => new ProviderMessage((string)message["role"]!, (string)message["content"]!)).ToArray();
        var state = input.GetValueOrDefault("continuation") as Dictionary<string, object?>;
        var tools = (input.GetValueOrDefault("tools") as List<object?>)?.Cast<string>().ToArray();
        var results = (input.GetValueOrDefault("toolResults") as List<object?>)?.Cast<Dictionary<string, object?>>()
            .Select(result => new ProviderToolResult((string)result["id"]!, (string)result["name"]!, (string)result["content"]!, (bool)result["isError"]!)).ToArray();
        var request = new ProviderRequest(messages, state is null ? null : new ProviderContinuation((string)state["apiKind"]!, state["data"]), tools, results);
        var next = 1;
        var provider = new FakeChatProvider(id: () => Guid.Parse($"55555555-0000-4000-8000-{next++:000000000000}"));
        using var cancelled = new CancellationTokenSource();
        if (Equals(input.GetValueOrDefault("abortBefore"), true)) cancelled.Cancel();
        var events = new List<object?>(); string? error = null; var texts = 0;
        try
        {
            await foreach (var value in provider.StreamTurn(request, cancelled.Token))
            {
                events.Add(value);
                if (value is ProviderText && input.GetValueOrDefault("cancelAfterTexts") is double count && ++texts == count) cancelled.Cancel();
            }
        }
        catch (InvalidOperationException caught) { error = caught.Message; }
        catch (OperationCanceledException caught) { error = caught.Message; }
        Assert.Equal(JsJson.Stringify(item["expected"]), JsJson.Stringify(new Dictionary<string, object?> { ["events"] = events, ["error"] = error }));
    }
}
