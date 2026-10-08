using System.IO;
using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using Xunit;

namespace Foundry.WebView2.Tests;

/// <summary>A test page: body, content type and the response headers the custom scheme sends with it.</summary>
internal sealed record Page(string Body, string ContentType, string? ContentSecurityPolicy = null);

/// <summary>Something the WebView2 reported to the host, in arrival order.</summary>
internal sealed record Observation(string Kind, string Source, string? Text, bool IsString);

/// <param name="AdditionalBrowserArguments">Switches passed through the API.</param>
/// <param name="CancelForeignNavigation">Cancel every navigation that leaves the app origin.</param>
/// <param name="AdoptPopups">Adopt a popup as another webview of the environment, keeping its opener, instead of opening nothing.</param>
/// <param name="UserDataFolder">An existing user-data folder to reuse instead of a fresh temporary one.</param>
/// <param name="KeepUserDataFolder">Leave the user-data folder in place on disposal, so another rig can restart on it.</param>
/// <param name="WebMessages">The webviews' <c>IsWebMessageEnabled</c>; the integrated browser's tabs turn it off.</param>
internal sealed record RigOptions(
    string? AdditionalBrowserArguments = null, bool CancelForeignNavigation = false, bool AdoptPopups = false,
    string? UserDataFolder = null, bool KeepUserDataFolder = false, bool WebMessages = true);

/// <summary>How a navigation completed.</summary>
internal sealed record Navigation(bool IsSuccess, CoreWebView2WebErrorStatus Status, int HttpStatusCode);

/// <summary>
/// A real WebView2 environment on its own STA thread. Each webview sits behind a hidden, non-activating window parked off
/// screen. The rig serves pages for the foundry-app scheme from memory with real response headers. Every WebView2 call
/// runs on that thread. Downloads are cancelled, and permission, authentication, certificate and external-scheme
/// prompts are refused, unless a test says otherwise, so no test can write to the user's folders or open a dialog.
/// </summary>
internal sealed class Rig : IAsyncDisposable
{
    public const string Scheme = "foundry-app";
    public const string AppOrigin = "foundry-app://ui";
    public const string AppUri = "foundry-app://ui/index.html";

    private readonly Dispatcher dispatcher;
    private readonly IReadOnlyDictionary<string, Page> pages;
    private readonly RigOptions options;
    private readonly ConcurrentQueue<Observation> observations = new();
    private readonly SemaphoreSlim arrived = new(0);
    private readonly TaskCompletionSource browserExited = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly List<(Window Window, CoreWebView2Controller Controller, CoreWebView2 Core)> tabs = []; // The rig's thread only.
    private CoreWebView2Environment? environment;

    private Rig(Dispatcher dispatcher, IReadOnlyDictionary<string, Page> pages, RigOptions options, string userDataFolder)
    {
        this.dispatcher = dispatcher;
        this.pages = pages;
        this.options = options;
        UserDataFolder = userDataFolder;
    }

    public string UserDataFolder { get; }

    /// <summary>The profile's default download folder, inside the temporary user-data folder.</summary>
    public string DownloadFolder => Path.Combine(UserDataFolder, "downloads");

    public uint BrowserProcessId { get; private set; }

    public IReadOnlyList<Observation> Observations => observations.ToArray();

    /// <summary>Messages from pages, as the plan's gate would read them.</summary>
    public IEnumerable<Observation> Messages => observations.Where(item => item.Kind == "message");

    /// <summary>Decides each download on the rig's thread. Without it, every download is cancelled.</summary>
    public Action<CoreWebView2DownloadStartingEventArgs>? OnDownload { get; set; }

    /// <summary>Sees, on the rig's thread, each request that matches a filter a test added. The rig serves foundry-app itself.</summary>
    public Action<CoreWebView2WebResourceRequestedEventArgs, CoreWebView2Environment>? OnRequest { get; set; }

    /// <summary>Sees each navigation start, redirects included, on the rig's thread, after the rig's own handling.</summary>
    public Action<CoreWebView2NavigationStartingEventArgs>? OnNavigation { get; set; }

