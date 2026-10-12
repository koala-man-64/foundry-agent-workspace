using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

public sealed class TransactionTests
{
    [Fact]
    public async Task RollbackFailurePoisonsStoreAndProgressNeverPersists()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p1-poison-").FullName;
        try
        {
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                var delivered = new List<WorkspaceEvent>();
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), publish: delivered.Add);
                Assert.Equal(0, store.PublishProgress(new { text = "fixture" }, "fixture").Sequence);
                Assert.Equal(0L, store.Scalar("SELECT COUNT(*) FROM events"));
                delivered.Clear();
                store.BeforeRollback = () => throw new IOException("rollback fault");
                Assert.Throws<IOException>(() => store.Transaction((Func<int>)(() =>
                {
                    store.Event("fixture.uncertain", null);
                    throw new InvalidOperationException("mutation fault");
                })));
                Assert.Empty(delivered);
                Assert.Throws<InvalidOperationException>(() => store.Scalar("SELECT 1"));
                Assert.Throws<InvalidOperationException>(() => store.PublishProgress(null, "fixture"));
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task NestedRejectedAsyncCallbackDoesNotStrandDrain()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p1-nested-late-").FullName;
        try
        {
            await using var loop = new RuntimeLoop();
            Store? store = null;
            var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            await loop.Invoke(() =>
            {
                store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"));
                async Task LateWrite()
                {
                    await release.Task;
                    store.Execute("INSERT INTO intents VALUES('late','test','{}','complete')");
                }
                store.Transaction(() =>
                {
                    Assert.Throws<InvalidOperationException>(() => store.Transaction<object>(() => LateWrite()));
                    return 0;
                });
                return Task.FromResult(0);
            });
            var drain = loop.Drain(() => { Assert.Equal(0L, store!.Scalar("SELECT COUNT(*) FROM intents")); store.Dispose(); });
            Assert.False(drain.IsCompleted);
            release.SetResult();
            await drain.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Theory]
    [InlineData(false), InlineData(true)]
    public async Task NestedRollbackDropsRowsAndEventsAndCommitsPublishInOrder(bool immediate)
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p1-tx-").FullName;
        try
        {
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                var delivered = new List<WorkspaceEvent>();
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), publish: delivered.Add);
                int Mutation()
                {
                    store.Execute("INSERT INTO intents VALUES('outer','test','{}','complete')");
                    var first = store.Event("fixture.first", new Dictionary<string, object?>());
                    Assert.Empty(delivered);
                    Assert.Throws<InvalidOperationException>(() => store.Immediate((Func<int>)(() =>
                    {
                        store.Execute("INSERT INTO intents VALUES('inner','test','{}','complete')");
                        store.Event("fixture.rollback", new Dictionary<string, object?>());
                        throw new InvalidOperationException("fault");
                    })));
                    store.Transaction(() => { store.Event("fixture.second", new Dictionary<string, object?>()); return 0; });
                    Assert.Empty(delivered);
                    Assert.Null(store.Scalar("SELECT id FROM intents WHERE id='inner'"));
                    Assert.Equal(first.Sequence, (long)store.Scalar("SELECT MIN(sequence) FROM events")!);
                    return 17;
                }
                Assert.Equal(17, immediate ? store.Immediate(Mutation) : store.Transaction(Mutation));
                Assert.Equal(["fixture.first", "fixture.second"], delivered.Select(e => e.Type));
                Assert.Equal(delivered.OrderBy(e => e.Sequence), delivered);
                Assert.Equal("outer", store.Scalar("SELECT id FROM intents"));
                Assert.Equal(2L, store.Scalar("SELECT COUNT(*) FROM events"));
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task OuterRollbackAndAsyncCallbackCannotCommit()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p1-tx-").FullName;
        try
        {
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                var delivered = new List<WorkspaceEvent>();
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), publish: delivered.Add);
                Assert.Throws<InvalidOperationException>(() => store.Transaction((Func<int>)(() =>
                {
                    store.Event("fixture.outer-rollback", null);
                    store.Immediate(() => { store.Execute("INSERT INTO intents VALUES('inner','test','{}','complete')"); return 0; });
                    throw new InvalidOperationException("fault");
                })));
                Assert.Throws<InvalidOperationException>(() => store.Transaction<object>(() =>
                {
                    store.Execute("INSERT INTO intents VALUES('async','test','{}','complete')");
                    return Task.FromResult(3);
                }));
                Assert.Equal(0L, store.Scalar("SELECT COUNT(*) FROM intents"));
                Assert.Equal(0L, store.Scalar("SELECT COUNT(*) FROM events"));
                Assert.Empty(delivered);
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task NotificationFailureLeavesCommittedMutationAndRetrievableEvent()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p1-tx-").FullName;
        try
        {
            await using var loop = new RuntimeLoop();
            await loop.Invoke(() =>
            {
                var mutations = 0;
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), publish: _ => throw new IOException("delivery fault"));
                Assert.Throws<EventDeliveryException>(() => store.Transaction(() =>
                {
                    mutations++; store.Execute("INSERT INTO intents VALUES('committed','test','{}','complete')");
                    store.Event("fixture.committed", null); return 0;
                }));
                Assert.Equal(1, mutations);
                Assert.Equal("committed", store.Scalar("SELECT id FROM intents"));
                Assert.Equal("fixture.committed", store.Scalar("SELECT type FROM events WHERE sequence=1"));
                return Task.FromResult(0);
            });
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task RejectedAsyncCallbackCannotWriteAfterRollback()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p1-late-tx-").FullName;
        try
        {
            await using var loop = new RuntimeLoop();
            await loop.Invoke(async () =>
            {
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"));
                var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                Task? delayed = null;
                async Task LateWrite()
                {
                    store.Execute("INSERT INTO intents VALUES('before','test','{}','complete')");
                    await release.Task;
                    store.Execute("INSERT INTO intents VALUES('after','test','{}','complete')");
                }
                Assert.Throws<InvalidOperationException>(() => store.Transaction<object>(() => delayed = LateWrite()));
                release.SetResult();
                await Assert.ThrowsAsync<InvalidOperationException>(() => delayed!);
                Assert.Equal(0L, store.Scalar("SELECT COUNT(*) FROM intents"));
                return 0;
            });
        }
        finally { Directory.Delete(scratch, true); }
    }
}
