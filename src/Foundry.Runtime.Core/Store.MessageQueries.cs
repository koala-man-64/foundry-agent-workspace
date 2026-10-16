using System.Text;
using Foundry.Protocol;

namespace Foundry.Runtime;

public sealed partial class Store
{
    private const int ReadPageBytes = 256 * 1024;
    private const int ReadItemsBytes = ReadPageBytes - 1024;

    // Internal projections take already-validated query parameters. RPC admission is separate.
    internal Dictionary<string, object?> MessagePage(string taskId, int limit = 50, long? before = null, long? through = null, Redactor? redactor = null)
    {
        loop.AssertCurrent();
        ReadTask(taskId);
        redactor ??= new Redactor();
        var maximum = (long)Scalar("SELECT COALESCE(MAX(ordinal),0) FROM messages WHERE task_id=$p0", taskId)!;
        var highWater = Math.Min(through ?? maximum, maximum);
        var rows = Rows("SELECT id,task_id,data,ordinal FROM messages WHERE task_id=$p0 AND ordinal<=$p1 AND ordinal<$p2 ORDER BY ordinal DESC LIMIT $p3", taskId, highWater, before ?? highWater + 1, limit + 1);
        var items = new List<object?>();
        foreach (var row in rows.Take(limit))
        {
            var message = Document((string)row["data"]!);
            var text = redactor.Text((string)message["content"]!);
            var source = Encoding.UTF8.GetBytes(text);
            var clipped = source.Length > 4096;
            var end = Math.Min(4096, source.Length);
            if (clipped) while (end > 0 && IsContinuation(source[end])) end--;
            message["id"] = row["id"];
            message["content"] = clipped ? Encoding.UTF8.GetString(source, 0, end) : text;
            if (clipped) message["truncated"] = true;
            var item = new Dictionary<string, object?> { ["message"] = message, ["ordinal"] = row["ordinal"] };
            if (WireBytes(new Dictionary<string, object?> { ["items"] = items.Append(item).ToList() }) > ReadItemsBytes)
            {
                if (items.Count == 0) throw new WorkspaceReadException("Stored message metadata is too large to page safely.");
                break;
            }
            items.Add(item);
        }
        var oldest = items.Count == 0 ? (object?)null : ((Dictionary<string, object?>)items[^1]!)["ordinal"];
        items.Reverse();
        return new() { ["items"] = items, ["nextBefore"] = rows.Count > items.Count ? oldest : null, ["through"] = highWater };
    }

    internal Dictionary<string, object?> MessageContent(string taskId, string messageId, long offset = 0, int maxBytes = 64 * 1024, Redactor? redactor = null)
    {
        loop.AssertCurrent();
        var row = Rows("SELECT data FROM messages WHERE id=$p0 AND task_id=$p1", messageId, taskId).SingleOrDefault()
            ?? throw new WorkspaceReadException("Message not found in this task.");
        var message = Document((string)row["data"]!);
        var source = Encoding.UTF8.GetBytes((redactor ?? new Redactor()).Text((string)message["content"]!));
        if (offset > source.Length) throw new WorkspaceReadException("Message offset is beyond the content.");
        return ContentChunk(source, "messageId", messageId, offset, maxBytes);
    }

    private static Dictionary<string, object?> ContentChunk(byte[] source, string idKey, string resourceId, long offset, int maxBytes)
    {
        var start = checked((int)offset);
        var end = (int)Math.Min(source.Length, offset + maxBytes);
        void Align() { while (end < source.Length && end > start && IsContinuation(source[end])) end--; }
        Align();
        if (end == start && end < source.Length) end = Math.Min(source.Length, start + 4);
        Dictionary<string, object?> Build() => new()
        {
            [idKey] = resourceId, ["content"] = Encoding.UTF8.GetString(source, start, end - start),
            ["offset"] = offset, ["nextOffset"] = end < source.Length ? end : null, ["totalBytes"] = source.Length
        };
        var result = Build();
        while (WireBytes(result) > ReadPageBytes)
        {
            end = start + (end - start) / 2;
            Align();
            if (end <= start) throw new WorkspaceReadException("Content chunk cannot fit within the response limit.");
            result = Build();
        }
        return result;
    }

    private static bool IsContinuation(byte value) => (value & 0xc0) == 0x80;
    private static int WireBytes(object value) => Encoding.UTF8.GetByteCount(JsJson.Stringify(value)!);
}
