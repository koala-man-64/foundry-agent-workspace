using System.Runtime.CompilerServices;
using Foundry.Protocol;

namespace Foundry.Providers;

public sealed record ProviderMessage(string Role, string Content);
public sealed record ProviderContinuation(string ApiKind, object? Data) : IWireModel
{
    public Dictionary<string, object?> ToWire() => new() { ["apiKind"] = ApiKind, ["data"] = Data };
}
public abstract record ProviderChatEvent : IWireModel
{
    public abstract Dictionary<string, object?> ToWire();
}
public sealed record ProviderText(string Text) : ProviderChatEvent
{
    public override Dictionary<string, object?> ToWire() => new() { ["type"] = "text", ["text"] = Text };
}
public sealed record ProviderDone(ProviderContinuation Continuation) : ProviderChatEvent
{
    public override Dictionary<string, object?> ToWire() => new() { ["type"] = "done", ["continuation"] = Continuation };
}

/// <summary>Offline text/continuation slice only. No profile verification, tools, credentials or provider fallback.</summary>
public sealed class FakeChatProvider
{
    private readonly Func<CancellationToken, Task> pause;
    // Node's zero-delay timer yields to a later event-loop turn; do not substitute a completed task in production.
    public FakeChatProvider(Func<CancellationToken, Task>? pause = null) => this.pause = pause ?? (token => Task.Delay(1, token));

    public async IAsyncEnumerable<ProviderChatEvent> StreamTurn(IReadOnlyList<ProviderMessage> messages,
        ProviderContinuation? continuation = null, [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        ValidateContinuation(continuation);
        CheckCancellation(cancellationToken);
        var content = messages.LastOrDefault(message => message.Role == "user")?.Content;
        var value = "Fake response: " + (string.IsNullOrEmpty(content) ? "No user message." : content);
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
        yield return new ProviderDone(new("fake", new Dictionary<string, object?> { ["stage"] = "chat", ["calls"] = new List<object?>() }));
    }

    private static void ValidateContinuation(ProviderContinuation? continuation)
    {
        if (continuation is null) return;
        if (continuation.ApiKind != "fake" || continuation.Data is not IReadOnlyDictionary<string, object?> data || data.GetValueOrDefault("stage") is not string stage)
            throw new InvalidOperationException("Invalid fake continuation.");
        if (data.GetValueOrDefault("calls") is List<object?> calls)
            foreach (var call in calls)
                if (call is not IReadOnlyDictionary<string, object?> item || item.GetValueOrDefault("id") is not string || item.GetValueOrDefault("name") is not string)
                    throw new InvalidOperationException("Invalid continuation call.");
        if (stage is not "chat" and not "complete") throw new InvalidOperationException("Invalid fake continuation.");
    }
    private static void CheckCancellation(CancellationToken token) { if (token.IsCancellationRequested) throw Aborted(token); }
    private static OperationCanceledException Aborted(CancellationToken token) => new("This operation was aborted", token);
}
