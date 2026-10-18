using System.Net;
using System.Security.Cryptography;
using System.Text;
using Foundry.Protocol;
using Foundry.Providers;
using Xunit;

namespace Foundry.Conformance;

/// <summary>
/// The Azure adapter's requests, transport, SSE framing and Chat Completions parser against the committed Node outcomes
/// (tests/p2/provider-transport.test.ts). A recording handler answers each request with exactly the recorded chunks, one per
/// read, so both runtimes read the same bytes in the same pieces.
/// </summary>
public sealed class ProviderTransportTests
{
    private const string Corpus = "tests/p2/provider-transport-vectors.json";

    /// <summary>
    /// Retry-After spellings only Date.parse reads (P2.4a): "-1" is the year 1 BCE and "5, 6" (two headers, joined) a date in
    /// 2001, both in the past, so TypeScript waits 0 seconds; native reads neither, so the orchestrator would use its default.
    /// </summary>
    private static readonly HashSet<string> DateParseOnly = new(["-1", "5, 6"], StringComparer.Ordinal);

    public static IEnumerable<object[]> Cases()
    {
        var corpus = (Dictionary<string, object?>)PersistedJson.Parse(File.ReadAllText(Path.Combine(RepositoryFixture.Root, Corpus)))!;
        foreach (var item in ((List<object?>)corpus["cases"]!).Cast<Dictionary<string, object?>>()) yield return [(string)item["name"]!, JsJson.Stringify(item)!];
    }

    [Fact]
    public void VectorsAreBoundToTheProviderSources() => RepositoryFixture.AssertOracleSources(RepositoryFixture.ReadCorpus(Corpus));

    [Theory, MemberData(nameof(Cases))]
    public async Task RequestsEventsAndErrorsMatchCommittedNodeOutcomes(string name, string json)
    {
        Assert.NotEmpty(name);
        var item = (Dictionary<string, object?>)PersistedJson.Parse(json)!;
        var input = (Dictionary<string, object?>)item["input"]!;
        var expected = (Dictionary<string, object?>)item["expected"]!;
        var outcome = await Run(input, (expected["requests"] as List<object?>)?.Cast<Dictionary<string, object?>>().ToList() ?? []);
        var error = outcome.Error;
        if (input.GetValueOrDefault("now") is double && RetryAfterValue(input) is { } retry && DateParseOnly.Contains(retry))
        {
            Assert.NotNull(error);
            Assert.Null(error["retryAfterSeconds"]);
            error["retryAfterSeconds"] = ((Dictionary<string, object?>)expected["error"]!)["retryAfterSeconds"];
        }
        var actual = new Dictionary<string, object?> { ["requests"] = outcome.Requests, ["events"] = outcome.Events, ["error"] = error };
        Assert.Equal(JsJson.Stringify(expected), JsJson.Stringify(actual));
    }

    /// <summary>
    /// Streams one oracle input through the adapter and a recording handler, with a fresh credential, and returns what the
    /// oracle records: each request, every event and the error as JavaScript names it. The provider stream replay
    /// (<see cref="ProviderStreamTests"/>) uses it too.
    /// </summary>
    internal static async Task<(List<object?> Requests, List<object?> Events, Dictionary<string, object?>? Error)> Run(Dictionary<string, object?> input, List<Dictionary<string, object?>> expectedRequests)
    {
        var credential = "fixture-" + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(12));
        var handler = new RecordingHandler(input, expectedRequests, credential);
        using var transport = new AzureTransport(handler);
        var kind = (string)input["kind"]!;
        var provider = new AzureProvider((string?)input.GetValueOrDefault("provider") ?? kind, transport, () => input.GetValueOrDefault("now") is double now ? (long)now : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        var request = Request(input, credential);
        using var cancelled = new CancellationTokenSource();
        if (Equals(input.GetValueOrDefault("abortBefore"), true)) await cancelled.CancelAsync();
        var events = new List<object?>(); Dictionary<string, object?>? error = null; Exception? cause = null;
        try
        {
            await foreach (var value in provider.StreamTurn(request, cancelled.Token))
            {
                events.Add(value);
                if (input.GetValueOrDefault("abortAfterEvents") is double count && events.Count == count) await cancelled.CancelAsync();
            }
        }
        catch (Exception caught) when (caught is InvalidOperationException or OperationCanceledException)
        {
            cause = caught.InnerException;
            error = new()
            {
                ["name"] = caught switch { OperationCanceledException => "AbortError", ProviderTransportException => "TypeError", ProviderHttpException => "ProviderHttpError", _ => "Error" },
                ["message"] = caught.Message.Replace(credential, "{credential}", StringComparison.Ordinal),
            };
            if (caught is ProviderHttpException http) { error["status"] = (double)http.Status; error["retryAfterSeconds"] = http.RetryAfterSeconds; }
        }
        if (handler.Failure is not null) throw handler.Failure;
        if (error is not null && Equals(error["message"], "fetch failed") && handler.Requests.Count == 0 && !Equals(input.GetValueOrDefault("fetchRejects"), true))
            throw new Xunit.Sdk.XunitException("Transport failed before the handler: " + cause);
        return (handler.Requests, events, error);
    }

