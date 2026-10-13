using Foundry.Protocol;
using Foundry.Providers;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

public sealed class FakeChatTests
{
    private static string Root
    {
        get
        {
            for (var root = new DirectoryInfo(AppContext.BaseDirectory); root is not null; root = root.Parent)
                if (File.Exists(Path.Combine(root.FullName, "Foundry.slnx"))) return root.FullName;
            throw new InvalidOperationException("Missing fake-provider corpus.");
        }
    }
    public static IEnumerable<object[]> Cases()
    {
        var corpus = (List<object?>)PersistedJson.Parse(File.ReadAllText(Path.Combine(Root, "tests/p2/fake-chat-vectors.json")))!;
        foreach (var item in corpus.Cast<Dictionary<string, object?>>()) yield return [(string)item["name"]!, JsJson.Stringify(item)!];
    }
    [Theory, MemberData(nameof(Cases))]
    public async Task OfflineChatMatchesCommittedNodeEventsAndErrors(string name, string json)
    {
        Assert.NotEmpty(name);
        var item = (Dictionary<string, object?>)PersistedJson.Parse(json)!;
        var input = (Dictionary<string, object?>)item["input"]!;
        var messages = ((List<object?>)input["messages"]!).Cast<Dictionary<string, object?>>().Select(message => new ProviderMessage((string)message["role"]!, (string)message["content"]!)).ToArray();
        var state = input.GetValueOrDefault("continuation") as Dictionary<string, object?>;
        var continuation = state is null ? null : new ProviderContinuation((string)state["apiKind"]!, state["data"]);
        var unchanged = JsJson.Stringify(continuation);
        using var cancelled = new CancellationTokenSource();
        if (Equals(input.GetValueOrDefault("abortBefore"), true)) cancelled.Cancel();
        var events = new List<object?>(); string? error = null; var texts = 0;
        try
        {
            await foreach (var value in new FakeChatProvider().StreamTurn(messages, continuation, cancelled.Token))
            {
                events.Add(value);
                if (value is ProviderText && input.GetValueOrDefault("cancelAfterTexts") is double count && ++texts == count) cancelled.Cancel();
            }
        }
        catch (InvalidOperationException caught) { error = caught.Message; }
        catch (OperationCanceledException caught) { error = caught.Message; }
        Assert.Equal(JsJson.Stringify(item["expected"]), JsJson.Stringify(new Dictionary<string, object?> { ["events"] = events, ["error"] = error }));
        Assert.Equal(unchanged, JsJson.Stringify(continuation));
    }

    [Fact]
    public async Task PendingPauseCancellationIsObservedWithoutDone()
    {
        using var cancelled = new CancellationTokenSource();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        CancellationTokenRegistration registration = default;
        var provider = new FakeChatProvider(token =>
        {
            registration = token.Register(() => completion.TrySetCanceled(token));
            entered.SetResult(); return completion.Task;
        });
        await using var stream = provider.StreamTurn([new("user", "hello")], cancellationToken: cancelled.Token).GetAsyncEnumerator(cancelled.Token);
        Assert.True(await stream.MoveNextAsync()); Assert.IsType<ProviderText>(stream.Current);
        var pending = stream.MoveNextAsync().AsTask(); await entered.Task;
        cancelled.Cancel();
        var error = await Assert.ThrowsAsync<OperationCanceledException>(() => pending);
        Assert.Equal("This operation was aborted", error.Message); Assert.Equal(cancelled.Token, error.CancellationToken);
        registration.Dispose();
    }

    [Fact]
    public async Task ProviderContinuationReturnsToLoopAndEarlyDisposalStartsNoPause()
    {
        await using var loop = new RuntimeLoop();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var released = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var first = true;
        var operation = loop.Invoke(async () =>
        {
            var provider = new FakeChatProvider(_ =>
            {
                loop.AssertCurrent();
                if (!first) return Task.CompletedTask;
                first = false; entered.SetResult(); return released.Task;
            });
            var count = 0;
            await foreach (var item in provider.StreamTurn([new("user", "affinity")], cancellationToken: TestContext.Current.CancellationToken)) { loop.AssertCurrent(); Assert.NotNull(item); count++; }
            return count;
        });
        await entered.Task; Assert.False(operation.IsCompleted); released.SetResult(); Assert.True(await operation > 1);
        var pauses = 0;
        var early = new FakeChatProvider(_ => { pauses++; return Task.CompletedTask; });
        await using (var stream = early.StreamTurn([new("user", "early")], cancellationToken: TestContext.Current.CancellationToken).GetAsyncEnumerator(TestContext.Current.CancellationToken)) Assert.True(await stream.MoveNextAsync());
        Assert.Equal(0, pauses);
    }
}
