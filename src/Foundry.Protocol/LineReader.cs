using System.Text;

namespace Foundry.Protocol;

/// <summary>Limits each line, not each read. EOF deliberately discards an unterminated frame, as TS does.</summary>
public sealed class LineReader(int maximumBytes = WireJson.MaximumBytes) : IDisposable
{
    private readonly MemoryStream pending = new();
    private readonly Decoder decoder = Encoding.UTF8.GetDecoder();
    public void Dispose() => pending.Dispose();
    public IReadOnlyList<byte[]> Push(ReadOnlySpan<byte> chunk)
    {
        var lines = new List<byte[]>();
        // Node's stdin UTF-8 decoder holds fragmented characters and replaces malformed
        // bytes before LineDecoder applies its UTF-8 byte limit. Count that normalized text.
        var characters = new char[Encoding.UTF8.GetMaxCharCount(chunk.Length)];
        var count = decoder.GetChars(chunk, characters, flush: false);
        var start = 0;
        for (var index = 0; index <= count; index++)
        {
            if (index != count && characters[index] != '\n') continue;
            var segment = characters.AsSpan(start, index - start);
            var size = Encoding.UTF8.GetByteCount(segment);
            if (pending.Length + size > maximumBytes) throw new InvalidDataException("Oversized RPC input; runtime stopped.");
            pending.Write(Encoding.UTF8.GetBytes(segment.ToString()));
            if (index != count) { lines.Add(pending.ToArray()); pending.SetLength(0); }
            start = index + 1;
        }
        return lines;
    }
    public void Finish() { pending.SetLength(0); decoder.Reset(); }
    public static bool IsBlank(byte[] line) => JsJson.Trim(Encoding.UTF8.GetString(line)).Length == 0;
}
