using System.Globalization;
using System.Text.Json;
using Foundry.Protocol;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

public sealed class ContractTests
{
    [Theory]
    [InlineData("2026-01-01T00:00:00+15:00", "2025-12-31T09:00:00.000Z")]
    [InlineData("2026-01-01T00:00:00-23:59", "2026-01-01T23:59:00.000Z")]
    [InlineData("0000-01-01T00:00:00+23:59", "-000001-12-31T00:01:00.000Z")]
    [InlineData("9999-12-31T23:59:59.9999-23:59", "+010000-01-01T23:58:59.999Z")]
    [InlineData("0000-02-29T12:00:00.123456789Z", "0000-02-29T12:00:00.123Z")]
    public void IsoNormalizationMatchesNodeBeyondDotnetTimestampRange(string timestamp, string expected)
    {
        var value = (Dictionary<string, object?>)Contracts.Validate("rpc usage.summary", new Dictionary<string, object?> { ["filters"] = new Dictionary<string, object?> { ["from"] = timestamp } })!;
        Assert.Equal(expected, ((Dictionary<string, object?>)value["filters"]!)["from"]);
    }

    [Theory]
    [InlineData("http:example.com", true), InlineData("https:\\example.com", true), InlineData("http://0x7f000001", true), InlineData("http://127.1", true), InlineData("http://0177.0.0.1", true), InlineData("http://[::1]", true), InlineData("https://bücher.example", true), InlineData("https://@example.com", true), InlineData("http://.", true)]
    [InlineData("http://1.2.3.256", false), InlineData("http://0x100000000", false), InlineData("http://1..2", false), InlineData("http://[::1%25eth0]", false), InlineData("http://example.com:65536", false), InlineData("http://%00.com", false), InlineData("https://user@example.com", false), InlineData("file:///tmp/fixture", false)]
    public void HttpSpecialUrlAcceptance(string url, bool accepted)
    {
        var input = new Dictionary<string, object?> { ["kind"] = "navigate", ["tabId"] = "00000000-0000-4000-8000-000000000002", ["url"] = url };
        Assert.Equal(accepted, Record.Exception(() => Contracts.Validate("bridge workspace:browser", input)) is null);
    }
    [Theory]
    [InlineData("Pacific Standard Time", false)]
    [InlineData("America/New_York", true)]
    [InlineData("us/eastern", true)]
    [InlineData("UTC", true)]
    [InlineData("GMT", true)]
    [InlineData("+05:30", true)]
    [InlineData("-2359", true)]
    [InlineData("+05", true)]
    [InlineData("+24:00", false)]
    public void Ecma402TimeZoneNamespace(string zone, bool accepted)
    {
        var input = new Dictionary<string, object?> { ["timeZone"] = zone };
        if (accepted) Contracts.Validate("rpc usage.summary", input);
        else Assert.Throws<JsonException>(() => Contracts.Validate("rpc usage.summary", input));
    }

