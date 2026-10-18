using System.Diagnostics;
using System.Text;

namespace Foundry.Conformance;

/// <summary>
/// Windows PowerShell 5.1 keeps its module analysis cache in the profile's local application data. These suites give each
/// command a scratch USERPROFILE, so without a cache every unqualified cmdlet (the offline demo's <c>Write-Output</c>) first
/// analyses every installed module. On a CI image with AWSPowerShell, Microsoft.Graph and SqlServer that takes 10 to 60
/// seconds and breaks the commands' own timeouts. One warm-up builds the cache under its own scratch profile; each fixture's
/// profile then starts with a copy, as a real profile would. What runs and what it prints are unchanged: PowerShell still
/// reports its first-use progress. <c>tests/p2/powershell-module-cache.ts</c> seeds the oracles' profiles the same way.
/// </summary>
internal static class PowerShellModuleCache
{
    private static readonly string Relative = Path.Combine("AppData", "Local", "Microsoft", "Windows", "PowerShell", "ModuleAnalysisCache");
    private static readonly string Shared = Path.Combine(Path.GetTempPath(), "foundry-p2-powershell-module-cache", "ModuleAnalysisCache");

    // PowerShell saves the cache on a delayed timer, so the warm-up waits for the file and for its size to settle.
    private const string Script = "Get-Command -CommandType Cmdlet, Function | Out-Null; "
        + "$cache = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Microsoft\\Windows\\PowerShell\\ModuleAnalysisCache'; "
        + "$deadline = [DateTime]::UtcNow.AddMinutes(5); "
        + "while (-not (Test-Path -LiteralPath $cache) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }; "
        + "$size = -1; "
        + "while ((Test-Path -LiteralPath $cache) -and (Get-Item -LiteralPath $cache).Length -ne $size -and [DateTime]::UtcNow -lt $deadline) { $size = (Get-Item -LiteralPath $cache).Length; Start-Sleep -Milliseconds 500 }";

    private static readonly Lazy<Task<string?>> Warm = new(Build);

    /// <summary>Starts a scratch profile with the warm cache, as a profile PowerShell has run under before would have.</summary>
    internal static async Task Seed(string profile)
    {
        var cache = await Warm.Value;
        if (cache is null) return;
        var target = Path.Combine(profile, Relative);
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        File.Copy(cache, target, overwrite: true);
    }

    /// <summary>Builds the shared cache once; null when PowerShell saved none, in which case profiles stay cold.</summary>
    private static async Task<string?> Build()
    {
        if (File.Exists(Shared)) return Shared;
        var systemRoot = Environment.GetEnvironmentVariable("SystemRoot")!;
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-powershell-warm-").FullName;
        try
        {
            var profile = Path.Combine(scratch, "profile");
            Directory.CreateDirectory(Path.Combine(profile, "AppData", "Local"));
            var info = new ProcessStartInfo(Path.Combine(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"))
            {
                UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = scratch,
                RedirectStandardOutput = true, RedirectStandardError = true,
            };
            foreach (var argument in new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Convert.ToBase64String(Encoding.Unicode.GetBytes(Script)) })
                info.ArgumentList.Add(argument);
            info.Environment.Clear();
            info.Environment["SystemRoot"] = systemRoot; info.Environment["WINDIR"] = systemRoot;
            info.Environment["ComSpec"] = Path.Combine(systemRoot, "System32", "cmd.exe"); info.Environment["PATHEXT"] = ".COM;.EXE;.BAT;.CMD";
            info.Environment["PATH"] = string.Join(';', Path.Combine(systemRoot, "System32"), systemRoot, Path.Combine(systemRoot, "System32", "WindowsPowerShell", "v1.0"));
            info.Environment["TEMP"] = scratch; info.Environment["TMP"] = scratch; info.Environment["USERPROFILE"] = profile;
            using (var process = Process.Start(info)!)
            {
                using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(10));
                var output = process.StandardOutput.ReadToEndAsync(deadline.Token);
                var error = process.StandardError.ReadToEndAsync(deadline.Token);
                try { await process.WaitForExitAsync(deadline.Token); await Task.WhenAll(output, error); }
                catch (OperationCanceledException) { process.Kill(entireProcessTree: true); return null; }
            }
            var built = Path.Combine(profile, Relative);
            if (!File.Exists(built)) return null;
            Directory.CreateDirectory(Path.GetDirectoryName(Shared)!);
            var staged = $"{Shared}.{Environment.ProcessId}.tmp";
            File.Copy(built, staged, overwrite: true);
            File.Move(staged, Shared, overwrite: true);
            return Shared;
        }
        finally
        {
            Directory.Delete(scratch, recursive: true);
        }
    }
}
