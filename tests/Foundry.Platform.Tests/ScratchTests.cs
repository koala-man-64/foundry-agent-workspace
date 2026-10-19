using Xunit;

namespace Foundry.Platform.Tests;

public sealed class ScratchTests
{
    [Fact]
    public async Task PidWaitRetriesWhileTheWriterStillHoldsANonEmptyFile()
    {
        var directory = Scratch.Directory("foundry-pid-wait-").FullName;
        try
        {
            var cancellation = TestContext.Current.CancellationToken;
            // The state hosted CI hit: the child's WriteAllText has flushed its PID but not yet closed the file.
            var writer = new FileStream(Path.Combine(directory, "child.pid"), FileMode.CreateNew, FileAccess.Write, FileShare.Read);
            await writer.WriteAsync("4242"u8.ToArray(), cancellation);
            await writer.FlushAsync(cancellation);
            var wait = Scratch.WaitForPids(directory, "child.pid");
            await Task.Delay(500, cancellation);
            Assert.False(wait.IsCompleted);
            await writer.DisposeAsync();
            var pids = await wait;
            Assert.Equal(4242, Assert.Single(pids));
        }
        finally { Directory.Delete(directory, true); }
    }

    [Fact]
    public async Task PidWaitIgnoresContentThatIsNotYetAProcessId()
    {
        var directory = Scratch.Directory("foundry-pid-wait-").FullName;
        try
        {
            var cancellation = TestContext.Current.CancellationToken;
            var path = Path.Combine(directory, "root.pid");
            await File.WriteAllTextAsync(path, " ", cancellation);
            var wait = Scratch.WaitForPids(directory, "root.pid");
            await Task.Delay(300, cancellation);
            Assert.False(wait.IsCompleted);
            await File.WriteAllTextAsync(path, "17\r\n", cancellation);
            var pids = await wait;
            Assert.Equal(17, Assert.Single(pids));
        }
        finally { Directory.Delete(directory, true); }
    }
}
