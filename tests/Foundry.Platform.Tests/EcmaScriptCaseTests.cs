using System.Globalization;
using System.Text.Json;
using Xunit;

namespace Foundry.Platform.Tests;

/// <summary>
/// The shipped tables against V8 itself: tests/golden/data/ecmascript-lowercase.json holds toLocaleLowerCase('en-US')
/// results from Node 24 (Unicode 17.0, as in Electron 44) for final-sigma contexts, every mapped code point and random
/// strings with lone surrogates. Those results were computed independently of the tables, so the vectors also check
/// the final-sigma algorithm.
/// </summary>
public sealed class EcmaScriptCaseTests
{
    [Fact]
    public void TheTablesArePinnedToElectron44()
    {
        Assert.Equal("17.0", EcmaScriptCase.UnicodeVersion);
    }

    [Fact]
    public void LowercasesExactlyLikeV8OnEveryGoldenVector()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(Scratch.RepositoryRoot, "tests", "golden", "data", "ecmascript-lowercase.json")));
        var vectors = document.RootElement.GetProperty("content").EnumerateArray().ToList();
        Assert.True(vectors.Count > 1000);
        var mismatches = vectors
            .Select(vector => (Input: Text(vector.GetProperty("input")), Expected: Text(vector.GetProperty("lower"))))
            .Where(vector => !string.Equals(EcmaScriptCase.ToLower(vector.Input), vector.Expected, StringComparison.Ordinal))
            .Select(vector => $"{Units(vector.Input)} -> expected {Units(vector.Expected)}, got {Units(EcmaScriptCase.ToLower(vector.Input))}")
            .ToList();
        Assert.True(mismatches.Count == 0, string.Join(Environment.NewLine, mismatches.Take(20)));
    }

    [Theory]
    [InlineData("", "")]
    [InlineData("C:\\Users\\Foundry", "c:\\users\\foundry")]
    [InlineData("\u00c0\u00de\u00df\u00b5", "\u00e0\u00fe\u00df\u00b5")]
    [InlineData("\u0130stanbul", "i\u0307stanbul")]
    [InlineData("\u0391\u03a3", "\u03b1\u03c2")]
    [InlineData("\u0391\u03a3.txt", "\u03b1\u03c3.txt")]
    [InlineData("\u0391\u03a3\\x", "\u03b1\u03c2\\x")]
    [InlineData("\u03a3", "\u03c3")]
    [InlineData("A\u0301\u03a3", "a\u0301\u03c2")]
    [InlineData("\u212a", "k")]
    [InlineData("\ud801\udc00", "\ud801\udc28")]
    [InlineData("\ua7cb", "\u0264")]
    public void ExplainsTheCasesThatMatter(string input, string expected)
    {
        Assert.Equal(expected, EcmaScriptCase.ToLower(input));
    }

    [Fact]
    public void DotNetLowercasingWouldDisagree()
    {
        // Why FinalPath does not use ToLower(en-US): .NET maps characters one to one and has no final-sigma rule.
        var culture = CultureInfo.GetCultureInfo("en-US");
        Assert.NotEqual(EcmaScriptCase.ToLower("\u0130"), "\u0130".ToLower(culture));
        Assert.NotEqual(EcmaScriptCase.ToLower("\u0391\u03a3"), "\u0391\u03a3".ToLower(culture));
    }

    [Fact]
    public void AnExpandingResultIsComplete()
    {
        Assert.Equal(string.Concat(Enumerable.Repeat("i\u0307", 1000)), EcmaScriptCase.ToLower(new string('\u0130', 1000)));
    }

    /// <summary>A golden string: plain JSON text, or {"$utf16": [code units]} when it holds a lone surrogate.</summary>
    private static string Text(JsonElement element) => element.ValueKind == JsonValueKind.String
        ? element.GetString()!
        : new string(element.GetProperty("$utf16").EnumerateArray().Select(unit => (char)unit.GetInt32()).ToArray());

    private static string Units(string value) => string.Join(' ', value.Select(unit => ((int)unit).ToString("x4", CultureInfo.InvariantCulture)));
}
