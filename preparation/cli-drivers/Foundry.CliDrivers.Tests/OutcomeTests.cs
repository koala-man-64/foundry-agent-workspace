using Xunit;

namespace Foundry.CliDrivers.Tests;

public sealed class OutcomeTests
{
    [Fact]
    public async Task CancellationBeforeInferenceRetainsKnownNotSubmittedState()
    {
        await using var connection = new WaitingConnection();
        using var cancellation = new CancellationTokenSource(); cancellation.Cancel();
        var error = await Assert.ThrowsAsync<CliCancelledException>(() => new CodexCliDriver(connection, workingDirectory: Frames.WorkingDirectory).RunAsync(new("model", "prompt"), cancellationToken: cancellation.Token));
        Assert.False(error.OutcomeUnknown);
        Assert.True(connection.Stopped);
    }

    [Fact]
    public async Task CancellationAfterSubmissionIsExplicitlyUnknown()
    {
        await using var connection = new WaitingConnection();
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));
        var error = await Assert.ThrowsAsync<CliCancelledException>(() => new ClaudeCodeCliDriver(connection).RunAsync(new("model", "prompt"), cancellationToken: cancellation.Token));
        Assert.True(error.OutcomeUnknown);
        Assert.True(connection.Stopped);
    }

    [Fact]
    public async Task TimeoutStopsTheConnectionAndRetainsUnknownOutcome()
    {
        await using var connection = new WaitingConnection();
        var error = await Assert.ThrowsAsync<CliDriverException>(() => new ClaudeCodeCliDriver(connection, new() { Timeout = TimeSpan.FromMilliseconds(50) }).RunAsync(new("model", "prompt"), cancellationToken: TestContext.Current.CancellationToken));
        Assert.Equal(CliFailure.Timeout, error.Failure);
        Assert.True(error.OutcomeUnknown);
        Assert.True(connection.Stopped);
    }

    [Fact]
    public async Task CleanupFailurePreservesConfirmedResultAndUsage()
    {
        await using var transcript = new Transcript([Frames.Init(), Frames.Config(), Frames.Thread(), Frames.Turn(), Frames.Usage(), Frames.Done()]);
        var connection = new FailingCleanupConnection(transcript.Connection);
        var error = await Assert.ThrowsAsync<CliDriverException>(() => new CodexCliDriver(connection, workingDirectory: Frames.WorkingDirectory).RunAsync(new("model-1", "prompt"), cancellationToken: TestContext.Current.CancellationToken));
        Assert.Equal(CliFailure.CleanupFailed, error.Failure);
        Assert.False(error.OutcomeUnknown);
        Assert.Equal("session-1", error.ConfirmedTurn!.Session.Id);
        Assert.Equal(new CliUsage(10, 2), error.ReportedUsage);
    }

    [Fact]
    public async Task ReusingDriverDoesNotReplayARequest()
    {
        await using var transcript = new Transcript([Frames.Init(), Frames.Config(), Frames.Thread(), Frames.Turn(), Frames.Done()]);
        var driver = new CodexCliDriver(transcript.Connection, workingDirectory: Frames.WorkingDirectory);
        await driver.RunAsync(new("model-1", "prompt"), cancellationToken: TestContext.Current.CancellationToken);
        await Assert.ThrowsAsync<InvalidOperationException>(() => driver.RunAsync(new("model-1", "prompt"), cancellationToken: TestContext.Current.CancellationToken));
        Assert.Equal(5, transcript.Requests.Length);
    }

    [Fact]
    public async Task UnsupportedResumeAndOutputLimitsDoNotStartExtraWork()
    {
        await using var transcript = new Transcript([Frames.Init(), Frames.Config(), Frames.Thread(), Frames.Turn(), Frames.Text("too large"), Frames.Done()]);
        var driver = new CodexCliDriver(transcript.Connection, new() { TextBytes = 2 }, Frames.WorkingDirectory);
        await Assert.ThrowsAsync<ArgumentException>(() => driver.RunAsync(new("model-1", "prompt", new(CliBackend.ClaudeCode, "session", "model-1")), cancellationToken: TestContext.Current.CancellationToken));
        Assert.Empty(transcript.Requests);
        var error = await Assert.ThrowsAsync<CliDriverException>(() => driver.RunAsync(new("model-1", "prompt"), cancellationToken: TestContext.Current.CancellationToken));
        Assert.Equal(CliFailure.InvalidProtocol, error.Failure);
        Assert.True(error.OutcomeUnknown);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CancellationDuringFinalObserversPreservesProviderConfirmation(bool duringUsage)
    {
        await using var transcript = new Transcript([Frames.ClaudeInit(), Frames.ClaudeDone(new { input_tokens = 4, output_tokens = 2 })]);
        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        CliObserver observer = (value, token) =>
        {
            if (duringUsage ? value is CliUsageReported : value is CliText) { cancellation.Cancel(); token.ThrowIfCancellationRequested(); }
            return ValueTask.CompletedTask;
        };
        var error = await Assert.ThrowsAsync<CliCancelledException>(() => new ClaudeCodeCliDriver(transcript.Connection).RunAsync(new("alias", "prompt"), observer, cancellation.Token));
        Assert.False(error.OutcomeUnknown);
        Assert.Equal("claude-1", error.ConfirmedTurn!.Session.Id);
        Assert.Equal(new CliUsage(4, 2), error.ReportedUsage);
    }

    [Fact]
    public async Task FailingFinalObserverDoesNotTurnSuccessIntoUnknownInference()
    {
        await using var transcript = new Transcript([Frames.ClaudeInit(), Frames.ClaudeDone(new { input_tokens = 4, output_tokens = 2 })]);
        CliObserver observer = (value, _) => value is CliUsageReported ? ValueTask.FromException(new IOException("fixture observer failure")) : ValueTask.CompletedTask;
        var error = await Assert.ThrowsAsync<CliDriverException>(() => new ClaudeCodeCliDriver(transcript.Connection).RunAsync(new("alias", "prompt"), observer, TestContext.Current.CancellationToken));
        Assert.Equal(CliFailure.ObserverFailed, error.Failure);
        Assert.False(error.OutcomeUnknown);
        Assert.NotNull(error.ConfirmedTurn);
        Assert.Equal(new CliUsage(4, 2), error.ReportedUsage);
    }

    [Fact]
    public async Task FailingObserverBeforeTerminalResultHasItsOwnDiagnosticAndUnknownOutcome()
    {
        await using var transcript = new Transcript([Frames.ClaudeInit(), Frames.Assistant(), Frames.ClaudeDone()]);
        CliObserver observer = (value, _) => value is CliText ? ValueTask.FromException(new InvalidOperationException("fixture observer failure")) : ValueTask.CompletedTask;
        var error = await Assert.ThrowsAsync<CliDriverException>(() => new ClaudeCodeCliDriver(transcript.Connection).RunAsync(new("alias", "prompt"), observer, TestContext.Current.CancellationToken));
        Assert.Equal(CliFailure.ObserverFailed, error.Failure);
        Assert.True(error.OutcomeUnknown);
        Assert.Null(error.ConfirmedTurn);
    }

    private sealed class FailingCleanupConnection(ICliConnection inner) : ICliConnection
    {
        public ValueTask<System.Text.Json.JsonElement?> ReadAsync(CancellationToken cancellationToken) => inner.ReadAsync(cancellationToken);
        public ValueTask WriteAsync(object message, CancellationToken cancellationToken) => inner.WriteAsync(message, cancellationToken);
        public async ValueTask StopAsync() { await inner.StopAsync(); throw new IOException("fixture cleanup failure"); }
        public ValueTask DisposeAsync() => StopAsync();
    }
}
