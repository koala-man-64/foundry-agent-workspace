using System.Collections.Concurrent;
using System.IO;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;

namespace Foundry.WebView2.Tests;

internal sealed record WebRequest(string Method, string Path, IReadOnlyDictionary<string, string> Headers, byte[] Body);

internal sealed record WebResponse(int Status, string ContentType, string Body, IReadOnlyDictionary<string, string>? Headers = null)
{
    public static WebResponse Html(string body) => new(200, "text/html; charset=utf-8", body);
}

/// <summary>
/// A minimal HTTP/1.1 server on the loopback address for the browser rig: one request per connection, answered by a
/// route function, every request recorded. With TLS it serves a fresh self-signed certificate that no browser trusts.
/// </summary>
internal sealed class WebServer : IAsyncDisposable
{
    private readonly TcpListener listener = new(IPAddress.Loopback, 0);
    private readonly Func<WebRequest, WebResponse> route;
    private readonly X509Certificate2? certificate;
    private readonly CancellationTokenSource stopping = new();
    private readonly Task accepting;

    public WebServer(Func<WebRequest, WebResponse> route, bool tls = false)
    {
        this.route = route;
        certificate = tls ? SelfSigned() : null;
        listener.Start();
        Port = ((IPEndPoint)listener.LocalEndpoint).Port;
        accepting = Task.Run(AcceptAsync);
    }

    public int Port { get; }

    public ConcurrentQueue<WebRequest> Requests { get; } = new();

    /// <summary>The same server under two origins: cookies are scoped by host, so the hosts differ, not just the port.</summary>
    public string Origin => $"{(certificate is null ? "http" : "https")}://127.0.0.1:{Port}";

    public string OtherOrigin => $"{(certificate is null ? "http" : "https")}://localhost:{Port}";

    public async ValueTask DisposeAsync()
    {
        await stopping.CancelAsync();
        listener.Stop();
        try
        {
            await accepting;
        }
        catch (Exception error) when (error is OperationCanceledException or ObjectDisposedException or SocketException)
        {
        }
        certificate?.Dispose();
        stopping.Dispose();
    }

    private async Task AcceptAsync()
    {
        while (!stopping.IsCancellationRequested)
        {
            var client = await listener.AcceptTcpClientAsync(stopping.Token);
            _ = Task.Run(() => ServeAsync(client));
        }
    }

    private async Task ServeAsync(TcpClient client)
    {
        using (client)
        {
            try
            {
                Stream stream = client.GetStream();
                if (certificate is not null)
                {
                    var secure = new SslStream(stream, leaveInnerStreamOpen: false);
                    await secure.AuthenticateAsServerAsync(certificate);
                    stream = secure;
                }
                await using (stream)
                {
                    var request = await ReadAsync(stream);
                    if (request is null)
                    {
                        return;
                    }
                    Requests.Enqueue(request);
                    var response = route(request);
                    var body = Encoding.UTF8.GetBytes(response.Body);
                    var invariant = System.Globalization.CultureInfo.InvariantCulture;
                    var headers = new StringBuilder();
                    headers.Append(invariant, $"HTTP/1.1 {response.Status} {(HttpStatusCode)response.Status}\r\nContent-Type: {response.ContentType}\r\nContent-Length: {body.Length}\r\nConnection: close\r\nCache-Control: no-store\r\n");
                    foreach (var (name, value) in response.Headers ?? new Dictionary<string, string>())
                    {
                        headers.Append(invariant, $"{name}: {value}\r\n");
                    }
                    await stream.WriteAsync(Encoding.ASCII.GetBytes(headers.Append("\r\n").ToString()));
                    await stream.WriteAsync(body);
                }
            }
            catch (Exception error) when (error is IOException or System.Security.Authentication.AuthenticationException or SocketException or ObjectDisposedException)
            {
                // A browser that refuses the certificate, or gives up, closes the connection: nothing to serve.
            }
        }
    }

    private static async Task<WebRequest?> ReadAsync(Stream stream)
    {
        var buffer = new List<byte>();
        var single = new byte[1];
        while (buffer.Count < 64 * 1024)
        {
            if (await stream.ReadAsync(single) == 0)
            {
                return null;
            }
            buffer.Add(single[0]);
            if (buffer.Count >= 4 && buffer[^4] == '\r' && buffer[^3] == '\n' && buffer[^2] == '\r' && buffer[^1] == '\n')
            {
                break;
            }
        }
        var lines = Encoding.ASCII.GetString(buffer.ToArray()).Split("\r\n");
        var start = lines[0].Split(' ');
        var headers = lines.Skip(1).Where(line => line.Contains(':', StringComparison.Ordinal))
            .Select(line => line.Split(':', 2))
            .GroupBy(parts => parts[0].Trim(), StringComparer.OrdinalIgnoreCase)
            .ToDictionary(group => group.Key, group => group.Last()[1].Trim(), StringComparer.OrdinalIgnoreCase);
        var body = new byte[headers.TryGetValue("Content-Length", out var length) ? int.Parse(length, System.Globalization.CultureInfo.InvariantCulture) : 0];
        await stream.ReadExactlyAsync(body);
        return new WebRequest(start[0], start.Length > 1 ? start[1] : "/", headers, body);
    }

    private static X509Certificate2 SelfSigned()
    {
        using var key = RSA.Create(2048);
        var request = new CertificateRequest("CN=127.0.0.1", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        var names = new SubjectAlternativeNameBuilder();
        names.AddIpAddress(IPAddress.Loopback);
        request.CertificateExtensions.Add(names.Build());
        using var created = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-5), DateTimeOffset.UtcNow.AddHours(1));
        // SChannel needs the key in a form it can use; a PKCS#12 round trip provides one.
        return X509CertificateLoader.LoadPkcs12(created.Export(X509ContentType.Pfx), null);
    }
}
