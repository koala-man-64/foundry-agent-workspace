using Microsoft.Data.Sqlite;

namespace Foundry.Runtime;

internal static class SqliteSetup
{
    internal static SqliteConnection Open(string path, SqliteOpenMode mode)
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Mode = mode, Pooling = false }.ToString());
        try
        {
            connection.Open();
            foreach (var option in new[] { 1013, 1014 })
                if (SQLitePCL.raw.sqlite3_db_config(connection.Handle, option, 0, out _) != SQLitePCL.raw.SQLITE_OK) throw new InvalidOperationException("SQLite compatibility setup failed.");
            return connection;
        }
        catch { connection.Dispose(); throw; }
    }
}
