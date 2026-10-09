using System.Windows;

namespace Foundry.Spikes.BrowserSurface;

/// <summary>
/// Usage:
///   bounds [--once | --simulate 125,150,200]
///       Spike S3: measures tab bounds while Rudy changes display scaling (docs/spikes/s3-tab-bounds.md). --once
///       measures the current scale and exits; --simulate sets the webviews' rasterization scale instead of the
///       display's, to check the arithmetic, and exits.
///   ladder [--self-check]
///       Spike S4: the input ladder Rudy tests by hand (docs/spikes/s4-input-ladder.md). --self-check attaches and
///       takes control three times through the host's own commands, without any input, and exits.
/// Exit codes: 0 finished, 1 harness error, 2 usage, 3 some measurements were disturbed, 4 the self-check failed.
/// </summary>
internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        var mode = args.Length > 0 ? args[0] : string.Empty;
        if (mode is not ("bounds" or "ladder"))
        {
            Console.Error.WriteLine("Usage: Foundry.Spikes.BrowserSurface bounds [--once | --simulate 125,150,200] | ladder [--self-check]");
            return 2;
        }
        var results = Results.Create(mode == "bounds" ? "s3-tab-bounds" : "s4-input-ladder");
        var application = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        var exitCode = 1;
        NativeWindow.OnError = error => results.Log($"Window procedure error: {error}");
        application.DispatcherUnhandledException += (_, e) =>
        {
            results.Log($"Unhandled: {e.Exception}");
            e.Handled = true;
            application.Shutdown(1);
        };
        application.Startup += async (_, _) =>
        {
            try
            {
                if (mode == "bounds")
                {
                    using var spike = new BoundsSpike(results, args.Contains("--once"), Simulated(args));
                    exitCode = await spike.RunAsync();
                }
                else
                {
                    using var spike = new LadderSpike(results, args.Contains("--self-check"));
                    exitCode = await spike.RunAsync();
                }
            }
            catch (Exception error) when (error is InvalidOperationException or TimeoutException or System.Runtime.InteropServices.COMException or Microsoft.Web.WebView2.Core.WebView2RuntimeNotFoundException)
            {
                results.Log($"The spike could not run: {error}");
                exitCode = 1;
            }
            finally
            {
                application.Shutdown(exitCode);
            }
        };
        application.Run();
        return exitCode;
    }

    /// <summary>The percentages after <c>--simulate</c>, as in <c>--simulate 125,150,200</c>.</summary>
    private static int[] Simulated(string[] args)
    {
        var index = Array.IndexOf(args, "--simulate");
        return index < 0 || index + 1 >= args.Length ? []
            : [.. args[index + 1].Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(item => int.Parse(item, System.Globalization.CultureInfo.InvariantCulture))];
    }
}
