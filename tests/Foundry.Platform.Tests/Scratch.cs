using System.Diagnostics;
using System.Globalization;
using System.Text;
using Xunit;

// Tests here mark handles inheritable and launch processes; a concurrent System.Diagnostics.Process launch in another
// test class would inherit those handles and turn handle and pipe assertions into races.
[assembly: Xunit.v3.Parallelization(Mode = Xunit.Sdk.ParallelMode.None)]

namespace Foundry.Platform.Tests;

internal static class Scratch
{
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
