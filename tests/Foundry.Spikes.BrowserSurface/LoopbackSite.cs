using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Foundry.Spikes.BrowserSurface;

/// <summary>
/// The S4 test page's two sites: one HTTP server on the loopback addresses only, answering as http://127.0.0.1:port
/// (the page and a same-origin frame) and as http://localhost:port (a cross-site frame, which Chromium runs in its own
/// process). One request per connection, from a fixed set of pages.
/// </summary>
internal sealed class LoopbackSite : IAsyncDisposable
{
    private const int MaxRequest = 16 * 1024;
    private readonly List<TcpListener> listeners = [new(IPAddress.Loopback, 0)];
    private readonly Func<string, string?> route;
    private readonly CancellationTokenSource stopping = new();

    /// <param name="route">The HTML for a path (without its query), or null for 404.</param>
    public LoopbackSite(Func<string, string?> route)
    {
        this.route = route;
        listeners[0].Start();
        Port = ((IPEndPoint)listeners[0].LocalEndpoint).Port;
        // localhost may resolve to ::1 first; listening there too spares the browser a refused connection.
        var ipv6 = new TcpListener(IPAddress.IPv6Loopback, Port);
        try
        {
            ipv6.Start();
            listeners.Add(ipv6);
        }
        catch (SocketException)
        {
            // The port is taken on ::1 or IPv6 is off; the browser falls back to 127.0.0.1.
        }
        foreach (var listener in listeners)
        {
            _ = AcceptAsync(listener);
        }
    }

    public int Port { get; }

    public string Origin => $"http://127.0.0.1:{Port}";

    public string OtherOrigin => $"http://localhost:{Port}";

    public ValueTask DisposeAsync()
    {
        stopping.Cancel();
        foreach (var listener in listeners)
        {
            listener.Stop();
        }
        stopping.Dispose();
        return ValueTask.CompletedTask;
    }

    private async Task AcceptAsync(TcpListener listener)
    {
        while (!stopping.IsCancellationRequested)
        {
            TcpClient client;
            try
            {
                client = await listener.AcceptTcpClientAsync(stopping.Token);
            }
            catch (Exception error) when (error is OperationCanceledException or ObjectDisposedException or SocketException)
            {
                return;
            }
            _ = ServeAsync(client);
        }
    }

    private async Task ServeAsync(TcpClient client)
    {
        using (client)
        {
            try
            {
                var stream = client.GetStream();
                var buffer = new byte[MaxRequest];
                var length = 0;
                while (length < buffer.Length)
                {
                    var read = await stream.ReadAsync(buffer.AsMemory(length), stopping.Token);
                    if (read == 0)
                    {
                        break;
                    }
                    length += read;
                    if (Encoding.ASCII.GetString(buffer, 0, length).Contains("\r\n\r\n", StringComparison.Ordinal))
                    {
                        break;
                    }
                }
                var target = Encoding.ASCII.GetString(buffer, 0, length).Split(' ', 3) is [_, var path, _] ? path : "/";
                var html = route(target.Split('?', 2)[0]);
                var body = Encoding.UTF8.GetBytes(html ?? "Not found");
                var head = $"HTTP/1.1 {(html is null ? "404 Not Found" : "200 OK")}\r\nContent-Type: {(html is null ? "text/plain" : "text/html")}; charset=utf-8\r\nContent-Length: {body.Length}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
                await stream.WriteAsync(Encoding.ASCII.GetBytes(head), stopping.Token);
                await stream.WriteAsync(body, stopping.Token);
            }
            catch (Exception error) when (error is IOException or SocketException or OperationCanceledException or ObjectDisposedException)
            {
                // The browser went away mid-request; nothing to answer.
            }
        }
    }
}
