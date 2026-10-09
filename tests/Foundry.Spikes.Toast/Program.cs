using System.Globalization;
using System.IO;
using System.Windows;

namespace Foundry.Spikes.Toast;

/// <summary>
/// Usage (Run-S6.ps1 drives it, and removes the registration and toasts afterwards):
///   run --label unzipped|installed --results &lt;folder&gt;   the interactive steps, recorded in the folder
/// Any other arguments, such as a toast's launch string, are untrusted: they are recorded and nothing else happens,
/// as the plan treats toast and second-instance arguments.
/// </summary>
internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        var command = args.Length > 0 ? args[0] : string.Empty;
        var results = Option(args, "--results");
        // A local, fully qualified folder only: never a network share or device path (decision 8's rule).
        if (results is not null && (!Path.IsPathFullyQualified(results) || results.StartsWith(@"\\", StringComparison.Ordinal) || results.StartsWith("//", StringComparison.Ordinal)))
        {
            results = null;
        }
        if (command == "run" && results is not null && Option(args, "--label") is "unzipped" or "installed")
        {
            Directory.CreateDirectory(results);
            var application = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
            ToastSpike spike;
            try
            {
                spike = new ToastSpike(Option(args, "--label")!, results);
            }
            catch (Exception error) when (error is System.Runtime.InteropServices.COMException or UnauthorizedAccessException or IOException or ArgumentException)
            {
                // Recorded for the summary and shown, so a toast API failure is evidence rather than a silent crash.
                File.AppendAllText(Path.Combine(results, $"phase-{Option(args, "--label")}-error.txt"), $"{Stamp()} {error}{Environment.NewLine}");
                MessageBox.Show($"The spike could not start its toasts: {error.Message}", Registration.DisplayName);
                return 1;
            }
            application.Run(spike.Window);
            return 0;
        }
        return Unexpected(args);
    }

    /// <summary>Record a launch the spike did not ask for (a toast click after the app closed, say) and do nothing else.</summary>
    private static int Unexpected(string[] args)
    {
        var folder = Path.Combine(Path.GetTempPath(), Registration.Aumid);
        Directory.CreateDirectory(folder);
        // Bounded and on one line, so arguments cannot forge log lines or grow the log without limit.
        var shown = string.Join(" ", args.Take(20).Select(arg => $"[{(arg.Length > 300 ? arg[..300] + "..." : arg).ReplaceLineEndings(@"\n")}]"));
        if (args.Length > 20)
        {
            shown += $" and {args.Length - 20} more";
        }
        File.AppendAllText(Path.Combine(folder, "launches.log"), $"{Stamp()} pid {Environment.ProcessId} {Environment.ProcessPath} arguments {shown}{Environment.NewLine}");
        MessageBox.Show($"Windows started this spike with the arguments {shown}.\n\nThey were recorded; nothing else happens. Close this message.", Registration.DisplayName);
        return 0;
    }

    private static string? Option(string[] args, string name)
    {
        var index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }

    public static string Stamp() => DateTimeOffset.Now.ToString("yyyy-MM-dd HH:mm:ss.fff zzz", CultureInfo.InvariantCulture);
}