    private static string? RetryAfterValue(Dictionary<string, object?> input)
    {
        var headers = ((input.GetValueOrDefault("response") as Dictionary<string, object?>)?.GetValueOrDefault("headers") as List<object?>)?.Cast<List<object?>>().Where(pair => (string)pair[0]! == "retry-after").Select(pair => (string)pair[1]!).ToList();
        return headers is { Count: > 0 } ? string.Join(", ", headers) : null;
    }

    private static ProviderRequest Request(Dictionary<string, object?> input, string credential)
    {
        var kind = (string)input["kind"]!;
        var profile = new Dictionary<string, object?>
        {
            ["id"] = "0c46787b-9dce-4a8d-a8aa-6fe7f8a44d53", ["name"] = "Transport", ["apiKind"] = kind, ["endpoint"] = "https://sample.openai.azure.com",
            ["deployment"] = "test-model", ["contextLimit"] = 4096d, ["outputLimit"] = 256d,
        };
        if (input.GetValueOrDefault("profile") is Dictionary<string, object?> overrides) foreach (var (key, value) in overrides) profile[key] = value;
        var messages = input.TryGetValue("messages", out var listed)
            ? ((List<object?>)listed!).Cast<Dictionary<string, object?>>().Select(message => new ProviderMessage((string)message["role"]!, (string)message["content"]!)).ToArray()
            : [new ProviderMessage("user", "hello")];
        var tools = (input.GetValueOrDefault("tools") as List<object?>)?.Cast<Dictionary<string, object?>>().Select(tool => new ProviderTool((string)tool["name"]!, (string)tool["description"]!, tool.GetValueOrDefault("inputSchema"))).ToArray();
        var state = input.GetValueOrDefault("continuation") as Dictionary<string, object?>;
        var results = (input.GetValueOrDefault("toolResults") as List<object?>)?.Cast<Dictionary<string, object?>>()
            .Select(result => new ProviderToolResult((string)result["id"]!, (string)result["name"]!, (string)result["content"]!, (bool)result["isError"]!)).ToArray();
        var given = input.GetValueOrDefault("credential");
        return new ProviderRequest(messages, state is null ? null : new ProviderContinuation((string)state["apiKind"]!, state.GetValueOrDefault("data")), tools, results)
        {
            Profile = profile,
            Credential = given is "{credential}" ? credential : given as string,
        };
    }

    /// <summary>Records each request as the oracle records fetch's arguments, and answers with the input's response.</summary>
    private sealed class RecordingHandler(Dictionary<string, object?> input, List<Dictionary<string, object?>> expectedRequests, string credential) : HttpMessageHandler
    {
        // Nothing but the adapter's headers and the content's framing headers is sent.
        private static readonly string[] RequestHeaders = ["Accept", "api-key", "anthropic-version"], ContentHeaders = ["Content-Type", "Content-Length"];
        internal List<object?> Requests { get; } = [];
        /// <summary>An assertion that failed inside the handler, which the transport would otherwise report as "fetch failed".</summary>
        internal Exception? Failure { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            try { return await Answer(request, cancellationToken); }
            catch (Exception error) when (error is Xunit.Sdk.XunitException) { Failure = error; throw; }
        }

