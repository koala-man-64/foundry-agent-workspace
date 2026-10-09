using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Media;
using System.Windows.Threading;

namespace Foundry.Spikes.BrowserSurface;

/// <summary>
/// The display scale a measurement ran at. A simulated scale sets both webviews' <c>RasterizationScale</c> directly,
/// with monitor detection off, on an unchanged display: it checks the arithmetic, not Windows' DPI handling.
/// </summary>
internal readonly record struct Scale(uint Dpi, int Percent, bool Simulated)
{
    public override string ToString() => Simulated ? $"{Percent}% (simulated)" : $"{Percent}%";
}

/// <summary>One placement of the tab, measured on screen.</summary>
internal sealed record BoundsRecord(
    string Kind, DateTimeOffset Time, uint Dpi, int ScalePercent, bool Simulated, double RasterizationScale, double TabRasterizationScale,
    double Zoom, double DevicePixelRatio, string Window, string Layout, string Placement, DeviceRect Client, CssRect Css,
    CssBounds Renderer, DeviceRect Computed, DeviceRect TabHost, DeviceRect? Painted, DeviceRect? Tab, EdgeErrors? Errors,
    int GapPixels, int OverflowPixels, bool Disturbed, bool Pass);

/// <summary>Whether the tab hid while a modal was open and came back where it was.</summary>
internal sealed record ModalRecord(
    string Kind, DateTimeOffset Time, uint Dpi, int ScalePercent, bool Simulated, string Modal, bool HiddenWhileOpen, int TabPixelsWhileOpen,
    DeviceRect? TabBefore, DeviceRect? TabAfter, bool Restored, bool Disturbed, bool Pass);

/// <summary>
/// Spike S3: tab bounds under display scaling and zoom. At each display scale it measures every combination of two
/// window sizes, two layouts of the browser area (whole and fractional CSS pixels) and UI zoom 1 and 2. For each it
/// photographs the area the UI painted (tab hidden) and then the tab (placed as designed, then from the exact
/// fractional rectangle), and compares their edges in device pixels. It also checks that the tab hides behind the
/// UI's confirmation dialog and a native dialog. Rudy changes Windows display scaling himself; the harness notices and
/// measures again. It never changes a system setting. <c>--simulate</c> runs the same sequence at simulated scales.
/// </summary>
internal sealed class BoundsSpike : IDisposable
{
    private static readonly int[] TargetScales = [100, 125, 150, 200];
    private static readonly string[] Layouts = ["aligned", "fractional"];
    private static readonly double[] Zooms = [1, 2];
    private static readonly System.Drawing.Color Navy = System.Drawing.Color.FromArgb(0x10, 0x20, 0x40);
    private static readonly System.Drawing.Color Green = System.Drawing.Color.FromArgb(0x00, 0xFF, 0x00);
    private const string TabPage = "<!doctype html><meta charset=\"utf-8\"><title>tab</title><style>html,body{margin:0;height:100%;overflow:hidden;background:#00ff00}</style>";
    private const int ZoneMargin = 12;
    private const int Attempts = 3;

    private readonly Results results;
    private readonly bool once;
    private readonly IReadOnlyList<int> simulate;
    private readonly Window window;
    private readonly List<BoundsRecord> measurements = [];
    private readonly List<ModalRecord> modals = [];
    private readonly SortedSet<int> scalesMeasured = [];
    private readonly TaskCompletionSource<int> finished = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private Surface? surface;
    private CancellationTokenSource? measuring;
    private int sequence;
    private bool closing;

    /// <param name="once">Measure the current scale, then exit.</param>
    /// <param name="simulate">Scales in percent to simulate, then exit; empty for a real run.</param>
    public BoundsSpike(Results results, bool once, IReadOnlyList<int> simulate)
    {
        this.results = results;
        this.once = once || simulate.Count > 0;
        this.simulate = simulate;
        window = new Window
        {
            Title = "Foundry S3 tab bounds: keep this window unobstructed",
            Background = new SolidColorBrush(Color.FromRgb(Navy.R, Navy.G, Navy.B)),
            WindowStartupLocation = WindowStartupLocation.Manual,
            Left = 24, Top = 24, Width = 900, Height = 700,
            ShowActivated = !once,
        };
        window.Closing += (_, e) =>
        {
            if (!closing)
            {
                e.Cancel = true; // Finish first: the summary is written and the webviews are closed before the window goes.
                finished.TrySetResult(0);
            }
        };
    }

