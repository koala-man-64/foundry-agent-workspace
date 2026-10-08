using Xunit;

namespace Foundry.Architecture.Tests;

/// <summary>Enforces the solution layout and trust boundaries in docs/wpf-webview2-migration.md.</summary>
public sealed class DependencyRulesTests
{
    private static readonly Dictionary<string, string[]> AllowedReferences = new(StringComparer.Ordinal)
    {
        ["Foundry.Protocol"] = [],
        ["Foundry.Platform"] = [],
        ["Foundry.Providers"] = ["Foundry.Protocol"],
        ["Foundry.Runtime.Core"] = ["Foundry.Protocol", "Foundry.Providers", "Foundry.Platform"],
        ["Foundry.Runtime"] = ["Foundry.Runtime.Core"],
        ["Foundry.Host"] = ["Foundry.Protocol", "Foundry.Platform"],
        ["Foundry.Desktop"] = ["Foundry.Host"],
    };

    [Fact]
    public void EverySourceProjectHasAnExplicitRule()
    {
        Assert.Equal(
            AllowedReferences.Keys.Order(StringComparer.Ordinal),
            SourceProjects.All.Keys.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void ProjectReferencesStayInsideTheAllowedGraph()
    {
        foreach (var project in SourceProjects.All.Values)
        {
            var unexpected = project.ProjectReferences.Except(AllowedReferences[project.Name], StringComparer.Ordinal).ToList();
            Assert.True(unexpected.Count == 0, $"{project.Name} references {string.Join(", ", unexpected)} outside the allowed graph.");
        }
    }

    // The host never reaches the runtime or providers, and the runtime never reaches the host or the WPF shell.
    [Theory]
    [InlineData("Foundry.Desktop", "Foundry.Runtime.Core")]
    [InlineData("Foundry.Desktop", "Foundry.Runtime")]
    [InlineData("Foundry.Desktop", "Foundry.Providers")]
    [InlineData("Foundry.Host", "Foundry.Runtime.Core")]
    [InlineData("Foundry.Host", "Foundry.Providers")]
    [InlineData("Foundry.Runtime.Core", "Foundry.Host")]
    [InlineData("Foundry.Runtime.Core", "Foundry.Desktop")]
    [InlineData("Foundry.Runtime", "Foundry.Host")]
    [InlineData("Foundry.Runtime", "Foundry.Desktop")]
    public void TrustBoundariesHoldTransitively(string project, string forbidden)
    {
        Assert.DoesNotContain(forbidden, SourceProjects.Closure(project));
    }

    [Theory]
    [InlineData("Microsoft.Web.WebView2", "Foundry.Desktop")]
    [InlineData("Microsoft.Data.Sqlite", "Foundry.Runtime.Core")]
    [InlineData("System.Security.Cryptography.ProtectedData", "Foundry.Platform")]
    public void ConfinedPackagesStayInTheirProject(string package, string owner)
    {
        var users = SourceProjects.All.Values
            .Where(project => project.PackageReferences.Contains(package, StringComparer.OrdinalIgnoreCase))
            .Select(project => project.Name);
        Assert.All(users, user => Assert.Equal(owner, user));
    }

    [Fact]
    public void OnlyDesktopUsesWpfAndNothingUsesWindowsForms()
    {
        Assert.Equal(["Foundry.Desktop"], SourceProjects.All.Values.Where(project => project.HasProperty("UseWPF", "true")).Select(project => project.Name));
        Assert.DoesNotContain(SourceProjects.All.Values, project => project.HasProperty("UseWindowsForms", "true"));
    }

    [Fact]
    public void UnsafeCodeIsConfinedToPlatform()
    {
        Assert.All(
            SourceProjects.All.Values.Where(project => project.HasProperty("AllowUnsafeBlocks", "true")),
            project => Assert.Equal("Foundry.Platform", project.Name));
    }

    [Fact]
    public void ProjectsUseNoRawAssemblyOrFrameworkReferences()
    {
        foreach (var project in SourceProjects.All.Values)
        {
            Assert.Empty(project.Document.Descendants("Reference"));
            Assert.Empty(project.Document.Descendants("FrameworkReference"));
        }
    }
}
