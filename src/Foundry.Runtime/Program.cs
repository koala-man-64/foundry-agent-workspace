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
Task? writer = null;
using var inputStop = new CancellationTokenSource();
var pending = new List<Task>();
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
    store = await loop.Invoke(() => Task.FromResult(new Store(loop, directory, applicationRoot)));
    var output = Channel.CreateBounded<string>(new BoundedChannelOptions(64) { SingleReader = true, SingleWriter = false });
    writer = WriteOutput();
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
        if (await Task.WhenAny(reading, writer) == writer) { await writer; throw new IOException("Output closed before input ended."); }
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
                var requestId = "invalid";
                object response;
                try
                {
                    var envelope = (Dictionary<string, object?>)Contracts.Validate("frame rpc request", WireJson.Parse(line))!;
                    requestId = (string)envelope["id"]!;
                    var request = WireJson.Request(envelope);
                    if (request.Method != "workspace.summary") throw new NotSupportedException("This operation is not implemented in the P1 development runtime.");
                    response = new { jsonrpc = "2.0", id = requestId, result = store.Summary() };
                }
                catch (JsonException) { response = new { jsonrpc = "2.0", id = requestId, error = new RpcError(-32000, "Invalid request.") }; }
                catch (NotSupportedException error) { response = new { jsonrpc = "2.0", id = requestId, error = new RpcError(-32000, error.Message) }; }
                catch (WorkspaceReadException error) { response = new { jsonrpc = "2.0", id = requestId, error = new RpcError(-32000, error.Message) }; }
                catch (InvalidOperationException) { response = new { jsonrpc = "2.0", id = requestId, error = new RpcError(-32000, "Runtime request failed.") }; }
                var text = JsJson.Stringify(response)!;
                if (Encoding.UTF8.GetByteCount(text) > WireJson.MaximumBytes)
                    text = JsJson.Stringify(new { jsonrpc = "2.0", id = requestId, error = new RpcError(-32001, "The result exceeds the display limit. Retained data has not been deleted.") })!;
                await output.Writer.WriteAsync(text);
                return 0;
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
    try { await DuringShutdown(loop.Drain(() => store?.Dispose())); await DuringShutdown(loop.DisposeAsync().AsTask()); } catch (Exception) { }
    try { await DuringShutdown(Task.WhenAll(pending)); } catch (Exception) { }
    if (writer?.IsCompleted == true) try { await writer; } catch (Exception) { }
    // A failed or timed-out drain is never described as clean shutdown.
    return 1;
}