    private Surface Host => surface ?? throw new InvalidOperationException("The surface is not started.");

    public void Dispose() => measuring?.Dispose();

    public async Task<int> RunAsync()
    {
        results.Log($"S3 tab bounds. Results: {results.Directory}");
        results.Log(Results.Describe());
        surface = await Surface.StartAsync(window, new SurfaceOptions(Pages.Load("ui-bounds.html"), TabPage, Navy, Green), results.Log);
        if (simulate.Count > 0)
        {
            _ = SimulateAsync();
        }
        else
        {
            Host.Ui.RasterizationScaleChanged += (_, _) => Schedule("the display scale changed");
            window.DpiChanged += (_, _) => Schedule("the window's DPI changed");
            if (!once && !Console.IsInputRedirected)
            {
                ReadConsole();
            }
            Schedule("start");
        }
        var code = await finished.Task;
        measuring?.Cancel();
        WriteSummary();
        await Host.DisposeAsync();
        closing = true;
        window.Close();
        results.Log($"Finished. Summary: {System.IO.Path.Combine(results.Directory, "summary.md")}");
        return code;
    }

    private void ReadConsole()
    {
        var reader = new Thread(() =>
        {
            while (Console.ReadLine() is { } line)
            {
                var command = line.Trim();
                window.Dispatcher.InvokeAsync(() =>
                {
                    if (command.Equals("q", StringComparison.OrdinalIgnoreCase))
                    {
                        finished.TrySetResult(0);
                    }
                    else
                    {
                        Schedule("requested");
                    }
                });
            }
        }) { IsBackground = true, Name = "S3 console" };
        reader.Start();
    }

    /// <summary>Measure about two seconds after the last change, so a scale change has finished resizing everything.</summary>
    private void Schedule(string reason)
    {
        measuring?.Cancel();
        measuring?.Dispose();
        measuring = new CancellationTokenSource();
        results.Log($"Measuring in 2 s: {reason}.");
        _ = MeasureLaterAsync(measuring.Token);
    }

