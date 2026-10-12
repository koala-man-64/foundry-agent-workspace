using System.Text.Json;
using System.Text.RegularExpressions;
using Foundry.Runtime;
using Microsoft.Data.Sqlite;
using Xunit;

namespace Foundry.Conformance;

public sealed class StoreTests
{
    private static string Root => FindRoot();
    private static string FindRoot()
    {
        for (var current = new DirectoryInfo(AppContext.BaseDirectory); current is not null; current = current.Parent)
            if (File.Exists(Path.Combine(current.FullName, "Foundry.slnx"))) return current.FullName;
        throw new InvalidOperationException("Missing fixtures.");
    }
    private sealed record Dump(long Version, List<string> Schema, Dictionary<string, Dictionary<long, Dictionary<string, object?>>> Tables);
    private static Dump ReadDump(string path)
    {
        using var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString());
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
        var objects = new List<(string Type, string Name, string Sql)>();
        using (var reader = command.ExecuteReader()) while (reader.Read()) objects.Add((reader.GetString(0), reader.GetString(1), reader.IsDBNull(2) ? "" : reader.GetString(2)));
        var virtualNames = objects.Where(item => item.Type == "table" && item.Sql.StartsWith("CREATE VIRTUAL TABLE", StringComparison.OrdinalIgnoreCase)).Select(item => item.Name).ToArray();
        var tables = new Dictionary<string, Dictionary<long, Dictionary<string, object?>>>();
        foreach (var item in objects.Where(item => item.Type == "table" && !virtualNames.Any(name => item.Name.StartsWith(name + "_", StringComparison.Ordinal))))
        {
            command.CommandText = "SELECT rowid,* FROM \"" + item.Name.Replace("\"", "\"\"", StringComparison.Ordinal) + "\" ORDER BY rowid";
            using var reader = command.ExecuteReader();
            var rows = new Dictionary<long, Dictionary<string, object?>>();
            while (reader.Read())
            {
                var row = new Dictionary<string, object?>();
                for (var index = 1; index < reader.FieldCount; index++) row.Add(reader.GetName(index), reader.IsDBNull(index) ? null : reader.GetValue(index));
                rows.Add(reader.GetInt64(0), row);
            }
            tables.Add(item.Name, rows);
        }
        command.CommandText = "PRAGMA user_version";
        return new((long)command.ExecuteScalar()!, objects.Select(item => item.Type + " " + item.Name + ": " + Regex.Replace(item.Sql, @"\s+", " ").Trim()).ToList(), tables);
    }
    private static string Canonical(object? value) => CanonicalElement(JsonSerializer.SerializeToElement(value));
    private static string CanonicalElement(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Object => "{" + string.Join(",", value.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal).Select(p => JsonSerializer.Serialize(p.Name) + ":" + CanonicalElement(p.Value))) + "}",
        JsonValueKind.Array => "[" + string.Join(",", value.EnumerateArray().Select(CanonicalElement)) + "]",
        JsonValueKind.String => JsonSerializer.Serialize(value.GetString()),
        _ => value.GetRawText()
    };
    private static object Differences(Dump before, Dump after)
    {
        var uuid = new Regex(@"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", RegexOptions.IgnoreCase);
        var timestamp = new Regex(@"\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z\b");
        var known = new HashSet<string>(); var minted = new Dictionary<string, string>();
        foreach (var value in before.Tables.Values.SelectMany(rows => rows.Values).SelectMany(row => row.Values).OfType<string>())
        {
            foreach (Match match in uuid.Matches(value)) known.Add(match.Value.ToLowerInvariant());
            foreach (Match match in timestamp.Matches(value)) known.Add(match.Value);
        }
        object? Mask(object? value)
        {
            if (value is not string text) return value;
            return timestamp.Replace(uuid.Replace(text, match =>
            {
                if (known.Contains(match.Value.ToLowerInvariant())) return match.Value;
                if (!minted.TryGetValue(match.Value, out var replacement)) minted.Add(match.Value, replacement = "<new-id-" + (minted.Count + 1) + ">");
                return replacement;
            }), match => known.Contains(match.Value) ? match.Value : "<recovered-at>");
        }
        var changes = new Dictionary<string, object?>();
        foreach (var name in before.Tables.Keys.Concat(after.Tables.Keys).Distinct())
        {
            var old = before.Tables.GetValueOrDefault(name) ?? []; var next = after.Tables.GetValueOrDefault(name) ?? [];
            var added = next.Where(p => !old.ContainsKey(p.Key)).Select(p => new Dictionary<string, object?> { ["rowid"] = p.Key }.Concat(p.Value.Select(field => new KeyValuePair<string, object?>(field.Key, Mask(field.Value)))).ToDictionary()).ToArray();
            var removed = old.Where(p => !next.ContainsKey(p.Key)).Select(p => new Dictionary<string, object?> { ["rowid"] = p.Key }.Concat(p.Value).ToDictionary()).ToArray();
            var changed = new List<object>();
            foreach (var (rowid, row) in next.Where(p => old.ContainsKey(p.Key) && Canonical(old[p.Key]) != Canonical(p.Value)))
            {
                var previous = old[rowid]; var keys = previous.Keys.Concat(row.Keys).Distinct().Where(key => Canonical(previous.GetValueOrDefault(key)) != Canonical(row.GetValueOrDefault(key))).ToArray();
                changed.Add(new { rowid, before = keys.ToDictionary(key => key, key => previous.GetValueOrDefault(key)), after = keys.ToDictionary(key => key, key => Mask(row.GetValueOrDefault(key))) });
            }
            if (added.Length > 0 || removed.Length > 0 || changed.Count > 0) changes.Add(name, new { added, removed, changed });
        }
        return new { userVersion = new { before = before.Version, after = after.Version }, schemaAfter = after.Schema, changes };
    }

    [Theory]
    [InlineData("v1"), InlineData("v2"), InlineData("v3"), InlineData("v4"), InlineData("v5"), InlineData("v5-wal")]
    public async Task EraOpeningMatchesCommittedSchemaAndRowDeltas(string era)
    {
        var fixture = Path.Combine(Root, "tests", "fixtures", "databases", era);
        var scratch = Directory.CreateTempSubdirectory("foundry-p1-era-").FullName;
        try
        {
            foreach (var file in Directory.GetFiles(fixture, "workspace.db*")) File.Copy(file, Path.Combine(scratch, Path.GetFileName(file)));
            File.WriteAllText(Path.Combine(scratch, Store.IsolationMarker), Store.IsolationDeclaration);
            var path = Path.Combine(scratch, "workspace.db"); var before = ReadDump(path);
            await using (var loop = new RuntimeLoop()) await loop.Invoke(() =>
            {
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-real-root"));
                Assert.Equal(before.Version, store.SchemaVersion);
                Assert.Equal(2L, store.Scalar("PRAGMA synchronous"));
                return Task.FromResult(0);
            });
            var actual = Differences(before, ReadDump(path));
            using var expected = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(fixture, "expected-after-open.json")));
            Assert.Equal(CanonicalElement(expected.RootElement), Canonical(actual));
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task FreshDatabaseUsesV5AndReleasesEveryFile()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p1-fresh-").FullName;
        try
        {
            await using (var loop = new RuntimeLoop()) await loop.Invoke(() =>
            {
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-real-root"));
                Assert.Equal(5, store.SchemaVersion);
                Assert.Null(store.Scalar("SELECT 1 FROM sqlite_master WHERE name='runtime_meta'"));
                Assert.Equal(5000L, store.Scalar("PRAGMA busy_timeout"));
                Assert.Throws<SqliteException>(() => store.Scalar("SELECT \"not a column\""));
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }
}
