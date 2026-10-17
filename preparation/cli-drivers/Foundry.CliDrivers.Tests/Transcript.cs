using System.Text;
using System.Text.Json;

namespace Foundry.CliDrivers.Tests;

internal sealed class Transcript : IAsyncDisposable
{
    private readonly MemoryStream written = new();
    public ICliConnection Connection { get; }
    public bool Stopped { get; private set; }

    public Transcript(IEnumerable<object> messages, int fragment = 4096, CliLimits? limits = null)
        : this(string.Concat(messages.Select(value => JsonSerializer.Serialize(value) + "\n")), fragment, limits) { }

    public Transcript(string raw, int fragment = 4096, CliLimits? limits = null)
    {
        Connection = new JsonLineConnection(written, new FragmentedStream(Encoding.UTF8.GetBytes(raw), fragment), limits,
            () => { Stopped = true; return ValueTask.CompletedTask; });
    }

    public JsonElement[] Requests => Encoding.UTF8.GetString(written.ToArray()).Split('\n', StringSplitOptions.RemoveEmptyEntries)
        .Select(line => JsonDocument.Parse(line).RootElement.Clone()).ToArray();

    public ValueTask DisposeAsync() => Connection.DisposeAsync();

    private sealed class FragmentedStream(byte[] bytes, int fragment) : MemoryStream(bytes)
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) =>
            base.ReadAsync(buffer[..Math.Min(buffer.Length, fragment)], cancellationToken);
    }
}

internal sealed class WaitingConnection : ICliConnection
{
    public bool Stopped { get; private set; }
    public async ValueTask<JsonElement?> ReadAsync(CancellationToken cancellationToken)
    { await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken); return null; }
    public ValueTask WriteAsync(object message, CancellationToken cancellationToken) { cancellationToken.ThrowIfCancellationRequested(); return ValueTask.CompletedTask; }
    public ValueTask StopAsync() { Stopped = true; return ValueTask.CompletedTask; }
    public ValueTask DisposeAsync() => StopAsync();
}

internal static class Frames
{
    public static object Rpc(int id, object result) => new { id, result };
    public static object Init() => Rpc(1, new { userAgent = "fixture" });
    public static object Thread(string id = "session-1") => Rpc(2, new { thread = new { id }, model = "model-1" });
    public static object Turn() => Rpc(3, new { turn = new { id = "turn-1" } });
    public static object Text(string text = "hello", string threadId = "session-1", string turnId = "turn-1") =>
        new { method = "item/agentMessage/delta", @params = new { threadId, turnId, delta = text } };
    public static object Usage(long input = 10, long output = 2) =>
        new { method = "thread/tokenUsage/updated", @params = new { threadId = "session-1", tokenUsage = new { total = new { inputTokens = input, outputTokens = output } } } };
    public static object Done(string status = "completed", string session = "session-1", string turn = "turn-1") =>
        new { method = "turn/completed", @params = new { threadId = session, turn = new { id = turn, status } } };
    public static object ClaudeInit(string session = "claude-1", string[]? tools = null) =>
        new { type = "system", subtype = "init", session_id = session, model = "resolved-model", tools = tools ?? [], mcp_servers = Array.Empty<string>() };
    public static object ClaudeEvent(object value) => new { type = "stream_event", session_id = "claude-1", @event = value };
    public static object Assistant(string text = "hello", string session = "claude-1", string id = "message-1") =>
        new { type = "assistant", session_id = session, message = new { id, content = new[] { new { type = "text", text } } } };
    public static object ClaudeDone(object? usage = null, string subtype = "success", bool isError = false) =>
        new { type = "result", session_id = "claude-1", subtype, is_error = isError, result = "hello", usage };

    public static CliObserver Observe(List<CliEvent> events) => (value, _) => { events.Add(value); return ValueTask.CompletedTask; };
}
