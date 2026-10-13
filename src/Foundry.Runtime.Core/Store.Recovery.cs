using System.Text.Json;
using Foundry.Protocol;

namespace Foundry.Runtime;

public sealed partial class Store
{
    private static Dictionary<string, object?> Document(string json)
    {
        // Persisted data deliberately has different parsing rules from incoming messages.
        return (Dictionary<string, object?>)PersistedJson.Parse(json)!;
    }
    private static object? Field(Dictionary<string, object?> value, string key) => value.GetValueOrDefault(key);
    private void Recover()
    {
        Transaction(() =>
        {
            if (SchemaVersion >= 4) Execute("UPDATE provider_requests SET outcome='interrupted',finished_at=$p0,reason='Runtime restarted before request settled.' WHERE finished_at IS NULL", Clock.Iso(now()));
            Execute("UPDATE intents SET state='unknown' WHERE state='pending'");
            Execute("UPDATE intents SET state='revoked' WHERE kind='tool.approval' AND state IN ('awaiting-approval','approved')");
            Execute("UPDATE intents SET state='unknown' WHERE kind='tool.approval' AND state='executing'");
            if (SchemaVersion >= 3) Execute("UPDATE task_starts SET state='unknown' WHERE state='pending'");
            if (SchemaVersion >= 2) RecoverOrchestration();
            foreach (var row in Rows("SELECT id,data FROM tasks"))
            {
                var task = Document((string)row["data"]!);
                var taskId = (string)task["id"]!;
                if (Equals(Field(task, "status"), "running"))
                {
                    task["status"] = "interrupted"; task["updatedAt"] = Clock.Iso(now()); SaveRecoveredTask(task, "running");
                    foreach (var messageRow in Rows("SELECT rowid,data FROM messages WHERE task_id=$p0 ORDER BY ordinal", taskId))
                    {
                        var message = Document((string)messageRow["data"]!);
                        if (!Equals(Field(message, "status"), "streaming")) continue;
                        message["status"] = "interrupted";
                        Execute("UPDATE messages SET data=$p0 WHERE id=$p1", JsJson.Stringify(message), message["id"]);
                        if (SchemaVersion >= 5)
                        {
                            Execute("DELETE FROM messages_fts WHERE rowid=$p0", messageRow["rowid"]);
                            Execute("INSERT INTO messages_fts(rowid,task_id,message_id,content) VALUES($p0,$p1,$p2,$p3)", messageRow["rowid"], taskId, message["id"], new Redactor().Text((string)message["content"]!));
                            Execute("UPDATE workspace_read_meta SET message_generation=message_generation+1 WHERE id=1");
                        }
                    }
                    if (SchemaVersion < 4)
                    {
                        var recorded = Convert.ToDouble(Scalar("SELECT COALESCE(SUM(CASE WHEN usage_known=1 THEN COALESCE(prompt_tokens,0)+COALESCE(completion_tokens,0) ELSE reserved END),0) FROM usage_records WHERE task_id=$p0", taskId), System.Globalization.CultureInfo.InvariantCulture);
                        var unrecorded = (double)task["usedTokens"]! - recorded;
                        if (unrecorded > 0)
                        {
                            var recordId = id().ToString();
                            var requestId = id().ToString();
                            SaveUnknownUsage(taskId, requestId, unrecorded, Clock.Iso(now()), recordId);
                        }
                    }
                    Event("task.interrupted", new Dictionary<string, object?> { ["reason"] = "Runtime restarted; partial response retained. Reserved usage retained conservatively." }, taskId);
                }
                else if (!Equals(Field(task, "status"), "retired") && (double)task["usedTokens"]! > 0 && (long)Scalar("SELECT COUNT(*) FROM messages WHERE task_id=$p0", taskId)! == 0)
                {
                    task["usedTokens"] = 0d; task["updatedAt"] = Clock.Iso(now()); SaveRecoveredTask(task, (string)task["status"]!);
                }
            }
            return 0;
        });
    }

    private void SaveRecoveredTask(Dictionary<string, object?> task, string previousStatus)
    {
        if (SchemaVersion < 5) { Execute("UPDATE tasks SET data=$p0 WHERE id=$p1", JsJson.Stringify(task), task["id"]); return; }
        var archived = Field(task, "archivedAt") ?? Scalar("SELECT archived_at FROM tasks WHERE id=$p0", task["id"]);
        if (archived is string { Length: > 0 }) task["archivedAt"] = archived; else task.Remove("archivedAt");
        Execute("UPDATE tasks SET data=$p0,created_at=$p1,updated_at=$p2,archived_at=$p3,parent_task_id=$p4,project_path=$p5,project_id=$p6,mode=$p7,status=$p8 WHERE id=$p9",
            JsJson.Stringify(task), Field(task, "createdAt"), Field(task, "updatedAt"), archived, Field(task, "parentTaskId"), Field(task, "projectPath"), Field(task, "projectId"), Field(task, "mode") ?? "chat", task["status"], task["id"]);
        Execute("UPDATE workspace_read_meta SET task_generation=task_generation+1 WHERE id=1");
        if (!Equals(previousStatus, task["status"])) Event("task.stopped", new Dictionary<string, object?> { ["status"] = task["status"], ["previousStatus"] = previousStatus }, (string)task["id"]!);
    }

    private void SaveUnknownUsage(string taskId, string requestId, double amount, string timestamp, string? recordId = null) => Execute("INSERT INTO usage_records(id,task_id,request_id,reserved,prompt_tokens,completion_tokens,cache_read_tokens,cache_creation_tokens,usage_known,reason,created_at) VALUES($p0,$p1,$p2,$p3,NULL,NULL,NULL,NULL,0,'Runtime restarted before usage was recorded.',$p4)", recordId ?? id().ToString(), taskId, requestId, amount, timestamp);
    private void RecoverOrchestration()
    {
        var timestamp = Clock.Iso(now());
        if (SchemaVersion < 4)
            foreach (var row in Rows("SELECT request_id,run_task_id,amount FROM budget_reservations WHERE state='reserved'"))
                if (Scalar("SELECT 1 FROM usage_records WHERE request_id=$p0", row["request_id"]) is null)
                    SaveUnknownUsage((string)row["run_task_id"]!, (string)row["request_id"]!, Convert.ToDouble(row["amount"], System.Globalization.CultureInfo.InvariantCulture), timestamp);
        Execute("UPDATE budget_reservations SET state='retained',charged=amount,reason='Runtime restarted before usage was recorded.',settled_at=$p0 WHERE state='reserved'", timestamp);
        Execute("UPDATE handoff_operations SET state='revoked',updated_at=$p0 WHERE state='awaiting-approval'", timestamp);
        Execute("UPDATE handoff_operations SET state='unknown',detail='Runtime restarted during the commit operation.',updated_at=$p0 WHERE state IN ('executing','staged','committed')", timestamp);
        Execute("UPDATE integration_operations SET state='revoked',updated_at=$p0 WHERE state='awaiting-approval'", timestamp);
        Execute("UPDATE integration_operations SET state='unknown',observed=json_object('detail','Runtime restarted during integration.'),updated_at=$p0 WHERE state='executing'", timestamp);
        Execute("UPDATE agent_runs SET lifecycle='waiting',wait_reason=CASE WHEN lifecycle='preparing' THEN 'reconciliation' ELSE 'user-continuation' END,updated_at=$p0 WHERE lifecycle IN ('queued','preparing','running')", timestamp);
    }
}
