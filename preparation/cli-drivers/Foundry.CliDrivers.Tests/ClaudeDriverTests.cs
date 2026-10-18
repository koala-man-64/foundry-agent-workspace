using Xunit;

namespace Foundry.CliDrivers.Tests;

public sealed class ClaudeDriverTests
{
    [Fact]
    public async Task ApiRetryProgressContinuesWithoutResendingInputOrDuplicatingUsage()
    {
        object noResponse = new { type = "system", subtype = "api_retry", session_id = "claude-1", uuid = "retry-2", attempt = 2, max_retries = 3, retry_delay_ms = 10, error_status = (int?)null, error = "unknown", no_response = new { waited_ms = 100, retry_wait_ms = 10 } };
        await using var transcript = new Transcript([Frames.ClaudeInit(), Frames.ClaudeRetry(), noResponse, Frames.Assistant(), Frames.ClaudeDone(new { input_tokens = 10, output_tokens = 2 })]);
        var events = new List<CliEvent>();
        var result = await new ClaudeCodeCliDriver(transcript.Connection).RunAsync(new("model-1", "prompt"), Frames.Observe(events), TestContext.Current.CancellationToken);
        Assert.Equal("hello", Assert.Single(events.OfType<CliText>()).Text);
        Assert.Equal(new CliUsage(10, 2), result.Usage);
        Assert.Single(events.OfType<CliUsageReported>());
        Assert.Single(transcript.Requests);
        Assert.True(transcript.Stopped);
    }

    [Fact]
    public async Task InvalidAndCrossSessionRetryProgressFailsWithoutReplay()
    {
        object[] events =
        [
            Frames.ClaudeRetry(attempt: 0), Frames.ClaudeRetry(attempt: 4), Frames.ClaudeRetry(delay: -1),
            Frames.ClaudeRetry(status: 600), Frames.ClaudeRetry(session: "other"),
            new { type = "system", subtype = "api_retry", session_id = "claude-1" }
        ];
        foreach (var message in events)
        {
            await using var transcript = new Transcript([Frames.ClaudeInit(), message, Frames.ClaudeDone()]);
            var error = await Assert.ThrowsAsync<CliDriverException>(() => new ClaudeCodeCliDriver(transcript.Connection).RunAsync(new("model-1", "prompt"), cancellationToken: TestContext.Current.CancellationToken));
            Assert.Equal(CliFailure.InvalidProtocol, error.Failure);
            Assert.True(error.OutcomeUnknown);
            Assert.Single(transcript.Requests);
        }
    }

    [Fact]
    public async Task PartialEventsSnapshotsAndFinalResultDoNotDuplicateTextOrUsage()
    {
        var frames = new object[]
        {
            Frames.ClaudeInit(),
            Frames.ClaudeEvent(new { type = "message_start", message = new { id = "message-1" } }),
            Frames.ClaudeEvent(new { type = "content_block_start", index = 0, content_block = new { type = "text", text = "" } }),
            Frames.ClaudeEvent(new { type = "content_block_delta", index = 0, delta = new { type = "text_delta", text = "hel" } }),
            Frames.ClaudeEvent(new { type = "content_block_delta", index = 0, delta = new { type = "text_delta", text = "lo" } }),
            Frames.ClaudeEvent(new { type = "content_block_stop", index = 0 }),
            Frames.ClaudeEvent(new { type = "message_delta", usage = new { output_tokens = 99 } }),
            Frames.ClaudeEvent(new { type = "message_stop" }),
            Frames.Assistant(), Frames.Assistant(),
            Frames.ClaudeDone(new { input_tokens = 10, output_tokens = 3, cache_read_input_tokens = 4, cache_creation_input_tokens = 2 })
        };
        await using var transcript = new Transcript(frames, fragment: 1);
        var events = new List<CliEvent>();
        var result = await new ClaudeCodeCliDriver(transcript.Connection).RunAsync(new("alias", "prompt"), Frames.Observe(events), TestContext.Current.CancellationToken);
        Assert.Equal("hello", string.Concat(events.OfType<CliText>().Select(value => value.Text)));
        Assert.Equal(new CliUsage(16, 3), result.Usage);
        Assert.Single(events.OfType<CliUsageReported>());
        Assert.Equal("resolved-model", result.ReportedModel);
        Assert.Equal("claude-1", result.Session.Id);
        Assert.Single(transcript.Requests);
        Assert.Equal("user", transcript.Requests[0].GetProperty("type").GetString());
        Assert.True(transcript.Stopped);
    }

    [Fact]
    public async Task SnapshotOnlyAndResultOnlyTextAreSupported()
    {
        foreach (var frames in new[] { new[] { Frames.ClaudeInit(), Frames.Assistant(), Frames.ClaudeDone() }, new[] { Frames.ClaudeInit(), Frames.ClaudeDone() } })
        {
            await using var transcript = new Transcript(frames);
            var events = new List<CliEvent>();
            var result = await new ClaudeCodeCliDriver(transcript.Connection).RunAsync(new("alias", "prompt"), Frames.Observe(events), TestContext.Current.CancellationToken);
            Assert.Equal("hello", Assert.Single(events.OfType<CliText>()).Text);
            Assert.Null(result.Usage);
        }
    }

