using Xunit;

namespace Foundry.CliDrivers.Tests;

public sealed class CodexDriverTests
{
    private static readonly string[] ExpectedMethods = ["initialize", "initialized", "thread/start", "turn/start"];
    private static readonly string[] ExpectedModels = ["one", "two"];
    private static readonly string[] ExpectedEfforts = ["high"];
    [Fact]
    public async Task StreamsTextAndCorrelatesHandshakeBeforeInference()
    {
        await using var transcript = new Transcript([Frames.Init(), Frames.Thread(), Frames.Turn(), Frames.Text("hello 😀"), Frames.Usage(), Frames.Done()], fragment: 1);
        var events = new List<CliEvent>();
        var result = await new CodexCliDriver(transcript.Connection).RunAsync(new("model-1", "private prompt"), Frames.Observe(events), TestContext.Current.CancellationToken);
        Assert.Equal("hello 😀", Assert.Single(events.OfType<CliText>()).Text);
        Assert.Equal(new CliUsage(10, 2), result.Usage);
        Assert.Equal("model-1", result.ReportedModel);
        Assert.True(transcript.Stopped);
        Assert.Equal(ExpectedMethods, transcript.Requests.Select(value => value.GetProperty("method").GetString()));
        Assert.False(transcript.Requests[0].GetProperty("params").TryGetProperty("capabilities", out _));
        Assert.Equal("private prompt", transcript.Requests[3].GetProperty("params").GetProperty("input")[0].GetProperty("text").GetString());
    }

    [Fact]
    public async Task NotificationsBeforeTurnAcknowledgmentAreNotDropped()
    {
        await using var transcript = new Transcript([Frames.Init(), Frames.Thread(), Frames.Text("early"), Frames.Turn(), Frames.Done()]);
        var events = new List<CliEvent>();
        await new CodexCliDriver(transcript.Connection).RunAsync(new("model-1", "prompt"), Frames.Observe(events), TestContext.Current.CancellationToken);
        Assert.Equal("early", Assert.Single(events.OfType<CliText>()).Text);
    }

    [Fact]
    public async Task ResumedCumulativeUsageIsSubtractedAndDuplicateSnapshotsAreNotAdded()
    {
        await using var transcript = new Transcript([Frames.Init(), Frames.Thread(), Frames.Turn(), Frames.Usage(110, 22), Frames.Usage(110, 22), Frames.Done()]);
        var events = new List<CliEvent>();
        var checkpoint = new CliSession(CliBackend.Codex, "session-1", "model-1", new(100, 20));
        var result = await new CodexCliDriver(transcript.Connection).RunAsync(new("model-1", "continue", checkpoint), Frames.Observe(events), TestContext.Current.CancellationToken);
        Assert.Equal(new CliUsage(10, 2), result.Usage);
        Assert.Equal(new CliUsage(110, 22), result.Session.CumulativeUsage);
        Assert.Single(events.OfType<CliUsageReported>());
        Assert.Equal("thread/resume", transcript.Requests[2].GetProperty("method").GetString());
    }

    [Fact]
    public async Task UnknownResumeBaselineDoesNotBecomeZeroUsage()
    {
        await using var transcript = new Transcript([Frames.Init(), Frames.Thread(), Frames.Turn(), Frames.Usage(), Frames.Done()]);
        var session = new CliSession(CliBackend.Codex, "session-1", "model-1");
        var result = await new CodexCliDriver(transcript.Connection).RunAsync(new("model-1", "continue", session), cancellationToken: TestContext.Current.CancellationToken);
        Assert.Null(result.Usage);
        Assert.Equal(new CliUsage(10, 2), result.Session.CumulativeUsage);
    }

