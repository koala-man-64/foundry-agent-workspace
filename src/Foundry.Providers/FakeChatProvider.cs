using System.Runtime.CompilerServices;
using Foundry.Protocol;

namespace Foundry.Providers;

public sealed record ProviderMessage(string Role, string Content);
public sealed record ProviderContinuation(string ApiKind, object? Data) : IWireModel
{
    public Dictionary<string, object?> ToWire() => new() { ["apiKind"] = ApiKind, ["data"] = Data };
}
/// <summary>A tool's result as the next request returns it to the model.</summary>
public sealed record ProviderToolResult(string Id, string Name, string Content, bool IsError);
/// <summary>What a provider reads of a request: the messages, the native continuation, the advertised tools and the
/// results of the previous response's tool calls, and for an external profile the stored profile and its credential.
/// Budgeting reads the full request, never this record.</summary>
public sealed record ProviderRequest(IReadOnlyList<ProviderMessage> Messages, ProviderContinuation? Continuation = null,
    IReadOnlyList<ProviderTool>? Tools = null, IReadOnlyList<ProviderToolResult>? ToolResults = null) : IWireModel
{
    /// <summary>The profile as the runtime stored it. The offline provider reads none of it.</summary>
    public IReadOnlyDictionary<string, object?>? Profile { get; init; }
    /// <summary>The profile's credential, from the runtime's memory only.</summary>
    public string? Credential { get; init; }
    /// <summary>Never prints the credential, as a record's generated text would.</summary>
    public override string ToString() => nameof(ProviderRequest);
    /// <summary>What JsJson writes for the request: never the credential, which a property walk would include (P2.4a
    /// review F4).</summary>
    public Dictionary<string, object?> ToWire() => new()
    {
        ["messages"] = Messages.Select(message => (object?)new Dictionary<string, object?> { ["role"] = message.Role, ["content"] = message.Content }).ToList(),
        ["continuation"] = Continuation is null ? Undefined.Value : Continuation,
        ["tools"] = Tools is null ? Undefined.Value : Tools.Select(tool => (object?)new Dictionary<string, object?> { ["name"] = tool.Name, ["description"] = tool.Description, ["inputSchema"] = tool.InputSchema }).ToList(),
        ["toolResults"] = ToolResults is null ? Undefined.Value : ToolResults.Select(result => (object?)new Dictionary<string, object?> { ["id"] = result.Id, ["name"] = result.Name, ["content"] = result.Content, ["isError"] = result.IsError }).ToList(),
    };
    internal bool Advertises(string name) => Tools?.Any(tool => tool.Name == name) == true;
}
public abstract record ProviderChatEvent : IWireModel
{
    public abstract Dictionary<string, object?> ToWire();
}
public sealed record ProviderText(string Text) : ProviderChatEvent
{
    public override Dictionary<string, object?> ToWire() => new() { ["type"] = "text", ["text"] = Text };
}
public sealed record ProviderToolCall(string Id, string Name, object? Arguments) : ProviderChatEvent
{
    /// <summary>The call as a continuation and the provider state keep it.</summary>
    public Dictionary<string, object?> Call() => new() { ["id"] = Id, ["name"] = Name, ["arguments"] = Arguments };
    public override Dictionary<string, object?> ToWire() => new() { ["type"] = "tool_call", ["call"] = Call() };
}
/// <summary>The end of a response, with the provider's native continuation when it gave one.</summary>
public sealed record ProviderDone(ProviderContinuation? Continuation) : ProviderChatEvent
{
    public override Dictionary<string, object?> ToWire() => new() { ["type"] = "done", ["continuation"] = Continuation is null ? Undefined.Value : Continuation };
}

/// <summary>
/// The offline provider of packages/providers (FakeProvider): text, continuation, the project-channel demo, the coding demo
/// (read, an approved edit, an approved command) and the stopped browser demo. The MCP, browser and orchestration demos
/// need tools native does not advertise yet; a continuation in one of their stages is refused as invalid, and the runtime
/// refuses such a stored continuation before any request. No profile verification, credentials or provider fallback.
/// </summary>
public sealed class FakeChatProvider
{
    private const string ChannelDemo = "/channel-demo";
    private readonly Func<CancellationToken, Task> pause;
    private readonly Func<Guid> id;
    // Node's zero-delay timer yields to a later event-loop turn; do not substitute a completed task in production.
    public FakeChatProvider(Func<CancellationToken, Task>? pause = null, Func<Guid>? id = null)
    {
        this.pause = pause ?? (token => Task.Delay(1, token));
        this.id = id ?? Guid.NewGuid;
    }