    public static async Task<Rig> StartAsync(IReadOnlyDictionary<string, Page> pages, RigOptions? options = null)
    {
        options ??= new RigOptions();
        var ready = new TaskCompletionSource<Dispatcher>(TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(() =>
        {
            ready.SetResult(Dispatcher.CurrentDispatcher);
            Dispatcher.Run();
        }) { IsBackground = true, Name = "WebView2 rig" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        var dispatcher = await ready.Task;
        var userDataFolder = options.UserDataFolder ?? Directory.CreateTempSubdirectory("foundry-webview2-").FullName;
        var rig = new Rig(dispatcher, pages, options, userDataFolder);
        await rig.OnThread(rig.CreateAsync);
        return rig;
    }

    /// <summary>Navigate and wait for the navigation to complete.</summary>
    public Task<Navigation> NavigateAsync(string uri, int tab = 0) => OnThread(async () =>
    {
        var core = Core(tab);
        var completed = new TaskCompletionSource<Navigation>(TaskCreationOptions.RunContinuationsAsynchronously);
        void OnCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e) => completed.TrySetResult(new Navigation(e.IsSuccess, e.WebErrorStatus, e.HttpStatusCode));
        core.NavigationCompleted += OnCompleted;
        try
        {
            core.Navigate(uri);
            return await completed.Task.WaitAsync(TimeSpan.FromSeconds(30));
        }
        finally
        {
            core.NavigationCompleted -= OnCompleted;
        }
    });

    public Task<string> SourceAsync(int tab = 0) => OnThread(() => Task.FromResult(Core(tab).Source));

    public Task<int> TabCountAsync() => OnThread(() => Task.FromResult(tabs.Count));

    /// <summary>Run code against one webview on the rig's thread.</summary>
    public Task<T> RunAsync<T>(Func<CoreWebView2, Task<T>> action, int tab = 0) => OnThread(() => action(Core(tab)));

    public Task RunAsync(Func<CoreWebView2, Task> action, int tab = 0) => OnThread(() => action(Core(tab)));

    /// <summary>Call a DevTools protocol method through the host's own session, as the plan's browser tools do.</summary>
    public async Task<JsonElement> CdpAsync(string method, object parameters, int tab = 0)
    {
        // Bounded, so that a promise the page never settles fails the test instead of hanging the run.
        var json = await OnThread(() => Core(tab).CallDevToolsProtocolMethodAsync(method, JsonSerializer.Serialize(parameters))).WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    /// <summary>Evaluate in the page's main world, or in an isolated world's context, and return the value.</summary>
    public async Task<JsonElement> EvaluateAsync(string expression, int? contextId = null, int tab = 0)
    {
        var parameters = new Dictionary<string, object> { ["expression"] = expression, ["returnByValue"] = true, ["awaitPromise"] = true };
        if (contextId is { } id)
        {
            parameters["contextId"] = id;
        }
        var result = await CdpAsync("Runtime.evaluate", parameters, tab);
        if (result.TryGetProperty("exceptionDetails", out var details))
        {
            throw new InvalidOperationException($"The evaluation threw: {details}");
        }
        return result.GetProperty("result").TryGetProperty("value", out var value) ? value : default;
    }

    /// <summary>Record each occurrence of a DevTools protocol event as a "cdp" observation.</summary>
    public Task ListenAsync(string cdpEvent, int tab = 0) => OnThread(() =>
    {
        Core(tab).GetDevToolsProtocolEventReceiver(cdpEvent).DevToolsProtocolEventReceived += (_, e) => Record(new Observation("cdp", cdpEvent, e.ParameterObjectAsJson, false));
        return Task.CompletedTask;
    });

    /// <summary>Wait until an observation matches, or fail after the timeout.</summary>
    public async Task<Observation> WaitForAsync(Func<Observation, bool> match, string description, int seconds = 15)
    {
        var deadline = DateTime.UtcNow.AddSeconds(seconds);
        while (true)
        {
            var found = observations.FirstOrDefault(match);
            if (found is not null)
            {
                return found;
            }
            var remaining = deadline - DateTime.UtcNow;
            if (remaining <= TimeSpan.Zero)
            {
                throw new TimeoutException($"Timed out waiting for {description}. Observed: {string.Join(" | ", observations.Select(item => $"{item.Kind}@{item.Source}:{Shorten(item.Text)}"))}");
            }
            await arrived.WaitAsync(remaining, TestContext.Current.CancellationToken);
        }
    }

    public void Record(Observation observation)
    {
        observations.Enqueue(observation);
        arrived.Release();
    }

    public async ValueTask DisposeAsync()
    {
        await OnThread(() =>
        {
            foreach (var (window, controller, _) in tabs)
            {
                controller.Close();
                window.Close();
            }
            tabs.Clear();
            return Task.CompletedTask;
        });
        // The browser process exits once its last webview closes and it has released the user-data folder, so a restart
        // reads the profile from disk instead of joining the old process.
        try
        {
            await browserExited.Task.WaitAsync(TimeSpan.FromSeconds(20));
        }
        catch (TimeoutException)
        {
            TestContext.Current.TestOutputHelper?.WriteLine($"The browser process {BrowserProcessId} did not exit within 20 seconds.");
        }
        dispatcher.InvokeShutdown();
        for (var attempt = 1; attempt <= 20 && !options.KeepUserDataFolder; attempt++)
        {
            try
            {
                Directory.Delete(UserDataFolder, recursive: true);
                break;
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                if (attempt == 20)
                {
                    TestContext.Current.TestOutputHelper?.WriteLine($"The user-data folder {UserDataFolder} was left behind: {error.Message}");
                }
                await Task.Delay(250);
            }
        }
        arrived.Dispose();
    }

    private CoreWebView2Environment Environment => environment ?? throw new InvalidOperationException("The rig has no environment.");

    private CoreWebView2 Core(int tab) => tab < tabs.Count ? tabs[tab].Core : throw new InvalidOperationException($"The rig has no webview {tab}.");

    private async Task CreateAsync()
    {
        // The registration exists only if passed to the constructor; the property is null otherwise.
        var environmentOptions = new CoreWebView2EnvironmentOptions(options.AdditionalBrowserArguments,
            customSchemeRegistrations: [new CoreWebView2CustomSchemeRegistration(Scheme) { TreatAsSecure = true, HasAuthorityComponent = true }]);
        // Bounded, so that a machine that cannot host WebView2 fails the test instead of hanging the run.
        environment = await CoreWebView2Environment.CreateAsync(browserExecutableFolder: null, UserDataFolder, environmentOptions).WaitAsync(TimeSpan.FromSeconds(60));
        environment.BrowserProcessExited += (_, _) => browserExited.TrySetResult();
        var core = await AddWebViewAsync();
        BrowserProcessId = core.BrowserProcessId;
        Directory.CreateDirectory(DownloadFolder);
        core.Profile.DefaultDownloadFolderPath = DownloadFolder;
    }

    private async Task<CoreWebView2> AddWebViewAsync()
    {
        var window = new Window
        {
            Width = 640, Height = 480, Left = -20000, Top = -20000,
            ShowActivated = false, ShowInTaskbar = false, WindowStyle = WindowStyle.None,
        };
        window.Show();
        var controller = await Environment.CreateCoreWebView2ControllerAsync(new WindowInteropHelper(window).Handle).WaitAsync(TimeSpan.FromSeconds(60));
        controller.Bounds = new System.Drawing.Rectangle(0, 0, 640, 480);
        var core = controller.CoreWebView2;
        tabs.Add((window, controller, core));
        Configure(core);
        return core;
    }

    private void Configure(CoreWebView2 core)
    {
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.AreHostObjectsAllowed = false;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.AreDefaultScriptDialogsEnabled = false;
        core.Settings.IsWebMessageEnabled = options.WebMessages;
        core.AddWebResourceRequestedFilter($"{Scheme}://*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += (_, e) =>
        {
            if (e.Request.Uri.StartsWith(Scheme + "://", StringComparison.Ordinal))
            {
                e.Response = Serve(e.Request.Uri);
            }
            else
            {
                OnRequest?.Invoke(e, Environment);
            }
        };
        core.WebMessageReceived += (_, e) =>
        {
            string? text;
            bool isString;
            try
            {
                text = e.TryGetWebMessageAsString();
                isString = true;
            }
            catch (ArgumentException)
            {
                text = e.WebMessageAsJson;
                isString = false;
            }
            Record(new Observation("message", e.Source, text, isString));
        };
        core.FrameCreated += (_, e) => Record(new Observation("frame-created", core.Source, e.Frame.Name, false));
        core.NewWindowRequested += (_, e) =>
        {
            Record(new Observation("new-window", core.Source, e.Uri, false));
            if (!options.AdoptPopups)
            {
                e.Handled = true; // Handled without a NewWindow: window.open returns null and nothing opens.
                return;
            }
            _ = AdoptAsync(e, e.GetDeferral());
        };
        core.WindowCloseRequested += (_, _) =>
        {
            Record(new Observation("window-close", core.Source, null, false));
            var index = tabs.FindIndex(item => ReferenceEquals(item.Core, core));
            if (index >= 0)
            {
                tabs[index].Controller.Close();
                tabs[index].Window.Close();
                tabs.RemoveAt(index);
            }
        };
        core.NavigationStarting += (_, e) =>
        {
            var foreign = !e.Uri.StartsWith(AppOrigin + "/", StringComparison.Ordinal);
            Record(new Observation(foreign && options.CancelForeignNavigation ? "navigation-cancelled" : "navigation", core.Source, e.Uri, false));
            if (foreign && options.CancelForeignNavigation)
            {
                e.Cancel = true;
            }
            if (e.IsRedirected)
            {
                Record(new Observation("redirect", core.Source, e.Uri, false));
            }
            OnNavigation?.Invoke(e);
        };
        core.NavigationCompleted += (_, e) => Record(new Observation("navigated", core.Source, $"{e.IsSuccess} {e.WebErrorStatus} {e.HttpStatusCode}", false));
        core.DownloadStarting += (_, e) =>
        {
            Record(new Observation("download", core.Source, e.DownloadOperation.Uri, false));
            if (OnDownload is { } decide)
            {
                decide(e);
            }
            else
            {
                e.Cancel = true;
            }
        };
        core.ServerCertificateErrorDetected += (_, e) =>
        {
            Record(new Observation("certificate-error", core.Source, $"{e.ErrorStatus} {e.RequestUri}", false));
            e.Action = CoreWebView2ServerCertificateErrorAction.Cancel;
        };
        core.BasicAuthenticationRequested += (_, e) =>
        {
            Record(new Observation("basic-authentication", core.Source, $"{e.Uri} {e.Challenge}", false));
            e.Cancel = true;
        };
        core.PermissionRequested += (_, e) =>
        {
            Record(new Observation("permission", core.Source, $"{e.PermissionKind} {e.Uri}", false));
            e.State = CoreWebView2PermissionState.Deny;
        };
        core.LaunchingExternalUriScheme += (_, e) =>
        {
            Record(new Observation("external-scheme", core.Source, e.Uri, false));
            e.Cancel = true;
        };
    }

    /// <summary>Adopt a popup as a new webview of the same environment; WebView2 then navigates it with its opener.</summary>
    private async Task AdoptAsync(CoreWebView2NewWindowRequestedEventArgs e, CoreWebView2Deferral deferral)
    {
        try
        {
            e.NewWindow = await AddWebViewAsync();
        }
        catch (Exception error) when (error is TimeoutException or InvalidOperationException or System.Runtime.InteropServices.COMException)
        {
            Record(new Observation("adopt-failed", e.Uri, error.Message, false));
        }
        finally
        {
            e.Handled = true;
            deferral.Complete();
        }
    }

    private CoreWebView2WebResourceResponse Serve(string uri)
    {
        var key = uri.Split('?', '#')[0];
        if (!pages.TryGetValue(key, out var page))
        {
            Record(new Observation("not-found", key, null, false));
            return Environment.CreateWebResourceResponse(null, 404, "Not Found", "Content-Type: text/plain");
        }
        var headers = new StringBuilder($"Content-Type: {page.ContentType}\r\nX-Content-Type-Options: nosniff");
        if (page.ContentSecurityPolicy is not null)
        {
            headers.Append("\r\nContent-Security-Policy: ").Append(page.ContentSecurityPolicy);
        }
        return Environment.CreateWebResourceResponse(new MemoryStream(Encoding.UTF8.GetBytes(page.Body)), 200, "OK", headers.ToString());
    }

    private Task OnThread(Func<Task> action) => dispatcher.InvokeAsync(action).Task.Unwrap();

    private Task<T> OnThread<T>(Func<Task<T>> action) => dispatcher.InvokeAsync(action).Task.Unwrap();

    private static string Shorten(string? text) => text is null ? "" : text.Length > 60 ? text[..60] + "…" : text;
}

/// <summary>
/// A prototype of the plan's BridgeGate, steps 1, 2 and 6 (section 4): a string message, at most 1 MiB of UTF-8, from
/// exactly the app URI, that parses as one strict JSON object (spike S8b's reader rules).
/// </summary>
internal static class GatePrototype
{
    public const int MaxBytes = 1024 * 1024;

    public static bool Accepts(Observation message)
    {
        if (!message.IsString || message.Text is null || !string.Equals(message.Source, Rig.AppUri, StringComparison.Ordinal))
        {
            return false;
        }
        if (Encoding.UTF8.GetByteCount(message.Text) > MaxBytes)
        {
            return false;
        }
        try
        {
            using var document = JsonDocument.Parse(message.Text, new JsonDocumentOptions { MaxDepth = 32, AllowDuplicateProperties = false });
            return document.RootElement.ValueKind == JsonValueKind.Object;
        }
        catch (JsonException)
        {
            return false;
        }
    }
}
