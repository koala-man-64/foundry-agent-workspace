using System.Text;
using System.Text.Json;

namespace Foundry.CliDrivers;

/// <summary>
/// One print-mode stream-json operation. Model and resume selection are launch-time settings, not user-message fields.
/// The supplied connection must already have that configuration; preparation never starts an installed Claude binary.
/// </summary>
public sealed class ClaudeCodeCliDriver
{
    private readonly ICliConnection connection;
    private readonly DriverOperation operation;

    public ClaudeCodeCliDriver(ICliConnection connection, CliLimits? limits = null)
    {
        this.connection = connection ?? throw new ArgumentNullException(nameof(connection));
        operation = new(connection, limits);
    }

    public Task<CliTurnResult> RunAsync(CliTurn request, CliObserver? observer = null, CancellationToken cancellationToken = default)
    {
        DriverOperation.ValidateTurn(request, CliBackend.ClaudeCode);
        return operation.ExecuteAsync(async token =>
        {
            operation.InferenceSent = true;
            await connection.WriteAsync(new { type = "user", message = new { role = "user", content = request.Prompt } }, token).ConfigureAwait(false);
            string? sessionId = null, model = null, activeMessage = null;
            var partials = new Dictionary<string, StringBuilder>(StringComparer.Ordinal);
            var snapshots = new Dictionary<string, string>(StringComparer.Ordinal);
            var observedText = false;
            var retainedTextBytes = 0;
            int? blockIndex = null;
            string? blockType = null;
            var nextBlockIndex = 0;
            while (true)
            {
                var message = await connection.ReadAsync(token).ConfigureAwait(false) ?? throw new IOException("Claude ended without a final result.");
                var type = DriverOperation.String(message, "type");
                if (message.TryGetProperty("parent_tool_use_id", out var parent) && parent.ValueKind != JsonValueKind.Null)
                    throw operation.Fail(CliFailure.Incompatible, "Native child sessions are not admitted in preparation.");
                if (type == "control_request")
                {
                    var requestId = DriverOperation.String(message, "request_id");
                    await connection.WriteAsync(new { type = "control_response", response = new { subtype = "error", request_id = requestId, error = "Client capability is not admitted." } }, token).ConfigureAwait(false);
                    throw operation.Fail(CliFailure.Incompatible, "Claude control request was denied; preparation grants no execution authority.");
                }
                if (type == "system" && DriverOperation.String(message, "subtype") == "init")
                {
                    if (sessionId is not null) throw new InvalidDataException("Duplicate Claude initialization.");
                    sessionId = DriverOperation.String(message, "session_id");
                    model = DriverOperation.String(message, "model");
                    if (request.Resume is { } resume && resume.Id != sessionId) throw new InvalidDataException("Claude resumed another session.");
                    if (!message.TryGetProperty("tools", out var tools) || tools.ValueKind != JsonValueKind.Array || tools.GetArrayLength() != 0 ||
                        !message.TryGetProperty("mcp_servers", out var servers) || servers.ValueKind != JsonValueKind.Array || servers.GetArrayLength() != 0 ||
                        message.TryGetProperty("plugins", out var plugins) && (plugins.ValueKind != JsonValueKind.Array || plugins.GetArrayLength() != 0))
                        throw operation.Fail(CliFailure.Incompatible, "Tool-bearing or plugin-bearing Claude sessions are not admitted in preparation.");
                    await operation.NotifyAsync(new CliModelReported(model), observer, token).ConfigureAwait(false);
                    continue;
                }
                if (sessionId is null) throw operation.Fail(CliFailure.Incompatible, "Claude emitted activity before a compatible initialization.");
                if (!message.TryGetProperty("session_id", out _) || DriverOperation.String(message, "session_id") != sessionId)
                    throw new InvalidDataException("Cross-session Claude event rejected.");
                switch (type)
                {
                    case "stream_event":
                        var streamEvent = message.GetProperty("event");
                        switch (DriverOperation.String(streamEvent, "type"))
                        {
                            case "message_start":
                                if (activeMessage is not null) throw new InvalidDataException("Overlapping Claude messages.");
                                activeMessage = DriverOperation.String(streamEvent.GetProperty("message"), "id");
                                nextBlockIndex = 0;
                                if (snapshots.ContainsKey(activeMessage) || !partials.TryAdd(activeMessage, new())) throw new InvalidDataException("Duplicate Claude message.");
                                if (partials.Count > 1000) throw new InvalidDataException("Too many Claude messages.");
                                break;
                            case "content_block_start":
                                if (activeMessage is null || blockIndex is not null || DriverOperation.Count(streamEvent, "index") != nextBlockIndex)
                                    throw new InvalidDataException("Invalid Claude block start.");
                                blockIndex = nextBlockIndex;
                                blockType = DriverOperation.String(streamEvent.GetProperty("content_block"), "type");
                                if (blockType is not ("text" or "thinking" or "redacted_thinking"))
                                    throw operation.Fail(CliFailure.Incompatible, "Claude tool calls are not admitted in preparation.");
                                if (blockType == "text")
                                {
                                    var initial = streamEvent.GetProperty("content_block").GetProperty("text").GetString() ?? throw new InvalidDataException("Invalid initial block text.");
                                    await operation.TextAsync(initial, observer, token).ConfigureAwait(false);
                                    retainedTextBytes = checked(retainedTextBytes + Encoding.UTF8.GetByteCount(initial));
                                    if (retainedTextBytes > 256 * 1024) throw new InvalidDataException("Retained Claude text exceeded its limit.");
                                    partials[activeMessage].Append(initial);
                                    observedText |= initial.Length != 0;
                                }
                                break;
                            case "content_block_delta":
                                if (activeMessage is null || blockIndex is null || DriverOperation.Count(streamEvent, "index") != blockIndex)
                                    throw new InvalidDataException("Claude delta has no matching open block.");
                                var delta = streamEvent.GetProperty("delta");
                                if (DriverOperation.String(delta, "type") == "text_delta")
                                {
                                    if (blockType != "text") throw new InvalidDataException("Text delta on a non-text block.");
                                    var text = delta.GetProperty("text").GetString() ?? throw new InvalidDataException("Invalid Claude text delta.");
                                    retainedTextBytes = checked(retainedTextBytes + Encoding.UTF8.GetByteCount(text));
                                    if (retainedTextBytes > 256 * 1024) throw new InvalidDataException("Retained Claude text exceeded its limit.");
                                    await operation.TextAsync(text, observer, token).ConfigureAwait(false);
                                    partials[activeMessage].Append(text);
                                    observedText |= text.Length != 0;
                                }
                                else if (blockType != "thinking" || DriverOperation.String(delta, "type") is not ("thinking_delta" or "signature_delta"))
                                    throw operation.Fail(CliFailure.Incompatible, "Unsupported Claude content delta.");
                                break;
                            case "content_block_stop":
                                if (activeMessage is null || blockIndex is null || DriverOperation.Count(streamEvent, "index") != blockIndex)
                                    throw new InvalidDataException("Claude stopped an inactive or mismatched block.");
                                blockIndex = null; blockType = null; nextBlockIndex++;
                                break;
                            case "message_delta":
                                if (activeMessage is null || blockIndex is not null) throw new InvalidDataException("Claude message update has an unfinished block.");
                                break;
                            case "message_stop":
                                if (activeMessage is null || blockIndex is not null) throw new InvalidDataException("Claude stopped an inactive message or unfinished block.");
                                activeMessage = null;
                                break;
                            default:
                                throw operation.Fail(CliFailure.Incompatible, "Unsupported Claude stream event.");
                        }
                        break;
                    case "assistant":
                        if (activeMessage is not null) throw new InvalidDataException("Claude snapshot arrived before its stream finished.");
                        if (message.TryGetProperty("error", out var assistantError) && assistantError.ValueKind != JsonValueKind.Null)
                            throw operation.Fail(CliFailure.ProviderRejected, "Claude reported an assistant error.");
                        var assistant = message.GetProperty("message");
                        var id = DriverOperation.String(assistant, "id");
                        var complete = new StringBuilder();
                        foreach (var block in assistant.GetProperty("content").EnumerateArray())
                        {
                            var snapshotType = DriverOperation.String(block, "type");
                            if (snapshotType == "text") complete.Append(block.GetProperty("text").GetString() ?? throw new InvalidDataException("Invalid assistant text."));
                            else if (snapshotType is not ("thinking" or "redacted_thinking"))
                                throw operation.Fail(CliFailure.Incompatible, "Claude tool calls are not admitted in preparation.");
                        }
                        var fullText = complete.ToString();
                        if (snapshots.TryGetValue(id, out var prior))
                        {
                            if (prior != fullText) throw new InvalidDataException("Conflicting Claude assistant snapshots.");
                            break;
                        }
                        if (snapshots.Count >= 1000) throw new InvalidDataException("Too many assistant snapshots.");
                        if (partials.TryGetValue(id, out var partial))
                        {
                            if (partial.ToString() != fullText) throw new InvalidDataException("Claude text stream disagrees with its snapshot.");
                        }
                        else
                        {
                            await operation.TextAsync(fullText, observer, token).ConfigureAwait(false);
                            retainedTextBytes = checked(retainedTextBytes + Encoding.UTF8.GetByteCount(fullText));
                            if (retainedTextBytes > 256 * 1024) throw new InvalidDataException("Retained Claude text exceeded its limit.");
                        }
                        snapshots.Add(id, fullText);
                        observedText |= fullText.Length != 0;
                        break;
                    case "result":
                        if (activeMessage is not null) throw new InvalidDataException("Claude result interrupted a message.");
                        if (DriverOperation.String(message, "subtype") != "success" || !message.TryGetProperty("is_error", out var isError) || isError.ValueKind != JsonValueKind.False)
                            throw operation.Fail(CliFailure.ProviderRejected, "Claude did not confirm successful completion.");
                        if (message.TryGetProperty("permission_denials", out var denials) && (denials.ValueKind != JsonValueKind.Array || denials.GetArrayLength() != 0))
                            throw operation.Fail(CliFailure.Incompatible, "Claude reported a denied tool operation.");
                        string? finalText = null;
                        if (!observedText && message.TryGetProperty("result", out var result))
                            finalText = result.GetString() ?? throw new InvalidDataException("Invalid final Claude text.");
                        CliUsage? usage = null;
                        if (message.TryGetProperty("usage", out var tokens) && tokens.ValueKind != JsonValueKind.Null)
                        {
                            // Anthropic input_tokens excludes cache tokens. Ignore assistant usage/modelUsage/cumulative cost to avoid double charging.
                            usage = DriverOperation.CheckedUsage(checked(DriverOperation.Count(tokens, "input_tokens") + DriverOperation.Count(tokens, "cache_read_input_tokens", true) + DriverOperation.Count(tokens, "cache_creation_input_tokens", true)), DriverOperation.Count(tokens, "output_tokens"));
                        }
                        var confirmed = new CliTurnResult(new(CliBackend.ClaudeCode, sessionId, request.Model), model, usage);
                        operation.ConfirmTurn(confirmed);
                        if (finalText is not null) await operation.TextAsync(finalText, observer, token).ConfigureAwait(false);
                        if (usage is not null) await operation.UsageAsync(usage, observer, token).ConfigureAwait(false);
                        return confirmed;
                    case "system" when DriverOperation.String(message, "subtype") == "status":
                        break;
                    default:
                        throw operation.Fail(CliFailure.Incompatible, "Unsupported Claude message; no continuation was attempted.");
                }
            }
        }, cancellationToken);
    }
}
