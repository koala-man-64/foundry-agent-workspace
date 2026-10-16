using Foundry.Protocol;

namespace Foundry.Runtime;

public sealed partial class Store
{
    private static readonly string[] AdmissionFeatures = ["archive", "hooks", "scheduling"];

    internal Dictionary<string, object?> FeatureState(string feature)
    {
        loop.AssertCurrent();
        if (SchemaVersion < 5) return new() { ["feature"] = feature, ["enabled"] = false, ["reason"] = "migration-required", ["updatedAt"] = null };
        var row = Rows("SELECT feature,enabled,reason,updated_at FROM workspace_features WHERE feature=$p0", feature).SingleOrDefault();
        return row is null ? new() { ["feature"] = feature, ["enabled"] = true, ["reason"] = null, ["updatedAt"] = null } : FeatureRow(row);
    }
    private static Dictionary<string, object?> FeatureRow(Dictionary<string, object?> row) => new()
    {
        ["feature"] = row["feature"], ["enabled"] = Truthy(row["enabled"]), ["reason"] = row["reason"], ["updatedAt"] = row["updated_at"]
    };
    internal Dictionary<string, object?> FeatureSnapshot()
    {
        loop.AssertCurrent();
        return new() { ["features"] = AdmissionFeatures.Select(FeatureState).ToList(), ["history"] = SchemaVersion < 5 ? new List<object?>() : Rows("SELECT feature,enabled,reason,updated_at FROM workspace_feature_history ORDER BY ordinal DESC LIMIT 50").Select(FeatureRow).ToList() };
    }
    internal Dictionary<string, object?> SetFeature(Dictionary<string, object?> input)
    {
        loop.AssertCurrent();
        var p = (Dictionary<string, object?>)Contracts.Validate("rpc features.set", input)!;
        if (SchemaVersion < 5) throw new WorkspaceReadException("Feature admission requires the verified v5 migration.");
        var feature = (string)p["feature"]!; var enabled = (bool)p["enabled"]!;
        var reason = enabled ? null : p.GetValueOrDefault("reason") ?? "user-paused";
        if (Equals(reason, "migration-required")) throw new WorkspaceReadException("Only migration status may report migration-required.");
        var prior = FeatureState(feature);
        if (Equals(prior["enabled"], enabled) && Equals(prior["reason"], reason)) return prior;
        var timestamp = Clock.Iso(now());
        Transaction(() =>
        {
            Execute("INSERT INTO workspace_features(feature,enabled,reason,updated_at) VALUES($p0,$p1,$p2,$p3) ON CONFLICT(feature) DO UPDATE SET enabled=excluded.enabled,reason=excluded.reason,updated_at=excluded.updated_at", feature, enabled ? 1 : 0, reason, timestamp);
            Execute("INSERT INTO workspace_feature_history(feature,enabled,reason,updated_at) VALUES($p0,$p1,$p2,$p3)", feature, enabled ? 1 : 0, reason, timestamp);
            return 0;
        });
        return new() { ["feature"] = feature, ["enabled"] = enabled, ["reason"] = reason, ["updatedAt"] = timestamp };
    }
    internal Dictionary<string, object?> SetArchived(string taskId, bool archived)
    {
        loop.AssertCurrent();
        var saved = Transaction(() =>
        {
            var task = ReadTask(taskId);
            if (Truthy(task.GetValueOrDefault("parentTaskId"))) throw new WorkspaceReadException("Archive the coordinated root, not an individual child.");
            var archivedAt = archived ? task.GetValueOrDefault("archivedAt") ?? Clock.Iso(now()) : Undefined.Value;
            var result = SaveTask(new Dictionary<string, object?>(task) { ["archivedAt"] = archivedAt });
            if (SchemaVersion >= 5 && Equals(task.GetValueOrDefault("mode"), "coordinated"))
                foreach (var row in Rows("SELECT data FROM tasks WHERE parent_task_id=$p0", task["id"]))
                    SaveTask(new Dictionary<string, object?>(Document((string)row["data"]!)) { ["archivedAt"] = archivedAt });
            return result;
        });
        return saved;
    }
}
