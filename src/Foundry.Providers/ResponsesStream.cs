using Foundry.Protocol;
using static Foundry.Providers.ProviderJson;
using static Foundry.Providers.ProviderPayloads;

namespace Foundry.Providers;

/// <summary>
/// streamResponses of packages/providers: text deltas as they arrive; output items, which must carry no refusal or computer
/// call anywhere in them; and one completion, whose output (when present) must contain every streamed item. Tool calls come
/// from the authoritative output and are emitted only after every check, followed by the continuation: the request's input
/// with the output appended, and the calls.
/// </summary>
internal static class ResponsesStream
{
    internal static async IAsyncEnumerable<ProviderChatEvent> Read(IAsyncEnumerable<SseFrame> frames, PreparedRequest prepared)
    {
        var streamed = new List<Dictionary<string, object?>>();
        var completed = false;
        var sawText = false;
        List<Dictionary<string, object?>>? output = null;
        await foreach (var frame in frames)
        {
            var payload = Json(frame);
            var type = EventType(frame, payload);
            if (completed) throw new InvalidOperationException("Responses provider sent content after completion.");
            if (type == "response.output_text.delta")
            {
                if (payload.GetValueOrDefault("delta") is not string text) throw new InvalidOperationException("Invalid Responses text delta.");
                sawText = true;
                yield return new ProviderText(text);
            }
            else if (type == "response.output_item.done")
            {
                if (payload.GetValueOrDefault("item") is not Dictionary<string, object?> item) throw new InvalidOperationException("Invalid Responses output item.");
                if (ContainsUnsupported(item)) throw new InvalidOperationException("Responses provider returned unsupported content.");
                streamed.Add(item);
            }
            else if (type == "response.completed")
            {
                var response = payload.GetValueOrDefault("response") as Dictionary<string, object?> ?? [];
                if (MetadataFrom(response) is { } metadata) yield return metadata;
                if (UsageFrom(response) is { } usage) yield return usage;
                if (!Equals(Member(response, "status"), "completed") || Truthy(Member(response, "incomplete_details"))) throw new InvalidOperationException("Responses completion was incomplete.");
                if (ContainsUnsupported(response)) throw new InvalidOperationException("Responses provider returned unsupported content.");
                var listed = Member(response, "output");
                if (listed is not Undefined)
                {
                    if (listed is not List<object?> items || !items.All(IsRecord)) throw new InvalidOperationException("Responses completion output was invalid.");
                    output = [.. items.Cast<Dictionary<string, object?>>()];
                    foreach (var candidate in streamed)
                        if (!output.Any(item => Matches(candidate, item))) throw new InvalidOperationException("Responses completion output did not match an output item event.");
                }
                // TypeScript's two conditions reduce to this: without output, streamed items alone stand for it, text never does.
                else if (sawText) throw new InvalidOperationException("Responses completion omitted authoritative output items.");
                completed = true;
            }
            else if (type is "response.failed" or "response.incomplete")
            {
                var response = payload.GetValueOrDefault("response") as Dictionary<string, object?> ?? [];
                if (MetadataFrom(response) is { } metadata) yield return metadata;
                if (UsageFrom(response) is { } usage) yield return usage;
                throw new InvalidOperationException("Responses provider returned unsupported or failed content.");
            }
            else if (type == "error" || type?.Contains("refusal", StringComparison.Ordinal) == true || ContainsUnsupported(payload))
            {
                var response = payload.GetValueOrDefault("response") as Dictionary<string, object?> ?? payload;
                if (MetadataFrom(response) is { } metadata) yield return metadata;
                if (UsageFrom(response) is { } usage) yield return usage;
                throw new InvalidOperationException("Responses provider returned unsupported or failed content.");
            }
        }
        if (!completed) throw new InvalidOperationException("Provider stream ended before a completion signal.");
        var final = output ?? streamed;
        if (ContainsUnsupported(final)) throw new InvalidOperationException("Responses provider returned unsupported content.");
        var calls = final.Where(item => Equals(item.GetValueOrDefault("type"), "function_call")).Select(Call).ToList();
        AzureRequests.ValidateCalls(calls, prepared);
        foreach (var call in calls) yield return call;
        var input = new List<object?>(AzureRequests.ProviderArray(prepared.State["input"]));
        input.AddRange(final);
        yield return new ProviderDone(new(AzureRequests.Responses, new Dictionary<string, object?> { ["input"] = input, ["calls"] = calls.Select(call => (object?)call.Call()).ToList() }));
    }

    /// <summary>responseCall(): a call id, a name and argument text, all strings.</summary>
    private static ProviderToolCall Call(Dictionary<string, object?> item) =>
        item.GetValueOrDefault("call_id") is string id && item.GetValueOrDefault("name") is string name && item.GetValueOrDefault("arguments") is string arguments
            ? new(id, name, ParseArguments(arguments))
            : throw new InvalidOperationException("Invalid Responses function call.");

    /// <summary>matchingResponseItem(): the same type and id, the same call for a function call, and otherwise the same
    /// serialized content when either has content.</summary>
    private static bool Matches(Dictionary<string, object?> streamed, Dictionary<string, object?> completed)
    {
        if (!StrictEquals(Member(streamed, "type"), Member(completed, "type"))) return false;
        if ((Member(streamed, "id") is string || Member(completed, "id") is string) && !StrictEquals(Member(streamed, "id"), Member(completed, "id"))) return false;
        if (Equals(Member(streamed, "type"), "function_call"))
            return StrictEquals(Member(streamed, "call_id"), Member(completed, "call_id")) && StrictEquals(Member(streamed, "name"), Member(completed, "name")) && StrictEquals(Member(streamed, "arguments"), Member(completed, "arguments"));
        if (streamed.ContainsKey("content") || completed.ContainsKey("content"))
            return JsJson.Stringify(Member(streamed, "content")) == JsJson.Stringify(Member(completed, "content"));
        return true;
    }

    /// <summary>containsUnsupported(): a refusal or computer call at any depth.</summary>
    internal static bool ContainsUnsupported(object? value) => value switch
    {
        List<object?> items => items.Any(ContainsUnsupported),
        IReadOnlyList<Dictionary<string, object?>> records => records.Any(ContainsUnsupported),
        Dictionary<string, object?> record => record.GetValueOrDefault("type") is "refusal" or "computer_call" || record.Values.Any(ContainsUnsupported),
        _ => false,
    };

    /// <summary>JavaScript's === over JSON.parse values: primitives by value, objects and arrays by identity.</summary>
    private static bool StrictEquals(object? left, object? right) => (left, right) switch
    {
        (null, null) or (Undefined, Undefined) => true,
        (string a, string b) => a == b,
        (double a, double b) => a == b,
        (bool a, bool b) => a == b,
        (Dictionary<string, object?> or List<object?>, _) => ReferenceEquals(left, right),
        _ => false,
    };
}
