using Foundry.Protocol;

namespace Foundry.Runtime;

public sealed partial class Store
{
    // These ledger primitives do not reserve task budgets or normalize measurements.
    // Their caller must do both in the same transaction before provider dispatch.
    internal void BeginUsage(string requestId, Dictionary<string, object?>? task, IReadOnlyDictionary<string, object?> profile, double reserved, string purpose)
    {
        loop.AssertCurrent();
        if (SchemaVersion < 4) return;
        if (!double.IsFinite(reserved) || reserved < 0 || reserved > 9_007_199_254_740_991d || Math.Truncate(reserved) != reserved)
            throw new InvalidOperationException("Invalid usage reservation.");
        var rootId = SqlField(task, "rootTaskId");
        var taskId = SqlField(task, "id");
        var root = Truthy(rootId) && !Equals(rootId, taskId) ? Rows("SELECT data FROM tasks WHERE id=$p0", rootId).SingleOrDefault() : null;
        var rootTitle = root is null ? SqlField(task, "title") : SqlField(Document((string)root["data"]!), "title");
        Execute("""
            INSERT INTO provider_requests(request_id,task_id,root_task_id,parent_task_id,task_title,root_task_title,role,purpose,profile_id,profile_name,api_kind,deployment,effort,attribution_known,created_at,outcome,reserved,usage_known)
            VALUES($p0,$p1,$p2,$p3,$p4,$p5,$p6,$p7,$p8,$p9,$p10,$p11,$p12,1,$p13,'pending',$p14,0)
            """, requestId, taskId, rootId ?? taskId, SqlField(task, "parentTaskId"), SqlField(task, "title"), rootTitle, SqlField(task, "role"), purpose,
            profile["id"], profile["name"], profile["apiKind"], profile["deployment"], SqlField(profile, "effort"), Clock.Iso(now()), reserved);
    }

    internal void AttemptUsage(string requestId)
    {
        loop.AssertCurrent();
        if (SchemaVersion >= 4) Execute("UPDATE provider_requests SET attempted_at=$p0 WHERE request_id=$p1 AND attempted_at IS NULL AND finished_at IS NULL", Clock.Iso(now()), requestId);
    }

    internal bool FinishUsage(string requestId, IReadOnlyDictionary<string, object?>? detail, string outcome, string? reason = null, IReadOnlyDictionary<string, object?>? metadata = null)
    {
        loop.AssertCurrent();
        if (SchemaVersion < 4) return false;
        return Execute("""
            UPDATE provider_requests SET finished_at=$p0,outcome=$p1,reason=$p2,reported_model=$p3,response_id=$p4,usage_known=$p5,input_tokens=$p6,output_tokens=$p7,cache_read_tokens=$p8,cache_creation_tokens=$p9,reasoning_tokens=$p10
            WHERE request_id=$p11 AND finished_at IS NULL
            """, Clock.Iso(now()), outcome, reason, SqlField(metadata, "reportedModel"), SqlField(metadata, "responseId"), detail is null ? 0 : 1,
            SqlField(detail, "inputTokens"), SqlField(detail, "outputTokens"), SqlField(detail, "cacheReadTokens"), SqlField(detail, "cacheCreationTokens"), SqlField(detail, "reasoningTokens"), requestId) == 1;
    }

    internal bool HasUsage(string requestId)
    {
        loop.AssertCurrent();
        return Scalar(SchemaVersion >= 4 ? "SELECT 1 FROM provider_requests WHERE request_id=$p0" : "SELECT 1 FROM usage_records WHERE request_id=$p0", requestId) is not null;
    }

    private static object? SqlField(IReadOnlyDictionary<string, object?>? document, string key)
    {
        var value = document?.GetValueOrDefault(key);
        return value is Undefined ? null : value;
    }
}
