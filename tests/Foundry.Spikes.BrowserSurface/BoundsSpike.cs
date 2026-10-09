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

/// <summary>How a measurement came out. An obstructed measurement says nothing about the tab and leaves its scale incomplete.</summary>
internal static class Outcome
{
    public const string Pass = "pass";
    public const string Fail = "FAIL";
    public const string Obstructed = "obstructed";
}

/// <summary>One placement of the tab, measured on screen.</summary>
/// <param name="Expected">Where the design puts the tab: the CSS rectangle × zoom × scale, edges rounded, in screen pixels.</param>
/// <param name="PlacedByEvents">For the design's placement: whether the host's own event handling put the tab there, before the harness synced anything.</param>
/// <param name="SyncWaitMilliseconds">How long after the UI settled the host's own re-sync arrived (0 if it already had).</param>
internal sealed record BoundsRecord(
    string Kind, int Pass, DateTimeOffset Time, uint Dpi, int ScalePercent, bool Simulated, double RasterizationScale,
    double TabRasterizationScale, double Zoom, double DevicePixelRatio, string Window, string Layout, string Placement,
    DeviceRect Client, CssRect Css, CssBounds Renderer, DeviceRect Expected, DeviceRect TabHost, bool? PlacedByEvents,
    int? SyncWaitMilliseconds, DeviceRect? Painted, DeviceRect? Tab, EdgeErrors? Errors, int GapPixels, int OverflowPixels, string Outcome, string? Reason);

/// <summary>Whether the tab hid while a modal was open and came back where it was.</summary>
internal sealed record ModalRecord(
    string Kind, int Pass, DateTimeOffset Time, uint Dpi, int ScalePercent, bool Simulated, string Modal, bool HiddenWhileOpen,
    int TabPixelsWhileOpen, DeviceRect? TabBefore, DeviceRect? TabAfter, string Outcome, string? Reason);

/// <summary>Every measurement of one pass at one scale. A pass is kept only if it ran to the end at the same scale.</summary>
/// <param name="Reason">What started the pass: the start, a request, or a (simulated) scale change.</param>
internal sealed record ScalePass(int Number, Scale Scale, string Reason, IReadOnlyList<BoundsRecord> Placements, IReadOnlyList<ModalRecord> Modals)
{
    public const string ScaleChange = "the display scale changed";

    /// <summary>"As left", then 2 window sizes × 2 layouts × 2 zooms; each placed as designed and from the exact rectangle.</summary>
    public const int ExpectedPlacements = 18;

    public bool Complete => Placements.Count == ExpectedPlacements && Modals.Count == 2
        && Placements.All(item => item.Outcome != Outcome.Obstructed) && Modals.All(item => item.Outcome != Outcome.Obstructed);

    /// <summary>A failure of the design decides the scale even when something else was obstructed.</summary>
    public string Verdict =>
        Placements.Any(item => item.Placement == nameof(Placement.Renderer) && item.Outcome == Outcome.Fail) || Modals.Any(item => item.Outcome == Outcome.Fail)
            ? "not met" : Complete ? "met" : "incomplete";
}

