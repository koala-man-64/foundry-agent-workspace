using System.Text;
using System.Text.Json;
using Xunit;

namespace Foundry.Protocol.Tests;

/// <summary>
/// Spike S8b: every JSON text in tests/golden/data/rpc-wire.json, where JSON.parse and a strict reader can disagree,
/// produces the decided host behavior on both trust-boundary paths (bridge strings and stdio bytes).
/// </summary>
public sealed class WireParsingTests
{
    private static readonly string[] Decisions = ["accept", "reject"];

    public static TheoryData<string> CaseNames => new(Cases.Keys.Order(StringComparer.Ordinal));

    private static Dictionary<string, (string Text, string Host)> Cases { get; } = LoadCases();

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void BridgeStringsGetTheDecidedOutcome(string name)
    {
        var (text, host) = Cases[name];
        AssertOutcome(name, host, () => Read(CandidateJson.FromText<RpcEnvelope>(text)));
    }

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void StdioLinesGetTheDecidedOutcome(string name)
    {
        var (text, host) = Cases[name];
        AssertOutcome(name, host, () => Read(CandidateJson.FromLine<RpcEnvelope>(Encoding.UTF8.GetBytes(text))));
    }

    [Fact]
    public void ByteOrderMarkRejectionDoesNotDependOnTheReadApi()
    {
        var line = Encoding.UTF8.GetPreamble().Concat(Encoding.UTF8.GetBytes("""{"jsonrpc":"2.0","id":"1","method":"task.cancel","params":{"taskId":"x"}}""")).ToArray();
        // The span reader rejects a leading BOM, as JSON.parse does...
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<RpcEnvelope>(line, CandidateJson.Options));
        // ...but stream reads skip a UTF-8 BOM, so the framing check keeps the rule independent of the read API.
        using (var stream = new MemoryStream(line))
        {
            Assert.NotNull(JsonSerializer.Deserialize<RpcEnvelope>(stream, CandidateJson.Options));
        }
        Assert.Throws<JsonException>(() => CandidateJson.FromLine<RpcEnvelope>(line));
    }

    [Fact]
    public void EveryWireCaseHasADecision()
    {
        Assert.All(Cases, item => Assert.Contains(item.Value.Host, Decisions));
    }

    // Typed parameter reads trigger the per-field rules: unknown properties, integer spelling, malformed UTF-16.
    private static object Read(RpcEnvelope envelope) => envelope.Method switch
    {
        "task.cancel" => envelope.Params.Deserialize<TaskIdentity>(CandidateJson.Options)!,
        "task.compact" => envelope.Params.Deserialize<CompactParams>(CandidateJson.Options)!,
        "task.send" => envelope.Params.Deserialize<SendParams>(CandidateJson.Options)!,
        "task.retire" => envelope.Params.Deserialize<RetireParams>(CandidateJson.Options)!,
        _ => throw new JsonException($"Unsupported method {envelope.Method}."),
    };

    private static void AssertOutcome(string name, string host, Func<object> read)
    {
        Exception? failure = null;
        try { read(); }
        catch (Exception exception) when (exception is JsonException or InvalidOperationException) { failure = exception; }
        if (string.Equals(host, "accept", StringComparison.Ordinal))
        {
            Assert.True(failure is null, $"{name}: expected acceptance, got {failure?.GetType().Name}: {failure?.Message}");
        }
        else
        {
            Assert.True(failure is not null, $"{name}: expected rejection, but the strict reader accepted it.");
        }
    }

    private static Dictionary<string, (string Text, string Host)> LoadCases()
    {
        var path = Path.Combine(RepositoryRoot(), "tests", "golden", "data", "rpc-wire.json");
        using var document = JsonDocument.Parse(File.ReadAllBytes(path));
        return document.RootElement.GetProperty("content").EnumerateArray().ToDictionary(
            item => item.GetProperty("name").GetString()!,
            item => (item.GetProperty("text").GetString()!, item.GetProperty("host").GetString()!),
            StringComparer.Ordinal);
    }

    private static string RepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "Foundry.slnx")))
            {
                return directory.FullName;
            }
        }
        throw new InvalidOperationException("Foundry.slnx was not found above the test output directory.");
    }
}
