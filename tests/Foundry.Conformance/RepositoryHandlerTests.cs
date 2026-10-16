using System.Text.Json;
using Foundry.Protocol;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

/// <summary>Git/files RPC handlers through DevelopmentChat against the committed Node outcomes (tests/p2/repository-handlers.test.ts).</summary>
public sealed class RepositoryHandlerTests
{
    private static readonly JsonElement Corpus = RepositoryFixture.ReadCorpus("tests/p2/repository-handler-vectors.json");
    private static readonly string[] Tables = ["tasks", "task_starts", "intents", "projects", "events", "messages"];

    public static IEnumerable<object[]> Cases()
    {
        var index = 0;
        foreach (var item in Corpus.GetProperty("cases").EnumerateArray()) yield return [item.GetProperty("name").GetString()!, index++];
    }

    [Theory, MemberData(nameof(Cases))]
    public async Task SeededTasksMatchCommittedNodeOutcomesAndLeaveEveryRowUnchanged(string name, int index)
    {
        var item = Corpus.GetProperty("cases")[index];
        Assert.Equal(name, item.GetProperty("name").GetString());
        using var fixture = RepositoryFixture.Create("foundry-p2-handlers-");
        await fixture.Build(item.GetProperty("tree"));
        var data = Directory.CreateDirectory(fixture.Local("data")).FullName;
        await using var loop = new RuntimeLoop();
        var outcomes = await loop.Invoke(async () =>
        {
            using var store = new Store(loop, data, Path.Combine(fixture.Scratch, "injected-root"));
            foreach (var task in item.GetProperty("tasks").EnumerateArray())
                store.SaveTask((Dictionary<string, object?>)PersistedJson.Parse(task.GetRawText().Replace("{scratch}", JsonEncodedText.Encode(fixture.Scratch).ToString(), StringComparison.Ordinal))!);
            string Snapshot() => JsJson.Stringify(Tables.Select(table => store.Rows($"SELECT * FROM {table}")))!;
            var before = Snapshot();
            var chat = new DevelopmentChat(loop, store, fixture.Environment);
            var results = new List<(object? Result, string? Error)>();
            foreach (var call in item.GetProperty("calls").EnumerateArray())
            {
                var parameters = (Dictionary<string, object?>)PersistedJson.Parse(call.GetProperty("params").GetRawText())!;
                try { results.Add((fixture.Normalize(await chat.Dispatch(call.GetProperty("method").GetString()!, parameters)), null)); }
                catch (InvalidOperationException exception) { results.Add((null, (string?)fixture.Normalize(exception.Message))); }
            }
            Assert.Equal(before, Snapshot());
            await chat.Shutdown();
            return results;
        });
        var expected = item.GetProperty("expected");
        Assert.Equal(expected.GetArrayLength(), outcomes.Count);
        for (var call = 0; call < outcomes.Count; call++)
        {
            var outcome = item.TryGetProperty("native", out var native) && native.TryGetProperty(call.ToString(System.Globalization.CultureInfo.InvariantCulture), out var difference)
                ? difference.GetProperty("outcome") : expected[call];
            var (result, error) = outcomes[call];
            if (outcome.TryGetProperty("result", out var value))
            {
                Assert.True(error is null, $"call {call}: {error}");
                var actual = JsonSerializer.SerializeToElement(result);
                Assert.True(JsonElement.DeepEquals(value, actual), $"call {call}: expected {value.GetRawText()}\nactual   {actual.GetRawText()}");
            }
            else if (outcome.TryGetProperty("error", out var message)) Assert.Equal(message.GetString(), error);
            else { Assert.True(outcome.TryGetProperty("systemError", out _)); Assert.NotNull(error); }
        }
    }

    [Fact]
    public void OracleSourceBindingsAreCurrent()
    {
        Assert.Equal(1, Corpus.GetProperty("schemaVersion").GetInt32());
        RepositoryFixture.AssertOracleSources(Corpus);
        foreach (var item in Corpus.GetProperty("cases").EnumerateArray())
            if (item.TryGetProperty("native", out var native))
                foreach (var difference in native.EnumerateObject()) Assert.False(string.IsNullOrWhiteSpace(difference.Value.GetProperty("difference").GetString()));
    }
}