    private static string Root
    {
        get
        {
            var directory = new DirectoryInfo(AppContext.BaseDirectory);
            while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "Foundry.slnx"))) directory = directory.Parent;
            return directory?.FullName ?? throw new InvalidOperationException("Missing committed test data.");
        }
    }

    internal static JsonDocument Golden(string name) => JsonDocument.Parse(File.ReadAllBytes(Path.Combine(Root, "tests", "golden", "data", name + ".json")));

    internal static object? Decode(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Array) return value.EnumerateArray().Select(Decode).ToList();
        if (value.ValueKind != JsonValueKind.Object) return JsJson.FromElement(value);
        if (value.TryGetProperty("$undefined", out _)) return Undefined.Value;
        if (value.TryGetProperty("$number", out var number)) return number.GetString() switch
        {
            "-0" => -0d, "NaN" => double.NaN, "Infinity" => double.PositiveInfinity, "-Infinity" => double.NegativeInfinity,
            _ => throw new InvalidOperationException("Unknown number tag.")
        };
        if (value.TryGetProperty("$utf16", out var units)) return new string(units.EnumerateArray().Select(unit => (char)unit.GetInt32()).ToArray());
        if (value.TryGetProperty("$repeat", out var repeat)) return string.Concat(Enumerable.Repeat((string)Decode(repeat[0])!, repeat[1].GetInt32()));
        if (value.TryGetProperty("$object", out var ordered)) return ordered.EnumerateArray().ToDictionary(pair => pair[0].GetString()!, pair => Decode(pair[1]), StringComparer.Ordinal);
        return value.EnumerateObject().ToDictionary(p => p.Name, p => Decode(p.Value), StringComparer.Ordinal);
    }

    public static IEnumerable<object[]> Corpus()
    {
        using var golden = Golden("rpc-corpus");
        foreach (var schema in golden.RootElement.GetProperty("content").EnumerateArray())
            foreach (var item in schema.GetProperty("cases").EnumerateArray()) yield return [schema.GetProperty("schema").GetString()!, item.GetProperty("name").GetString()!, item.GetRawText()];
    }

    [Theory, MemberData(nameof(Corpus))]
    public void MatchesCommittedContract(string schema, string name, string json)
    {
        _ = name;
        using var document = JsonDocument.Parse(json);
        var item = document.RootElement;
        object? actual = null;
        var error = Record.Exception(() => actual = Contracts.Validate(schema, Decode(item.GetProperty("input"))));
        if (!item.GetProperty("accepted").GetBoolean()) Assert.IsType<JsonException>(error);
        else
        {
            Assert.Null(error);
            Assert.Equal(JsJson.Stringify(Decode(item.GetProperty("output"))), JsJson.Stringify(actual));
        }
    }

    [Fact]
    public void InventoryHasNoMissingOrUnexpectedContract()
    {
        using var golden = Golden("rpc-corpus");
        Assert.Equal(Contracts.Names.Order(), golden.RootElement.GetProperty("content").EnumerateArray().Select(s => s.GetProperty("schema").GetString()!).Order());
        Assert.Equal(89, Contracts.Names.Count(name => name.StartsWith("rpc ", StringComparison.Ordinal)));
        Assert.Equal(5, Contracts.Names.Count(name => name.StartsWith("frame ", StringComparison.Ordinal) && name is not "frame rpc request" and not "frame rpc response"));
    }

    [Fact]
    public void JavascriptSerializationMatchesGoldenVectors()
    {
        using var golden = Golden("jsjson");
        foreach (var item in golden.RootElement.GetProperty("content").EnumerateArray())
        {
            var expected = Decode(item.GetProperty("output"));
            Assert.Equal(expected is Undefined ? null : (string?)expected, JsJson.Stringify(Decode(item.GetProperty("input"))));
        }
    }

    [Fact]
    public void ClockAlwaysUsesUtcMilliseconds() => Assert.Equal("2026-10-12T12:34:56.123Z", Clock.Iso(DateTimeOffset.Parse("2026-10-12T07:34:56.123987-05:00", CultureInfo.InvariantCulture)));

    [Fact]
    public void StrictWireEntryPointsMatchApprovedDifferentials()
    {
        using var golden = Golden("rpc-wire");
        foreach (var item in golden.RootElement.GetProperty("content").EnumerateArray())
        {
            var text = (string)Decode(item.GetProperty("text"))!;
            var accepted = item.GetProperty("host").GetString() == "accept";
            Assert.Equal(accepted, Record.Exception(() => WireJson.Request(WireJson.Parse(text))) is null);
            Assert.Equal(accepted, Record.Exception(() => WireJson.Request(WireJson.Parse(System.Text.Encoding.UTF8.GetBytes(text)))) is null);
        }
    }

    [Fact]
    public void RedactionMatchesCommittedVectors()
    {
        using var golden = Golden("redaction");
        var content = golden.RootElement.GetProperty("content");
        var redactor = new Redactor();
        foreach (var secret in content.GetProperty("secrets").EnumerateArray()) redactor.Add(secret.GetString()!);
        foreach (var item in content.GetProperty("cases").EnumerateArray()) Assert.Equal(item.GetProperty("output").GetString(), redactor.Text(item.GetProperty("input").GetString()!));
    }

    [Fact]
    public void SupportingCompatibilityVectorsMatch()
    {
        using var profiles = Golden("profile-fingerprint");
        foreach (var item in profiles.RootElement.GetProperty("content").EnumerateArray())
        {
            var profile = (Dictionary<string, object?>)Decode(item.GetProperty("profile"))!;
            Assert.Equal(item.GetProperty("runtime").GetString(), Compatibility.ProfileFingerprint(profile));
            var expected = item.GetProperty("provider");
            if (expected.ValueKind == JsonValueKind.String) Assert.Equal(expected.GetString(), Compatibility.ProviderProfileFingerprint(profile));
            else Assert.Equal(expected.GetProperty("error").GetString(), Assert.Throws<ArgumentException>(() => Compatibility.ProviderProfileFingerprint(profile)).Message);
        }
        using var manifests = Golden("manifest");
        foreach (var item in manifests.RootElement.GetProperty("content").EnumerateArray())
        {
            var sorted = Compatibility.SortManifest((List<object?>)Decode(item.GetProperty("entries"))!);
            Assert.Equal(JsJson.Stringify(Decode(item.GetProperty("sorted"))), JsJson.Stringify(sorted));
            Assert.Equal(item.GetProperty("sha256").GetString(), Compatibility.Hash(sorted));
        }
        using var mcp = Golden("mcp-config");
        var redactor = new Redactor(); redactor.Add("registered-mcp-secret");
        foreach (var item in mcp.RootElement.GetProperty("content").EnumerateArray())
        {
            var error = Record.Exception(() => Compatibility.CheckMcp(Decode(item.GetProperty("config")), redactor));
            Assert.Equal(item.GetProperty("accepted").GetBoolean(), error is null);
            if (error is McpConfigurationException) Assert.Equal(item.GetProperty("error").GetString(), error.Message);
        }
    }
}
