using System.Globalization;
using System.Text;
using Foundry.Platform;
using Foundry.Protocol;
using Foundry.Providers;

namespace Foundry.Runtime;

/// <summary>Development-only ordinary projectless fake chat. No repository, command, browser or external-provider authority.</summary>
public sealed class DevelopmentChat
{
    private sealed class Running : IDisposable
    {
        internal readonly CancellationTokenSource Abort = new();
        internal readonly TaskCompletionSource Started = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal Task Done = Task.CompletedTask;
        public void Dispose() => Abort.Dispose();
    }
    private readonly RuntimeLoop loop;
    private readonly Store store;
    private readonly Redactor redactor = new();
    private readonly Func<DateTimeOffset> now;
    private readonly Func<Guid> id;
    private readonly Func<IReadOnlyList<ProviderMessage>, ProviderContinuation?, CancellationToken, IAsyncEnumerable<ProviderChatEvent>> stream;
    private readonly RepositoryService repositories;
    private readonly ToolRuntime tools;
    private readonly Dictionary<string, Running> running = new(StringComparer.Ordinal);
    private readonly HashSet<string> publishing = new(StringComparer.Ordinal);
    private readonly HashSet<string> retiring = new(StringComparer.Ordinal);
    private readonly Dictionary<string, (string Hash, Task<Dictionary<string, object?>> Work)> starts = new(StringComparer.Ordinal);
    private readonly List<TaskCompletionSource> slotWaiters = [];
    private readonly TaskCompletionSource failure = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private Exception? backgroundFailure;
    private int activeSlots;
    private bool closing;
    public Task Failure => failure.Task;
    /// <summary>The repository service, for tests that observe or interrupt its Git launches.</summary>
    internal RepositoryService Repositories => repositories;

    public DevelopmentChat(RuntimeLoop loop, Store store, Func<DateTimeOffset>? now = null, Func<Guid>? id = null)
        : this(loop, store, (messages, continuation, token) => new FakeChatProvider().StreamTurn(messages, continuation, token), now, id) { }

    /// <summary>Tests supply the environment Git inherits, so fixtures never read the machine's Git configuration.</summary>
    internal DevelopmentChat(RuntimeLoop loop, Store store, Func<IReadOnlyDictionary<string, string>> gitEnvironment)
        : this(loop, store, (messages, continuation, token) => new FakeChatProvider().StreamTurn(messages, continuation, token), gitEnvironment: gitEnvironment) { }

    internal DevelopmentChat(RuntimeLoop loop, Store store,
        Func<IReadOnlyList<ProviderMessage>, ProviderContinuation?, CancellationToken, IAsyncEnumerable<ProviderChatEvent>> stream,
        Func<DateTimeOffset>? now = null, Func<Guid>? id = null, Func<IReadOnlyDictionary<string, string>>? gitEnvironment = null)
    {
        loop.AssertCurrent();
        this.loop = loop; this.store = store; this.stream = stream; this.now = now ?? (() => DateTimeOffset.UtcNow); this.id = id ?? Guid.NewGuid;
        repositories = new RepositoryService(loop, Path.Join(store.DataDirectory, "wt"), gitEnvironment);
        tools = new ToolRuntime(loop, store, repositories, redactor);
    }

    // Only notifications selected by the shipping ordinary-chat service are sent.
    // Other durable Store events remain retrievable; sequence gaps are expected.
    // A retirement records two task.retired events, as TypeScript does: the status transition saveTask records, which
    // TypeScript keeps silent, and the explicit event workspace-operations publishes with its removed-worktree count.
    public static bool SendsNotification(WorkspaceEvent item) => item.Type is "tasks.changed" or "task.started" or "task.completed" or "task.stopped"
        or "usage.changed" or "features.changed" or "projects.changed" or "preferences.changed" or "task.progress" or "task.context-warning" or "task.budget-warning"
        or "task.committed" or "task.pushed" or "approval.changed"
        || item.Type == "task.retired" && item.Data is IDictionary<string, object?> data && data.ContainsKey("removedWorktrees");

