using System.Net;
using System.Security.Cryptography;
using System.Text;
using Foundry.Protocol;
using Foundry.Providers;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

/// <summary>
/// Native-only checks of P2.4c: decision 2 against a fixture that saves MCP servers, the credential's redaction in what a
/// probe records, a shutdown that waits for a probe, and the refusals while a response runs.
/// </summary>
public sealed class ProfileNativeTests
{
    private const string Azure = "0c46787b-9dce-4a8d-a8aa-6fe7f8a44d53", Offline = "00000000-0000-4000-8000-000000000001";
    private static readonly string Credential = "fixture-" + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(12));
    private static Dictionary<string, object?> Profile(string apiKind = "responses") => (Dictionary<string, object?>)Contracts.Validate("rpc profile.save", new Dictionary<string, object?>
    {
        ["id"] = Azure, ["name"] = "Native", ["apiKind"] = apiKind, ["endpoint"] = "https://sample.openai.azure.com", ["deployment"] = "test-model", ["contextLimit"] = 8192d, ["outputLimit"] = 1024d,
    })!;
    private static string Binding(Dictionary<string, object?> profile) => JsJson.Stringify(new List<object?> { profile["apiKind"], profile["endpoint"], profile["deployment"] })!;

    [Fact]
    public async Task ACredentialIsRefusedWithNothingWrittenWhileMcpServersAreSaved()
    {
        await using var harness = await Harness.Open("v3");
        await harness.Run(chat => chat.Dispatch("profile.save", Profile()));
        var before = await harness.Rows("SELECT rowid AS _rowid,* FROM profiles ORDER BY rowid");
        Assert.NotEmpty(await harness.Rows("SELECT id FROM mcp_servers"));
        var refused = await Assert.ThrowsAsync<WorkspaceReadException>(() => harness.Run(chat => { chat.SetCredential(Azure, Credential, Binding(Profile())); return Task.FromResult<object?>(null); }));
        Assert.Equal(DevelopmentChat.McpRepair, refused.Message);
        Assert.Equal(JsJson.Stringify(before), JsJson.Stringify(await harness.Rows("SELECT rowid AS _rowid,* FROM profiles ORDER BY rowid")));
        // The credential was not kept: the probe has none.
        var probe = (Dictionary<string, object?>)(await harness.Run(chat => chat.Dispatch("profile.probe", new() { ["profileId"] = Azure })))!;
        Assert.Equal("A matching profile and credential are required to probe this provider.", probe["detail"]);
        Assert.Empty(harness.Handler.Requests);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AProbeRedactsTheCredentialAndItsTrimmedSpellingInWhatItRecords(bool padded)
    {
        await using var harness = await Harness.Open("fresh");
        await harness.Run(chat => chat.Dispatch("profile.save", Profile()));
        var secret = padded ? " \t" + Credential + "\r\n" : Credential;
        await harness.Run(chat => { chat.SetCredential(Azure, secret, Binding(Profile())); return Task.FromResult<object?>(null); });
        // The provider reports the credential, as fetch sent it, as its model and response id, then fails.
        harness.Handler.Answer = _ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("event: response.failed\ndata: " + JsJson.Stringify(new Dictionary<string, object?> { ["type"] = "response.failed", ["response"] = new Dictionary<string, object?> { ["id"] = Credential, ["model"] = Credential, ["status"] = "failed" } }) + "\n\n"),
        };
        var probe = (Dictionary<string, object?>)(await harness.Run(chat => chat.Dispatch("profile.probe", new() { ["profileId"] = Azure })))!;
        Assert.Equal("Responses provider returned unsupported or failed content.", probe["detail"]);
        Assert.Equal(Credential, Assert.Single(harness.Handler.Requests[0].Headers.NonValidated["api-key"]));
        var usage = Assert.Single(await harness.Rows("SELECT reported_model,response_id FROM provider_requests"));
        Assert.Equal("[REDACTED]", usage["reported_model"]); Assert.Equal("[REDACTED]", usage["response_id"]);
        foreach (var table in new[] { "profiles", "provider_requests", "events" })
            Assert.DoesNotContain(Credential, JsJson.Stringify(await harness.Rows($"SELECT * FROM {table}")), StringComparison.Ordinal);
    }

    [Fact]
    public async Task AProbeDetailCarryingTheCredentialIsRedacted()
    {
        await using var harness = await Harness.Open("fresh");
        await harness.Run(chat => chat.Dispatch("profile.save", Profile("anthropic")));
        await harness.Run(chat => { chat.SetCredential(Azure, Credential, Binding(Profile("anthropic"))); return Task.FromResult<object?>(null); });
        // The provider names the credential as its stop reason, which the adapter's failure message quotes.
        static string Frame(string type, string data) => $"event: {type}\ndata: {{\"type\":\"{type}\",{data}}}\n\n";
        harness.Handler.Answer = _ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(Frame("message_start", "\"message\":{\"usage\":{\"input_tokens\":3}}") + Frame("content_block_start", "\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}")
                + Frame("content_block_delta", "\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"OK\"}") + Frame("content_block_stop", "\"index\":0")
                + Frame("message_delta", "\"delta\":{\"stop_reason\":" + JsJson.Stringify(Credential) + "},\"usage\":{\"output_tokens\":1}") + Frame("message_stop", "\"x\":0")),
        };
        var probe = (Dictionary<string, object?>)(await harness.Run(chat => chat.Dispatch("profile.probe", new() { ["profileId"] = Azure })))!;
        Assert.Equal("Anthropic completion ended with [REDACTED].", probe["detail"]);
        Assert.Single(harness.Handler.Requests);
    }

    [Fact]
    public async Task ARightToLeftHostIsRefusedAtSave()
    {
        // A named difference, fail-closed: TypeScript saves this host, which the adapter then refuses natively (P2.4a).
        await using var harness = await Harness.Open("fresh");
        var before = await harness.Rows("SELECT rowid AS _rowid,* FROM profiles ORDER BY rowid");
        var profile = Profile(); profile["endpoint"] = "https://" + (char)0x05D0 + ".openai.azure.com";
        var refused = await Assert.ThrowsAsync<WorkspaceReadException>(() => harness.Run(chat => chat.Dispatch("profile.save", profile)));
        Assert.Equal("Invalid URL", refused.Message);
        Assert.Equal(JsJson.Stringify(before), JsJson.Stringify(await harness.Rows("SELECT rowid AS _rowid,* FROM profiles ORDER BY rowid")));
    }

    [Fact]
    public async Task AProbeWithABlankCredentialSendsNothing()
    {
        // JavaScript's trim, not .NET's: a byte order mark and an ideographic space are whitespace too.
        var blank = " \t" + (char)0xFEFF + (char)0x3000;
        var handler = new Handler();
        using var transport = new AzureTransport(handler);
        var result = await new AzureProvider("responses", transport).Probe(Profile(), blank);
        Assert.False(result.Ok);
        Assert.Equal("A matching profile and credential are required to probe this provider.", result.Detail);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task ShutdownWaitsForAProbeToFinishAndDiscardsItsResult()
    {
        await using var harness = await Harness.Open("fresh");
        await harness.Run(chat => chat.Dispatch("profile.save", Profile()));
        await harness.Run(chat => { chat.SetCredential(Azure, Credential, Binding(Profile())); return Task.FromResult<object?>(null); });
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var held = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        harness.Handler.Respond = async (_, token) => { held.TrySetResult(); await release.Task.WaitAsync(token); return new HttpResponseMessage(HttpStatusCode.Unauthorized); };
        var probe = harness.Run(chat => chat.Dispatch("profile.probe", new() { ["profileId"] = Azure }));
        await held.Task.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);
        var shutdown = harness.Loop.Invoke(async () => { await harness.Chat.Shutdown(); return 0; });
        await Task.Delay(200, TestContext.Current.CancellationToken);
        Assert.False(shutdown.IsCompleted);
        release.SetResult();
        await shutdown;
        // As in TypeScript, a probe that ends after shutdown began is discarded rather than saved.
        Assert.Equal("Runtime is shutting down.", (await Assert.ThrowsAsync<InvalidOperationException>(() => probe)).Message);
        Assert.Equal("failed", Assert.Single(await harness.Rows("SELECT outcome FROM provider_requests"))["outcome"]);
    }

    [Fact]
    public async Task ProfilesAndCredentialsAreRefusedWhileAResponseRuns()
    {
        await using var harness = await Harness.Open("fresh");
        await harness.Run(chat => chat.Dispatch("profile.save", Profile()));
        // The offline provider pauses after every 12 characters, so this answer keeps its turn running.
        var started = (Dictionary<string, object?>)(await harness.Run(chat => chat.Dispatch("task.start", (Dictionary<string, object?>)Contracts.Validate("rpc task.start", new Dictionary<string, object?>
        {
            ["requestId"] = Guid.NewGuid().ToString(), ["projectId"] = null, ["content"] = new string('x', 6_000), ["profileId"] = Offline, ["mode"] = "chat",
        })!)))!;
        Assert.Equal("running", started["status"]);
        var offline = (Dictionary<string, object?>)(await harness.Run(chat => chat.Dispatch("profile.read", new() { ["profileId"] = Offline })))!;
        var save = await Assert.ThrowsAsync<WorkspaceReadException>(() => harness.Run(chat => chat.Dispatch("profile.save", (Dictionary<string, object?>)Contracts.Validate("rpc profile.save", offline)!)));
        Assert.Equal("Cancel active responses before editing this profile.", save.Message);
        var credential = await Assert.ThrowsAsync<WorkspaceReadException>(() => harness.Run(chat => { chat.SetCredential(Azure, Credential, Binding(Profile())); return Task.FromResult<object?>(null); }));
        Assert.Equal("Wait for active responses before changing credentials.", credential.Message);
        await harness.Run(chat => chat.Dispatch("task.cancel", new() { ["taskId"] = started["id"] }));
    }

    private sealed class Handler : HttpMessageHandler
    {
        internal List<HttpRequestMessage> Requests { get; } = [];
        internal Func<HttpRequestMessage, HttpResponseMessage> Answer { get; set; } = _ => new HttpResponseMessage(HttpStatusCode.BadRequest);
        internal Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>>? Respond { get; set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(request);
            return Respond?.Invoke(request, cancellationToken) ?? Task.FromResult(Answer(request));
        }
    }

    private sealed class Harness : IAsyncDisposable
    {
        internal RuntimeLoop Loop { get; } = new();
        internal Handler Handler { get; } = new();
        internal DevelopmentChat Chat { get; private set; } = null!;
        private Store store = null!;

        internal static async Task<Harness> Open(string era)
        {
            var harness = new Harness();
            var data = Directory.CreateTempSubdirectory("foundry-p2-profile-native-").FullName;
            if (era != "fresh")
            {
                foreach (var file in Directory.GetFiles(Path.Combine(RepositoryFixture.Root, "tests", "fixtures", "databases", era), "workspace.db*")) File.Copy(file, Path.Combine(data, Path.GetFileName(file)));
                File.WriteAllText(Path.Combine(data, Store.IsolationMarker), Store.IsolationDeclaration);
            }
            await harness.Loop.Invoke(() =>
            {
                harness.store = new Store(harness.Loop, data, Path.Combine(data, "injected-root"));
                harness.Chat = new DevelopmentChat(harness.Loop, harness.store, null, transport: new AzureTransport(harness.Handler), probeDeadline: TimeSpan.FromSeconds(5));
                return Task.FromResult(0);
            });
            return harness;
        }

        internal Task<object?> Run(Func<DevelopmentChat, Task<object?>> action) => Loop.Invoke(() => action(Chat));
        internal Task<List<Dictionary<string, object?>>> Rows(string sql) => Loop.Invoke(() => Task.FromResult(store.Rows(sql)));

        public async ValueTask DisposeAsync()
        {
            await Loop.Invoke(async () => { await Chat.Shutdown(); store.Dispose(); return 0; });
            await Loop.DisposeAsync();
        }
    }
}
