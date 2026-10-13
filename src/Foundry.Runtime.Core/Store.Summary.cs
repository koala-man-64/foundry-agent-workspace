using System.Text;
using Foundry.Platform;
using Foundry.Protocol;

namespace Foundry.Runtime;

public sealed class WorkspaceReadException(string message) : InvalidOperationException(message);

public sealed partial class Store
{
    public Dictionary<string, object?> Summary()
    {
        loop.AssertCurrent();
        var profiles = Page("profiles");
        var projects = SchemaVersion >= 3 ? Page("projects") : (new List<object?>(), (string?)null);
        var preferences = SchemaVersion >= 3 ? Scalar("SELECT data FROM workspace_preferences WHERE id=1") as string : null;
        return new()
        {
            ["profiles"] = profiles.Items, ["nextProfileAfter"] = profiles.Cursor,
            ["projects"] = projects.Item1, ["nextProjectAfter"] = projects.Item2,
            ["preferences"] = preferences is null ? new Dictionary<string, object?> { ["profileId"] = FakeProfileId, ["mode"] = "chat", ["collapsedProjectIds"] = new List<object?>() } : Document(preferences),
            ["lastSequence"] = (long)Scalar("SELECT COALESCE(MAX(sequence),0) FROM events")!, ["runtime"] = "ready"
        };
    }
    private (List<object?> Items, string? Cursor) Page(string table)
    {
        if (table is not "profiles" and not "projects") throw new ArgumentException("Invalid page.", nameof(table));
        var rows = Rows("SELECT id,data FROM " + table + " WHERE id>$p0 ORDER BY id LIMIT $p1", "", 26);
        var items = new List<object?>();
        foreach (var row in rows)
        {
            if (items.Count >= 25) break;
            var item = Document((string)row["data"]!);
            if (table == "projects")
            {
                var path = (string)item["path"]!;
                if (NetworkPathPolicy.IsNetworkOrDevicePath(path))
                {
                    item["kind"] = "unavailable"; item["unavailableReason"] = "Projects on network shares are not supported.";
                }
                else if (!Directory.Exists(path) || !FinalPath.TryResolve(path, out var resolved) || !StringComparer.Ordinal.Equals(EcmaScriptCase.ToLower(resolved), EcmaScriptCase.ToLower(path)))
                {
                    item["kind"] = "unavailable"; item["unavailableReason"] = "Folder is unavailable.";
                }
            }
            var candidate = new Dictionary<string, object?> { [table] = items.Append(item).ToList(), ["nextAfter"] = row["id"] };
            if (Encoding.UTF8.GetByteCount(JsJson.Stringify(candidate)!) > 96 * 1024)
            {
                if (items.Count == 0) throw new WorkspaceReadException(table == "profiles" ? "Stored profile is too large to page safely. Repair this profile before using it." : "Stored project is too large to page safely. Repair this project before using it.");
                break;
            }
            items.Add(item);
        }
        return (items, rows.Count > items.Count ? (string)((Dictionary<string, object?>)items[^1]!)["id"]! : null);
    }
}