        private async Task<HttpResponseMessage> Answer(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var headers = new Dictionary<string, object?>();
            foreach (var name in new[] { "accept", "content-type", "api-key", "anthropic-version" })
            {
                var source = name == "content-type" ? (System.Net.Http.Headers.HttpHeaders)request.Content!.Headers : request.Headers;
                if (source.NonValidated.TryGetValues(name, out var values)) headers[name] = Scrub(string.Join(", ", values));
            }
            Assert.All(request.Headers.NonValidated, header => Assert.Contains(header.Key, RequestHeaders));
            Assert.All(request.Content!.Headers.NonValidated, header => Assert.Contains(header.Key, ContentHeaders));
            Assert.Equal(HttpVersion.Version11, request.Version);
            Assert.Equal(HttpVersionPolicy.RequestVersionExact, request.VersionPolicy);
            var body = Encoding.UTF8.GetString(await request.Content.ReadAsByteArrayAsync(cancellationToken));
            Requests.Add(new Dictionary<string, object?> { ["url"] = Target(request.RequestUri!), ["method"] = request.Method.Method, ["headers"] = headers, ["body"] = Scrub(body), ["redirect"] = "error" });
            if (Equals(input.GetValueOrDefault("fetchRejects"), true)) throw new HttpRequestException("No connection could be made.");
            var response = input.GetValueOrDefault("response") as Dictionary<string, object?> ?? [];
            var status = response.GetValueOrDefault("status") is double code ? (int)code : 200;
            var message = new HttpResponseMessage((HttpStatusCode)status);
            var chunks = response.GetValueOrDefault("body") is List<object?> listed ? Chunks(listed) : null;
            message.Content = chunks is null ? new ByteArrayContent([]) : new StreamContent(new ChunkStream(chunks, (string?)response.GetValueOrDefault("end") ?? "close"));
            if (response.GetValueOrDefault("headers") is List<object?> pairs)
                foreach (var pair in pairs.Cast<List<object?>>()) message.Headers.TryAddWithoutValidation((string)pair[0]!, (string)pair[1]!);
            return message;
        }

        /// <summary>The oracle records String(url), which keeps an empty query or fragment marker that is never sent.</summary>
        private string Target(Uri uri)
        {
            var expected = expectedRequests.ElementAtOrDefault(Requests.Count)?["url"] as string;
            var sent = uri.AbsoluteUri;
            Assert.Equal("", uri.Query); Assert.Equal("", uri.Fragment);
            return expected is not null && expected.TrimEnd('?', '#') == sent ? expected : sent;
        }

        private string Scrub(string value) => value.Replace(credential, "{credential}", StringComparison.Ordinal);
    }

    private static List<byte[]> Chunks(List<object?> body)
    {
        static byte[] One(object? chunk) => chunk switch
        {
            string text => Encoding.UTF8.GetBytes(text),
            Dictionary<string, object?> spec when spec.TryGetValue("bytes", out var bytes) => [.. ((List<object?>)bytes!).Select(value => (byte)(double)value!)],
            Dictionary<string, object?> spec => Encoding.UTF8.GetBytes(string.Concat(Enumerable.Repeat((string)spec["text"]!, (int)(double)spec["times"]!))),
            _ => throw new InvalidOperationException("Unknown chunk."),
        };
        var chunks = new List<byte[]>();
        foreach (var item in body)
        {
            if (item is Dictionary<string, object?> spec && spec.TryGetValue("chunk", out var repeated)) chunks.AddRange(Enumerable.Repeat(One(repeated), (int)(double)spec["count"]!));
            else chunks.Add(One(item));
        }
        return chunks;
    }

    /// <summary>One recorded chunk per read; then the end the oracle gives: close, a lost connection, or a wait.</summary>
    internal sealed class ChunkStream(List<byte[]> chunks, string end) : Stream
    {
        private int next;
        internal bool Disposed { get; private set; }
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (next < chunks.Count)
            {
                var chunk = chunks[next++];
                Assert.True(chunk.Length <= buffer.Length, "Each recorded chunk must fit one native read.");
                chunk.CopyTo(buffer);
                return chunk.Length;
            }
            if (end == "terminated") throw new IOException("The response ended prematurely.");
            if (end == "hang") await Task.Delay(Timeout.Infinite, cancellationToken);
            return 0;
        }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        protected override void Dispose(bool disposing) { Disposed = true; base.Dispose(disposing); }
    }
}
