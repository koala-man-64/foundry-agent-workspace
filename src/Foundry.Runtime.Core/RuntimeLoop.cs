using System.Collections.Concurrent;

namespace Foundry.Runtime;

/// <summary>One FIFO owner thread. Awaiting a handler yields to other admitted handlers.</summary>
public sealed class RuntimeLoop : SynchronizationContext, IAsyncDisposable
{
    private readonly BlockingCollection<(SendOrPostCallback Callback, object? State)> queue = new(new ConcurrentQueue<(SendOrPostCallback, object?)>());
    private readonly TaskCompletionSource exited = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int active;
    private bool closing;
    private int drainRequested;
    // The high bit closes admission; low bits count producers between admission
    // and queue insertion. The close marker follows every admitted producer.
    private int admissions;
    private int closeQueued;
    private Action? finalizer;
    private Exception? callbackFailure;
    private sealed class ContinuationContext(RuntimeLoop owner) : SynchronizationContext
    {
        public override void Post(SendOrPostCallback callback, object? state) => owner.Enqueue(_ =>
        {
            if (owner.closing && owner.active == 0) { owner.callbackFailure ??= new InvalidOperationException("Untracked continuation arrived after runtime cleanup."); return; }
            callback(state);
        }, null);
        public override void Send(SendOrPostCallback callback, object? state) => throw new NotSupportedException("RuntimeLoop.Send is forbidden.");
        // Async-void has no task to observe or drain. Its builder calls this
        // before executing the body, including when hidden behind a helper.
        public override void OperationStarted() => throw new NotSupportedException("RuntimeLoop requires task-returning handlers; async-void is forbidden.");
    }
    private readonly SynchronizationContext continuations;
    private static readonly AsyncLocal<SynchronousScope?> Scope = new();

    internal sealed class SynchronousScope : IDisposable
    {
        private readonly SynchronousScope? previous = Scope.Value;
        private bool closed;
        internal SynchronousScope() => Scope.Value = this;
        internal void AssertOpen()
        {
            if (closed) throw new InvalidOperationException("Work resumed after its synchronous transaction scope closed.");
            previous?.AssertOpen();
        }
        public void Dispose() { closed = true; Scope.Value = previous; }
    }
    internal SynchronousScope EnterSynchronousScope() { AssertCurrent(); return new(); }

#pragma warning disable RS0030 // This class is the sole owner of the execution thread and state-free offload.
    internal const int StackSize = 8 * 1024 * 1024;
    private readonly Thread thread;
    private bool IsOwnerThread => ReferenceEquals(Thread.CurrentThread, thread);
    public RuntimeLoop()
    {
        continuations = new ContinuationContext(this);
        // Provider payloads up to ProviderJson.MaxDepth are walked recursively on this thread (P2.4b review N4): an explicit
        // stack keeps that headroom independent of the platform's default.
        thread = new Thread(Run, StackSize) { IsBackground = true, Name = "Foundry RuntimeLoop" };
        thread.Start();
    }

    private void Run()
    {
        SetSynchronizationContext(continuations);
        try
        {
            foreach (var (callback, state) in queue.GetConsumingEnumerable())
                try { callback(state); }
                catch (Exception error) { callbackFailure ??= error; }
            if (callbackFailure is not null) exited.TrySetException(callbackFailure);
            else exited.TrySetResult();
        }
        catch (Exception error) { exited.TrySetException(error); }
        finally { SetSynchronizationContext(null); }
    }

    public static Task<TOutput> Offload<TInput, TOutput>(TInput input, Func<TInput, TOutput> operation)
    {
        ArgumentNullException.ThrowIfNull(operation);
        if (!operation.Method.IsStatic || operation.Target is not null) throw new ArgumentException("Offload requires a static function without captured state.", nameof(operation));
        if (!IsPlain(input)) throw new ArgumentException("Offload input must be plain data.", nameof(input));
        return Task.Run(() =>
        {
            var output = operation(input);
            if (!IsPlain(output)) throw new InvalidOperationException("Offload output must be plain data.");
            return output;
        });
    }

    // Timer completion is state-free; awaiting callers capture the owner context.
    // The caller must retain, cancel and await its timer task during shutdown.
    internal Task Delay(TimeSpan duration, CancellationToken cancellationToken)
    {
        AssertCurrent();
        return Task.Delay(duration, cancellationToken);
    }

