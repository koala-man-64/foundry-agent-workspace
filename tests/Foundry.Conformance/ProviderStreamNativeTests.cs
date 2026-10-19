using System.Net;
using System.Text;
using Foundry.Protocol;
using Foundry.Providers;
using Xunit;

namespace Foundry.Conformance;

/// <summary>
/// The Responses and Anthropic parsers at the JSON depth bound (P2.4b): payloads as deep as <see cref="ProviderJson.MaxDepth"/>
/// allows pass through the recursive checks and the continuation's serialization without exhausting the stack, and a
/// refusal at the deepest level is still found. One level more is refused as malformed before any recursive walk. And the
/// parsers' work is linear in a stream's size (review N1 and N2).
/// </summary>
public sealed class ProviderStreamNativeTests
{
    private static readonly ProviderTool[] Tools = [new("read_file", "Read a file.", new Dictionary<string, object?>())];

    /// <summary>An output item whose nested arrays bring the whole SSE payload to <paramref name="depth"/> levels.</summary>
    private static string Completed(int depth, string innermost)
    {
        // data {} → response {} → output [] → item {} → nested arrays: four levels before the arrays begin.
        var arrays = depth - 4;
        var nested = new string('[', arrays) + innermost + new string(']', arrays);
        return "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"id\":\"m1\",\"deep\":" + nested + "}]}}\n\n";
    }

    [Fact]
    public async Task AResponsesItemAtTheDepthBoundCompletesAndItsRefusalIsFound()
    {
        var events = await Stream("responses", Completed(ProviderJson.MaxDepth, ""));
        var done = Assert.IsType<ProviderDone>(Assert.Single(events));
        Assert.Contains("\"deep\":[[", JsJson.Stringify(done.Continuation), StringComparison.Ordinal);

        // The innermost array holds an object: one level more for the refusal's own braces.
        var refused = await Assert.ThrowsAsync<InvalidOperationException>(() => Stream("responses", Completed(ProviderJson.MaxDepth - 1, "{\"type\":\"refusal\"}")));
        Assert.Equal("Responses provider returned unsupported content.", refused.Message);

        var deeper = await Assert.ThrowsAsync<InvalidOperationException>(() => Stream("responses", Completed(ProviderJson.MaxDepth + 1, "")));
        Assert.Equal("Provider sent malformed SSE JSON.", deeper.Message);
    }

    [Fact]
    public async Task AnthropicToolInputAtTheDepthBoundBecomesItsContinuation()
    {
        static string Frame(string type, string data) => $"event: {type}\ndata: {{\"type\":\"{type}\",{data}}}\n\n";
        string Body(int depth) =>
            Frame("content_block_start", "\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"read_file\",\"input\":{}}")
            + Frame("content_block_delta", "\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":" + JsJson.Stringify(new string('[', depth) + new string(']', depth)) + "}")
            + Frame("content_block_stop", "\"index\":0") + Frame("message_delta", "\"delta\":{\"stop_reason\":\"tool_use\"}") + Frame("message_stop", "\"x\":0");
        var events = await Stream("anthropic", Body(ProviderJson.MaxDepth));
        Assert.IsType<ProviderToolCall>(events[0]);
        Assert.Contains("\"input\":[[", JsJson.Stringify(Assert.IsType<ProviderDone>(events[1]).Continuation), StringComparison.Ordinal);
        var deeper = await Assert.ThrowsAsync<InvalidOperationException>(() => Stream("anthropic", Body(ProviderJson.MaxDepth + 1)));
        Assert.Equal("Tool call arguments were not complete JSON.", deeper.Message);
    }

    // Review N1 and N2: streams of a few megabytes, as the 8 MiB stream cap admits, that cost many gigabytes of copying when
    // each append copies the text so far or each streamed item is compared with every completed one. The parsers allocate a
    // few hundred bytes per frame; the bound is far below either quadratic cost.
    private const long AllocationBound = 512L * 1024 * 1024;

    [Fact]
    public async Task AnthropicTextAndToolJsonAreAppendedInLinearWork()
    {
        static SseFrame Frame(string type, string data) => new(type, $"{{\"type\":\"{type}\",{data}}}");
        const int Deltas = 30_000;
        var frames = new List<SseFrame>
        {
            Frame("content_block_start", "\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}"),
            Frame("content_block_start", "\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"read_file\",\"input\":{}}"),
            Frame("content_block_delta", "\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"\"}"),
        };
        for (var i = 0; i < Deltas; i++)
        {
            frames.Add(Frame("content_block_delta", "\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"abcdefghij\"}"));
            frames.Add(Frame("content_block_delta", "\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"abcdefghij\"}"));
        }
        frames.AddRange([
            Frame("content_block_delta", "\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"\"}"),
            Frame("content_block_stop", "\"index\":0"), Frame("content_block_stop", "\"index\":1"),
            Frame("message_delta", "\"delta\":{\"stop_reason\":\"tool_use\"}"), Frame("message_stop", "\"x\":0")]);
        var (events, allocated) = await ReadSynchronously("anthropic", frames);
        Assert.InRange(allocated, 0, AllocationBound);
        Assert.Equal(Deltas, events.OfType<ProviderText>().Count());
        Assert.Equal(Deltas * 10, Assert.IsType<string>(Assert.Single(events.OfType<ProviderToolCall>()).Arguments).Length);
        var history = (List<object?>)Data(events[^1])["messages"]!;
        var content = (List<object?>)((Dictionary<string, object?>)history[^1]!)["content"]!;
        Assert.Equal(Deltas * 10, ((string)((Dictionary<string, object?>)content[0]!)["text"]!).Length);
    }

