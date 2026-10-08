using System.Globalization;
using System.Text;
using Microsoft.Data.Sqlite;
using Xunit;

namespace Foundry.Runtime.Tests;

/// <summary>Spike S8: Microsoft.Data.Sqlite with its bundled SQLite against better-sqlite3 13.0.3 on every era fixture.</summary>
public sealed class SqliteEngineParityTests
{
    private static readonly SqliteOracle Oracle = SqliteOracle.Load();

    // Compile options that change what SQL means or what a connection does by default.
    private static readonly string[] SemanticOptions =
        ["DEFAULT_FOREIGN_KEYS", "DEFAULT_WAL_SYNCHRONOUS", "DQS", "LIKE_DOESNT_MATCH_BLOBS", "CASE_SENSITIVE_LIKE", "ENABLE_FTS5", "OMIT_JSON", "ENABLE_ICU", "MAX_VARIABLE_NUMBER", "MAX_LIKE_PATTERN_LENGTH", "DEFAULT_RECURSIVE_TRIGGERS"];

    // Differences the connection setup or the Store's explicit pragmas neutralize (docs/wpf-webview2-migration.md, S8).
    private static readonly string[] Compensated = ["DQS", "DEFAULT_FOREIGN_KEYS", "DEFAULT_WAL_SYNCHRONOUS"];

    public static TheoryData<string> FixtureNames => new(Fixtures.Names);

    [Fact]
    public void EngineProvidesWhatTheSchemaNeeds()
    {
        using var connection = CandidateConnection.Open(":memory:", SqliteOpenMode.Memory);
        var version = (string)CandidateConnection.Scalar(connection, "SELECT sqlite_version()")!;
        TestContext.Current.TestOutputHelper?.WriteLine($"Microsoft.Data.Sqlite engine {version}; better-sqlite3 engine {Oracle.Version}");
        using (var command = connection.CreateCommand())
        {
            command.CommandText = "CREATE VIRTUAL TABLE probe USING fts5(content, tokenize='unicode61'); CREATE TABLE documents (data TEXT); CREATE INDEX documents_kind ON documents(json_extract(data, '$.kind')) WHERE json_valid(data);";
            command.ExecuteNonQuery();
        }
        Assert.Equal(2L, CandidateConnection.Scalar(connection, "SELECT json_extract('{\"a\":2}', '$.a')"));
        Assert.True(new Version(version) >= new Version(3, 45), $"SQLite {version} predates JSONB-era JSON functions the schema may rely on.");
    }

    [Fact]
    public void CompileOptionsThatChangeSemanticsMatchOrAreCompensated()
    {
        using var connection = CandidateConnection.Open(":memory:", SqliteOpenMode.Memory);
        var ours = Semantic(CandidateConnection.Column(connection, "PRAGMA compile_options"));
        var theirs = Semantic(Oracle.CompileOptions);
        var differences = SemanticOptions
            .Where(option => !string.Equals(ours.GetValueOrDefault(option), theirs.GetValueOrDefault(option), StringComparison.Ordinal))
            .Select(option => $"{option}: ours={ours.GetValueOrDefault(option) ?? "(absent)"} better-sqlite3={theirs.GetValueOrDefault(option) ?? "(absent)"}")
            .ToList();
        TestContext.Current.TestOutputHelper?.WriteLine(string.Join(Environment.NewLine, differences));
        var unexplained = differences.Where(item => !Compensated.Any(option => item.StartsWith(option + ":", StringComparison.Ordinal))).ToList();
        Assert.True(unexplained.Count == 0, "Uncompensated semantic compile-option differences: " + string.Join("; ", unexplained));
    }

    [Theory]
    [MemberData(nameof(FixtureNames))]
    public void QueriesReturnWhatBetterSqlite3Returns(string fixture)
    {
        using var scratch = Fixtures.Copy(fixture);
        using var connection = CandidateConnection.Open(scratch.Path);
        var objects = CandidateConnection.Column(connection, "SELECT name FROM sqlite_master").ToHashSet(StringComparer.Ordinal);
        var expected = Oracle.Results(fixture);
        foreach (var query in Oracle.Queries.Where(query => query.When is null || objects.Contains(query.When)))
        {
            var oracle = expected[query.Id];
            var (rows, error) = Run(connection, query);
            if (oracle.Error is not null)
            {
                Assert.True(string.Equals(oracle.Error, error, StringComparison.Ordinal), $"{fixture} / {query.Id}: expected error '{oracle.Error}', got {(error is null ? "rows" : $"'{error}'")}.");
                continue;
            }
            Assert.True(error is null, $"{fixture} / {query.Id}: unexpected error '{error}'.");
            Assert.True(oracle.Rows!.Count == rows!.Count, $"{fixture} / {query.Id}: expected {oracle.Rows.Count} rows, got {rows.Count}.");
            for (var index = 0; index < rows.Count; index++)
            {
                Assert.True(oracle.Rows[index].SequenceEqual(rows[index]), $"{fixture} / {query.Id} row {index}: expected [{Describe(oracle.Rows[index])}], got [{Describe(rows[index])}].");
            }
        }
    }

