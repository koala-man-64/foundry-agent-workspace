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

internal sealed record AttachRecord(string Kind, DateTimeOffset Time, int Generation, IReadOnlyList<LayerResult> Layers, bool Attached, string? Refusal);

internal sealed record TakeoverRecord(
    string Kind, DateTimeOffset Time, int Generation, string Trigger, int QueuedMilliseconds, double DetachMilliseconds,
    double RestoreMilliseconds, bool Restored, string? RestoreError, int HumanEvents, IReadOnlyDictionary<string, int> HumanEventsByType,
    int AgentActions, int Frames, double AttachedSeconds, string Rendering);

internal sealed record BreachRecord(string Kind, DateTimeOffset Time, int Generation, string What);

/// <summary>What the S4 test page counted, read through the DevTools protocol.</summary>
internal sealed record PageSnapshot(int Trusted, int Synthetic, Dictionary<string, int> ByType, string[] Last, int Frames, int AgentClicks);

/// <summary>
/// Spike S4's subject: the plan's agent/human input ladder (section 6) around one tab. Attaching engages every layer or
/// none: (1) the tab host window is disabled, (2) keyboard focus leaves the tab, (3) an owned layered overlay at alpha
/// 1/255 covers it, (4) the renderer ignores input (<c>Input.setIgnoreInputEvents</c>), and (5) key chords that still
/// reach the tab are swallowed. While attached, a stand-in agent acts on the page through host scripts in an isolated
/// world, as <c>TARGET_SCRIPT</c> does. Any button, wheel, touch or pen contact on the overlay takes control: the
/// generation is bumped and the attachment ends first, then the window is re-enabled.
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
    private NativeWindow? overlay;
    private Task restoring = Task.CompletedTask;
    private int generation;
    private bool attached;
    private bool attaching;
    private bool attachInterrupted;
    private bool guardKeys;
    private bool closing;
    private bool agentBusy;
    private bool tabHadFocus;
    private int? isolatedWorld;
    private int agentActions;
    private TimeSpan attachedAt;
    private int framesAtAttach;
    private string rendering = "-";
    private bool? renderingOk;
    private string layersText = "-";
    private bool? layersOk;
    private int liveHuman;
    private string liveHumanText = "0";
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
        agentTimer.Tick += (_, _) => _ = AgentActAsync();
        pollTimer = new DispatcherTimer(DispatcherPriority.Normal, window.Dispatcher) { Interval = TimeSpan.FromMilliseconds(400) };
        pollTimer.Tick += (_, _) => _ = PollAsync();
    }

    private Surface Host => surface ?? throw new InvalidOperationException("The surface is not started.");

    public void Dispose() => overlay?.Dispose();

    public async Task<int> RunAsync()
    {
        results.Log($"S4 input ladder. Results: {results.Directory}");
        results.Log(Results.Describe());
        surface = await Surface.StartAsync(window, new SurfaceOptions(Pages.Load("ui-ladder.html"), Pages.Load("tab-ladder.html"),
            System.Drawing.Color.FromArgb(0x14, 0x27, 0x23), System.Drawing.Color.White), results.Log);
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
        WriteSummary();
        overlay.Dispose();
        await Host.DisposeAsync();
        closing = true;
        window.Close();
        results.Log($"Finished. Summary: {System.IO.Path.Combine(results.Directory, "summary.md")}");
        return code;
    }

    private void OnUiMessage(JsonElement message)
    {
        switch (message.GetProperty("kind").GetString())
        {
            case "attach":
                _ = AttachAsync();
                break;
            case "takeControl":
                TakeControl("the Take control button", 0);
                break;
        }
    }

    /// <summary>Engage all five layers, verifying each, or roll back and refuse, as the plan requires.</summary>
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
        var before = OnScreen() ? Native.CaptureScreen(Host.TabScreen) : null;
        try
        {
            var host = Host.TabHostHwnd;
            Native.EnableWindow(host, false);
            layers.Add(new LayerResult("1 tab host disabled", !Native.IsWindowEnabled(host), "EnableWindow(false)"));

            Host.Ui.MoveFocus(CoreWebView2MoveFocusReason.Programmatic);
            var focus = Native.GetFocus();
            var focusInTab = focus != 0 && (focus == host || Native.IsChild(host, focus));
            layers.Add(new LayerResult("2 focus out of the tab", !focusInTab, focus == 0 ? "no focus window on this thread" : $"focus 0x{focus:X} {(Native.IsChild(Host.Hwnd, focus) ? "in the UI" : "elsewhere")}"));

            var cover = Host.TabScreen;
            ShowOverlay(true);
            var overlayRect = Native.WindowRect(overlay!.Handle);
            layers.Add(new LayerResult("3 overlay over the tab", Native.IsWindowVisible(overlay.Handle) && overlayRect == cover, $"overlay {overlayRect}, tab {cover}"));

            await Surface.CdpAsync(Host.Tab.CoreWebView2, "Input.setIgnoreInputEvents", new { ignore = true });
            layers.Add(new LayerResult("4 renderer ignores input", true, "Input.setIgnoreInputEvents(true)"));

            guardKeys = true;
            layers.Add(new LayerResult("5 key chords swallowed", true, "AcceleratorKeyPressed handled while attached"));

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
        catch (Exception error) when (error is InvalidOperationException or TimeoutException or System.Runtime.InteropServices.COMException)
        {
            refusal = $"error while attaching: {error.Message}";
        }

        if (refusal is not null)
        {
            await DisengageAsync();
            attaching = false;
            layersOk = false;
            layersText = string.Join(" · ", layers.Select(layer => $"{layer.Layer} {(layer.Ok ? "✓" : "✗")}"));
            AddAttach(new AttachRecord("attach", DateTimeOffset.Now, generation, layers, false, refusal));
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
        AddAttach(new AttachRecord("attach", DateTimeOffset.Now, generation, layers, true, null));
        Log($"Attached (generation {generation}); all layers engaged.");
        // Let the blur from moving focus out of the tab arrive before counting starts.
        await Task.Delay(150);
        var start = await SnapshotAsync(reset: true);
        framesAtAttach = start?.Frames ?? 0;
        liveHuman = 0;
        liveHumanText = "0";
        rendering = "checking…";
        renderingOk = null;
        agentTimer.Start();
        pollTimer.Start();
        Push();
        await CheckRenderingAsync(before, generation);
    }

    /// <summary>
    /// Whether the page keeps rendering behind the disabled window and the overlay: its frame counter keeps rising,
    /// the screen keeps changing, and the screen is not dimmed relative to the moment before attaching.
    /// </summary>
    private async Task CheckRenderingAsync(uint[]? before, int expected)
    {
        await Task.Delay(400);
        var first = attached && OnScreen() ? Native.CaptureScreen(Host.TabScreen) : null;
        var framesFirst = (await SnapshotAsync())?.Frames ?? 0;
        await Task.Delay(1000);
        if (!attached || generation != expected)
        {
            return;
        }
        var second = OnScreen() ? Native.CaptureScreen(Host.TabScreen) : null;
        var framesSecond = (await SnapshotAsync())?.Frames ?? 0;
        var rate = framesSecond - framesFirst;
        var changed = first is not null && second is not null && first.Length == second.Length ? first.Zip(second).Count(pair => pair.First != pair.Second) : -1;
        var dimming = before is not null && first is not null && before.Length == first.Length ? Math.Abs(Luminance(before) - Luminance(first)) : double.NaN;
        renderingOk = rate >= 20 && (changed < 0 || changed > 0) && (double.IsNaN(dimming) || dimming < 4);
        rendering = changed < 0
            ? $"{rate} frames/s; screen not checked (window not in front)"
            : $"{rate} frames/s, {changed} pixels changed in 1 s, brightness shift {dimming:0.0}";
        Log($"Rendering while attached: {rendering} → {(renderingOk == true ? "ok" : "PROBLEM")}");
        Push();
    }

    private static double Luminance(uint[] pixels) =>
        pixels.Average(pixel => (0.2126 * ((pixel >> 16) & 0xFF)) + (0.7152 * ((pixel >> 8) & 0xFF)) + (0.0722 * (pixel & 0xFF)));

    /// <summary>Whether this window is what the user sees at the tab's center.</summary>
    private bool OnScreen()
    {
        var rect = Host.TabScreen;
        var top = Native.WindowFromPoint(new NativePoint { X = rect.Left + (rect.Width / 2), Y = rect.Top + (rect.Height / 2) });
        return top != 0 && (top == overlay?.Handle || top == Host.TabHostHwnd || Native.IsChild(Host.TabHostHwnd, top) || Native.IsChild(Host.Hwnd, top));
    }

    /// <summary>The plan's take control: bump the generation and detach first, then re-enable the window.</summary>
    private void TakeControl(string trigger, int queuedMilliseconds)
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
        restoring = RestoreAsync(trigger, queuedMilliseconds, start, detached);
    }

    private async Task RestoreAsync(string trigger, int queued, TimeSpan start, TimeSpan detached)
    {
        // Read what reached the page while attached before anything is re-enabled.
        PageSnapshot? page = null;
        string? error = null;
        try
        {
            page = await SnapshotAsync();
        }
        catch (Exception failure) when (failure is InvalidOperationException or TimeoutException or System.Runtime.InteropServices.COMException)
        {
            error = $"reading the page: {failure.Message}";
        }
        var disengaged = await DisengageAsync();
        error = error is null ? disengaged : disengaged is null ? error : $"{error}; {disengaged}";
        var restoredAt = clock.Elapsed;
        var restored = error is null && Native.IsWindowEnabled(Host.TabHostHwnd) && !Native.IsWindowVisible(overlay!.Handle);
        var record = new TakeoverRecord("takeover", DateTimeOffset.Now, generation, trigger, queued,
            queued + (detached - start).TotalMilliseconds, queued + (restoredAt - start).TotalMilliseconds, restored, error,
            page?.Trusted ?? -1, page?.ByType ?? [], agentActions, (page?.Frames ?? 0) - framesAtAttach,
            (start - attachedAt).TotalSeconds, rendering);
        takeovers.Add(record);
        results.Record(record);
        lastTakeoverOk = record.DetachMilliseconds < 100 && restored && record.HumanEvents == 0;
        lastTakeover = string.Create(CultureInfo.InvariantCulture,
            $"{trigger}: detached in {record.DetachMilliseconds:0.0} ms (restored in {record.RestoreMilliseconds:0.0} ms); human events while attached {record.HumanEvents}");
        Log($"Take control by {trigger}: detach {record.DetachMilliseconds:0.0} ms (input queued {queued} ms), restore {record.RestoreMilliseconds:0.0} ms, human events on page {record.HumanEvents}{(record.HumanEvents > 0 ? $" ({string.Join(", ", record.HumanEventsByType.Select(pair => $"{pair.Key} {pair.Value}"))})" : string.Empty)}, agent actions {agentActions}{(error is null ? string.Empty : $", restore problem: {error}")}");
        agentActions = 0;
        Push();
    }

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
        var rect = Host.TabScreen;
        Native.SetWindowPos(overlay.Handle, Native.HwndTop, rect.Left, rect.Top, rect.Width, rect.Height,
            Native.SwpNoActivate | Native.SwpNoOwnerZOrder | (show ? Native.SwpShowWindow : Native.SwpHideWindow));
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
        if (!attached || agentBusy)
        {
            return;
        }
        agentBusy = true;
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
        finally
        {
            agentBusy = false;
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
        if (!attached)
        {
            return;
        }
        if (await SnapshotAsync() is { } page && attached)
        {
            liveHuman = page.Trusted;
            liveHumanText = page.Trusted == 0 ? "0" : $"{page.Trusted}: {string.Join(", ", page.ByType.Select(pair => $"{pair.Key} {pair.Value}"))}";
            Push();
        }
    }

    private async Task<PageSnapshot?> SnapshotAsync(bool reset = false)
    {
        var value = await Surface.EvaluateAsync(Host.Tab.CoreWebView2, reset ? "window.__s4.reset() && window.__s4.snapshot()" : "window.__s4 ? window.__s4.snapshot() : null");
        return value.ValueKind == JsonValueKind.Object ? value.Deserialize<PageSnapshot>(Json) : null;
    }

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
        var worst = takeovers.Count == 0 ? "" : string.Create(CultureInfo.InvariantCulture, $"; worst detach {takeovers.Max(item => item.DetachMilliseconds):0.0} ms");
        Host.Post(new
        {
            kind = "state",
            attached,
            generation,
            state = attached ? "Attached: the agent is acting; your input should not reach the page" : attaching ? "Attaching…" : "Manual browsing",
            layers = layersText,
            layersOk,
            agentActions,
            trusted = liveHuman,
            trustedText = attached ? liveHumanText : "-",
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
            var page = await SnapshotAsync();
            if (!Native.IsWindowVisible(overlay!.Handle) || Native.IsWindowEnabled(Host.TabHostHwnd))
            {
                problems.Add($"round {round}: a layer was not in place while attached");
            }
            if (agentActions == 0 || page is null || page.AgentClicks == 0)
            {
                problems.Add($"round {round}: the agent did not act");
            }
            if (page is { Trusted: > 0 })
            {
                problems.Add($"round {round}: {page.Trusted} human events reached the page ({string.Join(", ", page.ByType.Select(pair => $"{pair.Key} {pair.Value}"))})");
            }
            TakeControl("self-check", 0);
            await restoring;
            var last = takeovers[^1];
            if (!last.Restored || last.DetachMilliseconds >= 100)
            {
                problems.Add($"round {round}: take control did not restore cleanly ({last.RestoreError ?? $"{last.DetachMilliseconds} ms"})");
            }
            if (renderingOk == false)
            {
                problems.Add($"round {round}: rendering problem ({rendering})");
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
        var human = takeovers.Sum(item => Math.Max(0, item.HumanEvents));
        var worst = takeovers.Count == 0 ? double.NaN : takeovers.Max(item => item.DetachMilliseconds);
        text.AppendLine("## Totals").AppendLine();
        text.AppendLine(invariant, $"- Attachments: {attaches.Count(item => item.Attached)}; refused: {attaches.Count(item => !item.Attached)}.");
        text.AppendLine(invariant, $"- Takeovers: {takeovers.Count}; worst detach {worst:0.0} ms (criterion: under 100 ms).");
        text.AppendLine(invariant, $"- Human events that reached the page while attached: {human}.");
        text.AppendLine(invariant, $"- Breaches (focus or keys inside an attached tab): {breaches.Count}.");
        text.AppendLine(invariant, $"- Rendering checks with a problem: {takeovers.Count(item => item.Rendering.Contains("PROBLEM", StringComparison.Ordinal))} (see each takeover).").AppendLine();
        text.AppendLine("## Takeovers").AppendLine();
        text.AppendLine("| Time | Trigger | Detach ms | Restore ms | Human events while attached | Agent actions | Frames | Rendering | Restored |");
        text.AppendLine("|---|---|---|---|---|---|---|---|---|");
        foreach (var item in takeovers)
        {
            var events = item.HumanEvents == 0 ? "0" : $"{item.HumanEvents} ({string.Join(", ", item.HumanEventsByType.Select(pair => $"{pair.Key} {pair.Value}"))})";
            text.AppendLine(invariant, $"| {item.Time:HH:mm:ss} | {item.Trigger} | {item.DetachMilliseconds:0.0} | {item.RestoreMilliseconds:0.0} | {events} | {item.AgentActions} | {item.Frames} | {item.Rendering} | {item.Restored}{(item.RestoreError is null ? string.Empty : $": {item.RestoreError}")} |");
        }
        text.AppendLine().AppendLine("## Refused attachments and breaches").AppendLine();
        foreach (var item in attaches.Where(item => !item.Attached))
        {
            text.AppendLine(invariant, $"- {item.Time:HH:mm:ss} attach refused: {item.Refusal}");
        }
        foreach (var item in breaches)
        {
            text.AppendLine(invariant, $"- {item.Time:HH:mm:ss} breach (generation {item.Generation}): {item.What}");
        }
        text.AppendLine().AppendLine("Detach is measured from the input's message time (GetMessageTime, about 16 ms resolution) to the end of the attachment. Restore also includes reading the page's counters and re-enabling every layer.");
        results.Write("summary.md", text.ToString());
    }
}
