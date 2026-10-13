using System.Text;
using Foundry.Protocol;

namespace Foundry.Runtime;

public sealed partial class Store
{
    internal Dictionary<string, object?> UsageRecordPage(string taskId, long? before = null, int limit = 50, Redactor? redactor = null)
    {
        loop.AssertCurrent(); var task = ReadTask(taskId); redactor ??= new Redactor();
        var current = SchemaVersion >= 4;
        var children = current && Equals(task.GetValueOrDefault("mode"), "coordinated") && !Truthy(task.GetValueOrDefault("parentTaskId"));
        var rows = current
            ? Rows($"SELECT rowid,* FROM provider_requests WHERE {(children ? "root_task_id" : "task_id")}=$p0 AND finished_at IS NOT NULL AND rowid<$p1 ORDER BY rowid DESC LIMIT $p2", taskId, before ?? 9_007_199_254_740_991L, limit + 1)
            : Rows("SELECT rowid,* FROM usage_records WHERE task_id=$p0 AND rowid<$p1 ORDER BY rowid DESC LIMIT $p2", taskId, before ?? 9_007_199_254_740_991L, limit + 1);
        var records = new List<object?>();
        foreach (var row in rows.Take(limit))
        {
            var record = new Dictionary<string, object?>
            {
                ["id"] = current ? row["request_id"] : row["id"], ["taskId"] = row["task_id"], ["requestId"] = row["request_id"], ["reservedTokens"] = row["reserved"],
                ["promptTokens"] = row[current ? "input_tokens" : "prompt_tokens"], ["completionTokens"] = row[current ? "output_tokens" : "completion_tokens"],
                ["cacheReadTokens"] = row["cache_read_tokens"], ["cacheCreationTokens"] = row["cache_creation_tokens"], ["usageKnown"] = Equals(row["usage_known"], 1L),
                ["reason"] = Truthy(row["reason"]) ? Utf8Excerpt(redactor.Text((string)row["reason"]!), 1000).Content : null, ["createdAt"] = row["created_at"]
            };
            if (current) { record["outcome"] = row["outcome"]; record["attemptedAt"] = row["attempted_at"]; }
            if (WireBytes(new Dictionary<string, object?> { ["records"] = records.Append(record).ToList() }) > ReadItemsBytes)
            {
                if (records.Count == 0) throw new WorkspaceReadException("Stored usage record is too large to page safely.");
                break;
            }
            records.Add(record);
        }
        return new() { ["records"] = records, ["nextBefore"] = rows.Count > records.Count ? rows[records.Count - 1]["rowid"] : null };
    }

    internal Dictionary<string, object?> CompactionPage(string taskId, long? before = null, int limit = 50, Redactor? redactor = null)
    {
        loop.AssertCurrent(); ReadTask(taskId); redactor ??= new Redactor();
        var rows = Rows("SELECT rowid,id,task_id,from_ordinal,to_ordinal,json_array_length(message_ids) AS message_count,summary,estimated_before,estimated_after,created_at FROM compactions WHERE task_id=$p0 AND rowid<$p1 ORDER BY rowid DESC LIMIT $p2", taskId, before ?? 9_007_199_254_740_991L, limit + 1);
        var summaries = new List<object?>();
        foreach (var row in rows.Take(limit))
        {
            var excerpt = Utf8Excerpt(redactor.Text((string)row["summary"]!), 2000);
            var summary = new Dictionary<string, object?>
            {
                ["id"] = row["id"], ["taskId"] = row["task_id"], ["fromOrdinal"] = row["from_ordinal"], ["toOrdinal"] = row["to_ordinal"],
                ["messageCount"] = row["message_count"], ["summaryExcerpt"] = excerpt.Content, ["summaryTruncated"] = excerpt.Truncated,
                ["estimatedTokensBefore"] = row["estimated_before"], ["estimatedTokensAfter"] = row["estimated_after"], ["createdAt"] = row["created_at"]
            };
            if (WireBytes(new Dictionary<string, object?> { ["compactions"] = summaries.Append(summary).ToList() }) > ReadItemsBytes)
            {
                if (summaries.Count == 0) throw new WorkspaceReadException("Stored compaction marker is too large to page safely.");
                break;
            }
            summaries.Add(summary);
        }
        return new() { ["compactions"] = summaries, ["nextBefore"] = rows.Count > summaries.Count ? rows[summaries.Count - 1]["rowid"] : null };
    }

    internal Dictionary<string, object?> CompactionContent(string taskId, string compactionId, long offset = 0, int maxBytes = 64 * 1024, Redactor? redactor = null)
    {
        loop.AssertCurrent();
        var row = Rows("SELECT summary FROM compactions WHERE id=$p0 AND task_id=$p1", compactionId, taskId).SingleOrDefault() ?? throw new WorkspaceReadException("Compaction not found in this task.");
        var source = Encoding.UTF8.GetBytes((redactor ?? new Redactor()).Text((string)row["summary"]!));
        if (offset > source.Length) throw new WorkspaceReadException("Compaction offset is beyond the content.");
        return ContentChunk(source, "compactionId", compactionId, offset, maxBytes);
    }

    private static (string Content, bool Truncated) Utf8Excerpt(string text, int maximum)
    {
        var source = Encoding.UTF8.GetBytes(text);
        if (source.Length <= maximum) return (text, false);
        var end = maximum;
        while (end > 0 && IsContinuation(source[end])) end--;
        return (Encoding.UTF8.GetString(source, 0, end), true);
    }
}
