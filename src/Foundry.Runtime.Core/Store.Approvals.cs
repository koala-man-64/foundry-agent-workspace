using System.Text;
using System.Text.Json;
using Foundry.Protocol;

namespace Foundry.Runtime;

public sealed partial class Store
{
    private const int ApprovalPreviewBytes = 128 * 1024;
    private const long MaximumSafeInteger = 9_007_199_254_740_991;
    private static readonly string[] PreviewFields = ["summary", "before", "after", "command", "result", "handoff", "integration", "mcp", "environment"];

    /// <summary>store.approval: the stored document, with the row's state column in place of any stored state.</summary>
    internal Dictionary<string, object?> Approval(string approvalId)
    {
        loop.AssertCurrent();
        var row = Rows("SELECT data,state FROM intents WHERE id=$p0 AND kind='tool.approval'", approvalId).SingleOrDefault()
            ?? throw new WorkspaceReadException("Approval not found.");
        var approval = Document((string)row["data"]!);
        approval["state"] = row["state"];
        return approval;
    }

    /// <summary>
    /// store.saveApproval: the row, and from schema v5 an approval.changed event (with a truthy origin) when the state
    /// changed, in one transaction. Returns whether it recorded that event.
    /// </summary>
    internal bool SaveApproval(Dictionary<string, object?> approval)
    {
        loop.AssertCurrent();
        return Transaction(() =>
        {
            var approvalId = (string)approval["id"]!; var state = (string)approval["state"]!;
            var prior = Scalar("SELECT state FROM intents WHERE id=$p0 AND kind='tool.approval'", approvalId) as string;
            Execute("INSERT INTO intents VALUES ($p0,'tool.approval',$p1,$p2) ON CONFLICT(id) DO UPDATE SET data=excluded.data,state=excluded.state", approvalId, JsJson.Stringify(approval), state);
            if (SchemaVersion < 5 || prior == state) return false;
            var data = new Dictionary<string, object?> { ["approvalId"] = approvalId, ["state"] = state };
            if (Truthy(approval.GetValueOrDefault("origin"))) data["origin"] = approval["origin"];
            Event("approval.changed", data, approval.GetValueOrDefault("taskId") as string);
            return true;
        });
    }

    /// <summary>Whether the task has any event of this type: the canonical re-read service.ts publish falls back from.</summary>
    internal bool HasTaskEvent(string type, string taskId) => Scalar("SELECT 1 FROM events WHERE type=$p0 AND task_id=$p1 LIMIT 1", type, taskId) is not null;

    /// <summary>task.approvals: the task's approvals, newest first, keyed by rowid. Stored documents are never rewritten.</summary>
    internal Dictionary<string, object?> ApprovalPage(string taskId, int limit, long? before)
    {
        loop.AssertCurrent();
        ReadTask(taskId);
        var rows = Rows("SELECT rowid,data,state FROM intents WHERE kind='tool.approval' AND rowid<$p0 AND json_valid(data) AND json_extract(data,'$.taskId')=$p1 ORDER BY rowid DESC LIMIT $p2",
            before ?? MaximumSafeInteger, taskId, limit + 1);
        var approvals = new List<object?>();
        foreach (var row in rows.Take(limit))
        {
            var value = Document((string)row["data"]!);
            var item = new Dictionary<string, object?>();
            foreach (var key in new[] { "id", "taskId", "tool" }) if (value.TryGetValue(key, out var field)) item[key] = field;
            item["state"] = row["state"];
            foreach (var key in new[] { "createdAt", "path" }) if (value.TryGetValue(key, out var field)) item[key] = field;
            approvals.Add(item);
        }
        return new() { ["approvals"] = approvals, ["nextBefore"] = rows.Count > approvals.Count ? rows[approvals.Count - 1]["rowid"] : null };
    }

