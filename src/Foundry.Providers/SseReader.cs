using System.Runtime.CompilerServices;
using System.Text;
using Foundry.Protocol;

namespace Foundry.Providers;

internal sealed record SseFrame(string? Event, string Data);

/// <summary>
/// readSse and parseSse of packages/providers. Bytes are decoded as TextDecoder decodes a stream (replacement characters,
/// one leading byte order mark dropped, an incomplete sequence at the end discarded). Line endings are normalized in each
/// decoded read, so a CRLF split between two reads leaves a blank line, as in TypeScript. After every read the stream may
/// hold at most 8 MiB in all and the undelivered text at most 1 MiB of UTF-8, checked before events are split off; at most
/// 10,000 blank-line-separated blocks are read, with or without data. The caller's cancellation is checked before and
/// after each read only, so frames already read are still delivered after an abort, as in TypeScript.
/// <para>Undici ends a read that sees no bytes for 300 seconds with "terminated" (measured); <paramref name="idle"/> is that
/// bound. Any failure of the stream itself is reported as "terminated".</para>
/// </summary>
internal static class SseReader
{
    internal const int MaxEventBytes = 1024 * 1024, MaxStreamBytes = 8 * 1024 * 1024, MaxEvents = 10000;
    internal const int ReadBytes = 64 * 1024;
    private static readonly UTF8Encoding Utf8 = new(false, false);

    internal static async IAsyncEnumerable<SseFrame> Read(Stream body, TimeSpan idle, [EnumeratorCancellation] CancellationToken token)
    {
        var decoder = Utf8.GetDecoder();
        var bytes = new byte[ReadBytes];
        var chars = new char[Utf8.GetMaxCharCount(ReadBytes)];
        var buffer = "";
        long total = 0;
        var events = 0;
        var started = false;
        while (true)
        {
            ProviderAbort.ThrowIfAborted(token);
            var count = await ReadOnce(body, bytes, idle, token);
            ProviderAbort.ThrowIfAborted(token);
            if (count == 0) break;
            total += count;
            if (total > MaxStreamBytes) throw new InvalidOperationException("Provider stream exceeded the configured byte limit.");
            var length = decoder.GetChars(bytes, 0, count, chars, 0, flush: false);
            var text = new string(chars, 0, length);
            if (!started && text.Length > 0)
            {
                started = true;
                // U+FEFF is EF BB BF in UTF-8, so a first decoded U+FEFF is the stream's byte order mark.
                if (text[0] == '﻿') text = text[1..];
            }
            buffer += text.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n');
            if (Utf8.GetByteCount(buffer) > MaxEventBytes) throw new InvalidOperationException("Provider event exceeded the configured byte limit.");
            var position = 0;
            while (true)
            {
                var boundary = buffer.IndexOf("\n\n", position, StringComparison.Ordinal);
                if (boundary < 0) break;
                var raw = buffer[position..boundary];
                position = boundary + 2;
                if (++events > MaxEvents) throw new InvalidOperationException("Provider stream exceeded the configured event limit.");
                var frame = Parse(raw);
                if (frame is not null) yield return frame;
            }
            buffer = buffer[position..];
        }
    }

    private static async Task<int> ReadOnce(Stream body, byte[] bytes, TimeSpan idle, CancellationToken token)
    {
        using var bound = CancellationTokenSource.CreateLinkedTokenSource(token);
        if (idle != Timeout.InfiniteTimeSpan) bound.CancelAfter(idle);
        try { return await body.ReadAsync(bytes, bound.Token); }
        catch (Exception) when (token.IsCancellationRequested) { throw ProviderAbort.Aborted(token); }
        catch (Exception error) { throw new ProviderTransportException("terminated", error); }
    }

    /// <summary>parseSse: the last event name, trimmed, and the data lines without their leading whitespace, joined.</summary>
    internal static SseFrame? Parse(string raw)
    {
        string? name = null;
        List<string>? data = null;
        foreach (var line in raw.Split('\n'))
        {
            if (line.StartsWith("event:", StringComparison.Ordinal)) name = JsJson.Trim(line[6..]);
            else if (line.StartsWith("data:", StringComparison.Ordinal)) (data ??= []).Add(JsJson.TrimStart(line[5..]));
        }
        return data is null ? null : new(name, string.Join('\n', data));
    }
}
