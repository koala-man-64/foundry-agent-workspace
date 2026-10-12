using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

public sealed class RuntimeLoopTests
{
    [Fact]
    public async Task UntrackedContinuationCannotRunAfterCleanup()
    {
        var loop = new RuntimeLoop();
        var release = new TaskCompletionSource();
        using var blocked = new ManualResetEventSlim();
        using var unblock = new ManualResetEventSlim();
        var resumed = false;
        var cancellation = TestContext.Current.CancellationToken;
        await loop.Invoke(() => { _ = Untracked(); return Task.FromResult(0); });
        async Task Untracked() { await release.Task; resumed = true; }
        loop.Post(_ => { blocked.Set(); unblock.Wait(cancellation); }, null);
        Assert.True(blocked.Wait(TimeSpan.FromSeconds(5), cancellation));
        var cleaned = false;
        var shutdown = loop.Drain(() => cleaned = true);
        release.SetResult(); // Queues the untracked continuation behind closure.
        unblock.Set();
        await Assert.ThrowsAsync<InvalidOperationException>(() => shutdown);
        Assert.True(cleaned);
        Assert.False(resumed);
        await Assert.ThrowsAsync<InvalidOperationException>(() => loop.DisposeAsync().AsTask());
    }

    [Fact]
    public async Task OwnerCannotWaitForItsOwnDrain()
    {
        await using var loop = new RuntimeLoop();
        await loop.Invoke(() =>
        {
            Assert.Throws<InvalidOperationException>(() => { _ = loop.Drain(); });
            return Task.FromResult(0);
        });
        Assert.Equal(9, await loop.Invoke(() => Task.FromResult(9)));
    }

    [Fact]
    public async Task CapturedContextFailureDoesNotAbandonHandlersOrCleanup()
    {
        var loop = new RuntimeLoop();
        var cleaned = false;
        await loop.Invoke(async () =>
        {
            SynchronizationContext.Current!.Post(_ => throw new IOException("context failure"), null);
            await Task.Yield();
            loop.AssertCurrent();
            return 0;
        });
        Assert.Equal(9, await loop.Invoke(() => Task.FromResult(9)));
        await Assert.ThrowsAsync<IOException>(() => loop.Drain(() => cleaned = true));
        Assert.True(cleaned);
        await Assert.ThrowsAsync<IOException>(() => loop.DisposeAsync().AsTask());
    }

    [Fact]
    public async Task AsyncVoidCannotStartUntrackedWork()
    {
        var loop = new RuntimeLoop();
        var entered = false;
        loop.Post(async _ => { entered = true; await Task.Yield(); }, null);
        await Assert.ThrowsAsync<NotSupportedException>(() => loop.Drain());
        Assert.False(entered);
        await Assert.ThrowsAsync<NotSupportedException>(() => loop.DisposeAsync().AsTask());
    }

    [Fact]
    public async Task CopyingSynchronizationContextCannotImpersonateOwnerThread()
    {
        await using var loop = new RuntimeLoop();
        var captured = await loop.Invoke(() => Task.FromResult(SynchronizationContext.Current));
        var previous = SynchronizationContext.Current;
        try
        {
            SynchronizationContext.SetSynchronizationContext(captured);
            Assert.False(loop.IsCurrent);
            Assert.Throws<InvalidOperationException>(loop.AssertCurrent);
        }
        finally { SynchronizationContext.SetSynchronizationContext(previous); }
    }

    [Fact]
    public async Task PostedFailureIsObservedAtShutdownAndPostAdmissionCloses()
    {
        var loop = new RuntimeLoop();
        loop.Post(_ => throw new IOException("posted fault"), null);
        await loop.Invoke(() => Task.FromResult(0));
        var drain = loop.Drain();
        Assert.Throws<ObjectDisposedException>(() => loop.Post(_ => { }, null));
        await Assert.ThrowsAsync<IOException>(() => drain);
        await Assert.ThrowsAsync<IOException>(() => loop.DisposeAsync().AsTask());
        await Assert.ThrowsAsync<ObjectDisposedException>(() => loop.Invoke(() => Task.FromResult(0)));
    }

    [Fact]
    public async Task CleanupFailureIsObservedAndResourcesStillJoin()
    {
        var loop = new RuntimeLoop();
        await loop.Invoke(() => Task.FromResult(0));
        await Assert.ThrowsAsync<IOException>(() => loop.Drain(() => throw new IOException("cleanup fault")));
        await Assert.ThrowsAsync<IOException>(() => loop.DisposeAsync().AsTask());
    }

    [Fact]
    public async Task AdmissionIsFifoAndHandlersInterleaveOnlyAtAwaits()
    {
        await using var loop = new RuntimeLoop();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var entries = new List<string>();
        var first = loop.Invoke(async () =>
        {
            loop.AssertCurrent(); entries.Add("first-before");
            await release.Task;
            loop.AssertCurrent(); entries.Add("first-after"); return 1;
        });
        var second = loop.Invoke(() => { loop.AssertCurrent(); entries.Add("second"); release.SetResult(); return Task.FromResult(2); });
        Assert.Equal(1, await first);
        Assert.Equal(2, await second);
        Assert.Equal(["first-before", "second", "first-after"], entries);
        Assert.False(loop.IsCurrent);
        Assert.Throws<InvalidOperationException>(loop.AssertCurrent);
        Assert.Throws<NotSupportedException>(() => loop.Send(_ => { }, null));
    }

    [Fact]
    public async Task DrainWaitsForAdmittedHandlersAndRejectsNewWork()
    {
        var loop = new RuntimeLoop();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var pending = loop.Invoke(async () => { started.SetResult(); await release.Task; loop.AssertCurrent(); return 7; });
        await started.Task;
        var shutdown = loop.DisposeAsync().AsTask();
        Assert.False(shutdown.IsCompleted);
        // This request follows the close-admission marker in the FIFO.
        await Assert.ThrowsAsync<ObjectDisposedException>(() => loop.Invoke(() => Task.FromResult(0)));
        release.SetResult();
        Assert.Equal(7, await pending);
        await shutdown;
        await Assert.ThrowsAsync<ObjectDisposedException>(() => loop.Invoke(() => Task.FromResult(0)));
    }

    private static int Double(int number) => number * 2;
    [Fact]
    public async Task OffloadIsStateFreeAndReturnsToItsAwaitingOwner()
    {
        await using var loop = new RuntimeLoop();
        Assert.Equal(8, await loop.Invoke(async () => { var result = await RuntimeLoop.Offload(4, Double); loop.AssertCurrent(); return result; }));
        var captured = 3;
        Assert.Throws<ArgumentException>(() => { _ = RuntimeLoop.Offload(1, number => number + captured); });
        Assert.Throws<ArgumentException>(() => { _ = RuntimeLoop.Offload(loop, Identity); });
    }
    private static RuntimeLoop Identity(RuntimeLoop value) => value;

    [Fact]
    public async Task HandlerFailuresAndCancellationAreObservedWithoutStoppingOtherHandlers()
    {
        await using var loop = new RuntimeLoop();
        await Assert.ThrowsAsync<InvalidOperationException>(() => loop.Invoke<int>(() => throw new InvalidOperationException("test")));
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => loop.Invoke<int>(() => Task.FromCanceled<int>(cancellation.Token)));
        Assert.Equal(9, await loop.Invoke(() => Task.FromResult(9)));
    }
}
