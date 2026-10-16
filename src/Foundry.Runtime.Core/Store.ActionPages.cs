using Foundry.Protocol;

namespace Foundry.Runtime;

public sealed partial class Store
{
    internal Dictionary<string, object?> ActionPage(Dictionary<string, object?> input, Redactor? redactor = null)
    {
        loop.AssertCurrent(); redactor ??= new Redactor();
        var p = (Dictionary<string, object?>)Contracts.Validate("rpc workspace.actions", input)!;
        var limit = checked((int)(double)p["limit"]!);
        var cursor = (Dictionary<string, object?>?)p.GetValueOrDefault("cursor");
        var current = SchemaVersion >= 5;
        var values = new List<object?>();
        string Bind(object? value) { var name = "$p" + values.Count; values.Add(value); return name; }
        var cutoff = Clock.Iso(now().AddDays(-30));
        var candidates = new List<string>
        {
            "SELECT 'approval:' || i.id AS id,'approval' AS kind,i.id AS source_id,i.state,CASE WHEN json_valid(i.data) THEN json_extract(i.data,'$.taskId') END AS source_task_id,COALESCE(CASE WHEN json_valid(i.data) THEN json_extract(i.data,'$.createdAt') END,'1970-01-01T00:00:00.000Z') AS at,'Reviewed tool action' AS detail FROM intents i WHERE i.kind='tool.approval' AND i.state IN ('awaiting-approval','approved','executing','unknown')",
            "SELECT 'intent:' || i.id,'intent',i.id,i.state,CASE WHEN json_valid(i.data) THEN COALESCE(json_extract(i.data,'$.taskId'),json_extract(i.data,'$.rootTaskId')) END,COALESCE(CASE WHEN json_valid(i.data) THEN json_extract(i.data,'$.createdAt') END,'1970-01-01T00:00:00.000Z'),i.kind FROM intents i WHERE i.kind<>'tool.approval' AND i.state='unknown'"
        };
        if (current)
        {
            candidates.Add("SELECT 'task:' || t.id,'task',t.id,t.status,t.id,t.updated_at,'Task running' FROM tasks t WHERE t.status='running' AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.task_id=t.id)");
            candidates.Add("SELECT 'run:' || r.task_id,'run',r.task_id,r.lifecycle,r.task_id,r.updated_at,COALESCE(r.wait_reason,'Active agent run') FROM agent_runs r WHERE r.lifecycle<>'terminal'");
            candidates.Add("SELECT 'validation:' || v.id,'validation',v.id,'failed',v.run_task_id,v.created_at,'Validation needs review' FROM validation_evidence v WHERE v.passed=0 AND NOT EXISTS (SELECT 1 FROM validation_evidence newer WHERE newer.run_task_id=v.run_task_id AND newer.kind=v.kind AND (newer.created_at>v.created_at OR (newer.created_at=v.created_at AND newer.id>v.id)))");
            candidates.Add("SELECT 'draft:' || d.id,'draft',d.id,'open',CASE WHEN json_valid(d.data) THEN json_extract(d.data,'$.taskId') END,COALESCE(CASE WHEN json_valid(d.data) THEN json_extract(d.data,'$.createdAt') END,'1970-01-01T00:00:00.000Z'),CASE WHEN json_valid(d.data) THEN json_extract(d.data,'$.kind') END FROM automation_drafts d WHERE CASE WHEN json_valid(d.data) THEN json_extract(d.data,'$.state') END='open'");
            candidates.Add("SELECT 'outcome:' || e.sequence,'outcome',CAST(e.sequence AS TEXT),e.type,e.task_id,e.created_at,'Recent task outcome' FROM events e WHERE e.type IN ('task.completed','task.stopped') AND e.created_at>=" + Bind(cutoff));
        }
        var ctes = "WITH candidates(id,kind,source_id,state,source_task_id,at,detail) AS (" + string.Join(" UNION ALL ", candidates) + "),ranked AS (SELECT *,CASE WHEN kind='outcome' THEN 2 WHEN kind='task' OR (kind='run' AND state<>'waiting') OR (kind='approval' AND state NOT IN ('awaiting-approval','unknown')) OR (kind='draft' AND detail NOT IN ('promptDraft','actionDraft')) THEN 1 ELSE 0 END AS tier FROM candidates) ";
        var tier = Bind(cursor?.GetValueOrDefault("tier")); var at = Bind(cursor?.GetValueOrDefault("at")); var idAfter = Bind(cursor?.GetValueOrDefault("id")); var maximum = Bind(limit + 1);
        var sql = ctes + "SELECT c.*,root.id AS root_id,root.data AS root_data," + (current ? "root.archived_at" : "NULL") + " AS root_archived_at FROM ranked c LEFT JOIN tasks source ON source.id=c.source_task_id LEFT JOIN tasks root ON root.id=" + (current ? "COALESCE(source.parent_task_id,source.id)" : "source.id")
            + $" WHERE ({tier} IS NULL OR c.tier>{tier} OR (c.tier={tier} AND (c.at<{at} OR (c.at={at} AND c.id>{idAfter})))) ORDER BY c.tier ASC,c.at DESC,c.id ASC LIMIT {maximum}";
        var rows = Rows(sql, values.ToArray());
        var tally = Rows(ctes + "SELECT tier,COUNT(*) AS count FROM ranked GROUP BY tier", current ? [cutoff] : []);
        object Count(long n) => tally.FirstOrDefault(row => Equals(row["tier"], n))?.GetValueOrDefault("count") ?? 0L;
        var selected = rows.Take(limit).Select(row =>
        {
            var root = Truthy(row["root_data"]) ? Document((string)row["root_data"]!) : null;
            return new Dictionary<string, object?>
            {
                ["id"] = row["id"], ["kind"] = row["kind"], ["tier"] = row["tier"], ["sourceId"] = row["source_id"], ["state"] = row["state"], ["sourceTaskId"] = row["source_task_id"] ?? Undefined.Value,
                ["taskId"] = row["root_id"], ["taskTitle"] = root?.GetValueOrDefault("title") ?? "Workspace", ["archived"] = Truthy(row["root_archived_at"]), ["createdAt"] = row["at"],
                ["detail"] = Equals(row["kind"], "draft") ? "Draft awaiting review" : Utf8Excerpt(redactor.Text((string)row["detail"]!), 100).Content
            };
        }).ToList();
        var more = rows.Count > selected.Count;
        var last = selected.LastOrDefault();
        return new() { ["items"] = selected, ["hasMore"] = more, ["nextCursor"] = more && last is not null ? new Dictionary<string, object?> { ["tier"] = rows[selected.Count - 1]["tier"], ["at"] = last["createdAt"], ["id"] = last["id"] } : null,
            ["counts"] = new Dictionary<string, object?> { ["needsDecision"] = Count(0), ["inProgress"] = Count(1), ["recent"] = Count(2) } };
    }
}