    [Fact]
    public async Task ChatCompletionsArgumentsAreAppendedInLinearWork()
    {
        static SseFrame Frame(string call) => new(null, "{\"choices\":[{\"delta\":{\"tool_calls\":[" + call + "]}}]}");
        const int Deltas = 60_000;
        var frames = new List<SseFrame> { Frame("{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"\\\"\"}}") };
        for (var i = 0; i < Deltas; i++) frames.Add(Frame("{\"index\":0,\"function\":{\"arguments\":\"abcdefghij\"}}"));
        frames.AddRange([Frame("{\"index\":0,\"function\":{\"arguments\":\"\\\"\"}}"), new(null, "{\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}"), new(null, "[DONE]")]);
        var (events, allocated) = await ReadSynchronously("chat-completions", frames);
        Assert.InRange(allocated, 0, AllocationBound);
        Assert.Equal(Deltas * 10, Assert.IsType<string>(Assert.Single(events.OfType<ProviderToolCall>()).Arguments).Length);
    }

    [Fact]
    public async Task ResponsesItemsAreMatchedToTheCompletionInLinearWork()
    {
        // 1,500 messages without ids, each with 2,000 characters of its own text, completed in reverse order.
        const int Items = 1_500;
        var items = Enumerable.Range(0, Items).Select(i => JsJson.Stringify(new Dictionary<string, object?>
        {
            ["type"] = "message", ["content"] = new List<object?> { new Dictionary<string, object?> { ["type"] = "output_text", ["text"] = i.ToString("D6", System.Globalization.CultureInfo.InvariantCulture) + new string('x', 1_994) } },
        })!).ToList();
        var frames = items.Select(item => new SseFrame("response.output_item.done", "{\"type\":\"response.output_item.done\",\"item\":" + item + "}")).ToList();
        frames.Add(new("response.completed", "{\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[" + string.Join(",", Enumerable.Reverse(items)) + "]}}"));
        var (events, allocated) = await ReadSynchronously("responses", frames);
        Assert.InRange(allocated, 0, AllocationBound);
        Assert.Equal(Items, ((List<object?>)Data(Assert.Single(events))["input"]!).Count - 1);

        // One streamed item that no completed item matches still fails, wherever it falls.
        frames.Insert(Items / 2, new("response.output_item.done", "{\"type\":\"response.output_item.done\",\"item\":{\"type\":\"message\",\"content\":[]}}"));
        var unmatched = await Assert.ThrowsAsync<InvalidOperationException>(() => ReadSynchronously("responses", frames));
        Assert.Equal("Responses completion output did not match an output item event.", unmatched.Message);
    }

    /// <summary>Feeds <paramref name="frames"/> to the parser and reads it on this thread: nothing in it awaits, which each step
    /// asserts, so <see cref="GC.GetAllocatedBytesForCurrentThread"/> measures the parser alone.</summary>
    private static async Task<(List<ProviderChatEvent> Events, long Allocated)> ReadSynchronously(string kind, List<SseFrame> frames)
    {
        var prepared = AzureRequests.Prepare(kind, Request(kind));
        var source = Frames(frames);
        IAsyncEnumerable<ProviderChatEvent> parser = kind switch
        {
            AzureRequests.Responses => ResponsesStream.Read(source, prepared),
            AzureRequests.ChatCompletions => ChatCompletionsStream.Read(source, prepared),
            _ => AnthropicStream.Read(source, prepared),
        };
        var events = new List<ProviderChatEvent>(capacity: 128 * 1024);
        var before = GC.GetAllocatedBytesForCurrentThread();
        await using var enumerator = parser.GetAsyncEnumerator(TestContext.Current.CancellationToken);
        while (true)
        {
            var next = enumerator.MoveNextAsync();
            Assert.True(next.IsCompleted);
            if (!await next) break;
            events.Add(enumerator.Current);
        }
        return (events, GC.GetAllocatedBytesForCurrentThread() - before);

        static async IAsyncEnumerable<SseFrame> Frames(List<SseFrame> frames)
        {
            await Task.CompletedTask;
            foreach (var frame in frames) yield return frame;
        }
    }

    private static Dictionary<string, object?> Data(ProviderChatEvent done) => (Dictionary<string, object?>)Assert.IsType<ProviderDone>(done).Continuation!.Data!;

    private static ProviderRequest Request(string kind) => new([new ProviderMessage("user", "hello")], Tools: Tools)
    {
        Profile = new Dictionary<string, object?> { ["apiKind"] = kind, ["endpoint"] = "https://sample.openai.azure.com", ["deployment"] = "d", ["contextLimit"] = 4096d, ["outputLimit"] = 256d },
        Credential = "fixture-" + Guid.NewGuid().ToString("N"),
    };

    private static async Task<List<ProviderChatEvent>> Stream(string kind, string body)
    {
        using var transport = new AzureTransport(new Answer(body));
        var events = new List<ProviderChatEvent>();
        await foreach (var item in new AzureProvider(kind, transport).StreamTurn(Request(kind), TestContext.Current.CancellationToken)) events.Add(item);
        return events;
    }

    private sealed class Answer(string body) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Encoding.UTF8.GetBytes(body)) });
    }
}
