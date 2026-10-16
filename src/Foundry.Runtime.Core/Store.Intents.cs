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
}
