using Foundry.Protocol;

namespace Foundry.Runtime;

/// <summary>Existing workspace mutations admitted before repository execution is ported.</summary>
public sealed partial class Store
{
    internal Dictionary<string, object?> UpdateProject(Dictionary<string, object?> parameters)
    {
        loop.AssertCurrent();
        parameters = (Dictionary<string, object?>)Contracts.Validate("rpc project.update", parameters)!;
        RequireServiceProjects();
        var project = Project((string)parameters["projectId"]!) ?? throw new WorkspaceReadException("Project not found.");
        if (!parameters.ContainsKey("name") && !parameters.ContainsKey("hidden")) throw new WorkspaceReadException("Choose a name or visibility change.");
        var updated = new Dictionary<string, object?>(project);
        foreach (var field in new[] { "name", "hidden" }) if (parameters.TryGetValue(field, out var value)) updated[field] = value;
        updated["updatedAt"] = Clock.Iso(now());
        return Transaction(() =>
        {
            SaveProject(updated);
            Event("projects.changed", new Dictionary<string, object?> { ["projectId"] = updated["id"] });
            return updated;
        });
    }

    internal Dictionary<string, object?> UpdatePreferences(Dictionary<string, object?> parameters)
    {
        loop.AssertCurrent();
        parameters = (Dictionary<string, object?>)Contracts.Validate("rpc workspace.preferences.save", parameters)!;
        RequireServiceProjects();
        if (parameters.TryGetValue("profileId", out var profile) && profile is string profileId && profileId.Length > 0 && Profile(profileId) is null)
            throw new WorkspaceReadException("Select an existing model profile.");
        if (parameters.TryGetValue("collapsedProjectIds", out var collapsed))
            foreach (var value in (List<object?>)collapsed!)
                if (!Equals(value, "none") && Project((string)value!) is null) throw new WorkspaceReadException("A collapsed project no longer exists.");
        var saved = new Dictionary<string, object?>(Preferences());
        foreach (var pair in parameters) saved[pair.Key] = pair.Value;
        if (parameters.TryGetValue("collapsedProjectIds", out var ids)) saved["collapsedProjectIds"] = ((List<object?>)ids!).Distinct().ToList();
        return Transaction(() =>
        {
            SavePreferences(saved);
            Event("preferences.changed", new Dictionary<string, object?>());
            return saved;
        });
    }

    private void RequireServiceProjects()
    {
        if (SchemaVersion < 3) throw new WorkspaceReadException("Saved projects require the backed-up database upgrade. Upgrade from the workspace banner first.");
    }
}