    [Fact]
    public async Task AnUnmeasuredTurnInvalidatesItsOldAccountingCheckpoint()
    {
        await using var missing = new Transcript([Frames.Init(), Frames.Thread(), Frames.Turn(), Frames.Done()]);
        var previous = new CliSession(CliBackend.Codex, "session-1", "model-1", new(100, 20));
        var unmeasured = await new CodexCliDriver(missing.Connection).RunAsync(new("model-1", "continue", previous), cancellationToken: TestContext.Current.CancellationToken);
        Assert.Null(unmeasured.Usage);
        Assert.Null(unmeasured.Session.CumulativeUsage);
        await using var fresh = new Transcript([Frames.Init(), Frames.Thread(), Frames.Turn(), Frames.Usage(130, 25), Frames.Done()]);
        var refreshed = await new CodexCliDriver(fresh.Connection).RunAsync(new("model-1", "continue", unmeasured.Session), cancellationToken: TestContext.Current.CancellationToken);
        Assert.Null(refreshed.Usage); // The unknown interval must not be charged against an earlier retained reservation again.
        Assert.Equal(new CliUsage(130, 25), refreshed.Session.CumulativeUsage);
        await using var measured = new Transcript([Frames.Init(), Frames.Thread(), Frames.Turn(), Frames.Usage(135, 27), Frames.Done()]);
        var current = await new CodexCliDriver(measured.Connection).RunAsync(new("model-1", "continue", refreshed.Session), cancellationToken: TestContext.Current.CancellationToken);
        Assert.Equal(new CliUsage(5, 2), current.Usage);
    }

    [Theory]
    [InlineData("item/commandExecution/requestApproval")]
    [InlineData("item/fileChange/requestApproval")]
    [InlineData("item/tool/call")]
    [InlineData("item/permissions/requestApproval")]
    public async Task NativeRequestsCannotAcquireAuthority(string method)
    {
        await using var transcript = new Transcript([Frames.Init(), Frames.Thread(), Frames.Turn(), new { id = "unsafe-1", method, @params = new { command = "untrusted" } }]);
        var error = await Assert.ThrowsAsync<CliDriverException>(() => new CodexCliDriver(transcript.Connection).RunAsync(new("model-1", "prompt"), cancellationToken: TestContext.Current.CancellationToken));
        Assert.Equal(CliFailure.Incompatible, error.Failure);
        Assert.True(error.OutcomeUnknown);
        var rejection = transcript.Requests[^1];
        if (method.EndsWith("requestApproval", StringComparison.Ordinal) && !method.Contains("permissions", StringComparison.Ordinal))
            Assert.Equal("decline", rejection.GetProperty("result").GetProperty("decision").GetString());
        else Assert.Equal(-32601, rejection.GetProperty("error").GetProperty("code").GetInt32());
        Assert.True(transcript.Stopped);
    }

    [Theory]
    [InlineData("failed")]
    [InlineData("interrupted")]
    [InlineData("inProgress")]
    public async Task NonSuccessfulTerminalStateIsNeverSuccess(string status)
    {
        await using var transcript = new Transcript([Frames.Init(), Frames.Thread(), Frames.Turn(), Frames.Done(status)]);
        var error = await Assert.ThrowsAsync<CliDriverException>(() => new CodexCliDriver(transcript.Connection).RunAsync(new("model-1", "prompt"), cancellationToken: TestContext.Current.CancellationToken));
        Assert.Equal(CliFailure.ProviderRejected, error.Failure);
    }

    [Fact]
    public async Task TransportLossRetainsUnknownInferenceOutcome()
    {
        await using var transcript = new Transcript([Frames.Init(), Frames.Thread(), Frames.Turn(), Frames.Text()]);
        var error = await Assert.ThrowsAsync<CliDriverException>(() => new CodexCliDriver(transcript.Connection).RunAsync(new("model-1", "prompt"), cancellationToken: TestContext.Current.CancellationToken));
        Assert.Equal(CliFailure.TransportLost, error.Failure);
        Assert.True(error.OutcomeUnknown);
    }

    [Fact]
    public async Task WrongResponseIdFailsBeforeInferenceAndDoesNotExposeRawErrors()
    {
        await using var transcript = new Transcript([Frames.Rpc(99, new { secret = "do-not-copy" })]);
        var error = await Assert.ThrowsAsync<CliDriverException>(() => new CodexCliDriver(transcript.Connection).RunAsync(new("model-1", "prompt"), cancellationToken: TestContext.Current.CancellationToken));
        Assert.Equal(CliFailure.InvalidProtocol, error.Failure);
        Assert.False(error.OutcomeUnknown);
        Assert.DoesNotContain("do-not-copy", error.Message);
        Assert.Single(transcript.Requests);
    }

