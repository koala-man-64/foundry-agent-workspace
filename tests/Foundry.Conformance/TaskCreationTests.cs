using System.Text.Json;
using System.Text.RegularExpressions;
using Foundry.Protocol;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

/// <summary>task.create through DevelopmentChat against the committed Node outcomes, rows and repository state (tests/p2/task-creation.test.ts).</summary>
public sealed partial class TaskCreationTests
{
    private static readonly JsonElement Corpus = RepositoryFixture.ReadCorpus("tests/p2/task-creation-vectors.json");

    public static IEnumerable<object[]> Cases()
    {
        var index = 0;
        foreach (var item in Corpus.GetProperty("cases").EnumerateArray()) yield return [item.GetProperty("name").GetString()!, index++];
    }

    [Theory, MemberData(nameof(Cases))]
    public Task TasksMatchCommittedNodeRowsAndRepositoryState(string name, int index) => Replay(name, index, removable: false);

    /// <summary>The same committed Node outcomes with the fixture on a removable drive (Rudy, 19 October 2026): TypeScript
    /// reads no drive type for project folders, so nothing may change. The data directory and the worktree base inside it stay fixed.</summary>
    [Theory, MemberData(nameof(Cases))]
    public Task TasksOnARemovableDriveMatchTheSameRowsAndRepositoryState(string name, int index) => Replay(name, index, removable: true);

