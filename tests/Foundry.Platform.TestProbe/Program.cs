using System.Collections;
using System.Globalization;
using Foundry.Platform;

// Usage: Foundry.Platform.TestProbe <working directory> <PowerShell script as base64 UTF-16>
// Starts the script in its own JobProcess, prints the child's process id, then holds the job until stdin closes or
// this process is killed. A test that kills it proves the kernel reclaims the tree when its owner dies.
var powerShell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
{
    environment[(string)entry.Key] = (string?)entry.Value ?? string.Empty;
}
using var job = JobProcess.Start(new ProcessSpec(powerShell, $"\"{powerShell}\" -NoLogo -NoProfile -NonInteractive -EncodedCommand {args[1]}", args[0], environment));
Console.Out.WriteLine(job.ProcessId.ToString(CultureInfo.InvariantCulture));
Console.Out.Flush();
await Console.In.ReadToEndAsync();
return 0;
