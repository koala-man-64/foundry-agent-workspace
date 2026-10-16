using Foundry.Protocol;

namespace Foundry.Runtime;

/// <summary>Task and message persistence. Service admission and provider execution are separate.</summary>
public sealed partial class Store
{
    private static readonly string[] TaskGenerationFields = ["title", "projectPath", "parentTaskId", "mode", "status", "createdAt", "updatedAt", "archivedAt"];

    internal Dictionary<string, object?> ReadTask(string taskId)
        => ReadDocument("SELECT data FROM tasks WHERE id=$p0", taskId) ?? throw new InvalidOperationException("Task not found.");
    internal Dictionary<string, object?> ReadGitTask(string taskId)
    {
        var task = ReadTask(taskId);
        if (!IsGitDocument(task)) throw new InvalidOperationException("This action requires a Git worktree.");
        return task;
    }

    internal Dictionary<string, object?> SaveTask(Dictionary<string, object?> task, Dictionary<string, object?>? transition = null)
    {
        loop.AssertCurrent();
        if (SchemaVersion < 5)
        {
            Execute("INSERT INTO tasks(id,data) VALUES($p0,$p1) ON CONFLICT(id) DO UPDATE SET data=excluded.data", task["id"], JsJson.Stringify(task));
            return task;
        }
        var previous = Rows("SELECT data,archived_at FROM tasks WHERE id=$p0", task["id"]).SingleOrDefault();
        var archived = task.TryGetValue("archivedAt", out var explicitArchive) ? explicitArchive : previous?.GetValueOrDefault("archived_at") ?? Undefined.Value;
        var saved = new Dictionary<string, object?>(task);
        if (Truthy(archived)) saved["archivedAt"] = archived; else saved.Remove("archivedAt");
        return Transaction(() =>
        {
            Execute("INSERT INTO tasks(id,data,created_at,updated_at,archived_at,parent_task_id,project_path,project_id,mode,status) VALUES($p0,$p1,$p2,$p3,$p4,$p5,$p6,$p7,$p8,$p9) "
                + "ON CONFLICT(id) DO UPDATE SET data=excluded.data,created_at=excluded.created_at,updated_at=excluded.updated_at,archived_at=excluded.archived_at,parent_task_id=excluded.parent_task_id,project_path=excluded.project_path,project_id=excluded.project_id,mode=excluded.mode,status=excluded.status",
                saved["id"], JsJson.Stringify(saved), Field(saved, "createdAt"), Field(saved, "updatedAt"), archived is Undefined ? null : archived,
                Field(saved, "parentTaskId"), Field(saved, "projectPath"), Field(saved, "projectId"), Field(saved, "mode") ?? "chat", saved["status"]);
            var old = previous is null ? null : Document((string)previous["data"]!);
            var currentGeneration = TaskGenerationFields.Select(key => key == "archivedAt" ? archived : Property(saved, key));
            if (old is null || string.Join('\0', TaskGenerationFields.Select(key => JoinPart(Property(old, key)))) != string.Join('\0', currentGeneration.Select(JoinPart)))
                Execute("UPDATE workspace_read_meta SET task_generation=task_generation+1 WHERE id=1");
            var taskId = (string)saved["id"]!;
            if (old is null) Event("task.created", new Dictionary<string, object?> { ["taskId"] = taskId, ["mode"] = Field(saved, "mode") ?? "chat" }, taskId);
            else
            {
                if (!Equals(Property(old, "status"), Property(saved, "status")))
                {
                    var type = (string)saved["status"]! switch
                    {
                        "running" => "task.started", "idle" when Equals(Field(old, "status"), "running") => "task.completed",
                        "retired" => "task.retired", _ => "task.stopped"
                    };
                    var data = new Dictionary<string, object?> { ["status"] = saved["status"], ["previousStatus"] = Property(old, "status") };
                    if (transition is not null) foreach (var pair in transition) data[pair.Key] = pair.Value;
                    Event(type, data, taskId);
                }
                if (!Equals(Property(old, "archivedAt"), archived))
                    Event(Truthy(archived) ? "task.archived" : "task.unarchived", new Dictionary<string, object?> { ["archivedAt"] = archived is Undefined ? null : archived }, taskId);
            }
            return saved;
        });
    }

    internal void SaveMessage(Dictionary<string, object?> message)
    {
        loop.AssertCurrent();
        Transaction(() =>
        {
            var existing = Rows("SELECT rowid,data FROM messages WHERE id=$p0", message["id"]).SingleOrDefault();
            if (existing is null)
                Execute("INSERT INTO messages(id,task_id,data,ordinal) VALUES($p0,$p1,$p2,(SELECT COALESCE(MAX(ordinal),0)+1 FROM messages))", message["id"], message["taskId"], JsJson.Stringify(message));
            else Execute("UPDATE messages SET data=$p0 WHERE id=$p1", JsJson.Stringify(message), message["id"]);
            if (SchemaVersion >= 5)
            {
                var rowId = existing?.GetValueOrDefault("rowid") ?? Scalar("SELECT rowid FROM messages WHERE id=$p0", message["id"]);
                if (existing is not null) Execute("DELETE FROM messages_fts WHERE rowid=$p0", rowId);
                Execute("INSERT INTO messages_fts(rowid,task_id,message_id,content) VALUES($p0,$p1,$p2,$p3)", rowId, message["taskId"], message["id"], new Redactor().Text((string)message["content"]!));
                Execute("UPDATE workspace_read_meta SET message_generation=message_generation+1 WHERE id=1");
                if (Equals(Field(message, "status"), "complete") && (existing is null || !Equals(Field(Document((string)existing["data"]!), "status"), "complete")))
                    Event("message.completed", new Dictionary<string, object?> { ["messageId"] = message["id"], ["role"] = message["role"] }, (string)message["taskId"]!);
            }
            return 0;
        });
    }

    private static object? Property(Dictionary<string, object?> document, string key) => document.TryGetValue(key, out var value) ? value : Undefined.Value;
    private static bool Truthy(object? value) => value switch
    {
        null or Undefined => false, bool flag => flag, string text => text.Length > 0,
        double number => number != 0 && !double.IsNaN(number), int number => number != 0, long number => number != 0, _ => true
    };
    private static string JoinPart(object? value) => value switch
    {
        null or Undefined => "", string text => text, Dictionary<string, object?> => "[object Object]",
        IEnumerable<object?> list => string.Join(',', list.Select(JoinPart)), _ => JsJson.Stringify(value)!
    };
}
