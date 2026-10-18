using System.Net;
using System.Security.Cryptography;
using System.Text;
using Foundry.Protocol;
using Foundry.Providers;
using Xunit;

namespace Foundry.Conformance;

/// <summary>
/// The Azure transport's native-only behaviour (P2.4a): what the production handler is configured to do, and the outcomes
/// measured against undici that a recording fetch cannot show. No test sends through the production handler.
/// </summary>
public sealed class ProviderTransportNativeTests
{
    private static readonly string Credential = "fixture-" + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(12));
    private const string Done = "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";

    [Fact]
    public void TheProductionHandlerFollowsNoRedirectAndUsesNoAmbientState()
    {
        using var handler = AzureTransport.CreateHandler(TransportLimits.Undici);
        Assert.False(handler.AllowAutoRedirect);
        Assert.False(handler.UseCookies);
        Assert.False(handler.UseProxy);
        Assert.Null(handler.Proxy);
        Assert.Null(handler.Credentials);
        Assert.Null(handler.DefaultProxyCredentials);
        Assert.False(handler.PreAuthenticate);
        Assert.Equal(DecompressionMethods.None, handler.AutomaticDecompression);
        Assert.Null(handler.SslOptions.RemoteCertificateValidationCallback);
        Assert.Null(handler.SslOptions.ClientCertificates);
        Assert.Equal(TimeSpan.FromSeconds(10), handler.ConnectTimeout);
        Assert.Same(Encoding.Latin1, handler.RequestHeaderEncodingSelector!("api-key", null!));
        Assert.Null(handler.ActivityHeadersPropagator);
        Assert.Equal((TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(300), TimeSpan.FromSeconds(300)), (TransportLimits.Undici.Connect, TransportLimits.Undici.Headers, TransportLimits.Undici.BodyIdle));
    }

    [Theory]
    [InlineData(301, true)] [InlineData(302, true)] [InlineData(303, false)] [InlineData(307, true)] [InlineData(308, false)]
    public async Task ARedirectIsAFetchFailureAndIsNeverFollowed(int status, bool location)
    {
        var handler = new ScriptedHandler(_ =>
        {
            var response = new HttpResponseMessage((HttpStatusCode)status) { Content = new StringContent(Done) };
            if (location) response.Headers.Location = new Uri("https://elsewhere.example/collect");
            return response;
        });
        var error = await Assert.ThrowsAsync<ProviderTransportException>(() => Collect(handler, Request()));
        Assert.Equal("fetch failed", error.Message);
        Assert.Single(handler.Requests);
        Assert.Equal("sample.openai.azure.com", handler.Requests[0].RequestUri!.Host);
    }

    [Fact]
    public async Task TheHeadersBoundIsAFetchFailureAndTheBodyIdleBoundTerminates()
    {
        var limits = new TransportLimits(TimeSpan.FromSeconds(10), TimeSpan.FromMilliseconds(50), TimeSpan.FromSeconds(30));
        var stalled = new ScriptedHandler(async (_, token) => { await Task.Delay(Timeout.Infinite, token); return new HttpResponseMessage(); });
        Assert.Equal("fetch failed", (await Assert.ThrowsAsync<ProviderTransportException>(() => Collect(stalled, Request(), limits))).Message);

        limits = new TransportLimits(TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(30), TimeSpan.FromMilliseconds(50));
        var body = new ProviderTransportTests.ChunkStream([Encoding.UTF8.GetBytes("data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\n")], "hang");
        var idle = new ScriptedHandler(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(body) });
        var events = new List<ProviderChatEvent>();
        var error = await Assert.ThrowsAsync<ProviderTransportException>(() => Collect(idle, Request(), limits, events));
        Assert.Equal("terminated", error.Message);
        Assert.Equal("Hi", Assert.IsType<ProviderText>(Assert.Single(events)).Text);
        Assert.True(body.Disposed);
    }

    [Fact]
    public async Task CancellationIsTheAbortErrorAndDisposesTheResponse()
    {
        using var cancelled = new CancellationTokenSource();
        var waiting = new ScriptedHandler(async (_, token) => { await cancelled.CancelAsync(); await Task.Delay(Timeout.Infinite, token); return new HttpResponseMessage(); });
        var error = await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Run(waiting, Request(), null, null, null, cancelled.Token));
        Assert.Equal("This operation was aborted", error.Message);

        using var reading = new CancellationTokenSource();
        var body = new ProviderTransportTests.ChunkStream([Encoding.UTF8.GetBytes("data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\n")], "hang");
        var streaming = new ScriptedHandler(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(body) });
        var events = new List<ProviderChatEvent>();
        var task = Run(streaming, Request(), null, events, () => reading.Cancel(), reading.Token);
        Assert.Equal("This operation was aborted", (await Assert.ThrowsAnyAsync<OperationCanceledException>(() => task)).Message);
        Assert.True(body.Disposed);

        foreach (var end in new[] { "close", "terminated" })
        {
            var finished = new ProviderTransportTests.ChunkStream([Encoding.UTF8.GetBytes(Done)], end);
            var handler = new ScriptedHandler(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(finished) });
            try { await Collect(handler, Request()); } catch (ProviderTransportException) { }
            Assert.True(finished.Disposed);
        }
    }

    /// <summary>fetch's header-value rules for the credential, as measured on Electron 44.4.1's Node.</summary>
    [Theory]
    [InlineData(" abc ", "abc")] [InlineData("\tabc\t", "abc")] [InlineData("a b", "a b")] [InlineData("abc\r\n", "abc")] [InlineData("caf\u00e9", "caf\u00e9")] [InlineData("\u0085key", "\u0085key")]
    public async Task ACredentialIsSentAsFetchNormalizesIt(string credential, string sent)
    {
        var handler = new ScriptedHandler(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(Done) });
        await Collect(handler, Request(credential));
        Assert.Equal(sent, Assert.Single(handler.Requests[0].Headers.NonValidated["api-key"]));
    }

    [Theory]
    [InlineData("a\nb", "Headers.append: the credential is an invalid header value.")]
    [InlineData(" key1\nkey2 ", "Headers.append: the credential is an invalid header value.")]
    [InlineData("a\rb", "Headers.append: the credential is an invalid header value.")]
    [InlineData("a\0b", "Headers.append: the credential is an invalid header value.")]
    [InlineData("\u20ac", "Cannot convert argument to a ByteString because a character is greater than 255.")]
    [InlineData("a\u007fb", "fetch failed")] [InlineData("a\u0001b", "fetch failed")] [InlineData("a\u000bb", "fetch failed")]
    public async Task AnInvalidCredentialHeaderIsRefusedBeforeAnyRequestWithoutEchoingIt(string credential, string message)
    {
        var handler = new ScriptedHandler(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(Done) });
        var error = await Assert.ThrowsAsync<ProviderTransportException>(() => Collect(handler, Request(credential)));
        Assert.Equal(message, error.Message);
        Assert.Empty(handler.Requests);
        foreach (var part in credential.Split('\n', '\r', '\0', ' ').Where(part => part.Length > 1)) Assert.DoesNotContain(part, error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ProviderJsonRefusesNestingBeyondItsBoundAndKeepsJavaScriptValues()
    {
        var deepest = new string('[', ProviderJson.MaxDepth) + new string(']', ProviderJson.MaxDepth);
        Assert.NotNull(ProviderJson.Parse(deepest));
        Assert.Throws<ProviderJsonException>(() => ProviderJson.Parse("[" + deepest + "]"));
        Assert.Throws<ProviderJsonException>(() => ProviderJson.Parse(new string('[', 500_000)));
        Assert.Equal(double.PositiveInfinity, ProviderJson.Parse("1e400"));
        Assert.Equal("\ud800", ProviderJson.Parse("\"\ud800\""));
        Assert.Equal("{\"a\":2,\"__proto__\":{}}", JsJson.Stringify(ProviderJson.Parse("{\"a\":1,\"__proto__\":{},\"a\":2}")));
    }

    [Fact]
    public async Task DeepPayloadsAndArgumentsAreRefusedWithTheParsersMessages()
    {
        var nested = new string('[', ProviderJson.MaxDepth + 1) + new string(']', ProviderJson.MaxDepth + 1);
        var payload = new ScriptedHandler(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("data: {\"choices\":[],\"x\":" + nested + "}\n\n" + Done) });
        Assert.Equal("Provider sent malformed SSE JSON.", (await Assert.ThrowsAsync<InvalidOperationException>(() => Collect(payload, Request()))).Message);
        var arguments = JsJson.Stringify(nested)!;
        var call = "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"read_file\",\"arguments\":" + arguments + "}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n";
        var tooling = new ScriptedHandler(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(call) });
        var request = Request() with { Tools = [new ProviderTool("read_file", "Read a file.", new Dictionary<string, object?>())] };
        Assert.Equal("Tool call arguments were not complete JSON.", (await Assert.ThrowsAsync<InvalidOperationException>(() => Collect(tooling, request))).Message);
    }

    [Fact]
    public async Task TheCredentialAppearsInNoMessageOrRequestText()
    {
        var request = Request();
        Assert.DoesNotContain(Credential, request.ToString(), StringComparison.Ordinal);
        foreach (var answer in new Func<HttpResponseMessage>[]
        {
            () => new HttpResponseMessage(HttpStatusCode.Unauthorized),
            () => { var limited = new HttpResponseMessage((HttpStatusCode)429); limited.Headers.TryAddWithoutValidation("retry-after", Credential); return limited; },
            () => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("data: " + Credential + "\n\n") },
            () => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"" + Credential + "\"}]}\n\ndata: [DONE]\n\n") },
            () => throw new HttpRequestException("Connection to " + Credential + " failed."),
        })
        {
            var handler = new ScriptedHandler(_ => answer());
            var error = await Assert.ThrowsAnyAsync<InvalidOperationException>(() => Collect(handler, request));
            Assert.Equal(Credential, Assert.Single(handler.Requests[0].Headers.NonValidated["api-key"]));
            // A finish reason is the provider's own text; TypeScript reports it the same way and the runtime redacts it.
            if (error.Message.StartsWith("Chat completion ended with", StringComparison.Ordinal)) continue;
            Assert.DoesNotContain(Credential, error.Message, StringComparison.Ordinal);
        }
    }

    /// <summary>The review's endpoint spellings (P2.4a F1, F2): what WHATWG refuses is refused before any request, a host
    /// .NET's Uri cannot hold fails as name resolution would, and a right-to-left host is refused (a named difference).</summary>
    [Theory]
    [InlineData("https://::@x.openai.azure.com", "Endpoint must be an HTTPS Azure resource URL without path, credentials, query, or fragment.")]
    [InlineData("https://xn--.openai.azure.com", "Endpoint must be a valid HTTPS Azure URL.")]
    [InlineData("https://xn--zz.openai.azure.com", "Endpoint must be a valid HTTPS Azure URL.")]
    [InlineData("https://xn--a.openai.azure.com", "Endpoint must be a valid HTTPS Azure URL.")]
    [InlineData("https://xn--abc-.openai.azure.com", "Endpoint must be a valid HTTPS Azure URL.")]
    [InlineData("https://a\u0640b.openai.azure.com", "Endpoint must be a valid HTTPS Azure URL.")]
    [InlineData("https://\u05e2\u05d1\u05e8\u05d9\u05ea.openai.azure.com", "Endpoint must be a valid HTTPS Azure URL.")]
    [InlineData("https://a!b.openai.azure.com", "fetch failed")]
    [InlineData("https://a(b).openai.azure.com", "fetch failed")]
    [InlineData("https://a~b.openai.azure.com", "fetch failed")]
    public async Task EndpointsTypeScriptRefusesOrCannotReachSendNothing(string endpoint, string message)
    {
        var handler = new ScriptedHandler(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(Done) });
        var request = Request();
        request = request with { Profile = new Dictionary<string, object?>(request.Profile!) { ["endpoint"] = endpoint } };
        Assert.Equal(message, (await Assert.ThrowsAnyAsync<InvalidOperationException>(() => Collect(handler, request))).Message);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public void ARequestSerializesWithoutItsCredential()
    {
        var request = Request() with { Tools = [new ProviderTool("read_file", "Read.", new Dictionary<string, object?>())] };
        var wire = JsJson.Stringify(request)!;
        Assert.DoesNotContain(Credential, wire, StringComparison.Ordinal);
        Assert.Equal("{\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}],\"tools\":[{\"name\":\"read_file\",\"description\":\"Read.\",\"inputSchema\":{}}]}", wire);
    }

    private static ProviderRequest Request(string? credential = null) => new([new ProviderMessage("user", "hello")])
    {
        Profile = new Dictionary<string, object?>
        {
            ["id"] = "0c46787b-9dce-4a8d-a8aa-6fe7f8a44d53", ["name"] = "Transport", ["apiKind"] = "chat-completions", ["endpoint"] = "https://sample.openai.azure.com",
            ["deployment"] = "test-model", ["contextLimit"] = 4096d, ["outputLimit"] = 256d,
        },
        Credential = credential ?? Credential,
    };

    private static Task Collect(ScriptedHandler handler, ProviderRequest request) => Run(handler, request, null, null, null, TestContext.Current.CancellationToken);
    private static Task Collect(ScriptedHandler handler, ProviderRequest request, TransportLimits limits, List<ProviderChatEvent>? events = null) => Run(handler, request, limits, events, null, TestContext.Current.CancellationToken);

    private static async Task Run(ScriptedHandler handler, ProviderRequest request, TransportLimits? limits, List<ProviderChatEvent>? events, Action? afterEvent, CancellationToken token)
    {
        using var transport = new AzureTransport(handler, limits);
        await foreach (var value in new AzureProvider("chat-completions", transport).StreamTurn(request, token))
        {
            events?.Add(value);
            afterEvent?.Invoke();
        }
    }

    private sealed class ScriptedHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> answer;
        internal List<HttpRequestMessage> Requests { get; } = [];
        internal ScriptedHandler(Func<HttpRequestMessage, HttpResponseMessage> answer) => this.answer = (request, _) => Task.FromResult(answer(request));
        internal ScriptedHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> answer) => this.answer = answer;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(request);
            return answer(request, cancellationToken);
        }
    }
}
