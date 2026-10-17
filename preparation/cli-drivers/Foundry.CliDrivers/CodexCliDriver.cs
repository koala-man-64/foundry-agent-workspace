using System.Text.Json;

namespace Foundry.CliDrivers;

/// <summary>One-shot app-server stdio client. Tool execution and live-launch admission are deliberately unavailable.</summary>
public sealed class CodexCliDriver
{
    private readonly ICliConnection connection;
    private readonly DriverOperation operation;
    private readonly Queue<JsonElement> notifications = new();
    private int nextId;

    public CodexCliDriver(ICliConnection connection, CliLimits? limits = null)
    {
        this.connection = connection ?? throw new ArgumentNullException(nameof(connection));
        operation = new(connection, limits);
    }

    public Task<CodexInspection> InspectAsync(CancellationToken cancellationToken = default) => operation.ExecuteAsync(async token =>
    {
        await InitializeAsync(token).ConfigureAwait(false);
        var account = await RpcAsync("account/read", new { refreshToken = false }, token).ConfigureAwait(false);
        if (!account.TryGetProperty("account", out var identity)) throw new InvalidDataException("Missing authentication status.");
        var authenticated = identity.ValueKind == JsonValueKind.Object;
        if (authenticated && DriverOperation.String(identity, "type") is not ("apiKey" or "chatgpt"))
            throw operation.Fail(CliFailure.Incompatible, "Unsupported Codex authentication mode.");
        if (!authenticated && identity.ValueKind != JsonValueKind.Null) throw new InvalidDataException("Invalid authentication status.");
        var models = new List<CliModel>();
        var modelIds = new HashSet<string>(StringComparer.Ordinal);
        var cursors = new HashSet<string>(StringComparer.Ordinal);
        string? cursor = null;
        for (var page = 0; page < 10; page++)
        {
            var result = await RpcAsync("model/list", new { cursor, limit = 50, includeHidden = false }, token).ConfigureAwait(false);
            foreach (var item in result.GetProperty("data").EnumerateArray())
            {
                var id = DriverOperation.String(item, "id");
                if (!modelIds.Add(id) || models.Count >= 500) throw new InvalidDataException("Invalid model catalog.");
                var efforts = new List<string>();
                if (item.TryGetProperty("supportedReasoningEfforts", out var supported))
                    foreach (var effort in supported.EnumerateArray()) efforts.Add(DriverOperation.String(effort, "reasoningEffort"));
                models.Add(new(id, DriverOperation.String(item, "displayName"), efforts));
            }
            if (!result.TryGetProperty("nextCursor", out var next) || next.ValueKind == JsonValueKind.Null)
                return new CodexInspection(authenticated, models);
            cursor = DriverOperation.String(result, "nextCursor");
            if (!cursors.Add(cursor)) throw new InvalidDataException("Model catalog repeated a cursor.");
        }
        throw new InvalidDataException("Model catalog exceeded its page limit.");
    }, cancellationToken);

