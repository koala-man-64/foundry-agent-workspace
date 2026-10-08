using Microsoft.Data.Sqlite;

namespace Foundry.Runtime.Tests;

/// <summary>
/// The connection setup spike S8 proposes for the P1 Store: no pooling (files must close for backup and restore), and
/// double-quoted string literals rejected as better-sqlite3 does (DQS=0), so SQL keeps one meaning on both engines.
/// </summary>
internal static class CandidateConnection
{
    // sqlite3.h: SQLITE_DBCONFIG_DQS_DML and SQLITE_DBCONFIG_DQS_DDL.
    private const int DoubleQuotedStringsInDml = 1013;
    private const int DoubleQuotedStringsInDdl = 1014;

    public static SqliteConnection Open(string path, SqliteOpenMode mode = SqliteOpenMode.ReadWrite)
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Mode = mode, Pooling = false }.ToString());
        connection.Open();
        foreach (var option in new[] { DoubleQuotedStringsInDml, DoubleQuotedStringsInDdl })
        {
            var result = SQLitePCL.raw.sqlite3_db_config(connection.Handle, option, 0, out _);
            if (result != SQLitePCL.raw.SQLITE_OK)
            {
                connection.Dispose();
                throw new InvalidOperationException($"sqlite3_db_config({option}) failed with {result}.");
            }
        }
        return connection;
    }

    public static object? Scalar(SqliteConnection connection, string sql)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        return command.ExecuteScalar();
    }

    public static List<string> Column(SqliteConnection connection, string sql)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        using var reader = command.ExecuteReader();
        var values = new List<string>();
        while (reader.Read())
        {
            values.Add(reader.GetString(0));
        }
        return values;
    }
}
