using System.Globalization;
using System.Text.RegularExpressions;
using Foundry.Protocol;

namespace Foundry.Providers;

/// <summary>A request's native body, the conversation state its continuation will extend, the pending calls and the
/// advertised tool names (nativeRequest's Prepared).</summary>
internal sealed record PreparedRequest(Dictionary<string, object?> Body, Dictionary<string, object?> State, IReadOnlyList<ProviderToolCall> Calls, IReadOnlySet<string> Tools);

/// <summary>
/// The request half of packages/providers' AzureProvider: effort validation, nativeRequest for each API kind, the endpoint
/// rule and target, the headers, and Retry-After. Property order matches TypeScript's object literals, so JsJson gives the
/// body TypeScript sends, byte for byte.
/// </summary>
internal static partial class AzureRequests
{
    internal const string Responses = "responses", ChatCompletions = "chat-completions", Anthropic = "anthropic";
    private static readonly string[] Efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

    /// <summary>supportedEfforts in packages/protocol/src/limits.ts.</summary>
    internal static IReadOnlyList<string> SupportedEfforts(object? apiKind) => apiKind switch
    {
        Responses => Efforts,
        ChatCompletions => [.. Efforts.Where(effort => effort != "max")],
        Anthropic => ["low", "medium", "high", "xhigh", "max"],
        _ => [],
    };

    internal static void ValidateEffort(IReadOnlyDictionary<string, object?> profile)
    {
        if (profile.TryGetValue("effort", out var effort) && effort is not Undefined && !(effort is string name && SupportedEfforts(profile.GetValueOrDefault("apiKind")).Contains(name)))
            throw new InvalidOperationException("Effort is not supported by this API type.");
    }

    internal static PreparedRequest Prepare(string kind, ProviderRequest request)
    {
        var profile = request.Profile!;
        var data = request.Continuation is null ? null : ContinuationData(kind, request.Continuation);
        var tools = request.Tools ?? [];
        var names = tools.Select(tool => tool.Name).ToHashSet(StringComparer.Ordinal);
        var effort = profile.TryGetValue("effort", out var value) ? value : Undefined.Value;
        List<object?> Messages(IEnumerable<ProviderMessage> messages) => [.. messages.Select(message => (object?)Message(message.Role, message.Content))];
        if (kind == Responses)
        {
            var input = data is null ? Messages(request.Messages) : [.. ProviderArray(data.GetValueOrDefault("input", Undefined.Value))];
            var calls = data is null ? [] : CallsFrom(data.GetValueOrDefault("calls", Undefined.Value));
            if (data is not null)
            {
                input.AddRange(RequiredResults(request, calls).Select(result => (object?)new Dictionary<string, object?> { ["type"] = "function_call_output", ["call_id"] = result.Id, ["output"] = result.Content }));
                input.AddRange(Messages(request.Messages));
            }
            var body = new Dictionary<string, object?>
            {
                ["model"] = profile.GetValueOrDefault("deployment", Undefined.Value), ["input"] = input, ["stream"] = true, ["store"] = false,
                ["include"] = new List<object?> { "reasoning.encrypted_content" }, ["max_output_tokens"] = profile.GetValueOrDefault("outputLimit", Undefined.Value),
            };
            if (effort is not Undefined) body["reasoning"] = new Dictionary<string, object?> { ["effort"] = effort };
            if (tools.Count > 0) body["tools"] = tools.Select(tool => (object?)new Dictionary<string, object?> { ["type"] = "function", ["name"] = tool.Name, ["description"] = tool.Description, ["parameters"] = tool.InputSchema, ["strict"] = false }).ToList();
            return new(body, new() { ["input"] = input }, calls, names);
        }
        if (kind == ChatCompletions)
        {
            var messages = data is null ? Messages(request.Messages) : [.. ProviderArray(data.GetValueOrDefault("messages", Undefined.Value))];
            var calls = data is null ? [] : CallsFrom(data.GetValueOrDefault("calls", Undefined.Value));
            if (data is not null)
            {
                messages.AddRange(RequiredResults(request, calls).Select(result => (object?)new Dictionary<string, object?> { ["role"] = "tool", ["tool_call_id"] = result.Id, ["content"] = result.Content }));
                messages.AddRange(Messages(request.Messages));
            }
            var body = new Dictionary<string, object?>
            {
                ["model"] = profile.GetValueOrDefault("deployment", Undefined.Value), ["messages"] = messages, ["stream"] = true,
                ["stream_options"] = new Dictionary<string, object?> { ["include_usage"] = true }, ["max_completion_tokens"] = profile.GetValueOrDefault("outputLimit", Undefined.Value),
            };
            if (effort is not Undefined) body["reasoning_effort"] = effort;
            if (tools.Count > 0) body["tools"] = tools.Select(tool => (object?)new Dictionary<string, object?> { ["type"] = "function", ["function"] = new Dictionary<string, object?> { ["name"] = tool.Name, ["description"] = tool.Description, ["parameters"] = tool.InputSchema, ["strict"] = false } }).ToList();
            return new(body, new() { ["messages"] = messages }, calls, names);
        }
        // Anthropic keeps system text apart from the messages; a continuation carries both.
        var state = data ?? new Dictionary<string, object?>
        {
            ["messages"] = Messages(request.Messages.Where(message => message.Role != "system")),
            ["system"] = string.Join("\n\n", request.Messages.Where(message => message.Role == "system").Select(message => message.Content)),
            ["calls"] = new List<object?>(),
        };
        var history = new List<object?>(ProviderArray(state.GetValueOrDefault("messages", Undefined.Value)));
        var pending = CallsFrom(state.GetValueOrDefault("calls", Undefined.Value));
        if (data is not null)
        {
            var next = request.Messages.Where(message => message.Role != "system").ToList();
            var results = RequiredResults(request, pending).Select(result => new Dictionary<string, object?>
            {
                ["role"] = "user", ["content"] = new List<object?> { new Dictionary<string, object?> { ["type"] = "tool_result", ["tool_use_id"] = result.Id, ["content"] = result.Content, ["is_error"] = result.IsError } },
            }).ToList();
            // A single new user message joins every result's block, in the request's order: Anthropic refuses a tool_use left
            // unanswered (T-1, dual-landed).
            if (results.Count > 0 && next.Count == 1 && next[0].Role == "user")
                history.Add(new Dictionary<string, object?> { ["role"] = "user", ["content"] = new List<object?>([.. results.SelectMany(result => (List<object?>)result["content"]!), new Dictionary<string, object?> { ["type"] = "text", ["text"] = next[0].Content }]) });
            else { history.AddRange(results); history.AddRange(Messages(next)); }
        }
        var system = state.GetValueOrDefault("system", Undefined.Value);
        var anthropic = new Dictionary<string, object?>
        {
            ["model"] = profile.GetValueOrDefault("deployment", Undefined.Value), ["messages"] = history, ["stream"] = true, ["max_tokens"] = profile.GetValueOrDefault("outputLimit", Undefined.Value),
        };
        if (effort is not Undefined) anthropic["output_config"] = new Dictionary<string, object?> { ["effort"] = effort };
        if (system is string { Length: > 0 }) anthropic["system"] = system;
        if (tools.Count > 0) anthropic["tools"] = tools.Select(tool => (object?)new Dictionary<string, object?> { ["name"] = tool.Name, ["description"] = tool.Description, ["input_schema"] = tool.InputSchema }).ToList();
        return new(anthropic, new() { ["messages"] = history, ["system"] = system }, pending, names);
    }

