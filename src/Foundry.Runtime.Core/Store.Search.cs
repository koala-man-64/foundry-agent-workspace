using System.Globalization;
using Foundry.Platform;
using Foundry.Protocol;
using Microsoft.Data.Sqlite;

namespace Foundry.Runtime;

public sealed partial class Store
{
    internal Dictionary<string, object?> SearchPage(Dictionary<string, object?> input, Redactor? redactor = null)
    {
        loop.AssertCurrent(); redactor ??= new Redactor();
        var p = (Dictionary<string, object?>)Contracts.Validate("rpc workspace.search", input)!;
        var query = (string)p["query"]!; var limit = checked((int)(double)p["limit"]!);
        var filter = new Dictionary<string, object?> { ["query"] = query, ["visibility"] = p["visibility"] };
        foreach (var key in new[] { "projectPath", "projectId", "mode", "status", "from", "to" }) filter[key] = p.GetValueOrDefault(key);
        var hash = Compatibility.Hash(filter); var cursor = p.GetValueOrDefault("cursor") as Dictionary<string, object?>;
        if (cursor is not null && !Equals(cursor["filterHash"], hash)) throw new WorkspaceReadException("Search cursor belongs to different filters; restart the search.");
        var through = cursor?.GetValueOrDefault("throughOrdinal") ?? Scalar("SELECT COALESCE(MAX(ordinal),0) FROM messages");
        var taskThrough = cursor?.GetValueOrDefault("taskThroughRowid") ?? Scalar("SELECT COALESCE(MAX(rowid),0) FROM tasks");
        var basis = new Dictionary<string, object?> { ["throughOrdinal"] = through, ["taskThroughRowid"] = taskThrough, ["filterHash"] = hash };
        var hits = new List<Dictionary<string, object?>>();
        Dictionary<string, object?> Page(Dictionary<string, object?>? next) => new() { ["hits"] = hits, ["nextCursor"] = next };
        Dictionary<string, object?> Next(string phase, string key, object? value) => new(basis) { ["phase"] = phase, [key] = value };
        if (cursor is null || Equals(cursor["phase"], "titles"))
        {
            var after = cursor?.GetValueOrDefault("titleAfter") as Dictionary<string, object?>;
            List<Dictionary<string, object?>> remaining;
            if (SchemaVersion >= 5)
            {
                var args = new List<object?>(); string Bind(object? v) { args.Add(v); return "$p" + (args.Count - 1); }
                var clauses = new List<string> { "parent_task_id IS NULL", "rowid<=" + Bind(taskThrough), "instr(lower(json_extract(data,'$.title')),lower(" + Bind(query) + "))>0" };
                SearchFilters(clauses, Bind, p, "");
                if (after is not null) { var at = Bind(after["at"]); var id = Bind(after["id"]); clauses.Add($"(created_at<{at} OR (created_at={at} AND id<{id}))"); }
                remaining = Rows("SELECT data FROM tasks WHERE " + string.Join(" AND ", clauses) + " ORDER BY created_at DESC,id DESC LIMIT " + Bind(limit + 1), args.ToArray()).Select(row => Document((string)row["data"]!)).ToList();
            }
            else
            {
                // Preserve the legacy full scan and locale ordering. Its input
                // memory cost, shared with Node, remains a separate limitation.
                var tasks = Rows("SELECT data FROM tasks WHERE rowid<=$p0", taskThrough).Select(row => Document((string)row["data"]!)).ToList();
                var comparer = StringComparer.Create(CultureInfo.GetCultureInfo("en-US"), false);
                var lowered = EcmaScriptCase.ToLower(query);
                remaining = tasks.Where(task => !Truthy(task.GetValueOrDefault("parentTaskId")) && MatchesTask(task, p, "createdAt") && EcmaScriptCase.ToLower((string)task["title"]!).Contains(lowered, StringComparison.Ordinal))
                    .OrderByDescending(task => (string)task["createdAt"]!, comparer).ThenByDescending(task => (string)task["id"]!, comparer)
                    .Where(task => after is null || Before(task["createdAt"], task["id"], after["at"], after["id"])).Take(limit + 1).ToList();
            }
            foreach (var task in remaining.Take(limit)) hits.Add(new() { ["taskId"] = task["id"], ["rootTaskId"] = task["id"], ["taskTitle"] = task["title"], ["excerpt"] = task["title"], ["createdAt"] = task["createdAt"] });
            if (remaining.Count > hits.Count)
            {
                var last = remaining[hits.Count - 1];
                return Page(Next("titles", "titleAfter", new Dictionary<string, object?> { ["at"] = last["createdAt"], ["id"] = last["id"] }));
            }
            if (hits.Count == limit && Convert.ToInt64(through, CultureInfo.InvariantCulture) > 0 && SchemaVersion >= 5)
                return Page(Next("messages", "beforeOrdinal", Convert.ToInt64(through, CultureInfo.InvariantCulture) + 1));
        }
        if (SchemaVersion < 5 || Convert.ToInt64(through, CultureInfo.InvariantCulture) == 0) return Page(null);
        var tokens = string.Join(" AND ", SearchTokens(query).Take(8).Select(token => "\"" + token.Replace("\"", "\"\"", StringComparison.Ordinal) + "\""));
        var values = new List<object?>(); string Argument(object? v) { values.Add(v); return "$p" + (values.Count - 1); }
        var predicates = new List<string> { "messages_fts MATCH " + Argument(tokens), "m.ordinal<=" + Argument(through), "m.ordinal<" + Argument(cursor?.GetValueOrDefault("beforeOrdinal") ?? Convert.ToInt64(through, CultureInfo.InvariantCulture) + 1) };
        SearchFilters(predicates, Argument, p, "root.");
        var slots = limit - hits.Count;
        List<Dictionary<string, object?>> rows;
        try
        {
            rows = Rows("SELECT m.id,m.task_id,m.data,m.ordinal,root.data AS root_data FROM messages_fts JOIN messages m ON m.rowid=messages_fts.rowid JOIN tasks t ON t.id=m.task_id JOIN tasks root ON root.id=COALESCE(t.parent_task_id,t.id) WHERE " + string.Join(" AND ", predicates) + " ORDER BY m.ordinal DESC LIMIT " + Argument(slots + 1), values.ToArray());
        }
        catch (SqliteException error) when (query.Contains('\0') && error.SqliteErrorCode == 1 && error.Message == "SQLite Error 1: 'unterminated string'.")
        {
            // The frozen contract accepts NUL. This specific FTS parse error is
            // a client-visible Node verdict; other database faults still escape.
            throw new WorkspaceReadException("unterminated string");
        }
        foreach (var row in rows.Take(slots))
        {
            var message = Document((string)row["data"]!); var root = Document((string)row["root_data"]!);
            hits.Add(new() { ["taskId"] = row["task_id"], ["rootTaskId"] = root["id"], ["taskTitle"] = root["title"], ["messageId"] = row["id"], ["ordinal"] = row["ordinal"], ["role"] = message["role"], ["excerpt"] = Utf8Excerpt(redactor.Text((string)message["content"]!), 500).Content, ["createdAt"] = message["createdAt"] });
        }
        var lastOrdinal = hits.LastOrDefault(hit => hit.ContainsKey("ordinal"))?.GetValueOrDefault("ordinal");
        return Page(rows.Count > slots && lastOrdinal is not null ? Next("messages", "beforeOrdinal", lastOrdinal) : null);
    }

