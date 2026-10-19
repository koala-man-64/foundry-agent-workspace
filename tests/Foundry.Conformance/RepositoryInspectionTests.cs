using System.Text.Json;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

/// <summary>Native read-only repository inspection against the committed Node outcomes (tests/p2/repository-inspection.test.ts).</summary>
public sealed class RepositoryInspectionTests
{
    private static readonly JsonElement Corpus = RepositoryFixture.ReadCorpus("tests/p2/repository-inspection-vectors.json");

    public static IEnumerable<object[]> Cases()
    {
        var index = 0;
        foreach (var item in Corpus.GetProperty("cases").EnumerateArray()) yield return [item.GetProperty("name").GetString()!, index++];
    }

    [Theory, MemberData(nameof(Cases))]
    public Task FixtureTreesMatchCommittedNodeOutcomesOrTheirApprovedDifference(string name, int index) => Replay(name, index, removable: false);

    /// <summary>The same committed Node outcomes with the fixture on a removable drive (Rudy, 19 October 2026): TypeScript
    /// reads no drive type for project folders, so nothing may change. The worktree base stays fixed.</summary>
    [Theory, MemberData(nameof(Cases))]
    public Task FixtureTreesOnARemovableDriveMatchTheSameOutcomes(string name, int index) => Replay(name, index, removable: true);

    private static async Task Replay(string name, int index, bool removable)
    {
        var item = Corpus.GetProperty("cases")[index];
        Assert.Equal(name, item.GetProperty("name").GetString());
        var expected = item.TryGetProperty("native", out var native) ? native.GetProperty("outcome") : item.GetProperty("expected");
        using var fixture = RepositoryFixture.Create("foundry-p2-inspection-");
        await fixture.Build(item.GetProperty("tree"));
        using var drive = RemovableDrive.Place(removable, fixture.Scratch, Path.Combine(fixture.Scratch, "wt-base"));
        await using var loop = new RuntimeLoop();
        var (result, error) = await loop.Invoke(async () =>
        {
            var service = new RepositoryService(loop, Path.Combine(fixture.Scratch, "wt-base"), fixture.Environment);
            try { return (fixture.Normalize(await Perform(service, item.GetProperty("operation"), fixture)), (string?)null); }
            catch (InvalidOperationException exception) { return ((object?)null, (string?)fixture.Normalize(exception.Message)); }
        });
        if (expected.TryGetProperty("result", out var value))
        {
            Assert.Null(error);
            var actual = JsonSerializer.SerializeToElement(result);
            Assert.True(JsonElement.DeepEquals(value, actual), $"expected {value.GetRawText()}\nactual   {actual.GetRawText()}");
        }
        else if (expected.TryGetProperty("error", out var message)) Assert.Equal(message.GetString(), error);
        else
        {
            // Node raised a raw filesystem error (ENOENT, ENOTDIR); native must refuse, with its own fixed message.
            Assert.True(expected.TryGetProperty("systemError", out _));
            Assert.NotNull(error);
        }
    }

    [Fact]
    public void OracleSourceBindingsAreCurrent()
    {
        Assert.Equal(1, Corpus.GetProperty("schemaVersion").GetInt32());
        Assert.True(Corpus.GetProperty("cases").GetArrayLength() >= 80);
        RepositoryFixture.AssertOracleSources(Corpus);
        foreach (var item in Corpus.GetProperty("cases").EnumerateArray())
            if (item.TryGetProperty("native", out var native)) Assert.False(string.IsNullOrWhiteSpace(native.GetProperty("difference").GetString()));
    }

    private static async Task<object?> Perform(RepositoryService service, JsonElement operation, RepositoryFixture fixture)
    {
        var root = fixture.Local(operation.GetProperty("root").GetString()!);
        switch (operation.GetProperty("op").GetString())
        {
            case "list": return service.ListFiles(root, operation.GetProperty("path").GetString()!);
            case "read": return service.ReadFile(root, operation.GetProperty("path").GetString()!);
            case "status": return await service.UncommittedPaths(root);
            case "diff": return await service.Diff(root);
            case "isGit": return await service.IsGitWorkingTree(root);
            case "repository": { using var admission = await service.RequireRepository(root); return admission.Path; }
            case "trackedFilters": { using var admission = await service.RequireRepository(root); await service.RejectTrackedFilters(admission); return null; }
            case "filters":
                {
                    using var admission = await service.RequireRepository(root);
                    await service.RejectFilters(admission, [.. operation.GetProperty("paths").EnumerateArray().Select(path => path.GetString()!)]);
                    return null;
                }
            case "revisionFilters":
                {
                    // {HEAD} becomes the commit object id, as every runtime caller passes the id rev-parse returned.
                    var revision = operation.GetProperty("revision").GetString()!;
                    if (revision == "{HEAD}") revision = await fixture.GitOutput("-C", root, "rev-parse", "HEAD");
                    using var admission = await service.RequireRepository(root);
                    await service.RejectTrackedFiltersAtRevision(admission, revision);
                    return null;
                }
            default: throw new InvalidDataException("Unknown operation.");
        }
    }
}
