using System.Net;
using System.Text;

namespace Foundry.Providers;

/// <summary>The bounds undici's fetch applies (measured on Electron 44.4.1's Node 24.21.0).</summary>
public sealed record TransportLimits(TimeSpan Connect, TimeSpan Headers, TimeSpan BodyIdle)
{
    /// <summary>10 seconds to connect ("fetch failed"), 300 to receive headers ("fetch failed"), and 300 without a byte of
    /// the body ("terminated").</summary>
    public static TransportLimits Undici { get; } = new(TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(300), TimeSpan.FromSeconds(300));
}

/// <summary>
/// The HTTP transport for the Azure adapters: one POST per request through <see cref="HttpMessageInvoker"/>, which returns at
/// the response headers and leaves the body to the caller. The production handler follows no redirect, keeps no cookies,
/// uses no proxy and no default credentials, decompresses nothing, validates certificates with the system's defaults and
/// sends header values as Latin-1 bytes, as fetch sends a ByteString. Tests inject a handler; nothing here reads the
/// environment, so no setting can send provider traffic to another host.
/// </summary>
public sealed class AzureTransport : IDisposable
{
    private readonly HttpMessageInvoker invoker;
    internal TransportLimits Limits { get; }

    public AzureTransport(HttpMessageHandler? handler = null, TransportLimits? limits = null)
    {
        Limits = limits ?? TransportLimits.Undici;
        invoker = new HttpMessageInvoker(handler ?? CreateHandler(Limits), disposeHandler: true);
    }

    /// <summary>The production handler. Tests inspect it; none sends through it.</summary>
    internal static SocketsHttpHandler CreateHandler(TransportLimits limits) => new()
    {
        AllowAutoRedirect = false,
        UseCookies = false,
        UseProxy = false,
        Proxy = null,
        Credentials = null,
        DefaultProxyCredentials = null,
        PreAuthenticate = false,
        AutomaticDecompression = DecompressionMethods.None,
        ConnectTimeout = limits.Connect,
        RequestHeaderEncodingSelector = (_, _) => Encoding.Latin1,
    };

    /// <summary>
    /// Sends the request and returns its response once the headers arrive. The caller's cancellation is the AbortError;
    /// any other failure before a response, including the headers bound, is fetch's "fetch failed". The credential header
    /// is checked as fetch checks a header value first: no character above U+00FF, HTTP whitespace trimmed from both ends,
    /// no NUL, CR or LF, and no other control character (measured). Its messages never include the value, where fetch's
    /// name the character or echo the trimmed value (named in P2.4a).
    /// </summary>
    internal async Task<HttpResponseMessage> Send(Uri uri, IReadOnlyList<KeyValuePair<string, string>> headers, byte[] body, CancellationToken token)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, uri) { Version = HttpVersion.Version11, VersionPolicy = HttpVersionPolicy.RequestVersionExact, Content = new ByteArrayContent(body) };
        foreach (var (name, value) in headers)
        {
            if (name == "content-type") { request.Content.Headers.TryAddWithoutValidation(name, value); continue; }
            request.Headers.TryAddWithoutValidation(name, name == "api-key" ? HeaderValue(value) : value);
        }
        using var bound = CancellationTokenSource.CreateLinkedTokenSource(token);
        bound.CancelAfter(Limits.Headers);
        HttpResponseMessage response;
        try { response = await invoker.SendAsync(request, bound.Token); }
        catch (Exception) when (token.IsCancellationRequested) { throw ProviderAbort.Aborted(token); }
        catch (Exception error) { throw new ProviderTransportException("fetch failed", error); }
        // redirect: "error" makes any redirect status a network error before the body is read, with or without a Location
        // (measured); the redirect is never followed and the credential never goes anywhere else.
        if ((int)response.StatusCode is 301 or 302 or 303 or 307 or 308)
        {
            response.Dispose();
            throw new ProviderTransportException("fetch failed");
        }
        return response;
    }

    internal static string HeaderValue(string value)
    {
        if (value.Any(c => c > '\u00ff')) throw new ProviderTransportException("Cannot convert argument to a ByteString because a character is greater than 255.");
        var normalized = value.Trim('\t', '\n', '\r', ' ');
        if (normalized.IndexOfAny(['\0', '\r', '\n']) >= 0) throw new ProviderTransportException("Headers.append: the credential is an invalid header value.");
        if (normalized.Any(c => c < ' ' && c != '\t' || c == '\u007f')) throw new ProviderTransportException("fetch failed");
        return normalized;
    }

    public void Dispose() => invoker.Dispose();
}