    /// <summary>
    /// approval.get: the redacted approval when its whole document fits in 128 KiB; otherwise a preview of its identity,
    /// hashes and binding, with the summary and path clipped to 1,000 bytes and the omitted fields named.
    /// </summary>
    internal Dictionary<string, object?> ApprovalRead(string taskId, string approvalId, Redactor redactor)
    {
        var (value, full, redacted) = ApprovalText(taskId, approvalId, redactor);
        var fullBytes = Encoding.UTF8.GetByteCount(full);
        if (fullBytes <= ApprovalPreviewBytes) return new() { ["approval"] = value, ["truncatedFields"] = new List<object?>(), ["fullBytes"] = fullBytes, ["redacted"] = redacted };
        var (summary, summaryTruncated) = Clip(value.GetValueOrDefault("summary") as string ?? "", 1000);
        var preview = new Dictionary<string, object?>();
        foreach (var key in new[] { "id", "taskId", "toolCallId", "nonce", "tool", "state", "createdAt" }) if (value.TryGetValue(key, out var field)) preview[key] = field;
        preview["summary"] = summary;
        if (value.TryGetValue("fingerprint", out var fingerprint)) preview["fingerprint"] = fingerprint;
        if (Truthy(value.GetValueOrDefault("origin"))) preview["origin"] = value["origin"];
        if (Truthy(value.GetValueOrDefault("path"))) preview["path"] = Clip((string)value["path"]!, 1000).Content;
        foreach (var key in new[] { "expectedHash", "resultingHash" }) if (value.TryGetValue(key, out var field)) preview[key] = field;
        if (Truthy(value.GetValueOrDefault("rootTaskId"))) preview["rootTaskId"] = value["rootTaskId"];
        foreach (var key in new[] { "assignmentId", "generation" }) if (value.TryGetValue(key, out var field)) preview[key] = field;
        if (Truthy(value.GetValueOrDefault("evidenceId"))) preview["evidenceId"] = value["evidenceId"];
        var truncated = new List<object?> { "full" };
        truncated.AddRange(PreviewFields.Where(field => field == "summary" ? summaryTruncated : value.ContainsKey(field)));
        return new() { ["approval"] = preview, ["truncatedFields"] = truncated, ["fullBytes"] = fullBytes, ["redacted"] = redacted };
    }

    /// <summary>approval.content: one UTF-8-aligned chunk of a redacted approval field, or of the whole redacted document.</summary>
    internal Dictionary<string, object?> ApprovalContent(string taskId, string approvalId, string field, long offset, int maxBytes, Redactor redactor)
    {
        var (value, full, _) = ApprovalText(taskId, approvalId, redactor);
        static string? Text(Dictionary<string, object?>? source, string key) => source?.GetValueOrDefault(key) as string;
        static Dictionary<string, object?>? Nested(Dictionary<string, object?> source, string key) => source.GetValueOrDefault(key) as Dictionary<string, object?>;
        var selected = field switch
        {
            "full" => full,
            "summary" or "before" or "after" or "command" => Text(value, field),
            "result.content" => Text(Nested(value, "result"), "content"),
            "handoff.patch" => Text(Nested(value, "handoff"), "patch"),
            "integration.patch" => Text(Nested(value, "integration"), "patch"),
            "mcp.arguments" => Text(Nested(value, "mcp"), "arguments"),
            _ => null,
        } ?? throw new WorkspaceReadException("Approval content field is absent.");
        var source = Encoding.UTF8.GetBytes(selected);
        if (offset > source.Length) throw new WorkspaceReadException("Approval content offset is beyond the field.");
        var start = (int)offset;
        var end = (int)Math.Min(source.Length, offset + maxBytes);
        while (end < source.Length && end > start && IsContinuation(source[end])) end--;
        if (end == start && end < source.Length) end = Math.Min(source.Length, start + 4);
        return new()
        {
            ["approvalId"] = approvalId, ["field"] = field, ["content"] = Encoding.UTF8.GetString(source, start, end - start),
            ["offset"] = offset, ["nextOffset"] = end < source.Length ? end : null, ["totalBytes"] = source.Length,
        };
    }

    /// <summary>The approval as the caller may see it: its whole document redacted, parsed back from the redacted text.</summary>
    private (Dictionary<string, object?> Value, string Full, bool Redacted) ApprovalText(string taskId, string approvalId, Redactor redactor)
    {
        loop.AssertCurrent();
        var value = Approval(approvalId);
        if (!Equals(value.GetValueOrDefault("taskId"), taskId)) throw new WorkspaceReadException("Approval not found in this task.");
        var raw = JsJson.Stringify(value)!;
        var full = redactor.Text(raw);
        try { return (Document(full), full, !string.Equals(full, raw, StringComparison.Ordinal)); }
        catch (Exception error) when (error is JsonException or InvalidCastException) { throw new WorkspaceReadException("Approval evidence could not be safely rendered."); }
    }

    /// <summary>workspace-queries.ts clipped: at most this many UTF-8 bytes, ending on a character boundary.</summary>
    private static (string Content, bool Truncated) Clip(string text, int maximumBytes)
    {
        var source = Encoding.UTF8.GetBytes(text);
        if (source.Length <= maximumBytes) return (text, false);
        var end = maximumBytes;
        while (end > 0 && IsContinuation(source[end])) end--;
        return (Encoding.UTF8.GetString(source, 0, end), true);
    }
}
