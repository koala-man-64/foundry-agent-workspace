using System.Text.Json;
using Foundry.Platform;

// Only this disposable executable is launched by process tests. It never calls a provider or opens application data.
if (args is ["tree", var marker])
{
    var application = Environment.ProcessPath ?? throw new InvalidOperationException("Missing fixture executable.");
    var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    foreach (System.Collections.DictionaryEntry item in Environment.GetEnvironmentVariables()) environment[(string)item.Key] = (string)item.Value!;
    using var child = JobProcess.Start(new(application, $"\"{application}\" child", Environment.CurrentDirectory, environment));
    var stagedMarker = marker + ".pending";
    await File.WriteAllTextAsync(stagedMarker, $"{Environment.ProcessId},{child.ProcessId}");
    File.Move(stagedMarker, marker); // Publish only after the writer is closed, so the reader cannot race a sharing lock.
    await Task.Delay(Timeout.InfiniteTimeSpan);
    return;
}
if (args is ["child"])
{
    await Task.Delay(Timeout.InfiniteTimeSpan);
    return;
}
if (args is ["stderr"])
{
    await Console.Error.WriteAsync(new string('x', 128 * 1024));
    await Console.Error.FlushAsync();
    await Task.Delay(Timeout.InfiniteTimeSpan);
    return;
}
var backend = args.SingleOrDefault() ?? "codex";
while (await Console.In.ReadLineAsync() is { } line)
{
    using var document = JsonDocument.Parse(line);
    var message = document.RootElement;
    if (backend == "claude")
    {
        await EmitAsync(new { type = "system", subtype = "init", session_id = "fixture-claude", model = "fixture-model", tools = Array.Empty<string>(), mcp_servers = Array.Empty<string>() });
        await EmitAsync(new { type = "assistant", session_id = "fixture-claude", message = new { id = "message-1", content = new[] { new { type = "text", text = "fixture response" } } } });
        await EmitAsync(new { type = "result", session_id = "fixture-claude", subtype = "success", is_error = false, result = "fixture response", usage = new { input_tokens = 3, output_tokens = 2 } });
        return;
    }
    var method = message.GetProperty("method").GetString();
    if (method == "initialized") continue;
    var id = message.GetProperty("id");
    switch (method)
    {
        case "initialize": await EmitAsync(new { id, result = new { userAgent = "fixture" } }); break;
        case "config/read": await EmitAsync(new { id, result = new { config = new { } } }); break;
        case "thread/start": await EmitAsync(new { id, result = new { thread = new { id = "fixture-codex" }, cwd = message.GetProperty("params").GetProperty("cwd").GetString(), model = "fixture-model", approvalPolicy = "never", sandbox = new { type = "readOnly", networkAccess = false } } }); break;
        case "turn/start":
            await EmitAsync(new { method = "turn/started", @params = new { turn = new { id = "turn-1" } } });
            await EmitAsync(new { id, result = new { turn = new { id = "turn-1" } } });
            await EmitAsync(new { method = "item/agentMessage/delta", @params = new { threadId = "fixture-codex", turnId = "turn-1", delta = "fixture response" } });
            await EmitAsync(new { method = "thread/tokenUsage/updated", @params = new { threadId = "fixture-codex", tokenUsage = new { total = new { inputTokens = 3, outputTokens = 2 } } } });
            await EmitAsync(new { method = "turn/completed", @params = new { turn = new { id = "turn-1", status = "completed" } } });
            break;
        default: throw new InvalidDataException("Unexpected fixture method.");
    }
}

static async Task EmitAsync(object message) { await Console.Out.WriteLineAsync(JsonSerializer.Serialize(message)); await Console.Out.FlushAsync(); }
