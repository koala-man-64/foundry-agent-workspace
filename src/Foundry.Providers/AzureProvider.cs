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

    public AzureProvider(string apiKind, AzureTransport transport, Func<long>? now = null)
    {
        if (apiKind is not (AzureRequests.Responses or AzureRequests.ChatCompletions or AzureRequests.Anthropic)) throw new ArgumentException("Unsupported API kind.", nameof(apiKind));
        kind = apiKind;
        this.transport = transport;
        this.now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
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
        Uri uri;
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