    [Fact]
    public async Task CrossSessionAndRegressingUsageAreRejected()
    {
        foreach (var frame in new[] { Frames.Text(threadId: "other"), Frames.Done(turn: "other"), Frames.Usage(-1), Frames.Usage(9, 1) })
        {
            await using var transcript = new Transcript([Frames.Init(), Frames.Thread(), Frames.Turn(), Frames.Usage(), frame, Frames.Done()]);
            var error = await Assert.ThrowsAsync<CliDriverException>(() => new CodexCliDriver(transcript.Connection).RunAsync(new("model-1", "prompt"), cancellationToken: TestContext.Current.CancellationToken));
            Assert.Equal(CliFailure.InvalidProtocol, error.Failure);
        }
    }

    [Fact]
    public async Task CatalogDiscoveryUsesAccountStatusAndBoundedPaginationWithoutInference()
    {
        object Item(string id) => new { id, displayName = id, supportedReasoningEfforts = new[] { new { reasoningEffort = "high" } } };
        await using var transcript = new Transcript([Frames.Init(), Frames.Rpc(2, new { account = new { type = "chatgpt" } }), Frames.Rpc(3, new { data = new[] { Item("one") }, nextCursor = "next" }), Frames.Rpc(4, new { data = new[] { Item("two") }, nextCursor = (string?)null })]);
        var result = await new CodexCliDriver(transcript.Connection).InspectAsync(TestContext.Current.CancellationToken);
        Assert.True(result.Authenticated);
        Assert.Equal(ExpectedModels, result.Models.Select(model => model.Id));
        Assert.All(result.Models, model => Assert.Equal(ExpectedEfforts, model.ReasoningEfforts));
        Assert.DoesNotContain(transcript.Requests, message => message.GetProperty("method").GetString() == "turn/start");
    }

    [Fact]
    public async Task RepeatedCatalogCursorIsRejected()
    {
        await using var transcript = new Transcript([Frames.Init(), Frames.Rpc(2, new { account = (object?)null }), Frames.Rpc(3, new { data = Array.Empty<object>(), nextCursor = "same" }), Frames.Rpc(4, new { data = Array.Empty<object>(), nextCursor = "same" })]);
        var error = await Assert.ThrowsAsync<CliDriverException>(() => new CodexCliDriver(transcript.Connection).InspectAsync(TestContext.Current.CancellationToken));
        Assert.Equal(CliFailure.InvalidProtocol, error.Failure);
    }

    [Fact]
    public async Task UnrecognizedAuthenticationMetadataIsNotReportedAsSignedIn()
    {
        await using var transcript = new Transcript([Frames.Init(), Frames.Rpc(2, new { account = new { type = "unknown" } })]);
        var error = await Assert.ThrowsAsync<CliDriverException>(() => new CodexCliDriver(transcript.Connection).InspectAsync(TestContext.Current.CancellationToken));
        Assert.Equal(CliFailure.Incompatible, error.Failure);
        Assert.False(error.OutcomeUnknown);
    }

    [Fact]
    public async Task MissingTerminalFieldsAndOutOfRangeUsageRetainUnknownState()
    {
        foreach (var frame in new[]
        {
            new { method = "turn/completed", @params = new { threadId = "session-1" } },
            Frames.Usage(9007199254740991L, 1), Frames.Usage(long.MaxValue, 0)
        })
        {
            await using var transcript = new Transcript([Frames.Init(), Frames.Thread(), Frames.Turn(), frame]);
            var error = await Assert.ThrowsAsync<CliDriverException>(() => new CodexCliDriver(transcript.Connection).RunAsync(new("model-1", "prompt"), cancellationToken: TestContext.Current.CancellationToken));
            Assert.Equal(CliFailure.InvalidProtocol, error.Failure);
            Assert.True(error.OutcomeUnknown);
        }
    }
}
