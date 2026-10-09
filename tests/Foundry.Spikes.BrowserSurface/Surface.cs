using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Core;

namespace Foundry.Spikes.BrowserSurface;

/// <summary>Which CSS rectangle positions the tab.</summary>
internal enum Placement
{
    /// <summary>The whole-pixel bounds the unchanged UI sends: the design under test.</summary>
    Renderer,
    /// <summary>The fractional rectangle the page measured: a diagnostic that separates the UI's rounding from the platform's.</summary>
    Exact,
}

/// <summary>What the UI page measured for the browser area, after a layout settled.</summary>
internal sealed record AreaReport(int Sequence, string Layout, CssRect Rect, double InnerWidth, double InnerHeight, double DevicePixelRatio);

/// <summary>What the spike's pages need from the host.</summary>
/// <param name="TabPage">The tab's HTML, loaded as a string, or with <paramref name="TabUri"/> the address the tab opens.</param>
internal sealed record SurfaceOptions(string UiPage, string TabPage, System.Drawing.Color UiBackground, System.Drawing.Color TabBackground, Uri? TabUri = null);

/// <summary>
/// The plan's browser surface (section 6) on a real window: the app UI in one WebView2 environment, and one tab in a
/// separate browser environment and user-data folder. The tab is its own child window (the tab host) above the UI,
/// positioned in device pixels at CSS pixels times the UI <c>ZoomFactor</c> times its <c>RasterizationScale</c>, and
/// re-synced on <c>ZoomFactorChanged</c>, <c>RasterizationScaleChanged</c> and resize. Every call runs on the UI thread.
/// </summary>
internal sealed class Surface : IAsyncDisposable
{
    private readonly Window window;
    private readonly Action<string> log;
    private readonly List<(string Folder, TaskCompletionSource Exited)> environments = [];
    private CoreWebView2Controller? ui;
    private CoreWebView2Controller? tab;
    private NativeWindow? tabHost;
    private CssBounds bounds = CssBounds.Hidden;
    private int hidden;

    private Surface(Window window, Action<string> log)
    {
        this.window = window;
        this.log = log;
    }

    public nint Hwnd { get; private set; }

    public nint TabHostHwnd => tabHost?.Handle ?? 0;

    public CoreWebView2Controller Ui => ui ?? throw new InvalidOperationException("The surface is not started.");

    public CoreWebView2Controller Tab => tab ?? throw new InvalidOperationException("The surface is not started.");

    public Placement Placement { get; set; } = Placement.Renderer;

    /// <summary>The last whole-pixel bounds the UI sent.</summary>
    public CssBounds Bounds => bounds;

    /// <summary>How many bounds messages the UI has sent; the UI suppresses repeats, as BrowserPanel does.</summary>
    public int BoundsMessages { get; private set; }

    /// <summary>The page's last measurement of the browser area.</summary>
    public AreaReport? Area { get; private set; }

    /// <summary>Where the last sync put the tab, relative to the main window's client area.</summary>
    public DeviceRect TabRect { get; private set; }

    public bool TabShown { get; private set; }

    /// <summary>Raised after every sync of the tab's position.</summary>
    public event Action? Synced;

    /// <summary>Raised when the main window moves, so owned windows can follow.</summary>
    public event Action? Moved;

    /// <summary>Every UI message other than bounds and area reports, as parsed JSON.</summary>
    public event Action<JsonElement>? UiMessage;

    public static async Task<Surface> StartAsync(Window window, SurfaceOptions options, Action<string> log)
    {
        var surface = new Surface(window, log);
        try
        {
            await surface.CreateAsync(options);
        }
        catch
        {
            await surface.DisposeAsync(); // A half-built surface still owns its temporary user-data folders.
            throw;
        }
        return surface;
    }

    public uint Dpi => Native.GetDpiForWindow(Hwnd);

    /// <summary>The main window's client area in screen coordinates; the UI webview fills it.</summary>
    public DeviceRect ClientScreen => Native.ClientScreenRect(Hwnd);

    /// <summary>The tab host's rectangle in screen coordinates.</summary>
    public DeviceRect TabScreen => Native.WindowRect(TabHostHwnd);

