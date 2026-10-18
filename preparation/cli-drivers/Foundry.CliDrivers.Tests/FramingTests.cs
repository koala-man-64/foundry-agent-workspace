using System.Text;
using Xunit;

namespace Foundry.CliDrivers.Tests;

public sealed class FramingTests
{
    [Fact]
    public async Task FragmentedUnicodeAndCrLfArePreserved()
    {
        await using var transcript = new Transcript("{\"text\":\"caffè ☕ 😀\"}\r\n", fragment: 1);
        var value = await transcript.Connection.ReadAsync(TestContext.Current.CancellationToken);
        Assert.Equal("caffè ☕ 😀", value!.Value.GetProperty("text").GetString());
        Assert.Null(await transcript.Connection.ReadAsync(TestContext.Current.CancellationToken));
    }

    [Theory]
    [InlineData("{\"a\":1,\"a\":2}\n")]
    [InlineData("{\"a\":{\"x\":1,\"x\":2}}\n")]
    [InlineData("{\"a\":1}")]
    [InlineData("\n")]
    [InlineData("[]\n")]
    [InlineData("\ufeff{}\n")]
    [InlineData("{\"a\":1,}\n")]
    [InlineData("{\"a\":/*comment*/1}\n")]
    public async Task AmbiguousOrTruncatedMessagesAreRejected(string raw)
    {
        await using var transcript = new Transcript(raw, fragment: 1);
        await Assert.ThrowsAnyAsync<Exception>(async () => await transcript.Connection.ReadAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task InvalidUtf8IsRejected()
    {
        await using var connection = new JsonLineConnection(new MemoryStream(), new MemoryStream(new byte[] { 123, 34, 120, 34, 58, 34, 0xc0, 0xaf, 34, 125, 10 }));
        await Assert.ThrowsAsync<DecoderFallbackException>(async () => await connection.ReadAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task FrameAndTotalLimitsApplyBeforeUnboundedAllocation()
    {
        var limits = new CliLimits { FrameBytes = 64, TotalBytes = 64 };
        await using var large = new Transcript("{\"text\":\"" + new string('a', 64) + "\"}\n", limits: limits);
        await Assert.ThrowsAsync<InvalidDataException>(async () => await large.Connection.ReadAsync(TestContext.Current.CancellationToken));
        await using var repeated = new Transcript(string.Concat(Enumerable.Repeat("{}\n", 22)), limits: limits);
        for (var index = 0; index < 21; index++) Assert.NotNull(await repeated.Connection.ReadAsync(TestContext.Current.CancellationToken));
        await Assert.ThrowsAsync<InvalidDataException>(async () => await repeated.Connection.ReadAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task MessageAndOutboundLimitsAreEnforced()
    {
        await using var transcript = new Transcript("{}\n{}\n", limits: new() { MessageCount = 1 });
        Assert.NotNull(await transcript.Connection.ReadAsync(TestContext.Current.CancellationToken));
        await Assert.ThrowsAsync<InvalidDataException>(async () => await transcript.Connection.ReadAsync(TestContext.Current.CancellationToken));
        await using var outbound = new JsonLineConnection(new MemoryStream(), new MemoryStream(), new() { FrameBytes = 64 });
        await Assert.ThrowsAsync<InvalidDataException>(async () => await outbound.WriteAsync(new { text = new string('x', 80) }, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task DeepJsonAndInvalidSurrogatesAreRejected()
    {
        await using var deep = new Transcript("{\"a\":" + new string('[', 35) + "0" + new string(']', 35) + "}\n");
        await Assert.ThrowsAnyAsync<Exception>(async () => await deep.Connection.ReadAsync(TestContext.Current.CancellationToken));
        await using var surrogate = new Transcript("{\"text\":\"\\ud800\"}\n");
        await Assert.ThrowsAnyAsync<Exception>(async () => await surrogate.Connection.ReadAsync(TestContext.Current.CancellationToken));
    }
}
