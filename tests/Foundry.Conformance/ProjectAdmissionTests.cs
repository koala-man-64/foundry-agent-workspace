using System.Text.Json;
using System.Text.RegularExpressions;
using Foundry.Platform;
using Foundry.Protocol;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

/// <summary>project.add through DevelopmentChat against the committed Node outcomes (tests/p2/project-admission.test.ts).</summary>
public sealed partial class ProjectAdmissionTests
{
    private static readonly JsonElement Corpus = RepositoryFixture.ReadCorpus("tests/p2/project-admission-vectors.json");
    private static readonly string[] RaceTables = ["projects", "events", "intents"];

    public static IEnumerable<object[]> Cases()
    {
        var index = 0;
        foreach (var item in Corpus.GetProperty("cases").EnumerateArray()) yield return [item.GetProperty("name").GetString()!, index++];
    }

    [Theory, MemberData(nameof(Cases))]
    public async Task FoldersMatchCommittedNodeProjectsRowsAndEvents(string name, int index)
    {
        var item = Corpus.GetProperty("cases")[index];
        Assert.Equal(name, item.GetProperty("name").GetString());
        // A root-relative path names the scratch folder only when the working directory and the temporary folder share a
        // drive, as they did where the oracle recorded it; a CI runner may keep its workspace and TEMP on different drives.
        if (item.TryGetProperty("sameDrive", out _) && !string.Equals(Path.GetPathRoot(Environment.CurrentDirectory), Path.GetPathRoot(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase))
            Assert.Skip("The working directory and the temporary folder are on different drives, so a root-relative path cannot name the scratch folder.");
        using var fixture = RepositoryFixture.Create("foundry-p2-project-add-");
        await fixture.Build(item.GetProperty("tree"));
        var data = Directory.CreateDirectory(fixture.Local("data")).FullName;
        string Expand(string raw) => raw.Replace("{scratch-nodrive}", fixture.Scratch[2..], StringComparison.Ordinal)
            .Replace("{scratch/}", fixture.Scratch.Replace('\\', '/'), StringComparison.Ordinal).Replace("{scratch}", fixture.Scratch, StringComparison.Ordinal);
        await using var loop = new RuntimeLoop();
        var (calls, projects, events) = await loop.Invoke(async () =>
        {
            var notifications = new List<WorkspaceEvent>();
            using var store = new Store(loop, data, Path.Combine(fixture.Scratch, "injected-root"), publish: notifications.Add);
            var identities = new Dictionary<string, string>(StringComparer.Ordinal);
            var first = store.Scalar("SELECT COALESCE(MAX(sequence),0) FROM events");
            var chat = new DevelopmentChat(loop, store, fixture.Environment);
            var outcomes = new List<(object? Result, string? Error)>();
            async Task<(object? Result, string? Error)> Settle(Task<object?> operation)
            {
                try { return (Stable(fixture.Normalize(await operation), identities), null); }
                catch (InvalidOperationException exception) { return (null, (string?)fixture.Normalize(exception.Message)); }
            }
            var paths = item.GetProperty("paths").EnumerateArray().Select(raw => Expand(raw.GetString()!)).ToList();
            if (item.TryGetProperty("concurrent", out _))
            {
                // Both requests are admitted before either settles, as the Node oracle's Promise.all dispatches them.
                var pending = paths.Select(path => chat.Dispatch("project.add", new() { ["path"] = path })).ToList();
                foreach (var operation in pending) outcomes.Add(await Settle(operation));
            }
            else foreach (var path in paths) outcomes.Add(await Settle(chat.Dispatch("project.add", new() { ["path"] = path })));
            List<Dictionary<string, object?>> Parsed(List<Dictionary<string, object?>> rows) =>
                [.. rows.Select(row => new Dictionary<string, object?>(row) { ["data"] = PersistedJson.Parse((string)row["data"]!) })];
            var rows = Stable(fixture.Normalize(Parsed(store.Rows("SELECT path_key, data FROM projects ORDER BY rowid"))), identities);
            var log = Stable(fixture.Normalize(Parsed(store.Rows("SELECT sequence - $p0 AS offset, type, task_id, data FROM events WHERE sequence > $p0 ORDER BY sequence", first))), identities);
            // Every committed project notification was published after its commit, in order.
            Assert.Equal(store.Rows("SELECT sequence FROM events WHERE sequence > $p0 ORDER BY sequence", first).Select(row => (long)row["sequence"]!), notifications.Select(item => item.Sequence));
            await chat.Shutdown();
            return (outcomes, rows, log);
        });
        var expected = item.GetProperty("expected");
        Assert.Equal(expected.GetProperty("calls").GetArrayLength(), calls.Count);
        for (var call = 0; call < calls.Count; call++)
        {
            var outcome = item.TryGetProperty("native", out var native) && native.TryGetProperty(call.ToString(System.Globalization.CultureInfo.InvariantCulture), out var difference)
                ? difference.GetProperty("outcome") : expected.GetProperty("calls")[call];
            var (result, error) = calls[call];
            if (outcome.TryGetProperty("result", out var value))
            {
                Assert.True(error is null, $"call {call}: {error}");
                var actual = JsonSerializer.SerializeToElement(result);
                Assert.True(JsonElement.DeepEquals(value, actual), $"call {call}: expected {value.GetRawText()}\nactual   {actual.GetRawText()}");
            }
            else if (outcome.TryGetProperty("error", out var message)) Assert.Equal(message.GetString(), error);
            else { Assert.True(outcome.TryGetProperty("systemError", out _)); Assert.NotNull(error); }
        }
        Assert.True(JsonElement.DeepEquals(expected.GetProperty("projects"), JsonSerializer.SerializeToElement(projects)), JsonSerializer.Serialize(projects));
        Assert.True(JsonElement.DeepEquals(expected.GetProperty("events"), JsonSerializer.SerializeToElement(events)), JsonSerializer.Serialize(events));
    }

    [Fact]
    public void OracleSourceBindingsAreCurrent()
    {
        Assert.Equal(1, Corpus.GetProperty("schemaVersion").GetInt32());
        RepositoryFixture.AssertOracleSources(Corpus);
    }

    [Fact]
    public async Task FolderIdentityMatchesSpellingsOfOneFolderAndRefusesAliases()
    {
        using var fixture = RepositoryFixture.Create("foundry-p2-folder-identity-");
        fixture.Write("Folder/child/a.txt", "a"); fixture.Write("other/a.txt", "a");
        await fixture.Junction("alias", "Folder");
        var folder = fixture.Local("Folder");
        Assert.True(RepositoryPaths.SameFolder(folder, folder));
        Assert.True(RepositoryPaths.SameFolder(fixture.Local("FOLDER"), folder));
        Assert.True(RepositoryPaths.SameFolder(folder + "\\", folder));
        Assert.True(RepositoryPaths.SameFolder(fixture.Scratch.Replace('\\', '/') + "/Folder", folder));
        Assert.True(RepositoryPaths.SameFolder(fixture.Local("Folder/child/.."), folder));
        Assert.False(RepositoryPaths.SameFolder(fixture.Local("other"), folder));
        Assert.False(RepositoryPaths.SameFolder(fixture.Local("Folder/child"), folder));
        Assert.False(RepositoryPaths.SameFolder(fixture.Local("alias"), folder));
        Assert.False(RepositoryPaths.SameFolder(folder, fixture.Local("alias")));
        Assert.False(RepositoryPaths.SameFolder(fixture.Local("missing"), folder));
        Assert.False(RepositoryPaths.SameFolder(@"\\server\share\Folder", folder));
        Assert.False(RepositoryPaths.SameFolder(folder, @"\\?\" + folder));
    }

    [Fact]
    public void AShortSpellingOfOneFolderMatchesItsLongName()
    {
        using var fixture = RepositoryFixture.Create("foundry-p2-folder-short-name-");
        var longName = Directory.CreateDirectory(fixture.Local("a folder with a long name")).FullName;
        var shortName = ShortPath(longName);
        if (shortName is null || string.Equals(shortName, longName, StringComparison.OrdinalIgnoreCase)) Assert.Skip("This volume does not generate short (8.3) names.");
        Assert.True(RepositoryPaths.SameFolder(shortName, longName));
    }

    [Fact]
    public async Task FoldersThatDifferOnlyInCaseStayDistinctInACaseSensitiveDirectory()
    {
        using var fixture = RepositoryFixture.Create("foundry-p2-folder-case-");
        var sensitive = Directory.CreateDirectory(fixture.Local("sensitive")).FullName;
        if (!await CaseSensitive(sensitive)) Assert.Skip("fsutil cannot enable per-directory case sensitivity here.");
        Directory.CreateDirectory(Path.Combine(sensitive, "Foo")); Directory.CreateDirectory(Path.Combine(sensitive, "foo"));
        Assert.False(RepositoryPaths.SameFolder(Path.Combine(sensitive, "foo"), Path.Combine(sensitive, "Foo")));
        Assert.True(RepositoryPaths.SameFolder(Path.Combine(sensitive, "Foo"), Path.Combine(sensitive, "Foo")));
    }

    [Fact]
    public async Task AnIdentityChangeDuringClassificationSavesNothing()
    {
        using var fixture = RepositoryFixture.Create("foundry-p2-project-race-");
        fixture.Write("repo/README.md", "hello\n");
        await fixture.Git("-C", "repo", "init", "-q"); await fixture.Git("-C", "repo", "add", "-A"); await fixture.Git("-C", "repo", "commit", "-qm", "fixture");
        await fixture.Git("init", "-q", "other");
        var data = Directory.CreateDirectory(fixture.Local("data")).FullName;
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            var notifications = new List<WorkspaceEvent>();
            using var store = new Store(loop, data, Path.Combine(fixture.Scratch, "injected-root"), publish: notifications.Add);
            var chat = new DevelopmentChat(loop, store, fixture.Environment);
            string Snapshot() => JsJson.Stringify(RaceTables.Select(table => store.Rows($"SELECT * FROM {table}")))!;
            var before = Snapshot();
            // While classification runs Git, the repository's common directory is redirected to another repository.
            var redirected = false;
            chat.Repositories.Git.Launching = _ =>
            {
                if (redirected) return;
                redirected = true; File.WriteAllText(fixture.Local("repo/.git/commondir"), "../../other/.git\n");
            };
            var error = await Assert.ThrowsAsync<WorkspaceReadException>(() => chat.Dispatch("project.add", new() { ["path"] = fixture.Local("repo") }));
            Assert.Contains("Project channel identity changed during admission.", error.Message, StringComparison.Ordinal);
            Assert.Equal(before, Snapshot()); Assert.Empty(notifications);
            // Once the identity is restored, the same request admits the repository.
            File.Delete(fixture.Local("repo/.git/commondir")); chat.Repositories.Git.Launching = null;
            var project = (Dictionary<string, object?>)(await chat.Dispatch("project.add", new() { ["path"] = fixture.Local("repo") }))!;
            Assert.Equal("git", project["kind"]); Assert.Single(notifications);
            await chat.Shutdown(); return 0;
        });
    }

    [Fact]
    public async Task IdentitiesNameEveryPrefixFromTheDriveRoot()
    {
        using var fixture = RepositoryFixture.Create("foundry-p2-folder-identities-");
        fixture.Write("a/b/c.txt", "c");
        await Task.CompletedTask;
        using var lease = DirectoryLease.AcquireExisting(fixture.Local("a/b"));
        using var parent = DirectoryLease.AcquireExisting(fixture.Local("a"));
        var identities = lease.Identities();
        Assert.Equal(fixture.Local("a/b").Split('\\', StringSplitOptions.RemoveEmptyEntries).Length, identities.Count);
        Assert.Equal(parent.Identities(), identities.Take(identities.Count - 1));
        Assert.Equal(identities.Count, identities.Distinct().Count());
    }

    /// <summary>Generated identities (UUIDs) become placeholders in order of appearance; wall-clock stamps become {stamp}.</summary>
    private static object? Stable(object? value, Dictionary<string, string> identities) => value switch
    {
        string text when Uuid().IsMatch(text) => identities.TryGetValue(text, out var known) ? known : identities[text] = $"{{project-{identities.Count + 1}}}",
        string text when Stamp().IsMatch(text) => "{stamp}",
        IDictionary<string, object?> map => map.ToDictionary(pair => pair.Key, pair => Stable(pair.Value, identities)),
        string text => text,
        System.Collections.IEnumerable items => items.Cast<object?>().Select(item => Stable(item, identities)).ToList(),
        _ => value,
    };

    [GeneratedRegex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", RegexOptions.CultureInvariant)]
    private static partial Regex Uuid();
    [GeneratedRegex(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$", RegexOptions.CultureInvariant)]
    private static partial Regex Stamp();

    private static string? ShortPath(string path)
    {
        var buffer = new char[1024];
        var length = GetShortPathName(path, buffer, (uint)buffer.Length);
        return length == 0 || length >= buffer.Length ? null : new string(buffer, 0, (int)length);
    }

    private static async Task<bool> CaseSensitive(string directory)
    {
        var info = new System.Diagnostics.ProcessStartInfo("fsutil.exe") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var argument in new[] { "file", "setCaseSensitiveInfo", directory, "enable" }) info.ArgumentList.Add(argument);
        using var process = System.Diagnostics.Process.Start(info)!;
        await process.WaitForExitAsync(TestContext.Current.CancellationToken);
        return process.ExitCode == 0;
    }

#pragma warning disable SYSLIB1054 // A test-only probe; the test project does not enable unsafe code for generated interop.
    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
    private static extern uint GetShortPathName(string longPath, char[] shortPath, uint length);
#pragma warning restore SYSLIB1054
}
