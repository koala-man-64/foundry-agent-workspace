using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;

namespace Foundry.Spikes.BrowserSurface;

internal sealed record LayerResult(string Layer, bool Ok, string Detail);

/// <param name="SettlingInput">Input events between the start of the attach and the hover baseline; they count against the attachment.</param>
/// <param name="SettlingHover">Hover and focus events in the same window (such as the tab's blur), which may settle.</param>
/// <param name="OutOfProcessFrames">Frames Chromium reported as separate targets (out of process), or null if unknown.</param>
internal sealed record AttachRecord(
    string Kind, DateTimeOffset Time, int Generation, IReadOnlyList<LayerResult> Layers, bool Attached, string? Refusal,
    IReadOnlyDictionary<string, int>? SettlingInput, IReadOnlyDictionary<string, int>? SettlingHover, IReadOnlyList<string>? Frames,
    int? OutOfProcessFrames);

/// <param name="DetachMilliseconds">From the human's input to the end of the attachment.</param>
/// <param name="InputEvents">Trusted input events that reached the page or its frames while attached; -1 if unknown.</param>
/// <param name="HoverEvents">Trusted hover, focus and scroll events while attached, which the browser can also generate itself.</param>
/// <param name="Unknown">Why the page's counts are unknown for this attachment, if they are.</param>
/// <param name="AgentEffectsAfterInput">Agent clicks or typing that landed in the page after the human's input.</param>
internal sealed record TakeoverRecord(
    string Kind, DateTimeOffset Time, int Generation, string Trigger, int QueuedMilliseconds, double DetachMilliseconds,
    double RestoreMilliseconds, bool Restored, string? RestoreError, int InputEvents, IReadOnlyDictionary<string, int> InputByType,
    int HoverEvents, IReadOnlyDictionary<string, int> HoverByType, string? Unknown, IReadOnlyList<string> StateChanges,
    int AgentActions, int AgentEffectsAfterInput, double? AgentLastAfterInputMilliseconds, int Rendered, double AttachedSeconds,
    string Rendering, bool? RenderingOk);

internal sealed record BreachRecord(string Kind, DateTimeOffset Time, int Generation, string What);

internal sealed record PageState(bool HasFocus, string Active, double ScrollX, double ScrollY, string Href, int History);

/// <summary>What the S4 test page and its frames counted, read through the DevTools protocol.</summary>
internal sealed record PageSnapshot(
    string LoadId, Dictionary<string, int> Input, Dictionary<string, int> Hover, int Synthetic, string[] Last, Dictionary<string, string> Frames,
    int Rendered, int AgentClicks, double[] AgentTimes, PageState State);