    public async Task<object?> Dispatch(string method, Dictionary<string, object?> parameters)
    {
        loop.AssertCurrent();
        if (closing) throw new InvalidOperationException("Runtime is shutting down.");
        try
        {
        switch (method)
        {
            case "workspace.summary": return store.Summary();
            case "workspace.schema": return new Dictionary<string, object?> { ["version"] = store.SchemaVersion, ["current"] = 5, ["upgradeRequired"] = store.SchemaVersion < 5, ["coordinatedAvailable"] = false };
            case "project.update": return store.UpdateProject(parameters);
            case "workspace.preferences.save": return store.UpdatePreferences(parameters);
            case "workspace.profiles": return store.ProfilePage((string?)parameters.GetValueOrDefault("after"), Integer(parameters, "limit", 50));
            case "workspace.projects": return store.ProjectPage((string?)parameters.GetValueOrDefault("after"), Integer(parameters, "limit", 50));
            case "profile.read": return store.ProfileRead((string)parameters["profileId"]!);
            case "workspace.tasks": return store.TaskPage(parameters);
            case "workspace.events": return store.EventPage(Ordinal(parameters, "after") ?? 0, Integer(parameters, "limit", 50), (string?)parameters.GetValueOrDefault("taskId"), redactor);
            case "workspace.actions": return store.ActionPage(parameters, redactor);
            case "workspace.search": return store.SearchPage(parameters, redactor);
            case "workspace.usageTrend": return store.UsageTrend(parameters);
            case "task.timeline": return store.TimelinePage((string)parameters["taskId"]!, Ordinal(parameters, "before"), Integer(parameters, "limit", 50), redactor);
            case "task.usageRecords": return store.UsageRecordPage((string)parameters["taskId"]!, Ordinal(parameters, "before"), Integer(parameters, "limit", 50), redactor);
            case "task.compactions": return store.CompactionPage((string)parameters["taskId"]!, Ordinal(parameters, "before"), Integer(parameters, "limit", 50), redactor);
            case "task.compactionContent": return store.CompactionContent((string)parameters["taskId"]!, (string)parameters["compactionId"]!, Ordinal(parameters, "offset") ?? 0, Integer(parameters, "maxBytes", 65536), redactor);
            case "features.get": return store.FeatureSnapshot();
            case "features.set":
                var feature = store.SetFeature(parameters);
                store.Event("features.changed", new Dictionary<string, object?> { ["feature"] = feature["feature"], ["enabled"] = feature["enabled"] });
                return feature;
            case "task.setArchived":
                var archiving = (bool)parameters["archived"]!;
                if (archiving && Equals(store.FeatureState("archive")["enabled"], false)) throw new WorkspaceReadException("Archive admission is paused. Restore and pending-work access remain available.");
                var archivedTask = store.SetArchived((string)parameters["taskId"]!, archiving);
                store.Event("tasks.changed", new Dictionary<string, object?>(), (string)parameters["taskId"]!);
                return archivedTask;
            case "task.start": return await Start(parameters);
            case "task.send":
                var sending = StartTurn((string)parameters["taskId"]!, (string)parameters["content"]!);
                // Acknowledge after the admitted run reaches its first execution turn;
                // this is an observed readiness signal, not a speculative yield.
                await sending.Started.Task;
                return new Dictionary<string, object?> { ["accepted"] = true };
            case "task.cancel":
                var task = store.ReadTask((string)parameters["taskId"]!); RequireOrdinary(task);
                var present = running.TryGetValue((string)task["id"]!, out var entry); entry?.Abort.Cancel();
                return new Dictionary<string, object?> { ["accepted"] = present };
            case "task.read": return store.TaskRead((string)parameters["taskId"]!);
            case "task.approvals": return store.ApprovalPage((string)parameters["taskId"]!, Integer(parameters, "limit", 50), Ordinal(parameters, "before"));
            case "approval.get": return store.ApprovalRead((string)parameters["taskId"]!, (string)parameters["approvalId"]!, redactor);
            case "approval.content":
                return store.ApprovalContent((string)parameters["taskId"]!, (string)parameters["approvalId"]!, (string)parameters["field"]!, Ordinal(parameters, "offset") ?? 0, Integer(parameters, "maxBytes", 32 * 1024), redactor);
            case "approval.reconcile": return tools.Reconcile((string)parameters["taskId"]!, (string)parameters["approvalId"]!);
            case "task.messages": return store.MessagePage((string)parameters["taskId"]!, Integer(parameters, "limit", 50), Ordinal(parameters, "before"), Ordinal(parameters, "through"), redactor);
            case "task.messageContent": return store.MessageContent((string)parameters["taskId"]!, (string)parameters["messageId"]!, Ordinal(parameters, "offset") ?? 0, Integer(parameters, "maxBytes", 65536), redactor);
            case "project.add": return await Repository(async () => await AddProject((string)parameters["path"]!));
            case "task.create": return await Repository(async () => await CreateTask(parameters));
            case "task.commit": return await Repository(async () => await Commit((string)parameters["taskId"]!, (string)parameters["message"]!));
            case "task.push": return await Repository(async () => await Push((string)parameters["taskId"]!, (string?)parameters.GetValueOrDefault("remote") ?? "origin"));
            case "task.reconcilePublication": return await Repository(async () => await ReconcilePublication((string)parameters["taskId"]!));
            case "task.retire": return await Repository(async () => await Retire((string)parameters["taskId"]!));
            case "files.list":
                return await Repository(() =>
                {
                    using var held = FileRoot(store.ReadTask((string)parameters["taskId"]!), out var root);
                    return Task.FromResult<object?>(repositories.ListFiles(root, (string?)parameters.GetValueOrDefault("path") ?? ""));
                });
            case "files.read":
                return await Repository(() =>
                {
                    using var held = FileRoot(store.ReadTask((string)parameters["taskId"]!), out var root);
                    var file = repositories.ReadFile(root, (string)parameters["path"]!);
                    file["content"] = redactor.Text((string)file["content"]!);
                    return Task.FromResult<object?>(file);
                });
            case "task.diff":
                return await Repository(async () =>
                {
                    var diff = await repositories.Diff((string)store.ReadGitTask((string)parameters["taskId"]!)["worktreePath"]!);
                    diff["patch"] = redactor.Text((string)diff["patch"]!); diff["summary"] = redactor.Text((string)diff["summary"]!);
                    return diff;
                });
            default: throw new NotSupportedException("This operation is not implemented in the P2 development chat runtime.");
        }
        }
        catch (EventDeliveryException error) { Fail(error); throw; }
    }

    /// <summary>
    /// Repository failures reach the caller as TypeScript's entry reports every handler error: the message, redacted, with
    /// the runtime still serving. That includes a filesystem or argument failure, which must never stop the runtime.
    /// </summary>
    private async Task<object?> Repository(Func<Task<object?>> operation)
    {
        try { return await operation(); }
        catch (Exception error) when (error is InvalidOperationException or ArgumentException or IOException or UnauthorizedAccessException)
        {
            throw new WorkspaceReadException(redactor.Text(error.Message));
        }
    }

    /// <summary>
    /// service.ts project.add. The folder stays pinned from its first resolution to the saved row, so classification and
    /// the final checks see the same physical folder; the requested spelling must still name that folder (by identity), and
    /// the Git identity read before classification must be unchanged. The row and its notification commit together.
    /// </summary>
    private async Task<Dictionary<string, object?>> AddProject(string raw)
    {
        store.RequireProjects();
        if (!RepositoryPaths.IsNodeAbsolute(raw)) throw new WorkspaceReadException("Select an absolute folder path.");
        // Before any canonicalization or probe: touching a network path makes Windows authenticate to its server.
        if (NetworkPathPolicy.IsNetworkOrDevicePath(raw)) throw new WorkspaceReadException(RepositoryFolderLease.Network);
        using var folder = RepositoryFolderLease.Open(loop, raw, "Select a folder.");
        var path = folder.Path;
        if (store.ProjectByPath(path) is { } previous) return previous;
        using var identity = RepositoryAdmission.Open(loop, path);
        var kind = await repositories.IsGitWorkingTree(path) ? "git" : "folder";
        if (!RepositoryPaths.SameFolder(raw, path)) throw new WorkspaceReadException("The saved folder now resolves to a different location.");
        identity.Revalidate();
        return store.Transaction(() =>
        {
            var project = store.ProjectByPath(path) ?? store.InsertProject(path, kind);
            store.Event("projects.changed", new Dictionary<string, object?> { ["projectId"] = project["id"] });
            return project;
        });
    }

