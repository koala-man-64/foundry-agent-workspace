using System.Runtime.CompilerServices;
using System.Text;
using Foundry.Protocol;

namespace Foundry.Providers;

/// <summary>
/// AzureProvider of packages/providers for one API kind: requests and transport (P2.4a) and the three stream parsers
/// (P2.4a and P2.4b). Unwired: nothing in the runtime constructs it yet. Checks run in TypeScript's
/// order: the profile's kind, its effort, the credential, the caller's cancellation, the request body and its continuation,
/// the endpoint, then the request. A non-2xx status is <see cref="ProviderHttpException"/>; a 204 or 205 has no stream.
/// </summary>
public sealed class AzureProvider
{
    private readonly string kind;
    private readonly AzureTransport transport;
    private readonly Func<long> now;
    private readonly Func<Guid> id;
    private readonly TimeSpan probeDeadline;

    /// <param name="now">The clock Retry-After reads, in epoch milliseconds.</param>
    /// <param name="id">Draws the probe's token, as TypeScript's randomUUID does.</param>
    /// <param name="probeDeadline">Each probe request's deadline: 20 seconds, as in TypeScript.</param>
    public AzureProvider(string apiKind, AzureTransport transport, Func<long>? now = null, Func<Guid>? id = null, TimeSpan? probeDeadline = null)
    {
        if (apiKind is not (AzureRequests.Responses or AzureRequests.ChatCompletions or AzureRequests.Anthropic)) throw new ArgumentException("Unsupported API kind.", nameof(apiKind));
        kind = apiKind;
        this.transport = transport;
        this.now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        this.id = id ?? Guid.NewGuid;
        this.probeDeadline = probeDeadline ?? TimeSpan.FromSeconds(20);
    }

    /// <summary>
    /// AzureProvider.probe: four requests on the profile with its output budget at 256 tokens unless it sets an effort. A
    /// text stream with usage and completion; a stream cancelled after its first text, which must then end with the abort;
    /// a call of a fixture tool; and that call's continuation, which must echo a fresh token. Each has a 20-second deadline,
    /// whose expiry is reported with TypeScript's message. Every failure becomes a result, never an exception. The observer
    /// sees each request. Native closes the cancellation request's stream on every path; TypeScript leaves it open when the
    /// stream continues after the abort, so its usage record stays pending (P2.4c, a named difference).
    /// </summary>
    public async Task<ProbeResult> Probe(IReadOnlyDictionary<string, object?> profile, string? credential, ProbeObserver? observer = null)
    {
        ArgumentNullException.ThrowIfNull(profile);
        try
        {
            if (!Equals(profile.GetValueOrDefault("apiKind"), kind) || credential is null || JsJson.Trim(credential).Length == 0)
                throw new InvalidOperationException("A matching profile and credential are required to probe this provider.");
            AzureRequests.ValidateEffort(profile);
            try { Compatibility.AzureEndpoint(profile.GetValueOrDefault("endpoint") as string ?? ""); }
            catch (ArgumentException error) { throw new InvalidOperationException(error.Message); }
            var small = profile.ToDictionary(entry => entry.Key, entry => entry.Value, StringComparer.Ordinal);
            if (!profile.TryGetValue("effort", out var effort) || effort is Undefined) small["outputLimit"] = 256d;
            ProviderMessage[] reply = [new("user", "Reply with exactly: OK")];
            IAsyncEnumerable<ProviderChatEvent> Observe(ProviderRequest request, CancellationToken token) =>
                observer is null ? StreamTurn(request, token) : observer(request, () => StreamTurn(request, token), token);
            var text = await WithDeadline("Probe text stream timed out.", token => Observe(new(reply) { Profile = small, Credential = credential }, token));
            if (!text.OfType<ProviderText>().Any() || !text.OfType<ProviderUsage>().Any() || !text.OfType<ProviderDone>().Any()) throw new InvalidOperationException("Probe text stream was incomplete.");
            await VerifyCancellation(token => Observe(new(reply) { Profile = small, Credential = credential }, token));
            var probeToken = id().ToString();
            var fixture = new ProviderTool("fixture_tool", "Probe-only fixture.", new Dictionary<string, object?> { ["type"] = "object", ["properties"] = new Dictionary<string, object?>(), ["additionalProperties"] = false });
            var toolStart = await WithDeadline("Probe tool stream timed out.", token => Observe(new([new("user", "Call fixture_tool with an empty object, then reply exactly with the token it returns.")], Tools: [fixture]) { Profile = small, Credential = credential }, token));
            var call = toolStart.OfType<ProviderToolCall>().FirstOrDefault();
            var continuation = toolStart.OfType<ProviderDone>().FirstOrDefault()?.Continuation;
            if (call is null || continuation is null || call.Name != fixture.Name) throw new InvalidOperationException("Probe tool stream did not return a completed tool call.");
            var result = new ProviderToolResult(call.Id, call.Name, JsJson.Stringify(new Dictionary<string, object?> { ["ok"] = true, ["token"] = probeToken })!, false);
            var end = await WithDeadline("Probe continuation stream timed out.", token => Observe(new([], continuation, [fixture], [result]) { Profile = small, Credential = credential }, token));
            if (!end.OfType<ProviderDone>().Any() || end.OfType<ProviderToolCall>().Any() || !string.Concat(end.OfType<ProviderText>().Select(item => item.Text)).Contains(probeToken, StringComparison.Ordinal))
                throw new InvalidOperationException("Probe tool continuation was incomplete.");
            return new(true, true, true, true, true, true, "Text, usage, tool continuation, and local client cancellation were verified. Server cancellation and billing are not guaranteed.");
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            return new(false, false, false, false, false, false, error.Message);
        }
    }

