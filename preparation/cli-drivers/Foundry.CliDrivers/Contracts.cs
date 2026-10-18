namespace Foundry.CliDrivers;

// Preparation-only types. These are deliberately independent of Foundry.Protocol and persisted application models.
public enum CliBackend { Codex, ClaudeCode }
public enum CliFailure { InvalidProtocol, Incompatible, ProviderRejected, AuthenticationRequired, TransportLost, Timeout, CleanupFailed, ObserverFailed }

public sealed class CliDriverException(CliFailure failure, string message, bool outcomeUnknown = false, Exception? inner = null)
    : Exception(message, inner)
{
    public CliFailure Failure { get; } = failure;
    public bool OutcomeUnknown { get; } = outcomeUnknown;
    public CliTurnResult? ConfirmedTurn { get; init; }
    public CliUsage? ReportedUsage { get; init; }
}

public sealed class CliCancelledException(bool outcomeUnknown, OperationCanceledException inner, CancellationToken cancellationToken)
    : OperationCanceledException("CLI operation was cancelled; inspect outcome metadata before continuing.", inner, cancellationToken)
{
    public bool OutcomeUnknown { get; } = outcomeUnknown;
    public CliUsage? ReportedUsage { get; init; }
    public CliTurnResult? ConfirmedTurn { get; init; }
}

public sealed record CliUsage(long InputTokens, long OutputTokens);
public sealed record CliSession(CliBackend Backend, string Id, string RequestedModel, CliUsage? CumulativeUsage = null, string? WorkingDirectory = null);
public sealed record CliTurn(string Model, string Prompt, CliSession? Resume = null);
public sealed record CliTurnResult(CliSession Session, string? ReportedModel, CliUsage? Usage);
public sealed record CliModel(string Id, string DisplayName, IReadOnlyList<string> ReasoningEfforts);
public sealed record CodexInspection(bool Authenticated, IReadOnlyList<CliModel> Models);

public abstract record CliEvent;
public sealed record CliText(string Text) : CliEvent;
public sealed record CliModelReported(string Model) : CliEvent;
/// <summary>Authoritative usage so far in this operation. Replace the previous snapshot; never add snapshots together.</summary>
public sealed record CliUsageReported(CliUsage Usage) : CliEvent;

public delegate ValueTask CliObserver(CliEvent value, CancellationToken cancellationToken);

public sealed record CliLimits
{
    public int FrameBytes { get; init; } = 1024 * 1024;
    public int TotalBytes { get; init; } = 8 * 1024 * 1024;
    public int MessageCount { get; init; } = 10000;
    public int TextBytes { get; init; } = 256 * 1024;
    public TimeSpan Timeout { get; init; } = TimeSpan.FromMinutes(10);

    internal void Validate()
    {
        if (FrameBytes is < 64 or > 1024 * 1024 || TotalBytes < FrameBytes || TotalBytes > 8 * 1024 * 1024 ||
            MessageCount is < 1 or > 10000 || TextBytes is < 1 or > 256 * 1024 ||
            Timeout <= TimeSpan.Zero || Timeout > TimeSpan.FromMinutes(10))
            throw new ArgumentOutOfRangeException(nameof(CliLimits), "CLI limits must be positive and within preparation bounds.");
    }
}

public interface ICliConnection : IAsyncDisposable
{
    ValueTask<System.Text.Json.JsonElement?> ReadAsync(CancellationToken cancellationToken);
    ValueTask WriteAsync(object message, CancellationToken cancellationToken);
    ValueTask StopAsync();
}
