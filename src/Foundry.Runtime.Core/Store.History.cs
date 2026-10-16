using Foundry.Protocol;

namespace Foundry.Runtime;

public sealed partial class Store
{
    // Internal provider preparation reads. Public history uses bounded projections.
    internal List<Dictionary<string, object?>> MessagesWithOrdinals(string taskId)
    {
        loop.AssertCurrent();
        return Rows("SELECT data,ordinal FROM messages WHERE task_id=$p0 ORDER BY ordinal", taskId)
            .Select(row => new Dictionary<string, object?>(Document((string)row["data"]!)) { ["ordinal"] = row["ordinal"] }).ToList();
    }

    internal List<Dictionary<string, object?>> ReadCompactions(string taskId)
    {
        loop.AssertCurrent();
        return Rows("SELECT * FROM compactions WHERE task_id=$p0 ORDER BY from_ordinal", taskId).Select(row => new Dictionary<string, object?>
        {
            ["id"] = row["id"], ["taskId"] = row["task_id"], ["fromOrdinal"] = row["from_ordinal"], ["toOrdinal"] = row["to_ordinal"],
            ["messageIds"] = PersistedJson.Parse((string)row["message_ids"]!), ["summary"] = row["summary"],
            ["estimatedTokensBefore"] = row["estimated_before"], ["estimatedTokensAfter"] = row["estimated_after"], ["createdAt"] = row["created_at"]
        }).ToList();
    }

    internal Dictionary<string, object?>? ReadProviderState(string taskId)
    {
        loop.AssertCurrent();
        return ReadDocument("SELECT data FROM intents WHERE id=$p0 AND kind='provider.context'", taskId);
    }
}