    /// <summary>withDeadline: every event of one stream, or the deadline's message once it expires.</summary>
    private async Task<List<ProviderChatEvent>> WithDeadline(string message, Func<CancellationToken, IAsyncEnumerable<ProviderChatEvent>> action)
    {
        using var deadline = new CancellationTokenSource(probeDeadline);
        var output = new List<ProviderChatEvent>();
        try { await foreach (var item in action(deadline.Token)) output.Add(item); }
        catch (OperationCanceledException) when (deadline.IsCancellationRequested) { throw new InvalidOperationException(message); }
        return output;
    }

    /// <summary>verifyCancellation: read to the first text, abort, and require the stream to end with the abort. Any other
    /// failure is the probe's failure; another event, or a quiet end, means cancellation was not honoured.</summary>
    private async Task VerifyCancellation(Func<CancellationToken, IAsyncEnumerable<ProviderChatEvent>> create)
    {
        using var deadline = new CancellationTokenSource(probeDeadline);
        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(deadline.Token);
        var iterator = create(cancellation.Token).GetAsyncEnumerator(cancellation.Token);
        try
        {
            while (true)
            {
                bool moved;
                try { moved = await iterator.MoveNextAsync(); }
                catch (OperationCanceledException) when (deadline.IsCancellationRequested) { throw new InvalidOperationException("Probe cancellation stream timed out."); }
                if (!moved) throw new InvalidOperationException("Probe cancellation stream completed before text.");
                if (iterator.Current is ProviderText) break;
            }
            await cancellation.CancelAsync();
            try { await iterator.MoveNextAsync(); }
            catch (OperationCanceledException) { return; }
            throw new InvalidOperationException("Probe cancellation stream continued after abort.");
        }
        finally { await iterator.DisposeAsync(); }
    }

    public async IAsyncEnumerable<ProviderChatEvent> StreamTurn(ProviderRequest request, [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        var profile = request.Profile;
        if (profile is null || !Equals(profile.GetValueOrDefault("apiKind"), kind)) throw new InvalidOperationException("Profile API kind does not match this provider.");
        AzureRequests.ValidateEffort(profile);
        if (request.Credential is null || JsJson.Trim(request.Credential).Length == 0) throw new InvalidOperationException("A credential is required for this provider.");
        ProviderAbort.ThrowIfAborted(cancellationToken);
        var prepared = AzureRequests.Prepare(kind, request);
        Uri? uri;
        try { uri = AzureRequests.Target(profile.GetValueOrDefault("endpoint") as string ?? "", kind).Uri; }
        catch (ArgumentException error) { throw new InvalidOperationException(error.Message); }
        var body = Encoding.UTF8.GetBytes(JsJson.Stringify(prepared.Body)!);
        using var response = await transport.Send(uri, AzureRequests.Headers(kind, request.Credential), body, cancellationToken);
        var status = (int)response.StatusCode;
        if (status is < 200 or > 299) throw new ProviderHttpException(status, status == 429 ? AzureRequests.RetryAfter(RetryAfterHeader(response), now()) : null);
        // fetch gives a null body for these statuses (measured for 204).
        if (status is 204 or 205) throw new InvalidOperationException("Provider returned no response stream.");
        Stream stream;
        try { stream = await response.Content.ReadAsStreamAsync(cancellationToken); }
        catch (Exception) when (cancellationToken.IsCancellationRequested) { throw ProviderAbort.Aborted(cancellationToken); }
        catch (Exception error) { throw new ProviderTransportException("terminated", error); }
        await using (stream)
        {
            var frames = SseReader.Read(stream, transport.Limits.BodyIdle, cancellationToken);
            var events = kind switch
            {
                AzureRequests.Responses => ResponsesStream.Read(frames, prepared),
                AzureRequests.ChatCompletions => ChatCompletionsStream.Read(frames, prepared),
                _ => AnthropicStream.Read(frames, prepared),
            };
            await foreach (var item in events) yield return item;
        }
    }

    /// <summary>headers.get("retry-after"): each value trimmed of HTTP whitespace, repeated values joined with ", ".</summary>
    private static string? RetryAfterHeader(HttpResponseMessage response) =>
        response.Headers.NonValidated.TryGetValues("retry-after", out var values) ? string.Join(", ", values.Select(value => value.Trim('\t', '\n', '\r', ' '))) : null;
}
