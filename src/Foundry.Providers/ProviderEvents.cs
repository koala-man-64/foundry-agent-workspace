using System.Runtime.CompilerServices;
using Foundry.Protocol;

[assembly: InternalsVisibleTo("Foundry.Conformance")]

namespace Foundry.Providers;

/// <summary>A tool as a request advertises it: its name, description and input schema (ToolDefinition).</summary>
public sealed record ProviderTool(string Name, string Description, object? InputSchema);

/// <summary>Measured usage, as the adapters report it; the runtime revalidates it before settling a request.</summary>
public sealed record ProviderUsage(double InputTokens, double OutputTokens, double? CacheReadTokens = null, double? CacheCreationTokens = null, double? ReasoningTokens = null) : ProviderChatEvent
{
    public override Dictionary<string, object?> ToWire()
    {
        var wire = new Dictionary<string, object?> { ["type"] = "usage", ["inputTokens"] = InputTokens, ["outputTokens"] = OutputTokens };
        if (CacheReadTokens is double read) wire["cacheReadTokens"] = read;
        if (CacheCreationTokens is double creation) wire["cacheCreationTokens"] = creation;
        if (ReasoningTokens is double reasoning) wire["reasoningTokens"] = reasoning;
        return wire;
    }
}

/// <summary>The model and response id a provider reported, each at most 200 UTF-16 units.</summary>
public sealed record ProviderMetadata(string? ReportedModel, string? ResponseId) : ProviderChatEvent
{
    public override Dictionary<string, object?> ToWire()
    {
        var wire = new Dictionary<string, object?> { ["type"] = "metadata" };
        if (ReportedModel is not null) wire["reportedModel"] = ReportedModel;
        if (ResponseId is not null) wire["responseId"] = ResponseId;
        return wire;
    }
}

/// <summary>ProviderHttpError: a definite HTTP rejection before any response stream was accepted. Retry-After is bounded and
/// advisory only; nothing retries automatically.</summary>
public sealed class ProviderHttpException(int status, double? retryAfterSeconds) : InvalidOperationException($"Provider request failed with HTTP {status.ToString(System.Globalization.CultureInfo.InvariantCulture)}.")
{
    public int Status { get; } = status;
    public double? RetryAfterSeconds { get; } = retryAfterSeconds;
}

/// <summary>A failure of the transport itself, which fetch reports as a TypeError ("fetch failed" before a response,
/// "terminated" while reading one). Its message never carries the exception that caused it, which can name the host; the
/// cause is kept only as the inner exception, which the runtime never reports.</summary>
public sealed class ProviderTransportException(string message, Exception? cause = null) : InvalidOperationException(message, cause);

internal static class ProviderAbort
{
    /// <summary>The AbortError fetch and the adapters raise when the caller's signal is aborted.</summary>
    internal static OperationCanceledException Aborted(CancellationToken token) => new("This operation was aborted", token);
    internal static void ThrowIfAborted(CancellationToken token) { if (token.IsCancellationRequested) throw Aborted(token); }
}
