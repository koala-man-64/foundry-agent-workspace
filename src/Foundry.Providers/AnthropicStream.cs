using Foundry.Protocol;
using static Foundry.Providers.ProviderJson;
using static Foundry.Providers.ProviderPayloads;

namespace Foundry.Providers;

/// <summary>
/// streamAnthropic of packages/providers: content blocks are assembled by index (text, thinking and its signature, tool-use
/// JSON) and text deltas are emitted as they arrive. Usage is the message's input with both cache buckets added once, and
/// its output; a stop reason other than end_turn or tool_use fails the response, even if a valid one follows. After
/// message_stop only pings may arrive. Tool calls are emitted only after every block has stopped and the stop reason agrees,
/// followed by the continuation: the messages with the assistant's blocks appended, the system text and the calls.
/// </summary>
internal static class AnthropicStream
{
    internal static async IAsyncEnumerable<ProviderChatEvent> Read(IAsyncEnumerable<SseFrame> frames, PreparedRequest prepared)
    {
        // JavaScript Map and Set keyed by the integer index; -0 and 0 are one key.
        var blocks = new Dictionary<double, Dictionary<string, object?>>();
        var stopped = new HashSet<double>();
        object? input = Undefined.Value, cacheCreation = Undefined.Value, cacheRead = Undefined.Value;
        ProviderUsage? usage = null;
        var done = false;
        string? stopReason = null, failedStopReason = null;
        await foreach (var frame in frames)
        {
            var payload = Json(frame);
            var type = EventType(frame, payload);
            if (done && type != "ping") throw new InvalidOperationException("Anthropic provider sent content after message_stop.");
            if (type == "message_start")
            {
                var message = payload.GetValueOrDefault("message") as Dictionary<string, object?> ?? [];
                if (MetadataFrom(message) is { } metadata) yield return metadata;
                var messageUsage = message.GetValueOrDefault("usage") as Dictionary<string, object?>;
                if (ValidUsageInteger(Member(messageUsage, "input_tokens"))) input = messageUsage!["input_tokens"];
                if (ValidUsageInteger(Member(messageUsage, "cache_creation_input_tokens"))) cacheCreation = messageUsage!["cache_creation_input_tokens"];
                if (ValidUsageInteger(Member(messageUsage, "cache_read_input_tokens"))) cacheRead = messageUsage!["cache_read_input_tokens"];
            }
            else if (type == "content_block_start")
            {
                if (!IsInteger(payload.GetValueOrDefault("index")) || payload.GetValueOrDefault("content_block") is not Dictionary<string, object?> started) throw new InvalidOperationException("Invalid Anthropic content block.");
                var index = Key(payload["index"]);
                if (blocks.ContainsKey(index)) throw new InvalidOperationException("Duplicate Anthropic content block.");
                blocks[index] = new Dictionary<string, object?>(started, StringComparer.Ordinal);
            }
            else if (type == "content_block_delta")
            {
                if (Apply(blocks, payload) is { Length: > 0 } text) yield return new ProviderText(text);
            }
            else if (type == "message_delta")
            {
                var delta = payload.GetValueOrDefault("delta") as Dictionary<string, object?> ?? [];
                var reason = Member(delta, "stop_reason");
                if (reason is "end_turn" or "tool_use") stopReason = (string)reason;
                else failedStopReason = $"Anthropic completion ended with {JsString(reason)}.";
                var messageUsage = payload.GetValueOrDefault("usage") as Dictionary<string, object?>;
                var output = Member(messageUsage, "output_tokens");
                var outputCacheCreation = Coalesce(Member(messageUsage, "cache_creation_input_tokens"), cacheCreation);
                var outputCacheRead = Coalesce(Member(messageUsage, "cache_read_input_tokens"), cacheRead);
                if (ValidUsageInteger(input) && ValidUsageInteger(output) && (outputCacheCreation is Undefined || ValidUsageInteger(outputCacheCreation)) && (outputCacheRead is Undefined || ValidUsageInteger(outputCacheRead)))
                {
                    var total = (double)input! + (outputCacheCreation is double creation ? creation : 0) + (outputCacheRead is double read ? read : 0);
                    if (!ValidUsageInteger(total)) throw new InvalidOperationException("Anthropic usage exceeded the supported range.");
                    usage = new ProviderUsage(total, (double)output!, outputCacheRead as double?, outputCacheCreation as double?);
                }
            }
            else if (type == "content_block_stop")
            {
                if (!IsInteger(payload.GetValueOrDefault("index")) || !blocks.ContainsKey(Key(payload["index"])) || stopped.Contains(Key(payload["index"]))) throw new InvalidOperationException("Invalid Anthropic content block stop.");
                stopped.Add(Key(payload["index"]));
            }
            else if (type == "message_stop") done = true;
            else if (type == "error")
            {
                if (usage is not null) yield return usage;
                throw new InvalidOperationException("Anthropic provider reported an error.");
            }
        }
        if (usage is not null) yield return usage;
        if (failedStopReason is not null) throw new InvalidOperationException(failedStopReason);
        if (!done) throw new InvalidOperationException("Provider stream ended before message_stop.");
        if (stopReason is null) throw new InvalidOperationException("Anthropic completion ended without a stop reason.");
        if (stopped.Count != blocks.Count) throw new InvalidOperationException("Anthropic completion ended before all content blocks stopped.");
        var content = blocks.OrderBy(entry => entry.Key).Select(entry => Finalize(entry.Value)).ToList();
        var calls = content.Where(item => Equals(item.GetValueOrDefault("type"), "tool_use"))
            .Select(item => new ProviderToolCall((string)item["id"]!, (string)item["name"]!, item.GetValueOrDefault("input", Undefined.Value))).ToList();
        if (stopReason == "tool_use" != calls.Count > 0) throw new InvalidOperationException("Anthropic tool-call stop state was inconsistent.");
        AzureRequests.ValidateCalls(calls, prepared);
        foreach (var call in calls) yield return call;
        var history = new List<object?>(AzureRequests.ProviderArray(prepared.State["messages"]))
        {
            new Dictionary<string, object?> { ["role"] = "assistant", ["content"] = content.Cast<object?>().ToList() },
        };
        yield return new ProviderDone(new(AzureRequests.Anthropic, new Dictionary<string, object?>
        {
            ["messages"] = history, ["system"] = prepared.State.GetValueOrDefault("system", Undefined.Value), ["calls"] = calls.Select(call => (object?)call.Call()).ToList(),
        }));
    }