    [Fact]
    public void OnlineBackupOfALiveWalDatabaseVerifies()
    {
        using var scratch = Fixtures.Copy("v5-wal");
        using var source = CandidateConnection.Open(scratch.Path);
        var backup = Path.Combine(scratch.Directory, "backup.db");
        using (var destination = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = backup, Pooling = false }.ToString()))
        {
            destination.Open();
            source.BackupDatabase(destination);
        }
        using var copy = CandidateConnection.Open(backup, SqliteOpenMode.ReadOnly);
        Assert.Equal("ok", CandidateConnection.Scalar(copy, "PRAGMA integrity_check"));
        Assert.Equal(CandidateConnection.Scalar(source, "PRAGMA user_version"), CandidateConnection.Scalar(copy, "PRAGMA user_version"));
        foreach (var table in CandidateConnection.Column(source, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"))
        {
            Assert.Equal(CandidateConnection.Scalar(source, $"SELECT count(*) FROM \"{table}\""), CandidateConnection.Scalar(copy, $"SELECT count(*) FROM \"{table}\""));
        }
        Assert.Equal((long)OracleTaskCount("v5-wal"), CandidateConnection.Scalar(copy, "SELECT count(*) FROM tasks"));
    }

    [Fact]
    public void ReadOnlyOpenSeesCommittedWalPages()
    {
        using var scratch = Fixtures.Copy("v5-wal");
        using var connection = CandidateConnection.Open(scratch.Path, SqliteOpenMode.ReadOnly);
        Assert.Equal((long)OracleTaskCount("v5-wal"), CandidateConnection.Scalar(connection, "SELECT count(*) FROM tasks"));
        Assert.Equal("ok", CandidateConnection.Scalar(connection, "PRAGMA integrity_check"));
    }

    [Fact]
    public void PlannedDurabilityPragmasApply()
    {
        using var scratch = Fixtures.Copy("v5");
        using var connection = CandidateConnection.Open(scratch.Path);
        using (var command = connection.CreateCommand())
        {
            command.CommandText = "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;";
            command.ExecuteNonQuery();
        }
        Assert.Equal("wal", CandidateConnection.Scalar(connection, "PRAGMA journal_mode"));
        Assert.Equal(1L, CandidateConnection.Scalar(connection, "PRAGMA foreign_keys"));
        Assert.Equal(5000L, CandidateConnection.Scalar(connection, "PRAGMA busy_timeout"));
        Assert.Equal(2L, CandidateConnection.Scalar(connection, "PRAGMA synchronous"));
    }

    private static int OracleTaskCount(string fixture) => Oracle.Results(fixture)["task documents"].Rows!.Count;

    private static (List<IReadOnlyList<object?>>? Rows, string? Error) Run(SqliteConnection connection, OracleQuery query)
    {
        using var command = connection.CreateCommand();
        var sql = new StringBuilder();
        var parameter = 0;
        foreach (var character in query.Sql)
        {
            if (character != '?') { sql.Append(character); continue; }
            var name = "$p" + (++parameter).ToString(CultureInfo.InvariantCulture);
            sql.Append(name);
            command.Parameters.AddWithValue(name, query.Parameters[parameter - 1] switch { double number when number == Math.Floor(number) => (long)number, var value => value });
        }
        command.CommandText = sql.ToString();
        try
        {
            using var reader = command.ExecuteReader();
            var plan = query.Sql.StartsWith("EXPLAIN QUERY PLAN", StringComparison.Ordinal);
            var rows = new List<IReadOnlyList<object?>>();
            while (reader.Read())
            {
                rows.Add(plan
                    ? [reader.GetString(reader.FieldCount - 1)]
                    : Enumerable.Range(0, reader.FieldCount).Select(index => SqliteOracle.Normalize(reader.GetValue(index))).ToList());
            }
            return (rows, null);
        }
        catch (SqliteException exception)
        {
            // Microsoft.Data.Sqlite wraps SQLite's text: SQLite Error 1: '<message>'.
            var text = exception.Message;
            var start = text.IndexOf('\'', StringComparison.Ordinal);
            var end = text.LastIndexOf('\'');
            return (null, start >= 0 && end > start ? text[(start + 1)..end] : text);
        }
    }

    private static Dictionary<string, string> Semantic(IEnumerable<string> options) =>
        options.Select(option => option.Split('=', 2)).ToDictionary(parts => parts[0], parts => parts.Length > 1 ? parts[1] : "set", StringComparer.Ordinal);

    private static string Describe(IReadOnlyList<object?> row) =>
        string.Join(", ", row.Select(value => value switch { null => "null", double number => number.ToString("R", CultureInfo.InvariantCulture), var other => $"'{other}'" }));
}