/// <summary>
/// Spike S3: tab bounds under display scaling and zoom. Each pass first photographs the tab exactly where the host's
/// own event handling left it after the last change ("as left"), then every combination of two window sizes, two
/// layouts of the browser area (whole CSS pixels, and edges a hair past a whole pixel, the near-worst case for the
/// UI's inward rounding) and UI zoom 1 and 2. For each it photographs the tab where the host's events put it, the area
/// the UI painted (tab hidden), and the tab placed from the page's exact fractional rectangle, and compares edges in
/// device pixels. It also checks the tab hides behind the UI's confirmation dialog and around a native dialog.
/// Rudy changes Windows display scaling himself; the harness notices and measures again. It never changes a system
/// setting. <c>--simulate</c> runs the same passes at simulated scales.
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
    private readonly List<ScalePass> passes = [];
    private readonly TaskCompletionSource<int> finished = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private Surface? surface;
    private CancellationTokenSource? measuring;
    private int sequence;
    private int passNumber;
    private string pendingReason = "start";
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
        try
        {
            surface = await Surface.StartAsync(window, new SurfaceOptions(Pages.Load("ui-bounds.html"), TabPage, Navy, Green), results.Log);
            if (simulate.Count > 0)
            {
                _ = SimulateAsync();
            }
            else
            {
                Host.Ui.RasterizationScaleChanged += (_, _) => Schedule(ScalePass.ScaleChange);
                window.DpiChanged += (_, _) => Schedule(ScalePass.ScaleChange);
                if (!once && !Console.IsInputRedirected)
                {
                    ReadConsole();
                }
                Schedule("start");
            }
            var code = await finished.Task;
            measuring?.Cancel();
            return code;
        }
        finally
        {
            // Release the webviews' temporary profiles even if the summary cannot be written.
            try
            {
                WriteSummary();
            }
            finally
            {
                if (surface is not null)
                {
                    await surface.DisposeAsync();
                }
                closing = true;
                window.Close();
                results.Log($"Finished. Summary: {System.IO.Path.Combine(results.Directory, "summary.md")}");
            }
        }
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
        // A scale change stays the reason until a pass completes, even if a request or another event restarts the wait.
        pendingReason = reason == ScalePass.ScaleChange || pendingReason != ScalePass.ScaleChange ? reason : pendingReason;
        _ = MeasureLaterAsync(measuring.Token);
    }

    private async Task MeasureLaterAsync(CancellationToken token)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(2), token);
            var pass = await MeasureScaleAsync(new Scale(Host.Dpi, Percent(Host.Dpi), false), pendingReason, token);
            pendingReason = "requested";
            if (once)
            {
                finished.TrySetResult(pass is { Complete: true } ? 0 : 3);
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            results.Log("Measurement interrupted; its partial results were discarded. It starts again when things settle.");
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

    private async Task SimulateAsync()
    {
        try
        {
            Host.Ui.ShouldDetectMonitorScaleChanges = false;
            Host.Tab.ShouldDetectMonitorScaleChanges = false;
            var complete = true;
            foreach (var percent in simulate)
            {
                Host.Ui.RasterizationScale = percent / 100.0;
                Host.Tab.RasterizationScale = percent / 100.0;
                var pass = await MeasureScaleAsync(new Scale(Host.Dpi, percent, true), ScalePass.ScaleChange, CancellationToken.None);
                complete &= pass is { Complete: true };
            }
            finished.TrySetResult(complete ? 0 : 3);
        }
        catch (Exception error) when (error is InvalidOperationException or TimeoutException or System.Runtime.InteropServices.COMException or JsonException)
        {
            results.Log($"Simulation failed: {error}");
            finished.TrySetResult(1);
        }
    }

    /// <summary>One pass at the current scale. Its records are kept only if it runs to the end at that scale.</summary>
    private async Task<ScalePass?> MeasureScaleAsync(Scale scale, string reason, CancellationToken token)
    {
        var number = ++passNumber;
        var placements = new List<BoundsRecord>();
        var modals = new List<ModalRecord>();
        results.Log($"Pass {number}: measuring at {scale} (DPI {scale.Dpi}, rasterization scale {Host.Ui.RasterizationScale}). Do not touch the window for about half a minute.");
        Status($"S3 · {scale} · measuring, do not touch");
        window.Topmost = true; // Captures must see this window, whatever Settings or anything else covers.
        try
        {
            // First, the tab exactly as the last change left it, before the harness moves, resizes or zooms anything.
            await MeasureAsync(number, scale, placements, Host.Ui.ZoomFactor, "as left", token);
            for (var size = 0; size < 2; size++)
            {
                Resize(size);
                foreach (var layout in Layouts)
                {
                    Host.Post(new { kind = "layout", name = layout });
                    foreach (var zoom in Zooms)
                    {
                        Host.Ui.ZoomFactor = zoom;
                        await MeasureAsync(number, scale, placements, zoom, size == 0 ? "standard" : "odd", token);
                    }
                }
            }
            Resize(0);
            Host.Post(new { kind = "layout", name = "fractional" });
            Host.Ui.ZoomFactor = 1;
            modals.Add(await ConfirmationAsync(number, scale, token));
            modals.Add(await NativeDialogAsync(number, scale, token));
        }
        finally
        {
            Host.Ui.ZoomFactor = 1;
            Host.Post(new { kind = "layout", name = "aligned" });
            window.Topmost = false;
        }
        if (!scale.Simulated && Host.Dpi != scale.Dpi)
        {
            results.Log($"The display scale changed during pass {number}; its results were discarded.");
            return null;
        }
        var pass = new ScalePass(number, scale, reason, placements, modals);
        passes.Add(pass);
        foreach (var record in placements)
        {
            results.Record(record);
        }
        foreach (var record in modals)
        {
            results.Record(record);
        }
        WriteSummary();
        foreach (var line in PassSummary(pass))
        {
            results.Log(line);
        }
        if (!scale.Simulated)
        {
            Prompt(pass);
        }
        return pass;
    }

    private void Prompt(ScalePass pass)
    {
        if (pass.Verdict == "incomplete")
        {
            results.Log($"Some measurements at {pass.Scale} were obstructed. Keep this window unobstructed and press Enter to measure again.");
            Status($"S3 · {pass.Scale} incomplete · press Enter in the console");
            return;
        }
        var remaining = TargetScales.Where(item => Latest(item) is not { Verdict: "met" or "not met" }).ToList();
        results.Log(remaining.Count == 0
            ? "All four scales are measured. Restore your usual scaling, then type q and Enter (or close the window)."
            : $"Next: set Windows display scaling to {remaining[0]}% (Settings > System > Display > Scale). The harness measures again about 2 s after the change. Still to do: {string.Join(", ", remaining.Select(item => $"{item}%"))}. Enter re-measures now; q finishes.");
        Status(remaining.Count == 0 ? "S3 · all scales measured · type q in the console" : $"S3 · {pass.Scale} done · next {remaining[0]}%");
    }

    private ScalePass? Latest(int percent, bool simulated = false) =>
        passes.LastOrDefault(item => item.Scale.Percent == percent && item.Scale.Simulated == simulated);

    private async Task MeasureAsync(int number, Scale scale, List<BoundsRecord> placements, double zoom, string window, CancellationToken token)
    {
        bool? placedByEvents = null;
        int? syncWait = null;
        for (var attempt = 1; ; attempt++)
        {
            var area = await SettleAsync(zoom, token);
            var client = Host.ClientScreen;
            var rasterization = Host.Ui.RasterizationScale;
            var designed = Expected(Host.Bounds.ToRect(), zoom, rasterization, client);
            var exact = Expected(area.Rect, zoom, rasterization, client);
            var zone = TabGeometry.ToDevice(area.Rect, zoom, rasterization).Offset(client.Left, client.Top).Inflate(ZoneMargin).Intersect(client);

            // 1. The tab where the host's own event handling put it. The harness has not synced it since the last
            //    change, so a missed ZoomFactorChanged, RasterizationScaleChanged or resize shows here. A retry follows
            //    the harness's own syncs, so the first attempt's answer stands.
            if (placedByEvents is null)
            {
                var waited = 0;
                while (Host.TabScreen != designed && waited < 500)
                {
                    await Task.Delay(25, token);
                    waited += 25;
                }
                placedByEvents = Host.TabScreen == designed;
                syncWait = placedByEvents == true ? waited : null;
            }
            var designedHost = Host.TabScreen;
            var shownDesigned = await StableAsync(zone, token);

            // 2. The area the UI painted, photographed with the tab hidden.
            Host.Hide(true);
            await Surface.PaintedAsync(Host.Ui.CoreWebView2);
            var beneath = await StableAsync(zone, token);
            Host.Hide(false);

            // 3. A diagnostic: the tab placed from the page's fractional rectangle.
            Host.Placement = Placement.Exact;
            Host.Sync();
            await Surface.PaintedAsync(Host.Tab.CoreWebView2);
            var exactHost = Host.TabScreen;
            var shownExact = await StableAsync(zone, token);
            Host.Placement = Placement.Renderer;
            Host.Sync();

            var consistent = scale.Simulated || (Host.Dpi == scale.Dpi && Math.Abs(Host.Tab.RasterizationScale - rasterization) < 0.001);
            var painted = beneath?.Bounds(Paint.Area, zone);
            var obstruction = !consistent ? "the scale changed, or the tab's scale differs from the UI's"
                : beneath is null ? "the area beneath the tab kept changing"
                : painted is not { } box || !beneath.IsSolid(Paint.Area, box) || beneath.Count(Paint.Other, zone) > 0 || beneath.Count(Paint.Tab, zone) > 0
                    ? "something else covered the painted area"
                : null;
            BoundsRecord Record(Placement placement, DeviceRect expected, DeviceRect host, bool? byEvents, ScreenCapture? shown)
            {
                var (tab, errors, gap, overflow, outcome, reason) = Judge(painted, shown, zone, byEvents, obstruction);
                return new BoundsRecord("placement", number, DateTimeOffset.Now, scale.Dpi, scale.Percent, scale.Simulated, rasterization,
                    Host.Tab.RasterizationScale, zoom, area.DevicePixelRatio, window, area.Layout, placement.ToString(), client, area.Rect,
                    Host.Bounds, expected, host, byEvents, byEvents is null ? null : syncWait, painted, tab, errors, gap, overflow, outcome, reason);
            }
            var records = new[] { Record(Placement.Renderer, designed, designedHost, placedByEvents, shownDesigned), Record(Placement.Exact, exact, exactHost, null, shownExact) };
            if (records.Any(item => item.Outcome == Outcome.Obstructed) && attempt < Attempts)
            {
                results.Log($"Something covered or changed the measured area ({window}, {area.Layout}, zoom {zoom}); retrying.");
                await Task.Delay(1000, token);
                continue;
            }
            placements.AddRange(records);
            foreach (var record in records)
            {
                results.Log($"{scale} zoom {zoom} {window} {area.Layout} {record.Placement}: {record.Errors?.ToString() ?? "-"} → {record.Outcome}{(record.Reason is null ? string.Empty : $" ({record.Reason})")} (painted {record.Painted}, tab {record.Tab})");
            }
            return;
        }
    }

    /// <summary>
    /// Judge one photograph of the tab against the painted area. Something on screen that is not the UI, the area or
    /// the tab means an obstruction (no verdict), unless it lies along the tab's own edge, where it is a seam the tab
    /// left (a failure). A missing, holed or misplaced tab is a failure.
    /// </summary>
    internal static (DeviceRect? Tab, EdgeErrors? Errors, int Gap, int Overflow, string Outcome, string? Reason) Judge(
        DeviceRect? painted, ScreenCapture? shown, DeviceRect zone, bool? placedByEvents, string? obstruction)
    {
        if (obstruction is not null || painted is not { } area)
        {
            return (null, null, 0, 0, Outcome.Obstructed, obstruction ?? "no painted area in view");
        }
        if (shown is null)
        {
            return (null, null, 0, 0, Outcome.Obstructed, "the tab kept changing");
        }
        if (shown.Bounds(Paint.Tab, zone) is not { } tab)
        {
            return shown.Count(Paint.Other, zone) > 0
                ? (null, null, 0, 0, Outcome.Obstructed, "something else covered the tab")
                : (null, null, 0, 0, Outcome.Fail, "no tab in view");
        }
        var errors = TabGeometry.Compare(area, tab);
        var gap = shown.Count(Paint.Area, zone);
        var overflow = shown.Count(Paint.Tab, zone, except: area);
        var nearEdge = shown.Count(Paint.Other, tab.Inflate(1)) - (tab.Width > 2 && tab.Height > 2 ? shown.Count(Paint.Other, tab.Inflate(-1)) : 0);
        var elsewhere = shown.Count(Paint.Other, zone) - nearEdge;
        var (outcome, reason) =
            elsewhere > 0 ? (Outcome.Obstructed, $"{elsewhere} pixels of something else in view")
            : nearEdge > 0 ? (Outcome.Fail, $"{nearEdge} pixels of neither UI, area nor tab along the tab's edge")
            : !shown.IsSolid(Paint.Tab, tab) ? (Outcome.Fail, "the tab is not one solid rectangle")
            : placedByEvents == false ? (Outcome.Fail, "the host had not re-synced the tab by itself")
            : errors.Max > 1 ? (Outcome.Fail, $"an edge is {errors.Max} device px off")
            : (Outcome.Pass, (string?)null);
        return (tab, errors, gap, overflow, outcome, reason);
    }

    private static DeviceRect Expected(CssRect css, double zoom, double scale, DeviceRect client) =>
        TabGeometry.Clamp(TabGeometry.ToDevice(css, zoom, scale), client.Width, client.Height).Offset(client.Left, client.Top);

    /// <summary>Photograph twice, a frame apart, until two photographs agree; null if the screen keeps changing.</summary>
    private static async Task<ScreenCapture?> StableAsync(DeviceRect zone, CancellationToken token)
    {
        for (var attempt = 0; attempt < 3; attempt++)
        {
            Native.FlushComposition();
            var first = ScreenCapture.Take(zone);
            await Task.Delay(60, token);
            Native.FlushComposition();
            var second = ScreenCapture.Take(zone);
            if (first.SameAs(second))
            {
                return second;
            }
        }
        return null;
    }

    /// <summary>The tab hides behind the UI's confirmation dialog, as BrowserPanel's <c>visible: !confirmation</c> asks.</summary>
    private async Task<ModalRecord> ConfirmationAsync(int number, Scale scale, CancellationToken token)
    {
        var before = await TabOnScreenAsync(token);
        Host.Post(new { kind = "confirm", open = true });
        await UntilAsync(() => !Host.TabShown, "the tab to hide for the confirmation", token);
        await Surface.PaintedAsync(Host.Ui.CoreWebView2);
        var client = Host.ClientScreen;
        var during = (await StableAsync(client, token))?.Count(Paint.Tab, client) ?? -1;
        var hidden = !Host.TabShown && !Native.IsWindowVisible(Host.TabHostHwnd) && during == 0;
        Host.Post(new { kind = "confirm", open = false });
        await UntilAsync(() => Host.TabShown, "the tab to come back after the confirmation", token);
        var after = await TabOnScreenAsync(token);
        return Modal(number, scale, "confirmation", hidden, during, before, after);
    }

    /// <summary>
    /// The host's rule around native dialogs (index.ts:151): it hides the tab while one is open. This checks that the
    /// hidden tab stays off screen during the dialog's modal loop and comes back in place. The harness closes the dialog.
    /// </summary>
    private async Task<ModalRecord> NativeDialogAsync(int number, Scale scale, CancellationToken token)
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
        return Modal(number, scale, "native folder dialog", during == 0 && !visibleDuring, during, before, after);
    }

    private ModalRecord Modal(int number, Scale scale, string modal, bool hidden, int during, (DeviceRect? Rect, string? Obstruction) before, (DeviceRect? Rect, string? Obstruction) after)
    {
        var (outcome, reason) =
            during < 0 ? (Outcome.Obstructed, "the screen kept changing while the modal was open")
            : before.Obstruction is not null || after.Obstruction is not null ? (Outcome.Obstructed, before.Obstruction ?? after.Obstruction)
            : !hidden ? (Outcome.Fail, $"the tab stayed visible ({during} tab pixels)")
            : before.Rect is null ? (Outcome.Fail, "no tab in view before the modal")
            : before.Rect != after.Rect ? (Outcome.Fail, $"the tab came back at {after.Rect?.ToString() ?? "nowhere"}, not {before.Rect}")
            : (Outcome.Pass, (string?)null);
        var record = new ModalRecord("modal", number, DateTimeOffset.Now, scale.Dpi, scale.Percent, scale.Simulated, modal, hidden, during, before.Rect, after.Rect, outcome, reason);
        results.Log($"{scale} {modal}: hidden while open {hidden} ({during} tab pixels), back at {after.Rect?.ToString() ?? "-"} → {outcome}{(reason is null ? string.Empty : $" ({reason})")}");
        return record;
    }

    /// <summary>The tab's visible rectangle on screen, or why it could not be seen.</summary>
    private async Task<(DeviceRect? Rect, string? Obstruction)> TabOnScreenAsync(CancellationToken token)
    {
        var area = await SettleAsync(Host.Ui.ZoomFactor, token);
        var client = Host.ClientScreen;
        var zone = TabGeometry.ToDevice(area.Rect, Host.Ui.ZoomFactor, Host.Ui.RasterizationScale).Offset(client.Left, client.Top).Inflate(ZoneMargin).Intersect(client);
        if (await StableAsync(zone, token) is not { } capture)
        {
            return (null, "the screen kept changing");
        }
        if (capture.Bounds(Paint.Tab, zone) is not { } tab)
        {
            return capture.Count(Paint.Other, zone) > 0 ? (null, "something else covered the tab") : (null, null);
        }
        var nearEdge = capture.Count(Paint.Other, tab.Inflate(1)) - (tab.Width > 2 && tab.Height > 2 ? capture.Count(Paint.Other, tab.Inflate(-1)) : 0);
        return capture.Count(Paint.Other, zone) - nearEdge > 0 ? (null, "something else covered the tab") : (tab, null);
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

    private static IEnumerable<string> PassSummary(ScalePass pass)
    {
        foreach (var placement in new[] { nameof(Placement.Renderer), nameof(Placement.Exact) })
        {
            var selected = pass.Placements.Where(item => item.Placement == placement).ToList();
            var judged = selected.Where(item => item.Outcome != Outcome.Obstructed).ToList();
            var worst = judged.Count == 0 ? "-" : judged.Max(item => item.Errors?.Max ?? 0).ToString(CultureInfo.InvariantCulture);
            yield return $"{pass.Scale} {placement}: {judged.Count(item => item.Outcome == Outcome.Pass)} of {selected.Count} placements pass, {selected.Count(item => item.Outcome == Outcome.Fail)} fail, {selected.Count - judged.Count} obstructed; worst edge error {worst} device px";
        }
        yield return $"{pass.Scale} modals: {string.Join("; ", pass.Modals.Select(item => $"{item.Modal} {item.Outcome}"))}";
        yield return $"{pass.Scale}: S3 as designed {pass.Verdict} at this scale (pass {pass.Number}).";
    }

    private void WriteSummary()
    {
        var text = new StringBuilder();
        var invariant = CultureInfo.InvariantCulture;
        text.AppendLine("# Spike S3: tab bounds under display scaling and zoom").AppendLine();
        text.AppendLine(invariant, $"Run {DateTimeOffset.Now:yyyy-MM-dd HH:mm zzz}. {Results.Describe()}.").AppendLine();
        text.AppendLine("Exit criterion: at most 1 device px of error at 100/125/150/200% and zoom 2; hidden behind modals.").AppendLine();
        text.AppendLine("A scale is **met** when its latest pass ran completely and every placement of the design (the UI's whole-pixel bounds) and both modal checks passed; **not met** when any of them failed; **incomplete** when something obstructed the screen. Obstructed measurements are never counted as passes.").AppendLine();
        foreach (var simulated in new[] { false, true })
        {
            var latest = passes.Where(item => item.Scale.Simulated == simulated).GroupBy(item => item.Scale.Percent).Select(group => group.Last()).OrderBy(item => item.Scale.Percent).ToList();
            if (latest.Count == 0 && simulated)
            {
                continue;
            }
            text.AppendLine(simulated ? "## Simulated scales (an arithmetic check; never evidence for the exit criterion)" : "## Verdict").AppendLine();
            if (!simulated)
            {
                var verdicts = TargetScales.Select(percent => (percent, verdict: Latest(percent)?.Verdict ?? "not measured")).ToList();
                var overall = verdicts.Any(item => item.verdict == "not met") ? "not met" : verdicts.All(item => item.verdict == "met") ? "met" : "incomplete";
                text.AppendLine(invariant, $"- **S3 as designed: {overall}.** {string.Join("; ", verdicts.Select(item => $"{item.percent}% {item.verdict}"))}.");
                foreach (var percent in TargetScales)
                {
                    var all = passes.Where(item => item.Scale.Percent == percent && !item.Scale.Simulated).ToList();
                    if (all.Count > 1 && all.Select(item => item.Verdict).Distinct().Count() > 1)
                    {
                        text.AppendLine(invariant, $"- **Passes disagree at {percent}%:** {string.Join(", ", all.Select(item => $"pass {item.Number} {item.Verdict}"))}. The verdict above uses the latest; decide deliberately whether an earlier result stands.");
                    }
                }
                var exact = latest.SelectMany(item => item.Placements).Where(item => item.Placement == nameof(Placement.Exact) && item.Outcome != Outcome.Obstructed).ToList();
                text.AppendLine(invariant, $"- Diagnostic, placed from the page's fractional rectangle (needs a protocol change): {exact.Count(item => item.Outcome == Outcome.Pass)} of {exact.Count} judged placements pass; worst edge error {(exact.Count == 0 ? "-" : exact.Max(item => item.Errors?.Max ?? 0).ToString(invariant))} device px.");
                var rescaled = passes.Where(item => !item.Scale.Simulated && item.Reason == ScalePass.ScaleChange)
                    .Select(item => item.Placements.FirstOrDefault(record => record.Window == "as left" && record.Placement == nameof(Placement.Renderer))).OfType<BoundsRecord>().ToList();
                text.AppendLine(invariant, $"- After a display-scale change, before the harness moved anything, the host had re-synced the tab by itself in {rescaled.Count(item => item.PlacedByEvents == true)} of {rescaled.Count} passes{(rescaled.Count == 0 ? string.Empty : $" (slowest {rescaled.Where(item => item.SyncWaitMilliseconds is not null).Select(item => item.SyncWaitMilliseconds!.Value).DefaultIfEmpty(0).Max()} ms after the UI settled)")}. Passes started otherwise do not count here.");
                foreach (var item in latest.Where(item => item.Placements.Count > 0 && Math.Abs((item.Placements[0].RasterizationScale * 100) - item.Scale.Percent) > 0.5))
                {
                    text.AppendLine(invariant, $"- **Warning:** at {item.Scale} the UI's rasterization scale was {item.Placements[0].RasterizationScale}, not {item.Scale.Percent / 100.0}: text scaling, or a DPI the webview had not caught up with. The scale label may not describe what was measured.");
                }
            }
            text.AppendLine().AppendLine("| Scale | Pass | Verdict | Zoom | Renderer, aligned | Renderer, fractional | Exact, aligned | Exact, fractional |");
            text.AppendLine("|---|---|---|---|---|---|---|---|");
            foreach (var pass in latest)
            {
                foreach (var zoom in Zooms)
                {
                    string Cell(string placement, string layout)
                    {
                        var rows = pass.Placements.Where(item => item.Zoom == zoom && item.Placement == placement && item.Layout == layout && item.Window != "as left").ToList();
                        if (rows.Count == 0)
                        {
                            return "-";
                        }
                        var judged = rows.Where(item => item.Outcome != Outcome.Obstructed).ToList();
                        var worst = judged.Count == 0 ? "obstructed" : $"{judged.Max(item => item.Errors?.Max ?? 0)} px";
                        return rows.Any(item => item.Outcome == Outcome.Fail) ? $"{worst} FAIL" : judged.Count < rows.Count ? $"{worst}, part obstructed" : worst;
                    }
                    text.AppendLine(invariant, $"| {pass.Scale.Percent}% | {pass.Number} | {pass.Verdict} | {zoom} | {Cell("Renderer", "aligned")} | {Cell("Renderer", "fractional")} | {Cell("Exact", "aligned")} | {Cell("Exact", "fractional")} |");
                }
            }
            text.AppendLine();
        }
        text.AppendLine("Errors are signed per edge: positive where the tab stops short of the painted area, negative where it overlaps past it. The worst-error table takes the largest absolute edge error over both window sizes. The fractional layout puts each edge a hair past a whole CSS pixel, the near-worst case for the UI's inward rounding, so the design's error there approaches zoom × scale device px.").AppendLine();
        text.AppendLine("## Placements").AppendLine();
        text.AppendLine("| Pass | Scale | Zoom | Window | Layout | Placement | CSS bounds (renderer) | Placed by events | Errors | Max | Gap px | Overflow px | Outcome |");
        text.AppendLine("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
        foreach (var item in passes.SelectMany(pass => pass.Placements))
        {
            text.AppendLine(invariant, $"| {item.Pass} | {item.ScalePercent}%{(item.Simulated ? " sim" : string.Empty)} | {item.Zoom} | {item.Window} | {item.Layout} | {item.Placement} | {item.Renderer.X},{item.Renderer.Y} {item.Renderer.Width}x{item.Renderer.Height} | {item.PlacedByEvents?.ToString() ?? "-"} | {item.Errors?.ToString() ?? "-"} | {item.Errors?.Max.ToString(invariant) ?? "-"} | {item.GapPixels} | {item.OverflowPixels} | {item.Outcome}{(item.Reason is null ? string.Empty : $": {item.Reason}")} |");
        }
        text.AppendLine().AppendLine("## Modals").AppendLine();
        text.AppendLine("| Pass | Scale | Modal | Hidden while open | Tab pixels while open | Before | After | Outcome |");
        text.AppendLine("|---|---|---|---|---|---|---|---|");
        foreach (var item in passes.SelectMany(pass => pass.Modals))
        {
            text.AppendLine(invariant, $"| {item.Pass} | {item.ScalePercent}%{(item.Simulated ? " sim" : string.Empty)} | {item.Modal} | {item.HiddenWhileOpen} | {item.TabPixelsWhileOpen} | {item.TabBefore?.ToString() ?? "-"} | {item.TabAfter?.ToString() ?? "-"} | {item.Outcome}{(item.Reason is null ? string.Empty : $": {item.Reason}")} |");
        }
        results.Write("summary.md", text.ToString());
    }
}
