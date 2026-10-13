using Foundry.Protocol;

namespace Foundry.Runtime;

public sealed partial class Store
{
    internal Dictionary<string, object?> UsageTrend(Dictionary<string, object?> input)
    {
        loop.AssertCurrent();
        var p = (Dictionary<string, object?>)Contracts.Validate("rpc workspace.usageTrend", input)!;
        var from = (string?)p.GetValueOrDefault("from") ?? "1970-01-01T00:00:00.000Z";
        var to = (string?)p.GetValueOrDefault("to") ?? Clock.Iso(now());
        var fromKey = UsageInstantKey(from); var toKey = UsageInstantKey(to);
        if (StringComparer.Ordinal.Compare(fromKey, toKey) > 0) throw new WorkspaceReadException("Usage trend start must be before end.");
        const string TimeKey = "substr(u.created_at,1,19)||'.'||rtrim(CASE WHEN substr(u.created_at,20,1)='.' THEN substr(u.created_at,21,length(u.created_at)-21) ELSE '' END,'0')";
        var current = SchemaVersion >= 4; var groupBy = (string)p["groupBy"]!; var limit = checked((int)(double)p["limit"]!);
        var group = groupBy == "day" ? "substr(u.created_at,1,10)" : groupBy == "profile"
            ? current ? "COALESCE(u.profile_id,'unknown')" : "COALESCE(json_extract(t.data,'$.profileId'),'unknown')"
            : current ? "COALESCE(u.root_task_id,u.task_id)" : "u.task_id";
        var known = current ? "u.outcome!='pending' AND u.usage_known=1" : "u.usage_known=1";
        var pending = current ? "u.outcome='pending'" : "0";
        var notSent = current ? "u.outcome!='pending' AND u.usage_known=0 AND u.attribution_known=1 AND u.attempted_at IS NULL" : "0";
        var unknown = current ? $"u.outcome!='pending' AND u.usage_known=0 AND NOT ({notSent})" : "u.usage_known=0";
        var profile = current ? "u.profile_id" : "json_extract(t.data,'$.profileId')";
        var selected = Truthy(p.GetValueOrDefault("taskId")) ? ReadTask((string)p["taskId"]!) : null;
        var children = current && Equals(selected?.GetValueOrDefault("mode"), "coordinated") && !Truthy(selected?.GetValueOrDefault("parentTaskId"));
        var taskFilter = children ? "u.root_task_id" : "u.task_id";
        var table = current ? "provider_requests" : "usage_records"; var join = current ? "" : "JOIN tasks t ON t.id=u.task_id";
        var prompt = current ? "input_tokens" : "prompt_tokens"; var completion = current ? "output_tokens" : "completion_tokens";
        var sql = $"""
            SELECT {group} AS key,COUNT(*) AS requests,
            SUM(CASE WHEN {known} THEN 1 ELSE 0 END) AS known,
            SUM(CASE WHEN {pending} THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN {notSent} THEN 1 ELSE 0 END) AS not_sent,
            SUM(CASE WHEN {unknown} THEN 1 ELSE 0 END) AS unknown,
            SUM(CASE WHEN {known} THEN COALESCE(u.{prompt},0) ELSE 0 END) AS prompt,
            SUM(CASE WHEN {known} THEN COALESCE(u.{completion},0) ELSE 0 END) AS completion,
            SUM(COALESCE(u.cache_read_tokens,0)) AS cache_read,SUM(COALESCE(u.cache_creation_tokens,0)) AS cache_creation,
            SUM(CASE WHEN {unknown} THEN u.reserved ELSE 0 END) AS reserved_unknown,
            SUM(CASE WHEN {pending} THEN u.reserved ELSE 0 END) AS reserved_pending,
            SUM(CASE WHEN {notSent} THEN u.reserved ELSE 0 END) AS reserved_not_sent
            FROM {table} u {join}
            WHERE u.created_at>=$p0 AND u.created_at<$p1 AND {TimeKey}>=$p6 AND {TimeKey}<=$p7 AND ($p2 IS NULL OR {taskFilter}=$p2)
              AND ($p3 IS NULL OR {profile}=$p3) {(groupBy == "task" ? "AND u.task_id IS NOT NULL" : "")}
            GROUP BY key HAVING key>$p4 ORDER BY key LIMIT $p5
            """;
        // The broad second range remains indexable. Exact keys retain every
        // supported fraction without DateTime precision loss or boundary carry.
        var rows = Rows(sql, from[..19], to[..19] + "[", p.GetValueOrDefault("taskId"), p.GetValueOrDefault("profileId"), p.GetValueOrDefault("after") ?? "", limit + 1, fromKey, toKey);
        var buckets = rows.Take(limit).Select(row => new Dictionary<string, object?>
        {
            ["key"] = row["key"], ["requests"] = row["requests"], ["knownRequests"] = row["known"], ["unknownRequests"] = row["unknown"], ["pendingRequests"] = row["pending"], ["notSentRequests"] = row["not_sent"],
            ["observedPrompt"] = row["prompt"], ["observedCompletion"] = row["completion"], ["cacheRead"] = row["cache_read"], ["cacheCreation"] = row["cache_creation"],
            ["reservedUnknown"] = row["reserved_unknown"], ["reservedPending"] = row["reserved_pending"], ["reservedNotSent"] = row["reserved_not_sent"]
        }).ToList();
        return new() { ["groupBy"] = groupBy, ["buckets"] = buckets, ["nextAfter"] = rows.Count > limit ? buckets[^1]["key"] : null, ["timeZone"] = "UTC" };
    }
    private static string UsageInstantKey(string value) => value[..19] + "." + (value[19] == '.' ? value[20..^1].TrimEnd('0') : "");
}