    /// <summary>
    /// service.ts task.create: a Git task with its own app-owned worktree. Every refusal happens before the durable
    /// worktree.create intent; the intent is written before any Git mutation; the task, its project, its channel binding,
    /// the completed intent and the tasks.changed notification commit together. A failure leaves the intent complete only
    /// when the repository reported that no mutation started; otherwise it is unknown, and it blocks every later creation
    /// until someone inspects the retained worktree. Coordinated tasks need the orchestrator, which this runtime lacks.
    /// </summary>
    private async Task<Dictionary<string, object?>> CreateTask(Dictionary<string, object?> parameters)
    {
        var projectPath = (string)parameters["projectPath"]!;
        var mode = (string?)parameters.GetValueOrDefault("mode") ?? "chat";
        // Before any canonicalization or probe: touching a network path makes Windows authenticate to its server.
        if (NetworkPathPolicy.IsNetworkOrDevicePath(projectPath)) throw new WorkspaceReadException(RepositoryFolderLease.Network);
        using (RepositoryFolderLease.Open(loop, projectPath)) { }
        var selected = store.Profile((string)parameters["profileId"]!) ?? throw new InvalidOperationException("Select an existing model profile.");
        if (mode != "coordinated" && parameters.ContainsKey("coordination")) throw new WorkspaceReadException("Coordination settings apply only to coordinated tasks.");
        if (mode == "coordinated") throw new WorkspaceReadException("Coordinated tasks are not available in this build.");
        if (mode == "coding" && !ProfileReady(selected)) throw new WorkspaceReadException("Probe tool and continuation capabilities before creating a coding task.");
        if (store.UnknownWorktreeIntents() > 0)
            throw new WorkspaceReadException("An earlier worktree creation has an unknown outcome. Inspect the retained worktree and database intent before creating another task.");
        using var channel = RepositoryAdmission.Open(loop, projectPath);
        var identity = channel.Identity ?? throw new WorkspaceReadException(RepositoryService.NoRepository);
        var taskId = id().ToString();
        var intent = store.Intent("worktree.create", new Dictionary<string, object?> { ["taskId"] = taskId, ["projectPath"] = projectPath });
        try
        {
            var worktree = await repositories.CreateTaskWorktree(projectPath, taskId, identity);
            var stamp = Clock.Iso(now());
            return store.Transaction(() =>
            {
                string? projectId = null;
                if (store.SchemaVersion >= 3)
                {
                    var project = store.ProjectByPath(projectPath) ?? store.InsertProject(FinalPath.Canonical(projectPath), "git");
                    if (!Equals(project["kind"], "git")) store.SaveProject(new(project) { ["kind"] = "git" });
                    projectId = (string)project["id"]!;
                }
                var task = new Dictionary<string, object?> { ["id"] = taskId, ["title"] = redactor.Text((string)parameters["title"]!), ["workspaceKind"] = "git" };
                if (projectId is not null) task["projectId"] = projectId;
                task["projectPath"] = projectPath; task["worktreePath"] = worktree.WorktreePath; task["branch"] = worktree.Branch; task["baseCommit"] = worktree.BaseCommit;
                task["profileId"] = parameters["profileId"]; task["status"] = "idle"; task["createdAt"] = stamp; task["updatedAt"] = stamp;
                task["tokenBudget"] = parameters.GetValueOrDefault("tokenBudget") ?? 100000; task["usedTokens"] = 0; task["mode"] = mode;
                store.SaveTask(task);
                // agent-channel admit: the project still resolves to the identity admitted before the worktree was made.
                channel.Revalidate(identity);
                var binding = store.Intent("channel.identity", new Dictionary<string, object?>
                {
                    ["taskId"] = taskId,
                    ["identity"] = new Dictionary<string, object?> { ["path"] = identity.Path, ["root"] = identity.Root, ["gitDirectory"] = identity.GitDirectory, ["common"] = identity.Common },
                });
                store.FinishIntent(binding, "complete");
                store.FinishIntent(intent, "complete");
                store.Event("tasks.changed", new Dictionary<string, object?>(), taskId);
                return task;
            });
        }
        catch (Exception error) when (error is not EventDeliveryException)
        {
            store.FinishIntent(intent, error is RepositoryException { Outcome: "none" } ? "complete" : "unknown");
            throw;
        }
    }

    // ---------------------------------------------------------------- explicit Git actions (workspace-operations.ts)

    /// <summary>publishable: a ready chat or coding Git task with no unknown mutation, publication or retirement outcome.</summary>
    private Dictionary<string, object?> Publishable(string taskId)
    {
        var task = store.ReadGitTask(taskId);
        if (running.ContainsKey(taskId) || Equals(task["status"], "running")) throw new WorkspaceReadException("Wait for the active response to finish or cancel it first.");
        if (Equals(task["status"], "retired")) throw new WorkspaceReadException("This task worktree is retired.");
        if (Truthy(task.GetValueOrDefault("parentTaskId")) || Equals(task.GetValueOrDefault("role"), "child"))
            throw new WorkspaceReadException("Child agent worktrees are published only through reviewed handoff commits and coordinator integration.");
        if (Equals(task.GetValueOrDefault("mode"), "coordinated"))
            throw new WorkspaceReadException("Coordinated task worktrees are integrated through reviewed operations; commit and push are available for chat and coding tasks.");
        if (store.HasUnknownApproval(taskId)) throw new WorkspaceReadException("This task has an unknown mutation outcome. Check the outcome and inspect its worktree before publishing.");
        if (store.UnknownPublicationIntents(taskId) is [var unknown, ..])
            throw new WorkspaceReadException($"This task has an unknown {unknown.Kind} outcome. Reconcile publication state before attempting another operation.");
        if (store.UnknownRetireIntents(taskId).Count > 0) throw new WorkspaceReadException("This task has an unknown worktree retirement outcome. Reconcile state before attempting another operation.");
        // Not in TypeScript: a retirement that removes the worktree mid-commit would leave an outcome nothing can verify.
        if (retiring.Contains(taskId)) throw new WorkspaceReadException("Worktree retirement is already in progress for this task.");
        return task;
    }

    private void BeginPublishing(string taskId)
    {
        if (!publishing.Add(taskId)) throw new WorkspaceReadException("A Git operation is already in progress for this task.");
    }

    /// <summary>Intent first; a failure is complete only when the repository reported that no mutation started.</summary>
    private void FinishFailed(string intent, Exception error) => store.FinishIntent(intent, error is RepositoryException { Outcome: "none" } ? "complete" : "unknown");

