using Foundry.Protocol;
using static Foundry.Providers.ProviderJson;

namespace Foundry.Providers;

/// <summary>The payload helpers the three stream parsers share: json, eventType, metadataFrom, usageFrom and parseArguments.</summary>
internal static class ProviderPayloads
{
    /// <summary>json(): a frame's data must be a JSON object.</summary>
    internal static Dictionary<string, object?> Json(SseFrame frame)
    {
        try { if (Parse(frame.Data) is Dictionary<string, object?> value) return value; }
        catch (ProviderJsonException) { }
        throw new InvalidOperationException("Provider sent malformed SSE JSON.");
    }

    /// <summary>eventType(): the SSE event name and a string payload type must agree; the name wins.</summary>
    internal static string? EventType(SseFrame frame, Dictionary<string, object?> payload)
    {
        var payloadType = payload.GetValueOrDefault("type") as string;
        if (!string.IsNullOrEmpty(frame.Event) && payloadType is { Length: > 0 } && frame.Event != payloadType) throw new InvalidOperationException("Provider SSE event type did not match its payload type.");
        return frame.Event ?? payloadType;
    }

    /// <summary>metadataFrom(): a model and id of 1 to 200 UTF-16 units each.</summary>
    internal static ProviderMetadata? MetadataFrom(Dictionary<string, object?> value)
    {
        var model = value.GetValueOrDefault("model") is string { Length: > 0 and <= 200 } reported ? reported : null;
        var id = value.GetValueOrDefault("id") is string { Length: > 0 and <= 200 } response ? response : null;
        return model is null && id is null ? null : new ProviderMetadata(model, id);
    }

    /// <summary>
    /// usageFrom(): input and output totals (Responses and Anthropic names first), with cached, cache-creation and reasoning
    /// subsets that must be safe integers within their totals. A subset that is present but invalid, including JSON null,
    /// makes the whole report unknown; nothing is defaulted to zero.
    /// </summary>
    internal static ProviderUsage? UsageFrom(object? value)
    {
        if (!IsRecord(value)) return null;
        var usage = IsRecord(Member(value, "usage")) ? Member(value, "usage") : value;
        var input = Coalesce(Member(usage, "input_tokens"), Member(usage, "prompt_tokens"));
        var output = Coalesce(Member(usage, "output_tokens"), Member(usage, "completion_tokens"));
        if (!ValidUsageInteger(input) || !ValidUsageInteger(output)) return null;
        var details = IsRecord(Member(usage, "prompt_tokens_details")) ? Member(usage, "prompt_tokens_details") : IsRecord(Member(usage, "input_tokens_details")) ? Member(usage, "input_tokens_details") : Undefined.Value;
        var outputDetails = IsRecord(Member(usage, "output_tokens_details")) ? Member(usage, "output_tokens_details") : IsRecord(Member(usage, "completion_tokens_details")) ? Member(usage, "completion_tokens_details") : Undefined.Value;
        var cacheRead = Coalesce(Member(details, "cached_tokens"), Member(usage, "cache_read_input_tokens"));
        var cacheCreation = Member(usage, "cache_creation_input_tokens");
        var reasoning = Member(outputDetails, "reasoning_tokens");
        double inputTokens = (double)input!, outputTokens = (double)output!;
        bool Present(object? subset) => subset is not Undefined;
        if (Present(cacheRead) && (!ValidUsageInteger(cacheRead) || (double)cacheRead! > inputTokens)
            || Present(cacheCreation) && (!ValidUsageInteger(cacheCreation) || (double)cacheCreation! > inputTokens)
            || Present(cacheRead) && Present(cacheCreation) && (double)cacheRead! + (double)cacheCreation! > inputTokens
            || Present(reasoning) && (!ValidUsageInteger(reasoning) || (double)reasoning! > outputTokens)) return null;
        return new ProviderUsage(inputTokens, outputTokens, Present(cacheRead) ? (double)cacheRead! : null, Present(cacheCreation) ? (double)cacheCreation! : null, Present(reasoning) ? (double)reasoning! : null);
    }

    /// <summary>parseArguments(): a tool call's arguments are complete JSON of any kind.</summary>
    internal static object? ParseArguments(string value)
    {
        try { return Parse(value); }
        catch (ProviderJsonException) { throw new InvalidOperationException("Tool call arguments were not complete JSON."); }
    }

    /// <summary>a ?? b: JavaScript's nullish coalescing over absent members and JSON null.</summary>
    internal static object? Coalesce(object? value, object? fallback) => Nullish(value) ? fallback : value;
}