    private static double Key(object? index) => (double)index! + 0d;

    /// <summary>applyAnthropicDelta(): appends text, thinking or tool JSON to its block, or replaces the signature; only text is
    /// returned. The index is looked up as a JavaScript Map looks it up: a string "0" names no block.</summary>
    private static string? Apply(Dictionary<double, Dictionary<string, object?>> blocks, Dictionary<string, object?> payload)
    {
        var block = payload.GetValueOrDefault("index") is double index && blocks.TryGetValue(index + 0d, out var found) ? found : null;
        var delta = payload.GetValueOrDefault("delta") as Dictionary<string, object?>;
        if (block is null || delta is null) throw new InvalidOperationException("Invalid Anthropic content delta.");
        string Prior(string key) => block.GetValueOrDefault(key) as string ?? "";
        switch (delta.GetValueOrDefault("type"))
        {
            case "text_delta" when delta.GetValueOrDefault("text") is string text:
                block["text"] = Prior("text") + text; return text;
            case "thinking_delta" when delta.GetValueOrDefault("thinking") is string thinking:
                block["thinking"] = Prior("thinking") + thinking; return null;
            case "signature_delta" when delta.GetValueOrDefault("signature") is string signature:
                block["signature"] = signature; return null;
            case "input_json_delta" when delta.GetValueOrDefault("partial_json") is string partial:
                block["__json"] = Prior("__json") + partial; return null;
            default: throw new InvalidOperationException("Invalid Anthropic content delta.");
        }
    }

    /// <summary>finalizeAnthropic(): assembled tool JSON becomes the block's input; a tool use needs a non-empty string id and
    /// name and an input.</summary>
    private static Dictionary<string, object?> Finalize(Dictionary<string, object?> block)
    {
        var output = new Dictionary<string, object?>(block, StringComparer.Ordinal);
        if (output.GetValueOrDefault("__json") is string json)
        {
            output["input"] = ParseArguments(json);
            output.Remove("__json");
        }
        if (Equals(output.GetValueOrDefault("type"), "tool_use") && (output.GetValueOrDefault("id") is not string { Length: > 0 } || output.GetValueOrDefault("name") is not string { Length: > 0 } || !output.ContainsKey("input")))
            throw new InvalidOperationException("Incomplete Anthropic tool call.");
        return output;
    }
}