    [Theory]
    [InlineData("Bash")]
    [InlineData("Read")]
    [InlineData("Agent")]
    [InlineData("mcp__external__write")]
    public async Task ToolBearingInitializationIsRejected(string tool)
    {
        await using var transcript = new Transcript([Frames.ClaudeInit(tools: [tool]), Frames.ClaudeDone()]);
        var error = await Assert.ThrowsAsync<CliDriverException>(() => new ClaudeCodeCliDriver(transcript.Connection).RunAsync(new("alias", "prompt"), cancellationToken: TestContext.Current.CancellationToken));
        Assert.Equal(CliFailure.Incompatible, error.Failure);
        Assert.True(error.OutcomeUnknown);
    }

    [Fact]
    public async Task ControlRequestsAreDeniedWithoutDispatch()
    {
        await using var transcript = new Transcript([Frames.ClaudeInit(), new { type = "control_request", request_id = "permission-1", request = new { subtype = "can_use_tool", tool_name = "Bash" } }]);
        var error = await Assert.ThrowsAsync<CliDriverException>(() => new ClaudeCodeCliDriver(transcript.Connection).RunAsync(new("alias", "prompt"), cancellationToken: TestContext.Current.CancellationToken));
        Assert.Equal(CliFailure.Incompatible, error.Failure);
        var response = transcript.Requests[^1].GetProperty("response");
        Assert.Equal("error", response.GetProperty("subtype").GetString());
        Assert.Equal("permission-1", response.GetProperty("request_id").GetString());
    }

    [Theory]
    [InlineData("error_during_execution", true)]
    [InlineData("error_max_turns", true)]
    [InlineData("success", true)]
    public async Task ErrorsNeverProduceSuccess(string subtype, bool isError)
    {
        await using var transcript = new Transcript([Frames.ClaudeInit(), Frames.ClaudeDone(subtype: subtype, isError: isError)]);
        var error = await Assert.ThrowsAsync<CliDriverException>(() => new ClaudeCodeCliDriver(transcript.Connection).RunAsync(new("alias", "prompt"), cancellationToken: TestContext.Current.CancellationToken));
        Assert.Equal(CliFailure.ProviderRejected, error.Failure);
    }

    [Fact]
    public async Task SessionMismatchAndUnannouncedNativeChildrenAreRejected()
    {
        foreach (var frame in new[]
        {
            Frames.Assistant(session: "other"),
            new { type = "assistant", session_id = "claude-1", parent_tool_use_id = "native-child" },
            new { type = "assistant", session_id = "claude-1", message = new { id = "message-1", content = new[] { new { type = "tool_use", name = "Bash" } } } }
        })
        {
            await using var transcript = new Transcript([Frames.ClaudeInit(), frame, Frames.ClaudeDone()]);
            await Assert.ThrowsAsync<CliDriverException>(() => new ClaudeCodeCliDriver(transcript.Connection).RunAsync(new("alias", "prompt"), cancellationToken: TestContext.Current.CancellationToken));
        }
    }

    [Fact]
    public async Task WrongResumeSessionIsNotSilentlyRestarted()
    {
        await using var transcript = new Transcript([Frames.ClaudeInit(), Frames.ClaudeDone()]);
        var request = new CliTurn("alias", "continue", new(CliBackend.ClaudeCode, "another-session", "alias"));
        var error = await Assert.ThrowsAsync<CliDriverException>(() => new ClaudeCodeCliDriver(transcript.Connection).RunAsync(request, cancellationToken: TestContext.Current.CancellationToken));
        Assert.Equal(CliFailure.InvalidProtocol, error.Failure);
        Assert.Single(transcript.Requests);
    }

    [Fact]
    public async Task ConflictingTextSnapshotsAndMissingCompletionMembersAreClassified()
    {
        foreach (var last in new[] { Frames.Assistant("different"), new { type = "result", session_id = "claude-1" } })
        {
            await using var transcript = new Transcript([Frames.ClaudeInit(), Frames.Assistant(), last]);
            var error = await Assert.ThrowsAsync<CliDriverException>(() => new ClaudeCodeCliDriver(transcript.Connection).RunAsync(new("alias", "prompt"), cancellationToken: TestContext.Current.CancellationToken));
            Assert.Equal(CliFailure.InvalidProtocol, error.Failure);
            Assert.True(error.OutcomeUnknown);
        }
    }