    private async Task<Dictionary<string, object?>> Commit(string taskId, string message)
    {
        var task = Publishable(taskId);
        BeginPublishing(taskId);
        try
        {
            var clean = redactor.Text(message);
            if (clean != message) throw new WorkspaceReadException("The commit message contains secret-like content.");
            var worktree = (string)task["worktreePath"]!; var branch = (string)task["branch"]!;
            var baseCommit = await repositories.HeadCommit(worktree);
            var intent = store.Intent("git.commit", new Dictionary<string, object?> { ["taskId"] = taskId, ["branch"] = branch, ["baseCommit"] = baseCommit, ["message"] = clean });
            try
            {
                var result = await repositories.CommitAll(worktree, (string)task["projectPath"]!, store.BoundCommon(taskId), branch, clean);
                store.Transaction(() =>
                {
                    store.FinishIntent(intent, "complete");
                    store.SaveTask(new(store.ReadTask(taskId)) { ["updatedAt"] = Clock.Iso(now()) });
                    store.Event("task.committed", new Dictionary<string, object?> { ["commit"] = result.Commit, ["changedPaths"] = result.ChangedPaths.Count }, taskId);
                    return 0;
                });
                return new() { ["commit"] = result.Commit, ["changedPaths"] = result.ChangedPaths, ["branch"] = branch };
            }
            catch (Exception error) when (error is not EventDeliveryException) { FinishFailed(intent, error); throw; }
        }
        finally { publishing.Remove(taskId); }
    }

    private async Task<Dictionary<string, object?>> Push(string taskId, string remote)
    {
        var task = Publishable(taskId);
        BeginPublishing(taskId);
        try
        {
            var worktree = (string)task["worktreePath"]!; var branch = (string)task["branch"]!;
            var commit = await repositories.HeadCommit(worktree);
            var intent = store.Intent("git.push", new Dictionary<string, object?> { ["taskId"] = taskId, ["branch"] = branch, ["remote"] = remote, ["commit"] = commit });
            try
            {
                var detail = await repositories.Push(worktree, (string)task["projectPath"]!, store.BoundCommon(taskId), remote, branch);
                store.Transaction(() =>
                {
                    store.FinishIntent(intent, "complete");
                    store.Event("task.pushed", new Dictionary<string, object?> { ["remote"] = remote, ["branch"] = branch }, taskId);
                    return 0;
                });
                return new() { ["remote"] = remote, ["branch"] = branch, ["detail"] = redactor.Text(detail) };
            }
            catch (Exception error) when (error is not EventDeliveryException) { FinishFailed(intent, error); throw; }
        }
        finally { publishing.Remove(taskId); }
    }

    /// <summary>
    /// reconcilePublication: each unknown push is checked against the remote and each unknown commit against the worktree;
    /// one that cannot be established stays unknown. An unknown retirement is complete when no listed worktree remains and
    /// failed otherwise. A listed worktree on a network path is never probed and counts as remaining.
    /// </summary>
    private async Task<Dictionary<string, object?>> ReconcilePublication(string taskId)
    {
        var task = store.ReadGitTask(taskId);
        BeginPublishing(taskId);
        try
        {
            var unknowns = store.UnknownPublicationIntents(taskId);
            var retirements = store.UnknownRetireIntents(taskId);
            if (unknowns.Count == 0 && retirements.Count == 0) return new() { ["reconciled"] = true, ["detail"] = "No unknown publication or retirement intents." };
            var resolved = 0; var unresolved = 0;
            foreach (var item in unknowns)
            {
                bool? succeeded;
                var bound = store.BoundCommon(taskId);
                if (item.Kind == "git.push")
                    succeeded = await repositories.VerifyPushOutcome((string)task["projectPath"]!, (string)task["worktreePath"]!, bound,
                        item.Data.GetValueOrDefault("remote") as string ?? "", item.Data.GetValueOrDefault("branch") as string ?? "", item.Data.GetValueOrDefault("commit") as string);
                else
                    succeeded = await repositories.VerifyCommitOutcome((string)task["worktreePath"]!, (string)task["projectPath"]!, bound,
                        item.Data.GetValueOrDefault("baseCommit") as string, item.Data.GetValueOrDefault("message") as string);
                if (succeeded is not { } known) { unresolved++; continue; }
                store.ClearPublicationIntent(item.Id, known ? "complete" : "failed");
                resolved++;
            }
            foreach (var item in retirements)
            {
                var worktrees = item.Data.GetValueOrDefault("worktrees") is List<object?> listed ? listed.OfType<string>().ToList() : [(string)task["worktreePath"]!];
                var remaining = worktrees.Any(worktree => NetworkPathPolicy.IsNetworkOrDevicePath(worktree) || !DataClassifier.IsLocal(FinalPath.Resolve(worktree)) || Present(worktree));
                store.ClearRetireIntent(item.Id, remaining ? "failed" : "complete");
                resolved++;
            }
            return new()
            {
                ["reconciled"] = unresolved == 0,
                ["detail"] = unresolved > 0 ? $"Reconciled {resolved} intent(s); {unresolved} push intent(s) could not be verified against the remote." : $"Reconciled {resolved} intent(s).",
            };
        }
        finally { publishing.Remove(taskId); }

        static bool Present(string path)
        {
            try { return MetadataFile.Probe(FinalPath.Resolve(path)) is not MetadataEntryKind.Missing; }
            catch (IOException) { return false; }
        }
    }

