using System.Net;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using Foundry.Protocol;
using Foundry.Providers;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

/// <summary>
/// Native-only checks of P2.4d. A Git chat whose completion is as deep as <see cref="ProviderJson.MaxDepth"/> allows runs
/// every recursive walk of it on the runtime loop's own thread, whose stack is explicit (P2.4b review N4): the parser's
/// screening, the continuation's serialization and persistence, and, on the next turn, its reading back from the store
/// and the request body built from it.
/// </summary>
public sealed class ExternalChatNativeTests
{
    private const string Azure = "0c46787b-9dce-4a8d-a8aa-6fe7f8a44d53";

    [Fact]
    public async Task AContinuationAtTheDepthBoundIsSavedAndResumedOnTheLoop()
    {
        // data {} → response {} → output [] → item {} → nested arrays: four levels before the arrays begin.
        var arrays = ProviderJson.MaxDepth - 4;
        static string Text(string text, string extra = "") =>
            "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"" + text + "\"}\n\n"
            + "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":9,\"output_tokens\":1},\"output\":[{\"type\":\"message\",\"id\":\"m1\",\"content\":[{\"type\":\"output_text\",\"text\":\"" + text + "\"}]" + extra + "}]}}\n\n";
        var handler = new Answers([Text("Deep", ",\"deep\":" + new string('[', arrays) + new string(']', arrays)), Text("Resumed")]);
        using var fixture = RepositoryFixture.Create("foundry-p2-external-native-");
        fixture.Write("work/repo/README.md", "hello\n");
        await fixture.Git("-C", "work/repo", "init", "-q"); await fixture.Git("-C", "work/repo", "add", "-A"); await fixture.Git("-C", "work/repo", "commit", "-qm", "fixture");
        var data = Directory.CreateDirectory(fixture.Local("data")).FullName;
        var environment = fixture.Environment();
        await using var loop = new RuntimeLoop(); Store? store = null; DevelopmentChat? chat = null;
        await loop.Invoke(() =>
        {
            store = new Store(loop, data, Path.Combine(fixture.Scratch, "injected-root"));
            chat = new DevelopmentChat(loop, store, null, gitEnvironment: () => environment, transport: new AzureTransport(handler), probeDeadline: TimeSpan.FromSeconds(5));
            return Task.FromResult(0);
        });
        Task<object?> Dispatch(string method, Dictionary<string, object?> parameters) => loop.Invoke(() => chat!.Dispatch(method, (Dictionary<string, object?>)Contracts.Validate("rpc " + method, parameters)!));
        async Task<Dictionary<string, object?>> Settled(string taskId)
        {
            Dictionary<string, object?> task;
            for (var n = 0; Equals((task = await loop.Invoke(() => Task.FromResult(store!.ReadTask(taskId))))["status"], "running"); n++)
            {
                Assert.True(n < 6000, "The turn did not finish.");
                await Task.Delay(5, TestContext.Current.CancellationToken);
            }
            return task;
        }
        try
        {
            var saved = (Dictionary<string, object?>)(await Dispatch("profile.save", new()
            {
                ["id"] = Azure, ["name"] = "Deep", ["apiKind"] = "responses", ["endpoint"] = "https://sample.openai.azure.com", ["deployment"] = "test-model", ["contextLimit"] = 16384d, ["outputLimit"] = 1024d,
            }))!;
            await loop.Invoke(() =>
            {
                chat!.SetCredential(Azure, "fixture-" + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(12)), JsJson.Stringify(new List<object?> { saved["apiKind"], saved["endpoint"], saved["deployment"] })!);
                // As a probe by an earlier runtime left it: verified for tools and continuation, so the chat has channel tools.
                var profile = store!.Profile(Azure)!;
                store.SaveProfile(new(profile)
                {
                    ["verificationFingerprint"] = Compatibility.ProfileFingerprint(profile),
                    ["capabilities"] = new Dictionary<string, object?> { ["streaming"] = true, ["tools"] = true, ["continuation"] = true, ["cancellation"] = true, ["usage"] = true },
                });
                return Task.FromResult(0);
            });
            var project = (Dictionary<string, object?>)(await Dispatch("project.add", new() { ["path"] = fixture.Local("work/repo") }))!;
            var started = (Dictionary<string, object?>)(await Dispatch("task.start", new()
            {
                ["requestId"] = Guid.NewGuid().ToString(), ["projectId"] = project["id"], ["content"] = "Go deep", ["profileId"] = Azure, ["mode"] = "chat",
            }))!;
            var taskId = (string)started["id"]!;
            Assert.Equal("idle", (await Settled(taskId))["status"]);
            await Dispatch("task.send", new() { ["taskId"] = taskId, ["content"] = "Resume" });
            Assert.Equal("idle", (await Settled(taskId))["status"]);
            // The second request resumes the stored continuation, the deep item included.
            Assert.Equal(2, handler.Bodies.Count);
            Assert.Contains("\"deep\":[[", handler.Bodies[1], StringComparison.Ordinal);
        }
        finally { await loop.Invoke(async () => { try { await chat!.Shutdown(); } finally { store!.Dispose(); } return 0; }); }
    }

    [Fact]
    public async Task UsageThatArrivesWithTheAbortSettlesTheCancelledRequest()
    {
        // agent-loop.ts keeps usage before it checks the abort, so a provider that reports final usage as it stops is
        // charged that usage. No recorded stream can time this, so a scripted provider reports it after the cancel.
        var waiting = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        async IAsyncEnumerable<ProviderChatEvent> Script(ProviderRequest request, [EnumeratorCancellation] CancellationToken token)
        {
            yield return new ProviderText("partial");
            waiting.TrySetResult();
            try { await Task.Delay(Timeout.Infinite, token); }
            catch (OperationCanceledException) { }
            yield return new ProviderUsage(7, 2);
            throw new OperationCanceledException("This operation was aborted", token);
        }
        var data = Directory.CreateTempSubdirectory("foundry-p2-external-abort-").FullName;
        await using var loop = new RuntimeLoop(); Store? store = null; DevelopmentChat? chat = null;
        await loop.Invoke(() => { store = new Store(loop, data, Path.Combine(data, "injected-root")); chat = new DevelopmentChat(loop, store, Script); return Task.FromResult(0); });
        try
        {
            var started = (Dictionary<string, object?>)(await loop.Invoke(() => chat!.Dispatch("task.start", (Dictionary<string, object?>)Contracts.Validate("rpc task.start", new Dictionary<string, object?>
            {
                ["requestId"] = Guid.NewGuid().ToString(), ["projectId"] = null, ["content"] = "Stop me", ["profileId"] = Store.FakeProfileId, ["mode"] = "chat",
            })!)))!;
            var taskId = (string)started["id"]!;
            await waiting.Task.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);
            await loop.Invoke(() => chat!.Dispatch("task.cancel", new() { ["taskId"] = taskId }));
            for (var n = 0; await loop.Invoke(() => Task.FromResult(Equals(store!.ReadTask(taskId)["status"], "running"))); n++)
            {
                Assert.True(n < 6000, "The turn did not stop.");
                await Task.Delay(5, TestContext.Current.CancellationToken);
            }
            var request = Assert.Single(await loop.Invoke(() => Task.FromResult(store!.Rows("SELECT outcome,usage_known,input_tokens,output_tokens,reason FROM provider_requests"))));
            Assert.Equal("cancelled", request["outcome"]);
            Assert.Equal(1L, request["usage_known"]); Assert.Equal(7L, request["input_tokens"]); Assert.Equal(2L, request["output_tokens"]);
            Assert.Equal("Provider reported final usage for an unsuccessful request.", request["reason"]);
        }
        finally { await loop.Invoke(async () => { try { await chat!.Shutdown(); } finally { store!.Dispose(); } return 0; }); }
    }

    private sealed class Answers(List<string> bodies) : HttpMessageHandler
    {
        private int next;
        internal List<string> Bodies { get; } = [];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var text = Encoding.UTF8.GetString(await request.Content!.ReadAsByteArrayAsync(cancellationToken));
            lock (Bodies) Bodies.Add(text);
            var body = bodies[Interlocked.Increment(ref next) - 1];
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Encoding.UTF8.GetBytes(body)) };
        }
    }
}
