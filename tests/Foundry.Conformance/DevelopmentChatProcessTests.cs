using System.Diagnostics;
using System.Text;
using Foundry.Protocol;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

public sealed class DevelopmentChatProcessTests
{
    private static string Root
    {
        get
        {
            for (var root = new DirectoryInfo(AppContext.BaseDirectory); root is not null; root = root.Parent)
                if (File.Exists(Path.Combine(root.FullName, "Foundry.slnx"))) return root.FullName;
            throw new InvalidOperationException("Missing development runtime.");
        }
    }
    private static Process Start(string directory, bool chatEnabled = true)
    {
        var info = new ProcessStartInfo(Path.Combine(Root, "src/Foundry.Runtime/bin/Release/net10.0-windows/Foundry.Runtime.exe"))
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
        };
        info.Environment["FOUNDRY_WORKSPACE_DATA"] = directory; info.Environment["FOUNDRY_RUNTIME_P2_CHAT"] = chatEnabled ? "1" : "0";
        return Process.Start(info) ?? throw new InvalidOperationException("Runtime did not start.");
    }
    private static Dictionary<string, object?> StartParameters(string content = "Hello 😀", string requestId = "88888888-0000-4000-8000-000000000001") => new()
    {
        ["requestId"] = requestId, ["projectId"] = null, ["content"] = content, ["profileId"] = Store.FakeProfileId, ["mode"] = "chat"
    };
    private static string Frame(string id, string method, object parameters) => JsJson.Stringify(new { jsonrpc = "2.0", id, method, @params = parameters })! + "\n";
    private static async Task Send(Process process, string frame, int fragment = 0)
    {
        var bytes = Encoding.UTF8.GetBytes(frame);
        if (fragment == 0) fragment = bytes.Length;
        for (var offset = 0; offset < bytes.Length; offset += fragment)
            await process.StandardInput.BaseStream.WriteAsync(bytes.AsMemory(offset, Math.Min(fragment, bytes.Length - offset)), TestContext.Current.CancellationToken);
        await process.StandardInput.BaseStream.FlushAsync(TestContext.Current.CancellationToken);
    }
    private static async Task<Dictionary<string, object?>> Reply(Process process, string id, List<Dictionary<string, object?>> events)
        => (await Replies(process, [id], events))[id];

    private static async Task<Dictionary<string, Dictionary<string, object?>>> Replies(Process process, string[] ids, List<Dictionary<string, object?>> events)
    {
        var replies = new Dictionary<string, Dictionary<string, object?>>(StringComparer.Ordinal);
        for (var index = 0; index < 500; index++)
        {
            var line = await process.StandardOutput.ReadLineAsync(TestContext.Current.CancellationToken).AsTask().WaitAsync(TimeSpan.FromSeconds(15), TestContext.Current.CancellationToken);
            Assert.NotNull(line);
            var frame = (Dictionary<string, object?>)PersistedJson.Parse(line)!;
            if (Equals(frame.GetValueOrDefault("method"), "workspace.event"))
            {
                Contracts.Validate("frame workspace.event", frame); events.Add((Dictionary<string, object?>)frame["params"]!); continue;
            }
            Contracts.Validate("frame rpc response", frame);
            var id = Assert.IsType<string>(frame["id"]);
            Assert.Contains(id, ids);
            Assert.True(replies.TryAdd(id, frame), "Duplicate response ID.");
            if (replies.Count == ids.Length) return replies;
        }
        throw new InvalidOperationException("Missing bounded response.");
    }
    private static async Task Exit(Process process, Task<string> error)
    {
        process.StandardInput.Close();
        await process.WaitForExitAsync(TestContext.Current.CancellationToken).WaitAsync(TimeSpan.FromSeconds(15), TestContext.Current.CancellationToken);
        Assert.Equal(0, process.ExitCode); Assert.Empty(await error);
    }
    private static async Task KillIfNeeded(Process process)
    {
        if (!process.HasExited) { process.Kill(true); await process.WaitForExitAsync(TestContext.Current.CancellationToken); }
    }

    [Fact]
    public async Task FragmentedUnicodeCreateReadSendAndIdempotenceWorkOverStdio()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-stdio-chat-").FullName;
        try
        {
            using var process = Start(scratch); var error = process.StandardError.ReadToEndAsync(TestContext.Current.CancellationToken); var events = new List<Dictionary<string, object?>>();
            try
            {
                var parameters = StartParameters(); await Send(process, Frame("start", "task.start", parameters), 1);
                var first = await Reply(process, "start", events); var task = (Dictionary<string, object?>)first["result"]!; var taskId = (string)task["id"]!;
                await Send(process, Frame("retry", "task.start", parameters));
                Assert.Equal(taskId, ((Dictionary<string, object?>)(await Reply(process, "retry", events))["result"]!)["id"]);
                for (var attempt = 0; ; attempt++)
                {
                    Assert.True(attempt < 200); await Send(process, Frame("read", "task.read", new { taskId }));
                    var read = (Dictionary<string, object?>)(await Reply(process, "read", events))["result"]!;
                    if (Equals(((Dictionary<string, object?>)read["task"]!)["status"], "idle")) break;
                }
                await Send(process, Frame("messages", "task.messages", new { taskId }));
                var page = (Dictionary<string, object?>)(await Reply(process, "messages", events))["result"]!;
                var items = ((List<object?>)page["items"]!).Cast<Dictionary<string, object?>>().Select(item => (Dictionary<string, object?>)item["message"]!).ToArray();
                Assert.Equal(2, items.Length); Assert.Equal("Fake response: Hello 😀", items.Single(item => Equals(item["role"], "assistant"))["content"]);
                await Send(process, Frame("send", "task.send", new { taskId, content = "second" }));
                Assert.Equal(true, ((Dictionary<string, object?>)(await Reply(process, "send", events))["result"]!)["accepted"]);
                await Exit(process, error);
                Assert.Contains(events, item => Equals(item["type"], "task.started"));
                Assert.DoesNotContain(events, item => Equals(item["type"], "task.created") || Equals(item["type"], "message.completed"));
                Assert.Contains(events, item => Equals(item["sequence"], 0d) && Equals(item["type"], "task.progress"));
            }
            finally { await KillIfNeeded(process); }
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task CancellationAndEofDrainReleaseSQLiteAndRetainPartialAnswer()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-stdio-cancel-").FullName;
        try
        {
            using var process = Start(scratch); var error = process.StandardError.ReadToEndAsync(TestContext.Current.CancellationToken); var events = new List<Dictionary<string, object?>>(); string taskId;
            try
            {
                await Send(process, Frame("start", "task.start", StartParameters(new string('a', 8000))));
                taskId = (string)((Dictionary<string, object?>)(await Reply(process, "start", events))["result"]!)["id"]!;
                await Send(process, Frame("cancel", "task.cancel", new { taskId }));
                Assert.Equal(true, ((Dictionary<string, object?>)(await Reply(process, "cancel", events))["result"]!)["accepted"]);
                await Exit(process, error);
            }
            finally { await KillIfNeeded(process); }
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"));
                Assert.Equal("cancelled", store.ReadTask(taskId)["status"]);
                Assert.Equal("cancelled", store.Rows("SELECT outcome FROM provider_requests").Single()["outcome"]);
                Assert.Equal(2, store.MessagesWithOrdinals(taskId).Count);
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task UnsupportedSettingsAndBadInputCannotCreateTasks()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-stdio-denial-").FullName;
        try
        {
            using var process = Start(scratch); var error = process.StandardError.ReadToEndAsync(TestContext.Current.CancellationToken); var events = new List<Dictionary<string, object?>>();
            try
            {
                var unsupported = StartParameters(); unsupported["mode"] = "coding";
                await Send(process, Frame("unsupported", "task.start", unsupported) + Frame("invalid", "task.start", new { secret = "must not log this" }));
                var replies = await Replies(process, ["unsupported", "invalid"], events);
                Assert.Equal(-32000d, ((Dictionary<string, object?>)replies["unsupported"]["error"]!)["code"]);
                Assert.Equal("Invalid request.", ((Dictionary<string, object?>)replies["invalid"]["error"]!)["message"]);
                await Exit(process, error); Assert.Empty(events);
            }
            finally { await KillIfNeeded(process); }
            await using var loop = new RuntimeLoop(); await loop.Invoke(() => { using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root")); Assert.Equal(0L, store.Scalar("SELECT COUNT(*) FROM tasks")); Assert.Equal(0L, store.Scalar("SELECT COUNT(*) FROM task_starts")); return Task.FromResult(0); });
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task ImmediateEofObservesEveryAdmittedResponseAndReleasesState()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-stdio-eof-").FullName;
        try
        {
            using var process = Start(scratch); var error = process.StandardError.ReadToEndAsync(TestContext.Current.CancellationToken);
            var output = process.StandardOutput.ReadToEndAsync(TestContext.Current.CancellationToken);
            try
            {
                var frames = string.Concat(Enumerable.Range(1, 8).Select(n => Frame($"start-{n}", "task.start", StartParameters(new string('a', 8000), $"88888888-0000-4000-8000-{n:000000000000}"))));
                await Send(process, frames); await Exit(process, error);
                var responses = new HashSet<string>(StringComparer.Ordinal);
                foreach (var line in (await output).Split('\n', StringSplitOptions.RemoveEmptyEntries))
                {
                    var frame = (Dictionary<string, object?>)PersistedJson.Parse(line)!;
                    if (frame.ContainsKey("method")) { Contracts.Validate("frame workspace.event", frame); continue; }
                    Contracts.Validate("frame rpc response", frame); Assert.True(responses.Add((string)frame["id"]!));
                }
                Assert.Equal(Enumerable.Range(1, 8).Select(n => $"start-{n}").Order(), responses.Order());
            }
            finally { await KillIfNeeded(process); }
            await using var loop = new RuntimeLoop(); await loop.Invoke(() =>
            {
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"));
                Assert.Equal(0L, store.Scalar("SELECT COUNT(*) FROM tasks WHERE status='running'"));
                Assert.Equal(0L, store.Scalar("SELECT COUNT(*) FROM provider_requests WHERE finished_at IS NULL"));
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Theory]
    [InlineData(false, false), InlineData(true, false), InlineData(false, true), InlineData(true, true)]
    public async Task UnexpectedHandlerFailureStopsPromptlyWhileInputRemainsOpen(bool chatEnabled, bool malformedJson)
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-stdio-handler-fault-").FullName;
        try
        {
            await using (var loop = new RuntimeLoop()) await loop.Invoke(() =>
            {
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"));
                store.Execute("INSERT INTO profiles(id,data) VALUES('99999999-0000-4000-8000-000000000001',$p0)", malformedJson ? "{" : "[]");
                return Task.FromResult(0);
            });
            using var process = Start(scratch, chatEnabled); var error = process.StandardError.ReadToEndAsync(TestContext.Current.CancellationToken);
            try
            {
                await Send(process, Frame("warm", "profile.read", new { profileId = Store.FakeProfileId }));
                await Reply(process, "warm", []); Assert.False(process.HasExited);
                await Send(process, Frame("failure", "workspace.summary", new { }) + Frame("queued", "task.start", StartParameters()));
                // Keep stdin open: the old loop could wait indefinitely for more
                // frames before observing an unexpected handler exception.
                await process.WaitForExitAsync(TestContext.Current.CancellationToken).WaitAsync(TimeSpan.FromSeconds(15), TestContext.Current.CancellationToken);
                Assert.Equal(1, process.ExitCode); Assert.Equal("Runtime failed unexpectedly; restart to reconcile retained state.", (await error).Trim());
                Assert.Empty(await process.StandardOutput.ReadToEndAsync(TestContext.Current.CancellationToken));
            }
            finally { await KillIfNeeded(process); }
            await using (var loop = new RuntimeLoop()) await loop.Invoke(() =>
            {
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"));
                Assert.Equal(0L, store.Scalar("SELECT COUNT(*) FROM tasks"));
                Assert.Equal(0L, store.Scalar("SELECT COUNT(*) FROM provider_requests"));
                Assert.Equal(malformedJson ? "{" : "[]", store.Scalar("SELECT data FROM profiles WHERE id='99999999-0000-4000-8000-000000000001'"));
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task CompactionContentIsBoundedAndOwnedOverStdio()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-stdio-compaction-").FullName;
        const string taskId = "12121212-0000-4000-8000-000000000001";
        const string compactionId = "12121212-0000-4000-8000-000000000204";
        try
        {
            await using (var loop = new RuntimeLoop()) await loop.Invoke(() =>
            {
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"));
                store.SaveTask(new Dictionary<string, object?> { ["id"] = taskId, ["title"] = "Retained", ["profileId"] = Store.FakeProfileId, ["status"] = "idle", ["mode"] = "chat", ["workspaceKind"] = "none", ["createdAt"] = "2026-01-02T03:04:05.678Z", ["updatedAt"] = "2026-01-02T03:04:05.678Z", ["tokenBudget"] = 100000, ["usedTokens"] = 0 });
                store.Execute("INSERT INTO compactions(id,task_id,from_ordinal,to_ordinal,message_ids,summary,estimated_before,estimated_after,provider_state_before,provider_state_after,created_at) VALUES($p0,$p1,1,3,'[]',$p2,10000,2000,'{\"opaque\":\"before\"}','{\"opaque\":\"after\"}','2026-01-02T03:04:05.678Z')", compactionId, taskId, "A😀éB");
                return Task.FromResult(0);
            });
            using var process = Start(scratch); var error = process.StandardError.ReadToEndAsync(TestContext.Current.CancellationToken);
            try
            {
                await Send(process, Frame("list", "task.compactions", new { taskId, limit = 1 }) + Frame("content", "task.compactionContent", new { taskId, compactionId, offset = 1, maxBytes = 1 }) + Frame("denied", "task.compactionContent", new { taskId = "12121212-0000-4000-8000-000000000004", compactionId }), 3);
                var replies = await Replies(process, ["list", "content", "denied"], []);
                var list = JsJson.Stringify(replies["list"]["result"])!;
                Assert.Contains("A😀éB", list); Assert.DoesNotContain("opaque", list);
                var content = (Dictionary<string, object?>)replies["content"]["result"]!;
                Assert.Equal("😀", content["content"]); Assert.Equal(1d, content["offset"]); Assert.Equal(5d, content["nextOffset"]);
                Assert.Equal("Compaction not found in this task.", ((Dictionary<string, object?>)replies["denied"]["error"]!)["message"]);
                await Exit(process, error);
            }
            finally { await KillIfNeeded(process); }
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task NulInRendererPathsIsRefusedWhileTheRuntimeKeepsServing()
    {
        using var fixture = RepositoryFixture.Create("foundry-p2-stdio-nul-");
        fixture.Write("plain/notes.txt", "notes\n"); fixture.Write("plain/sub/b.txt", "b\n");
        var data = Directory.CreateDirectory(fixture.Local("data")).FullName;
        const string Folder = "21212121-0000-4000-8000-000000000011";
        await using (var loop = new RuntimeLoop())
        {
            await loop.Invoke(() =>
            {
                using var store = new Store(loop, data, Path.Combine(fixture.Scratch, "injected-root"));
                store.SaveTask(new()
                {
                    ["id"] = Folder, ["title"] = "Seeded", ["profileId"] = Store.FakeProfileId, ["status"] = "idle", ["createdAt"] = "2026-01-02T03:04:05.678Z",
                    ["updatedAt"] = "2026-01-02T03:04:05.678Z", ["tokenBudget"] = 100000, ["usedTokens"] = 0, ["mode"] = "chat", ["workspaceKind"] = "folder", ["projectPath"] = fixture.Local("plain"),
                });
                return Task.FromResult(0);
            });
        }
        var info = new ProcessStartInfo(Path.Combine(Root, "src/Foundry.Runtime/bin/Release/net10.0-windows/Foundry.Runtime.exe"))
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
        };
        info.Environment["FOUNDRY_WORKSPACE_DATA"] = data; info.Environment["FOUNDRY_RUNTIME_P2_CHAT"] = "1";
        foreach (var (name, value) in fixture.Isolation) info.Environment[name] = value;
        using var process = Process.Start(info)!;
        var error = process.StandardError.ReadToEndAsync(TestContext.Current.CancellationToken);
        try
        {
            var events = new List<Dictionary<string, object?>>();
            // Each request is answered (so a crash would surface here), then the runtime must still serve a valid request.
            string[] ids = ["middle", "final", "list", "project"];
            await Send(process, Frame("middle", "files.read", new { taskId = Folder, path = "sub\0x/b.txt" })
                + Frame("final", "files.read", new { taskId = Folder, path = "notes.txt\0zzz" })
                + Frame("list", "files.list", new { taskId = Folder, path = "sub\0x" })
                + Frame("project", "project.add", new { path = fixture.Local("pla\0in") }));
            var replies = await Replies(process, ids, events);
            foreach (var id in ids) Assert.True(replies[id].ContainsKey("error"), $"{id} was not refused.");
            await Send(process, Frame("after", "files.read", new { taskId = Folder, path = "notes.txt" }));
            Assert.Equal("notes\n", ((Dictionary<string, object?>)(await Reply(process, "after", events))["result"]!)["content"]);
            Assert.Empty(events);
            await Exit(process, error);
        }
        finally { await KillIfNeeded(process); }
    }

    [Fact]
    public async Task GitAndFileHandlersAnswerOverStdioWithRedactedContentAndRefusals()
    {
        const string Secret = "sk-abcdefghijklmnopqrstuvwx";
        using var fixture = RepositoryFixture.Create("foundry-p2-stdio-files-");
        fixture.Write("plain/notes.txt", $"token {Secret}\n"); fixture.Write("plain/sub/b.txt", "b\n");
        fixture.Write("repo/README.md", "hello\n");
        await fixture.Git("-C", "repo", "init", "-q"); await fixture.Git("-C", "repo", "add", "-A"); await fixture.Git("-C", "repo", "commit", "-qm", "fixture");
        fixture.Write("repo/README.md", $"hello\nchanged {Secret}\n");
        var data = Directory.CreateDirectory(fixture.Local("data")).FullName;
        const string Folder = "21212121-0000-4000-8000-000000000001", Git = "21212121-0000-4000-8000-000000000002", Missing = "21212121-0000-4000-8000-000000000003";
        await using (var loop = new RuntimeLoop())
        {
            await loop.Invoke(() =>
            {
                using var store = new Store(loop, data, Path.Combine(fixture.Scratch, "injected-root"));
                var stamp = "2026-01-02T03:04:05.678Z";
                Dictionary<string, object?> Seed(string id) => new()
                {
                    ["id"] = id, ["title"] = "Seeded", ["profileId"] = Store.FakeProfileId, ["status"] = "idle", ["createdAt"] = stamp, ["updatedAt"] = stamp,
                    ["tokenBudget"] = 100000, ["usedTokens"] = 0, ["mode"] = "chat",
                };
                store.SaveTask(new(Seed(Folder)) { ["workspaceKind"] = "folder", ["projectPath"] = fixture.Local("plain") });
                store.SaveTask(new(Seed(Git)) { ["workspaceKind"] = "git", ["projectPath"] = fixture.Local("repo"), ["worktreePath"] = fixture.Local("repo"), ["branch"] = "main", ["baseCommit"] = new string('0', 40) });
                return Task.FromResult(0);
            });
        }
        var info = new ProcessStartInfo(Path.Combine(Root, "src/Foundry.Runtime/bin/Release/net10.0-windows/Foundry.Runtime.exe"))
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
        };
        info.Environment["FOUNDRY_WORKSPACE_DATA"] = data; info.Environment["FOUNDRY_RUNTIME_P2_CHAT"] = "1";
        foreach (var (name, value) in fixture.Isolation) info.Environment[name] = value;
        using var process = Process.Start(info)!;
        var error = process.StandardError.ReadToEndAsync(TestContext.Current.CancellationToken);
        try
        {
            var events = new List<Dictionary<string, object?>>();
            await Send(process, Frame("list", "files.list", new { taskId = Folder })
                + Frame("read", "files.read", new { taskId = Folder, path = "notes.txt" })
                + Frame("escape", "files.read", new { taskId = Folder, path = "../repo/README.md" })
                + Frame("folder-diff", "task.diff", new { taskId = Folder })
                + Frame("diff", "task.diff", new { taskId = Git })
                + Frame("missing", "files.list", new { taskId = Missing, path = "" }));
            var replies = await Replies(process, ["list", "read", "escape", "folder-diff", "diff", "missing"], events);
            Assert.Equal("[{\"path\":\"notes.txt\",\"kind\":\"file\"},{\"path\":\"sub\",\"kind\":\"directory\"}]", JsJson.Stringify(replies["list"]["result"]));
            var read = (Dictionary<string, object?>)replies["read"]["result"]!;
            Assert.Equal("token [REDACTED]\n", read["content"]); Assert.Equal("notes.txt", read["path"]);
            string Error(string id) => (string)((Dictionary<string, object?>)replies[id]["error"]!)["message"]!;
            Assert.Equal("Path contains a forbidden segment.", Error("escape"));
            Assert.Equal("This action requires a Git worktree.", Error("folder-diff"));
            Assert.Equal("Task not found.", Error("missing"));
            var diff = (Dictionary<string, object?>)replies["diff"]["result"]!;
            Assert.Contains("+changed [REDACTED]", (string)diff["patch"]!, StringComparison.Ordinal);
            Assert.DoesNotContain(Secret, JsJson.Stringify(replies)!, StringComparison.Ordinal);
            Assert.Equal(" README.md | 1 +\n 1 file changed, 1 insertion(+)\n", diff["summary"]); Assert.Equal(false, diff["truncated"]);
            Assert.Empty(events);
            await Exit(process, error);
        }
        finally { await KillIfNeeded(process); }
    }
}