    /// <summary>
    /// retire: remove the task worktree only when Git proves it holds no uncommitted or untracked files; the branch and
    /// every record remain. Coordinated tasks retire their children with them, which needs the orchestrator, a later slice.
    /// </summary>
    private async Task<Dictionary<string, object?>> Retire(string taskId)
    {
        var task = store.ReadGitTask(taskId);
        if (running.ContainsKey(taskId) || Equals(task["status"], "running")) throw new WorkspaceReadException("Wait for the active response to finish or cancel it before retiring the worktree.");
        if (Equals(task["status"], "retired")) throw new WorkspaceReadException("This task worktree is already retired.");
        if (Truthy(task.GetValueOrDefault("parentTaskId")) || Equals(task.GetValueOrDefault("role"), "child"))
            throw new WorkspaceReadException("Retire a child worktree from its coordinated task; children are retired together with their root.");
        if (Equals(task.GetValueOrDefault("mode"), "coordinated")) throw new WorkspaceReadException("Coordinated tasks are not available in this build.");
        // Not in TypeScript: a commit, push or reconciliation in flight must settle before its worktree can go.
        if (publishing.Contains(taskId)) throw new WorkspaceReadException("A Git operation is already in progress for this task.");
        if (!retiring.Add(taskId)) throw new WorkspaceReadException("Worktree retirement is already in progress for this task.");
        try
        {
            if (store.HasUnknownApproval(taskId) || store.UnknownPublicationIntents(taskId).Count > 0 || store.UnknownRetireIntents(taskId).Count > 0)
                throw new WorkspaceReadException("This task has an unknown mutation outcome. Inspect the worktree before retiring it.");
            var worktree = (string)task["worktreePath"]!;
            // Saved before decision 8, a worktree on a share is never probed.
            if (NetworkPathPolicy.IsNetworkOrDevicePath(worktree)) throw new WorkspaceReadException(RepositoryFolderLease.Network);
            var present = new List<string>();
            MetadataEntryKind kind;
            try { kind = DataClassifier.IsLocal(FinalPath.Resolve(worktree)) ? MetadataFile.Probe(FinalPath.Resolve(worktree)) : MetadataEntryKind.Missing; }
            catch (IOException) { kind = MetadataEntryKind.Missing; }
            // Every worktree is checked read-only before any removal starts; a dirty one refuses the whole retirement.
            if (kind is MetadataEntryKind.Directory or MetadataEntryKind.Reparse)
            {
                var dirty = await repositories.UncommittedPaths(worktree);
                if (dirty.Count > 0)
                    throw new WorkspaceReadException($"Worktree {worktree} has uncommitted or untracked files ({string.Join(", ", dirty.Take(10))}{(dirty.Count > 10 ? ", …" : "")}). Commit, publish or discard them yourself before retiring; nothing was deleted.");
                present.Add(worktree);
            }
            var intent = store.Intent("worktree.retire", new Dictionary<string, object?> { ["taskId"] = taskId, ["worktrees"] = present });
            var removed = new List<string>();
            try
            {
                foreach (var member in present)
                {
                    await repositories.RemoveWorktree((string)task["projectPath"]!, member);
                    removed.Add(member);
                }
                var stamp = Clock.Iso(now());
                store.Transaction(() =>
                {
                    store.SaveTask(new(store.ReadTask(taskId)) { ["status"] = "retired", ["retiredAt"] = stamp, ["updatedAt"] = stamp });
                    store.FinishIntent(intent, "complete");
                    store.Event("task.retired", new Dictionary<string, object?> { ["removedWorktrees"] = removed.Count }, taskId);
                    return 0;
                });
                return new() { ["taskId"] = taskId, ["branch"] = task["branch"], ["removedWorktrees"] = removed };
            }
            catch (Exception error) when (error is not EventDeliveryException)
            {
                store.FinishIntent(intent, removed.Count > 0 || error is not RepositoryException { Outcome: "none" } ? "unknown" : "complete");
                throw;
            }
        }
        finally { retiring.Remove(taskId); }
    }

    private static bool Truthy(object? value) => value is not (null or false or "" or 0 or 0L or 0d);

    /// <summary>service.ts profileReady: the fake profile, or a probe of this exact configuration that found tools and continuation.</summary>
    private static bool ProfileReady(Dictionary<string, object?> profile) =>
        Equals(profile.GetValueOrDefault("apiKind"), "fake")
        || Equals(profile.GetValueOrDefault("verificationFingerprint"), Compatibility.ProfileFingerprint(profile))
            && profile.GetValueOrDefault("capabilities") is Dictionary<string, object?> capabilities
            && Equals(capabilities.GetValueOrDefault("tools"), true) && Equals(capabilities.GetValueOrDefault("continuation"), true);

    /// <summary>
    /// service.ts fileRoot: a Git task's worktree, or a saved folder that still resolves to the same physical folder under
    /// the exact spelling it was saved with. The saved spelling is both the candidate and the approved path, and the folder
    /// lease refuses every reparse point on the way, so the only remaining check is that the real path keeps that spelling.
    /// Since #33, TypeScript's resolveLocalPath admits a short (8.3) spelling of the same folder, and this same check then
    /// refuses it in both runtimes, with the same message.
    /// </summary>
    /// <returns>For a folder task, the lease that keeps the checked folder pinned while the caller reads it.</returns>
    private RepositoryFolderLease? FileRoot(Dictionary<string, object?> task, out string root)
    {
        if (Store.IsGitDocument(task)) { root = (string)task["worktreePath"]!; return null; }
        if (!Equals(task.GetValueOrDefault("workspaceKind"), "folder")) throw new WorkspaceReadException("This chat has no folder access.");
        var projectPath = (string)task["projectPath"]!;
        if (NetworkPathPolicy.IsNetworkOrDevicePath(projectPath)) throw new WorkspaceReadException(RepositoryFolderLease.Network);
        var folder = RepositoryFolderLease.Open(loop, projectPath, RepositoryService.WorkingDirectory);
        try
        {
            if (EcmaScriptCase.ToLower(folder.Path) != EcmaScriptCase.ToLower(projectPath))
                throw new WorkspaceReadException("The saved folder now resolves to a different location. Restore the original folder before browsing files.");
            root = projectPath;
            return folder;
        }
        catch { folder.Dispose(); throw; }
    }

    private void Fail(Exception error)
    {
        loop.AssertCurrent(); backgroundFailure ??= error; CloseAdmission();
        failure.TrySetResult();
    }

    public void CloseAdmission()
    {
        loop.AssertCurrent(); closing = true;
        foreach (var entry in running.Values) entry.Abort.Cancel();
    }

    private Task<Dictionary<string, object?>> Start(Dictionary<string, object?> parameters)
    {
        var requestId = (string)parameters["requestId"]!; var hash = Compatibility.Hash(parameters);
        if (starts.TryGetValue(requestId, out var current)) return current.Hash == hash ? current.Work : Task.FromException<Dictionary<string, object?>>(new InvalidOperationException("This request ID belongs to different chat settings."));
        // Approved microtask site 1: install coalescing before the queued start.
        // Invoke also keeps the promise completion asynchronous and observed.
        var work = loop.Invoke(() => StartDeferred(parameters, hash)); starts.Add(requestId, (hash, work)); return work;
    }

    private const string ProjectUnavailable = "Project folder is unavailable or resolves to a different location.";
    private const string GitProjectChat = "Chats in Git projects need the native tool loop, which a later runtime slice ports.";

