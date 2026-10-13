using Foundry.Platform;
using Foundry.Protocol;

namespace Foundry.Runtime;

/// <summary>Persisted workspace primitives. RPC admission and event publication belong to the service slice.</summary>
public sealed partial class Store
{
    private Func<string, string> workspacePathKey = FinalPath.Key;
    // Deterministic fault injection: prove affinity rejection occurs before any path probe.
    internal Func<string, string> WorkspacePathKeyProbe
    {
        set { loop.AssertCurrent(); workspacePathKey = value; }
    }
    internal void RequireProjects()
    {
        loop.AssertCurrent();
        if (SchemaVersion < 3) throw new InvalidOperationException("Saved projects require the backed-up database upgrade. Upgrade from the workspace banner first.");
    }

    internal Dictionary<string, object?>? Profile(string profileId) => ReadDocument("SELECT data FROM profiles WHERE id=$p0", profileId);
    internal void SaveProfile(Dictionary<string, object?> profile)
    {
        loop.AssertCurrent();
        Execute("INSERT OR REPLACE INTO profiles(id,data) VALUES($p0,$p1)", profile["id"], JsJson.Stringify(profile));
    }

    internal List<Dictionary<string, object?>> Projects()
    {
        loop.AssertCurrent();
        return SchemaVersion < 3 ? [] : Rows("SELECT data FROM projects").Select(row => Document((string)row["data"]!)).ToList();
    }
    internal Dictionary<string, object?>? Project(string projectId)
    {
        RequireProjects();
        return ReadDocument("SELECT data FROM projects WHERE id=$p0", projectId);
    }
    // Callers must admit paths before this canonical identity probe, as in the TypeScript Store.
    internal Dictionary<string, object?>? ProjectByPath(string path)
    {
        loop.AssertCurrent();
        return ReadDocument("SELECT data FROM projects WHERE path_key=$p0", workspacePathKey(path));
    }

    internal Dictionary<string, object?> InsertProject(string path, string kind = "folder")
    {
        loop.AssertCurrent();
        var timestamp = Clock.Iso(now());
        var name = WindowsBasename(path);
        var project = new Dictionary<string, object?>
        {
            ["id"] = id().ToString(), ["path"] = path, ["name"] = name.Length == 0 ? path : name,
            ["hidden"] = false, ["kind"] = kind, ["createdAt"] = timestamp, ["updatedAt"] = timestamp
        };
        Execute("INSERT INTO projects(id,path_key,data) VALUES($p0,$p1,$p2)", project["id"], workspacePathKey(path), JsJson.Stringify(project));
        return project;
    }
    internal Dictionary<string, object?> SaveProject(Dictionary<string, object?> project)
    {
        RequireProjects();
        Execute("UPDATE projects SET data=$p0 WHERE id=$p1", JsJson.Stringify(project), project["id"]);
        return project;
    }

    internal Dictionary<string, object?> Preferences()
    {
        loop.AssertCurrent();
        return (SchemaVersion >= 3 ? ReadDocument("SELECT data FROM workspace_preferences WHERE id=1") : null)
            ?? new Dictionary<string, object?> { ["profileId"] = FakeProfileId, ["mode"] = "chat", ["collapsedProjectIds"] = new List<object?>() };
    }
    internal Dictionary<string, object?> SavePreferences(Dictionary<string, object?> preferences)
    {
        RequireProjects();
        Execute("INSERT OR REPLACE INTO workspace_preferences(id,data) VALUES(1,$p0)", JsJson.Stringify(preferences));
        return preferences;
    }

    internal Dictionary<string, object?>? TaskStart(string requestId)
    {
        RequireProjects();
        var row = Rows("SELECT input_hash,task_id,state FROM task_starts WHERE request_id=$p0", requestId).SingleOrDefault();
        return row is null ? null : new() { ["inputHash"] = row["input_hash"], ["taskId"] = row["task_id"], ["state"] = row["state"] };
    }
    internal void ReserveTaskStart(string requestId, string inputHash, string taskId)
    {
        loop.AssertCurrent();
        Execute("INSERT INTO task_starts(request_id,input_hash,task_id,state,created_at) VALUES($p0,$p1,$p2,'pending',$p3)", requestId, inputHash, taskId, Clock.Iso(now()));
    }
    internal void FinishTaskStart(string requestId, string state)
        => Execute("UPDATE task_starts SET state=$p0 WHERE request_id=$p1", state, requestId);
    internal void ClearTaskStart(string requestId)
        => Execute("DELETE FROM task_starts WHERE request_id=$p0 AND state='pending'", requestId);

    private Dictionary<string, object?>? ReadDocument(string sql, params object?[] values)
        => Scalar(sql, values) is string json ? Document(json) : null;
    private static string WindowsBasename(string path)
    {
        var start = path.Length >= 2 && char.IsAsciiLetter(path[0]) && path[1] == ':' ? 2 : 0;
        var end = path.Length;
        while (end > start && path[end - 1] is '/' or '\\') end--;
        var index = end;
        while (index > start && path[index - 1] is not '/' and not '\\') index--;
        return path[index..end];
    }
}
