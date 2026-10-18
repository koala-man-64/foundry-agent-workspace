using System.Net;
using System.Text;
using Foundry.Protocol;
using Foundry.Providers;
using Xunit;

namespace Foundry.Conformance;

/// <summary>
/// The Responses and Anthropic parsers at the JSON depth bound (P2.4b): payloads as deep as <see cref="ProviderJson.MaxDepth"/>
/// allows pass through the recursive checks and the continuation's serialization without exhausting the stack, and a
/// refusal at the deepest level is still found. One level more is refused as malformed before any recursive walk.
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

    private static async Task<List<ProviderChatEvent>> Stream(string kind, string body)
    {
        using var transport = new AzureTransport(new Answer(body));
        var request = new ProviderRequest([new ProviderMessage("user", "hello")], Tools: Tools)
        {
            Profile = new Dictionary<string, object?> { ["apiKind"] = kind, ["endpoint"] = "https://sample.openai.azure.com", ["deployment"] = "d", ["contextLimit"] = 4096d, ["outputLimit"] = 256d },
            Credential = "fixture-" + Guid.NewGuid().ToString("N"),
        };
        var events = new List<ProviderChatEvent>();
        await foreach (var item in new AzureProvider(kind, transport).StreamTurn(request, TestContext.Current.CancellationToken)) events.Add(item);
        return events;
    }

    private sealed class Answer(string body) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Encoding.UTF8.GetBytes(body)) });
    }
}
