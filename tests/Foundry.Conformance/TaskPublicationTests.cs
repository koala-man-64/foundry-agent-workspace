using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Foundry.Protocol;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

/// <summary>task.commit, task.push, task.reconcilePublication and task.retire through DevelopmentChat against the
/// committed Node outcomes, rows and repository state (tests/p2/task-publication.test.ts).</summary>
public sealed partial class TaskPublicationTests
{
    private static readonly JsonElement Corpus = RepositoryFixture.ReadCorpus("tests/p2/task-publication-vectors.json");
    private static readonly string[] PlantedHooks = ["post-commit", "post-checkout", "reference-transaction"];

    public static IEnumerable<object[]> Cases()
    {
        var index = 0;
        foreach (var item in Corpus.GetProperty("cases").EnumerateArray()) yield return [item.GetProperty("name").GetString()!, index++];
    }

    [Theory, MemberData(nameof(Cases))]
    public async Task PublicationMatchesCommittedNodeRowsAndRepositoryState(string name, int index)
    {
        var item = Corpus.GetProperty("cases")[index];
        Assert.Equal(name, item.GetProperty("name").GetString());
        using var fixture = RepositoryFixture.Create("foundry-p2-publication-");
        var created = new List<(string Id, string Worktree)>();
        string Expand(string text) => text.Replace("{scratch}", fixture.Scratch, StringComparison.Ordinal)
            .Replace("{task0}", created.Count > 0 ? created[0].Worktree : "{task0}", StringComparison.Ordinal).Replace("{id0}", created.Count > 0 ? created[0].Id : "{id0}", StringComparison.Ordinal);
        await fixture.Build(JsonDocument.Parse(Expand(item.GetProperty("tree").GetRawText().Replace("{scratch}", JsonEncodedText.Encode(fixture.Scratch).ToString(), StringComparison.Ordinal))).RootElement);
        var data = Directory.CreateDirectory(fixture.Local("data")).FullName;
        var identities = new Dictionary<string, string>(StringComparer.Ordinal);
        await using var loop = new RuntimeLoop();
        var (calls, rows) = await loop.Invoke(async () =>
        {
            var notifications = new List<WorkspaceEvent>();
            using var store = new Store(loop, data, Path.Combine(fixture.Scratch, "injected-root"), publish: notifications.Add);
            var first = store.Scalar("SELECT COALESCE(MAX(sequence),0) FROM events");
            var chat = new DevelopmentChat(loop, store, fixture.Environment);
            var outcomes = new List<(object? Result, string? Error)>();
            async Task<(object? Result, string? Error)> Settle(Task<object?> operation)
            {
                try
                {
                    var value = await operation;
                    if (value is Dictionary<string, object?> task && task.GetValueOrDefault("worktreePath") is string worktree && task.GetValueOrDefault("id") is string id
                        && !created.Any(entry => entry.Id == id)) created.Add((id, worktree));
                    return (Stable(fixture.Normalize(value), identities), null);
                }
                catch (InvalidOperationException exception) { return (null, (string?)Stable(fixture.Normalize(exception.Message), identities)); }
            }
            Task<object?> Dispatch(JsonElement call)
            {
                var parameters = (Dictionary<string, object?>)PersistedJson.Parse(call.GetProperty("params").GetRawText())!;
                foreach (var key in parameters.Keys.ToList()) if (parameters[key] is string text) parameters[key] = Expand(text);
                return chat.Dispatch(call.GetProperty("method").GetString()!, parameters);
            }
            foreach (var call in item.GetProperty("calls").EnumerateArray())
            {
                if (call.TryGetProperty("write", out var write)) File.WriteAllBytes(Expand(write.GetString()!), Encoding.UTF8.GetBytes(call.GetProperty("text").GetString()!));
                else if (call.TryGetProperty("delete", out var deleted)) File.Delete(Expand(deleted.GetString()!));
                else if (call.TryGetProperty("git", out var git)) await fixture.Git([.. git.EnumerateArray().Select(argument => Expand(argument.GetString()!))]);
                else if (call.TryGetProperty("concurrent", out var concurrent))
                {
                    // Both are admitted before either settles, as the Node oracle's Promise.all dispatches them.
                    var pending = concurrent.EnumerateArray().Select(Dispatch).ToList();
                    foreach (var operation in pending) outcomes.Add(await Settle(operation));
                }
                else outcomes.Add(await Settle(Dispatch(call)));
            }
            List<Dictionary<string, object?>> Parsed(List<Dictionary<string, object?>> found) =>
                [.. found.Select(row => new Dictionary<string, object?>(row) { ["data"] = PersistedJson.Parse((string)row["data"]!) })];
            var state = new Dictionary<string, object?>
            {
                ["tasks"] = Parsed(store.Rows("SELECT data FROM tasks ORDER BY rowid")),
                ["intents"] = Parsed(store.Rows("SELECT kind, data, state FROM intents ORDER BY rowid")),
                ["events"] = Parsed(store.Rows("SELECT sequence - $p0 AS offset, type, task_id, data FROM events WHERE sequence > $p0 ORDER BY sequence", first)),
            };
            Assert.Equal(store.Rows("SELECT sequence FROM events WHERE sequence > $p0 ORDER BY sequence", first).Select(row => (long)row["sequence"]!), notifications.Select(entry => entry.Sequence));
            await chat.Shutdown();
            return (outcomes, state);
        });
        var expected = item.GetProperty("expected");
        Assert.Equal(expected.GetProperty("calls").GetArrayLength(), calls.Count);
        for (var call = 0; call < calls.Count; call++)
        {
            var outcome = expected.GetProperty("calls")[call];
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
        var repositories = new Dictionary<string, object?>();
        foreach (var repository in item.GetProperty("repositories").EnumerateArray().Select(entry => entry.GetString()!))
        {
            if (!Directory.Exists(fixture.Local(repository))) continue;
            var listed = new Dictionary<string, object?> { ["refs"] = Lines(await fixture.GitOutput("-C", fixture.Local(repository), "for-each-ref", "--format=%(refname) %(objectname)")) };
            if (!repository.EndsWith(".git", StringComparison.Ordinal)) listed["worktrees"] = Lines(await fixture.GitOutput("-C", fixture.Local(repository), "worktree", "list", "--porcelain"));
            repositories[repository] = listed;
        }
        object? worktreeState = null;
        if (created.Count > 0 && Directory.Exists(created[0].Worktree))
            worktreeState = new Dictionary<string, object?>
            {
                ["status"] = await fixture.GitText("-C", created[0].Worktree, "status", "--porcelain=v1", "--untracked-files=all"),
                ["log"] = await fixture.GitText("-C", created[0].Worktree, "log", "--format=%s", "-3"),
            };
        var observed = (Dictionary<string, object?>)Stable(fixture.Normalize(new Dictionary<string, object?> { ["rows"] = rows, ["git"] = repositories, ["worktree"] = worktreeState }), identities)!;
        foreach (var part in new[] { "rows", "git", "worktree" })
        {
            var actual = JsonSerializer.SerializeToElement(observed[part]);
            Assert.True(JsonElement.DeepEquals(expected.GetProperty(part), actual), $"{part}: expected {expected.GetProperty(part).GetRawText()}\nactual   {actual.GetRawText()}");
        }
    }

    private static async Task<(RepositoryFixture Fixture, string Data)> Project(string prefix)
    {
        var fixture = RepositoryFixture.Create(prefix);
        fixture.Write("repo/README.md", "hello\n");
        await fixture.Git("-C", "repo", "init", "-q"); await fixture.Git("-C", "repo", "add", "-A"); await fixture.Git("-C", "repo", "commit", "-qm", "fixture");
        await fixture.Git("-C", "repo", "config", "user.name", "Runtime"); await fixture.Git("-C", "repo", "config", "user.email", "runtime@example.invalid");
        await fixture.Git("init", "-q", "--bare", "remote.git"); await fixture.Git("-C", "repo", "remote", "add", "origin", fixture.Local("remote.git"));
        return (fixture, Directory.CreateDirectory(fixture.Local("data")).FullName);
    }

    private static Dictionary<string, object?> CreateParameters(RepositoryFixture fixture) => new()
    {
        ["title"] = "Publication", ["projectPath"] = fixture.Local("repo"), ["profileId"] = Store.FakeProfileId, ["tokenBudget"] = 100000, ["mode"] = "chat",
    };

    /// <summary>
    /// removeWorktree's outcome: a removal that fails while the worktree is still there is "none", so the retirement
    /// intent completes and the task stays ready; one that fails after the worktree is gone is "unknown", which blocks
    /// every Git operation until reconciliation finds the worktree absent and completes it.
    /// </summary>
    [Fact]
    public async Task RetirementFailuresAreClassifiedByWhetherTheWorktreeRemains()
    {
        var (fixture, data) = await Project("foundry-p2-retire-outcome-");
        using (fixture)
        {
            await using var loop = new RuntimeLoop();
            await loop.Invoke(async () =>
            {
                using var store = new Store(loop, data, Path.Combine(fixture.Scratch, "injected-root"));
                var chat = new DevelopmentChat(loop, store, fixture.Environment);
                var task = (Dictionary<string, object?>)(await chat.Dispatch("task.create", CreateParameters(fixture)))!;
                var taskId = (string)task["id"]!; var worktree = (string)task["worktreePath"]!;
                var retire = new Dictionary<string, object?> { ["taskId"] = taskId, ["confirm"] = "retire" };
                bool Removing(Foundry.Platform.ProcessSpec spec) => spec.CommandLine.Contains(" worktree remove -- ", StringComparison.Ordinal);
                chat.Repositories.Git.Launching = spec => { if (Removing(spec)) throw new IOException("Injected failure before removal."); };
                await Assert.ThrowsAsync<WorkspaceReadException>(() => chat.Dispatch("task.retire", retire));
                Assert.Equal("complete", store.Rows("SELECT state FROM intents WHERE kind='worktree.retire'").Single()["state"]);
                Assert.Equal("idle", store.ReadTask(taskId)["status"]); Assert.True(Directory.Exists(worktree));
                // The second failure happens after the worktree is gone, as a crash after Git's removal would leave it.
                chat.Repositories.Git.Launching = spec =>
                {
                    if (!Removing(spec)) return;
                    foreach (var file in new DirectoryInfo(worktree).EnumerateFiles("*", SearchOption.AllDirectories)) file.Attributes = FileAttributes.Normal;
                    Directory.Delete(worktree, true);
                    throw new IOException("Injected failure after removal.");
                };
                await Assert.ThrowsAsync<WorkspaceReadException>(() => chat.Dispatch("task.retire", retire));
                Assert.Equal(["complete", "unknown"], store.Rows("SELECT state FROM intents WHERE kind='worktree.retire' ORDER BY rowid").Select(row => (string)row["state"]!));
                Assert.Equal("idle", store.ReadTask(taskId)["status"]);
                chat.Repositories.Git.Launching = null;
                Assert.Equal("This task has an unknown worktree retirement outcome. Reconcile state before attempting another operation.",
                    (await Assert.ThrowsAsync<WorkspaceReadException>(() => chat.Dispatch("task.commit", new() { ["taskId"] = taskId, ["message"] = "x" }))).Message);
                Assert.Equal("This task has an unknown mutation outcome. Inspect the worktree before retiring it.",
                    (await Assert.ThrowsAsync<WorkspaceReadException>(() => chat.Dispatch("task.retire", retire))).Message);
                var reconciled = (Dictionary<string, object?>)(await chat.Dispatch("task.reconcilePublication", new() { ["taskId"] = taskId }))!;
                Assert.Equal(true, reconciled["reconciled"]); Assert.Equal("Reconciled 1 intent(s).", reconciled["detail"]);
                Assert.Equal(["complete", "complete"], store.Rows("SELECT state FROM intents WHERE kind='worktree.retire' ORDER BY rowid").Select(row => (string)row["state"]!));
                await chat.Shutdown(); return 0;
            });
        }
    }

    /// <summary>Only the user's explicit push and the remote check of an unknown push may run the credential helper.</summary>
    [Fact]
    public async Task OnlyPushAndRemoteVerificationMayUseTheCredentialHelper()
    {
        var (fixture, data) = await Project("foundry-p2-credential-helper-");
        using (fixture)
        {
            await using var loop = new RuntimeLoop();
            await loop.Invoke(async () =>
            {
                using var store = new Store(loop, data, Path.Combine(fixture.Scratch, "injected-root"));
                var chat = new DevelopmentChat(loop, store, fixture.Environment);
                var launches = new List<string>();
                chat.Repositories.Git.Launching = spec => launches.Add(spec.CommandLine);
                var task = (Dictionary<string, object?>)(await chat.Dispatch("task.create", CreateParameters(fixture)))!;
                File.WriteAllText(Path.Combine((string)task["worktreePath"]!, "README.md"), "changed\n");
                await chat.Dispatch("task.commit", new() { ["taskId"] = task["id"], ["message"] = "Change" });
                await chat.Dispatch("task.push", new() { ["taskId"] = task["id"], ["remote"] = "origin", ["confirm"] = "push" });
                Assert.True(await chat.Repositories.VerifyPushOutcome(fixture.Local("repo"), (string)task["worktreePath"]!, "origin", (string)task["branch"]!, null));
                var helper = launches.Where(line => !line.Contains(" -c credential.helper= ", StringComparison.Ordinal)).ToList();
                Assert.Equal(2, helper.Count);
                Assert.Contains(" push --no-verify --porcelain -- origin ", helper[0], StringComparison.Ordinal);
                Assert.Contains(" ls-remote --heads origin ", helper[1], StringComparison.Ordinal);
                await chat.Shutdown(); return 0;
            });
        }
    }

    /// <summary>A reviewed tool action of the task whose outcome is unknown blocks publication and retirement.</summary>
    [Fact]
    public async Task AnUnknownApprovalBlocksPublicationAndRetirement()
    {
        var (fixture, data) = await Project("foundry-p2-unknown-approval-");
        using (fixture)
        {
            await using var loop = new RuntimeLoop();
            await loop.Invoke(async () =>
            {
                using var store = new Store(loop, data, Path.Combine(fixture.Scratch, "injected-root"));
                var chat = new DevelopmentChat(loop, store, fixture.Environment);
                var task = (Dictionary<string, object?>)(await chat.Dispatch("task.create", CreateParameters(fixture)))!;
                store.Execute("INSERT INTO intents VALUES('30303030-0000-4000-8000-000000000031','tool.approval',$p0,'unknown')", JsJson.Stringify(new Dictionary<string, object?> { ["id"] = "30303030-0000-4000-8000-000000000031", ["taskId"] = task["id"] }));
                File.WriteAllText(Path.Combine((string)task["worktreePath"]!, "README.md"), "changed\n");
                Assert.Equal("This task has an unknown mutation outcome. Check the outcome and inspect its worktree before publishing.",
                    (await Assert.ThrowsAsync<WorkspaceReadException>(() => chat.Dispatch("task.commit", new() { ["taskId"] = task["id"], ["message"] = "x" }))).Message);
                Assert.Equal("This task has an unknown mutation outcome. Inspect the worktree before retiring it.",
                    (await Assert.ThrowsAsync<WorkspaceReadException>(() => chat.Dispatch("task.retire", new() { ["taskId"] = task["id"], ["confirm"] = "retire" }))).Message);
                Assert.Empty(store.Rows("SELECT * FROM intents WHERE kind IN ('git.commit','worktree.retire')"));
                await chat.Shutdown(); return 0;
            });
        }
    }

    /// <summary>
    /// Review H1: a hook planted in the app-owned hooks folder after a task exists never runs. Commit and creation refuse
    /// before any Git process starts, nothing is recorded as started, and they work again once the folder is empty.
    /// </summary>
    [Fact]
    public async Task APlantedHookStopsCommitAndCreationBeforeAnyGitRuns()
    {
        var (fixture, data) = await Project("foundry-p2-planted-hook-");
        using (fixture)
        {
            var marker = fixture.Local("hook-ran");
            var hook = $"#!/bin/sh\necho ran > '{marker.Replace('\\', '/')}'\n";
            await using var loop = new RuntimeLoop();
            await loop.Invoke(async () =>
            {
                using var store = new Store(loop, data, Path.Combine(fixture.Scratch, "injected-root"));
                var chat = new DevelopmentChat(loop, store, fixture.Environment);
                var task = (Dictionary<string, object?>)(await chat.Dispatch("task.create", CreateParameters(fixture)))!;
                var worktree = (string)task["worktreePath"]!;
                var hooks = chat.Repositories.Git.HooksPath;
                foreach (var name in PlantedHooks) File.WriteAllText(Path.Join(hooks, name), hook);
                File.WriteAllText(Path.Combine(worktree, "README.md"), "changed\n");
                var launches = 0;
                chat.Repositories.Git.Launching = _ => launches++;
                var refused = "Git command failed: " + chat.Repositories.Git.HooksNotEmptyMessage;
                Assert.Equal(refused, (await Assert.ThrowsAsync<WorkspaceReadException>(() => chat.Dispatch("task.commit", new() { ["taskId"] = task["id"], ["message"] = "Change" }))).Message);
                Assert.Equal(refused, (await Assert.ThrowsAsync<WorkspaceReadException>(() => chat.Dispatch("task.create", CreateParameters(fixture)))).Message);
                Assert.Equal(0, launches);
                Assert.Empty(store.Rows("SELECT * FROM intents WHERE kind='git.commit' OR state<>'complete'"));
                Assert.Single(store.Rows("SELECT id FROM tasks"));
                foreach (var name in PlantedHooks) File.Delete(Path.Join(hooks, name));
                await chat.Dispatch("task.commit", new() { ["taskId"] = task["id"], ["message"] = "Change" });
                Assert.True(launches > 0);
                await chat.Shutdown(); return 0;
            });
            Assert.False(File.Exists(marker));
        }
    }

    /// <summary>
    /// Review L1 (not in TypeScript): a commit, push or reconciliation in flight and a retirement of the same task exclude
    /// each other, so retirement can never remove the worktree that an in-flight commit's outcome must be verified in.
    /// </summary>
    [Fact]
    public async Task PublicationAndRetirementOfOneTaskExcludeEachOther()
    {
        var (fixture, data) = await Project("foundry-p2-publish-retire-");
        using (fixture)
        {
            await using var loop = new RuntimeLoop();
            await loop.Invoke(async () =>
            {
                using var store = new Store(loop, data, Path.Combine(fixture.Scratch, "injected-root"));
                var chat = new DevelopmentChat(loop, store, fixture.Environment);
                var task = (Dictionary<string, object?>)(await chat.Dispatch("task.create", CreateParameters(fixture)))!;
                var retire = new Dictionary<string, object?> { ["taskId"] = task["id"], ["confirm"] = "retire" };
                var commit = new Dictionary<string, object?> { ["taskId"] = task["id"], ["message"] = "Change" };
                File.WriteAllText(Path.Combine((string)task["worktreePath"]!, "README.md"), "changed\n");
                // Each operation reserves its task before its first await, so the second request sees the first in flight.
                var committing = chat.Dispatch("task.commit", commit);
                Assert.Equal("A Git operation is already in progress for this task.", (await Assert.ThrowsAsync<WorkspaceReadException>(() => chat.Dispatch("task.retire", retire))).Message);
                await committing;
                var retiring = chat.Dispatch("task.retire", retire);
                Assert.Equal("Worktree retirement is already in progress for this task.", (await Assert.ThrowsAsync<WorkspaceReadException>(() => chat.Dispatch("task.commit", commit))).Message);
                Assert.Equal("Worktree retirement is already in progress for this task.", (await Assert.ThrowsAsync<WorkspaceReadException>(() => chat.Dispatch("task.push", new() { ["taskId"] = task["id"], ["remote"] = "origin", ["confirm"] = "push" }))).Message);
                await retiring;
                Assert.Equal("retired", store.ReadTask((string)task["id"]!)["status"]);
                Assert.Equal(["git.commit", "worktree.retire"], store.Rows("SELECT kind FROM intents WHERE kind IN ('git.commit','git.push','worktree.retire') ORDER BY rowid").Select(row => (string)row["kind"]!));
                Assert.All(store.Rows("SELECT state FROM intents"), row => Assert.Equal("complete", row["state"]));
                await chat.Shutdown(); return 0;
            });
        }
    }

    /// <summary>
    /// Review of #36 (not in TypeScript): porcelain v1 writes a staged rename's source after its destination, and the
    /// staged listing detects renames, so `git mv .env safe.txt` showed only the safe name. Both endpoints are screened now.
    /// </summary>
    [Fact]
    public async Task AStagedRenameOfASecretNamedPathIsRefused()
    {
        var (fixture, data) = await Project("foundry-p2-rename-secret-");
        using (fixture)
        {
            fixture.Write("repo/.env", "TOKEN=1\n");
            await fixture.Git("-C", "repo", "add", "-f", ".env"); await fixture.Git("-C", "repo", "commit", "-qm", "tracked env");
            await using var loop = new RuntimeLoop();
            await loop.Invoke(async () =>
            {
                using var store = new Store(loop, data, Path.Combine(fixture.Scratch, "injected-root"));
                var chat = new DevelopmentChat(loop, store, fixture.Environment);
                var task = (Dictionary<string, object?>)(await chat.Dispatch("task.create", CreateParameters(fixture)))!;
                var worktree = (string)task["worktreePath"]!;
                await fixture.Git("-C", worktree, "mv", ".env", "safe.txt");
                var head = await fixture.GitOutput("-C", worktree, "rev-parse", "HEAD");
                Assert.Equal("Refusing to commit secret-named paths: .env. Remove or ignore them first.",
                    (await Assert.ThrowsAsync<WorkspaceReadException>(() => chat.Dispatch("task.commit", new() { ["taskId"] = task["id"], ["message"] = "Rename" }))).Message);
                Assert.Equal(head, await fixture.GitOutput("-C", worktree, "rev-parse", "HEAD"));
                Assert.Equal("complete", store.Rows("SELECT state FROM intents WHERE kind='git.commit'").Single()["state"]);
                await chat.Shutdown(); return 0;
            });
        }
    }

    /// <summary>
    /// Review of #36 (not in TypeScript): a worktree replaced by another repository on the saved branch, or a project
    /// whose repository is no longer the one bound at creation, is refused before anything is staged or pushed.
    /// </summary>
    [Fact]
    public async Task PublicationRefusesAWorktreeThatNoLongerBelongsToTheBoundProject()
    {
        var (fixture, data) = await Project("foundry-p2-foreign-worktree-");
        using (fixture)
        {
            await fixture.Git("init", "-q", "--bare", "elsewhere.git");
            await using var loop = new RuntimeLoop();
            await loop.Invoke(async () =>
            {
                using var store = new Store(loop, data, Path.Combine(fixture.Scratch, "injected-root"));
                var chat = new DevelopmentChat(loop, store, fixture.Environment);
                var task = (Dictionary<string, object?>)(await chat.Dispatch("task.create", CreateParameters(fixture)))!;
                var taskId = (string)task["id"]!; var worktree = (string)task["worktreePath"]!; var branch = (string)task["branch"]!;
                var commit = new Dictionary<string, object?> { ["taskId"] = taskId, ["message"] = "Change" };
                var push = new Dictionary<string, object?> { ["taskId"] = taskId, ["remote"] = "origin", ["confirm"] = "push" };
                // A tampered binding: the worktree still belongs to the project, but not to the repository bound at creation.
                var binding = store.Rows("SELECT id,data FROM intents WHERE kind='channel.identity'").Single();
                var original = (string)binding["data"]!;
                store.Execute("UPDATE intents SET data=$p0 WHERE id=$p1", original.Replace("\"common\":\"", "\"common\":\"X", StringComparison.Ordinal), binding["id"]);
                File.WriteAllText(Path.Combine(worktree, "README.md"), "changed\n");
                Assert.Equal(RepositoryService.ForeignWorktree, (await Assert.ThrowsAsync<WorkspaceReadException>(() => chat.Dispatch("task.commit", commit))).Message);
                Assert.Equal(RepositoryService.ForeignWorktree, (await Assert.ThrowsAsync<WorkspaceReadException>(() => chat.Dispatch("task.push", push))).Message);
                store.Execute("UPDATE intents SET data=$p0 WHERE id=$p1", original, binding["id"]);
                // A replacement repository at the worktree's path, on the saved branch, with its own remote.
                foreach (var file in new DirectoryInfo(worktree).EnumerateFiles("*", SearchOption.AllDirectories)) file.Attributes = FileAttributes.Normal;
                Directory.Delete(worktree, true);
                await fixture.Git("init", "-q", "-b", branch, worktree);
                File.WriteAllText(Path.Combine(worktree, "README.md"), "replacement\n");
                await fixture.Git("-C", worktree, "add", "-A"); await fixture.Git("-C", worktree, "commit", "-qm", "replacement");
                await fixture.Git("-C", worktree, "remote", "add", "origin", fixture.Local("elsewhere.git"));
                File.WriteAllText(Path.Combine(worktree, "README.md"), "changed again\n");
                var head = await fixture.GitOutput("-C", worktree, "rev-parse", "HEAD");
                Assert.Equal(RepositoryService.ForeignWorktree, (await Assert.ThrowsAsync<WorkspaceReadException>(() => chat.Dispatch("task.commit", commit))).Message);
                Assert.Equal(RepositoryService.ForeignWorktree, (await Assert.ThrowsAsync<WorkspaceReadException>(() => chat.Dispatch("task.push", push))).Message);
                Assert.Equal(head, await fixture.GitOutput("-C", worktree, "rev-parse", "HEAD"));
                Assert.All(store.Rows("SELECT state FROM intents WHERE kind IN ('git.commit','git.push')"), row => Assert.Equal("complete", row["state"]));
                await chat.Shutdown(); return 0;
            });
            Assert.Empty(await fixture.GitText("--git-dir", fixture.Local("elsewhere.git"), "for-each-ref"));
        }
    }

    /// <summary>
    /// Review of #36 (not in TypeScript): reconciliation reads the remote's fetch URL, so a remote whose push URL differs
    /// stays unverified rather than being judged against another server; a SHA-256 remote tip is recognized.
    /// </summary>
    [Fact]
    public async Task PushVerificationNeedsTheFetchedServerAndAcceptsSha256Tips()
    {
        var (fixture, _) = await Project("foundry-p2-push-verify-");
        using (fixture)
        {
            fixture.Write("sha256/README.md", "hello\n");
            await fixture.Git("init", "-q", "--object-format=sha256", "sha256"); await fixture.Git("-C", "sha256", "add", "-A"); await fixture.Git("-C", "sha256", "commit", "-qm", "fixture");
            await fixture.Git("init", "-q", "--bare", "--object-format=sha256", "sha256-remote.git");
            await fixture.Git("-C", "sha256", "remote", "add", "origin", fixture.Local("sha256-remote.git"));
            await fixture.Git("-C", "sha256", "push", "-q", "origin", "main");
            var sha256Head = await fixture.GitOutput("-C", "sha256", "rev-parse", "HEAD");
            Assert.Equal(64, sha256Head.Length);
            await fixture.Git("-C", "repo", "push", "-q", "origin", "main");
            var head = await fixture.GitOutput("-C", "repo", "rev-parse", "HEAD");
            await using var loop = new RuntimeLoop();
            await loop.Invoke(async () =>
            {
                var service = new RepositoryService(loop, fixture.Local("wt"), fixture.Environment);
                Assert.True(await service.VerifyPushOutcome(fixture.Local("sha256"), fixture.Local("sha256"), "origin", "main", sha256Head));
                Assert.True(await service.VerifyPushOutcome(fixture.Local("repo"), fixture.Local("repo"), "origin", "main", head));
                return 0;
            });
            await fixture.Git("init", "-q", "--bare", "push-only.git");
            await fixture.Git("-C", "repo", "remote", "set-url", "--push", "origin", fixture.Local("push-only.git"));
            await loop.Invoke(async () =>
            {
                var service = new RepositoryService(loop, fixture.Local("wt"), fixture.Environment);
                Assert.Null(await service.VerifyPushOutcome(fixture.Local("repo"), fixture.Local("repo"), "origin", "main", head));
                return 0;
            });
        }
    }

    [Fact]
    public void OracleSourceBindingsAreCurrent()
    {
        Assert.Equal(1, Corpus.GetProperty("schemaVersion").GetInt32());
        RepositoryFixture.AssertOracleSources(Corpus);
    }

    private static List<string> Lines(string text) => [.. text.Split('\n').Where(line => line.Length > 0)];

    /// <summary>Generated identities, commit object ids and stamps become placeholders in order of appearance.</summary>
    private static object? Stable(object? value, Dictionary<string, string> identities) => value switch
    {
        string text when Stamp().IsMatch(text) => "{stamp}",
        string text => Generated().Replace(text, match => identities.TryGetValue(match.Value, out var known) ? known
            : identities[match.Value] = $"{{{(match.Value.Length == 40 ? "sha" : "id")}-{identities.Count + 1}}}"),
        IDictionary<string, object?> map => map.ToDictionary(pair => pair.Key, pair => Stable(pair.Value, identities)),
        System.Collections.IEnumerable items => items.Cast<object?>().Select(item => Stable(item, identities)).ToList(),
        _ => value,
    };

    // JavaScript \b is ASCII: a word boundary between [0-9A-Za-z_] and anything else.
    [GeneratedRegex(@"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|(?<![0-9A-Za-z_])[0-9a-f]{40}(?![0-9A-Za-z_])", RegexOptions.CultureInvariant)]
    private static partial Regex Generated();
    [GeneratedRegex(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$", RegexOptions.CultureInvariant)]
    private static partial Regex Stamp();
}