    public void Post(object message) => Ui.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(message));

    /// <summary>
    /// Hide the tab whatever the UI says, as the host does while a native dialog is open (<c>index.ts:151</c>) and the
    /// harness does to photograph the area beneath it. Calls nest.
    /// </summary>
    public void Hide(bool hide)
    {
        hidden = Math.Max(0, hidden + (hide ? 1 : -1));
        Sync();
    }

    /// <summary>Position the tab from the latest bounds, zoom factor, rasterization scale and client size.</summary>
    public void Sync()
    {
        if (ui is null || tab is null || tabHost is null)
        {
            return;
        }
        Native.GetClientRect(Hwnd, out var client);
        if (ui.Bounds.Width != client.Right || ui.Bounds.Height != client.Bottom)
        {
            ui.Bounds = new System.Drawing.Rectangle(0, 0, client.Right, client.Bottom);
        }
        var css = Placement == Placement.Exact && Area is { } area ? area.Rect : bounds.ToRect();
        var device = TabGeometry.Clamp(TabGeometry.ToDevice(css, ui.ZoomFactor, ui.RasterizationScale), client.Right, client.Bottom);
        var visible = bounds.Visible && hidden == 0 && !device.IsEmpty;
        Native.SetWindowPos(tabHost.Handle, Native.HwndTop, device.Left, device.Top, device.Width, device.Height,
            Native.SwpNoActivate | (visible ? Native.SwpShowWindow : Native.SwpHideWindow));
        tab.Bounds = new System.Drawing.Rectangle(0, 0, device.Width, device.Height);
        tab.IsVisible = visible;
        TabRect = device;
        TabShown = visible;
        Synced?.Invoke();
    }

    /// <summary>Call a DevTools protocol method through the host's own session.</summary>
    public static async Task<JsonElement> CdpAsync(CoreWebView2 core, string method, object parameters)
    {
        var json = await core.CallDevToolsProtocolMethodAsync(method, JsonSerializer.Serialize(parameters)).WaitAsync(TimeSpan.FromSeconds(15));
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    /// <summary>Evaluate an expression (awaiting a promise) in the main world or an isolated world, and return its value.</summary>
    public static async Task<JsonElement> EvaluateAsync(CoreWebView2 core, string expression, int? contextId = null)
    {
        var parameters = new Dictionary<string, object> { ["expression"] = expression, ["returnByValue"] = true, ["awaitPromise"] = true };
        if (contextId is { } id)
        {
            parameters["contextId"] = id;
        }
        var result = await CdpAsync(core, "Runtime.evaluate", parameters);
        if (result.TryGetProperty("exceptionDetails", out var details))
        {
            throw new InvalidOperationException($"The evaluation threw: {details}");
        }
        return result.GetProperty("result").TryGetProperty("value", out var value) ? value : default;
    }

    /// <summary>Wait until a page has rendered two more frames and the compositor has presented them.</summary>
    public static async Task PaintedAsync(CoreWebView2 core)
    {
        await EvaluateAsync(core, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
        Native.FlushComposition();
        Native.FlushComposition();
    }

    public async ValueTask DisposeAsync()
    {
        tab?.Close();
        ui?.Close();
        tab = null;
        ui = null;
        tabHost?.Dispose();
        tabHost = null;
        foreach (var (folder, exited) in environments)
        {
            // The browser process exits once its last webview closes; then its user-data folder can go.
            await Task.WhenAny(exited.Task, Task.Delay(TimeSpan.FromSeconds(15)));
            for (var attempt = 0; attempt < 20; attempt++)
            {
                try
                {
                    Directory.Delete(folder, recursive: true);
                    break;
                }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException)
                {
                    await Task.Delay(250);
                }
            }
        }
    }

    private async Task CreateAsync(SurfaceOptions options)
    {
        Hwnd = new WindowInteropHelper(window).EnsureHandle();
        HwndSource.FromHwnd(Hwnd).AddHook(MainWindowHook);
        window.Show();

        var uiEnvironment = await EnvironmentAsync("foundry-spike-ui-", new CoreWebView2EnvironmentOptions());
        ui = await uiEnvironment.CreateCoreWebView2ControllerAsync(Hwnd).WaitAsync(TimeSpan.FromSeconds(60));
        ui.DefaultBackgroundColor = options.UiBackground;
        var settings = ui.CoreWebView2.Settings;
        settings.AreDevToolsEnabled = false;
        settings.AreHostObjectsAllowed = false;
        settings.AreDefaultContextMenusEnabled = false;
        settings.AreDefaultScriptDialogsEnabled = false;
        settings.AreBrowserAcceleratorKeysEnabled = false; // Section 4. Zoom stays enabled.
        settings.IsStatusBarEnabled = false;
        ui.CoreWebView2.WebMessageReceived += OnUiMessage;
        ui.ZoomFactorChanged += (_, _) => Sync();
        ui.RasterizationScaleChanged += (_, _) => Sync();
        ui.CoreWebView2.ProcessFailed += (_, e) => log($"UI process failed: {e.ProcessFailedKind}");

        // The integrated browser's own environment: a separate browser process, no shared workers (decision 9).
        var browserEnvironment = await EnvironmentAsync("foundry-spike-browser-", new CoreWebView2EnvironmentOptions("--disable-blink-features=SharedWorker"));
        tabHost = new NativeWindow("Foundry tab host", Native.WsChild | Native.WsClipSiblings | Native.WsClipChildren, 0, Hwnd);
        var controllerOptions = browserEnvironment.CreateCoreWebView2ControllerOptions();
        controllerOptions.ProfileName = "workspace-browser-v1";
        tab = await browserEnvironment.CreateCoreWebView2ControllerAsync(tabHost.Handle, controllerOptions).WaitAsync(TimeSpan.FromSeconds(60));
        tab.DefaultBackgroundColor = options.TabBackground;
        tab.IsVisible = false;
        var tabSettings = tab.CoreWebView2.Settings;
        tabSettings.IsWebMessageEnabled = false; // Section 6: tabs have no host channel.
        tabSettings.AreDevToolsEnabled = false;
        tabSettings.AreHostObjectsAllowed = false;
        tabSettings.AreDefaultContextMenusEnabled = false;
        tabSettings.IsGeneralAutofillEnabled = false;
        tabSettings.IsPasswordAutosaveEnabled = false;
        tabSettings.IsStatusBarEnabled = false;
        tab.CoreWebView2.ProcessFailed += (_, e) => log($"Tab process failed: {e.ProcessFailedKind}");

        Sync();
        await Task.WhenAll(NavigateAsync(ui.CoreWebView2, options.UiPage), NavigateAsync(tab.CoreWebView2, options.TabPage, options.TabUri));
    }

    private async Task<CoreWebView2Environment> EnvironmentAsync(string prefix, CoreWebView2EnvironmentOptions options)
    {
        var folder = Directory.CreateTempSubdirectory(prefix).FullName;
        var exited = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        environments.Add((folder, exited));
        var environment = await CoreWebView2Environment.CreateAsync(browserExecutableFolder: null, folder, options).WaitAsync(TimeSpan.FromSeconds(60));
        environment.BrowserProcessExited += (_, _) => exited.TrySetResult();
        return environment;
    }

    private static async Task NavigateAsync(CoreWebView2 core, string html, Uri? uri = null)
    {
        var completed = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        void OnCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e) => completed.TrySetResult(e.IsSuccess);
        core.NavigationCompleted += OnCompleted;
        try
        {
            if (uri is not null)
            {
                core.Navigate(uri.AbsoluteUri);
            }
            else
            {
                core.NavigateToString(html);
            }
            if (!await completed.Task.WaitAsync(TimeSpan.FromSeconds(30)))
            {
                throw new InvalidOperationException("A spike page failed to load.");
            }
        }
        finally
        {
            core.NavigationCompleted -= OnCompleted;
        }
    }

    private void OnUiMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string text;
        try
        {
            text = e.TryGetWebMessageAsString();
        }
        catch (ArgumentException)
        {
            log("Ignored a non-string UI message.");
            return;
        }
        try
        {
            using var document = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 8 });
            var message = document.RootElement;
            switch (message.GetProperty("kind").GetString())
            {
                case "bounds":
                    bounds = ParseBounds(message.GetProperty("bounds"));
                    BoundsMessages++;
                    Sync();
                    break;
                case "area":
                    var rect = message.GetProperty("rect");
                    Area = new AreaReport(message.GetProperty("seq").GetInt32(), message.GetProperty("layout").GetString() ?? "",
                        new CssRect(rect.GetProperty("left").GetDouble(), rect.GetProperty("top").GetDouble(), rect.GetProperty("right").GetDouble(), rect.GetProperty("bottom").GetDouble()),
                        message.GetProperty("innerWidth").GetDouble(), message.GetProperty("innerHeight").GetDouble(), message.GetProperty("dpr").GetDouble());
                    UiMessage?.Invoke(message.Clone());
                    break;
                default:
                    UiMessage?.Invoke(message.Clone());
                    break;
            }
        }
        catch (Exception error) when (error is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
        {
            log($"Ignored a malformed UI message: {error.Message}");
        }
    }

    /// <summary>The renderer's bounds, held to <c>BrowserBoundsSchema</c>: whole numbers from 0 to 30000 and a boolean.</summary>
    private static CssBounds ParseBounds(JsonElement value)
    {
        static int Whole(JsonElement parent, string name)
        {
            var number = parent.GetProperty(name).GetInt32();
            return number is >= 0 and <= 30000 ? number : throw new FormatException($"{name} is out of range.");
        }
        return new CssBounds(Whole(value, "x"), Whole(value, "y"), Whole(value, "width"), Whole(value, "height"), value.GetProperty("visible").GetBoolean());
    }

    private nint MainWindowHook(nint hwnd, int message, nint wParam, nint lParam, ref bool handled)
    {
        if ((uint)message == Native.WmSize)
        {
            Sync();
        }
        else if ((uint)message == Native.WmMove)
        {
            ui?.NotifyParentWindowPositionChanged();
            tab?.NotifyParentWindowPositionChanged();
            Moved?.Invoke();
        }
        return 0;
    }
}