    private static void SearchFilters(List<string> clauses, Func<object?, string> bind, Dictionary<string, object?> p, string prefix)
    {
        if (!Equals(p["visibility"], "all")) clauses.Add(prefix + "archived_at " + (Equals(p["visibility"], "active") ? "IS NULL" : "IS NOT NULL"));
        foreach (var (key, column) in new[] { ("projectPath", "project_path"), ("projectId", "project_id"), ("mode", "mode"), ("status", "status") })
            if (Truthy(p.GetValueOrDefault(key))) clauses.Add(prefix + column + "=" + bind(p[key]));
        if (Truthy(p.GetValueOrDefault("from"))) clauses.Add(prefix + "created_at>=" + bind(p["from"]));
        if (Truthy(p.GetValueOrDefault("to"))) clauses.Add(prefix + "created_at<=" + bind(p["to"]));
    }
    private static IEnumerable<string> SearchTokens(string value)
    {
        var start = 0;
        for (var n = 0; n <= value.Length; n++)
            if (n == value.Length || value[n] is >= '\u0009' and <= '\u000d' or '\u0020' or '\u00a0' or '\u1680' or >= '\u2000' and <= '\u200a' or '\u2028' or '\u2029' or '\u202f' or '\u205f' or '\u3000' or '\ufeff')
            { if (n > start) yield return value[start..n]; start = n + 1; }
    }
}
