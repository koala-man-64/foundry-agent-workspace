using Xunit;

namespace Foundry.CliDrivers.Tests;

public sealed class IsolationTests
{
    [Fact]
    public void ShippingProjectsAndSolutionDoNotReferencePreparation()
    {
        var root = RepositoryRoot();
        var shippingFiles = Directory.EnumerateFiles(Path.Combine(root, "src"), "*.csproj", SearchOption.AllDirectories)
            .Append(Path.Combine(root, "Foundry.slnx"));
        foreach (var file in shippingFiles)
        {
            var source = File.ReadAllText(file);
            Assert.DoesNotContain("CliDrivers", source, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("preparation/", source, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("preparation\\", source, StringComparison.OrdinalIgnoreCase);
        }
        Assert.DoesNotContain(typeof(CodexCliDriver).Assembly.GetReferencedAssemblies(), name =>
            name.Name is "Foundry.Protocol" or "Foundry.Runtime.Core" or "Foundry.Host" or "Microsoft.Data.Sqlite");
    }

    private static string RepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
            if (File.Exists(Path.Combine(directory.FullName, "Foundry.slnx"))) return directory.FullName;
        throw new DirectoryNotFoundException("Repository root not found.");
    }
}
