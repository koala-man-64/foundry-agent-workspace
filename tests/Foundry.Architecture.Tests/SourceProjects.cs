using System.Xml.Linq;

namespace Foundry.Architecture.Tests;

/// <summary>A source project as declared in its .csproj, read without building or loading it.</summary>
internal sealed record SourceProject(string Name, XDocument Document)
{
    public IReadOnlyList<string> ProjectReferences { get; } = Document.Descendants("ProjectReference")
        .Select(item => Path.GetFileNameWithoutExtension((string?)item.Attribute("Include") ?? string.Empty))
        .ToList();

    public IReadOnlyList<string> PackageReferences { get; } = Document.Descendants("PackageReference")
        .Select(item => (string?)item.Attribute("Include") ?? string.Empty)
        .ToList();

    public bool HasProperty(string name, string value) =>
        Document.Descendants(name).Any(element => string.Equals(element.Value.Trim(), value, StringComparison.OrdinalIgnoreCase));
}

internal static class SourceProjects
{
    public static string RepositoryRoot { get; } = FindRepositoryRoot();

    public static IReadOnlyDictionary<string, SourceProject> All { get; } = Load();

    /// <summary>Every project reachable from <paramref name="name"/> through project references.</summary>
    public static IReadOnlySet<string> Closure(string name)
    {
        var reached = new HashSet<string>(StringComparer.Ordinal);
        var pending = new Stack<string>(All[name].ProjectReferences);
        while (pending.TryPop(out var next))
        {
            if (reached.Add(next) && All.TryGetValue(next, out var project))
            {
                foreach (var reference in project.ProjectReferences)
                {
                    pending.Push(reference);
                }
            }
        }
        return reached;
    }

    private static Dictionary<string, SourceProject> Load()
    {
        var projects = new Dictionary<string, SourceProject>(StringComparer.Ordinal);
        foreach (var path in Directory.EnumerateFiles(Path.Combine(RepositoryRoot, "src"), "*.csproj", SearchOption.AllDirectories))
        {
            var name = Path.GetFileNameWithoutExtension(path);
            projects.Add(name, new SourceProject(name, XDocument.Load(path)));
        }
        return projects;
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
