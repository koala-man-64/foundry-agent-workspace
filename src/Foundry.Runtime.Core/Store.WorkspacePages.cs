using System.Globalization;
using System.Text;
using System.Text.Json;
using Foundry.Protocol;

namespace Foundry.Runtime;

public sealed partial class Store
{
    internal Dictionary<string, object?> ProfilePage(string? after = null, int limit = 50)
    {
        loop.AssertCurrent(); var page = Page("profiles", after, limit, 128 * 1024);
        return new() { ["profiles"] = page.Items, ["nextAfter"] = page.Cursor };
    }

    internal Dictionary<string, object?> ProjectPage(string? after = null, int limit = 50)
    {
        loop.AssertCurrent(); var page = SchemaVersion < 3 ? (new List<object?>(), (string?)null) : Page("projects", after, limit, 128 * 1024);
        return new() { ["projects"] = page.Item1, ["nextAfter"] = page.Item2 };
    }

    internal Dictionary<string, object?>? ProfileRead(string profileId)
    {
        loop.AssertCurrent(); var profile = Profile(profileId);
        if (profile is not null && PageSize(profile) > ReadPageBytes) throw new WorkspaceReadException("Stored profile is too large to read safely. Repair this profile before using it.");
        return profile;
    }

    // Parameters have already passed the frozen workspace.tasks contract.
    internal Dictionary<string, object?> TaskPage(Dictionary<string, object?> parameters)
    {
        loop.AssertCurrent();
        var visibility = (string)parameters["visibility"]!; var sort = (string)parameters["sort"]!;
        var limit = Convert.ToInt32(parameters["limit"], CultureInfo.InvariantCulture);
        var column = sort == "created" ? "created_at" : "updated_at";
        var property = sort == "created" ? "createdAt" : "updatedAt";
        var filter = new Dictionary<string, object?> { ["visibility"] = visibility, ["sort"] = sort };
        foreach (var key in new[] { "projectPath", "projectId", "mode", "status", "from", "to" }) filter[key] = parameters.GetValueOrDefault(key);
        var fingerprint = Compatibility.Hash(filter); var cursor = parameters.GetValueOrDefault("cursor") as Dictionary<string, object?>;
        if (sort == "recent" && cursor is not null) throw new WorkspaceReadException("Recent tasks are a refreshed first page; reload to see changes.");
        if (cursor is not null && !Equals(cursor["filterHash"], fingerprint)) throw new WorkspaceReadException("Task list cursor belongs to different filters; reload the first page.");
        List<Dictionary<string, object?>> candidates; object? highAt; object? highId;
        if (SchemaVersion < 5)
        {
            var comparer = StringComparer.Create(CultureInfo.GetCultureInfo("en-US"), false);
            var legacy = Rows("SELECT data FROM tasks").Select(row => Document((string)row["data"]!))
                .Where(task => !Truthy(task.GetValueOrDefault("parentTaskId")) && MatchesTask(task, parameters, property))
                .OrderByDescending(task => (string)task[property]!, comparer).ThenByDescending(task => (string)task["id"]!, comparer).ToList();
            highAt = cursor is null ? legacy.FirstOrDefault()?.GetValueOrDefault(property) ?? "" : cursor["highWaterAt"];
            highId = cursor is null ? legacy.FirstOrDefault()?.GetValueOrDefault("id") ?? "" : cursor["highWaterId"];
            candidates = legacy.Where(task => cursor is null || Before(task[property], task["id"], cursor["at"], cursor["id"])).Take(limit + 1).ToList();
        }
        else
        {
            var clauses = new List<string> { "parent_task_id IS NULL" }; var args = new List<object?>();
            string Argument(object? value) { args.Add(value); return "$p" + (args.Count - 1).ToString(CultureInfo.InvariantCulture); }
            if (visibility != "all") clauses.Add(visibility == "active" ? "archived_at IS NULL" : "archived_at IS NOT NULL");
            foreach (var pair in new[] { ("projectPath", "project_path"), ("projectId", "project_id"), ("mode", "mode"), ("status", "status") })
                if (Truthy(parameters.GetValueOrDefault(pair.Item1))) clauses.Add(pair.Item2 + "=" + Argument(parameters[pair.Item1]));
            if (Truthy(parameters.GetValueOrDefault("from"))) clauses.Add(column + ">=" + Argument(parameters["from"]));
            if (Truthy(parameters.GetValueOrDefault("to"))) clauses.Add(column + "<=" + Argument(parameters["to"]));
            if (cursor is not null)
            {
                var at = Argument(cursor["at"]); var key = Argument(cursor["id"]);
                clauses.Add($"({column}<{at} OR ({column}={at} AND id<{key}))");
                var water = Argument(cursor["highWaterAt"]); var waterId = Argument(cursor["highWaterId"]);
                clauses.Add($"({column}<{water} OR ({column}={water} AND id<={waterId}))");
            }
            var count = Argument(limit + 1);
            var rows = Rows($"SELECT id,data,created_at,updated_at FROM tasks WHERE {string.Join(" AND ", clauses)} ORDER BY {column} DESC,id DESC LIMIT {count}", args.ToArray());
            highAt = cursor is null ? rows.FirstOrDefault()?.GetValueOrDefault(column) ?? "" : cursor["highWaterAt"];
            highId = cursor is null ? rows.FirstOrDefault()?.GetValueOrDefault("id") ?? "" : cursor["highWaterId"];
            candidates = rows.Select(row => Document((string)row["data"]!)).ToList();
        }
        var tasks = new List<object?>();
        foreach (var task in candidates.Take(limit))
        {
            if (PageSize(new Dictionary<string, object?> { ["tasks"] = tasks.Append(task).ToList() }) > ReadItemsBytes)
            {
                if (tasks.Count == 0) throw new WorkspaceReadException("Stored task is too large to page safely.");
                break;
            }
            tasks.Add(task);
        }
        var last = tasks.LastOrDefault() as Dictionary<string, object?>;
        object? next = sort == "created" && last is not null && candidates.Count > tasks.Count
            ? new Dictionary<string, object?> { ["at"] = last["createdAt"], ["id"] = last["id"], ["highWaterAt"] = highAt, ["highWaterId"] = highId, ["filterHash"] = fingerprint } : null;
        return new() { ["tasks"] = tasks, ["nextCursor"] = next, ["visibility"] = visibility };
    }

