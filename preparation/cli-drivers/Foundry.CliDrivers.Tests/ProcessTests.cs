using System.Diagnostics;
using Foundry.Platform;
using Xunit;

namespace Foundry.CliDrivers.Tests;

public sealed class ProcessTests
{
    [Theory]
    [InlineData("codex")]
    [InlineData("claude")]
    public async Task NativeFixtureStreamsThroughTheExistingJobObjectTransport(string backend)
    {
        using var scratch = new Scratch();
        await using var connection = SupervisedConnection.Start(scratch.Spec(backend));
        var events = new List<CliEvent>();
        var request = new CliTurn("fixture-model", "fixture-only prompt");
        var result = backend == "codex"
            ? await new CodexCliDriver(connection, workingDirectory: Frames.WorkingDirectory).RunAsync(request, Frames.Observe(events), TestContext.Current.CancellationToken)
            : await new ClaudeCodeCliDriver(connection).RunAsync(request, Frames.Observe(events), TestContext.Current.CancellationToken);
        Assert.Equal("fixture response", Assert.Single(events.OfType<CliText>()).Text);
        Assert.Equal(new CliUsage(3, 2), result.Usage);
    }

    [Fact]
    public async Task CancellationReclaimsRootAndGrandchildBeforeReturning()
    {
        using var scratch = new Scratch();
        var marker = Path.Combine(scratch.DirectoryPath, "pids.txt");
        await using var connection = SupervisedConnection.Start(scratch.Spec($"tree \"{marker}\""));
        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        var pending = new ClaudeCodeCliDriver(connection).RunAsync(new("fixture-model", "fixture-only prompt"), cancellationToken: cancellation.Token);
        var pids = await ReadPidsAsync(marker, TestContext.Current.CancellationToken);
        Assert.All(pids, pid => Assert.False(HasExited(pid)));
        cancellation.Cancel();
        var error = await Assert.ThrowsAsync<CliCancelledException>(() => pending.WaitAsync(TimeSpan.FromSeconds(8), TestContext.Current.CancellationToken));
        Assert.True(error.OutcomeUnknown);
        Assert.All(pids, pid => Assert.True(HasExited(pid)));
    }

    [Fact]
    public async Task StderrFloodIsBoundedAndNotReturnedAsDiagnostics()
    {
        using var scratch = new Scratch();
        var connection = SupervisedConnection.Start(scratch.Spec("stderr"), stderrBytes: 1024);
        var error = await Assert.ThrowsAsync<CliDriverException>(() => new CodexCliDriver(connection, workingDirectory: Frames.WorkingDirectory).RunAsync(new("fixture-model", "prompt"), cancellationToken: TestContext.Current.CancellationToken));
        Assert.Equal(CliFailure.CleanupFailed, error.Failure);
        Assert.DoesNotContain("xxxxxxxx", error.ToString());
        // A failed cleanup receipt remains failed on repeated disposal rather than becoming a false success.
        await Assert.ThrowsAsync<IOException>(async () => await connection.DisposeAsync());
    }

    private static async Task<int[]> ReadPidsAsync(string marker, CancellationToken token)
    {
        for (var attempt = 0; attempt < 150; attempt++)
        {
            if (File.Exists(marker))
            {
                var text = await File.ReadAllTextAsync(marker, token);
                if (text.Split(',') is [var root, var child] && int.TryParse(root, out var first) && int.TryParse(child, out var second)) return [first, second];
            }
            await Task.Delay(20, token);
        }
        throw new TimeoutException("Fixture did not report its process tree.");
    }

    private static bool HasExited(int pid)
    {
        try { using var process = Process.GetProcessById(pid); return process.HasExited; }
        catch (ArgumentException) { return true; }
    }

    private sealed class Scratch : IDisposable
    {
        public string DirectoryPath { get; } = Path.Combine(Path.GetTempPath(), "foundry-cli-fixture-" + Guid.NewGuid().ToString("N"));
        public Scratch() => Directory.CreateDirectory(DirectoryPath);

        public ProcessSpec Spec(string arguments)
        {
            var executable = FixtureExecutable();
            var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["SystemRoot"] = Environment.GetFolderPath(Environment.SpecialFolder.Windows),
                ["TEMP"] = DirectoryPath, ["TMP"] = DirectoryPath,
            };
            // The fixture uses the locally installed .NET runtime only. Provider/authentication variables are never inherited.
            if (Environment.GetEnvironmentVariable("DOTNET_ROOT") is { } dotnetRoot) environment["DOTNET_ROOT"] = dotnetRoot;
            return new(executable, $"\"{executable}\" {arguments}", DirectoryPath, environment);
        }

        private static string FixtureExecutable()
        {
            for (var candidate = new DirectoryInfo(AppContext.BaseDirectory); candidate is not null; candidate = candidate.Parent)
            {
                if (!File.Exists(Path.Combine(candidate.FullName, "Foundry.slnx"))) continue;
#if DEBUG
                const string configuration = "Debug";
#else
                const string configuration = "Release";
#endif
                var path = Path.Combine(candidate.FullName, "preparation", "cli-drivers", "Foundry.CliDrivers.Fixture", "bin", configuration, "net10.0-windows", "Foundry.CliDrivers.Fixture.exe");
                if (!File.Exists(path)) throw new FileNotFoundException("Build the standalone preparation solution before running its tests.");
                return path;
            }
            throw new DirectoryNotFoundException("Fixture repository root was not found.");
        }

        public void Dispose()
        {
            var target = Path.GetFullPath(DirectoryPath);
            var root = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "foundry-cli-fixture-"));
            if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Invalid fixture cleanup path.");
            Directory.Delete(target, recursive: true);
        }
    }
}