    public Task<CliTurnResult> RunAsync(CliTurn request, CliObserver? observer = null, CancellationToken cancellationToken = default)
    {
        DriverOperation.ValidateTurn(request, CliBackend.Codex);
        return operation.ExecuteAsync(async token =>
        {
            await InitializeAsync(token).ConfigureAwait(false);
            var started = request.Resume is null
                ? await RpcAsync("thread/start", new { model = request.Model }, token).ConfigureAwait(false)
                : await RpcAsync("thread/resume", new { threadId = request.Resume.Id, model = request.Model, excludeTurns = true }, token).ConfigureAwait(false);
            var threadId = DriverOperation.String(started.GetProperty("thread"), "id");
            if (request.Resume is { } checkpoint && checkpoint.Id != threadId) throw new InvalidDataException("Resume returned another session.");
            string? reportedModel = null;
            if (started.TryGetProperty("model", out _))
            {
                reportedModel = DriverOperation.String(started, "model");
                await operation.NotifyAsync(new CliModelReported(reportedModel), observer, token).ConfigureAwait(false);
            }
            operation.InferenceSent = true;
            var turn = await RpcAsync("turn/start", new { threadId, input = new[] { new { type = "text", text = request.Prompt } } }, token).ConfigureAwait(false);
            var turnId = DriverOperation.String(turn.GetProperty("turn"), "id");
            var baseline = request.Resume is null ? new CliUsage(0, 0) : request.Resume.CumulativeUsage;
            // No update this turn means an accounting gap. Reusing the old baseline next turn would charge the gap again.
            CliUsage? cumulative = null, usage = null;
            while (true)
            {
                var message = notifications.TryDequeue(out var queued) ? queued : await RequiredAsync(token).ConfigureAwait(false);
                if (message.TryGetProperty("id", out _)) await RejectRequestAsync(message, token).ConfigureAwait(false);
                var method = DriverOperation.String(message, "method");
                var parameters = message.GetProperty("params");
                if (parameters.TryGetProperty("threadId", out _) && DriverOperation.String(parameters, "threadId") != threadId)
                    throw new InvalidDataException("Cross-session CLI event rejected.");
                if (parameters.TryGetProperty("turnId", out _) && DriverOperation.String(parameters, "turnId") != turnId)
                    throw new InvalidDataException("Cross-turn CLI event rejected.");
                switch (method)
                {
                    case "item/agentMessage/delta":
                        RequireContext(parameters, threadId, turnId);
                        var text = parameters.GetProperty("delta").GetString() ?? throw new InvalidDataException("Invalid text delta.");
                        await operation.TextAsync(text, observer, token).ConfigureAwait(false);
                        break;
                    case "thread/tokenUsage/updated":
                        if (DriverOperation.String(parameters, "threadId") != threadId) throw new InvalidDataException("Cross-session usage rejected.");
                        var total = parameters.GetProperty("tokenUsage").GetProperty("total");
                        var nextUsage = DriverOperation.CheckedUsage(DriverOperation.Count(total, "inputTokens"), DriverOperation.Count(total, "outputTokens"));
                        var previous = cumulative ?? baseline;
                        if (previous is not null && (nextUsage.InputTokens < previous.InputTokens || nextUsage.OutputTokens < previous.OutputTokens))
                            throw new InvalidDataException("Cumulative CLI usage regressed.");
                        cumulative = nextUsage;
                        if (baseline is not null)
                        {
                            usage = new(nextUsage.InputTokens - baseline.InputTokens, nextUsage.OutputTokens - baseline.OutputTokens);
                            await operation.UsageAsync(usage, observer, token).ConfigureAwait(false);
                        }
                        break;
                    case "item/started":
                    case "item/completed":
                        RequireContext(parameters, threadId, turnId);
                        if (DriverOperation.String(parameters.GetProperty("item"), "type") is not ("agentMessage" or "reasoning" or "plan" or "userMessage" or "contextCompaction"))
                            throw operation.Fail(CliFailure.Incompatible, "Native CLI tools are not admitted in preparation.");
                        break;
                    case "turn/completed":
                        if (DriverOperation.String(parameters, "threadId") != threadId) throw new InvalidDataException("Wrong completion session.");
                        var completed = parameters.GetProperty("turn");
                        if (DriverOperation.String(completed, "id") != turnId) throw new InvalidDataException("Wrong completion turn.");
                        if (DriverOperation.String(completed, "status") != "completed" ||
                            completed.TryGetProperty("error", out var error) && error.ValueKind != JsonValueKind.Null)
                            throw operation.Fail(CliFailure.ProviderRejected, "Codex did not confirm successful completion.");
                        return new CliTurnResult(new(CliBackend.Codex, threadId, request.Model, cumulative), reportedModel, usage);
                    case "thread/started":
                        if (DriverOperation.String(parameters.GetProperty("thread"), "id") != threadId) throw new InvalidDataException("Wrong started session.");
                        break;
                    case "turn/started":
                        if (DriverOperation.String(parameters, "threadId") != threadId || DriverOperation.String(parameters.GetProperty("turn"), "id") != turnId)
                            throw new InvalidDataException("Wrong started turn.");
                        break;
                    case "thread/status/changed":
                        break;
                    default:
                        throw operation.Fail(CliFailure.Incompatible, "Unsupported Codex notification; no continuation was attempted.");
                }
            }
        }, cancellationToken);
    }

    private async Task InitializeAsync(CancellationToken token)
    {
        await RpcAsync("initialize", new { clientInfo = new { name = "foundry_cli_preparation", version = "0.1.0" } }, token).ConfigureAwait(false);
        await connection.WriteAsync(new { method = "initialized" }, token).ConfigureAwait(false);
    }

    private async Task<JsonElement> RpcAsync(string method, object parameters, CancellationToken token)
    {
        var id = ++nextId;
        await connection.WriteAsync(new { id, method, @params = parameters }, token).ConfigureAwait(false);
        while (true)
        {
            var message = await RequiredAsync(token).ConfigureAwait(false);
            if (message.TryGetProperty("method", out _))
            {
                if (message.TryGetProperty("id", out _)) await RejectRequestAsync(message, token).ConfigureAwait(false);
                if (notifications.Count >= 128) throw new InvalidDataException("Too many notifications before an RPC response.");
                notifications.Enqueue(message);
                continue;
            }
            if (!message.TryGetProperty("id", out var receivedId) || !receivedId.TryGetInt32(out var number) || number != id)
                throw new InvalidDataException("Uncorrelated CLI response.");
            if (message.TryGetProperty("error", out _)) throw operation.Fail(CliFailure.ProviderRejected, "Codex rejected a protocol request.");
            var result = message.GetProperty("result");
            if (result.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Invalid RPC result.");
            return result;
        }
    }

    private async Task RejectRequestAsync(JsonElement message, CancellationToken token)
    {
        var id = message.GetProperty("id");
        if (id.ValueKind is not (JsonValueKind.String or JsonValueKind.Number)) throw new InvalidDataException("Invalid server request id.");
        if (DriverOperation.String(message, "method") is "item/commandExecution/requestApproval" or "item/fileChange/requestApproval")
            await connection.WriteAsync(new { id, result = new { decision = "decline" } }, token).ConfigureAwait(false);
        else
            await connection.WriteAsync(new { id, error = new { code = -32601, message = "Client capability is not admitted." } }, token).ConfigureAwait(false);
        throw operation.Fail(CliFailure.Incompatible, "CLI server request was rejected; preparation grants no tool or permission authority.");
    }

    private async ValueTask<JsonElement> RequiredAsync(CancellationToken token) =>
        await connection.ReadAsync(token).ConfigureAwait(false) ?? throw new IOException("CLI stream ended without completion.");

    private static void RequireContext(JsonElement parameters, string threadId, string turnId)
    {
        if (DriverOperation.String(parameters, "threadId") != threadId || DriverOperation.String(parameters, "turnId") != turnId)
            throw new InvalidDataException("CLI event context mismatch.");
    }
}
