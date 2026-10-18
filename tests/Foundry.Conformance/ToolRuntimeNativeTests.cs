using System.Text;
using System.Text.Json;
using Foundry.Protocol;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

/// <summary>The native tool runtime's named differences and the outcomes the Node oracle cannot reach.</summary>
public sealed class ToolRuntimeNativeTests
{
    // Task 1's worktree is where the product puts it, as the coding tools require (Rudy's decision I5, P2.3f).
    private const string Worktree = "data/wt/14141414-0000-4000-8000-000000000001";
    private const string Tree = """
        [{ "dir": "data/wt/14141414-0000-4000-8000-000000000001" }, { "file": "data/wt/14141414-0000-4000-8000-000000000001/README.md", "text": "hello\n" },
         { "git": ["-C", "data/wt/14141414-0000-4000-8000-000000000001", "init", "-q"] }, { "git": ["-C", "data/wt/14141414-0000-4000-8000-000000000001", "add", "-A"] },
         { "git": ["-C", "data/wt/14141414-0000-4000-8000-000000000001", "commit", "-qm", "fixture"] }]
        """;
    private static readonly string Readme = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData("hello\n"u8));

    /// <summary>
    /// Native difference: coordinated roles are not served until their slices. TypeScript lets a coordinator read, asks a child
    /// for its assignment scope, and lets a child with its orchestration binding use the channel; native has no orchestration,
    /// so a child's channel call is fenced as TypeScript fences one without a binding.
    /// </summary>
    [Fact]
    public Task CoordinatedRolesAreRefusedUntilTheirSlices() => Run(async (fixture, store, _, tools) =>
    {
        var coordinator = SeedTask(store, fixture, 2, new() { ["mode"] = "coordinated" });
        var child = SeedTask(store, fixture, 3, new() { ["role"] = "child", ["parentTaskId"] = coordinator["id"], ["rootTaskId"] = coordinator["id"] });
        foreach (var (task, name, message) in new[]
        {
            (coordinator, "read_file", "Tool is not available."), (child, "read_file", "Tool is not available."), (child, "write_file", "Tool is not available."),
            (child, "list_project_agents", "This agent is cancelled, fenced or finished."), (child, "send_agent_message", "This agent is cancelled, fenced or finished."),
        })
        {
            var arguments = name.Contains("agent", StringComparison.Ordinal) ? new Dictionary<string, object?>() : new Dictionary<string, object?> { ["path"] = "README.md" };
            var result = await tools.Execute(task, new ToolCall("call", name, arguments), CancellationToken.None);
            Assert.Equal(new ToolResult("call", name, message, true), result);
        }
        Assert.Empty(store.Rows("SELECT * FROM intents WHERE kind='tool.approval'"));
        Assert.Empty(store.Rows("SELECT * FROM events WHERE type LIKE 'channel.%'"));
    });

    /// <summary>
    /// Native difference: a failure that is not one of the runtime's own refusals is classified and saved like any other
    /// (after the executing state, unknown), then rethrown instead of being handed to the model as text.
    /// </summary>
    [Fact]
    public Task AnUnexpectedFailureAfterTheExecutingStateIsSavedUnknownThenRethrown() => Run(async (fixture, store, commands, tools) =>
    {
        var task = SeedTask(store, fixture, 1);
        commands.Launching = _ => throw new InvalidOperationException("Unexpected launch failure.");
        var pending = tools.Execute(task, new ToolCall("call", "run_command", new Dictionary<string, object?> { ["command"] = "[Console]::Out.WriteLine('x')" }), CancellationToken.None);
        var approval = await Proposal(store, pending);
        tools.Decide((string)task["id"]!, (string)approval["id"]!, (string)approval["nonce"]!, "approve");
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => pending);
        Assert.Equal("Unexpected launch failure.", error.Message);
        var saved = store.Approval((string)approval["id"]!);
        Assert.Equal("unknown", saved["state"]);
        Assert.Equal("""{"content":"Tool failed.","isError":true,"cleanupVerified":false}""", JsJson.Stringify(saved["result"]));
    });

    /// <summary>A failure before any proposal is rethrown and leaves no row.</summary>
    [Fact]
    public Task AnUnexpectedFailureBeforeAnyProposalIsRethrownWithoutARow() => Run(async (fixture, store, _, tools) =>
    {
        var task = SeedTask(store, fixture, 1);
        await Assert.ThrowsAnyAsync<Exception>(() => tools.Execute(task, new ToolCall("call", "read_file", new Exploding()), CancellationToken.None));
        Assert.Empty(store.Rows("SELECT * FROM intents"));
    });

    /// <summary>Once the edit's write has started, any failure leaves the outcome unknown; nothing is retried.</summary>
    [Fact]
    public Task AFailureAfterTheEditWriteStartedIsUnknown() => Run(async (fixture, store, _, tools, repositories) =>
    {
        var task = SeedTask(store, fixture, 1);
        repositories.EditStage = stage => { if (stage == "written") throw new IOException("Verification read failed."); };
        var pending = tools.Execute(task, new ToolCall("call", "write_file", new Dictionary<string, object?> { ["path"] = "README.md", ["expectedHash"] = Readme, ["content"] = "after\n" }), CancellationToken.None);
        var approval = await Proposal(store, pending);
        tools.Decide((string)task["id"]!, (string)approval["id"]!, (string)approval["nonce"]!, "approve");
        Assert.Equal(new ToolResult("call", "write_file", "Verification read failed.", true), await pending);
        Assert.Equal("unknown", store.Approval((string)approval["id"]!)["state"]);
        Assert.Equal("after\n", File.ReadAllText(fixture.Local(Worktree + "/README.md")));
    });

    /// <summary>
    /// Rudy's decision I5 (P2.3f): the coding tools act only in the task's own app-owned worktree, the folder
    /// createTaskWorktree makes for it. Any other stored worktree is refused before any read, proposal or execution; a
    /// spelling that differs only in case is the same folder. Not in TypeScript, which uses the stored path.
    /// </summary>
    [Fact]
    public Task ACodingToolOutsideTheTasksOwnWorktreeIsRefused() => Run(async (fixture, store, _, tools) =>
    {
        const string Foreign = "This task's worktree is not its app-owned worktree, so coding tools are refused.";
        var own = SeedTask(store, fixture, 1);
        Directory.CreateDirectory(fixture.Local("project")); File.WriteAllText(fixture.Local("project/README.md"), "hello\n");
        foreach (var (number, worktree) in new[] { (2, fixture.Local("project")), (3, fixture.Local(Worktree)), (4, fixture.Local("data/wt/elsewhere")), (5, fixture.Local("data/wt")) })
        {
            var task = SeedTask(store, fixture, number, new() { ["worktreePath"] = worktree });
            foreach (var (name, arguments) in new (string, Dictionary<string, object?>)[]
            {
                ("read_file", new() { ["path"] = "README.md" }), ("list_directory", new()), ("search_text", new() { ["query"] = "hello" }),
                ("write_file", new() { ["path"] = "README.md", ["expectedHash"] = Readme, ["content"] = "after\n" }), ("run_command", new() { ["command"] = "[Console]::Out.Write('x')" }),
            })
                Assert.Equal(new ToolResult("call", name, Foreign, true), await tools.Execute(task, new ToolCall("call", name, arguments), CancellationToken.None));
        }
        Assert.Empty(store.Rows("SELECT * FROM intents WHERE kind='tool.approval'"));
        Assert.Equal("hello\n", File.ReadAllText(fixture.Local("project/README.md")));
        var spelled = SeedTask(store, fixture, 6, new() { ["worktreePath"] = fixture.Local(Worktree).ToUpperInvariant().Replace("14141414-0000-4000-8000-000000000001", "14141414-0000-4000-8000-000000000006", StringComparison.OrdinalIgnoreCase) });
        Directory.CreateDirectory(fixture.Local("data/wt/14141414-0000-4000-8000-000000000006")); File.WriteAllText(fixture.Local("data/wt/14141414-0000-4000-8000-000000000006/README.md"), "six\n");
        Assert.Contains("six", (await tools.Execute(spelled, new ToolCall("call", "read_file", new Dictionary<string, object?> { ["path"] = "README.md" }), CancellationToken.None)).Content, StringComparison.Ordinal);
        Assert.Contains("hello", (await tools.Execute(own, new ToolCall("call", "read_file", new Dictionary<string, object?> { ["path"] = "README.md" }), CancellationToken.None)).Content, StringComparison.Ordinal);
    });

    /// <summary>
    /// The compare-and-set on approval saves (P2.3b's carried item): a copy that finds its stored approval changed under it
    /// overwrites nothing and executes nothing. Here the row is revoked between the decision and the resumed call.
    /// </summary>
    [Fact]
    public Task AnApprovalChangedUnderItsCallIsNeitherOverwrittenNorExecuted() => Run(async (fixture, store, _, tools) =>
    {
        var task = SeedTask(store, fixture, 1);
        var pending = tools.Execute(task, new ToolCall("call", "write_file", new Dictionary<string, object?> { ["path"] = "README.md", ["expectedHash"] = Readme, ["content"] = "after\n" }), CancellationToken.None);
        var approval = await Proposal(store, pending);
        tools.Decide((string)task["id"]!, (string)approval["id"]!, (string)approval["nonce"]!, "approve");
        // The call resumes after this callback, so the row changes first.
        store.Execute("UPDATE intents SET state='revoked' WHERE id=$p0", approval["id"]);
        Assert.Equal("The approval changed while it was in use; it was not overwritten.", (await Assert.ThrowsAsync<ApprovalConflictException>(() => pending)).Message);
        Assert.Equal("revoked", store.Approval((string)approval["id"]!)["state"]);
        Assert.Equal("hello\n", File.ReadAllText(fixture.Local(Worktree + "/README.md")));
    });

    /// <summary>
    /// Security L-1 of P2.3f: confinement compares folders, not spellings. Another case of the task's own folder qualifies;
    /// a different folder whose name only case-folds alike (the Kelvin sign folds to k, though NTFS keeps the two apart)
    /// does not, and neither does any path through a junctioned worktree folder.
    /// </summary>
    [Fact]
    public async Task ConfinementComparesFoldersNotSpellings()
    {
        using var fixture = RepositoryFixture.Create("foundry-p2-confinement-");
        const string Id = "14141414-0000-4000-8000-000000000001";
        foreach (var folder in new[] { $"work/wt/{Id}", $"wor\u212A/wt/{Id}", $"target/wt/{Id}" }) Directory.CreateDirectory(fixture.Local(folder));
        await fixture.Junction("linked", "target");
        await using var loop = new RuntimeLoop();
        await loop.Invoke(() =>
        {
            var repositories = new RepositoryService(loop, fixture.Local("work/wt"));
            Assert.True(repositories.IsOwnWorktree(Id, fixture.Local($"work/wt/{Id}")));
            Assert.True(repositories.IsOwnWorktree(Id, fixture.Local($"WORK/WT/{Id}")));
            Assert.False(repositories.IsOwnWorktree(Id, fixture.Local($"wor\u212A/wt/{Id}")));
            Assert.False(repositories.IsOwnWorktree(Id, fixture.Local($"linked/wt/{Id}")));
            var junctioned = new RepositoryService(loop, fixture.Local("linked/wt"));
            Assert.False(junctioned.IsOwnWorktree(Id, fixture.Local($"linked/wt/{Id}")));
            Assert.False(junctioned.IsOwnWorktree(Id, fixture.Local($"target/wt/{Id}")));
            return Task.FromResult(0);
        });
    }

    /// <summary>Security L-2 and data L1 of P2.3f: a proposal changed while it waits is left as it was changed when the wait
    /// is cancelled; the stale copy writes nothing.</summary>
    [Fact]
    public Task AConflictWhileWaitingLeavesTheChangedApproval() => Run(async (fixture, store, _, tools) =>
    {
        var task = SeedTask(store, fixture, 1);
        using var cancellation = new CancellationTokenSource();
        var pending = tools.Execute(task, new ToolCall("call", "write_file", new Dictionary<string, object?> { ["path"] = "README.md", ["expectedHash"] = Readme, ["content"] = "after\n" }), cancellation.Token);
        var approval = await Proposal(store, pending);
        store.Execute("UPDATE intents SET state='rejected' WHERE id=$p0", approval["id"]);
        await cancellation.CancelAsync();
        await Assert.ThrowsAsync<ApprovalConflictException>(() => pending);
        Assert.Equal("rejected", store.Approval((string)approval["id"]!)["state"]);
        Assert.Equal("hello\n", File.ReadAllText(fixture.Local(Worktree + "/README.md")));
    });

    /// <summary>Data L2 of P2.3f: once the executing state is saved the action may have run, so a change to the stored
    /// approval then records the outcome unknown over it, and the next turn waits for reconciliation.</summary>
    [Fact]
    public Task AConflictAfterTheActionRanRecordsItsOutcomeUnknown() => Run(async (fixture, store, _, tools, repositories) =>
    {
        var task = SeedTask(store, fixture, 1);
        string? approvalId = null;
        repositories.EditStage = stage => { if (stage == "written") store.Execute("UPDATE intents SET state='revoked' WHERE id=$p0", approvalId); };
        var pending = tools.Execute(task, new ToolCall("call", "write_file", new Dictionary<string, object?> { ["path"] = "README.md", ["expectedHash"] = Readme, ["content"] = "after\n" }), CancellationToken.None);
        var approval = await Proposal(store, pending); approvalId = (string)approval["id"]!;
        tools.Decide((string)task["id"]!, approvalId, (string)approval["nonce"]!, "approve");
        await Assert.ThrowsAsync<ApprovalConflictException>(() => pending);
        var stored = store.Approval(approvalId);
        Assert.Equal("unknown", stored["state"]);
        Assert.Equal("The approval changed while its action ran, so its outcome is unknown.", ((Dictionary<string, object?>)stored["result"]!)["content"]);
        Assert.True(store.HasBlockingUnknown((string)task["id"]!));
        Assert.Equal("after\n", File.ReadAllText(fixture.Local(Worktree + "/README.md")));
    });

    /// <summary>Security I-1 of P2.3f: a decision applies only while the stored proposal, which the user reviews, is the one
    /// that would run. Not in TypeScript.</summary>
    [Fact]
    public Task ADecisionOnAProposalChangedSinceItWasSavedIsRefused() => Run(async (fixture, store, _, tools) =>
    {
        var task = SeedTask(store, fixture, 1);
        using var cancellation = new CancellationTokenSource();
        var pending = tools.Execute(task, new ToolCall("call", "write_file", new Dictionary<string, object?> { ["path"] = "README.md", ["expectedHash"] = Readme, ["content"] = "after\n" }), cancellation.Token);
        var approval = await Proposal(store, pending);
        store.Execute("UPDATE intents SET data=json_set(data,'$.after','benign') WHERE id=$p0", approval["id"]);
        Assert.Equal("This approval is stale or does not match the active task.",
            Assert.Throws<WorkspaceReadException>(() => tools.Decide((string)task["id"]!, (string)approval["id"]!, (string)approval["nonce"]!, "approve")).Message);
        await cancellation.CancelAsync();
        Assert.Equal("Action cancelled before execution.", (await pending).Content);
        Assert.Equal("hello\n", File.ReadAllText(fixture.Local(Worktree + "/README.md")));
    });

    /// <summary>
    /// A command that exits 0 but whose cleanup cannot be verified (it hands its output handle to this process, outside its
    /// job) is recorded unknown with cleanup unverified, never complete (review L-1 of P2.3c). The Node oracle cannot reach
    /// it: its helper runs the command under a watchdog of its own.
    /// </summary>
    [Fact]
    public Task ACommandWhoseCleanupIsUnverifiedIsRecordedUnknown() => Run(async (fixture, store, _, tools) =>
    {
        var task = SeedTask(store, fixture, 1);
        var command = "$sig = '[DllImport(\"kernel32.dll\")] public static extern IntPtr GetStdHandle(int n); [DllImport(\"kernel32.dll\")] public static extern IntPtr GetCurrentProcess(); "
            + "[DllImport(\"kernel32.dll\")] public static extern IntPtr OpenProcess(uint a, bool i, int p); "
            + "[DllImport(\"kernel32.dll\")] public static extern bool DuplicateHandle(IntPtr sp, IntPtr h, IntPtr tp, out IntPtr d, uint a, bool i, uint o);'; "
            + "$k = Add-Type -MemberDefinition $sig -Name K -Namespace P -PassThru; "
            + $"$t = $k::OpenProcess(0x40, $false, {Environment.ProcessId}); $d = [IntPtr]::Zero; "
            + "[void]$k::DuplicateHandle($k::GetCurrentProcess(), $k::GetStdHandle(-11), $t, [ref]$d, 0, $false, 2); "
            + "[IO.File]::WriteAllText('handle.txt', [string]$d.ToInt64()); [Console]::Out.Write('hello')";
        var pending = tools.Execute(task, new ToolCall("call", "run_command", new Dictionary<string, object?> { ["command"] = command, ["timeoutMs"] = 60000d }), CancellationToken.None);
        var approval = await Proposal(store, pending);
        tools.Decide((string)task["id"]!, (string)approval["id"]!, (string)approval["nonce"]!, "approve");
        var result = await pending.WaitAsync(TimeSpan.FromMinutes(2));
        var handle = nint.Parse(File.ReadAllText(fixture.Local(Worktree + "/handle.txt")), System.Globalization.CultureInfo.InvariantCulture);
        Assert.True(handle != 0, "The command did not hand its output to this process, so the test proves nothing.");
        CloseHandle(handle);
        Assert.True(result.IsError, result.Content);
        var saved = store.Approval((string)approval["id"]!);
        Assert.Equal("unknown", saved["state"]);
        var outcome = (Dictionary<string, object?>)saved["result"]!;
        Assert.Equal((false, 0d), ((bool)outcome["cleanupVerified"]!, (double)outcome["exitCode"]!));
    });

    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    [System.Runtime.InteropServices.DefaultDllImportSearchPaths(System.Runtime.InteropServices.DllImportSearchPath.System32)]
    private static extern bool CloseHandle(nint handle);

    /// <summary>Three holders at once; a waiter is admitted when one leaves, and a cancelled waiter leaves without a slot.</summary>
    [Fact]
    public async Task ExecutionSlotsAdmitThreeAndACancelledWaiterTakesNone()
    {
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            var slots = new ExecutionSlots(loop);
            var release = Enumerable.Range(0, 3).Select(_ => new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously)).ToList();
            var holders = release.Select(gate => slots.Use(() => gate.Task, CancellationToken.None)).ToList();
            using var cancellation = new CancellationTokenSource();
            var cancelled = slots.Use(() => Task.CompletedTask, cancellation.Token);
            var admitted = false;
            var waiting = slots.Use(() => { admitted = true; return Task.CompletedTask; }, CancellationToken.None);
            await Task.Yield();
            Assert.False(admitted);
            await cancellation.CancelAsync();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => cancelled);
            Assert.False(admitted);
            release[0].SetResult();
            await waiting;
            Assert.True(admitted);
            foreach (var gate in release.Skip(1)) gate.SetResult();
            await Task.WhenAll(holders);
            return 0;
        });
    }

    private sealed class Exploding
    {
        private readonly string message = "Unreadable argument.";
        public string Value => throw new InvalidOperationException(message);
    }

    private static async Task<Dictionary<string, object?>> Proposal(Store store, Task pending)
    {
        for (var wait = 0; wait < 6000 && !pending.IsCompleted; wait++)
        {
            if (store.Rows("SELECT data FROM intents WHERE kind='tool.approval' AND state='awaiting-approval'").FirstOrDefault() is { } row) return (Dictionary<string, object?>)PersistedJson.Parse((string)row["data"]!)!;
            await Task.Delay(5);
        }
        throw new InvalidOperationException("No proposal was saved.");
    }

    private static Dictionary<string, object?> SeedTask(Store store, RepositoryFixture fixture, int number, Dictionary<string, object?>? extra = null)
    {
        var task = new Dictionary<string, object?>
        {
            ["id"] = $"14141414-0000-4000-8000-{number:D12}", ["title"] = $"Task {number}", ["profileId"] = Store.FakeProfileId, ["status"] = "idle", ["createdAt"] = "2026-01-02T03:04:05.678Z",
            ["updatedAt"] = "2026-01-02T03:04:05.678Z", ["tokenBudget"] = 100000d, ["usedTokens"] = 0d, ["mode"] = "coding", ["workspaceKind"] = "git", ["projectPath"] = fixture.Local($"data/wt/14141414-0000-4000-8000-{number:D12}"),
            ["worktreePath"] = fixture.Local($"data/wt/14141414-0000-4000-8000-{number:D12}"), ["branch"] = "codex/tools", ["baseCommit"] = new string('0', 40),
        };
        foreach (var (key, value) in extra ?? []) task[key] = value;
        store.SaveTask(task);
        return store.ReadTask((string)task["id"]!);
    }

    private static Task Run(Func<RepositoryFixture, Store, CommandRunner, ToolRuntime, Task> body) => Run((fixture, store, commands, tools, _) => body(fixture, store, commands, tools));

    private static async Task Run(Func<RepositoryFixture, Store, CommandRunner, ToolRuntime, RepositoryService, Task> body)
    {
        using var fixture = RepositoryFixture.Create("foundry-p2-tools-native-");
        foreach (var folder in new[] { "tmp", "profile", "data" }) Directory.CreateDirectory(fixture.Local(folder));
        using (var tree = JsonDocument.Parse(Tree)) await fixture.Build(tree.RootElement);
        var environment = new Dictionary<string, string>(fixture.Environment(), StringComparer.OrdinalIgnoreCase)
        {
            ["TEMP"] = fixture.Local("tmp"), ["TMP"] = fixture.Local("tmp"), ["USERPROFILE"] = fixture.Local("profile"),
        };
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            using var store = new Store(loop, fixture.Local("data"), Path.Combine(fixture.Scratch, "injected-root"));
            var repositories = new RepositoryService(loop, Path.Combine(fixture.Local("data"), "wt"), () => environment);
            var commands = new CommandRunner(loop, repositories, () => environment);
            await body(fixture, store, commands, new ToolRuntime(loop, store, repositories, commands, new Redactor(), new ExecutionSlots(loop), () => DateTimeOffset.UtcNow, Guid.NewGuid), repositories);
            return 0;
        });
    }
}