    private static Dictionary<string, object?> Message(string role, string content) => new() { ["role"] = role, ["content"] = content };

    private static Dictionary<string, object?> ContinuationData(string kind, ProviderContinuation continuation) =>
        continuation.ApiKind == kind && continuation.Data is Dictionary<string, object?> data ? data : throw new InvalidOperationException("Continuation belongs to a different or invalid provider.");

    /// <summary>array(): continuation state must be an array.</summary>
    internal static List<object?> ProviderArray(object? value) => value as List<object?> ?? throw new InvalidOperationException("Invalid continuation state.");

    /// <summary>callsFrom(): each pending call needs a string id and name; anything but an array is no calls.</summary>
    internal static List<ProviderToolCall> CallsFrom(object? value)
    {
        if (value is not List<object?> items) return [];
        return [.. items.Select(call => call is Dictionary<string, object?> record && record.GetValueOrDefault("id") is string id && record.GetValueOrDefault("name") is string name
            ? new ProviderToolCall(id, name, record.GetValueOrDefault("arguments", Undefined.Value))
            : throw new InvalidOperationException("Invalid continuation call."))];
    }

    /// <summary>requiredResults(): one result for each pending call, matched by id and name, in the request's order.</summary>
    internal static IReadOnlyList<ProviderToolResult> RequiredResults(ProviderRequest request, IReadOnlyList<ProviderToolCall> calls)
    {
        if (calls.Count == 0)
        {
            if (request.ToolResults is { Count: > 0 }) throw new InvalidOperationException("Tool results were supplied without pending calls.");
            return [];
        }
        if (request.ToolResults is not { Count: > 0 } results) throw new InvalidOperationException("Pending tool calls require matching results.");
        var expected = new Dictionary<string, ProviderToolCall>(StringComparer.Ordinal);
        foreach (var call in calls) expected[call.Id] = call;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var result in results)
            if (!expected.TryGetValue(result.Id, out var call) || !seen.Add(result.Id) || result.Name != call.Name) throw new InvalidOperationException("Tool result does not match a pending call.");
        if (seen.Count != expected.Count) throw new InvalidOperationException("Missing tool result for a pending call.");
        return results;
    }

    /// <summary>validateCalls(): every call names an advertised tool, and no id repeats.</summary>
    internal static void ValidateCalls(IReadOnlyList<ProviderToolCall> calls, PreparedRequest prepared)
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var call in calls)
        {
            if (!prepared.Tools.Contains(call.Name)) throw new InvalidOperationException($"Provider requested unadvertised tool {call.Name}.");
            if (!ids.Add(call.Id)) throw new InvalidOperationException("Provider returned duplicate tool-call IDs.");
        }
    }

    /// <summary>
    /// buildTarget(normalizeEndpoint(endpoint), kind) as String(url) gives it, and the URI the request is sent to. The endpoint
    /// rule is the WHATWG reading the provider fingerprint already uses. An empty query or fragment marker stays in the
    /// target's text; undici sends neither (measured), and neither does the URI. A host WHATWG accepts but .NET's Uri cannot
    /// hold (a sub-delimiter such as "!" or "(") has no URI: TypeScript sends that request and fails at name resolution with
    /// "fetch failed", and native fails the same way without sending it (P2.4a review F2).
    /// </summary>
    internal static (string Target, Uri? Uri) Target(string endpoint, string kind)
    {
        var normalized = Compatibility.AzureEndpoint(endpoint);
        var slash = normalized.IndexOf('/', "https://".Length);
        var path = kind == Responses ? "/openai/v1/responses" : kind == ChatCompletions ? "/openai/v1/chat/completions" : "/anthropic/v1/messages";
        var origin = normalized[..slash];
        return (origin + path + normalized[(slash + 1)..], Uri.TryCreate(origin + path, UriKind.Absolute, out var uri) ? uri : null);
    }

    /// <summary>headersFor(), in its order.</summary>
    internal static IReadOnlyList<KeyValuePair<string, string>> Headers(string kind, string credential)
    {
        List<KeyValuePair<string, string>> headers = [new("accept", "text/event-stream"), new("content-type", "application/json"), new("api-key", credential)];
        if (kind == Anthropic) headers.Add(new("anthropic-version", "2023-06-01"));
        return headers;
    }

    /// <summary>
    /// retryAfter(): delta-seconds read as JavaScript's Number reads them, else an HTTP date, rounded up and capped at an hour.
    /// Date.parse accepts more spellings than the three HTTP-date forms read here, and reads asctime in local time; those
    /// differences are named in P2.4a. Only the orchestrator reads the value.
    /// </summary>
    internal static double? RetryAfter(string? value, long now)
    {
        if (string.IsNullOrEmpty(value)) return null;
        var seconds = JsNumber(value);
        if (double.IsFinite(seconds) && seconds >= 0) return Math.Min(3600, Math.Ceiling(seconds));
        var date = HttpDate(value);
        return date is long instant ? Math.Min(3600, Math.Max(0, Math.Ceiling((instant - now) / 1000d))) : null;
    }

    /// <summary>ECMAScript StringToNumber.</summary>
    internal static double JsNumber(string value)
    {
        var text = JsJson.Trim(value);
        if (text.Length == 0) return 0;
        if (text is "Infinity" or "+Infinity") return double.PositiveInfinity;
        if (text == "-Infinity") return double.NegativeInfinity;
        if (text.Length > 2 && text[0] == '0' && text[1] is 'x' or 'X' or 'o' or 'O' or 'b' or 'B')
        {
            var radix = text[1] is 'x' or 'X' ? 16 : text[1] is 'o' or 'O' ? 8 : 2;
            double number = 0;
            foreach (var digit in text[2..])
            {
                var place = char.IsAsciiDigit(digit) ? digit - '0' : char.IsAsciiLetter(digit) ? char.ToLowerInvariant(digit) - 'a' + 10 : 99;
                if (place >= radix) return double.NaN;
                number = number * radix + place;
            }
            return number;
        }
        return DecimalLiteral().IsMatch(text) ? double.Parse(text, NumberStyles.Float, CultureInfo.InvariantCulture) : double.NaN;
    }

    [GeneratedRegex(@"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$", RegexOptions.CultureInvariant)]
    private static partial Regex DecimalLiteral();

    private static readonly string[] HttpDates = ["dd MMM yyyy HH:mm:ss 'GMT'", "dd-MMM-yy HH:mm:ss 'GMT'", "MMM d HH:mm:ss yyyy", "MMM  d HH:mm:ss yyyy", "MMM dd HH:mm:ss yyyy"];

    /// <summary>IMF-fixdate, RFC 850 and asctime, read in UTC with the weekday ignored, as Date.parse ignores it.</summary>
    private static long? HttpDate(string value)
    {
        var text = value.Trim();
        var space = text.IndexOf(' ', StringComparison.Ordinal);
        if (space < 0) return null;
        var rest = text[(space + 1)..];
        return DateTimeOffset.TryParseExact(rest, HttpDates, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var date)
            ? date.ToUnixTimeMilliseconds() : null;
    }
}
