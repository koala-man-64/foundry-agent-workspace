using System.Text;
using System.Text.Json;
using System.Runtime.ExceptionServices;

namespace Foundry.CliDrivers;

internal sealed class DriverOperation(ICliConnection connection, CliLimits? options)
{
    private readonly CliLimits limits = Validate(options);
    private int consumed, textBytes;
    private CliUsage? reportedUsage;
    private CliTurnResult? confirmedTurn;
    public bool InferenceSent { get; set; }

    public async Task<T> ExecuteAsync<T>(Func<CancellationToken, Task<T>> operation, CancellationToken cancellationToken)
    {
        if (Interlocked.Exchange(ref consumed, 1) != 0) throw new InvalidOperationException("CLI drivers are one-shot; resume with a new connection.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(limits.Timeout);
        T? confirmed = default;
        var completed = false;
        Exception? failure = null;
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            confirmed = await operation(timeout.Token).ConfigureAwait(false);
            if (confirmed is CliTurnResult turn) confirmedTurn = turn;
            completed = true;
        }
        catch (Exception error)
        {
            failure = error switch
            {
                OperationCanceledException cancelled when cancellationToken.IsCancellationRequested =>
                    new CliCancelledException(UnknownOutcome, cancelled, cancellationToken) { ReportedUsage = KnownUsage, ConfirmedTurn = confirmedTurn },
                OperationCanceledException when timeout.IsCancellationRequested => Fail(CliFailure.Timeout, "CLI operation timed out."),
                CliDriverException driverError => new CliDriverException(driverError.Failure, driverError.Message, UnknownOutcome, driverError) { ReportedUsage = KnownUsage, ConfirmedTurn = confirmedTurn },
                JsonException or DecoderFallbackException or EncoderFallbackException or InvalidDataException or InvalidOperationException or KeyNotFoundException or OverflowException or FormatException =>
                    new CliDriverException(CliFailure.InvalidProtocol, "CLI protocol validation failed.", UnknownOutcome, error) { ReportedUsage = KnownUsage, ConfirmedTurn = confirmedTurn },
                _ => new CliDriverException(CliFailure.TransportLost, "CLI operation ended before a confirmed result.", UnknownOutcome, error) { ReportedUsage = KnownUsage, ConfirmedTurn = confirmedTurn }
            };
        }
        try { await connection.StopAsync().ConfigureAwait(false); }
        catch (Exception error)
        {
            var cause = failure is null ? error : new AggregateException(failure, error);
            throw new CliDriverException(CliFailure.CleanupFailed, "CLI cleanup failed; inspect completion metadata before continuing.", InferenceSent && !completed && confirmedTurn is null, cause)
            { ConfirmedTurn = confirmedTurn, ReportedUsage = KnownUsage };
        }
        if (failure is not null) ExceptionDispatchInfo.Capture(failure).Throw();
        return confirmed!;
    }

    public async ValueTask TextAsync(string text, CliObserver? observer, CancellationToken cancellationToken)
    {
        textBytes = checked(textBytes + Encoding.UTF8.GetByteCount(text));
        if (textBytes > limits.TextBytes) throw new InvalidDataException("CLI text exceeded its output limit.");
        if (text.Length != 0) await NotifyAsync(new CliText(text), observer, cancellationToken).ConfigureAwait(false);
    }

    private bool UnknownOutcome => InferenceSent && confirmedTurn is null;
    private CliUsage? KnownUsage => reportedUsage ?? confirmedTurn?.Usage;

    public void ConfirmTurn(CliTurnResult result) => confirmedTurn = result;

    public CliDriverException Fail(CliFailure failure, string message) => new(failure, message, UnknownOutcome) { ReportedUsage = KnownUsage, ConfirmedTurn = confirmedTurn };

    public async ValueTask UsageAsync(CliUsage usage, CliObserver? observer, CancellationToken cancellationToken)
    {
        if (usage == reportedUsage) return;
        reportedUsage = usage;
        await NotifyAsync(new CliUsageReported(usage), observer, cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask NotifyAsync(CliEvent value, CliObserver? observer, CancellationToken cancellationToken)
    {
        if (observer is null) return;
        try { await observer(value, cancellationToken).ConfigureAwait(false); }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
        catch (Exception error)
        {
            throw new CliDriverException(CliFailure.ObserverFailed, "The local CLI event observer failed.", UnknownOutcome, error)
            { ConfirmedTurn = confirmedTurn, ReportedUsage = KnownUsage };
        }
    }

    public static void ValidateTurn(CliTurn turn, CliBackend backend)
    {
        ArgumentNullException.ThrowIfNull(turn);
        if (string.IsNullOrWhiteSpace(turn.Model) || turn.Model.Length > 200 || turn.Model.Contains('\0', StringComparison.Ordinal) ||
            string.IsNullOrWhiteSpace(turn.Prompt) || Encoding.UTF8.GetByteCount(turn.Prompt) > 128 * 1024)
            throw new ArgumentException("A bounded model name and prompt are required.", nameof(turn));
        if (turn.Resume is { } session && (session.Backend != backend || session.RequestedModel != turn.Model ||
            string.IsNullOrWhiteSpace(session.Id) || session.Id.Length > 200 || session.Id.Contains('\0', StringComparison.Ordinal) ||
            session.CumulativeUsage is { } usage && (usage.InputTokens < 0 || usage.OutputTokens < 0 || usage.InputTokens > 9007199254740991L - usage.OutputTokens)))
            throw new ArgumentException("The resume checkpoint does not match this backend and model.", nameof(turn));
    }

    public static string String(JsonElement value, string name)
    {
        if (!value.TryGetProperty(name, out var property) || property.ValueKind != JsonValueKind.String ||
            property.GetString() is not { Length: > 0 and <= 200 } text || text.Contains('\0', StringComparison.Ordinal))
            throw new InvalidDataException("CLI metadata is missing or invalid.");
        return text;
    }

    public static long Count(JsonElement value, string name, bool optional = false)
    {
        if (!value.TryGetProperty(name, out var property) && optional) return 0;
        if (property.ValueKind != JsonValueKind.Number || !property.TryGetInt64(out var count) || count < 0 || count > 9007199254740991L)
            throw new InvalidDataException("CLI token usage is invalid.");
        return count;
    }

    public static CliUsage CheckedUsage(long input, long output)
    {
        if (input < 0 || output < 0 || input > 9007199254740991L - output) throw new InvalidDataException("CLI usage exceeded the supported integer range.");
        return new(input, output);
    }

    private static CliLimits Validate(CliLimits? options)
    {
        var result = options ?? new(); result.Validate(); return result;
    }
}
