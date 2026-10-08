namespace Foundry.Runtime.Tests;

/// <summary>Repository paths and disposable copies of the era fixture databases.</summary>
internal static class Fixtures
{
    public static string RepositoryRoot { get; } = FindRepositoryRoot();

    public static string DatabasesDirectory => Path.Combine(RepositoryRoot, "tests", "fixtures", "databases");

    public static string GoldenDirectory => Path.Combine(RepositoryRoot, "tests", "golden", "data");

    public static IReadOnlyList<string> Names { get; } = Directory.GetDirectories(DatabasesDirectory)
        .Where(directory => File.Exists(Path.Combine(directory, "workspace.db")))
        .Select(Path.GetFileName)
        .OfType<string>()
        .Order(StringComparer.Ordinal)
        .ToList();

    /// <summary>
    /// Copy a fixture (database plus any WAL pair) to a fresh scratch directory. Never open a fixture in place: SQLite
    /// creates -wal and -shm files beside any WAL database it opens, even read-only.
    /// </summary>
    public static ScratchDatabase Copy(string name)
    {
        var directory = Directory.CreateTempSubdirectory($"foundry-sqlite-{name}-");
        foreach (var file in Directory.GetFiles(Path.Combine(DatabasesDirectory, name), "workspace.db*"))
        {
            File.Copy(file, Path.Combine(directory.FullName, Path.GetFileName(file)));
        }
        return new ScratchDatabase(directory.FullName);
    }

    private static string FindRepositoryRoot()
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

internal sealed class ScratchDatabase(string directory) : IDisposable
{
    public string Directory { get; } = directory;

    public string Path => System.IO.Path.Combine(Directory, "workspace.db");

    public void Dispose()
    {
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        System.IO.Directory.Delete(Directory, recursive: true);
    }
}
