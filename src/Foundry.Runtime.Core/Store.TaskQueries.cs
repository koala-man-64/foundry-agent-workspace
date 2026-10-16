namespace Foundry.Runtime;

public sealed partial class Store
{
    internal Dictionary<string, object?> TaskRead(string taskId)
    {
        loop.AssertCurrent();
        var task = ReadTask(taskId);
        var count = Rows("""
            SELECT SUM(CASE WHEN kind='tool.approval' AND state='awaiting-approval' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN state='unknown' THEN 1 ELSE 0 END) AS unknown
            FROM intents WHERE json_valid(data) AND json_extract(data,'$.taskId')=$p0
              AND kind IN ('tool.approval','git.push','git.commit','worktree.retire')
            """, taskId).Single();
        return new()
        {
            ["task"] = task, ["compactionCount"] = Scalar("SELECT COUNT(*) FROM compactions WHERE task_id=$p0", taskId),
            ["pendingApprovals"] = count["pending"] ?? 0L, ["unknownOutcomes"] = count["unknown"] ?? 0L
        };
    }

    internal bool HasTaskUserMessage(string taskId) => Rows("SELECT data FROM messages WHERE task_id=$p0 ORDER BY ordinal", taskId)
        .Any(row => Equals(Document((string)row["data"]!).GetValueOrDefault("role"), "user"));

    internal void AssertNoChatExecutionIntents(string taskId)
    {
        loop.AssertCurrent();
        foreach (var row in Rows("SELECT kind,data,state FROM intents WHERE kind IN ('worktree.retire','git.push','git.commit')"))
        {
            Dictionary<string, object?> document;
            try
            {
                if (Foundry.Protocol.PersistedJson.Parse((string)row["data"]!) is not Dictionary<string, object?> parsed) continue;
                document = parsed;
            }
            catch (System.Text.Json.JsonException) { continue; }
            if (!Equals(document.GetValueOrDefault("taskId"), taskId)) continue;
            var kind = (string)row["kind"]!; var state = (string)row["state"]!;
            if (state == "unknown") throw new InvalidOperationException(kind == "worktree.retire"
                ? "This task has an unknown worktree retirement outcome. Reconcile state before starting a response."
                : "This task has an unknown publication outcome. Reconcile publication state before starting a response.");
            if (state == "pending") throw new NotSupportedException("An execution intent must be reconciled before using the development chat runtime.");
        }
    }
}