    public IAsyncEnumerable<ProviderChatEvent> StreamTurn(IReadOnlyList<ProviderMessage> messages,
        ProviderContinuation? continuation = null, CancellationToken cancellationToken = default) => StreamTurn(new ProviderRequest(messages, continuation), cancellationToken);

    public async IAsyncEnumerable<ProviderChatEvent> StreamTurn(ProviderRequest request, [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var last = request.Messages.LastOrDefault(message => message.Role == "user")?.Content;
        // browser-fixture.ts runs before any continuation check. Without browser tools it proposes nothing and stops.
        if (last is not null && JsJson.Trim(last) == "/browser-demo")
        {
            CheckCancellation(cancellationToken);
            yield return new ProviderText("Offline browser demo stopped. Attach a page containing a button named Browser demo action.");
            yield return Done("complete", []);
            yield break;
        }
        var state = State(request.Continuation);
        CheckCancellation(cancellationToken);
        if (request.Advertises("send_agent_message") && (last ?? "").StartsWith(ChannelDemo, StringComparison.Ordinal))
        {
            var content = JsJson.Trim(last![ChannelDemo.Length..]);
            var call = new ProviderToolCall(id().ToString(), "send_agent_message",
                new Dictionary<string, object?> { ["recipientTaskId"] = null, ["content"] = content.Length > 0 ? content : "Hello from the offline agent." });
            yield return call;
            yield return Done("channel-send", [call.Call()]);
            yield break;
        }
        if (state?.Stage == "channel-send")
        {
            var expected = state.Calls.FirstOrDefault()?["id"];
            var result = request.ToolResults?.FirstOrDefault(item => Equals(item.Id, expected));
            await foreach (var text in Text(result?.IsError == true ? "Channel message was not sent." : "Channel message recorded. Idle agents receive it on their next turn.", cancellationToken))
                yield return text;
            yield return Done("complete", []);
            yield break;
        }
        // The coding demo, on a task's first turn: read the README, propose appending a line, then propose a command.
        if (state is null && request.Advertises("read_file") && (last ?? "").StartsWith("/demo", StringComparison.Ordinal))
        {
            RequireTools(request, ["read_file", "replace_text", "run_command"]);
            var call = new ProviderToolCall("fake-read-1", "read_file", new Dictionary<string, object?> { ["path"] = "README.md" });
            yield return call;
            yield return Done("read", [call.Call()]);
            yield break;
        }
        if (state?.Stage == "read")
        {
            var result = First(RequiredResults(request, state.Calls), "name");
            var read = Content(result, "read_file") as IReadOnlyDictionary<string, object?>;
            if (result.IsError || read?.GetValueOrDefault("path") is not string path || read.GetValueOrDefault("content") is not string content || read.GetValueOrDefault("hash") is not string hash)
            {
                await foreach (var text in Text("Offline demo stopped: read_file failed or returned invalid content.", cancellationToken)) yield return text;
                yield return Done("complete", []);
                yield break;
            }
            var call = new ProviderToolCall("fake-replace-1", "replace_text",
                new Dictionary<string, object?> { ["path"] = path, ["expectedHash"] = hash, ["oldText"] = content, ["newText"] = content + "\nFoundry offline demo completed.\n" });
            yield return call;
            yield return Done("replace", [call.Call()]);
            yield break;
        }
        if (state?.Stage == "replace")
        {
            if (First(RequiredResults(request, state.Calls), "isError").IsError)
            {
                await foreach (var text in Text("Offline demo stopped: replace_text was rejected or failed.", cancellationToken)) yield return text;
                yield return Done("complete", []);
                yield break;
            }
            var call = new ProviderToolCall("fake-command-1", "run_command", new Dictionary<string, object?>
            {
                ["command"] = "Write-Output 'Foundry command demo completed'", ["cwd"] = "", ["environment"] = new Dictionary<string, object?>(), ["timeoutMs"] = 10000d,
            });
            yield return call;
            yield return Done("command", [call.Call()]);
            yield break;
        }
        if (state?.Stage == "command")
        {
            var result = First(RequiredResults(request, state.Calls), "isError");
            await foreach (var text in Text(result.IsError ? "Offline demo completed with a command error." : "Foundry offline demo completed.", cancellationToken)) yield return text;
            yield return Done("complete", []);
            yield break;
        }
        if (state is not null && state.Stage is not ("chat" or "complete")) throw new InvalidOperationException("Invalid fake continuation.");
        await foreach (var text in Text("Fake response: " + (string.IsNullOrEmpty(last) ? "No user message." : last), cancellationToken)) yield return text;
        yield return Done("chat", []);
    }

    /// <summary>FakeProvider.probe: the offline profile's fixed capabilities, without any request.</summary>
    public static ProbeResult Probe(IReadOnlyDictionary<string, object?> profile)
    {
        ArgumentNullException.ThrowIfNull(profile);
        var offline = Equals(profile.GetValueOrDefault("apiKind"), "fake");
        return new(offline, true, true, true, true, false, offline ? "Offline deterministic text, tools, and continuation are available." : "Profile API kind does not match this provider.");
    }

    private async IAsyncEnumerable<ProviderChatEvent> Text(string value, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        for (var index = 0; index < value.Length; index += 12)
        {
            CheckCancellation(cancellationToken);
            // JavaScript slice counts UTF-16 units and can split an emoji into two lone surrogates.
            yield return new ProviderText(value.Substring(index, Math.Min(12, value.Length - index)));
            // Node installs the timer's abort listener after the yielded text. An earlier abort is seen
            // by the next text check, but a final-text abort can still be followed by done. Pin this quirk.
            var pauseToken = cancellationToken.IsCancellationRequested ? CancellationToken.None : cancellationToken;
            try { await pause(pauseToken); }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw Aborted(cancellationToken); }
        }
    }

