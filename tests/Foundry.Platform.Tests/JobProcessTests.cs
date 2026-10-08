using System.Diagnostics;
using System.Text;
using Xunit;

namespace Foundry.Platform.Tests;

/// <summary>
/// Spike S7: the Job Object guarantees job-runner.ps1 gives the TypeScript runtime, natively. The tree mirrors
/// tests/integration/security-audit.test.ts ("Job Object process tree reclamation"): the root records its pid, starts a
/// hidden grandchild that sleeps, records that pid, then lingers.
/// </summary>
public sealed class JobProcessTests
{
    private static string TreeScript(string directory, int lingerSeconds) => $"""
        $ErrorActionPreference = 'Stop'
        [IO.File]::WriteAllText('{Quote(Path.Combine(directory, "root.pid"))}', $PID)
        $child = Start-Process -PassThru -WindowStyle Hidden -FilePath '{Quote(Scratch.PowerShell)}' -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 120'
        [IO.File]::WriteAllText('{Quote(Path.Combine(directory, "child.pid"))}', [string]$child.Id)
        Start-Sleep -Seconds {lingerSeconds}
        """;

    private static string Quote(string value) => value.Replace("'", "''", StringComparison.Ordinal);

    private static JobProcess StartTree(DirectoryInfo directory, int lingerSeconds) =>
        JobProcess.Start(new ProcessSpec(Scratch.PowerShell, Scratch.EncodedCommand(TreeScript(directory.FullName, lingerSeconds)), directory.FullName, Scratch.Environment(directory.FullName)));

    [Fact]
    public async Task TerminatingTheJobReclaimsEveryDescendant()
    {
        // The command runner's timeout and cancel paths both end in TerminateJobObject.
        var cancellation = TestContext.Current.CancellationToken;
        var directory = Scratch.Directory("foundry-job-terminate-");
        using var job = StartTree(directory, lingerSeconds: 120);
        var pids = await Scratch.WaitForPids(directory.FullName, "root.pid", "child.pid");
        Assert.All(pids, pid => Assert.True(Scratch.IsAlive(pid)));
        job.Terminate(2);
        Assert.True(await job.WaitForEmptyAsync(TimeSpan.FromSeconds(5), cancellation), "Cleanup was not verified within 5 seconds.");
        Assert.Equal(2, await job.WaitForExitAsync(cancellation));
        await Scratch.WaitUntil(() => pids.All(pid => !Scratch.IsAlive(pid)), "every descendant to be reclaimed");
    }

    [Fact]
    public async Task ADescendantThatOutlivesANormalExitIsStillReclaimed()
    {
        var cancellation = TestContext.Current.CancellationToken;
        var directory = Scratch.Directory("foundry-job-background-");
        using var job = StartTree(directory, lingerSeconds: 3);
        var pids = await Scratch.WaitForPids(directory.FullName, "root.pid", "child.pid");
        Assert.Equal(0, await job.WaitForExitAsync(cancellation));
        Assert.True(Scratch.IsAlive(pids[1]), "The background grandchild should outlive the root.");
        Assert.True(job.ActiveProcesses >= 1, "The background grandchild should still be running inside the job.");
        job.Terminate(3);
        Assert.True(await job.WaitForEmptyAsync(TimeSpan.FromSeconds(5), cancellation), "Cleanup was not verified within 5 seconds.");
        await Scratch.WaitUntil(() => pids.All(pid => !Scratch.IsAlive(pid)), "the background grandchild to be reclaimed");
    }

    [Fact]
    public async Task DisposingTheJobReclaimsTheTree()
    {
        var directory = Scratch.Directory("foundry-job-dispose-");
        var job = StartTree(directory, lingerSeconds: 120);
        var pids = await Scratch.WaitForPids(directory.FullName, "root.pid", "child.pid");
        job.Dispose();
        await Scratch.WaitUntil(() => pids.All(pid => !Scratch.IsAlive(pid)), "kill-on-close to reclaim the tree");
    }

    [Fact]
    public async Task KillingTheJobOwnerReclaimsItsTreeFromInsideAnEnclosingJob()
    {
        // The test's job stands in for the host's job around Foundry.Runtime.exe; the probe stands in for the runtime,
        // so the probe's own job is nested. Only the owner is killed, and the enclosing job stays open throughout, so
        // the tree can die only because the kernel closed the dead owner's job handle.
        var cancellation = TestContext.Current.CancellationToken;
        var directory = Scratch.Directory("foundry-job-owner-");
        var probe = Path.Combine(AppContext.BaseDirectory, "Foundry.Platform.TestProbe.exe");
        var script = Convert.ToBase64String(Encoding.Unicode.GetBytes(TreeScript(directory.FullName, lingerSeconds: 120)));
        using var host = JobProcess.Start(new ProcessSpec(probe, $"\"{probe}\" \"{directory.FullName}\" {script}", directory.FullName, Scratch.Environment(directory.FullName)));
        var pids = await Scratch.WaitForPids(directory.FullName, "root.pid", "child.pid");
        Assert.All(pids, pid => Assert.True(Scratch.IsAlive(pid)));
        using (var owner = Process.GetProcessById(host.ProcessId))
        {
            owner.Kill(entireProcessTree: false);
        }
        await Scratch.WaitUntil(() => pids.All(pid => !Scratch.IsAlive(pid)), "the owner's death to reclaim its job");
        Assert.True(await host.WaitForEmptyAsync(TimeSpan.FromSeconds(5), cancellation), "The enclosing job still has live processes.");
    }