    private static async Task Replay(string name, int index, bool removable)
    {
        var item = Corpus.GetProperty("cases")[index];
        Assert.Equal(name, item.GetProperty("name").GetString());
        using var fixture = RepositoryFixture.Create("foundry-p2-task-create-");
        await fixture.Build(item.GetProperty("tree"));
        var data = Directory.CreateDirectory(fixture.Local("data")).FullName;
        using var drive = RemovableDrive.Place(removable, fixture.Scratch, data);
        var repositories = item.TryGetProperty("repositories", out var listed) ? listed.EnumerateArray().Select(entry => entry.GetString()!).ToList() : ["repo"];
        var unchanged = item.TryGetProperty("native", out var native);
        var gitBefore = unchanged ? await GitState(fixture, repositories) : null;
        await using var loop = new RuntimeLoop();
        var identities = new Dictionary<string, string>(StringComparer.Ordinal);
        var (calls, rows, seededIntents) = await loop.Invoke(async () =>
        {
            var notifications = new List<WorkspaceEvent>();
            using var store = new Store(loop, data, Path.Combine(fixture.Scratch, "injected-root"), publish: notifications.Add);
            if (item.TryGetProperty("profiles", out var profiles))
                foreach (var profile in profiles.EnumerateArray()) store.SaveProfile((Dictionary<string, object?>)PersistedJson.Parse(profile.GetRawText())!);
            if (item.TryGetProperty("intents", out var intents))
                foreach (var intent in intents.EnumerateArray())
                    store.Execute("INSERT INTO intents VALUES($p0,$p1,$p2,$p3)", intent.GetProperty("id").GetString(), intent.GetProperty("kind").GetString(), JsJson.Stringify(PersistedJson.Parse(intent.GetProperty("data").GetRawText())), intent.GetProperty("state").GetString());
            var seeded = store.Rows("SELECT * FROM intents ORDER BY rowid").Count;
            var first = store.Scalar("SELECT COALESCE(MAX(sequence),0) FROM events");
            var chat = new DevelopmentChat(loop, store, fixture.Environment);
            var outcomes = new List<(object? Result, string? Error)>();
            async Task<(object? Result, string? Error)> Settle(Task<object?> operation)
            {
                try { return (Stable(fixture.Normalize(await operation), identities), null); }
                catch (InvalidOperationException exception) { return (null, (string?)Stable(fixture.Normalize(exception.Message), identities)); }
            }
            Task<object?> Dispatch(JsonElement call) => chat.Dispatch(call.GetProperty("method").GetString()!,
                (Dictionary<string, object?>)PersistedJson.Parse(Expand(call.GetProperty("params").GetRawText(), fixture.Scratch))!);
            if (item.TryGetProperty("concurrent", out _))
            {
                var pending = item.GetProperty("calls").EnumerateArray().Select(Dispatch).ToList();
                foreach (var operation in pending) outcomes.Add(await Settle(operation));
            }
            else
                foreach (var call in item.GetProperty("calls").EnumerateArray())
                {
                    if (call.TryGetProperty("step", out var step)) await fixture.Build(JsonDocument.Parse($"[{step.GetRawText()}]").RootElement);
                    else outcomes.Add(await Settle(Dispatch(call)));
                }
            List<Dictionary<string, object?>> Parsed(List<Dictionary<string, object?>> found) =>
                [.. found.Select(row => new Dictionary<string, object?>(row) { ["data"] = PersistedJson.Parse((string)row["data"]!) })];
            var state = new Dictionary<string, object?>
            {
                ["tasks"] = Parsed(store.Rows("SELECT data FROM tasks ORDER BY rowid")),
                ["intents"] = Parsed(store.Rows("SELECT kind, data, state FROM intents ORDER BY rowid")),
                ["projects"] = Parsed(store.Rows("SELECT path_key, data FROM projects ORDER BY rowid")),
                ["events"] = Parsed(store.Rows("SELECT sequence - $p0 AS offset, type, task_id, data FROM events WHERE sequence > $p0 ORDER BY sequence", first)),
            };
            // Every committed notification was published after its commit, in order.
            Assert.Equal(store.Rows("SELECT sequence FROM events WHERE sequence > $p0 ORDER BY sequence", first).Select(row => (long)row["sequence"]!), notifications.Select(entry => entry.Sequence));
            await chat.Shutdown();
            return (outcomes, state, seeded);
        });
        var expected = item.GetProperty("expected");
        Assert.Equal(expected.GetProperty("calls").GetArrayLength(), calls.Count);
        for (var call = 0; call < calls.Count; call++)
        {
            var outcome = unchanged && native.GetProperty("outcomes").TryGetProperty(call.ToString(System.Globalization.CultureInfo.InvariantCulture), out var difference)
                ? difference : expected.GetProperty("calls")[call];
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
        if (unchanged)
        {
            // The approved difference refuses before any intent: no row, notification, ref or worktree appears.
            foreach (var table in new[] { "tasks", "projects", "events" }) Assert.Empty((List<Dictionary<string, object?>>)rows[table]!);
            Assert.Equal(seededIntents, ((List<Dictionary<string, object?>>)rows["intents"]!).Count);
            Assert.Equal(JsJson.Stringify(gitBefore), JsJson.Stringify(await GitState(fixture, repositories)));
            return;
        }
        var git = new Dictionary<string, object?>();
        foreach (var repository in repositories)
            git[repository] = new Dictionary<string, object?>
            {
                ["refs"] = Lines(await fixture.GitOutput("-C", fixture.Local(repository), "for-each-ref", "--format=%(refname) %(objectname)")),
                ["worktrees"] = Lines(await fixture.GitOutput("-C", fixture.Local(repository), "worktree", "list", "--porcelain")),
            };
        var created = new List<object?>();
        foreach (var task in (List<Dictionary<string, object?>>)rows["tasks"]!)
            if (((Dictionary<string, object?>)task["data"]!).GetValueOrDefault("worktreePath") is string worktree)
                created.Add(new Dictionary<string, object?>
                {
                    ["status"] = await fixture.GitOutput("-C", worktree, "status", "--porcelain=v1", "--untracked-files=all"),
                    ["files"] = Lines(await fixture.GitOutput("-C", worktree, "ls-files")),
                });
        var observed = (Dictionary<string, object?>)Stable(fixture.Normalize(new Dictionary<string, object?> { ["rows"] = rows, ["git"] = git, ["created"] = created }), identities)!;
        // Git lists refs and worktrees by their random identities; after normalization they are ordered by placeholder.
        foreach (var entry in ((Dictionary<string, object?>)observed["git"]!).Values.Cast<Dictionary<string, object?>>())
        {
            entry["refs"] = ((List<object?>)entry["refs"]!).Cast<string>().Order(StringComparer.Ordinal).ToList();
            var blocks = new List<List<string>>();
            foreach (var line in ((List<object?>)entry["worktrees"]!).Cast<string>())
            {
                if (line.StartsWith("worktree ", StringComparison.Ordinal) || blocks.Count == 0) blocks.Add([]);
                blocks[^1].Add(line);
            }
            entry["worktrees"] = blocks.Select(block => string.Join('\n', block)).Order(StringComparer.Ordinal).SelectMany(block => block.Split('\n')).ToList();
        }
        foreach (var part in new[] { "rows", "git", "created" })
        {
            var actual = JsonSerializer.SerializeToElement(observed[part]);
            Assert.True(JsonElement.DeepEquals(expected.GetProperty(part), actual), $"{part}: expected {expected.GetProperty(part).GetRawText()}\nactual   {actual.GetRawText()}");
        }
    }

    private static Dictionary<string, object?> Create(string projectPath, string title = "Fixture task") => new()
    {
        ["title"] = title, ["projectPath"] = projectPath, ["profileId"] = Store.FakeProfileId, ["tokenBudget"] = 100000, ["mode"] = "chat",
    };

    private static async Task<RepositoryFixture> Repositories(string prefix)
    {
        var fixture = RepositoryFixture.Create(prefix);
        fixture.Write("repo/README.md", "hello\n");
        await fixture.Git("-C", "repo", "init", "-q"); await fixture.Git("-C", "repo", "add", "-A"); await fixture.Git("-C", "repo", "commit", "-qm", "fixture");
        await fixture.Git("init", "-q", "other");
        return fixture;
    }

    private static async Task<string> RepositoryState(RepositoryFixture fixture) =>
        await fixture.GitOutput("-C", fixture.Local("repo"), "for-each-ref", "--format=%(refname) %(objectname)") + "\n"
        + await fixture.GitOutput("-C", fixture.Local("repo"), "worktree", "list", "--porcelain");

    /// <summary>
    /// folder-admission.test.ts "retains admission for both queued worktree requests": native refuses aliases, so the
    /// identity is changed the way pins still allow, by redirecting the common directory while the first request waits
    /// inside its serialized section. Both requests must fail as known pre-mutation failures and change nothing.
    /// </summary>
    [Fact]
    public async Task QueuedRequestsKeepTheirAdmittedIdentityAndFailBeforeMutation()
    {
        using var fixture = await Repositories("foundry-p2-queued-identity-");
        var before = await RepositoryState(fixture);
        var data = Directory.CreateDirectory(fixture.Local("data")).FullName;
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            using var store = new Store(loop, data, Path.Combine(fixture.Scratch, "injected-root"));
            var chat = new DevelopmentChat(loop, store, fixture.Environment);
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var gated = false;
            chat.Repositories.PreparingWorktreeBase = async () => { if (gated) return; gated = true; entered.SetResult(); await release.Task; };
            var first = chat.Dispatch("task.create", Create(fixture.Local("repo"), "First"));
            await entered.Task;
            var second = chat.Dispatch("task.create", Create(fixture.Local("repo"), "Second"));
            File.WriteAllText(fixture.Local("repo/.git/commondir"), "../../other/.git\n");
            release.SetResult();
            foreach (var request in new[] { first, second })
                Assert.Contains("identity changed", (await Assert.ThrowsAsync<WorkspaceReadException>(() => request)).Message, StringComparison.Ordinal);
            File.Delete(fixture.Local("repo/.git/commondir"));
            Assert.Empty(store.Rows("SELECT * FROM tasks"));
            Assert.Equal(["complete", "complete"], store.Rows("SELECT state FROM intents WHERE kind='worktree.create' ORDER BY rowid").Select(row => (string)row["state"]!));
            Assert.Equal(0L, store.UnknownWorktreeIntents());
            await chat.Shutdown(); return 0;
        });
        Assert.Equal(before, await RepositoryState(fixture));
    }

    /// <summary>folder-admission.test.ts "refuses alias rebinding during final Git executable lookup": an identity change
    /// after the base commit and filters were checked, just before `worktree add`, is a known pre-mutation failure.</summary>
    [Fact]
    public async Task AnIdentityChangeAtTheFinalBoundaryIsAKnownPreMutationFailure()
    {
        using var fixture = await Repositories("foundry-p2-final-boundary-");
        var before = await RepositoryState(fixture);
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            var service = new RepositoryService(loop, fixture.Local("data/wt"), fixture.Environment);
            using var admission = RepositoryAdmission.Open(loop, fixture.Local("repo"));
            var identity = admission.Identity!;
            service.PreparingWorktreeBase = () => { File.WriteAllText(fixture.Local("repo/.git/commondir"), "../../other/.git\n"); return Task.CompletedTask; };
            var error = await Assert.ThrowsAsync<RepositoryException>(() => service.CreateTaskWorktree(fixture.Local("repo"), "18181818-0000-4000-8000-000000000013", identity));
            Assert.Equal("none", error.Outcome); Assert.False(error.MutationStarted);
            File.Delete(fixture.Local("repo/.git/commondir"));
            return 0;
        });
        Assert.Equal(before, await RepositoryState(fixture));
    }

    /// <summary>
    /// folder-admission.test.ts "retains an unknown outcome when checkout fails after worktree add has actually run": the
    /// branch and worktree exist, the intent is unknown, no task is saved, every later creation is refused, and a restart
    /// never turns it back into success.
    /// </summary>
    [Fact]
    public async Task AFailureAfterWorktreeAddRetainsAnUnknownOutcomeThatBlocksLaterCreation()
    {
        using var fixture = await Repositories("foundry-p2-post-mutation-");
        var data = Directory.CreateDirectory(fixture.Local("data")).FullName;
        string? taskId = null;
        await using (var loop = new RuntimeLoop())
        {
            await loop.Invoke(async () =>
            {
                using var store = new Store(loop, data, Path.Combine(fixture.Scratch, "injected-root"));
                var chat = new DevelopmentChat(loop, store, fixture.Environment);
                chat.Repositories.Git.Launching = spec =>
                {
                    if (spec.CommandLine.Contains(" checkout --no-recurse-submodules ", StringComparison.Ordinal)) throw new IOException("Injected failure after worktree add.");
                };
                var error = await Assert.ThrowsAsync<WorkspaceReadException>(() => chat.Dispatch("task.create", Create(fixture.Local("repo"))));
                Assert.Contains("Injected failure after worktree add.", error.Message, StringComparison.Ordinal);
                var intent = store.Rows("SELECT data,state FROM intents WHERE kind='worktree.create'").Single();
                Assert.Equal("unknown", intent["state"]);
                taskId = (string)((Dictionary<string, object?>)PersistedJson.Parse((string)intent["data"]!)!)["taskId"]!;
                Assert.Empty(store.Rows("SELECT * FROM tasks"));
                chat.Repositories.Git.Launching = null;
                var blocked = await Assert.ThrowsAsync<WorkspaceReadException>(() => chat.Dispatch("task.create", Create(fixture.Local("repo"))));
                Assert.Equal("An earlier worktree creation has an unknown outcome. Inspect the retained worktree and database intent before creating another task.", blocked.Message);
                Assert.Single(store.Rows("SELECT * FROM intents WHERE kind='worktree.create'"));
                await chat.Shutdown(); return 0;
            });
        }
        Assert.Contains($"refs/heads/codex/task/{taskId}", await fixture.GitOutput("-C", fixture.Local("repo"), "for-each-ref", "--format=%(refname)"), StringComparison.Ordinal);
        Assert.Contains(taskId!, await fixture.GitOutput("-C", fixture.Local("repo"), "worktree", "list", "--porcelain"), StringComparison.Ordinal);
        await using (var reopened = new RuntimeLoop())
        {
            await reopened.Invoke(() =>
            {
                using var store = new Store(reopened, data, Path.Combine(fixture.Scratch, "injected-root"));
                Assert.Equal(1L, store.UnknownWorktreeIntents());
                return Task.FromResult(0);
            });
        }
    }

    /// <summary>A creation interrupted after its intent (a crash or kill) is recovered as unknown on restart, never retried.</summary>
    [Fact]
    public async Task APendingCreationIsRecoveredAsUnknownAndBlocksCreation()
    {
        using var fixture = await Repositories("foundry-p2-pending-recovery-");
        var data = Directory.CreateDirectory(fixture.Local("data")).FullName;
        await using (var loop = new RuntimeLoop())
            await loop.Invoke(() =>
            {
                using var store = new Store(loop, data, Path.Combine(fixture.Scratch, "injected-root"));
                store.Intent("worktree.create", new Dictionary<string, object?> { ["taskId"] = "18181818-0000-4000-8000-000000000015", ["projectPath"] = fixture.Local("repo") });
                return Task.FromResult(0);
            });
        await using var reopened = new RuntimeLoop();
        await reopened.Invoke(async () =>
        {
            using var store = new Store(reopened, data, Path.Combine(fixture.Scratch, "injected-root"));
            Assert.Equal(1L, store.UnknownWorktreeIntents());
            var chat = new DevelopmentChat(reopened, store, fixture.Environment);
            await Assert.ThrowsAsync<WorkspaceReadException>(() => chat.Dispatch("task.create", Create(fixture.Local("repo"))));
            Assert.Empty(store.Rows("SELECT * FROM tasks"));
            await chat.Shutdown(); return 0;
        });
    }

    [Fact]
    public void OracleSourceBindingsAreCurrent()
    {
        Assert.Equal(1, Corpus.GetProperty("schemaVersion").GetInt32());
        RepositoryFixture.AssertOracleSources(Corpus);
        foreach (var item in Corpus.GetProperty("cases").EnumerateArray())
            if (item.TryGetProperty("native", out var native)) Assert.False(string.IsNullOrWhiteSpace(native.GetProperty("difference").GetString()));
    }

    private static async Task<object> GitState(RepositoryFixture fixture, List<string> repositories)
    {
        var state = new Dictionary<string, object?>();
        foreach (var repository in repositories)
            state[repository] = new[] { await fixture.GitOutput("-C", fixture.Local(repository), "for-each-ref", "--format=%(refname) %(objectname)"), await fixture.GitOutput("-C", fixture.Local(repository), "worktree", "list", "--porcelain") };
        return state;
    }

    private static List<string> Lines(string text) => [.. text.Split('\n').Where(line => line.Length > 0)];

    private static string Expand(string json, string scratch) =>
        json.Replace("{scratch/}", scratch.Replace('\\', '/'), StringComparison.Ordinal).Replace("{scratch}", JsonEncodedText.Encode(scratch).ToString(), StringComparison.Ordinal);

    /// <summary>Generated identities anywhere in a string become placeholders in order of appearance; stamps become {stamp}.</summary>
    private static object? Stable(object? value, Dictionary<string, string> identities) => value switch
    {
        string text when Stamp().IsMatch(text) => "{stamp}",
        string text => Uuid().Replace(text, match => identities.TryGetValue(match.Value, out var known) ? known : identities[match.Value] = $"{{id-{identities.Count + 1}}}"),
        IDictionary<string, object?> map => map.ToDictionary(pair => pair.Key, pair => Stable(pair.Value, identities)),
        System.Collections.IEnumerable items => items.Cast<object?>().Select(item => Stable(item, identities)).ToList(),
        _ => value,
    };

    [GeneratedRegex("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", RegexOptions.CultureInvariant)]
    private static partial Regex Uuid();
    [GeneratedRegex(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$", RegexOptions.CultureInvariant)]
    private static partial Regex Stamp();
}
