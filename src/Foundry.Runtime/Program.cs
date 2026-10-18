using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using System.Diagnostics;
using Foundry.Protocol;
using Foundry.Runtime;
using Foundry.Platform;

// Development foundation only. Electron still launches the TypeScript runtime.
const string Failure = "Runtime failed unexpectedly; restart to reconcile retained state.";
var directory = Environment.GetEnvironmentVariable("FOUNDRY_WORKSPACE_DATA");
if (string.IsNullOrWhiteSpace(directory)) { Console.Error.WriteLine(Failure); return 1; }
var loop = new RuntimeLoop();
Store? store = null;
DevelopmentChat? chat = null;
Task? writer = null;
using var inputStop = new CancellationTokenSource();
var pending = new List<Task>();
var requestFailure = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
long? shutdownStarted = null;
Task DuringShutdown(Task operation)
{
    shutdownStarted ??= Stopwatch.GetTimestamp();
    var remaining = TimeSpan.FromSeconds(45) - Stopwatch.GetElapsedTime(shutdownStarted.Value);
    return operation.WaitAsync(remaining > TimeSpan.Zero ? remaining : TimeSpan.Zero);
}
try
{
    var applicationRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FoundryAgentWorkspace");
    var output = Channel.CreateBounded<string>(new BoundedChannelOptions(64) { SingleReader = true, SingleWriter = false });
    writer = WriteOutput();
    var chatEnabled = Environment.GetEnvironmentVariable("FOUNDRY_RUNTIME_P2_CHAT") == "1";
    var notificationsEnabled = false;
    store = await loop.Invoke(() =>
    {
        var opened = new Store(loop, directory, applicationRoot, publish: item =>
        {
            if (!notificationsEnabled || !DevelopmentChat.SendsNotification(item)) return;
            object payload = item.Sequence == 0 ? new Dictionary<string, object?>
            {
                ["sequence"] = 0, ["type"] = item.Type, ["data"] = item.Data, ["taskId"] = item.TaskId, ["createdAt"] = item.CreatedAt
            } : item.ToWire();
            var frame = JsJson.Stringify(new { jsonrpc = "2.0", method = "workspace.event", @params = payload })!;
            if (Encoding.UTF8.GetByteCount(frame) > WireJson.MaximumBytes || !output.Writer.TryWrite(frame)) throw new IOException("Runtime notification delivery failed.");
        });
        if (chatEnabled) chat = new DevelopmentChat(loop, opened);
        notificationsEnabled = chatEnabled;
        return Task.FromResult(opened);
    });
    using var reader = new LineReader();
    var buffer = new byte[16 * 1024];
    using var input = StandardStreams.Input();
    async Task<int> ReadInput()
    {
        // A pipe read can outlive cancellation on Windows. Observe its exception in
        // this state-free transport task while writer failure wakes the main loop.
        try { return await input.ReadAsync(buffer, inputStop.Token); }
        catch (Exception) { return -1; }
    }
    while (true)
    {
        var reading = ReadInput();
        var first = chat is null ? await Task.WhenAny(reading, writer, requestFailure.Task) : await Task.WhenAny(reading, writer, chat.Failure, requestFailure.Task);
        if (first == requestFailure.Task || chat is not null && first == chat.Failure) throw new IOException("Runtime execution failed.");
        if (first == writer) { await writer; throw new IOException("Output closed before input ended."); }
        var count = await reading;
        if (count < 0) throw new IOException("Input failed.");
        if (count == 0) break;
        IReadOnlyList<byte[]> lines;
        try { lines = reader.Push(buffer.AsSpan(0, count)); }
        catch (InvalidDataException) { Console.Error.WriteLine("Oversized RPC input; runtime stopped."); break; }
        foreach (var line in lines)
        {
            if (LineReader.IsBlank(line)) continue;
            pending.Add(loop.Invoke(async () =>
            {
                try
                {
                if (requestFailure.Task.IsCompleted) throw new IOException("Runtime execution failed.");
                var requestId = "invalid";
                var parsingRequest = true;
                object response;
                try
                {
                    var envelope = (Dictionary<string, object?>)Contracts.Validate("frame rpc request", WireJson.Parse(line))!;
                    requestId = (string)envelope["id"]!;
                    var request = WireJson.Request(envelope);
                    parsingRequest = false;
                    object? result;
                    if (chat is not null) result = await chat.Dispatch(request.Method, (Dictionary<string, object?>)request.Params!);
                    else
                    {
                        if (request.Method != "workspace.summary") throw new NotSupportedException("This operation is not implemented in the P1 development runtime.");
                        result = store.Summary();
                    }
                    response = new { jsonrpc = "2.0", id = requestId, result };
                }
                catch (JsonException) when (parsingRequest) { response = new { jsonrpc = "2.0", id = requestId, error = new RpcError(-32000, "Invalid request.") }; }
                catch (NotSupportedException error) { response = new { jsonrpc = "2.0", id = requestId, error = new RpcError(-32000, error.Message) }; }
                catch (WorkspaceReadException error) { response = new { jsonrpc = "2.0", id = requestId, error = new RpcError(-32000, error.Message) }; }
                catch (InvalidOperationException error)
                {
                    var message = chat is not null && IsChatError(error.Message) ? error.Message : "Runtime request failed.";
                    response = new { jsonrpc = "2.0", id = requestId, error = new RpcError(-32000, message) };
                }
                var text = JsJson.Stringify(response)!;
                if (Encoding.UTF8.GetByteCount(text) > WireJson.MaximumBytes)
                    text = JsJson.Stringify(new { jsonrpc = "2.0", id = requestId, error = new RpcError(-32001, "The result exceeds the display limit. Retained data has not been deleted.") })!;
                await output.Writer.WriteAsync(text);
                return 0;
                }
                catch
                {
                    try { chat?.CloseAdmission(); }
                    finally { requestFailure.TrySetResult(); }
                    throw;
                }
            }));
            if (pending.Count >= 64)
            {
                await Task.WhenAny(pending);
                foreach (var done in pending.Where(task => task.IsCompleted)) await done;
                pending.RemoveAll(task => task.IsCompleted);
            }
        }
    }
    reader.Finish();
    if (chat is not null) await DuringShutdown(loop.Invoke(async () => { await chat.Shutdown(); return 0; }));
    await DuringShutdown(loop.Drain(store.Dispose));
    store = null;
    await DuringShutdown(Task.WhenAll(pending));
    output.Writer.Complete();
    await DuringShutdown(writer);
    await DuringShutdown(loop.DisposeAsync().AsTask());
    return 0;

    async Task WriteOutput()
    {
        try
        {
            using var stdout = StandardStreams.Output();
            await foreach (var text in output.Reader.ReadAllAsync())
            {
                await stdout.WriteAsync(Encoding.UTF8.GetBytes(text + "\n"));
                await stdout.FlushAsync(); // Each reply must be visible while stdin remains open.
            }
            await stdout.FlushAsync();
        }
        catch (Exception error) { output.Writer.TryComplete(error); inputStop.Cancel(); throw; }
    }
}
catch
{
    Console.Error.WriteLine(Failure);
    try { if (chat is not null) await DuringShutdown(loop.Invoke(async () => { await chat.Shutdown(); return 0; })); } catch (Exception) { }
    try { await DuringShutdown(loop.Drain(() => store?.Dispose())); await DuringShutdown(loop.DisposeAsync().AsTask()); } catch (Exception) { }
    try { await DuringShutdown(Task.WhenAll(pending)); } catch (Exception) { }
    if (writer?.IsCompleted == true) try { await writer; } catch (Exception) { }
    // A failed or timed-out drain is never described as clean shutdown.
    return 1;
}

static bool IsChatError(string message) => message is "Runtime is shutting down." or "Task not found." or "Profile not found." or "Select an existing model profile."
    or "This request ID belongs to different chat settings." or "This task already has an active response." or "Too many active tasks. Finish or cancel a task first."
    or "This task worktree is retired. Create a new task to continue the work."
    or "Wait for the Git operation to finish before starting a response."
    or "This task has an unknown mutation outcome. Check the outcome before continuing."
    or "This task has native conversation state for an earlier profile configuration. Create a new task for this configuration."
    or "This task has an unknown worktree retirement outcome. Reconcile state before starting a response."
    or "This task has an unknown publication outcome. Reconcile publication state before starting a response."
    or "Chat creation has an unknown outcome. Inspect the saved chat and retained intent before trying again with a new request."
    or "Conservative context limit reached. Compact this task from its Usage panel or create a new task."
    or "Insufficient task budget for the conservative request reservation.";