    [Fact]
    public void TheRootStartsInsideTheJob()
    {
        var directory = Scratch.Directory("foundry-job-member-");
        using var job = JobProcess.Start(new ProcessSpec(Scratch.PowerShell, Scratch.EncodedCommand("Start-Sleep -Seconds 30"), directory.FullName, Scratch.Environment(directory.FullName)));
        Assert.True(job.ActiveProcesses >= 1);
        job.Terminate(1);
    }

    [Fact]
    public async Task TheChildSeesExactlyTheGivenEnvironment()
    {
        var directory = Scratch.Directory("foundry-job-environment-");
        var environment = Scratch.Environment(directory.FullName);
        environment["FOUNDRY_GIVEN"] = "given value";
        Environment.SetEnvironmentVariable("FOUNDRY_NOT_GIVEN", "parent only");
        try
        {
            var output = await Scratch.Run(Scratch.PowerShell,
                Scratch.EncodedCommand("Write-Output \"given=$env:FOUNDRY_GIVEN\"; Write-Output \"absent=$([string]::IsNullOrEmpty($env:FOUNDRY_NOT_GIVEN))\""),
                directory.FullName, environment);
            Assert.Contains("given=given value", output, StringComparison.Ordinal);
            Assert.Contains("absent=True", output, StringComparison.Ordinal);
        }
        finally
        {
            Environment.SetEnvironmentVariable("FOUNDRY_NOT_GIVEN", null);
        }
    }

    [Fact]
    public async Task StandardInputAndOutputRoundTrip()
    {
        var directory = Scratch.Directory("foundry-job-stdio-");
        var output = await Scratch.Run(Scratch.PowerShell, Scratch.EncodedCommand("$text = [Console]::In.ReadToEnd(); [Console]::Out.Write($text.ToUpperInvariant())"),
            directory.FullName, Scratch.Environment(directory.FullName), input: "line one\nline two\n");
        Assert.Equal("LINE ONE\nLINE TWO\n", output);
    }

    [Theory]
    [InlineData("A=B")]
    [InlineData("")]
    public void UnrepresentableEnvironmentNamesAreRejected(string name)
    {
        var directory = Scratch.Directory("foundry-job-names-");
        var environment = new Dictionary<string, string>(StringComparer.Ordinal) { [name] = "value" };
        Assert.Throws<ArgumentException>(() => JobProcess.Start(new ProcessSpec(Scratch.PowerShell, Scratch.EncodedCommand("exit 0"), directory.FullName, environment)));
    }

    [Fact]
    public void NamesThatDifferOnlyInCaseAreRejected()
    {
        var directory = Scratch.Directory("foundry-job-duplicate-");
        var environment = new Dictionary<string, string>(StringComparer.Ordinal) { ["Path"] = "a", ["PATH"] = "b" };
        Assert.Throws<ArgumentException>(() => JobProcess.Start(new ProcessSpec(Scratch.PowerShell, Scratch.EncodedCommand("exit 0"), directory.FullName, environment)));
    }