/// <summary>
/// Spike S4's subject: the plan's agent/human input ladder (section 6) around one tab. Attaching engages every layer or
/// none: (1) the tab host window is disabled, (2) keyboard focus leaves the tab, (3) an owned layered overlay at alpha
/// 1/255 covers it, (4) the renderer ignores input (<c>Input.setIgnoreInputEvents</c>), and (5) key chords that still
/// reach the tab are swallowed. While attached, a stand-in agent acts on the page through host scripts in an isolated
/// world, as <c>TARGET_SCRIPT</c> does. Any button, wheel, touch or pen contact on the overlay takes control: the
/// generation is bumped and the attachment ends first, then the window is re-enabled. The test page, served from
/// loopback with a same-origin and a cross-site frame, counts every trusted event in every frame and timestamps every
/// agent effect, so the takeover can be judged by when the agent last changed the page.
/// Rudy drives every input himself (docs/spikes/s4-input-ladder.md). Nothing here generates input.
/// </summary>
internal sealed class LadderSpike : IDisposable
{
    private const string AgentScript = """
        (() => {
          const button = document.getElementById('agent-button');
          const field = document.getElementById('agent-field');
          if (!button || !field) return false;
          HTMLElement.prototype.click.call(button);
          field.value = (field.value + 'agent ').slice(-48);
          field.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()
        """;

    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };

    private readonly Results results;
    private readonly bool selfCheck;
    private readonly Window window;
    private readonly Stopwatch clock = Stopwatch.StartNew();
    private readonly List<string> recent = [];
    private readonly List<AttachRecord> attaches = [];
    private readonly List<TakeoverRecord> takeovers = [];
    private readonly List<BreachRecord> breaches = [];
    private readonly TaskCompletionSource<int> finished = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly DispatcherTimer agentTimer;
    private readonly DispatcherTimer pollTimer;
    private Surface? surface;
    private LoopbackSite? site;
    private NativeWindow? overlay;
    private Task restoring = Task.CompletedTask;
    private Task agentTask = Task.CompletedTask;
    private PageSnapshot? baseline;
    private PageSnapshot? inputBaseline;
    private static readonly string[] ExpectedFrames = ["same-origin-frame", "cross-site-frame"];
    private int generation;
    private bool attached;
    private bool attaching;
    private bool attachInterrupted;
    private bool guardKeys;
    private bool closing;
    private bool tabHadFocus;
    private int? isolatedWorld;
    private int agentActions;
    private TimeSpan attachedAt;
    private string rendering = "-";
    private bool? renderingOk;
    private string layersText = "-";
    private bool? layersOk;
    private int liveInput;
    private string liveText = "-";
    private string lastTakeover = "-";
    private bool? lastTakeoverOk;

    public LadderSpike(Results results, bool selfCheck)
    {
        this.results = results;
        this.selfCheck = selfCheck;
        window = new Window
        {
            Title = "Foundry S4 input ladder",
            Background = new SolidColorBrush(Color.FromRgb(0x14, 0x27, 0x23)),
            WindowStartupLocation = WindowStartupLocation.Manual,
            Left = 24, Top = 24, Width = 1240, Height = 820,
            ShowActivated = !selfCheck,
        };
        window.Closing += (_, e) =>
        {
            if (!closing)
            {
                e.Cancel = true;
                finished.TrySetResult(0);
            }
        };
        agentTimer = new DispatcherTimer(DispatcherPriority.Normal, window.Dispatcher) { Interval = TimeSpan.FromMilliseconds(700) };
        agentTimer.Tick += (_, _) =>
        {
            if (agentTask.IsCompleted)
            {
                agentTask = AgentActAsync();
            }
        };
        pollTimer = new DispatcherTimer(DispatcherPriority.Normal, window.Dispatcher) { Interval = TimeSpan.FromMilliseconds(400) };
        pollTimer.Tick += (_, _) => _ = PollAsync();
    }

    private Surface Host => surface ?? throw new InvalidOperationException("The surface is not started.");

    public void Dispose() => overlay?.Dispose();

    public async Task<int> RunAsync()
    {
        results.Log($"S4 input ladder. Results: {results.Directory}");
        results.Log(Results.Describe());
        try
        {
            var page = Pages.Load("tab-ladder.html");
            var frame = Pages.Load("tab-frame.html");
            site = new LoopbackSite((path, otherOrigin) => path switch
            {
                "/" => page.Replace("{{OTHER}}", otherOrigin, StringComparison.Ordinal),
                "/frame" => frame,
                _ => null,
            });
            surface = await Surface.StartAsync(window, new SurfaceOptions(Pages.Load("ui-ladder.html"), string.Empty,
                System.Drawing.Color.FromArgb(0x14, 0x27, 0x23), System.Drawing.Color.White, new Uri(site.Origin + "/")), results.Log);
            FitToWorkArea();
            Host.UiMessage += OnUiMessage;
            Host.Synced += AlignOverlay;
            Host.Moved += AlignOverlay;
            Host.Tab.AcceleratorKeyPressed += OnTabKey;
            Host.Tab.GotFocus += (_, _) =>
            {
                tabHadFocus = true;
                if (attached)
                {
                    Breach("keyboard focus entered the tab");
                    Host.Ui.MoveFocus(CoreWebView2MoveFocusReason.Programmatic);
                    TakeControl("focus entered the tab", 0);
                }
            };
            Host.Ui.GotFocus += (_, _) => tabHadFocus = false;
            // Tab key traversal between the UI and the tab, as the host will do it, refused into an attached tab.
            Host.Ui.MoveFocusRequested += (_, e) =>
            {
                if (e.Reason is not (CoreWebView2MoveFocusReason.Next or CoreWebView2MoveFocusReason.Previous))
                {
                    return;
                }
                e.Handled = true;
                if (attached || attaching || !Host.TabShown)
                {
                    Log("Tab-key traversal into the attached tab was refused; focus stays in the UI.");
                    Host.Ui.MoveFocus(e.Reason);
                    return;
                }
                Host.Tab.MoveFocus(e.Reason);
            };
            Host.Tab.MoveFocusRequested += (_, e) =>
            {
                if (e.Reason is CoreWebView2MoveFocusReason.Next or CoreWebView2MoveFocusReason.Previous)
                {
                    e.Handled = true;
                    Host.Ui.MoveFocus(e.Reason);
                }
            };
            window.Activated += (_, _) =>
            {
                // Keyboard input goes to the UI webview, never to an attached tab.
                if (attached || attaching || !tabHadFocus)
                {
                    Host.Ui.MoveFocus(CoreWebView2MoveFocusReason.Programmatic);
                }
            };
            overlay = new NativeWindow("Foundry input overlay", Native.WsPopup, Native.WsExLayered | Native.WsExNoActivate | Native.WsExToolWindow, Host.Hwnd)
            {
                OnMessage = OnOverlayMessage,
            };
            if (!Native.SetLayeredWindowAttributes(overlay.Handle, 0, 1, Native.LwaAlpha))
            {
                throw new InvalidOperationException("The overlay could not be made layered.");
            }
            Log("Ready. Follow docs/spikes/s4-input-ladder.md.");
            Push();
            var code = selfCheck ? await SelfCheckAsync() : await finished.Task;
            if (attached)
            {
                TakeControl("window closing", 0);
            }
            await restoring;
            return code;
        }
        finally
        {
            // Release the webviews' temporary profiles and the server even if the summary cannot be written.
            try
            {
                WriteSummary();
            }
            finally
            {
                overlay?.Dispose();
                overlay = null;
                try
                {
                    if (surface is not null)
                    {
                        await surface.DisposeAsync();
                    }
                }
                finally
                {
                    if (site is not null)
                    {
                        await site.DisposeAsync();
                    }
                    closing = true;
                    window.Close();
                    results.Log($"Finished. Summary: {System.IO.Path.Combine(results.Directory, "summary.md")}");
                }
            }
        }
    }

    private void OnUiMessage(JsonElement message)
    {
        switch (message.GetProperty("kind").GetString())
        {
            case "attach":
                _ = AttachAsync();
                break;
            case "takeControl":
                // Measured from the click in the UI, which the page timestamps; a missing or implausible time means now.
                var now = DateTimeOffset.UtcNow;
                var at = message.TryGetProperty("at", out var value) && value.TryGetInt64(out var milliseconds) ? DateTimeOffset.FromUnixTimeMilliseconds(milliseconds) : now;
                if (at > now || now - at > TimeSpan.FromSeconds(5))
                {
                    at = now;
                }
                TakeControl("the Take control button", (int)(now - at).TotalMilliseconds, at);
                break;
        }
    }

    /// <summary>Engage all five layers, verifying what can be verified, or roll back and refuse, as the plan requires.</summary>
    private async Task AttachAsync()
    {
        await restoring;
        if (attached || attaching)
        {
            return;
        }
        if (!Host.TabShown)
        {
            Log("Attach refused: the tab is not visible.");
            return;
        }
        attaching = true;
        attachInterrupted = false;
        var layers = new List<LayerResult>();
        string? refusal = null;
        var (before, screen) = OnScreen() ? (Native.CaptureScreen(VisibleTab()), VisibleTab()) : ((uint[]?)null, default(DeviceRect));
        PageSnapshot? start = null;
        try
        {
            // The input baseline, taken before any layer engages; the page's own counter starts here too.
            start = await SnapshotAsync(mark: "attached");
            var host = Host.TabHostHwnd;
            Native.EnableWindow(host, false);
            layers.Add(new LayerResult("1 tab host disabled", !Native.IsWindowEnabled(host), "EnableWindow(false), checked with IsWindowEnabled"));

            Host.Ui.MoveFocus(CoreWebView2MoveFocusReason.Programmatic);
            var focus = Native.GetFocus();
            var inFront = Native.GetForegroundWindow() == Host.Hwnd;
            var focusInTab = focus != 0 && (focus == host || Native.IsChild(host, focus));
            layers.Add(new LayerResult("2 focus out of the tab", focus != 0 ? !focusInTab : !inFront,
                focus != 0 ? $"focus 0x{focus:X} {(focusInTab ? "IN THE TAB" : Native.IsChild(Host.Hwnd, focus) ? "in the UI" : "elsewhere in this app")}"
                : inFront ? "no focus window although this window is in front" : "this window is not in front, so it has no keyboard focus"));

            var cover = Host.TabScreen;
            ShowOverlay(true);
            var overlayRect = Native.WindowRect(overlay!.Handle);
            layers.Add(new LayerResult("3 overlay over the tab", Native.IsWindowVisible(overlay.Handle) && overlayRect == cover, $"overlay {overlayRect}, tab {cover}"));

            await Surface.CdpAsync(Host.Tab.CoreWebView2, "Input.setIgnoreInputEvents", new { ignore = true });
            layers.Add(new LayerResult("4 renderer ignores input", true, "Input.setIgnoreInputEvents(true) accepted (CDP has no way to read it back)"));

            guardKeys = true;
            layers.Add(new LayerResult("5 key chords swallowed", true, "AcceleratorKeyPressed handler armed"));

            // Section 6's upload control while attached; not a ladder layer, but it decides what an OLE drop meets.
            Host.Tab.AllowExternalDrop = false;
            layers.Add(new LayerResult("external drop off", !Host.Tab.AllowExternalDrop, "AllowExternalDrop=false"));

            if (attachInterrupted)
            {
                refusal = "human input arrived while attaching";
            }
            else if (layers.FirstOrDefault(layer => !layer.Ok) is { } failed)
            {
                refusal = $"layer failed: {failed.Layer} ({failed.Detail})";
            }
        }
        catch (Exception error) when (error is InvalidOperationException or TimeoutException or System.Runtime.InteropServices.COMException or JsonException)
        {
            refusal = $"error while attaching: {error.Message}";
        }

        if (refusal is not null)
        {
            await DisengageAsync();
            attaching = false;
            layersOk = false;
            layersText = string.Join(" · ", layers.Select(layer => $"{layer.Layer} {(layer.Ok ? "✓" : "✗")}"));
            try
            {
                await Surface.EvaluateAsync(Host.Tab.CoreWebView2, "window.__s4 && window.__s4.mark('manual')");
            }
            catch (Exception error) when (error is InvalidOperationException or TimeoutException or System.Runtime.InteropServices.COMException)
            {
                // The page's display only; the refusal stands either way.
            }
            AddAttach(new AttachRecord("attach", DateTimeOffset.Now, generation, layers, false, refusal, null, null, null, null));
            Log($"Attach refused: {refusal}");
            Push();
            return;
        }

        generation++;
        attached = true;
        attaching = false;
        attachedAt = clock.Elapsed;
        layersOk = true;
        layersText = string.Join(" · ", layers.Select(layer => $"{layer.Layer} ✓"));
        // Let the blur from moving focus out of the tab arrive, then take the hover baseline. Input that arrived since
        // the attach began counts against the attachment; hover and focus events here are reported, not counted.
        await Task.Delay(150);
        baseline = await SnapshotAsync();
        inputBaseline = start;
        var settlingInput = start is null || baseline is null ? null : Minus(baseline.Input, start.Input);
        var settlingHover = start is null || baseline is null ? null : Minus(baseline.Hover, start.Hover);
        var outOfProcess = await OutOfProcessFramesAsync();
        AddAttach(new AttachRecord("attach", DateTimeOffset.Now, generation, layers, true, null, settlingInput, settlingHover, baseline?.Frames.Keys.ToList(), outOfProcess));
        Log($"Attached (generation {generation}); all layers engaged{(settlingInput is { Count: > 0 } ? $"; INPUT reached the page while attaching: {Describe(settlingInput)}" : string.Empty)}{(settlingHover is { Count: > 0 } ? $"; hover and focus events while attaching: {Describe(settlingHover)}" : string.Empty)}; frames in their own process: {outOfProcess?.ToString(CultureInfo.InvariantCulture) ?? "unknown"}.");
        if (baseline is null || !ExpectedFrames.All(baseline.Frames.ContainsKey))
        {
            Log("Not every frame has reported, so this attachment's counts will be unknown.");
        }
        liveInput = 0;
        liveText = "0";
        rendering = "checking…";
        renderingOk = null;
        agentTimer.Start();
        pollTimer.Start();
        Push();
        await CheckRenderingAsync(before, screen, generation, baseline?.Rendered ?? 0);
    }

    /// <summary>
    /// Whether the page keeps rendering behind the disabled window and the overlay: its frame counter keeps rising, and,
    /// when this window is what the user sees, the screen keeps changing and is not dimmed against the moment before.
    /// </summary>
    private async Task CheckRenderingAsync(uint[]? before, DeviceRect screen, int expected, int renderedAtBaseline)
    {
        await Task.Delay(400);
        var onScreen = before is not null && attached && OnScreen() && VisibleTab() == screen;
        var first = onScreen ? Native.CaptureScreen(screen) : null;
        var renderedFirst = (await SnapshotAsync())?.Rendered ?? renderedAtBaseline;
        await Task.Delay(1000);
        if (!attached || generation != expected)
        {
            return;
        }
        var second = first is not null && OnScreen() && VisibleTab() == screen ? Native.CaptureScreen(screen) : null;
        var rate = ((await SnapshotAsync())?.Rendered ?? renderedFirst) - renderedFirst;
        if (first is null || second is null)
        {
            renderingOk = rate < 20 ? false : null;
            rendering = $"{rate} frames/s; the screen was not checked (this window was not fully in view)";
        }
        else
        {
            var changed = first.Zip(second).Count(pair => pair.First != pair.Second);
            var dimming = Math.Abs(Luminance(before!) - Luminance(first));
            renderingOk = rate >= 20 && changed > 0 && dimming < 4;
            rendering = string.Create(CultureInfo.InvariantCulture, $"{rate} frames/s, {changed} pixels changed in 1 s, brightness shift {dimming:0.0}");
        }
        Log($"Rendering while attached: {rendering} → {(renderingOk == true ? "ok" : renderingOk == false ? "PROBLEM" : "not judged on screen")}");
        Push();
    }

    private static double Luminance(uint[] pixels) =>
        pixels.Average(pixel => (0.2126 * ((pixel >> 16) & 0xFF)) + (0.7152 * ((pixel >> 8) & 0xFF)) + (0.0722 * (pixel & 0xFF)));

    /// <summary>The tab's rectangle, clipped to the monitor's work area, so a capture never reads off-screen black.</summary>
    private DeviceRect VisibleTab() => Host.TabScreen.Intersect(Native.WorkArea(Host.Hwnd));

    /// <summary>Whether this window is what the user sees at the tab's center.</summary>
    private bool OnScreen()
    {
        var rect = Host.TabScreen;
        var top = Native.WindowFromPoint(new NativePoint { X = rect.Left + (rect.Width / 2), Y = rect.Top + (rect.Height / 2) });
        return top != 0 && (top == overlay?.Handle || top == Host.TabHostHwnd || Native.IsChild(Host.TabHostHwnd, top) || Native.IsChild(Host.Hwnd, top));
    }

    /// <summary>
    /// The plan's take control: bump the generation and detach first, then re-enable the window.
    /// </summary>
    /// <param name="queuedMilliseconds">How long the input waited before reaching the host.</param>
    /// <param name="inputAt">When the human acted; by default, now less the time the input waited.</param>
    private void TakeControl(string trigger, int queuedMilliseconds, DateTimeOffset? inputAt = null)
    {
        if (attaching)
        {
            attachInterrupted = true;
            return;
        }
        if (!attached)
        {
            return;
        }
        var start = clock.Elapsed;
        generation++;
        attached = false;
        agentTimer.Stop();
        pollTimer.Stop();
        var detached = clock.Elapsed;
        restoring = RestoreAsync(trigger, queuedMilliseconds, inputAt ?? DateTimeOffset.UtcNow.AddMilliseconds(-queuedMilliseconds), start, detached);
    }

    private async Task RestoreAsync(string trigger, int queued, DateTimeOffset inputAt, TimeSpan start, TimeSpan detached)
    {
        string? error = null;
        // An agent action already sent to the page cannot be recalled: let it land, so its effect is counted.
        try
        {
            await agentTask.WaitAsync(TimeSpan.FromSeconds(3));
        }
        catch (TimeoutException)
        {
            error = "an agent action was still running 3 s after the takeover";
        }
        await Task.Delay(60); // Frames report their counts to the page asynchronously.
        PageSnapshot? page = null;
        try
        {
            page = await SnapshotAsync();
            await Surface.EvaluateAsync(Host.Tab.CoreWebView2, "window.__s4.mark('after')");
        }
        catch (Exception failure) when (failure is InvalidOperationException or TimeoutException or System.Runtime.InteropServices.COMException or JsonException)
        {
            error = Join(error, $"reading the page: {failure.Message}");
        }
        error = Join(error, await DisengageAsync());
        var restoredAt = clock.Elapsed;
        var restored = error is null && Native.IsWindowEnabled(Host.TabHostHwnd) && !Native.IsWindowVisible(overlay!.Handle);

        var unknown = page is null ? "the page could not be read"
            : baseline is null || inputBaseline is null ? "no baseline was taken at attach"
            : page.LoadId != inputBaseline.LoadId ? "the page reloaded while attached, so its counters restarted"
            : FrameProblem(inputBaseline.Frames, page.Frames);
        var input = unknown is null ? Minus(page!.Input, inputBaseline!.Input) : [];
        var hover = unknown is null ? Minus(page!.Hover, baseline!.Hover) : [];
        var changes = unknown is null ? StateChanges(baseline!.State, page!.State) : [];
        double inputMilliseconds = inputAt.ToUnixTimeMilliseconds(); // The page's Date.now() reads the same system clock.
        var late = page?.AgentTimes.Where(time => time > inputMilliseconds).ToList() ?? [];
        var record = new TakeoverRecord("takeover", DateTimeOffset.Now, generation, trigger, queued,
            queued + (detached - start).TotalMilliseconds, queued + (restoredAt - start).TotalMilliseconds, restored, error,
            unknown is null ? input.Values.Sum() : -1, input, hover.Values.Sum(), hover, unknown, changes, agentActions, late.Count,
            late.Count == 0 ? null : late.Max() - inputMilliseconds, (page?.Rendered ?? 0) - (baseline?.Rendered ?? 0),
            (start - attachedAt).TotalSeconds, rendering, renderingOk);
        takeovers.Add(record);
        results.Record(record);
        lastTakeoverOk = Detached(record) && restored && record.InputEvents == 0;
        lastTakeover = string.Create(CultureInfo.InvariantCulture,
            $"{trigger}: detached in {record.DetachMilliseconds:0.0} ms (restored in {record.RestoreMilliseconds:0.0} ms); human events while attached {(unknown is null ? record.InputEvents.ToString(CultureInfo.InvariantCulture) : "UNKNOWN")}{(late.Count > 0 ? $"; agent changed the page {record.AgentLastAfterInputMilliseconds:0} ms after the input" : string.Empty)}");
        Log(string.Create(CultureInfo.InvariantCulture, $"Take control by {trigger}: detach {record.DetachMilliseconds:0.0} ms (input queued {queued} ms), restore {record.RestoreMilliseconds:0.0} ms, input events on page {(unknown ?? (input.Count == 0 ? "0" : Describe(input)))}, hover/focus {(hover.Count == 0 ? "0" : Describe(hover))}, agent actions {agentActions}, agent effects after the input {late.Count}{(changes.Count > 0 ? $", page state changed: {string.Join("; ", changes)}" : string.Empty)}{(error is null ? string.Empty : $", restore problem: {error}")}"));
        agentActions = 0;
        baseline = null;
        inputBaseline = null;
        Push();
    }

    /// <summary>The detach criterion: the attachment ended within 100 ms of the input, and the agent changed nothing later than that.</summary>
    private static bool Detached(TakeoverRecord record) => record.DetachMilliseconds < 100 && (record.AgentLastAfterInputMilliseconds is null or < 100);

    /// <summary>Undo every layer; returns a description of anything that failed.</summary>
    private async Task<string?> DisengageAsync()
    {
        string? error = null;
        guardKeys = false;
        try
        {
            await Surface.CdpAsync(Host.Tab.CoreWebView2, "Input.setIgnoreInputEvents", new { ignore = false });
        }
        catch (Exception failure) when (failure is InvalidOperationException or TimeoutException or System.Runtime.InteropServices.COMException)
        {
            error = $"Input.setIgnoreInputEvents(false): {failure.Message}";
        }
        Native.EnableWindow(Host.TabHostHwnd, true);
        ShowOverlay(false);
        Host.Tab.AllowExternalDrop = true;
        return error;
    }

    private void ShowOverlay(bool show)
    {
        if (overlay is null)
        {
            return;
        }
        // An owned window always stays above its owner, so the z-order is left alone: raising it explicitly could lift the
        // invisible overlay above another application's window while this one is in the background.
        var rect = Host.TabScreen;
        Native.SetWindowPos(overlay.Handle, 0, rect.Left, rect.Top, rect.Width, rect.Height,
            Native.SwpNoActivate | Native.SwpNoZOrder | (show ? Native.SwpShowWindow : Native.SwpHideWindow));
    }

    /// <summary>Keep the overlay exactly over the tab as the window moves, resizes, zooms or changes scale.</summary>
    private void AlignOverlay() => ShowOverlay((attached || attaching) && Host.TabShown);

    private nint? OnOverlayMessage(uint message, nint wParam, nint lParam)
    {
        if (message == Native.WmMouseActivate)
        {
            return Native.MaNoActivate; // Never activate the overlay; the main window keeps the focus.
        }
        var trigger = message switch
        {
            Native.WmLButtonDown or Native.WmLButtonDoubleClick => "left button",
            Native.WmRButtonDown or Native.WmRButtonDoubleClick => "right button",
            Native.WmMButtonDown or Native.WmMButtonDoubleClick => "middle button",
            Native.WmXButtonDown or Native.WmXButtonDoubleClick => "side button",
            Native.WmMouseWheel => "wheel",
            Native.WmMouseHWheel => "horizontal wheel",
            Native.WmPointerDown => $"{PointerKind(wParam)} contact",
            Native.WmPointerWheel or Native.WmPointerHWheel => $"{PointerKind(wParam)} wheel",
            Native.WmTouch => "touch",
            _ => null,
        };
        if (trigger is null)
        {
            return null; // Moves and hovers do not take control, as in Electron.
        }
        TakeControl(trigger, unchecked(Environment.TickCount - Native.GetMessageTime()));
        return 0;
    }

    private static string PointerKind(nint wParam) =>
        Native.GetPointerType((uint)(wParam & 0xFFFF), out var type) ? type switch
        {
            Native.PointerTypeTouch => "touch",
            Native.PointerTypePen => "pen",
            Native.PointerTypeMouse => "mouse",
            Native.PointerTypeTouchpad => "touchpad",
            _ => $"pointer type {type}",
        } : "pointer";

    private void OnTabKey(object? sender, CoreWebView2AcceleratorKeyPressedEventArgs e)
    {
        if (!guardKeys)
        {
            return;
        }
        e.Handled = true;
        if (e.KeyEventKind is CoreWebView2KeyEventKind.KeyDown or CoreWebView2KeyEventKind.SystemKeyDown)
        {
            Breach($"key 0x{e.VirtualKey:X2} reached the tab");
            TakeControl("a key in the tab", 0);
        }
    }

    private async Task AgentActAsync()
    {
        if (!attached)
        {
            return;
        }
        var expected = generation;
        try
        {
            isolatedWorld ??= await IsolatedWorldAsync();
            if (attached && generation == expected
                && (await Surface.EvaluateAsync(Host.Tab.CoreWebView2, AgentScript, isolatedWorld)).ValueKind == JsonValueKind.True)
            {
                agentActions++;
            }
        }
        catch (Exception error) when (error is InvalidOperationException or TimeoutException or System.Runtime.InteropServices.COMException or KeyNotFoundException)
        {
            isolatedWorld = null; // A navigation discards the world; the next action makes a new one.
            Log($"Agent action failed: {error.Message}");
        }
    }

    private async Task<int> IsolatedWorldAsync()
    {
        var tree = await Surface.CdpAsync(Host.Tab.CoreWebView2, "Page.getFrameTree", new { });
        var frameId = tree.GetProperty("frameTree").GetProperty("frame").GetProperty("id").GetString();
        var world = await Surface.CdpAsync(Host.Tab.CoreWebView2, "Page.createIsolatedWorld", new { frameId, worldName = "Foundry Browser Host", grantUniveralAccess = false });
        return world.GetProperty("executionContextId").GetInt32();
    }

    private async Task PollAsync()
    {
        if (!attached || baseline is null || inputBaseline is null)
        {
            return;
        }
        var page = await SnapshotAsync();
        if (!attached || baseline is null || inputBaseline is null)
        {
            return;
        }
        var problem = page is null ? "the page's counts could not be read"
            : page.LoadId != inputBaseline.LoadId ? "the page reloaded"
            : FrameProblem(inputBaseline.Frames, page.Frames);
        if (page is null || problem is not null)
        {
            liveInput = -1;
            liveText = $"UNKNOWN: {problem}";
        }
        else
        {
            var input = Minus(page.Input, inputBaseline.Input);
            var hover = Minus(page.Hover, baseline.Hover);
            liveInput = input.Values.Sum();
            liveText = $"{(input.Count == 0 ? "0" : Describe(input))}{(hover.Count == 0 ? string.Empty : $" · hover/focus {Describe(hover)}")}";
        }
        Push();
    }

    /// <summary>Why the frames' counts cannot be trusted for an attachment, or null if every frame reported throughout.</summary>
    private static string? FrameProblem(Dictionary<string, string> before, Dictionary<string, string> after)
    {
        foreach (var frame in ExpectedFrames)
        {
            if (!before.TryGetValue(frame, out var load))
            {
                return $"the {frame} had not reported when the attachment began";
            }
            if (!after.TryGetValue(frame, out var now))
            {
                return $"the {frame} stopped reporting";
            }
            if (now != load)
            {
                return $"the {frame} reloaded while attached, so its counters restarted";
            }
        }
        return null;
    }

    /// <summary>How many of the tab's frames Chromium runs as separate targets (out of process), or null if unknown.</summary>
    private async Task<int?> OutOfProcessFramesAsync()
    {
        try
        {
            var targets = await Surface.CdpAsync(Host.Tab.CoreWebView2, "Target.getTargets", new { });
            return targets.GetProperty("targetInfos").EnumerateArray().Count(target => target.GetProperty("type").GetString() == "iframe");
        }
        catch (Exception error) when (error is InvalidOperationException or TimeoutException or System.Runtime.InteropServices.COMException or KeyNotFoundException)
        {
            results.Log($"Could not list the tab's targets: {error.Message}");
            return null;
        }
    }

    /// <summary>The page's counts, or null when they cannot be read; callers treat null as unknown, never as zero.</summary>
    /// <param name="mark">A phase for the page's own counter display, set in the same evaluation as the snapshot.</param>
    private async Task<PageSnapshot?> SnapshotAsync(string? mark = null)
    {
        try
        {
            var expression = mark is null ? "window.__s4 ? window.__s4.snapshot() : null"
                : $"window.__s4 ? (() => {{ const snapshot = window.__s4.snapshot(); window.__s4.mark('{mark}'); return snapshot; }})() : null";
            var value = await Surface.EvaluateAsync(Host.Tab.CoreWebView2, expression);
            return value.ValueKind == JsonValueKind.Object ? value.Deserialize<PageSnapshot>(Json) : null;
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException or TimeoutException or System.Runtime.InteropServices.COMException)
        {
            results.Log($"Could not read the page's counts: {error.Message}");
            return null;
        }
    }

    private static Dictionary<string, int> Minus(Dictionary<string, int> now, Dictionary<string, int> then) =>
        now.Select(pair => (pair.Key, Count: pair.Value - then.GetValueOrDefault(pair.Key))).Where(pair => pair.Count > 0).ToDictionary(pair => pair.Key, pair => pair.Count);

    private static Dictionary<string, int> Merge(Dictionary<string, int> first, Dictionary<string, int> second)
    {
        var merged = new Dictionary<string, int>(first);
        foreach (var (type, count) in second)
        {
            merged[type] = merged.GetValueOrDefault(type) + count;
        }
        return merged;
    }

    private static List<string> StateChanges(PageState before, PageState after)
    {
        var changes = new List<string>();
        if (after.HasFocus && !before.HasFocus)
        {
            changes.Add("the page gained keyboard focus");
        }
        if (after.Active != before.Active)
        {
            changes.Add($"the focused element changed from {before.Active} to {after.Active}");
        }
        if (Math.Abs(after.ScrollX - before.ScrollX) > 0.5 || Math.Abs(after.ScrollY - before.ScrollY) > 0.5)
        {
            changes.Add("the page scrolled");
        }
        if (after.Href != before.Href || after.History != before.History)
        {
            changes.Add($"the page navigated to {after.Href}");
        }
        return changes;
    }

    private static string Describe(IReadOnlyDictionary<string, int> counts) => string.Join(", ", counts.Select(pair => $"{pair.Key} {pair.Value}"));

    private static string? Join(string? first, string? second) => first is null ? second : second is null ? first : $"{first}; {second}";

    private void Breach(string what)
    {
        var record = new BreachRecord("breach", DateTimeOffset.Now, generation, what);
        breaches.Add(record);
        results.Record(record);
        Log($"BREACH: {what}");
    }

    private void AddAttach(AttachRecord record)
    {
        attaches.Add(record);
        results.Record(record);
    }

    private void Log(string line)
    {
        results.Log(line);
        recent.Add($"{DateTime.Now.ToString("HH:mm:ss", CultureInfo.InvariantCulture)} {line}");
        if (recent.Count > 14)
        {
            recent.RemoveAt(0);
        }
        Push();
    }

    private void Push()
    {
        if (surface is null)
        {
            return;
        }
        var worst = takeovers.Count == 0 ? string.Empty : string.Create(CultureInfo.InvariantCulture, $"; worst detach {takeovers.Max(item => item.DetachMilliseconds):0.0} ms");
        Host.Post(new
        {
            kind = "state",
            attached,
            generation,
            state = attached ? "Attached: the agent is acting; your input should not reach the page" : attaching ? "Attaching…" : "Manual browsing",
            layers = layersText,
            layersOk,
            agentActions,
            trusted = attached ? liveInput : 0,
            trustedText = attached ? liveText : "-",
            rendering,
            renderingOk,
            takeover = lastTakeover,
            takeoverOk = lastTakeoverOk,
            breaches = breaches.Count,
            takeovers = $"{takeovers.Count}{worst}",
            log = recent,
        });
    }

    private void FitToWorkArea()
    {
        var work = Native.WorkArea(Host.Hwnd);
        Native.SetWindowPos(Host.Hwnd, 0, work.Left + 16, work.Top + 16, Math.Min(work.Width - 32, 1600), Math.Min(work.Height - 32, 1000), Native.SwpNoZOrder | Native.SwpNoActivate);
    }

    /// <summary>Exercise attach and take control through the host's own command path, without any input.</summary>
    private async Task<int> SelfCheckAsync()
    {
        var problems = new List<string>();
        for (var round = 1; round <= 3; round++)
        {
            await AttachAsync();
            if (!attached)
            {
                problems.Add($"round {round}: attach refused ({layersText})");
                break;
            }
            await Task.Delay(2500);
            if (!Native.IsWindowVisible(overlay!.Handle) || Native.IsWindowEnabled(Host.TabHostHwnd))
            {
                problems.Add($"round {round}: a layer was not in place while attached");
            }
            TakeControl("self-check", 0);
            await restoring;
            var last = takeovers[^1];
            if (last.Unknown is not null)
            {
                problems.Add($"round {round}: the page's counts are unknown ({last.Unknown})");
            }
            else if (last.InputEvents > 0)
            {
                problems.Add($"round {round}: {last.InputEvents} input events reached the page ({Describe(last.InputByType)})");
            }
            if (last.AgentActions == 0)
            {
                problems.Add($"round {round}: the agent did not act");
            }
            if (!last.Restored || !Detached(last))
            {
                problems.Add($"round {round}: take control did not detach and restore cleanly ({last.RestoreError ?? $"{last.DetachMilliseconds} ms, agent {last.AgentLastAfterInputMilliseconds} ms after"})");
            }
            if (last.RenderingOk == false)
            {
                problems.Add($"round {round}: rendering problem ({last.Rendering})");
            }
        }
        foreach (var problem in problems)
        {
            Log($"Self-check problem: {problem}");
        }
        Log(problems.Count == 0 ? "Self-check passed." : "Self-check found problems.");
        return problems.Count == 0 ? 0 : 4;
    }

    private void WriteSummary()
    {
        var invariant = CultureInfo.InvariantCulture;
        var text = new StringBuilder();
        text.AppendLine(selfCheck ? "# Spike S4: input ladder (self-check, no input)" : "# Spike S4: input ladder (manual run)").AppendLine();
        text.AppendLine(invariant, $"Run {DateTimeOffset.Now:yyyy-MM-dd HH:mm zzz}. {Results.Describe()}.").AppendLine();
        text.AppendLine("What the app measured. Rudy's observations go in the recording sheet of docs/spikes/s4-input-ladder.md.").AppendLine();
        text.AppendLine("Exit criterion: zero events reach the page except UIA (documented); detach under 100 ms; disabled HWND renders correctly. Otherwise apply decision 7.").AppendLine();
        var known = takeovers.Where(item => item.Unknown is null).ToList();
        var input = known.Aggregate(new Dictionary<string, int>(), (total, item) => Merge(total, new Dictionary<string, int>(item.InputByType)));
        var hover = known.Aggregate(new Dictionary<string, int>(), (total, item) => Merge(total, new Dictionary<string, int>(item.HoverByType)));
        var late = takeovers.Where(item => item.AgentEffectsAfterInput > 0).ToList();
        text.AppendLine("## Totals").AppendLine();
        text.AppendLine(invariant, $"- Attachments: {attaches.Count(item => item.Attached)}; refused: {attaches.Count(item => !item.Attached)}.");
        text.AppendLine(invariant, $"- Takeovers: {takeovers.Count}; worst detach {(takeovers.Count == 0 ? "-" : takeovers.Max(item => item.DetachMilliseconds).ToString("0.0", invariant))} ms; detached under 100 ms with no later agent effect: {takeovers.Count(Detached)} of {takeovers.Count}.");
        text.AppendLine(invariant, $"- Agent effects that landed after the human's input: {late.Sum(item => item.AgentEffectsAfterInput)} in {late.Count} takeovers{(late.Count == 0 ? string.Empty : $"; the latest {late.Max(item => item.AgentLastAfterInputMilliseconds):0} ms after the input")}.");
        text.AppendLine(invariant, $"- **Input events that reached the page or its frames while attached: {input.Values.Sum()}**{(input.Count == 0 ? string.Empty : $" ({Describe(input)})")}.");
        text.AppendLine(invariant, $"- Hover, focus and scroll events while attached, which the browser can also generate itself: {hover.Values.Sum()}{(hover.Count == 0 ? string.Empty : $" ({Describe(hover)})")}.");
        text.AppendLine(invariant, $"- Takeovers whose page counts are unknown (counted as failures): {takeovers.Count - known.Count}{string.Concat(takeovers.Where(item => item.Unknown is not null).Select(item => $"; {item.Time:HH:mm:ss} {item.Unknown}"))}.");
        text.AppendLine(invariant, $"- Page state changes while attached (focus, scroll, navigation): {takeovers.Sum(item => item.StateChanges.Count)}.");
        text.AppendLine(invariant, $"- Breaches (focus or keys inside an attached tab): {breaches.Count}.");
        text.AppendLine(invariant, $"- Rendering while attached: {takeovers.Count(item => item.RenderingOk == true)} ok, {takeovers.Count(item => item.RenderingOk == false)} with a problem, {takeovers.Count(item => item.RenderingOk is null)} not judged on screen.");
        var frames = attaches.Where(item => item.Frames is not null).SelectMany(item => item.Frames!).Distinct().ToList();
        text.AppendLine(invariant, $"- Frames reporting to the page's counter: {(frames.Count == 0 ? "none" : string.Join(", ", frames))}; frames Chromium ran in their own process at attach: {string.Join(", ", attaches.Where(item => item.Attached).Select(item => item.OutOfProcessFrames?.ToString(invariant) ?? "unknown").Distinct())}.").AppendLine();
        text.AppendLine("## Takeovers").AppendLine();
        text.AppendLine("| Time | Trigger | Detach ms | Agent after input | Restore ms | Input events while attached | Hover/focus | Page state | Agent actions | Rendering | Restored |");
        text.AppendLine("|---|---|---|---|---|---|---|---|---|---|---|");
        foreach (var item in takeovers)
        {
            var events = item.Unknown is not null ? $"UNKNOWN: {item.Unknown}" : item.InputEvents == 0 ? "0" : $"{item.InputEvents} ({Describe(item.InputByType)})";
            text.AppendLine(invariant, $"| {item.Time:HH:mm:ss} | {item.Trigger} | {item.DetachMilliseconds:0.0} | {(item.AgentEffectsAfterInput == 0 ? "none" : $"{item.AgentEffectsAfterInput}, last +{item.AgentLastAfterInputMilliseconds:0} ms")} | {item.RestoreMilliseconds:0.0} | {events} | {(item.HoverEvents == 0 ? "0" : Describe(item.HoverByType))} | {(item.StateChanges.Count == 0 ? "unchanged" : string.Join("; ", item.StateChanges))} | {item.AgentActions} | {item.Rendering} | {item.Restored}{(item.RestoreError is null ? string.Empty : $": {item.RestoreError}")} |");
        }
        text.AppendLine().AppendLine("## Attachments, refusals and breaches").AppendLine();
        foreach (var item in attaches)
        {
            if (item.Attached)
            {
                text.AppendLine(invariant, $"- {item.Time:HH:mm:ss} attached (generation {item.Generation}); input while attaching (counted against the attachment): {(item.SettlingInput is { Count: > 0 } settledInput ? $"**{Describe(settledInput)}**" : "none")}; hover and focus while attaching: {(item.SettlingHover is { Count: > 0 } settledHover ? Describe(settledHover) : "none")}");
            }
            else
            {
                text.AppendLine(invariant, $"- {item.Time:HH:mm:ss} attach refused: {item.Refusal}");
            }
        }
        foreach (var item in breaches)
        {
            text.AppendLine(invariant, $"- {item.Time:HH:mm:ss} breach (generation {item.Generation}): {item.What}");
        }
        text.AppendLine().AppendLine("Detach runs from the human's input to the end of the attachment: for the mouse, wheel, touch and pen from the input's message time (GetMessageTime, about 16 ms resolution); for the Take control button from the click in the UI. The agent's effects are timestamped in the page; an effect after the input means the agent was still acting on the page then. Restore also includes waiting for any agent action in flight, reading the page's counters and re-enabling every layer.");
        results.Write("summary.md", text.ToString());
    }
}
