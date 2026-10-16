using System.Runtime.CompilerServices;
using Foundry.Protocol;
using Foundry.Providers;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

public sealed class DevelopmentChatTests
{
    private static string Root
    {
        get
        {
            for (var root = new DirectoryInfo(AppContext.BaseDirectory); root is not null; root = root.Parent)
                if (File.Exists(Path.Combine(root.FullName, "Foundry.slnx"))) return root.FullName;
            throw new InvalidOperationException("Missing execution corpus.");
        }
    }
    private static Dictionary<string, object?> Parameters(string content = "Hello 😀") => new()
    {
        ["requestId"] = "77777777-0000-4000-8000-999999999999", ["projectId"] = null, ["content"] = content,
        ["profileId"] = Store.FakeProfileId, ["mode"] = "chat", ["tokenBudget"] = 100000
    };
    [Fact]
    public async Task ActualServiceExecutionAndReadsMatchCommittedNode()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-service-").FullName;
        try
        {
            var corpus = (Dictionary<string, object?>)PersistedJson.Parse(File.ReadAllText(Path.Combine(Root, "tests/p2/development-chat-vectors.json")))!;
            var timestamp = DateTimeOffset.Parse((string)corpus["timestamp"]!, System.Globalization.CultureInfo.InvariantCulture);
            await using var loop = new RuntimeLoop(); Store? owned = null; DevelopmentChat? chat = null;
            var events = new List<object?>(); var next = 1;
            Guid NewId() => Guid.Parse($"77777777-0000-4000-8000-{next++:000000000000}");
            await loop.Invoke(() =>
            {
                owned = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), () => timestamp, NewId, item =>
                {
                    if (!DevelopmentChat.SendsNotification(item)) return;
                    events.Add(item.Sequence == 0 ? new Dictionary<string, object?> { ["sequence"] = 0, ["type"] = item.Type, ["data"] = item.Data, ["taskId"] = item.TaskId, ["createdAt"] = item.CreatedAt } : item.ToWire());
                });
                chat = new DevelopmentChat(loop, owned, () => timestamp, NewId); return Task.FromResult(0);
            });
            var steps = ((List<object?>)corpus["steps"]!).Cast<Dictionary<string, object?>>().ToArray(); Assert.Equal(10, steps.Length);
            try
            {
            foreach (var step in steps)
            {
                var method = (string)step["method"]!; var input = (Dictionary<string, object?>)step["params"]!;
                if (method == "wait")
                {
                    var taskId = (string)input["taskId"]!;
                    while (await loop.Invoke(() => Task.FromResult(Equals(owned!.ReadTask(taskId)["status"], "running")))) await Task.Delay(1, TestContext.Current.CancellationToken);
                }
                await loop.Invoke(async () =>
                {
                    object? value = null; string? error = null;
                    try { if (method != "wait") value = await chat!.Dispatch(method, (Dictionary<string, object?>)Contracts.Validate("rpc " + method, input)!); }
                    catch (InvalidOperationException exception) { error = exception.Message; }
                    var actual = new Dictionary<string, object?>
                    {
                        ["value"] = value, ["error"] = error,
                        ["tasks"] = owned!.Rows("SELECT rowid AS _rowid,* FROM tasks WHERE id LIKE '77777777-%' ORDER BY rowid"),
                        ["messages"] = owned.Rows("SELECT rowid AS _rowid,* FROM messages WHERE id LIKE '77777777-%' ORDER BY ordinal"),
                        ["requests"] = owned.Rows("SELECT rowid AS _rowid,* FROM provider_requests WHERE request_id LIKE '77777777-%' ORDER BY rowid"),
                        ["starts"] = owned.Rows("SELECT * FROM task_starts WHERE request_id LIKE '77777777-%' ORDER BY rowid"),
                        ["events"] = owned.Rows("SELECT * FROM events WHERE task_id LIKE '77777777-%' ORDER BY sequence"), ["notifications"] = events
                    };
                    Assert.Equal(JsJson.Stringify(step["expected"]), JsJson.Stringify(actual)); return 0;
                });
            }
            }
            finally { await loop.Invoke(async () => { try { await chat!.Shutdown(); } finally { owned!.Dispose(); } return 0; }); }
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task CancellationAfterFinalTextCannotBecomeSuccessEvenWhenProviderYieldsDone()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-late-cancel-").FullName;
        try
        {
            await using var loop = new RuntimeLoop(); Store? store = null; DevelopmentChat? chat = null;
            var arrived = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            async IAsyncEnumerable<ProviderChatEvent> Stream(IReadOnlyList<ProviderMessage> _, ProviderContinuation? __, [EnumeratorCancellation] CancellationToken token)
            {
                loop.AssertCurrent(); yield return new ProviderText("partial"); arrived.TrySetResult(); await release.Task; loop.AssertCurrent();
                yield return new ProviderDone(new("fake", new Dictionary<string, object?> { ["stage"] = "chat", ["calls"] = new List<object?>() }));
            }
            var task = await loop.Invoke(async () =>
            {
                store = new Store(loop, scratch, Path.Combine(scratch, "injected-root")); chat = new DevelopmentChat(loop, store, Stream);
                return (Dictionary<string, object?>)(await chat.Dispatch("task.start", Parameters()))!;
            });
            await arrived.Task.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
            var taskId = (string)task["id"]!;
            await loop.Invoke(async () => { await chat!.Dispatch("task.cancel", new() { ["taskId"] = taskId }); return 0; });
            release.SetResult();
            await loop.Invoke(async () =>
            {
                await chat!.Shutdown();
                Assert.Equal("cancelled", store!.ReadTask(taskId)["status"]);
                Assert.Equal("cancelled", store.Rows("SELECT outcome FROM provider_requests").Single()["outcome"]);
                var answer = store.MessagesWithOrdinals(taskId).Single(message => Equals(message["role"], "assistant"));
                Assert.Equal("partial", answer["content"]); Assert.Equal("cancelled", answer["status"]);
                store.Dispose(); return 0;
            });
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Theory]
    [InlineData("missing-completion", "Provider stream ended without a completion event.")]
    [InlineData("after-completion", "Provider emitted data after its completion event.")]
    [InlineData("output-limit", "Response exceeded the local output limit.")]
    public async Task InvalidProviderStreamFailsWithoutSuccess(string scenario, string reason)
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-stream-fault-").FullName;
        try
        {
            await using var loop = new RuntimeLoop(); Store? store = null; DevelopmentChat? chat = null;
            async IAsyncEnumerable<ProviderChatEvent> Stream(IReadOnlyList<ProviderMessage> _, ProviderContinuation? __, [EnumeratorCancellation] CancellationToken token)
            {
                await Task.CompletedTask; loop.AssertCurrent();
                yield return new ProviderText(scenario == "output-limit" ? new string('a', 256 * 1024 + 1) : "partial");
                if (scenario == "after-completion") { yield return new ProviderDone(new("fake", new Dictionary<string, object?> { ["stage"] = "chat", ["calls"] = new List<object?>() })); yield return new ProviderText("late"); }
            }
            var task = await loop.Invoke(async () =>
            {
                store = new Store(loop, scratch, Path.Combine(scratch, "injected-root")); chat = new DevelopmentChat(loop, store, Stream);
                return (Dictionary<string, object?>)(await chat.Dispatch("task.start", Parameters()))!;
            });
            try
            {
                await loop.Invoke(async () =>
                {
                    await chat!.Shutdown();
                    var saved = store!.ReadTask((string)task["id"]!);
                    Assert.Equal("failed", saved["status"]);
                    Assert.Contains(reason, JsJson.Stringify(store.Rows("SELECT * FROM events WHERE type='task.stopped'"))!);
                    Assert.Equal("failed", store.Rows("SELECT outcome FROM provider_requests").Single()["outcome"]);
                    Assert.Equal("failed", store.MessagesWithOrdinals((string)task["id"]!).Single(message => Equals(message["role"], "assistant"))["status"]);
                    return 0;
                });
            }
            finally { await loop.Invoke(async () => { try { await chat!.Shutdown(); } finally { store!.Dispose(); } return 0; }); }
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task CoalescingSlotLimitAndQueuedCancellationAreDeterministic()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-slots-").FullName;
        try
        {
            await using var loop = new RuntimeLoop(); Store? store = null; DevelopmentChat? chat = null;
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var visits = 0;
            async IAsyncEnumerable<ProviderChatEvent> Stream(IReadOnlyList<ProviderMessage> _, ProviderContinuation? __, [EnumeratorCancellation] CancellationToken token)
            {
                loop.AssertCurrent(); if (++visits == 3) entered.TrySetResult();
                yield return new ProviderText("partial"); await Task.Delay(Timeout.InfiniteTimeSpan, token);
            }
            var tasks = await loop.Invoke(async () =>
            {
                store = new Store(loop, scratch, Path.Combine(scratch, "injected-root")); chat = new DevelopmentChat(loop, store, Stream);
                var input = Parameters(); var first = chat.Dispatch("task.start", input); var duplicate = chat.Dispatch("task.start", input);
                var conflict = chat.Dispatch("task.start", new(input) { ["content"] = "different" });
                var same = await Task.WhenAll(first, duplicate);
                Assert.Equal(((Dictionary<string, object?>)same[0]!)["id"], ((Dictionary<string, object?>)same[1]!)["id"]);
                Assert.Equal("This request ID belongs to different chat settings.", (await Assert.ThrowsAsync<InvalidOperationException>(() => conflict)).Message);
                var saved = new List<Dictionary<string, object?>> { (Dictionary<string, object?>)same[0]! };
                for (var n = 2; n <= 4; n++) saved.Add((Dictionary<string, object?>)(await chat.Dispatch("task.start", new(Parameters()) { ["requestId"] = $"77777777-0000-4000-8000-{n:000000000000}" }))!);
                return saved;
            });
            try
            {
                await entered.Task.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
                await loop.Invoke(async () =>
                {
                    Assert.Equal(3, visits);
                    var waiting = store!.Rows("SELECT * FROM provider_requests WHERE task_id=$p0", tasks[3]["id"]).Single();
                    Assert.Null(waiting["attempted_at"]);
                    await chat!.Dispatch("task.cancel", new() { ["taskId"] = tasks[3]["id"] });
                    await chat.Shutdown(); Assert.Equal(3, visits);
                    Assert.Equal(4L, store.Scalar("SELECT COUNT(*) FROM tasks"));
                    Assert.Equal(8L, store.Scalar("SELECT COUNT(*) FROM messages"));
                    Assert.Equal("cancelled", store.ReadTask((string)tasks[3]["id"]!)["status"]);
                    var cancelled = store.Rows("SELECT * FROM provider_requests WHERE task_id=$p0", tasks[3]["id"]).Single();
                    Assert.Equal("cancelled", cancelled["outcome"]); Assert.Null(cancelled["attempted_at"]);
                    await Assert.ThrowsAsync<InvalidOperationException>(() => chat.Dispatch("task.send", new() { ["taskId"] = tasks[0]["id"], ["content"] = "late" }));
                    return 0;
                });
            }
            finally { await loop.Invoke(async () => { try { await chat!.Shutdown(); } finally { store!.Dispose(); } return 0; }); }
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Theory]
    [InlineData("v1", 1), InlineData("v2", 2), InlineData("v3", 3), InlineData("v4", 4), InlineData("v5", 5), InlineData("v5-wal", 5)]
    public async Task ExecutionRespectsEachFixtureEraWithoutUpgrading(string era, int version)
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-era-chat-").FullName;
        try
        {
            foreach (var file in Directory.GetFiles(Path.Combine(Root, "tests/fixtures/databases", era), "workspace.db*")) File.Copy(file, Path.Combine(scratch, Path.GetFileName(file)));
            File.WriteAllText(Path.Combine(scratch, Store.IsolationMarker), Store.IsolationDeclaration);
            await using var loop = new RuntimeLoop(); Store? store = null; DevelopmentChat? chat = null;
            await loop.Invoke(() =>
            {
                store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"));
                chat = new DevelopmentChat(loop, store, (messages, continuation, token) => new FakeChatProvider(_ => Task.CompletedTask).StreamTurn(messages, continuation, token));
                return Task.FromResult(0);
            });
            try
            {
                if (version < 3)
                {
                    var before = await loop.Invoke(() => Task.FromResult(store!.Scalar("SELECT COUNT(*) FROM tasks")));
                    await Assert.ThrowsAsync<InvalidOperationException>(() => loop.Invoke(() => chat!.Dispatch("task.start", Parameters())));
                    await loop.Invoke(() => { Assert.Equal(before, store!.Scalar("SELECT COUNT(*) FROM tasks")); return Task.FromResult(0); });
                }
                else
                {
                    var task = (Dictionary<string, object?>)(await loop.Invoke(() => chat!.Dispatch("task.start", Parameters())))!;
                    await loop.Invoke(() =>
                    {
                        var taskId = (string)task["id"]!;
                        Assert.Equal("idle", store!.ReadTask(taskId)["status"]);
                        Assert.Equal("Fake response: Hello 😀", store.MessagesWithOrdinals(taskId).Single(message => Equals(message["role"], "assistant"))["content"]);
                        Assert.Equal(2, store.MessagesWithOrdinals(taskId).Count);
                        Assert.Equal(1L, store.Scalar(version >= 4 ? "SELECT COUNT(*) FROM provider_requests WHERE task_id=$p0" : "SELECT COUNT(*) FROM usage_records WHERE task_id=$p0", taskId));
                        return Task.FromResult(0);
                    });
                }
                await loop.Invoke(() => { Assert.Equal(version, store!.SchemaVersion); Assert.Equal((long)version, store.Scalar("PRAGMA user_version")); return Task.FromResult(0); });
            }
            finally { await loop.Invoke(async () => { try { await chat!.Shutdown(); } finally { store!.Dispose(); } return 0; }); }
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task DeliveryFailureKeepsCommittedMutationAndSignalsFatalShutdown()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-chat-delivery-").FullName;
        try
        {
            await using var loop = new RuntimeLoop(); Store? store = null; DevelopmentChat? chat = null;
            await loop.Invoke(async () =>
            {
                store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), publish: item => { if (item.Type == "task.completed") throw new IOException("injected delivery failure"); });
                chat = new DevelopmentChat(loop, store, (messages, continuation, token) => new FakeChatProvider(_ => Task.CompletedTask).StreamTurn(messages, continuation, token));
                await chat.Dispatch("task.start", Parameters()); return 0;
            });
            try
            {
                await chat!.Failure.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
                await loop.Invoke(async () =>
                {
                    Assert.Equal("idle", store!.Rows("SELECT status FROM tasks").Single()["status"]);
                    Assert.Equal("completed", store.Rows("SELECT outcome FROM provider_requests").Single()["outcome"]);
                    Assert.Equal(2L, store.Scalar("SELECT COUNT(*) FROM messages"));
                    Assert.Equal(1L, store.Scalar("SELECT COUNT(*) FROM events WHERE type='task.completed'"));
                    await Assert.ThrowsAsync<InvalidOperationException>(() => chat.Shutdown()); return 0;
                });
            }
            finally { await loop.Invoke(() => { store!.Dispose(); return Task.FromResult(0); }); }
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task FailedStartedNotificationClosesAdmissionAndRecoveryNeverReplays()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-start-delivery-").FullName;
        try
        {
            await using var loop = new RuntimeLoop(); Store? store = null; DevelopmentChat? chat = null; var visits = 0;
            await loop.Invoke(() =>
            {
                store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), publish: item => { if (item.Type == "task.started") throw new IOException("injected start delivery failure"); });
                chat = new DevelopmentChat(loop, store, (messages, continuation, token) => { visits++; return new FakeChatProvider().StreamTurn(messages, continuation, token); });
                return Task.FromResult(0);
            });
            try
            {
                await Assert.ThrowsAsync<EventDeliveryException>(() => loop.Invoke(() => chat!.Dispatch("task.start", Parameters())));
                await chat!.Failure.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
                await loop.Invoke(async () =>
                {
                    Assert.Equal(0, visits);
                    Assert.Equal("running", store!.Rows("SELECT status FROM tasks").Single()["status"]);
                    Assert.Equal("pending", store.Rows("SELECT outcome FROM provider_requests").Single()["outcome"]);
                    var taskId = (string)store.Rows("SELECT id FROM tasks").Single()["id"]!;
                    await Assert.ThrowsAsync<InvalidOperationException>(() => chat.Dispatch("task.send", new() { ["taskId"] = taskId, ["content"] = "duplicate" }));
                    Assert.Equal(2L, store.Scalar("SELECT COUNT(*) FROM messages"));
                    Assert.Equal(1L, store.Scalar("SELECT COUNT(*) FROM provider_requests"));
                    await Assert.ThrowsAsync<InvalidOperationException>(() => chat.Shutdown()); return 0;
                });
            }
            finally { await loop.Invoke(() => { store!.Dispose(); return Task.FromResult(0); }); }
            await loop.Invoke(() =>
            {
                using var recovered = new Store(loop, scratch, Path.Combine(scratch, "injected-root"));
                Assert.Equal("interrupted", recovered.Rows("SELECT status FROM tasks").Single()["status"]);
                var request = recovered.Rows("SELECT outcome,usage_known FROM provider_requests").Single();
                Assert.Equal("interrupted", request["outcome"]); Assert.Equal(0L, request["usage_known"]);
                Assert.Equal(2L, recovered.Scalar("SELECT COUNT(*) FROM messages")); Assert.Equal(0, visits);
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task QueuedStartCannotPassCommittedDeliveryFailureBeforeDispatchResumes()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-queued-delivery-").FullName;
        try
        {
            await using var loop = new RuntimeLoop(); Store? store = null; DevelopmentChat? chat = null; var visits = 0;
            try
            {
                await loop.Invoke(async () =>
                {
                    store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), publish: item => { if (item.Type == "task.started") throw new IOException("injected delivery failure"); });
                    chat = new DevelopmentChat(loop, store, (messages, continuation, token) => { visits++; return new FakeChatProvider().StreamTurn(messages, continuation, token); });
                    var first = chat.Dispatch("task.start", Parameters());
                    var second = chat.Dispatch("task.start", new(Parameters()) { ["requestId"] = "77777777-0000-4000-8000-999999999998" });
                    await Assert.ThrowsAsync<EventDeliveryException>(() => first);
                    Assert.Equal("Runtime is shutting down.", (await Assert.ThrowsAsync<InvalidOperationException>(() => second)).Message);
                    Assert.Equal(0, visits); Assert.Equal(1L, store.Scalar("SELECT COUNT(*) FROM tasks"));
                    Assert.Equal(1L, store.Scalar("SELECT COUNT(*) FROM task_starts")); Assert.Equal(1L, store.Scalar("SELECT COUNT(*) FROM provider_requests"));
                    await Assert.ThrowsAsync<InvalidOperationException>(() => chat.Shutdown()); return 0;
                });
            }
            finally { await loop.Invoke(() => { store?.Dispose(); return Task.FromResult(0); }); }
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task FailedStartRetryPreservesPendingIntentAfterCommittedDeliveryFailure()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-retry-delivery-").FullName;
        try
        {
            await using var loop = new RuntimeLoop(); Store? store = null; DevelopmentChat? chat = null;
            try
            {
                await loop.Invoke(async () =>
                {
                    store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), publish: item => { if (item.Type == "task.started") throw new IOException("injected delivery failure"); });
                    var input = Parameters(); var requestId = (string)input["requestId"]!; var taskId = "77777777-0000-4000-8000-000000000999";
                    var stamp = "2026-01-02T03:04:05.678Z";
                    store.ReserveTaskStart(requestId, Compatibility.Hash(input), taskId);
                    store.SaveTask(new() { ["id"] = taskId, ["title"] = "retry", ["profileId"] = Store.FakeProfileId, ["status"] = "idle", ["createdAt"] = stamp, ["updatedAt"] = stamp, ["tokenBudget"] = 100000, ["usedTokens"] = 0, ["mode"] = "chat", ["workspaceKind"] = "none" });
                    store.FinishTaskStart(requestId, "failed"); chat = new DevelopmentChat(loop, store);
                    await Assert.ThrowsAsync<EventDeliveryException>(() => chat.Dispatch("task.start", input));
                    Assert.Equal("pending", store.TaskStart(requestId)!["state"]);
                    Assert.Equal(1L, store.Scalar("SELECT COUNT(*) FROM provider_requests"));
                    Assert.Equal(2L, store.Scalar("SELECT COUNT(*) FROM messages"));
                    await Assert.ThrowsAsync<InvalidOperationException>(() => chat.Shutdown()); return 0;
                });
            }
            finally { await loop.Invoke(() => { store?.Dispose(); return Task.FromResult(0); }); }
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Theory]
    [InlineData("external-profile"), InlineData("folder"), InlineData("coding"), InlineData("child"), InlineData("unknown-approval")]
    [InlineData("unknown-publication"), InlineData("unknown-retirement"), InlineData("pending-publication"), InlineData("native-tools-stage"), InlineData("native-fingerprint")]
    public async Task UnsupportedOrUnresolvedTaskCannotAdmitAProviderRequest(string scenario)
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-admission-gates-").FullName;
        try
        {
            await using var loop = new RuntimeLoop(); Store? store = null; DevelopmentChat? chat = null; var visits = 0;
            try
            {
                await loop.Invoke(async () =>
                {
                    store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"));
                    var taskId = "77777777-0000-4000-8000-000000000999"; var stamp = "2026-01-02T03:04:05.678Z";
                    var task = new Dictionary<string, object?> { ["id"] = taskId, ["title"] = "guard", ["profileId"] = Store.FakeProfileId, ["status"] = "idle", ["createdAt"] = stamp, ["updatedAt"] = stamp, ["tokenBudget"] = 100000, ["usedTokens"] = 0, ["mode"] = "chat", ["workspaceKind"] = "none" };
                    if (scenario == "folder") task["workspaceKind"] = "folder";
                    if (scenario == "coding") task["mode"] = "coding";
                    if (scenario == "child") task["parentTaskId"] = "77777777-0000-4000-8000-000000000998";
                    store.SaveTask(task);
                    var profile = store.Profile(Store.FakeProfileId)!;
                    if (scenario == "external-profile") { profile["apiKind"] = "responses"; store.SaveProfile(profile); }
                    if (scenario is "unknown-approval" or "unknown-publication" or "unknown-retirement" or "pending-publication")
                    {
                        var kind = scenario == "unknown-approval" ? "tool.approval" : scenario == "unknown-retirement" ? "worktree.retire" : "git.push";
                        store.Execute("INSERT INTO intents VALUES('guard-intent',$p0,$p1,$p2)", kind, JsJson.Stringify(new { taskId }), scenario == "pending-publication" ? "pending" : "unknown");
                    }
                    if (scenario is "native-tools-stage" or "native-fingerprint")
                    {
                        var state = new Dictionary<string, object?> { ["fingerprint"] = scenario == "native-fingerprint" ? "old-profile" : Compatibility.ProfileFingerprint(profile),
                            ["continuation"] = new Dictionary<string, object?> { ["apiKind"] = "fake", ["data"] = new Dictionary<string, object?> { ["stage"] = "coding", ["calls"] = new List<object?>() } },
                            ["pending"] = new List<object?>(), ["results"] = new List<object?>(), ["seenCallIds"] = new List<object?>() };
                        store.Execute("INSERT INTO intents VALUES($p0,'provider.context',$p1,'complete')", taskId, JsJson.Stringify(state));
                    }
                    var before = JsJson.Stringify(store.Rows("SELECT * FROM tasks")); var eventCount = store.Scalar("SELECT COUNT(*) FROM events");
                    chat = new DevelopmentChat(loop, store, (messages, continuation, token) => { visits++; return new FakeChatProvider().StreamTurn(messages, continuation, token); });
                    var error = await Record.ExceptionAsync(() => chat.Dispatch("task.send", new() { ["taskId"] = taskId, ["content"] = "must not dispatch" }));
                    Assert.True(error is InvalidOperationException or NotSupportedException);
                    Assert.Equal(0, visits); Assert.Equal(before, JsJson.Stringify(store.Rows("SELECT * FROM tasks")));
                    Assert.Equal(eventCount, store.Scalar("SELECT COUNT(*) FROM events"));
                    Assert.Equal(0L, store.Scalar("SELECT COUNT(*) FROM messages")); Assert.Equal(0L, store.Scalar("SELECT COUNT(*) FROM provider_requests"));
                    return 0;
                });
            }
            finally { await loop.Invoke(async () => { try { if (chat is not null) await chat.Shutdown(); } finally { store?.Dispose(); } return 0; }); }
        }
        finally { Directory.Delete(scratch, true); }
    }
}
