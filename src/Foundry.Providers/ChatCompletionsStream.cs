using System.Text;
using Foundry.Protocol;
using static Foundry.Providers.ProviderJson;
using static Foundry.Providers.ProviderPayloads;

namespace Foundry.Providers;

/// <summary>
/// streamChat of packages/providers: Chat Completions deltas to text, then the assembled tool calls once the stream has
/// ended with [DONE] and a consistent terminal finish reason. Metadata is reported from every frame that names a model or id;
/// the last valid usage is reported once, before a terminal failure. Tool calls are emitted only after every check.
/// </summary>
internal static class ChatCompletionsStream
{
    // Argument text is appended to a builder: TypeScript's += is linear in V8, where a .NET concatenation copies (P2.4b
    // review N1).
    private sealed class Part { internal string? Id; internal string? Name; internal readonly StringBuilder Arguments = new(); }

    internal static async IAsyncEnumerable<ProviderChatEvent> Read(IAsyncEnumerable<SseFrame> frames, PreparedRequest prepared)
    {
        // A JavaScript Map keyed by the integer index; -0 and 0 are one key, and the calls are ordered by index at the end.
        var parts = new Dictionary<double, Part>();
        var content = new StringBuilder();
        var done = false;
        string? terminal = null, terminalFailure = null;
        ProviderUsage? usage = null;
        await foreach (var frame in frames)
        {
            if (frame.Data == "[DONE]")
            {
                if (done) throw new InvalidOperationException("Chat Completions provider sent duplicate [DONE].");
                done = true;
                continue;
            }
            if (done) throw new InvalidOperationException("Chat Completions provider sent data after [DONE].");
            var payload = Json(frame);
            EventType(frame, payload);
            if (MetadataFrom(payload) is { } metadata) yield return metadata;
            usage = UsageFrom(payload) ?? usage;
            if (Truthy(Member(payload, "error")))
            {
                if (usage is not null) yield return usage;
                throw new InvalidOperationException("Chat Completions provider reported an error.");
            }
            var choices = payload.GetValueOrDefault("choices") as List<object?> ?? [];
            foreach (var choice in choices)
            {
                if (choice is not Dictionary<string, object?> record) continue;
                var delta = record.GetValueOrDefault("delta") as Dictionary<string, object?> ?? [];
                var finish = Member(record, "finish_reason");
                var text = delta.GetValueOrDefault("content") as string;
                if (terminal is not null && (text is not null || delta.GetValueOrDefault("tool_calls") is List<object?> || !Nullish(finish)))
                {
                    if (usage is not null) yield return usage;
                    throw new InvalidOperationException("Chat Completions provider sent content after its terminal finish reason.");
                }
                if (text is not null)
                {
                    content.Append(text);
                    yield return new ProviderText(text);
                }
                if (Truthy(Member(delta, "refusal")) || Truthy(Member(delta, "function_call")))
                {
                    if (usage is not null) yield return usage;
                    throw new InvalidOperationException("Chat Completions returned unsupported content.");
                }
                if (delta.GetValueOrDefault("tool_calls") is List<object?> calls)
                    foreach (var part in calls) Add(parts, part);
                if (finish is "tool_calls" or "stop")
                {
                    if (terminal is not null) throw new InvalidOperationException("Chat completion reported a repeated terminal finish reason.");
                    terminal = (string)finish;
                }
                else if (Truthy(finish)) terminalFailure = $"Chat completion ended with {JsString(finish)}.";
            }
        }
        if (usage is not null) yield return usage;
        if (terminalFailure is not null) throw new InvalidOperationException(terminalFailure);
        if (!done) throw new InvalidOperationException("Provider stream ended before [DONE].");
        if (terminal is null) throw new InvalidOperationException("Chat completion ended without a terminal finish reason.");
        var assembled = parts.OrderBy(entry => entry.Key).Select(entry => Call(entry.Value)).ToList();
        if (terminal == "tool_calls" != assembled.Count > 0) throw new InvalidOperationException("Chat completion tool-call finish state was inconsistent.");
        AzureRequests.ValidateCalls(assembled, prepared);
        foreach (var call in assembled) yield return call;
        var assistant = new Dictionary<string, object?> { ["role"] = "assistant", ["content"] = content.Length > 0 ? content.ToString() : null };
        if (assembled.Count > 0)
            assistant["tool_calls"] = assembled.Select(call => (object?)new Dictionary<string, object?>
            {
                ["id"] = call.Id, ["type"] = "function", ["function"] = new Dictionary<string, object?> { ["name"] = call.Name, ["arguments"] = JsJson.Stringify(call.Arguments) },
            }).ToList();
        var history = new List<object?>(AzureRequests.ProviderArray(prepared.State["messages"])) { assistant };
        yield return new ProviderDone(new(AzureRequests.ChatCompletions, new Dictionary<string, object?> { ["messages"] = history, ["calls"] = assembled.Select(call => (object?)call.Call()).ToList() }));
    }

    /// <summary>addChatPart(): a delta names its call by integer index; ids and names replace, argument text appends.</summary>
    private static void Add(Dictionary<double, Part> parts, object? raw)
    {
        if (raw is not Dictionary<string, object?> record || !IsInteger(record.GetValueOrDefault("index"))) throw new InvalidOperationException("Invalid chat tool-call delta.");
        var index = (double)record["index"]! + 0d;
        if (!parts.TryGetValue(index, out var part)) parts[index] = part = new Part();
        if (record.GetValueOrDefault("id") is string id) part.Id = id;
        var function = record.GetValueOrDefault("function") as Dictionary<string, object?> ?? [];
        if (function.GetValueOrDefault("name") is string name) part.Name = name;
        if (function.GetValueOrDefault("arguments") is string arguments) part.Arguments.Append(arguments);
    }

    /// <summary>chatCall(): an id and a name, both non-empty, and complete JSON arguments.</summary>
    private static ProviderToolCall Call(Part part) =>
        string.IsNullOrEmpty(part.Id) || string.IsNullOrEmpty(part.Name) ? throw new InvalidOperationException("Incomplete chat tool call.") : new(part.Id, part.Name, ParseArguments(part.Arguments.ToString()));
}