    private static bool Before(object? at, object? id, object? boundary, object? key) =>
        StringComparer.Ordinal.Compare((string?)at, (string?)boundary) < 0 || Equals(at, boundary) && StringComparer.Ordinal.Compare((string?)id, (string?)key) < 0;

    private static bool MatchesTask(Dictionary<string, object?> task, Dictionary<string, object?> p, string property)
    {
        if (Equals(p["visibility"], "active") && Truthy(task.GetValueOrDefault("archivedAt")) || Equals(p["visibility"], "archived") && !Truthy(task.GetValueOrDefault("archivedAt"))) return false;
        foreach (var key in new[] { "projectPath", "projectId", "mode", "status" })
            if (Truthy(p.GetValueOrDefault(key)) && !Equals(key == "mode" ? task.GetValueOrDefault(key) ?? "chat" : task.GetValueOrDefault(key), p[key])) return false;
        var at = (string)task[property]!;
        return !(Truthy(p.GetValueOrDefault("from")) && StringComparer.Ordinal.Compare(at, (string)p["from"]!) < 0 || Truthy(p.GetValueOrDefault("to")) && StringComparer.Ordinal.Compare(at, (string)p["to"]!) > 0);
    }

    private static int PageSize(object value) => Encoding.UTF8.GetByteCount(JsJson.Stringify(value)!);

    internal Dictionary<string, object?> EventPage(long after = 0, int limit = 50, string? taskId = null, Redactor? redactor = null)
    {
        loop.AssertCurrent(); var args = taskId is null ? new object?[] { after, limit + 1 } : [after, taskId, limit + 1];
        var rows = Rows($"SELECT sequence,type,task_id,data,created_at,{EventMetadata} FROM events WHERE sequence>$p0 {(taskId is null ? "" : "AND task_id=$p1")} ORDER BY sequence LIMIT $p{args.Length - 1}", args);
        return BuildEventPage(rows, limit, "nextAfter", redactor ?? new Redactor());
    }

    internal Dictionary<string, object?> TimelinePage(string taskId, long? before = null, int limit = 50, Redactor? redactor = null)
    {
        loop.AssertCurrent(); var task = ReadTask(taskId); var children = SchemaVersion >= 5 && !Truthy(task.GetValueOrDefault("parentTaskId")) && Equals(task.GetValueOrDefault("mode"), "coordinated");
        var rows = Rows($"SELECT sequence,type,task_id,data,created_at,{EventMetadata} FROM events WHERE (task_id=$p0 {(children ? "OR task_id IN (SELECT id FROM tasks WHERE parent_task_id=$p0)" : "")}) AND sequence<$p1 ORDER BY sequence DESC LIMIT $p2", taskId, before ?? 9_007_199_254_740_991L, limit + 1);
        return BuildEventPage(rows, limit, "nextBefore", redactor ?? new Redactor());
    }

    private string EventMetadata => SchemaVersion >= 5 ? "version,source,root_task_id" : "NULL AS version,NULL AS source,NULL AS root_task_id";
    private static Dictionary<string, object?> BuildEventPage(List<Dictionary<string, object?>> rows, int limit, string nextKey, Redactor redactor)
    {
        var events = new List<object?>();
        foreach (var row in rows.Take(limit))
        {
            var raw = (string)row["data"]!; object? data = new Dictionary<string, object?> { ["redacted"] = true };
            if (Encoding.UTF8.GetByteCount(raw) > 4096) data = new Dictionary<string, object?> { ["truncated"] = true };
            else try { var clean = redactor.Text(raw); data = Encoding.UTF8.GetByteCount(clean) > 4096 ? new Dictionary<string, object?> { ["truncated"] = true } : PersistedJson.Parse(clean); } catch (JsonException) { }
            var runtime = Equals(row["version"], 1L) && Equals(row["source"], "runtime");
            var item = new Dictionary<string, object?> { ["sequence"] = row["sequence"], ["type"] = row["type"] };
            if (row["task_id"] is not null) item["taskId"] = row["task_id"];
            if (row["root_task_id"] is not null) item["rootTaskId"] = row["root_task_id"];
            item["data"] = data; item["createdAt"] = row["created_at"]; item["version"] = 1; item["source"] = runtime ? "runtime" : "legacy";
            if (!runtime) item["legacy"] = true;
            if (PageSize(new Dictionary<string, object?> { ["events"] = events.Append(item).ToList() }) > ReadItemsBytes)
            {
                if (events.Count == 0) throw new WorkspaceReadException("Stored event metadata is too large to page safely.");
                break;
            }
            events.Add(item);
        }
        return new() { ["events"] = events, [nextKey] = rows.Count > events.Count ? ((Dictionary<string, object?>)events[^1]!)["sequence"] : null };
    }
}
