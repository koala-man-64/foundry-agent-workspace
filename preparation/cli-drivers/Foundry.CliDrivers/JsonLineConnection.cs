using System.Text;
using System.Text.Json;

namespace Foundry.CliDrivers;

/// <summary>Bounded, strict JSONL over supplied streams. It discovers no programs, reads no credentials, and opens no data store.</summary>
public sealed class JsonLineConnection : ICliConnection
{
    private readonly Stream input;
    private readonly Stream output;
    private readonly Func<ValueTask>? stop;
    private readonly CliLimits limits;
    private readonly byte[] buffer = new byte[4096];
    private readonly SemaphoreSlim writeLock = new(1, 1);
    private readonly TaskCompletionSource stopped = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int position, length, messages, received, sent, stopStarted;

    public JsonLineConnection(Stream input, Stream output, CliLimits? limits = null, Func<ValueTask>? stop = null)
    {
        this.input = input ?? throw new ArgumentNullException(nameof(input));
        this.output = output ?? throw new ArgumentNullException(nameof(output));
        this.limits = limits ?? new();
        this.limits.Validate();
        this.stop = stop;
    }

    public async ValueTask<JsonElement?> ReadAsync(CancellationToken cancellationToken)
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref stopStarted) != 0, this);
        using var frame = new MemoryStream();
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (position == length)
            {
                length = await output.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
                position = 0;
                if (length == 0)
                {
                    if (frame.Length != 0) throw new InvalidDataException("CLI ended with an incomplete JSONL frame.");
                    return null;
                }
            }
            var next = buffer[position++];
            if (++received > limits.TotalBytes) throw new InvalidDataException("CLI stream exceeded its byte limit.");
            if (next == (byte)'\n') break;
            if (frame.Length >= limits.FrameBytes) throw new InvalidDataException("CLI frame exceeded its byte limit.");
            frame.WriteByte(next);
        }
        if (++messages > limits.MessageCount) throw new InvalidDataException("CLI stream exceeded its message limit.");
        var bytes = frame.ToArray();
        if (bytes.Length > 0 && bytes[^1] == (byte)'\r') bytes = bytes[..^1];
        // Decode explicitly: JsonDocument's byte parser alone does not reject every malformed string encoding.
        var json = new UTF8Encoding(false, true).GetString(bytes);
        using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 32 });
        if (document.RootElement.ValueKind != JsonValueKind.Object) throw new InvalidDataException("CLI messages must be JSON objects.");
        ValidateMembers(document.RootElement);
        return document.RootElement.Clone();
    }

    public async ValueTask WriteAsync(object message, CancellationToken cancellationToken)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(message);
        if (bytes.Length > limits.FrameBytes) throw new InvalidDataException("CLI request exceeded its frame limit.");
        await writeLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            ObjectDisposedException.ThrowIf(Volatile.Read(ref stopStarted) != 0, this);
            if (sent + bytes.Length + 1 > limits.TotalBytes) throw new InvalidDataException("CLI requests exceeded their byte limit.");
            sent += bytes.Length + 1;
            await input.WriteAsync(bytes, cancellationToken).ConfigureAwait(false);
            await input.WriteAsync(new byte[] { (byte)'\n' }, cancellationToken).ConfigureAwait(false);
            await input.FlushAsync(cancellationToken).ConfigureAwait(false);
        }
        finally { writeLock.Release(); }
    }

    private static void ValidateMembers(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in value.EnumerateObject())
            {
                if (!names.Add(property.Name)) throw new InvalidDataException("CLI message contains a duplicate property.");
                ValidateMembers(property.Value);
            }
        }
        else if (value.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in value.EnumerateArray()) ValidateMembers(item);
        }
        else if (value.ValueKind == JsonValueKind.String)
        {
            var text = value.GetString()!;
            _ = new UTF8Encoding(false, true).GetByteCount(text);
        }
    }

    public async ValueTask StopAsync()
    {
        if (Interlocked.Exchange(ref stopStarted, 1) == 0)
        {
            try
            {
                // The process callback kills the job before streams close, unblocking pending pipe operations.
                if (stop is not null) await stop().ConfigureAwait(false);
                stopped.TrySetResult();
            }
            catch (Exception error) { stopped.TrySetException(error); }
            finally { input.Dispose(); output.Dispose(); }
        }
        await stopped.Task.ConfigureAwait(false);
    }

    public ValueTask DisposeAsync() => StopAsync();
}
