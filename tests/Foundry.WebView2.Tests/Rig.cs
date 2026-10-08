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

internal sealed record RigOptions(string? AdditionalBrowserArguments = null, bool CancelForeignNavigation = false);

/// <summary>
/// A real WebView2 on its own STA thread, behind a hidden, non-activating window parked off screen, serving pages for
/// the foundry-app scheme from memory with real response headers. Every WebView2 call runs on that thread.
/// </summary>
internal sealed class Rig : IAsyncDisposable
{
    public const string Scheme = "foundry-app";
    public const string AppOrigin = "foundry-app://ui";
    public const string AppUri = "foundry-app://ui/index.html";

    private readonly Dispatcher dispatcher;
    private readonly IReadOnlyDictionary<string, Page> pages;
    private readonly ConcurrentQueue<Observation> observations = new();
    private readonly SemaphoreSlim arrived = new(0);
    private Window? window;
    private CoreWebView2Controller? controller;

    private Rig(Dispatcher dispatcher, IReadOnlyDictionary<string, Page> pages, string userDataFolder)
    {
        this.dispatcher = dispatcher;
        this.pages = pages;
        UserDataFolder = userDataFolder;
    }

    public string UserDataFolder { get; }

    public uint BrowserProcessId { get; private set; }

    public IReadOnlyList<Observation> Observations => observations.ToArray();

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
        var userDataFolder = Directory.CreateTempSubdirectory("foundry-webview2-").FullName;
        var rig = new Rig(dispatcher, pages, userDataFolder);
        await rig.OnThread(() => rig.CreateAsync(options));
        return rig;
    }

    /// <summary>Navigate and wait for the navigation to complete.</summary>
    public Task NavigateAsync(string uri) => OnThread(async () =>
    {
        var completed = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        void OnCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e) => completed.TrySetResult(e.IsSuccess);
        Core.NavigationCompleted += OnCompleted;
        try
        {
            Core.Navigate(uri);
            await completed.Task.WaitAsync(TimeSpan.FromSeconds(30));
        }
        finally
        {
            Core.NavigationCompleted -= OnCompleted;
        }
    });

    public Task<string> SourceAsync() => OnThread(() => Task.FromResult(Core.Source));

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

    /// <summary>Messages from pages, as the plan's gate would read them.</summary>
    public IEnumerable<Observation> Messages => observations.Where(item => item.Kind == "message");

    public async ValueTask DisposeAsync()
    {
        await OnThread(() =>
        {
            controller?.Close();
            window?.Close();
            return Task.CompletedTask;
        });
        dispatcher.InvokeShutdown();
        for (var attempt = 0; attempt < 20; attempt++)
        {
            try
            {
                Directory.Delete(UserDataFolder, recursive: true);
                break;
            }
            catch (IOException)
            {
                await Task.Delay(250);
            }
            catch (UnauthorizedAccessException)
            {
                await Task.Delay(250);
            }
        }
        arrived.Dispose();
    }

    private CoreWebView2 Core => controller?.CoreWebView2 ?? throw new InvalidOperationException("The rig has no WebView2.");

    private async Task CreateAsync(RigOptions options)
    {
        window = new Window
        {
            Width = 640, Height = 480, Left = -20000, Top = -20000,
            ShowActivated = false, ShowInTaskbar = false, WindowStyle = WindowStyle.None,
        };
        window.Show();
        var handle = new WindowInteropHelper(window).Handle;

        // The registration exists only if passed to the constructor; the property is null otherwise.
        var environmentOptions = new CoreWebView2EnvironmentOptions(options.AdditionalBrowserArguments,
            customSchemeRegistrations: [new CoreWebView2CustomSchemeRegistration(Scheme) { TreatAsSecure = true, HasAuthorityComponent = true }]);
        // Bounded, so that a machine that cannot host WebView2 fails the test instead of hanging the run.
        var environment = await CoreWebView2Environment.CreateAsync(browserExecutableFolder: null, UserDataFolder, environmentOptions).WaitAsync(TimeSpan.FromSeconds(60));
        controller = await environment.CreateCoreWebView2ControllerAsync(handle).WaitAsync(TimeSpan.FromSeconds(60));
        controller.Bounds = new System.Drawing.Rectangle(0, 0, 640, 480);
        BrowserProcessId = Core.BrowserProcessId;

        Core.Settings.AreDevToolsEnabled = false;
        Core.Settings.AreHostObjectsAllowed = false;
        Core.Settings.AreDefaultContextMenusEnabled = false;
        Core.Settings.AreDefaultScriptDialogsEnabled = false;
        Core.AddWebResourceRequestedFilter($"{Scheme}://*", CoreWebView2WebResourceContext.All);
        Core.WebResourceRequested += (_, e) => e.Response = Serve(environment, e.Request.Uri);
        Core.WebMessageReceived += (_, e) =>
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
        Core.FrameCreated += (_, e) => Record(new Observation("frame-created", Core.Source, e.Frame.Name, false));
        Core.NewWindowRequested += (_, e) =>
        {
            Record(new Observation("new-window", Core.Source, e.Uri, false));
            e.Handled = true; // Handled without a NewWindow: window.open returns null and nothing opens.
        };
        Core.NavigationStarting += (_, e) =>
        {
            var foreign = !e.Uri.StartsWith(AppOrigin + "/", StringComparison.Ordinal);
            Record(new Observation(foreign && options.CancelForeignNavigation ? "navigation-cancelled" : "navigation", Core.Source, e.Uri, false));
            if (foreign && options.CancelForeignNavigation)
            {
                e.Cancel = true;
            }
        };
    }

    private CoreWebView2WebResourceResponse Serve(CoreWebView2Environment environment, string uri)
    {
        var key = uri.Split('?', '#')[0];
        if (!pages.TryGetValue(key, out var page))
        {
            Record(new Observation("not-found", key, null, false));
            return environment.CreateWebResourceResponse(null, 404, "Not Found", "Content-Type: text/plain");
        }
        var headers = new StringBuilder($"Content-Type: {page.ContentType}\r\nX-Content-Type-Options: nosniff");
        if (page.ContentSecurityPolicy is not null)
        {
            headers.Append("\r\nContent-Security-Policy: ").Append(page.ContentSecurityPolicy);
        }
        return environment.CreateWebResourceResponse(new MemoryStream(Encoding.UTF8.GetBytes(page.Body)), 200, "OK", headers.ToString());
    }

    private void Record(Observation observation)
    {
        observations.Enqueue(observation);
        arrived.Release();
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
