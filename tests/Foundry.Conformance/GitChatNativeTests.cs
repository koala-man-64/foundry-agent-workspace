using System.Runtime.CompilerServices;
using Foundry.Protocol;
using Foundry.Providers;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

/// <summary>Native Git-project chat behavior the Node oracle cannot sequence: cancellation inside a tool loop, an
/// unclassified tool failure, refusals while a Git operation runs, and the stored continuations native serves.</summary>
public sealed class GitChatNativeTests
{
    private static readonly Dictionary<string, object?> Complete = new() { ["stage"] = "complete", ["calls"] = new List<object?>() };

    private static Dictionary<string, object?> Start(string projectId, string content, string mode = "chat", int request = 1) => new()
    {
        ["requestId"] = $"79797979-0000-4000-8000-{request:000000000000}", ["projectId"] = projectId, ["content"] = content, ["profileId"] = Store.FakeProfileId, ["mode"] = mode, ["tokenBudget"] = 100000d,
    };

    /// <summary>A store and chat over a saved Git project, with the given stream or the offline provider.</summary>
    private static async Task WithGitProject(Func<ProviderRequest, CancellationToken, IAsyncEnumerable<ProviderChatEvent>>? stream,
        Func<RepositoryFixture, RuntimeLoop, Store, DevelopmentChat, string, Task> body)
    {
        using var fixture = RepositoryFixture.Create("foundry-p2-git-chat-native-");
        fixture.Write("repo/README.md", "hello\n");
        await fixture.Git("-C", "repo", "init", "-q"); await fixture.Git("-C", "repo", "add", "-A"); await fixture.Git("-C", "repo", "commit", "-qm", "fixture");
        var data = Directory.CreateDirectory(fixture.Local("data")).FullName;
        await using var loop = new RuntimeLoop(); Store? store = null; DevelopmentChat? chat = null;
        try
        {
            var projectId = await loop.Invoke(async () =>
            {
                store = new Store(loop, data, Path.Combine(fixture.Scratch, "injected-root"));
                chat = new DevelopmentChat(loop, store, stream, null, null, fixture.Environment);
                return (string)((Dictionary<string, object?>)(await chat.Dispatch("project.add", new() { ["path"] = fixture.Local("repo") }))!)["id"]!;
            });
            await body(fixture, loop, store!, chat!, projectId);
        }
        finally { await loop.Invoke(async () => { try { if (chat is not null) await chat.Shutdown(); } finally { store?.Dispose(); } return 0; }); }
    }

    private static async Task Idle(RuntimeLoop loop, Store store, string taskId)
    {
        for (var n = 0; await loop.Invoke(() => Task.FromResult(Equals(store.ReadTask(taskId)["status"], "running"))); n++)
        {
            Assert.True(n < 5000, "The turn did not finish.");
            await Task.Delay(1, TestContext.Current.CancellationToken);
        }
    }

    private static List<object?> Outcomes(Store store, string taskId) => [.. store.Rows("SELECT outcome FROM provider_requests WHERE task_id=$p0 ORDER BY rowid", taskId).Select(row => row["outcome"])];

