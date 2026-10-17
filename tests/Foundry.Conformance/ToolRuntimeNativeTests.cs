using System.Text;
using System.Text.Json;
using Foundry.Protocol;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

/// <summary>The native tool runtime's named differences and the outcomes the Node oracle cannot reach.</summary>
public sealed class ToolRuntimeNativeTests
{
    private const string Tree = """
        [{ "dir": "repo" }, { "file": "repo/README.md", "text": "hello\n" }, { "git": ["-C", "repo", "init", "-q"] }, { "git": ["-C", "repo", "add", "-A"] },
         { "git": ["-C", "repo", "commit", "-qm", "fixture"] }]
        """;
    private static readonly string Readme = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData("hello\n"u8));

    /// <summary>
    /// Native difference: the project channel, coordinated roles and their tools are not served until their slices. TypeScript
    /// runs a coding task's channel tools, lets a coordinator read, and asks a child for its assignment scope.
    /// </summary>
    [Fact]
    public Task ChannelToolsAndCoordinatedRolesAreRefusedUntilTheirSlices() => Run(async (fixture, store, _, tools) =>
    {
        var coding = SeedTask(store, fixture, 1);
        var coordinator = SeedTask(store, fixture, 2, new() { ["mode"] = "coordinated" });
        var child = SeedTask(store, fixture, 3, new() { ["role"] = "child", ["parentTaskId"] = coordinator["id"], ["rootTaskId"] = coordinator["id"] });
        foreach (var (task, name) in new[] { (coding, "send_agent_message"), (coding, "list_project_agents"), (coordinator, "read_file"), (child, "read_file"), (child, "write_file") })
        {
            var result = await tools.Execute(task, new ToolCall("call", name, new Dictionary<string, object?> { ["path"] = "README.md" }), CancellationToken.None);
            Assert.Equal(new ToolResult("call", name, "Tool is not available.", true), result);
        }
        Assert.Empty(store.Rows("SELECT * FROM intents"));
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
        Assert.Equal("after\n", File.ReadAllText(fixture.Local("repo/README.md")));
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
        var handle = nint.Parse(File.ReadAllText(fixture.Local("repo/handle.txt")), System.Globalization.CultureInfo.InvariantCulture);
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
            ["updatedAt"] = "2026-01-02T03:04:05.678Z", ["tokenBudget"] = 100000d, ["usedTokens"] = 0d, ["mode"] = "coding", ["workspaceKind"] = "git", ["projectPath"] = fixture.Local("repo"),
            ["worktreePath"] = fixture.Local("repo"), ["branch"] = "codex/tools", ["baseCommit"] = new string('0', 40),
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
