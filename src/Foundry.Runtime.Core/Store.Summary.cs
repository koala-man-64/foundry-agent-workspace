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
    private (List<object?> Items, string? Cursor) Page(string table, string? after = null, int limit = 25, int budget = 96 * 1024)
    {
        if (table is not "profiles" and not "projects") throw new ArgumentException("Invalid page.", nameof(table));
        var rows = Rows("SELECT id,data FROM " + table + " WHERE id>$p0 ORDER BY id LIMIT $p1", after ?? "", limit + 1);
        var items = new List<object?>();
        foreach (var row in rows)
        {
            if (items.Count >= limit) break;
            var item = Document((string)row["data"]!);
            if (table == "projects")
            {
                var path = (string)item["path"]!;
                if (NetworkPathPolicy.IsNetworkOrDevicePath(path))
                {
                    item["kind"] = "unavailable"; item["unavailableReason"] = "Projects on network shares are not supported.";
                }
                else try
                {
                    using var folder = RepositoryFolderLease.Open(loop, path);
                    if (!StringComparer.Ordinal.Equals(EcmaScriptCase.ToLower(folder.Path), EcmaScriptCase.ToLower(path)))
                    {
                        item["kind"] = "unavailable"; item["unavailableReason"] = "Folder is unavailable.";
                    }
                }
                catch (Exception error) when (error is IOException or ArgumentException or WorkspaceReadException)
                {
                    item["kind"] = "unavailable"; item["unavailableReason"] = "Folder is unavailable.";
                }
            }
            var candidate = new Dictionary<string, object?> { [table] = items.Append(item).ToList(), ["nextAfter"] = row["id"] };
            if (Encoding.UTF8.GetByteCount(JsJson.Stringify(candidate)!) > budget)
            {
                if (items.Count == 0) throw new WorkspaceReadException(table == "profiles" ? "Stored profile is too large to page safely. Repair this profile before using it." : "Stored project is too large to page safely. Repair this project before using it.");
                break;
            }
            items.Add(item);
        }
        return (items, rows.Count > items.Count ? (string)((Dictionary<string, object?>)items[^1]!)["id"]! : null);
    }
}