    /// <summary>
    /// service.ts startTask, for projectless chats and chats in saved folders that are not Git repositories. Its order
    /// is kept: an earlier request with this ID is answered first, then the project and its folder are checked and the
    /// folder classified, then the mode, coordination and profile. A Git project is refused before any reservation:
    /// its chats advertise project-channel and coding tools, which need the native tool loop.
    /// </summary>
    private async Task<Dictionary<string, object?>> StartDeferred(Dictionary<string, object?> parameters, string hash)
    {
        loop.AssertCurrent(); var requestId = (string)parameters["requestId"]!;
        try
        {
            if (closing) throw new InvalidOperationException("Runtime is shutting down.");
            store.RequireProjects();
            var prior = store.TaskStart(requestId);
            if (prior is not null)
            {
                if (!Equals(prior["inputHash"], hash)) throw new InvalidOperationException("This request ID belongs to different chat settings.");
                if (Equals(prior["state"], "complete")) return store.ReadTask((string)prior["taskId"]!);
                if (Equals(prior["state"], "failed"))
                {
                    var existing = store.ReadTask((string)prior["taskId"]!);
                    if (store.HasTaskUserMessage((string)existing["id"]!)) { store.FinishTaskStart(requestId, "complete"); return existing; }
                    if (!Equals(existing.GetValueOrDefault("workspaceKind"), "none")) RequireRetryableFolder(existing, parameters.GetValueOrDefault("projectId") as string);
                    store.FinishTaskStart(requestId, "pending");
                    try { StartTurn((string)existing["id"]!, (string)parameters["content"]!); store.FinishTaskStart(requestId, "complete"); return store.ReadTask((string)existing["id"]!); }
                    catch (EventDeliveryException) { throw; }
                    catch { store.FinishTaskStart(requestId, "failed"); throw; }
                }
                throw new InvalidOperationException("Chat creation has an unknown outcome. Inspect the saved chat and retained intent before trying again with a new request.");
            }
            var project = parameters.GetValueOrDefault("projectId") is string projectId ? store.Project(projectId) ?? throw new WorkspaceReadException("Project not found.") : null;
            if (project is not null && Truthy(project.GetValueOrDefault("hidden"))) throw new WorkspaceReadException("Restore this project before starting a chat.");
            var kind = "none";
            if (project is not null)
            {
                var path = (string)project["path"]!;
                if (NetworkPathPolicy.IsNetworkOrDevicePath(path)) throw new WorkspaceReadException(RepositoryFolderLease.Network);
                using (SavedProjectFolder(path))
                {
                    using var identity = RepositoryAdmission.Open(loop, path);
                    kind = await repositories.IsGitWorkingTree(path) ? "git" : "folder";
                    identity.Revalidate();
                }
            }
            if (kind == "git") throw new NotSupportedException(GitProjectChat);
            if (!Equals(parameters["mode"], "chat")) throw new WorkspaceReadException("Coding and coordination require a Git project.");
            if (parameters.ContainsKey("coordination")) throw new WorkspaceReadException("Coordination settings apply only to coordinated tasks.");
            var profile = store.Profile((string)parameters["profileId"]!) ?? throw new InvalidOperationException("Select an existing model profile."); RequireFake(profile);
            var taskId = id().ToString(); var content = (string)parameters["content"]!;
            var lineEnd = content.IndexOf('\n'); var title = lineEnd < 0 ? content : content[..(lineEnd > 0 && content[lineEnd - 1] == '\r' ? lineEnd - 1 : lineEnd)];
            title = redactor.Text(parameters.TryGetValue("title", out var supplied) ? (string)supplied! : title[..Math.Min(80, title.Length)]);
            store.ReserveTaskStart(requestId, hash, taskId);
            var saved = false; var sending = false;
            try
            {
                var stamp = Clock.Iso(now());
                var task = new Dictionary<string, object?> { ["id"] = taskId, ["title"] = title };
                if (project is not null) task["projectId"] = project["id"];
                task["profileId"] = parameters["profileId"]; task["status"] = "idle"; task["createdAt"] = stamp; task["updatedAt"] = stamp;
                task["tokenBudget"] = parameters["tokenBudget"]; task["usedTokens"] = 0; task["mode"] = "chat"; task["workspaceKind"] = kind;
                if (project is not null) task["projectPath"] = project["path"];
                store.SaveTask(task); saved = true; store.Event("tasks.changed", new Dictionary<string, object?>(), taskId); sending = true;
                StartTurn(taskId, content); store.FinishTaskStart(requestId, "complete"); return store.ReadTask(taskId);
            }
            catch (EventDeliveryException) { throw; }
            catch (Exception error)
            {
                if (saved && sending && !store.HasTaskUserMessage(taskId)) { store.FinishTaskStart(requestId, "failed"); throw; }
                store.FinishTaskStart(requestId, "unknown");
                throw new InvalidOperationException("Chat creation has an unknown outcome. Inspect the saved chat and retained intent before retrying. " + redactor.Text(error.Message), error);
            }
        }
        catch (EventDeliveryException error) { Fail(error); throw; }
        finally { starts.Remove(requestId); }
    }

    /// <summary>
    /// startTask's project check: the saved folder resolves to the same physical folder under its saved spelling and is a
    /// directory. Every failure is the one refusal TypeScript's catch-all reports. The lease keeps the folder pinned while
    /// the caller classifies it.
    /// </summary>
    private RepositoryFolderLease SavedProjectFolder(string path)
    {
        RepositoryFolderLease? folder = null;
        try
        {
            folder = RepositoryFolderLease.Open(loop, path);
            if (EcmaScriptCase.ToLower(folder.Path) != EcmaScriptCase.ToLower(path)) throw new WorkspaceReadException(ProjectUnavailable);
            return folder;
        }
        catch (Exception error) when (error is InvalidOperationException or IOException or ArgumentException or UnauthorizedAccessException)
        {
            folder?.Dispose();
            throw new WorkspaceReadException(ProjectUnavailable);
        }
    }

