namespace Foundry.Runtime;

/// <summary>
/// TypeScript's ToolRuntime (tool-runtime.ts): one-shot decisions about reviewed tool actions. Nothing in model output,
/// repository text or a saved intent grants approval. This slice holds read-only reconciliation of unknown outcomes; the
/// tool execution and decision paths arrive with the native tool loop.
/// </summary>
internal sealed class ToolRuntime(RuntimeLoop loop, Store store, RepositoryService repositories)
{
    /// <summary>
    /// reconcile: an unknown outcome of this task is checked without replaying anything. An edit is compared, by hash, with
    /// the file in the task's worktree: the approved content completes it, the original content fails it, anything else
    /// (or a file that cannot be read safely) leaves it unknown. Command, external tool, browser and orchestration outcomes
    /// cannot be reconstructed here, so they stay unknown with guidance. The approval is saved with its approval.changed
    /// event as service.ts records it: before schema v5 always; from v5 when the state changed, or when the task has no
    /// such event yet (its publish falls back to recording one).
    /// </summary>
    internal Dictionary<string, object?> Reconcile(string taskId, string approvalId)
    {
        loop.AssertCurrent();
        var approval = store.Approval(approvalId);
        if (!Equals(approval.GetValueOrDefault("taskId"), taskId) || !Equals(approval["state"], "unknown"))
            throw new WorkspaceReadException("Only an unknown outcome for this task can be checked.");
        if (approval.GetValueOrDefault("path") is string { Length: > 0 } path && approval.GetValueOrDefault("resultingHash") is string { Length: > 0 } resulting)
        {
            try
            {
                var hash = repositories.ReadFile((string)store.ReadGitTask(taskId)["worktreePath"]!, path)["hash"] as string;
                if (hash == resulting) { approval["state"] = "complete"; approval["result"] = Result("Read-only reconciliation found the exact approved file content.", false); }
                else if (hash is not null && hash == approval.GetValueOrDefault("expectedHash") as string) { approval["state"] = "failed"; approval["result"] = Result("Read-only reconciliation found the original content. No retry was performed.", true); }
                else approval["result"] = Result("File content matches neither the original nor approved result. Outcome remains unknown; inspect the worktree.", true);
            }
            // TypeScript's catch-all: whatever stops the read, nothing is concluded from it.
            catch (Exception error) when (error is not OperationCanceledException) { approval["result"] = Result("The file could not be checked safely. Outcome remains unknown.", true); }
        }
        else if (Present(approval, "handoff") || Present(approval, "integration"))
            approval["result"] = Result("Use the orchestration operation check for this Git action. Its outcome is reconciled from repository state, never replayed.", true);
        else if (Present(approval, "mcp"))
            approval["result"] = Result("An external MCP tool outcome cannot be reconstructed by the runtime. Inspect the server's own state; this call will not be replayed.", true);
        else if (Present(approval, "browser"))
            approval["result"] = Result("Browser action outcome is unknown. Inspect the tab manually, then acknowledge it to permit newly reviewed actions. This action will not be replayed.", true);
        else
        {
            var result = Result("Command outcome cannot be reconstructed safely. Inspect the worktree and any external effects. This command will not be replayed.", true);
            result["cleanupVerified"] = false;
            approval["result"] = result;
        }
        Save(approval);
        return approval;
    }

    /// <summary>
    /// tool-runtime.ts save(): store.saveApproval, then service.ts publish('approval.changed'). Before schema v5 publish
    /// records a new event; from v5 it re-reads the task's latest approval.changed event and records one only when there is
    /// none, so a save that changed nothing still leaves the task one such event. Native commits all of it together.
    /// Every approval write goes through here.
    /// </summary>
    internal void Save(Dictionary<string, object?> approval)
    {
        loop.AssertCurrent();
        store.Transaction(() =>
        {
            var recorded = store.SaveApproval(approval);
            var taskId = approval.GetValueOrDefault("taskId") as string;
            if (store.SchemaVersion < 5 || !recorded && !store.HasTaskEvent("approval.changed", taskId))
                store.Event("approval.changed", new Dictionary<string, object?> { ["approvalId"] = approval["id"], ["state"] = approval["state"] }, taskId);
            return 0;
        });
    }

    private static Dictionary<string, object?> Result(string content, bool isError) => new() { ["content"] = content, ["isError"] = isError };

    /// <summary>JavaScript truthiness for a stored object field: present, and not null, false, empty or zero.</summary>
    private static bool Present(Dictionary<string, object?> value, string key) =>
        value.GetValueOrDefault(key) is not (null or false or "" or 0 or 0L or 0d or Foundry.Protocol.Undefined);
}
