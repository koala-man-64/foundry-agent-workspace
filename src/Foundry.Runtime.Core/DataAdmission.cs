using Foundry.Platform;

namespace Foundry.Runtime;

public enum DataDisposition { Fresh, SupportedIsolated, AdoptionPending, Unsupported }
public sealed record DataAdmission(DataDisposition Disposition, string Directory, string Database, int Version);

public static class DataClassifier
{
    public static DataAdmission Inspect(string directory, string applicationRoot) => Inspect(directory, applicationRoot, InspectVersion);
    internal static DataAdmission Inspect(string directory, string applicationRoot, Func<string, (int Version, bool Fenced)> inspectVersion)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(directory);
        ArgumentException.ThrowIfNullOrWhiteSpace(applicationRoot);
        var path = Path.GetFullPath(directory);
        var root = Path.GetFullPath(applicationRoot);
        if (!IsLocal(path) || !IsLocal(root)) throw new IOException("Data identity cannot be established.");
        var database = Path.Combine(path, "workspace.db");
        if (Within(path, root)) return new(DataDisposition.AdoptionPending, path, database, 0);
        var canonicalRoot = ResolveThroughExistingAncestor(root);
        var canonical = ResolveThroughExistingAncestor(path);
        if (Within(canonical, canonicalRoot)) return new(DataDisposition.AdoptionPending, canonical, Path.Combine(canonical, "workspace.db"), 0);
        database = Path.Combine(canonical, "workspace.db");
        using var identity = DirectoryLease.Acquire(path);
        if (!File.Exists(database)) return new(DataDisposition.Fresh, canonical, database, 0);
        // Reject reparse points and multiply-linked files before SQLite can
        // inspect contents. Keep this handle pinned throughout read preflight.
        identity.PinExistingDatabase(database);
        if (!FinalPath.TryResolve(database, out var physical)) throw new IOException("Data identity cannot be established.");
        if (Within(physical, canonicalRoot)) return new(DataDisposition.AdoptionPending, canonical, database, 0);
        if (!StringComparer.OrdinalIgnoreCase.Equals(physical, database)) throw new IOException("Database aliases are not admitted.");
        var (version, fenced) = inspectVersion(database);
        return new(!fenced && version is >= 0 and <= 5 ? DataDisposition.SupportedIsolated : DataDisposition.Unsupported, canonical, database, version);
    }

    private static (int Version, bool Fenced) InspectVersion(string database)
    {
        using var inspection = SqliteSetup.Open(database, Microsoft.Data.Sqlite.SqliteOpenMode.ReadOnly);
        using var command = inspection.CreateCommand();
        command.CommandText = "PRAGMA user_version";
        var version = checked((int)(long)command.ExecuteScalar()!);
        command.CommandText = "SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_meta'";
        var fenced = command.ExecuteScalar() is not null;
        return (version, fenced);
    }

    internal static bool IsLocal(string path) => path.Length >= 3 && char.IsAsciiLetter(path[0]) && path[1] == ':' && path[2] == '\\' && !path.AsSpan(2).Contains(':') && !path.Contains('\0');
    private static bool Within(string path, string root) => StringComparer.OrdinalIgnoreCase.Equals(path.TrimEnd('\\'), root.TrimEnd('\\'))
        || path.StartsWith(root.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
    private static string ResolveThroughExistingAncestor(string path)
    {
        var tail = new Stack<string>();
        var existing = path;
        while (!Directory.Exists(existing))
        {
            if (File.Exists(existing)) throw new IOException("Data identity cannot be established.");
            tail.Push(Path.GetFileName(existing));
            existing = Path.GetDirectoryName(existing) ?? throw new IOException("Data identity cannot be established.");
        }
        if (!FinalPath.TryResolve(existing, out var canonical) || !IsLocal(canonical)) throw new IOException("Data identity cannot be established.");
        foreach (var component in tail) canonical = Path.Combine(canonical, component);
        return canonical;
    }
}