    [Fact]
    public void RelativePathsAreRejected()
    {
        var directory = Scratch.Directory("foundry-job-relative-");
        Assert.Throws<ArgumentException>(() => JobProcess.Start(new ProcessSpec("powershell.exe", "powershell.exe", directory.FullName, Scratch.Environment(directory.FullName))));
        Assert.Throws<ArgumentException>(() => JobProcess.Start(new ProcessSpec(Scratch.PowerShell, Scratch.EncodedCommand("exit 0"), "relative", Scratch.Environment(directory.FullName))));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    public void NulInAnyStringIsRejectedRatherThanTruncated(int field)
    {
        var directory = Scratch.Directory("foundry-job-nul-").FullName;
        var spec = new ProcessSpec(Scratch.PowerShell, Scratch.EncodedCommand("exit 0"), directory, Scratch.Environment(directory));
        spec = field switch
        {
            0 => spec with { Application = Scratch.PowerShell + "\0.exe" },
            1 => spec with { CommandLine = spec.CommandLine + "\0 -Command 'second'" },
            _ => spec with { WorkingDirectory = directory + "\0ignored" },
        };
        Assert.Throws<ArgumentException>(() => JobProcess.Start(spec));
    }

    [Theory]
    [InlineData("tool.cmd")]
    [InlineData("tool.bat")]
    [InlineData("tool.cmd.")]
    [InlineData("tool.exe ")]
    [InlineData("tool.ps1")]
    [InlineData("tool")]
    public void OnlyExecutablesAreLaunched(string name)
    {
        // CreateProcessW hands batch files to cmd.exe, whose parsing differs from the caller's quoting.
        var directory = Scratch.Directory("foundry-job-batch-").FullName;
        var application = Path.Combine(directory, name);
        Assert.Throws<ArgumentException>(() => JobProcess.Start(new ProcessSpec(application, $"\"{application}\" argument", directory, Scratch.Environment(directory))));
    }

    [Fact]
    public async Task CancellingAWaitLeavesTheTreeRunning()
    {
        var directory = Scratch.Directory("foundry-job-wait-");
        using var job = JobProcess.Start(new ProcessSpec(Scratch.PowerShell, Scratch.EncodedCommand("Start-Sleep -Seconds 30"), directory.FullName, Scratch.Environment(directory.FullName)));
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(200));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => job.WaitForExitAsync(cancellation.Token));
        Assert.True(job.ActiveProcesses >= 1);
        job.Terminate(7);
        Assert.Equal(7, await job.WaitForExitAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task ConcurrentLaunchesDoNotInheritEachOthersPipes()
    {
        // Long-lived children start while short ones launch. A leaked pipe end would keep a short child's output open
        // until a long-lived child exits, so each short read must reach end-of-file promptly.
        var cancellation = TestContext.Current.CancellationToken;
        var directory = Scratch.Directory("foundry-job-concurrent-").FullName;
        var environment = Scratch.Environment(directory);
        var comspec = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
        var holders = new List<JobProcess>();
        try
        {
            var holding = Task.Run(() =>
            {
                for (var index = 0; index < 20; index++)
                {
                    var holder = JobProcess.Start(new ProcessSpec(Scratch.PowerShell, Scratch.EncodedCommand("Start-Sleep -Seconds 60"), directory, environment));
                    lock (holders)
                    {
                        holders.Add(holder);
                    }
                }
            }, cancellation);
            for (var index = 0; index < 20; index++)
            {
                using var job = JobProcess.Start(new ProcessSpec(comspec, $"\"{comspec}\" /d /c echo short {index}", directory, environment));
                await job.StandardInput.DisposeAsync();
                var read = new StreamReader(job.StandardOutput).ReadToEndAsync(cancellation);
                var finished = await Task.WhenAny(read, Task.Delay(TimeSpan.FromSeconds(15), cancellation));
                Assert.True(finished == read, $"Launch {index}: output stayed open, so a pipe end leaked into another child.");
                Assert.Equal($"short {index}", (await read).Trim());
            }
            await holding;
        }
        finally
        {
            foreach (var holder in holders)
            {
                holder.Dispose();
            }
        }
    }

    [Fact]
    public async Task TheChildInheritsOnlyItsStandardHandles()
    {
        var directory = Scratch.Directory("foundry-job-handles-");
        var decoy = Path.Combine(directory.FullName, "decoy.bin");
        await File.WriteAllBytesAsync(decoy, [1, 2, 3], TestContext.Current.CancellationToken);
        using var job = WithInheritableDecoy(decoy, () => JobProcess.Start(new ProcessSpec(Scratch.PowerShell, Scratch.EncodedCommand("Start-Sleep -Seconds 30"), directory.FullName, Scratch.Environment(directory.FullName))));
        Assert.True(job.ActiveProcesses >= 1);
        // The parent's copy is closed, so only a handle the child inherited could still hold the file open.
        using (File.Open(decoy, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
        job.Terminate(1);
    }

    [Fact]
    public async Task ProcessStartLeaksTheSameHandle()
    {
        // The premise for JobProcess and for banning System.Diagnostics.Process in the runtime: a redirected
        // Process.Start passes bInheritHandles=TRUE without a handle list, so the child inherits every inheritable handle.
        var directory = Scratch.Directory("foundry-process-leak-");
        var decoy = Path.Combine(directory.FullName, "decoy.bin");
        await File.WriteAllBytesAsync(decoy, [1, 2, 3], TestContext.Current.CancellationToken);
        using var child = WithInheritableDecoy(decoy, () => Process.Start(new ProcessStartInfo(Scratch.PowerShell, ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"])
        {
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        })!);
        try
        {
            Assert.Throws<IOException>(() => File.Open(decoy, FileMode.Open, FileAccess.ReadWrite, FileShare.None));
        }
        finally
        {
            child.Kill(entireProcessTree: true);
            await child.WaitForExitAsync(TestContext.Current.CancellationToken);
        }
    }

    private static T WithInheritableDecoy<T>(string path, Func<T> start)
    {
        using var decoy = File.OpenHandle(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        Assert.True(Native.SetHandleInformation(decoy, Native.HandleFlagInherit, Native.HandleFlagInherit));
        return start();
    }
}