    private async Task MeasureLaterAsync(CancellationToken token)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(2), token);
            await MeasureScaleAsync(new Scale(Host.Dpi, Percent(Host.Dpi), false), token);
            if (once)
            {
                finished.TrySetResult(AnyDisturbed ? 3 : 0);
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            results.Log("Measurement interrupted; it restarts when things settle.");
        }
        catch (Exception error) when (error is InvalidOperationException or TimeoutException or System.Runtime.InteropServices.COMException or JsonException)
        {
            results.Log($"Measurement failed: {error}");
            if (once)
            {
                finished.TrySetResult(1);
            }
        }
    }

    private bool AnyDisturbed => measurements.Any(item => item.Disturbed) || modals.Any(item => item.Disturbed);

    private async Task SimulateAsync()
    {
        try
        {
            Host.Ui.ShouldDetectMonitorScaleChanges = false;
            Host.Tab.ShouldDetectMonitorScaleChanges = false;
            foreach (var percent in simulate)
            {
                Host.Ui.RasterizationScale = percent / 100.0;
                Host.Tab.RasterizationScale = percent / 100.0;
                await MeasureScaleAsync(new Scale(Host.Dpi, percent, true), CancellationToken.None);
            }
            finished.TrySetResult(AnyDisturbed ? 3 : 0);
        }
        catch (Exception error) when (error is InvalidOperationException or TimeoutException or System.Runtime.InteropServices.COMException or JsonException)
        {
            results.Log($"Simulation failed: {error}");
            finished.TrySetResult(1);
        }
    }

    private async Task MeasureScaleAsync(Scale scale, CancellationToken token)
    {
        results.Log($"Measuring at {scale} (DPI {scale.Dpi}, rasterization scale {Host.Ui.RasterizationScale}). Do not touch the window for about half a minute.");
        Status($"S3 · {scale}% · measuring, do not touch");
        window.Topmost = true; // Captures must see this window, whatever Settings or anything else covers.
        try
        {
            for (var size = 0; size < 2; size++)
            {
                Resize(size);
                foreach (var layout in Layouts)
                {
                    Host.Post(new { kind = "layout", name = layout });
                    foreach (var zoom in Zooms)
                    {
                        Host.Ui.ZoomFactor = zoom;
                        await MeasureAsync(scale, zoom, layout, size == 0 ? "standard" : "odd", token);
                    }
                }
            }
            Resize(0);
            Host.Post(new { kind = "layout", name = "fractional" });
            Host.Ui.ZoomFactor = 1;
            await ConfirmationAsync(scale, token);
            await NativeDialogAsync(scale, token);
        }
        finally
        {
            Host.Ui.ZoomFactor = 1;
            Host.Post(new { kind = "layout", name = "aligned" });
            window.Topmost = false;
        }
        if (!scale.Simulated && TargetScales.Contains(scale.Percent))
        {
            scalesMeasured.Add(scale.Percent);
        }
        WriteSummary();
        foreach (var line in ScaleSummary(scale))
        {
            results.Log(line);
        }
        if (scale.Simulated)
        {
            return;
        }
        var remaining = TargetScales.Where(item => !scalesMeasured.Contains(item)).ToList();
        var next = remaining.Count == 0
            ? "All four scales are measured. Restore your usual scaling, then type q and Enter (or close the window)."
            : $"Next: set Windows display scaling to {remaining[0]}% (Settings > System > Display > Scale). The harness measures again about 2 s after the change. Still to do: {string.Join(", ", remaining.Select(item => $"{item}%"))}. Enter re-measures now; q finishes.";
        results.Log(next);
        Status(remaining.Count == 0 ? "S3 · all scales measured · type q in the console" : $"S3 · {scale}% done · next {remaining[0]}%");
    }

    private async Task MeasureAsync(Scale scale, double zoom, string layout, string size, CancellationToken token)
    {
        for (var attempt = 1; ; attempt++)
        {
            var area = await SettleAsync(zoom, token);
            var client = Host.ClientScreen;
            var rasterization = Host.Ui.RasterizationScale;
            var expected = TabGeometry.ToDevice(area.Rect, zoom, rasterization).Offset(client.Left, client.Top);
            var zone = expected.Inflate(ZoneMargin).Intersect(client);

            // The area the UI painted, photographed with the tab hidden.
            Host.Placement = Placement.Renderer;
            Host.Hide(true);
            await Surface.PaintedAsync(Host.Ui.CoreWebView2);
            var beneath = ScreenCapture.Take(zone);
            Host.Hide(false);
            var painted = beneath.Bounds(Paint.Area, zone);
            var disturbed = painted is not { } area0 || !beneath.IsSolid(Paint.Area, area0) || beneath.Count(Paint.Other, zone) > 0 || beneath.Count(Paint.Tab, zone) > 0;

            var records = new List<BoundsRecord>();
            foreach (var placement in new[] { Placement.Renderer, Placement.Exact })
            {
                Host.Placement = placement;
                Host.Sync();
                await Surface.PaintedAsync(Host.Tab.CoreWebView2);
                await Task.Delay(100, token);
                Native.FlushComposition();
                var shown = ScreenCapture.Take(zone);
                var tab = shown.Bounds(Paint.Tab, zone);
                var bad = disturbed || tab is not { } tab0 || !shown.IsSolid(Paint.Tab, tab0) || shown.Count(Paint.Other, zone) > 0;
                var errors = painted is { } p && tab is { } t ? TabGeometry.Compare(p, t) : (EdgeErrors?)null;
                records.Add(new BoundsRecord("measurement", DateTimeOffset.Now, scale.Dpi, scale.Percent, scale.Simulated, rasterization, Host.Tab.RasterizationScale,
                    zoom, area.DevicePixelRatio, size, layout, placement.ToString(), client, area.Rect, Host.Bounds,
                    Host.TabRect.Offset(client.Left, client.Top), Host.TabScreen, painted, tab, errors,
                    shown.Count(Paint.Area, zone), painted is { } p2 ? shown.Count(Paint.Tab, zone, except: p2) : 0,
                    bad, !bad && errors is { Max: <= 1 }));
            }
            Host.Placement = Placement.Renderer;
            Host.Sync();
            if (records.Any(item => item.Disturbed) && attempt < Attempts)
            {
                results.Log($"Something covered or changed the measured area ({size}, {layout}, zoom {zoom}); retrying.");
                await Task.Delay(1000, token);
                continue;
            }
            foreach (var record in records)
            {
                measurements.Add(record);
                results.Record(record);
                results.Log($"{scale} zoom {zoom} {size} {layout} {record.Placement}: {(record.Disturbed ? "DISTURBED" : $"{record.Errors} → {(record.Pass ? "pass" : "FAIL")}")} (painted {record.Painted}, tab {record.Tab})");
            }
            return;
        }
    }

    /// <summary>Hide the tab behind the UI's confirmation dialog, as BrowserPanel's <c>visible: !confirmation</c> asks.</summary>
    private async Task ConfirmationAsync(Scale scale, CancellationToken token)
    {
        var before = await TabOnScreenAsync(token);
        Host.Post(new { kind = "confirm", open = true });
        await UntilAsync(() => !Host.TabShown, "the tab to hide for the confirmation", token);
        await Surface.PaintedAsync(Host.Ui.CoreWebView2);
        var client = Host.ClientScreen;
        var during = ScreenCapture.Take(client).Count(Paint.Tab, client);
        var hidden = !Host.TabShown && !Native.IsWindowVisible(Host.TabHostHwnd) && during == 0;
        Host.Post(new { kind = "confirm", open = false });
        await UntilAsync(() => Host.TabShown, "the tab to come back after the confirmation", token);
        var after = await TabOnScreenAsync(token);
        AddModal(new ModalRecord("modal", DateTimeOffset.Now, scale.Dpi, scale.Percent, scale.Simulated, "confirmation", hidden, during, before, after,
            before is not null && before == after, before is null || after is null, hidden && before is not null && before == after));
    }

    /// <summary>Hide the tab while a native folder dialog is open (index.ts:151). The dialog is closed by the harness.</summary>
    private async Task NativeDialogAsync(Scale scale, CancellationToken token)
    {
        var before = await TabOnScreenAsync(token);
        var during = -1;
        var visibleDuring = true;
        var found = DateTime.MinValue;
        var started = DateTime.UtcNow;
        Host.Hide(true);
        var timer = new DispatcherTimer(DispatcherPriority.Normal, window.Dispatcher) { Interval = TimeSpan.FromMilliseconds(200) };
        timer.Tick += (_, _) =>
        {
            var popup = Native.GetWindow(Host.Hwnd, Native.GwEnabledPopup);
            if (popup == 0 || popup == Host.Hwnd || !Native.IsWindowVisible(popup))
            {
                if (DateTime.UtcNow - started > TimeSpan.FromSeconds(20))
                {
                    timer.Stop(); // No dialog appeared; the record says so.
                }
                return;
            }
            if (found == DateTime.MinValue)
            {
                found = DateTime.UtcNow;
                return;
            }
            if (DateTime.UtcNow - found < TimeSpan.FromMilliseconds(800))
            {
                return;
            }
            var client = Host.ClientScreen;
            during = ScreenCapture.Take(client).Count(Paint.Tab, client);
            visibleDuring = Host.TabShown || Native.IsWindowVisible(Host.TabHostHwnd);
            timer.Stop();
            Native.PostMessage(popup, Native.WmClose, 0, 0);
        };
        timer.Start();
        try
        {
            new Microsoft.Win32.OpenFolderDialog { Title = "S3 check: this dialog closes by itself" }.ShowDialog(window);
        }
        finally
        {
            timer.Stop();
            Host.Hide(false);
        }
        await UntilAsync(() => Host.TabShown, "the tab to come back after the dialog", token);
        var after = await TabOnScreenAsync(token);
        var hidden = during == 0 && !visibleDuring;
        AddModal(new ModalRecord("modal", DateTimeOffset.Now, scale.Dpi, scale.Percent, scale.Simulated, "native folder dialog", hidden, during, before, after,
            before is not null && before == after, before is null || after is null, hidden && before is not null && before == after));
    }

    private void AddModal(ModalRecord record)
    {
        modals.Add(record);
        results.Record(record);
        results.Log($"{new Scale(record.Dpi, record.ScalePercent, record.Simulated)} {record.Modal}: hidden while open {record.HiddenWhileOpen} ({record.TabPixelsWhileOpen} tab pixels), restored {record.Restored} → {(record.Pass ? "pass" : "FAIL")}");
    }

    /// <summary>The tab's visible rectangle on screen, or null if something else covers the area.</summary>
    private async Task<DeviceRect?> TabOnScreenAsync(CancellationToken token)
    {
        var area = await SettleAsync(Host.Ui.ZoomFactor, token);
        var client = Host.ClientScreen;
        var zone = TabGeometry.ToDevice(area.Rect, Host.Ui.ZoomFactor, Host.Ui.RasterizationScale).Offset(client.Left, client.Top).Inflate(ZoneMargin).Intersect(client);
        var capture = ScreenCapture.Take(zone);
        var tab = capture.Bounds(Paint.Tab, zone);
        return tab is { } rect && capture.IsSolid(Paint.Tab, rect) && capture.Count(Paint.Other, zone) == 0 ? rect : null;
    }

    /// <summary>
    /// Ask the page to measure after two frames, until it reports the requested zoom at the current scale and the host
    /// holds the whole-pixel bounds that BrowserPanel computes from that measurement.
    /// </summary>
    private async Task<AreaReport> SettleAsync(double zoom, CancellationToken token)
    {
        for (var attempt = 0; attempt < 25; attempt++)
        {
            token.ThrowIfCancellationRequested();
            var seq = ++sequence;
            var reported = new TaskCompletionSource<AreaReport>(TaskCreationOptions.RunContinuationsAsynchronously);
            void OnMessage(JsonElement message)
            {
                if (Host.Area is { } report && report.Sequence == seq)
                {
                    reported.TrySetResult(report);
                }
            }
            Host.UiMessage += OnMessage;
            try
            {
                Host.Post(new { kind = "measure", seq });
                var area = await reported.Task.WaitAsync(TimeSpan.FromSeconds(5), token);
                var ratio = zoom * Host.Ui.RasterizationScale;
                var expected = TabGeometry.RendererBounds(area.Rect, area.InnerWidth, area.InnerHeight, Host.Bounds.Visible);
                if (Math.Abs(area.DevicePixelRatio - ratio) < 0.001 && Host.Bounds == expected)
                {
                    await Surface.PaintedAsync(Host.Tab.CoreWebView2);
                    return area;
                }
            }
            finally
            {
                Host.UiMessage -= OnMessage;
            }
            await Task.Delay(200, token);
        }
        throw new TimeoutException($"The UI did not settle at zoom {zoom}.");
    }

    private static async Task UntilAsync(Func<bool> condition, string description, CancellationToken token)
    {
        for (var waited = 0; !condition(); waited += 50)
        {
            if (waited > 5000)
            {
                throw new TimeoutException($"Timed out waiting for {description}.");
            }
            await Task.Delay(50, token);
        }
    }

    /// <summary>Size the window from the monitor's work area, in device pixels, so it fits at 200% on a 1080p display.</summary>
    private void Resize(int variant)
    {
        var work = Native.WorkArea(Host.Hwnd);
        var width = Math.Min(work.Width - 48, (int)(work.Width * 0.55) + (variant * 37));
        var height = Math.Min(work.Height - 48, (int)(work.Height * 0.8) + (variant * 23));
        Native.SetWindowPos(Host.Hwnd, 0, work.Left + 24, work.Top + 24, width, height, Native.SwpNoZOrder | Native.SwpNoActivate);
    }

    private void Status(string text) => Host.Post(new { kind = "status", text });

    private static int Percent(uint dpi) => (int)Math.Round(dpi * 100.0 / 96, MidpointRounding.AwayFromZero);

    private IEnumerable<string> ScaleSummary(Scale scale)
    {
        var rows = measurements.Where(item => item.ScalePercent == scale.Percent && item.Simulated == scale.Simulated && !item.Disturbed).ToList();
        foreach (var placement in new[] { "Renderer", "Exact" })
        {
            var selected = rows.Where(item => item.Placement == placement).ToList();
            if (selected.Count > 0)
            {
                var worst = selected.Max(item => item.Errors?.Max ?? int.MaxValue);
                yield return $"{scale} {placement}: worst edge error {worst} device px over {selected.Count} placements → {(selected.All(item => item.Pass) ? "pass" : "FAIL")}";
            }
        }
    }

    private void WriteSummary()
    {
        var text = new StringBuilder();
        var invariant = CultureInfo.InvariantCulture;
        text.AppendLine("# Spike S3: tab bounds under display scaling and zoom").AppendLine();
        text.AppendLine(invariant, $"Run {DateTimeOffset.Now:yyyy-MM-dd HH:mm zzz}. {Results.Describe()}.").AppendLine();
        text.AppendLine("Exit criterion: at most 1 device px of error at 100/125/150/200% and zoom 2; hidden behind modals.").AppendLine();
        var missing = TargetScales.Where(item => !scalesMeasured.Contains(item)).ToList();
        foreach (var simulated in new[] { false, true })
        {
            var rows = measurements.Where(item => item.Simulated == simulated).ToList();
            var checks = modals.Where(item => item.Simulated == simulated).ToList();
            if (rows.Count == 0 && simulated)
            {
                continue;
            }
            var valid = rows.Where(item => !item.Disturbed).ToList();
            text.AppendLine(simulated ? "## Simulated scales (an arithmetic check; never evidence for the exit criterion)" : "## Verdict").AppendLine();
            text.AppendLine(invariant, $"- Scales measured: {string.Join(", ", rows.Select(item => item.ScalePercent).Distinct().Order().Select(item => $"{item}%"))}{(!simulated && missing.Count > 0 ? $" (still missing: {string.Join(", ", missing.Select(item => $"{item}%"))})" : string.Empty)}.");
            foreach (var (placement, meaning) in new[] { ("Renderer", "As designed: the UI's whole-pixel bounds × zoom × scale"), ("Exact", "Diagnostic: the page's fractional rectangle × zoom × scale (needs a protocol change)") })
            {
                var selected = valid.Where(item => item.Placement == placement).ToList();
                var worst = selected.Count == 0 ? "n/a" : selected.Max(item => item.Errors?.Max ?? int.MaxValue).ToString(invariant);
                text.AppendLine(invariant, $"- {meaning}: worst edge error {worst} device px; {selected.Count(item => !item.Pass)} of {selected.Count} placements over 1 px.");
            }
            text.AppendLine(invariant, $"- Hidden behind modals: {checks.Count(item => item.Pass)} of {checks.Count} checks passed.");
            text.AppendLine(invariant, $"- Disturbed measurements (not judged): {rows.Count(item => item.Disturbed) + checks.Count(item => item.Disturbed)}.");
            if (!simulated)
            {
                var met = missing.Count == 0 && valid.Where(item => item.Placement == "Renderer").All(item => item.Pass) && checks.Count > 0 && checks.All(item => item.Pass);
                text.AppendLine(invariant, $"- **S3 as designed: {(missing.Count > 0 ? "incomplete" : met ? "met" : "not met")}.**");
            }
            text.AppendLine().AppendLine("| Scale | Zoom | Renderer, aligned | Renderer, fractional | Exact, aligned | Exact, fractional |");
            text.AppendLine("|---|---|---|---|---|---|");
            foreach (var group in valid.GroupBy(item => (item.ScalePercent, item.Zoom)).OrderBy(group => group.Key))
            {
                string Worst(string placement, string layout)
                {
                    var errors = group.Where(item => item.Placement == placement && item.Layout == layout).Select(item => item.Errors?.Max ?? int.MaxValue).ToList();
                    return errors.Count == 0 ? "-" : $"{errors.Max()} px";
                }
                text.AppendLine(invariant, $"| {group.Key.ScalePercent}% | {group.Key.Zoom} | {Worst("Renderer", "aligned")} | {Worst("Renderer", "fractional")} | {Worst("Exact", "aligned")} | {Worst("Exact", "fractional")} |");
            }
            text.AppendLine();
        }
        text.AppendLine("Errors are signed per edge: positive where the tab stops short of the painted area, negative where it overlaps past it. The worst-error tables take the largest absolute edge error over both window sizes.").AppendLine();
        text.AppendLine("## Placements").AppendLine();
        text.AppendLine("| Scale | Zoom | Window | Layout | Placement | CSS bounds (renderer) | Errors | Max | Gap px | Overflow px | Result |");
        text.AppendLine("|---|---|---|---|---|---|---|---|---|---|---|");
        foreach (var item in measurements)
        {
            text.AppendLine(invariant, $"| {item.ScalePercent}%{(item.Simulated ? " sim" : string.Empty)} | {item.Zoom} | {item.Window} | {item.Layout} | {item.Placement} | {item.Renderer.X},{item.Renderer.Y} {item.Renderer.Width}x{item.Renderer.Height} | {item.Errors?.ToString() ?? "-"} | {item.Errors?.Max.ToString(invariant) ?? "-"} | {item.GapPixels} | {item.OverflowPixels} | {(item.Disturbed ? "disturbed" : item.Pass ? "pass" : "FAIL")} |");
        }
        text.AppendLine().AppendLine("## Modals").AppendLine();
        text.AppendLine("| Scale | Modal | Hidden while open | Tab pixels while open | Restored | Result |");
        text.AppendLine("|---|---|---|---|---|---|");
        foreach (var item in modals)
        {
            text.AppendLine(invariant, $"| {item.ScalePercent}%{(item.Simulated ? " sim" : string.Empty)} | {item.Modal} | {item.HiddenWhileOpen} | {item.TabPixelsWhileOpen} | {item.Restored} | {(item.Disturbed ? "disturbed" : item.Pass ? "pass" : "FAIL")} |");
        }
        results.Write("summary.md", text.ToString());
    }
}
