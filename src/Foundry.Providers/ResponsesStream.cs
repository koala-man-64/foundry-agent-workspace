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
                    if (streamed.Count > 0)
                    {
                        var index = output.Select(MatchKey).OfType<ItemKey>().ToHashSet();
                        foreach (var candidate in streamed)
                            if (MatchKey(candidate) is not { } key || !index.Contains(key)) throw new InvalidOperationException("Responses completion output did not match an output item event.");
                    }
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

    /// <summary>What matchingResponseItem() compares, as one key: two items match exactly when their keys are equal. The type,
    /// and for a function call its call id, name and arguments, are compared with ===; the id only when either is a string;
    /// otherwise the serialized content when either has content. An item whose compared value is an object or array matches
    /// nothing, as === compares those by identity and the streamed and completed items come from different parses. The
    /// completion's items are indexed once, so the check is linear rather than streamed × output × content (P2.4b review N2).</summary>
    private readonly record struct ItemKey(string Type, string? Id, string? CallId, string? Name, string? Arguments, string? Content);

    private static ItemKey? MatchKey(Dictionary<string, object?> item)
    {
        if (Strict(Member(item, "type")) is not { } type) return null;
        var id = Member(item, "id") as string;
        if (Equals(Member(item, "type"), "function_call"))
            return Strict(Member(item, "call_id")) is { } call && Strict(Member(item, "name")) is { } name && Strict(Member(item, "arguments")) is { } arguments
                ? new ItemKey(type, id, call, name, arguments, null)
                : null;
        // JSON.stringify of a parsed value is always a string, which never equals the undefined of a missing content.
        return new ItemKey(type, id, null, null, null, item.TryGetValue("content", out var content) ? "c" + JsJson.Stringify(content) : "-");
    }

    /// <summary>A primitive as === compares it (-0 and 0 are equal), or null for an object, an array or NaN, which equal nothing
    /// from another parse.</summary>
    private static string? Strict(object? value) => value switch
    {
        null => "l",
        Undefined => "u",
        bool flag => flag ? "t" : "f",
        string text => "s" + text,
        double number when !double.IsNaN(number) => "n" + BitConverter.DoubleToInt64Bits(number + 0d).ToString(System.Globalization.CultureInfo.InvariantCulture),
        _ => null,
    };

    /// <summary>containsUnsupported(): a refusal or computer call at any depth.</summary>
    internal static bool ContainsUnsupported(object? value) => value switch
    {
        List<object?> items => items.Any(ContainsUnsupported),
        IReadOnlyList<Dictionary<string, object?>> records => records.Any(ContainsUnsupported),
        Dictionary<string, object?> record => record.GetValueOrDefault("type") is "refusal" or "computer_call" || record.Values.Any(ContainsUnsupported),
        _ => false,
    };

}
