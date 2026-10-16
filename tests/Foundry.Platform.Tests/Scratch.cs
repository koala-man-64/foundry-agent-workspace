using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;
using Xunit;

// Tests here mark handles inheritable and launch processes; a concurrent System.Diagnostics.Process launch in another
// test class would inherit those handles and turn handle and pipe assertions into races.
[assembly: Xunit.v3.Parallelization(Mode = Xunit.Sdk.ParallelMode.None)]

namespace Foundry.Platform.Tests;

internal static class Scratch
{
    private static readonly string[] StageMarkerNames = ["before-start-process.marker", "after-start-process.marker", "child-entry.marker"];

    public static string RepositoryRoot { get; } = FindRepositoryRoot();

    public static string PowerShell { get; } = Path.Combine(System.Environment.GetFolderPath(System.Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");

    public static DirectoryInfo Directory(string prefix) => System.IO.Directory.CreateTempSubdirectory(prefix);

    /// <summary>A minimal child environment like the command runner's: Windows paths, temp and profile only.</summary>
    public static Dictionary<string, string> Environment(string temp)
    {
        var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["TEMP"] = temp, ["TMP"] = temp };
        foreach (var name in new[] { "SystemRoot", "WINDIR", "ComSpec", "PATH", "PATHEXT", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "DOTNET_ROOT" })
        {
            if (System.Environment.GetEnvironmentVariable(name) is { } value)
            {
                environment[name] = value;
            }
        }
        return environment;
    }

    public static string EncodedCommand(string script) =>
        $"\"{PowerShell}\" -NoLogo -NoProfile -NonInteractive -EncodedCommand {Convert.ToBase64String(Encoding.Unicode.GetBytes(script))}";

    /// <summary>Run a process to completion inside a JobProcess and return its standard output.</summary>
    public static async Task<string> Run(string application, string commandLine, string workingDirectory, IReadOnlyDictionary<string, string> environment, string? input = null)
    {
        var cancellation = TestContext.Current.CancellationToken;
        using var job = JobProcess.Start(new ProcessSpec(application, commandLine, workingDirectory, environment));
        var output = new StreamReader(job.StandardOutput, Encoding.UTF8).ReadToEndAsync(cancellation);
        var error = new StreamReader(job.StandardError, Encoding.UTF8).ReadToEndAsync(cancellation);
        if (input is not null)
        {
            await job.StandardInput.WriteAsync(Encoding.UTF8.GetBytes(input), cancellation);
        }
        await job.StandardInput.DisposeAsync();
        var exitCode = await job.WaitForExitAsync(cancellation);
        var text = await output;
        Assert.True(exitCode == 0, $"{Path.GetFileName(application)} exited with {exitCode}: {await error}");
        return text;
    }

    public static bool IsAlive(int processId)
    {
        try
        {
            using var process = Process.GetProcessById(processId);
            return !process.HasExited;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    public static async Task<int[]> WaitForPids(string directory, params string[] names)
    {
        var paths = names.Select(name => Path.Combine(directory, name)).ToArray();
        await WaitUntil(() => paths.All(path => File.Exists(path) && new FileInfo(path).Length > 0), "the process tree to record its process ids", seconds: 60);
        return paths.Select(path => int.Parse(File.ReadAllText(path).Trim(), CultureInfo.InvariantCulture)).ToArray();
    }

    public static async Task<int[]> WaitForPids(JobProcess job, string directory, params string[] names)
    {
        try
        {
            return await WaitForPids(directory, names);
        }
        catch (TimeoutException error)
        {
            throw new TimeoutException(error.Message + "\nStartup diagnostics: " + await DescribePidStartup(job, directory, names), error);
        }
    }

    internal static async Task<string> DescribePidStartup(JobProcess job, string directory, params string[] names)
    {
        // Only used with the fixture's untouched output pipes: no concurrent
        // reader, no draining or waiting for EOF, and no process termination.
        var rootExit = await ObserveRootExit(job);
        return JsonSerializer.Serialize(new
        {
            directory,
            rootProcessId = job.ProcessId,
            rootExit,
            activeProcesses = Observe(() => job.ActiveProcesses),
            pidFiles = names.Select(name => new { name, state = Observe(() =>
            {
                var file = new FileInfo(Path.Combine(directory, name));
                return new { exists = file.Exists, bytes = file.Exists ? (long?)file.Length : null };
            }) }).ToArray(),
            stageMarkers = StageMarkerNames
                .Select(name => new { name, state = Observe(() =>
                {
                    var file = new FileInfo(Path.Combine(directory, name));
                    return new { exists = file.Exists, bytes = file.Exists ? (long?)file.Length : null };
                }) }).ToArray(),
            stdout = PeekOutput(job.StandardOutput),
            stderr = PeekOutput(job.StandardError)
        });
    }

    private static async Task<object> ObserveRootExit(JobProcess job)
    {
        using var observation = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));
        try
        {
            return new { state = "exited", code = await job.WaitForExitAsync(observation.Token) };
        }
        catch (OperationCanceledException)
        {
            return new { state = "exit-not-observed" };
        }
        catch (Exception error)
        {
            return new { state = "unavailable", error = error.GetType().Name };
        }
    }

    private static object Observe(Func<object> read)
    {
        try { return read(); }
        catch (Exception error) { return new { error = error.GetType().Name }; }
    }

    private static object PeekOutput(FileStream stream) => Observe(() =>
    {
        var buffer = new byte[1024];
        if (!PeekNamedPipe(stream.SafeFileHandle, buffer, (uint)buffer.Length, out var read, out var available, 0))
            return new { state = "unavailable", win32Error = Marshal.GetLastPInvokeError() };
        return new
        {
            state = "available",
            availableBytes = available,
            capturedBytes = read,
            truncated = available > read,
            text = Encoding.UTF8.GetString(buffer, 0, checked((int)read))
        };
    });

    // CLR array marshalling keeps this test-only observation within the existing
    // project settings; source-generated interop would require enabling unsafe.
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PeekNamedPipe(SafeFileHandle pipe, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] byte[] buffer,
        uint size, out uint read, out uint available, nint left);

    public static async Task WaitUntil(Func<bool> condition, string description, int seconds = 10)
    {
        var deadline = DateTime.UtcNow.AddSeconds(seconds);
        while (!condition())
        {
            if (DateTime.UtcNow >= deadline)
            {
                throw new TimeoutException($"Timed out waiting for {description}.");
            }
            await Task.Delay(100, TestContext.Current.CancellationToken);
        }
    }

    private static string FindRepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "Foundry.slnx")))
            {
                return directory.FullName;
            }
        }
        throw new InvalidOperationException("Foundry.slnx was not found above the test output directory.");
    }
}
