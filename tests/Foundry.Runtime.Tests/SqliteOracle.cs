using System.Text.Json;

namespace Foundry.Runtime.Tests;

/// <summary>
/// The better-sqlite3 results recorded by tests/golden/sqlite-engine.test.ts, and the normalization that makes C# values
/// comparable with them: every number compares as a JavaScript double, because that is what the TypeScript runtime sees.
/// </summary>
internal sealed class SqliteOracle
{
    private SqliteOracle(JsonElement content) => Content = content;

    public JsonElement Content { get; }

    public static SqliteOracle Load()
    {
        using var stream = File.OpenRead(Path.Combine(Fixtures.GoldenDirectory, "sqlite-engine.json"));
        using var document = JsonDocument.Parse(stream);
        return new SqliteOracle(document.RootElement.GetProperty("content").Clone());
    }

    public IReadOnlyList<string> CompileOptions => Content.GetProperty("engine").GetProperty("compileOptions").EnumerateArray().Select(item => item.GetString()!).ToList();

    public string Version => Content.GetProperty("engine").GetProperty("version").GetString()!;

    public IReadOnlyList<OracleQuery> Queries => Content.GetProperty("queries").EnumerateArray().Select(item => new OracleQuery(
        item.GetProperty("id").GetString()!,
        item.GetProperty("sql").GetString()!,
        item.GetProperty("params").EnumerateArray().Select(ToValue).ToList(),
        item.GetProperty("when").ValueKind == JsonValueKind.Null ? null : item.GetProperty("when").GetString())).ToList();

    /// <summary>Expected results for a fixture, by query id: rows of normalized values, or the SQLite error text.</summary>
    public IReadOnlyDictionary<string, OracleResult> Results(string fixture) =>
        Content.GetProperty("fixtures").GetProperty(fixture).EnumerateArray().ToDictionary(
            item => item.GetProperty("id").GetString()!,
            item => item.TryGetProperty("error", out var error)
                ? new OracleResult(null, error.GetString())
                : new OracleResult(item.GetProperty("rows").EnumerateArray().Select(row => (IReadOnlyList<object?>)row.EnumerateArray().Select(ToValue).ToList()).ToList(), null),
            StringComparer.Ordinal);

    /// <summary>Decode a tagged golden value (tests/golden/encoding.ts) into the normalized comparison form.</summary>
    public static object? ToValue(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.Null => null,
        JsonValueKind.Number => element.GetDouble(),
        JsonValueKind.String => element.GetString(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.Object when element.TryGetProperty("$blob", out var blob) => blob.GetString(),
        JsonValueKind.Object when element.TryGetProperty("$repeat", out var repeat) => string.Concat(Enumerable.Repeat(repeat[0].GetString(), repeat[1].GetInt32())),
        _ => throw new InvalidOperationException($"Unsupported golden value: {element.GetRawText()}"),
    };

    /// <summary>Normalize a value read through Microsoft.Data.Sqlite the way better-sqlite3 hands it to JavaScript.</summary>
    public static object? Normalize(object? value) => value switch
    {
        null or DBNull => null,
        long integer => (double)integer,
        double real => real,
        string text => text,
        byte[] bytes => Convert.ToBase64String(bytes),
        _ => throw new InvalidOperationException($"Unexpected SQLite value type {value.GetType()}."),
    };
}

internal sealed record OracleQuery(string Id, string Sql, IReadOnlyList<object?> Parameters, string? When);

internal sealed record OracleResult(IReadOnlyList<IReadOnlyList<object?>>? Rows, string? Error);
