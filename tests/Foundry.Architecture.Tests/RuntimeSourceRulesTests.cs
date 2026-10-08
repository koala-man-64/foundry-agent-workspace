using System.Text.RegularExpressions;
using Xunit;

namespace Foundry.Architecture.Tests;

/// <summary>
/// Loop-affinity rules that BannedSymbols.txt cannot express: the lock statement and async void are language
/// constructs, not API symbols.
/// </summary>
public sealed partial class RuntimeSourceRulesTests
{
    [GeneratedRegex(@"\block\s*\(", RegexOptions.CultureInvariant)]
    private static partial Regex LockStatement();

    [GeneratedRegex(@"\basync\s+void\b", RegexOptions.CultureInvariant)]
    private static partial Regex AsyncVoid();

    [Theory]
    [InlineData("lock (gate) {", true)]
    [InlineData("    lock(state)", true)]
    [InlineData("private async void OnTick()", true)]
    [InlineData("var block = Unlock(handle);", false)]
    [InlineData("private async Task OnTickAsync()", false)]
    public void PatternsRecognizeTheForbiddenConstructs(string line, bool forbidden)
    {
        Assert.Equal(forbidden, IsForbidden(line));
    }

    [Fact]
    public void RuntimeCoreHasNoLockStatementsOrAsyncVoid()
    {
        var root = Path.Combine(SourceProjects.RepositoryRoot, "src", "Foundry.Runtime.Core");
        var offenders = Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories)
            .Where(path => !IsBuildOutput(path))
            .SelectMany(path => File.ReadLines(path).Select((line, index) => (path, line, number: index + 1)))
            .Where(item => IsForbidden(item.line))
            .Select(item => $"{Path.GetRelativePath(SourceProjects.RepositoryRoot, item.path)}:{item.number}")
            .ToList();
        Assert.True(offenders.Count == 0, "Loop-affine runtime code must not use lock statements or async void: " + string.Join(", ", offenders));
    }

    private static bool IsForbidden(string line) => LockStatement().IsMatch(line) || AsyncVoid().IsMatch(line);

    private static bool IsBuildOutput(string path)
    {
        var separator = Path.DirectorySeparatorChar;
        return path.Contains($"{separator}obj{separator}", StringComparison.OrdinalIgnoreCase)
            || path.Contains($"{separator}bin{separator}", StringComparison.OrdinalIgnoreCase);
    }
}