    /// <summary>
    /// The failed-start retry of a project chat: the task's saved project is still the requested, visible project, its
    /// folder still resolves under its saved spelling, and the task's own folder spelling names that same folder by
    /// identity. A Git task's retry would run a tool-enabled turn, which needs a later slice.
    /// </summary>
    private void RequireRetryableFolder(Dictionary<string, object?> task, string? projectId)
    {
        if (Store.IsGitDocument(task)) throw new NotSupportedException(GitProjectChat);
        var project = task.GetValueOrDefault("projectId") is string saved ? store.Project(saved) : null;
        if (project is null || !Equals(project["id"], projectId) || Truthy(project.GetValueOrDefault("hidden"))) throw new WorkspaceReadException(ProjectUnavailable);
        var path = (string)project["path"]!;
        if (NetworkPathPolicy.IsNetworkOrDevicePath(path)) throw new WorkspaceReadException(ProjectUnavailable);
        using (SavedProjectFolder(path))
            if (task.GetValueOrDefault("projectPath") is not string folder || !RepositoryPaths.SameFolder(folder, path)) throw new WorkspaceReadException(ProjectUnavailable);
    }

    private Running StartTurn(string taskId, string content)
    {
        loop.AssertCurrent();
        if (closing) throw new InvalidOperationException("Runtime is shutting down.");
        if (running.ContainsKey(taskId)) throw new InvalidOperationException("This task already has an active response.");
        if (running.Count >= 16) throw new InvalidOperationException("Too many active tasks. Finish or cancel a task first.");
        var task = store.ReadTask(taskId); RequireOrdinary(task);
        if (Equals(task["status"], "retired")) throw new InvalidOperationException("This task worktree is retired. Create a new task to continue the work.");
        store.AssertNoChatExecutionIntents(taskId);
        var profile = store.Profile((string)task["profileId"]!) ?? throw new InvalidOperationException("Profile not found."); RequireFake(profile);
        var clean = redactor.Text(content); var fingerprint = Compatibility.ProfileFingerprint(profile);
        var request = store.PrepareChatRequest(taskId, profile, fingerprint, clean);
        if (request.GetValueOrDefault("continuation") is Dictionary<string, object?> native
            && (native.GetValueOrDefault("data") is not Dictionary<string, object?> data || data.GetValueOrDefault("stage") is not string stage || stage is not "chat" and not "complete"))
            throw new NotSupportedException("This native continuation requires a later runtime feature slice.");
        var stamp = Clock.Iso(now()); var answer = new Dictionary<string, object?> { ["id"] = id().ToString(), ["taskId"] = taskId, ["role"] = "assistant", ["content"] = "", ["createdAt"] = stamp, ["status"] = "streaming" };
        TaskReservation? reservation = null;
        store.Transaction(() =>
        {
            reservation = store.AdmitTaskRequest(task, request);
            store.SaveMessage(new() { ["id"] = id().ToString(), ["taskId"] = taskId, ["role"] = "user", ["content"] = clean, ["createdAt"] = stamp, ["status"] = "complete" });
            store.SaveMessage(answer); store.SaveTask(new(store.ReadTask(taskId)) { ["status"] = "running", ["updatedAt"] = stamp }); return 0;
        });
        var entry = new Running(); running.Add(taskId, entry);
        // Approved JavaScript microtask site 2: Invoke queues and tracks AgentLoop.run.
        // Adding another yield here would defer twice and change admission ordering.
        entry.Done = loop.Invoke(async () =>
        {
            entry.Started.TrySetResult();
            try
            {
                await Run(taskId, request, answer, reservation!, fingerprint, entry.Abort.Token);
            }
            catch (Exception error) { Fail(error); }
            finally { loop.AssertCurrent(); running.Remove(taskId); entry.Dispose(); }
            return 0;
        });
        if (store.SchemaVersion < 5) store.Event("task.started", new Dictionary<string, object?>(), taskId);
        var started = store.ReadTask(taskId);
        if (Number(started["usedTokens"]) >= Number(task["tokenBudget"]) * 0.8) store.Event("task.budget-warning", new Dictionary<string, object?> { ["usedTokens"] = started["usedTokens"], ["budget"] = task["tokenBudget"] }, taskId);
        return entry;
    }

