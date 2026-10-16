using Foundry.Protocol;

namespace Foundry.Runtime;

/// <summary>Durable mutation intents, byte-compatible with packages/runtime/src/store.ts. Intent is written before any external
/// mutation; restart recovery turns a still-pending intent into unknown, and nothing ever retries one automatically.</summary>
public sealed partial class Store
{
    internal string Intent(string kind, object data)
    {
        loop.AssertCurrent();
        var intentId = id().ToString();
        Execute("INSERT INTO intents VALUES($p0,$p1,$p2,'pending')", intentId, kind, JsJson.Stringify(data));
        return intentId;
    }

    internal void FinishIntent(string intentId, string state)
    {
        loop.AssertCurrent();
        if (state is not ("complete" or "unknown")) throw new ArgumentOutOfRangeException(nameof(state));
        Execute("UPDATE intents SET state=$p0 WHERE id=$p1", state, intentId);
    }

    /// <summary>Worktree creations whose outcome is unknown; any one blocks further Git-backed task creation.</summary>
    internal long UnknownWorktreeIntents()
    {
        loop.AssertCurrent();
        return (long)Scalar("SELECT COUNT(*) FROM intents WHERE kind='worktree.create' AND state='unknown'")!;
    }

    internal sealed record UnknownIntent(string Id, string Kind, Dictionary<string, object?> Data);

    /// <summary>unknownPublicationIntents: unknown commits and pushes of one task, in row order; unreadable documents are skipped.</summary>
    internal List<UnknownIntent> UnknownPublicationIntents(string taskId) => UnknownIntents("SELECT id,kind,data FROM intents WHERE kind IN ('git.push','git.commit') AND state='unknown'", taskId);

    /// <summary>unknownRetireIntents: unknown worktree retirements of one task.</summary>
    internal List<UnknownIntent> UnknownRetireIntents(string taskId) => UnknownIntents("SELECT id,kind,data FROM intents WHERE kind='worktree.retire' AND state='unknown'", taskId);

    internal void ClearPublicationIntent(string intentId, string state) => ClearIntent("UPDATE intents SET state=$p0 WHERE id=$p1 AND kind IN ('git.push','git.commit')", intentId, state);
    internal void ClearRetireIntent(string intentId, string state) => ClearIntent("UPDATE intents SET state=$p0 WHERE id=$p1 AND kind='worktree.retire'", intentId, state);

    /// <summary>approvals(taskId).some(state === 'unknown'): a reviewed tool action of this task whose outcome is unknown.</summary>
    internal bool HasUnknownApproval(string taskId) =>
        UnknownIntents("SELECT id,kind,data FROM intents WHERE kind='tool.approval' AND state='unknown'", taskId).Count > 0;

    private List<UnknownIntent> UnknownIntents(string sql, string taskId)
    {
        loop.AssertCurrent();
        var found = new List<UnknownIntent>();
        foreach (var row in Rows(sql))
        {
            Dictionary<string, object?> data;
            try { if (PersistedJson.Parse((string)row["data"]!) is not Dictionary<string, object?> parsed) continue; data = parsed; }
            catch (System.Text.Json.JsonException) { continue; }
            if (Equals(data.GetValueOrDefault("taskId"), taskId)) found.Add(new((string)row["id"]!, (string)row["kind"]!, data));
        }
        return found;
    }

    private void ClearIntent(string sql, string intentId, string state)
    {
        loop.AssertCurrent();
        if (state is not ("complete" or "failed")) throw new ArgumentOutOfRangeException(nameof(state));
        Execute(sql, state, intentId);
    }
}