    /// <summary>requireTools: every named tool was advertised.</summary>
    private static void RequireTools(ProviderRequest request, string[] names)
    {
        foreach (var name in names)
            if (!request.Advertises(name)) throw new InvalidOperationException($"Tool {name} was not advertised.");
    }

    /// <summary>requiredResults: one result for each pending call, matched by id and name, in the order the request gives
    /// them; none when nothing is pending.</summary>
    private static IReadOnlyList<ProviderToolResult> RequiredResults(ProviderRequest request, List<IReadOnlyDictionary<string, object?>> calls)
    {
        if (calls.Count == 0)
        {
            if (request.ToolResults is { Count: > 0 }) throw new InvalidOperationException("Tool results were supplied without pending calls.");
            return [];
        }
        if (request.ToolResults is not { Count: > 0 } results) throw new InvalidOperationException("Pending tool calls require matching results.");
        var expected = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var call in calls) expected[(string)call["id"]!] = (string)call["name"]!;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var result in results)
        {
            if (!expected.TryGetValue(result.Id, out var name) || !seen.Add(result.Id) || result.Name != name) throw new InvalidOperationException("Tool result does not match a pending call.");
        }
        if (seen.Count != expected.Count) throw new InvalidOperationException("Missing tool result for a pending call.");
        return results;
    }

    /// <summary>results[0], whose first property read fails as JavaScript's does when there is none.</summary>
    private static ProviderToolResult First(IReadOnlyList<ProviderToolResult> results, string member) =>
        results.Count > 0 ? results[0] : throw new InvalidOperationException($"Cannot read properties of undefined (reading '{member}')");

    /// <summary>parseToolContent: the result of the named tool, parsed, or nothing when its text is not JSON.</summary>
    private static object? Content(ProviderToolResult result, string name)
    {
        if (result.Name != name) throw new InvalidOperationException("Tool result name mismatch.");
        try { return PersistedJson.Parse(result.Content); }
        catch (System.Text.Json.JsonException) { return null; }
    }

    private static ProviderDone Done(string stage, List<object?> calls) => new(new("fake", new Dictionary<string, object?> { ["stage"] = stage, ["calls"] = calls }));

    private sealed record FakeState(string Stage, List<IReadOnlyDictionary<string, object?>> Calls);

    /// <summary>fakeState: a continuation's stage and calls. Its shape is checked here; an unknown stage only after the
    /// demo stages, as TypeScript checks it.</summary>
    private static FakeState? State(ProviderContinuation? continuation)
    {
        if (continuation is null) return null;
        if (continuation.ApiKind != "fake" || continuation.Data is not IReadOnlyDictionary<string, object?> data || data.GetValueOrDefault("stage") is not string stage)
            throw new InvalidOperationException("Invalid fake continuation.");
        var calls = new List<IReadOnlyDictionary<string, object?>>();
        if (data.GetValueOrDefault("calls") is List<object?> items)
            foreach (var call in items)
            {
                if (call is not IReadOnlyDictionary<string, object?> item || item.GetValueOrDefault("id") is not string || item.GetValueOrDefault("name") is not string)
                    throw new InvalidOperationException("Invalid continuation call.");
                calls.Add(item);
            }
        return new(stage, calls);
    }
    private static void CheckCancellation(CancellationToken token) { if (token.IsCancellationRequested) throw Aborted(token); }
    private static OperationCanceledException Aborted(CancellationToken token) => new("This operation was aborted", token);
}