    private async Task Run(string taskId, Dictionary<string, object?> request, Dictionary<string, object?> answer, TaskReservation initial, string fingerprint, CancellationToken token)
    {
        loop.AssertCurrent(); TaskReservation? handle = initial; var raw = new StringBuilder(); var profile = (Dictionary<string, object?>)request["profile"]!;
        var rawBytes = 0L; var lastProgress = 0L; var finished = false; ProviderContinuation? continuation = null;
        void CheckCancellation() { if (token.IsCancellationRequested) throw new OperationCanceledException("This operation was aborted", token); }
        void Settle(string outcome, string? reason)
        {
            if (handle is null) return;
            var current = handle; store.SettleTaskRequest(taskId, current, null, outcome, reason); handle = null;
            store.Event("usage.changed", new Dictionary<string, object?> { ["requestId"] = current.RequestId }, taskId);
        }
        async Task Expire(CancellationToken lifetime)
        {
            try { await loop.Delay(TimeSpan.FromMinutes(10), lifetime); loop.AssertCurrent(); if (running.TryGetValue(taskId, out var current)) current.Abort.Cancel(); }
            catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        }
        try
        {
            var contextLimit = Number(profile["contextLimit"]);
            if (initial.Amount >= contextLimit * 0.8) store.Event("task.context-warning", new Dictionary<string, object?> { ["estimatedTokens"] = initial.Amount, ["contextLimit"] = profile["contextLimit"], ["percent"] = Math.Floor(initial.Amount / contextLimit * 100 + 0.5) }, taskId);
            try
            {
                await UseSlot(async () =>
                {
                    store.AttemptUsage(initial.RequestId); using var lifetime = new CancellationTokenSource(); var expiry = Expire(lifetime.Token);
                    try
                    {
                        var messages = ((System.Collections.IEnumerable)request["messages"]!).Cast<Dictionary<string, object?>>().Select(message => new ProviderMessage((string)message["role"]!, (string)message["content"]!)).ToArray();
                        var native = request.GetValueOrDefault("continuation") as Dictionary<string, object?>;
                        var prior = native is null ? null : new ProviderContinuation((string)native["apiKind"]!, native["data"]);
                        await foreach (var item in stream(messages, prior, token))
                        {
                            loop.AssertCurrent();
                            if (finished) throw new InvalidOperationException("Provider emitted data after its completion event.");
                            CheckCancellation();
                            if (item is ProviderText text)
                            {
                                raw.Append(text.Text); rawBytes += Encoding.UTF8.GetByteCount(text.Text);
                                if (rawBytes > 256 * 1024) throw new InvalidOperationException("Response exceeded the local output limit.");
                                var tick = now().ToUnixTimeMilliseconds();
                                if (tick - lastProgress >= 100) { store.PublishProgress(new Dictionary<string, object?> { ["receivedCharacters"] = raw.Length }, taskId); lastProgress = tick; }
                            }
                            else if (item is ProviderDone done) { finished = true; continuation = done.Continuation; }
                            else throw new InvalidOperationException("Unexpected or duplicate provider tool call.");
                        }
                    }
                    finally { lifetime.Cancel(); await expiry; }
                }, token);
            }
            catch (EventDeliveryException) { throw; }
            catch
            {
                Settle(token.IsCancellationRequested ? "cancelled" : "failed", "Provider stream failed or was cancelled before usage was confirmed."); throw;
            }
            CheckCancellation();
            if (!finished) throw new InvalidOperationException("Provider stream ended without a completion event.");
            Dictionary<string, object?>? state = null;
            var previous = store.ReadProviderState(taskId);
            if (previous is not null)
            {
                if (continuation is null || continuation.ApiKind != (string)profile["apiKind"]!) throw new InvalidOperationException("Provider omitted native continuation; tools were not executed.");
                var serialized = JsJson.Stringify(continuation)!;
                if (Encoding.UTF8.GetByteCount(serialized) > 512 * 1024) throw new InvalidOperationException("Native conversation exceeded the persistence limit.");
                if (redactor.Text(serialized) != serialized) throw new InvalidOperationException("Native conversation contained secret-like data; it was not persisted and tools were not executed.");
                var seen = previous.GetValueOrDefault("seenToolCallIds") as List<object?>
                    ?? ((List<object?>)previous["pending"]!).Cast<Dictionary<string, object?>>().Select(call => call["id"]).ToList();
                var unique = seen.Cast<string>().Distinct(StringComparer.Ordinal).ToList();
                if (unique.Count > 1000) throw new InvalidOperationException("Task tool-history limit reached. Create a new task.");
                state = new() { ["fingerprint"] = fingerprint, ["continuation"] = continuation.ToWire(), ["pending"] = new List<object?>(), ["results"] = new List<object?>(), ["seenToolCallIds"] = unique };
            }
            var priorContent = (string)answer["content"]!; var clean = redactor.Text(raw.ToString());
            answer["content"] = priorContent + (priorContent.Length > 0 && raw.Length > 0 ? "\n\n" : "") + clean; raw.Clear();
            if (Encoding.UTF8.GetByteCount((string)answer["content"]!) > 512 * 1024) throw new InvalidOperationException("Turn transcript exceeded the local limit.");
            store.Transaction(() =>
            {
                if (state is not null) store.Execute("INSERT OR REPLACE INTO intents VALUES($p0,'provider.context',$p1,'complete')", taskId, JsJson.Stringify(state));
                store.SaveMessage(answer); Settle("completed", "Provider completed without reporting usage; the reservation is retained."); return 0;
            });
            answer["status"] = "complete"; store.SaveMessage(answer);
            var detail = new Dictionary<string, object?> { ["usageKnown"] = false, ["chargedTokens"] = initial.Amount };
            store.SaveTask(new(store.ReadTask(taskId)) { ["status"] = "idle", ["updatedAt"] = Clock.Iso(now()) }, detail);
            if (store.SchemaVersion < 5) store.Event("task.completed", detail, taskId);
        }
        catch (EventDeliveryException) { throw; }
        catch (Exception error)
        {
            Settle(token.IsCancellationRequested ? "cancelled" : "failed", "Turn stopped before this request completed.");
            var content = (string)answer["content"]!;
            answer["content"] = content + (content.Length > 0 && raw.Length > 0 ? "\n\n" : "") + redactor.Text(raw.ToString());
            answer["status"] = token.IsCancellationRequested ? "cancelled" : "failed";
            var reason = token.IsCancellationRequested ? "Response cancelled. Unreported usage remains reserved conservatively." : redactor.Text(error.Message);
            store.Transaction(() => { store.SaveMessage(answer); store.SaveTask(new(store.ReadTask(taskId)) { ["status"] = answer["status"], ["updatedAt"] = Clock.Iso(now()) }, new() { ["reason"] = reason }); return 0; });
            if (store.SchemaVersion < 5) store.Event("task.stopped", new Dictionary<string, object?> { ["reason"] = reason }, taskId);
        }
    }

    private async Task UseSlot(Func<Task> action, CancellationToken token)
    {
        while (activeSlots >= 3)
        {
            token.ThrowIfCancellationRequested(); var waiter = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); slotWaiters.Add(waiter);
            using var registration = token.Register(() => waiter.TrySetResult());
            try { await waiter.Task; }
            finally { loop.AssertCurrent(); slotWaiters.Remove(waiter); }
        }
        token.ThrowIfCancellationRequested(); activeSlots++;
        try { await action(); }
        finally { loop.AssertCurrent(); activeSlots--; foreach (var waiter in slotWaiters.ToArray()) waiter.TrySetResult(); }
    }

    public async Task Shutdown()
    {
        CloseAdmission();
        await Task.WhenAll(running.Values.Select(entry => entry.Done).ToArray());
        loop.AssertCurrent();
        if (backgroundFailure is not null) throw new InvalidOperationException("Development chat execution failed.", backgroundFailure);
    }
    private static void RequireFake(Dictionary<string, object?> profile)
    {
        if (!Equals(profile.GetValueOrDefault("apiKind"), "fake")) throw new NotSupportedException("External providers are not supported by the development chat runtime.");
    }
    /// <summary>A chat turn with no tools: projectless, or in a saved folder that is not a Git repository (agent-loop.ts
    /// prepareRequest gives neither any tool, channel or system prompt).</summary>
    private static void RequireOrdinary(Dictionary<string, object?> task)
    {
        if (task.TryGetValue("mode", out var mode) && !Equals(mode, "chat") || task.GetValueOrDefault("workspaceKind") is not ("none" or "folder")
            || task.ContainsKey("parentTaskId") || task.ContainsKey("rootTaskId") || task.ContainsKey("role"))
            throw new NotSupportedException("The development chat runtime supports projectless and folder ordinary chat only.");
    }
    private static double Number(object? value) => Convert.ToDouble(value, CultureInfo.InvariantCulture);
    private static long? Ordinal(Dictionary<string, object?> value, string key) => value.TryGetValue(key, out var field) ? checked((long)Number(field)) : null;
    private static int Integer(Dictionary<string, object?> value, string key, int fallback) => checked((int)(Ordinal(value, key) ?? fallback));
}
