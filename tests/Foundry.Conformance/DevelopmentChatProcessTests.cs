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
    private static Process Start(string directory)
    {
        var info = new ProcessStartInfo(Path.Combine(Root, "src/Foundry.Runtime/bin/Release/net10.0-windows/Foundry.Runtime.exe"))
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
        };
        info.Environment["FOUNDRY_WORKSPACE_DATA"] = directory; info.Environment["FOUNDRY_RUNTIME_P2_CHAT"] = "1";
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
}
