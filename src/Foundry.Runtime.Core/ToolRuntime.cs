using System.Text;
using Foundry.Protocol;

namespace Foundry.Runtime;

/// <summary>A model's tool call: its provider id, the tool name and the parsed JSON arguments.</summary>
internal sealed record ToolCall(string Id, string Name, object? Arguments);

/// <summary>ProviderToolResult: the redacted, bounded text a tool returns to the model.</summary>
internal sealed record ToolResult(string Id, string Name, string Content, bool IsError) : IWireModel
{
    public Dictionary<string, object?> ToWire() => new() { ["id"] = Id, ["name"] = Name, ["content"] = Content, ["isError"] = IsError };
}

/// <summary>
/// TypeScript's ToolRuntime (tool-runtime.ts): one-shot decisions about reviewed tool actions. Nothing in model output,
/// repository text or a saved intent grants approval. It is unwired: no RPC, turn or decision reaches it until the native
/// tool loop lands, and it serves only the six repository tools of an ordinary coding task. External (MCP), browser,
/// channel and orchestration tools, coordinated roles and hook-origin drafts refuse until their own slices.
/// </summary>
internal sealed class ToolRuntime(RuntimeLoop loop, Store store, RepositoryService repositories, CommandRunner commands, Redactor redactor, ExecutionSlots slots,
    Func<DateTimeOffset> now, Func<Guid> id)
{
    private const string Unavailable = "Tool is not available.";
    private const string SecretContent = "This action contains secret-like content and cannot be persisted or executed.";
    private const string Aborted = "This operation was aborted";
    private const int ResultBytes = 192 * 1024;
    private static readonly string[] BrowserTools = ["browser_tabs", "browser_snapshot", "browser_action"];
    private static readonly string[] ChannelTools = ["list_project_agents", "send_agent_message", "read_agent_messages"];
    private static readonly string[] OrchestrationTools = ["delegate_assignments", "await_children", "integrate_result", "complete_task", "commit_handoff", "submit_handoff"];

    private sealed record Waiter(string TaskId, TaskCompletionSource<bool> Decision, CancellationToken Cancellation);
    private readonly Dictionary<string, Waiter> waiting = new(StringComparer.Ordinal);

    /// <summary>
    /// execute: one tool call of an ordinary coding task (Git, mode coding, no coordinated role), checked in TypeScript's
    /// order. The read tools answer at once. An edit or command is prepared, screened for secrets and saved as a proposal
    /// that waits for its one-shot decision without holding an execution slot. Once approved, the executing state is saved
    /// before any repository or process mutation, inside a slot. A failure is classified as TypeScript classifies it:
    /// after the executing state, unknown unless the failure is known to precede any effect; a cancelled wait is revoked.
    /// Results are redacted and bounded to 192 KiB of UTF-8. A failure other than the runtime's own refusals is classified
    /// and saved like any other, then rethrown rather than handed to the model as text.
    /// </summary>
    internal async Task<ToolResult> Execute(Dictionary<string, object?> task, ToolCall call, CancellationToken token)
    {
        loop.AssertCurrent();
        ToolResult Result(string content, bool isError = false)
        {
            var clean = redactor.Text(content);
            if (Encoding.UTF8.GetByteCount(clean) > ResultBytes) return new(call.Id, call.Name, "Tool output exceeded the result limit. Request a smaller result.", true);
            return new(call.Id, call.Name, clean, isError);
        }
        Dictionary<string, object?>? approval = null;
        PreparedCommand? command = null;
        try
        {
            token.ThrowIfCancellationRequested();
            if (BrowserTools.Contains(call.Name, StringComparer.Ordinal)) throw new WorkspaceReadException("Browser tools are unavailable.");
            if (task.GetValueOrDefault("workspaceKind") is not (null or Undefined or "" or "git")) throw new WorkspaceReadException("Repository tools require a Git worktree.");
            // The project channel lands with the native AgentChannel.
            if (ChannelTools.Contains(call.Name, StringComparer.Ordinal)) throw new WorkspaceReadException(Unavailable);
            if (task.GetValueOrDefault("mode") is null or Undefined or "" or "chat") throw new WorkspaceReadException("Chat tasks can use only project communication and attached browser tools.");
            // Coordinated roles are refused before any reservation; native has no orchestration hooks.
            if (Equals(task.GetValueOrDefault("role"), "child") && Present(task, "parentTaskId") || Equals(task.GetValueOrDefault("mode"), "coordinated")) throw new WorkspaceReadException(Unavailable);
            if (OrchestrationTools.Contains(call.Name, StringComparer.Ordinal) || call.Name.StartsWith("mcp__", StringComparison.Ordinal) || !ToolDefinitions.IsTool(call.Name))
                throw new WorkspaceReadException(Unavailable);
            AssertNoSecrets(JsJson.Stringify(call.Arguments)!);
            var worktree = (string)task["worktreePath"]!;
            var arguments = ToolDefinitions.Parse(call.Name, call.Arguments);
            switch (call.Name)
            {
                case "list_directory": return Result(JsJson.Stringify(repositories.ListFiles(worktree, (string)arguments["path"]!))!);
                case "read_file": return Result(JsJson.Stringify(repositories.ReadFile(worktree, (string)arguments["path"]!))!);
                case "search_text": return Result(await repositories.Search(worktree, (string)arguments["query"]!, (string)arguments["path"]!));
            }
            var common = new Dictionary<string, object?>
            {
                ["id"] = id().ToString(), ["taskId"] = task["id"], ["toolCallId"] = call.Id, ["nonce"] = id().ToString(), ["tool"] = call.Name, ["state"] = "awaiting-approval",
                ["createdAt"] = Clock.Iso(now()),
            };
            PreparedEdit? edit = null;
            if (call.Name == "run_command")
            {
                var environment = ((Dictionary<string, object?>)arguments["environment"]!).Select(entry => KeyValuePair.Create(entry.Key, (string)entry.Value!)).ToList();
                command = await commands.Prepare(worktree, new((string)arguments["command"]!, (string)arguments["cwd"]!, environment, (double)arguments["timeoutMs"]!));
                AssertNoSecrets(JsJson.Stringify(command)!);
                approval = new(common) { ["summary"] = "Run this exact PowerShell command with your Windows privileges." };
                foreach (var (key, value) in command.ToWire()) approval[key] = value;
            }
            else
            {
                var path = (string)arguments["path"]!; var expectedHash = (string)arguments["expectedHash"]!;
                string after;
                if (call.Name == "write_file") after = (string)arguments["content"]!;
                else
                {
                    var oldText = (string)arguments["oldText"]!;
                    var file = repositories.ReadFile(worktree, path);
                    if (!Equals(file["hash"], expectedHash)) throw new WorkspaceReadException("File changed since it was read. Read it again before proposing an edit.");
                    var content = (string)file["content"]!;
                    if (Occurrences(content, oldText) != 1) throw new WorkspaceReadException("oldText must occur exactly once in the file.");
                    var at = content.IndexOf(oldText, StringComparison.Ordinal);
                    after = string.Concat(content.AsSpan(0, at), (string)arguments["newText"]!, content.AsSpan(at + oldText.Length));
                }
                edit = repositories.PrepareEdit(worktree, path, expectedHash, after);
                AssertNoSecrets(edit.Before); AssertNoSecrets(edit.After);
                approval = new(common)
                {
                    ["summary"] = $"Edit {edit.Path}", ["path"] = edit.Path, ["before"] = edit.Before, ["after"] = edit.After, ["expectedHash"] = edit.ExpectedHash,
                    ["resultingHash"] = edit.ResultingHash, ["fingerprint"] = edit.Fingerprint,
                };
            }
            if (!await RequestApproval(approval, token))
                return Result(token.IsCancellationRequested ? "Action cancelled before execution." : "User rejected this action. Do not repeat this proposal without new user instructions.", true);
            token.ThrowIfCancellationRequested();
            var approved = approval;
            await slots.Use(async () =>
            {
                // The executing intent is durable before any repository or process mutation.
                approved["state"] = "executing"; Save(approved);
                if (edit is not null)
                {
                    repositories.ApplyEdit(edit);
                    approved["state"] = "complete";
                    approved["result"] = new Dictionary<string, object?> { ["content"] = JsJson.Stringify(new Dictionary<string, object?> { ["path"] = edit.Path, ["hash"] = edit.ResultingHash, ["applied"] = true }), ["isError"] = false };
                }
                else
                {
                    var executed = await commands.Execute(command!, token);
                    loop.AssertCurrent();
                    approved["state"] = executed.CleanupVerified ? executed.ExitCode == 0 && !executed.Cancelled && !executed.TimedOut ? "complete" : "failed" : "unknown";
                    var result = new Dictionary<string, object?> { ["content"] = redactor.Text(JsJson.Stringify(executed)!), ["isError"] = !Equals(approved["state"], "complete"), ["cleanupVerified"] = executed.CleanupVerified };
                    if (executed.ExitCode is long code) result["exitCode"] = code;
                    approved["result"] = result;
                }
            }, token);
            Save(approval);
            var outcome = (Dictionary<string, object?>)approval["result"]!;
            return Result((string)outcome["content"]!, (bool)outcome["isError"]!);
        }
        catch (Exception error)
        {
            loop.AssertCurrent();
            var message = error switch
            {
                OperationCanceledException => Aborted,
                WorkspaceReadException or RepositoryException or CommandPreflightException or ToolArgumentException => error.Message,
                _ => null,
            };
            var content = redactor.Text(message ?? "Tool failed.");
            if (approval is not null)
            {
                var knownUnstarted = error is CommandPreflightException or RepositoryException { Outcome: "none" };
                var state = approval["state"] as string;
                approval["state"] = state == "executing" && !knownUnstarted ? "unknown"
                    : state is "complete" or "failed" or "unknown" ? state
                    : token.IsCancellationRequested ? "revoked"
                    : state == "rejected" ? "rejected" : "failed";
                var result = new Dictionary<string, object?> { ["content"] = content, ["isError"] = true };
                if (Present(approval, "command")) result["cleanupVerified"] = false;
                approval["result"] = result;
                Save(approval);
            }
            if (message is null) throw;
            return Result(content, true);
        }
        finally
        {
            if (command is not null) commands.Discard(command);
        }
    }

    /// <summary>
    /// awaitDecision: the proposal is saved, then waits for its decision without holding an execution slot. Cancelling the
    /// wait revokes it, unless a decision was recorded first; that decision then stands, and the caller's next cancellation
    /// check revokes an approval that has not started. TypeScript's abort listener revokes synchronously; here the revoke
    /// runs on the loop when the wait resumes, and until then <see cref="Decide"/> treats the cancelled wait as stale.
    /// </summary>
    internal async Task<bool> RequestApproval(Dictionary<string, object?> approval, CancellationToken token)
    {
        loop.AssertCurrent();
        token.ThrowIfCancellationRequested();
        var approvalId = (string)approval["id"]!;
        Save(approval);
        var decision = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        waiting[approvalId] = new((string)approval["taskId"]!, decision, token);
        using (token.Register(() => cancelled.TrySetResult()))
            await Task.WhenAny(decision.Task, cancelled.Task);
        loop.AssertCurrent();
        if (decision.Task.IsCompleted) return await decision.Task;
        if (waiting.Remove(approvalId)) { approval["state"] = "revoked"; Save(approval); }
        return false;
    }

    /// <summary>
    /// decide: the user's one-shot decision on a waiting proposal of this task, with its nonce. A coordinated approval needs
    /// its bound decision. The stored approval is decided and saved; the waiting call continues with its own copy.
    /// </summary>
    internal Dictionary<string, object?> Decide(string taskId, string approvalId, string nonce, string decision)
    {
        loop.AssertCurrent();
        var approval = store.Approval(approvalId);
        if (Present(approval, "rootTaskId")) throw new WorkspaceReadException("This approval belongs to a coordinated task and requires its bound decision.");
        var waiter = waiting.GetValueOrDefault(approvalId);
        if (!Equals(approval.GetValueOrDefault("taskId"), taskId) || !Equals(approval.GetValueOrDefault("nonce"), nonce) || !Equals(approval["state"], "awaiting-approval") || waiter?.TaskId != taskId
            || waiter.Cancellation.IsCancellationRequested)
            throw new WorkspaceReadException("This approval is stale or does not match the active task.");
        approval["state"] = decision == "approve" ? "approved" : "rejected";
        Save(approval); waiting.Remove(approvalId); waiter.Decision.TrySetResult(decision == "approve");
        return new() { ["accepted"] = true };
    }

    /// <summary>revokeWaiting: every waiting decision of a task is revoked, as scoped cancellation does.</summary>
    internal void RevokeWaiting(string taskId)
    {
        loop.AssertCurrent();
        foreach (var (approvalId, waiter) in waiting.ToArray())
        {
            if (waiter.TaskId != taskId) continue;
            var approval = store.Approval(approvalId);
            if (Equals(approval["state"], "awaiting-approval")) { approval["state"] = "revoked"; Save(approval); }
            waiting.Remove(approvalId); waiter.Decision.TrySetResult(false);
        }
    }

    private void AssertNoSecrets(string value) { if (redactor.Text(value) != value) throw new WorkspaceReadException(SecretContent); }

    /// <summary>text.split(search).length - 1: occurrences found left to right, never overlapping.</summary>
    private static int Occurrences(string text, string search)
    {
        var count = 0;
        for (var at = text.IndexOf(search, StringComparison.Ordinal); at >= 0; at = text.IndexOf(search, at + search.Length, StringComparison.Ordinal)) count++;
        return count;
    }

    /// <summary>
    /// reconcile: an unknown outcome of this task is checked without replaying anything. An edit is compared, by hash, with
    /// the file in the task's worktree: the approved content completes it, the original content fails it, anything else
    /// (or a file that cannot be read safely) leaves it unknown. Command, external tool, browser and orchestration outcomes
    /// cannot be reconstructed here, so they stay unknown with guidance. The approval is saved with its approval.changed
    /// event as service.ts records it: before schema v5 always; from v5 when the state changed, or when the task has no
    /// such event yet (its publish falls back to recording one). The outcome is returned as approval.get shows it: redacted,
    /// and a bounded preview above 128 KiB.
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
        // The state is already saved, so a refusal here would misreport a check that happened: when redaction leaves the
        // document unparseable, the identity and outcome are still reported, each text redacted on its own.
        try { return (Dictionary<string, object?>)store.ApprovalRead(taskId, approvalId, redactor)["approval"]!; }
        catch (WorkspaceReadException) { return Outcome(approval); }
    }

    /// <summary>
    /// tool-runtime.ts reconcile's fallback: identity, state, summary, fingerprint and outcome, every text field redacted on
    /// its own (the state is the runtime's own value). A field the document lacks stays absent.
    /// </summary>
    private Dictionary<string, object?> Outcome(Dictionary<string, object?> approval)
    {
        var value = new Dictionary<string, object?>();
        foreach (var key in new[] { "id", "taskId", "toolCallId", "nonce", "tool", "state", "createdAt", "summary", "fingerprint" })
            if (approval.TryGetValue(key, out var field)) value[key] = key == "state" ? field : Text(field);
        if (approval.GetValueOrDefault("result") is Dictionary<string, object?> result)
            value["result"] = new Dictionary<string, object?>(result) { ["content"] = Text(result["content"]) };
        return value;
    }

    private object? Text(object? field) => field is string text ? redactor.Text(text) : field;

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