    [Fact]
    public async Task StartupHooksAndTruncatedResultsAreNotAccepted()
    {
        await using var hook = new Transcript([new { type = "system", subtype = "hook_started", session_id = "claude-1" }, Frames.ClaudeInit(), Frames.ClaudeDone()]);
        Assert.Equal(CliFailure.Incompatible, (await Assert.ThrowsAsync<CliDriverException>(() => new ClaudeCodeCliDriver(hook.Connection).RunAsync(new("alias", "prompt"), cancellationToken: TestContext.Current.CancellationToken))).Failure);
        await using var truncated = new Transcript([Frames.ClaudeInit(), Frames.Assistant()]);
        Assert.Equal(CliFailure.TransportLost, (await Assert.ThrowsAsync<CliDriverException>(() => new ClaudeCodeCliDriver(truncated.Connection).RunAsync(new("alias", "prompt"), cancellationToken: TestContext.Current.CancellationToken))).Failure);
    }

    [Fact]
    public async Task CacheInclusiveUsageCannotExceedTheSupportedIntegerRange()
    {
        await using var transcript = new Transcript([Frames.ClaudeInit(), Frames.ClaudeDone(new { input_tokens = 9007199254740991L, output_tokens = 0, cache_read_input_tokens = 1 })]);
        var error = await Assert.ThrowsAsync<CliDriverException>(() => new ClaudeCodeCliDriver(transcript.Connection).RunAsync(new("alias", "prompt"), cancellationToken: TestContext.Current.CancellationToken));
        Assert.Equal(CliFailure.InvalidProtocol, error.Failure);
    }

    [Theory]
    [InlineData("thinking", 0, true)]
    [InlineData("text", 1, true)]
    [InlineData("text", 0, false)]
    public async Task TextDeltasRequireTheMatchingOpenTextBlock(string blockType, int deltaIndex, bool startBlock)
    {
        var frames = new List<object>
        {
            Frames.ClaudeInit(), Frames.ClaudeEvent(new { type = "message_start", message = new { id = "message-1" } })
        };
        if (startBlock) frames.Add(Frames.ClaudeEvent(new { type = "content_block_start", index = 0, content_block = new { type = blockType, text = "" } }));
        frames.Add(Frames.ClaudeEvent(new { type = "content_block_delta", index = deltaIndex, delta = new { type = "text_delta", text = "must not escape" } }));
        await using var transcript = new Transcript(frames);
        var events = new List<CliEvent>();
        var error = await Assert.ThrowsAsync<CliDriverException>(() => new ClaudeCodeCliDriver(transcript.Connection).RunAsync(new("alias", "prompt"), Frames.Observe(events), TestContext.Current.CancellationToken));
        Assert.Equal(CliFailure.InvalidProtocol, error.Failure);
        Assert.Empty(events.OfType<CliText>());
    }

    [Theory]
    [InlineData("content_block_stop", 1)]
    [InlineData("message_stop", 0)]
    [InlineData("message_delta", 0)]
    public async Task WrongStopsAndUnfinishedBlocksCannotBeConfirmed(string eventType, int index)
    {
        await using var transcript = new Transcript([
            Frames.ClaudeInit(), Frames.ClaudeEvent(new { type = "message_start", message = new { id = "message-1" } }),
            Frames.ClaudeEvent(new { type = "content_block_start", index = 0, content_block = new { type = "text", text = "" } }),
            Frames.ClaudeEvent(new { type = eventType, index }), Frames.ClaudeDone()]);
        var error = await Assert.ThrowsAsync<CliDriverException>(() => new ClaudeCodeCliDriver(transcript.Connection).RunAsync(new("alias", "prompt"), cancellationToken: TestContext.Current.CancellationToken));
        Assert.Equal(CliFailure.InvalidProtocol, error.Failure);
        Assert.Null(error.ConfirmedTurn);
    }

    [Fact]
    public async Task ThinkingBlocksStayPrivateAndNonemptyInitialTextIsPreserved()
    {
        await using var transcript = new Transcript([
            Frames.ClaudeInit(), Frames.ClaudeEvent(new { type = "message_start", message = new { id = "message-1" } }),
            Frames.ClaudeEvent(new { type = "content_block_start", index = 0, content_block = new { type = "thinking" } }),
            Frames.ClaudeEvent(new { type = "content_block_delta", index = 0, delta = new { type = "thinking_delta", thinking = "private" } }),
            Frames.ClaudeEvent(new { type = "content_block_stop", index = 0 }),
            Frames.ClaudeEvent(new { type = "content_block_start", index = 1, content_block = new { type = "text", text = "hello" } }),
            Frames.ClaudeEvent(new { type = "content_block_stop", index = 1 }),
            Frames.ClaudeEvent(new { type = "message_stop" }), Frames.Assistant(), Frames.ClaudeDone()]);
        var events = new List<CliEvent>();
        await new ClaudeCodeCliDriver(transcript.Connection).RunAsync(new("alias", "prompt"), Frames.Observe(events), TestContext.Current.CancellationToken);
        Assert.Equal("hello", Assert.Single(events.OfType<CliText>()).Text);
    }
}
