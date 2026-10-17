namespace Foundry.Runtime;

/// <summary>
/// execution-slots.ts: at most three provider requests and approved tool executions at once, shared by both, as service.ts
/// shares one ExecutionSlots between the agent loop and the tool runtime. Waiting for a user decision never holds a slot.
/// A cancelled wait leaves without taking one. The per-profile key limit applies only to coordinated tasks, which native
/// refuses, so it is not ported.
/// </summary>
internal sealed class ExecutionSlots(RuntimeLoop loop, int limit = 3)
{
    private readonly List<TaskCompletionSource> waiters = [];
    private int active;

    internal async Task<T> Use<T>(Func<Task<T>> action, CancellationToken token)
    {
        loop.AssertCurrent();
        while (active >= limit)
        {
            token.ThrowIfCancellationRequested();
            var waiter = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); waiters.Add(waiter);
            using var registration = token.Register(() => waiter.TrySetResult());
            try { await waiter.Task; }
            finally { loop.AssertCurrent(); waiters.Remove(waiter); }
        }
        token.ThrowIfCancellationRequested(); active++;
        try { return await action(); }
        finally { loop.AssertCurrent(); active--; foreach (var waiter in waiters.ToArray()) waiter.TrySetResult(); }
    }

    internal Task Use(Func<Task> action, CancellationToken token) => Use(async () => { await action(); return 0; }, token);
}
