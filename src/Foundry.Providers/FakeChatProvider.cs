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
/// <summary>What a provider reads of a request: the messages, the native continuation, the advertised tool names and the
/// results of the previous response's tool calls. Budgeting reads the full request, never this record.</summary>
public sealed record ProviderRequest(IReadOnlyList<ProviderMessage> Messages, ProviderContinuation? Continuation = null,
    IReadOnlyList<string>? Tools = null, IReadOnlyList<ProviderToolResult>? ToolResults = null);
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
/// The offline provider of packages/providers (FakeProvider): text, continuation, the project-channel demo and the stopped
/// browser demo. The coding, MCP, browser and orchestration demos need tools native does not advertise yet; a continuation
/// in one of their stages is refused as invalid, and the runtime refuses such a stored continuation before any request.
/// No profile verification, credentials or provider fallback.
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
        if (request.Tools?.Contains("send_agent_message", StringComparer.Ordinal) == true && (last ?? "").StartsWith(ChannelDemo, StringComparison.Ordinal))
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
        if (state is not null && state.Stage is not ("chat" or "complete")) throw new InvalidOperationException("Invalid fake continuation.");
        await foreach (var text in Text("Fake response: " + (string.IsNullOrEmpty(last) ? "No user message." : last), cancellationToken)) yield return text;
        yield return Done("chat", []);
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