    public async ValueTask DisposeAsync()
    {
        if (IsOwnerThread) throw new InvalidOperationException("The owner cannot join itself.");
        try { await Drain(); }
        finally
        {
            thread.Join(); // Join even when a callback/cleanup failure made Drain fault.
            queue.Dispose();
            GC.SuppressFinalize(this);
        }
    }
#pragma warning restore RS0030

    private static bool IsPlain(object? value) => value is null or string or bool or byte or short or int or long or float or double or decimal or Guid or DateTimeOffset;
    public bool IsCurrent => IsOwnerThread && ReferenceEquals(Current, continuations);
    public Task Drain(Action? cleanup = null)
    {
        if (IsOwnerThread) throw new InvalidOperationException("The owner cannot drain itself.");
        if (Interlocked.CompareExchange(ref drainRequested, 1, 0) == 0)
        {
            finalizer = cleanup;
            if (Interlocked.Or(ref admissions, int.MinValue) == 0) QueueClose();
        }
        return exited.Task;
    }
    public void AssertCurrent()
    {
        if (!IsCurrent) throw new InvalidOperationException("Runtime state requires its owning loop.");
        Scope.Value?.AssertOpen();
    }

    internal void ObserveRejectedTask(Task operation)
    {
        AssertCurrent(); active++;
        // Bookkeeping must not inherit an outer transaction's soon-to-close scope.
        // The rejected operation itself retains its captured scope and cannot write.
        var previous = Scope.Value;
        try { Scope.Value = null; _ = Observe(); }
        finally { Scope.Value = previous; }
        async Task Observe()
        {
            try { await operation; } catch (Exception) { /* The caller already receives the synchronous rejection. */ }
            finally { active--; CompleteIfDrained(); }
        }
    }

    public override void Send(SendOrPostCallback d, object? state) => throw new NotSupportedException("Synchronous loop dispatch is forbidden.");
    public override void Post(SendOrPostCallback d, object? state)
    {
        ArgumentNullException.ThrowIfNull(d);
        ObjectDisposedException.ThrowIf(!BeginAdmission(), this);
        try { Enqueue(_ =>
        {
            try { d(state); }
            catch (Exception error) { callbackFailure ??= error; }
        }, null); }
        finally { EndAdmission(); }
    }

    private bool BeginAdmission()
    {
        while (true)
        {
            var state = Volatile.Read(ref admissions);
            if (state < 0) return false;
            if (state == int.MaxValue) throw new InvalidOperationException("Too many concurrent admissions.");
            if (Interlocked.CompareExchange(ref admissions, state + 1, state) == state) return true;
        }
    }
    private void EndAdmission() { if (Interlocked.Decrement(ref admissions) == int.MinValue) QueueClose(); }
    private void QueueClose()
    {
        if (Interlocked.CompareExchange(ref closeQueued, 1, 0) == 0) Enqueue(_ => { closing = true; CompleteIfDrained(); }, null);
    }

    private void Enqueue(SendOrPostCallback d, object? state)
    {
        ArgumentNullException.ThrowIfNull(d);
        try { queue.Add((d, state)); }
        catch (InvalidOperationException) { throw new ObjectDisposedException(nameof(RuntimeLoop)); }
    }

    public Task<T> Invoke<T>(Func<Task<T>> handler)
    {
        ArgumentNullException.ThrowIfNull(handler);
        var completion = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!BeginAdmission()) { completion.SetException(new ObjectDisposedException(nameof(RuntimeLoop))); return completion.Task; }
        try
        {
            Enqueue(_ =>
            {
                if (closing) { completion.TrySetException(new ObjectDisposedException(nameof(RuntimeLoop))); return; }
                active++;
                _ = Execute(handler, completion);
            }, null);
        }
        catch (ObjectDisposedException error) { completion.TrySetException(error); }
        finally { EndAdmission(); }
        return completion.Task;
    }

    private async Task Execute<T>(Func<Task<T>> handler, TaskCompletionSource<T> completion)
    {
        try { completion.TrySetResult(await handler()); }
        catch (OperationCanceledException error) { completion.TrySetCanceled(error.CancellationToken); }
        catch (Exception error) { completion.TrySetException(error); }
        finally { AssertCurrent(); active--; CompleteIfDrained(); }
    }

    private void CompleteIfDrained()
    {
        AssertCurrent();
        if (closing && active == 0)
        {
            var cleanup = finalizer; finalizer = null;
            try { cleanup?.Invoke(); if (callbackFailure is not null) exited.TrySetException(callbackFailure); }
            catch (Exception error) { exited.TrySetException(error); }
            finally { queue.CompleteAdding(); }
        }
    }
}