    /// <summary>Cancelling between a turn's iterations settles the open request as cancelled, keeps the first response's
    /// tool result in the provider state, and frees the task for its next turn.</summary>
    [Fact]
    public async Task ACancelledToolLoopSettlesItsOpenRequestAndStops()
    {
        var second = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var requests = 0;
        async IAsyncEnumerable<ProviderChatEvent> Stream(ProviderRequest request, [EnumeratorCancellation] CancellationToken token)
        {
            await Task.Yield();
            if (++requests == 1)
            {
                yield return new ProviderToolCall("c1", "read_agent_messages", new Dictionary<string, object?> { ["after"] = 0d });
                yield return new ProviderDone(new("fake", Complete));
                yield break;
            }
            if (requests == 2) { second.TrySetResult(); await Task.Delay(Timeout.InfiniteTimeSpan, token); }
            yield return new ProviderText("Next turn.");
            yield return new ProviderDone(new("fake", Complete));
        }
        await WithGitProject(Stream, async (fixture, loop, store, chat, projectId) =>
        {
            var taskId = await loop.Invoke(async () => (string)((Dictionary<string, object?>)(await chat.Dispatch("task.start", Start(projectId, "Hello")))!)["id"]!);
            await second.Task.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);
            Assert.Equal(true, await loop.Invoke(async () => ((Dictionary<string, object?>)(await chat.Dispatch("task.cancel", new() { ["taskId"] = taskId }))!)["accepted"]));
            await Idle(loop, store, taskId);
            await loop.Invoke(() =>
            {
                Assert.Equal("cancelled", store.ReadTask(taskId)["status"]);
                Assert.Equal(["completed", "cancelled"], Outcomes(store, taskId));
                var state = store.ReadProviderState(taskId)!;
                Assert.Equal("c1", ((Dictionary<string, object?>)((List<object?>)state["results"]!).Single()!)["id"]);
                var answer = store.Rows("SELECT data FROM messages WHERE task_id=$p0 ORDER BY ordinal", taskId).Select(row => (Dictionary<string, object?>)PersistedJson.Parse((string)row["data"]!)!).Last();
                Assert.Equal("cancelled", answer["status"]);
                return Task.FromResult(0);
            });
            await loop.Invoke(() => chat.Dispatch("task.send", new() { ["taskId"] = taskId, ["content"] = "Again" }));
            await Idle(loop, store, taskId);
            await loop.Invoke(() => { Assert.Equal("idle", store.ReadTask(taskId)["status"]); Assert.Equal(["completed", "cancelled", "completed"], Outcomes(store, taskId)); return Task.FromResult(0); });
        });
    }

    /// <summary>
    /// Review I-2 of P2.3c: a failure the tool runtime does not classify as a refusal (here, a stored task it cannot read
    /// while listing participants) stops the turn as failed instead of reaching the model, as TypeScript's message would.
    /// No reservation is open while tools run, and the runtime keeps serving.
    /// </summary>
    [Fact]
    public async Task AnUnclassifiedToolFailureStopsTheTurnWithoutHoldingAReservation()
    {
        async IAsyncEnumerable<ProviderChatEvent> Stream(ProviderRequest request, [EnumeratorCancellation] CancellationToken token)
        {
            await Task.Yield();
            yield return new ProviderToolCall("l1", "list_project_agents", new Dictionary<string, object?>());
            yield return new ProviderDone(new("fake", Complete));
        }
        await WithGitProject(Stream, async (fixture, loop, store, chat, projectId) =>
        {
            await loop.Invoke(() => { store.Execute("INSERT INTO tasks(id,data) VALUES('unreadable','not json')"); return Task.FromResult(0); });
            var taskId = await loop.Invoke(async () => (string)((Dictionary<string, object?>)(await chat.Dispatch("task.start", Start(projectId, "Hello")))!)["id"]!);
            await Idle(loop, store, taskId);
            await loop.Invoke(async () =>
            {
                Assert.Equal("failed", store.ReadTask(taskId)["status"]);
                Assert.Equal(["completed"], Outcomes(store, taskId));
                Assert.Empty(store.Rows("SELECT * FROM events WHERE type='task.tool-result'"));
                Assert.False(chat.Failure.IsCompleted);
                Assert.Equal(taskId, ((Dictionary<string, object?>)((Dictionary<string, object?>)(await chat.Dispatch("task.read", new() { ["taskId"] = taskId }))!)["task"]!)["id"]);
                return 0;
            });
        });
    }

    /// <summary>A coordinated start in a Git project needs the orchestrator; it is refused before any reservation,
    /// intent or worktree.</summary>
    [Fact]
    public Task ACoordinatedGitStartIsRefusedBeforeAnyIntent() => WithGitProject(null, async (fixture, loop, store, chat, projectId) =>
    {
        var parameters = Start(projectId, "Coordinate", "coordinated");
        parameters["coordination"] = new Dictionary<string, object?> { ["childProfileIds"] = new List<object?> { Store.FakeProfileId }, ["requiredValidation"] = new Dictionary<string, object?> { ["command"] = "pnpm check", ["cwd"] = "", ["timeoutMs"] = 600000d } };
        var error = await loop.Invoke(async () => await Record.ExceptionAsync(() => chat.Dispatch("task.start", parameters)));
        Assert.Equal("Coordinated tasks are not available in this build.", Assert.IsType<NotSupportedException>(error).Message);
        await loop.Invoke(() =>
        {
            Assert.Empty(store.Rows("SELECT * FROM intents")); Assert.Empty(store.Rows("SELECT * FROM task_starts")); Assert.Empty(store.Rows("SELECT * FROM tasks"));
            return Task.FromResult(0);
        });
        Assert.False(Directory.Exists(Path.Join(store.DataDirectory, "wt")) && Directory.EnumerateFileSystemEntries(Path.Join(store.DataDirectory, "wt")).Any());
    });

    /// <summary>service.ts startTurn: a Git chat's turn waits for its commit or push, and a retirement in progress refuses it
    /// as retired.</summary>
    [Fact]
    public Task AGitChatTurnIsRefusedWhileAGitOperationRuns() => WithGitProject(null, async (fixture, loop, store, chat, projectId) =>
    {
        var taskId = await loop.Invoke(async () => (string)((Dictionary<string, object?>)(await chat.Dispatch("task.start", Start(projectId, "Hello")))!)["id"]!);
        await Idle(loop, store, taskId);
        await loop.Invoke(async () =>
        {
            var commit = chat.Dispatch("task.commit", new() { ["taskId"] = taskId, ["message"] = "Nothing to commit" });
            var refused = await Record.ExceptionAsync(() => chat.Dispatch("task.send", new() { ["taskId"] = taskId, ["content"] = "During the commit" }));
            Assert.Equal("Wait for the Git operation to finish before starting a response.", refused!.Message);
            await Record.ExceptionAsync(() => commit);
            var retire = chat.Dispatch("task.retire", new() { ["taskId"] = taskId, ["confirm"] = "retire" });
            refused = await Record.ExceptionAsync(() => chat.Dispatch("task.send", new() { ["taskId"] = taskId, ["content"] = "During the retirement" }));
            Assert.Equal("This task worktree is retired. Create a new task to continue the work.", refused!.Message);
            await retire;
            Assert.Equal("retired", store.ReadTask(taskId)["status"]);
            Assert.Single(store.Rows("SELECT * FROM provider_requests"));
            return 0;
        });
    });

    /// <summary>A stored continuation must be in a stage the offline provider serves natively. A channel demo interrupted
    /// before its tool ran resumes with the interrupted-call result; a coding demo's stage is refused before any reservation.</summary>
    [Fact]
    public Task StoredContinuationsAreServedOnlyInNativeStages() => WithGitProject(null, async (fixture, loop, store, chat, projectId) =>
    {
        var taskId = await loop.Invoke(async () => (string)((Dictionary<string, object?>)(await chat.Dispatch("task.start", Start(projectId, "Hello")))!)["id"]!);
        await Idle(loop, store, taskId);
        Dictionary<string, object?> State(string stage) => new()
        {
            ["fingerprint"] = Compatibility.ProfileFingerprint(store.Profile(Store.FakeProfileId)!),
            ["continuation"] = new Dictionary<string, object?> { ["apiKind"] = "fake", ["data"] = new Dictionary<string, object?> { ["stage"] = stage, ["calls"] = new List<object?> { new Dictionary<string, object?> { ["id"] = "p1", ["name"] = "send_agent_message", ["arguments"] = new Dictionary<string, object?>() } } } },
            ["pending"] = new List<object?> { new Dictionary<string, object?> { ["id"] = "p1", ["name"] = "send_agent_message", ["arguments"] = new Dictionary<string, object?>() } },
            ["results"] = new List<object?>(), ["seenToolCallIds"] = new List<object?> { "p1" },
        };
        await loop.Invoke(async () =>
        {
            store.SaveProviderState(taskId, State("read"));
            var refused = await Record.ExceptionAsync(() => chat.Dispatch("task.send", new() { ["taskId"] = taskId, ["content"] = "Coding stage" }));
            Assert.Equal("This native continuation requires a later runtime feature slice.", Assert.IsType<NotSupportedException>(refused).Message);
            Assert.Single(store.Rows("SELECT * FROM provider_requests"));
            store.SaveProviderState(taskId, State("channel-send"));
            await chat.Dispatch("task.send", new() { ["taskId"] = taskId, ["content"] = "After a restart" });
            return 0;
        });
        await Idle(loop, store, taskId);
        await loop.Invoke(() =>
        {
            var answer = store.Rows("SELECT data FROM messages WHERE task_id=$p0 ORDER BY ordinal", taskId).Select(row => (Dictionary<string, object?>)PersistedJson.Parse((string)row["data"]!)!).Last();
            Assert.Equal("Channel message was not sent.", answer["content"]);
            Assert.Equal("complete", answer["status"]);
            return Task.FromResult(0);
        });
    });
}
