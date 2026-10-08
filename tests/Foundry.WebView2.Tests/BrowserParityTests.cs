using System.IO;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Xunit;

namespace Foundry.WebView2.Tests;

/// <summary>
/// Spike S5: what the two <c>browser.spec</c> scenarios and <c>browser-manager.ts</c> rely on, reproduced on WebView2
/// against real loopback origins. The webviews run as the plan's tabs do: web messages off, the named profile, and an
/// environment without shared workers.
/// </summary>
public sealed class BrowserParityTests
{
    private static readonly RigOptions Tab = new(AdditionalBrowserArguments: "--disable-blink-features=SharedWorker", WebMessages: false, ProfileName: "workspace-browser-v1");

    private const string TemporaryDownload = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp$";

    [Fact]
    public async Task StorageSurvivesARestartOnTheSameUserDataFolder()
    {
        await using var server = new WebServer(BrowserSite.Route);
        var folder = Directory.CreateTempSubdirectory("foundry-webview2-").FullName;
        try
        {
            uint firstProcess;
            await using (var first = await Rig.StartAsync(Pages.All(), Tab with { UserDataFolder = folder, KeepUserDataFolder = true }))
            {
                await first.NavigateAsync($"{server.Origin}/seed");
                var seeded = await first.EvaluateAsync($"{BrowserSite.StoredValues}.then(values => ({{ ...values, node: typeof require, bridge: typeof window.workspace }}))");
                AssertJson("""{"cookie":"fixture-login=remembered","stored":"persisted","indexed":"indexed-persisted","node":"undefined","bridge":"undefined"}""", seeded);
                firstProcess = first.BrowserProcessId;
            }

            await using var second = await Rig.StartAsync(Pages.All(), Tab with { UserDataFolder = folder });
            Assert.NotEqual(firstProcess, second.BrowserProcessId); // A new browser process read the profile from disk.
            await second.NavigateAsync($"{server.Origin}/read");
            AssertJson("""{"cookie":"fixture-login=remembered","stored":"persisted","indexed":"indexed-persisted"}""", await second.EvaluateAsync(BrowserSite.StoredValues));
        }
        finally
        {
            try
            {
                Directory.Delete(folder, recursive: true); // Normally gone already: the second rig deletes it.
            }
            catch (Exception error) when (error is DirectoryNotFoundException or IOException or UnauthorizedAccessException)
            {
            }
        }
    }

    [Fact]
    public async Task NothingATabOrItsFramesPostReachesTheHost()
    {
        await using var server = new WebServer(BrowserSite.Route);
        await using var rig = await Rig.StartAsync(Pages.All(), Tab);
        await rig.NavigateAsync($"{server.Origin}/read");
        // WebView2 defines chrome.webview in every page. With web messages off, nothing posted through it arrives.
        var posted = await rig.EvaluateAsync("""
            new Promise(resolve => {
              chrome.webview.postMessage('from-tab');
              chrome.webview.postMessageWithAdditionalObjects('from-tab-with-objects', []);
              const frame = document.createElement('iframe');
              frame.srcdoc = "<script>window.chrome?.webview?.postMessage('from-frame'); window.chrome?.webview?.postMessageWithAdditionalObjects('from-frame-with-objects', []); parent.framePosted = typeof window.chrome?.webview?.postMessage;</script>";
              frame.onload = () => resolve({ tab: typeof chrome.webview.postMessage, frame: window.framePosted ?? 'not run' });
              document.body.append(frame);
            })
            """);
        AssertJson("""{"tab":"function","frame":"function"}""", posted);
        await Task.Delay(1000, TestContext.Current.CancellationToken);
        Assert.Empty(rig.Messages);
    }

    [Fact]
    public async Task APopupIsAdoptedWithItsOpenerAndClosesItself()
    {
        await using var server = new WebServer(BrowserSite.Route);
        await using var rig = await Rig.StartAsync(Pages.All(), Tab with { AdoptPopups = true });
        await rig.NavigateAsync($"{server.Origin}/seed");
        await rig.EvaluateAsync("window.storageReady");

        await rig.EvaluateAsync("window.open('/popup'), true");
        await rig.WaitForAsync(item => item.Kind == "navigated" && item.Source == $"{server.Origin}/popup", "the adopted popup to load");
        Assert.Equal(2, await rig.TabCountAsync());
        var popup = await rig.EvaluateAsync("({ opener: window.opener?.location.href ?? null, cookie: document.cookie })", tab: 1);
        Assert.Equal($"{server.Origin}/seed", popup.GetProperty("opener").GetString()); // The login flow keeps its opener.
        Assert.Equal("fixture-login=remembered", popup.GetProperty("cookie").GetString());
        // The adopted webview is configured like any tab before the deferral completes.
        await rig.EvaluateAsync("chrome.webview.postMessage('from-popup'), true", tab: 1);
        await Task.Delay(500, TestContext.Current.CancellationToken);
        Assert.Empty(rig.Messages);

        await rig.EvaluateAsync("setTimeout(() => window.close(), 0), true", tab: 1);
        await rig.WaitForAsync(item => item.Kind == "window-close", "the popup's close request");
        Assert.Equal(1, await rig.TabCountAsync());
    }

    [Fact]
    public async Task ClearingOneOriginSparesTheOtherAndClearingTheProfileSparesNothing()
    {
        await using var server = new WebServer(BrowserSite.Route);
        await using var rig = await Rig.StartAsync(Pages.All(), Tab);
        const string seeded = """{"cookie":"fixture-login=remembered","stored":"persisted","indexed":"indexed-persisted"}""";
        const string empty = """{"cookie":"","stored":null,"indexed":null}""";
        foreach (var origin in new[] { server.Origin, server.OtherOrigin })
        {
            await rig.NavigateAsync($"{origin}/seed");
            AssertJson(seeded, await rig.EvaluateAsync(BrowserSite.StoredValues));
        }

        // The per-origin clear: away from the origin first, then the protocol call, which takes the origin's cookies too,
        // as the cookie manager confirms.
        await rig.NavigateAsync("about:blank");
        await rig.CdpAsync("Storage.clearDataForOrigin", new { origin = server.Origin, storageTypes = "all" });
        Assert.Equal(0, await rig.RunAsync(async core => (await core.CookieManager.GetCookiesAsync(server.Origin)).Count));
        Assert.Equal(1, await rig.RunAsync(async core => (await core.CookieManager.GetCookiesAsync(server.OtherOrigin)).Count));
        await rig.NavigateAsync($"{server.Origin}/read");
        AssertJson(empty, await rig.EvaluateAsync(BrowserSite.StoredValues));
        await rig.NavigateAsync($"{server.OtherOrigin}/read");
        AssertJson(seeded, await rig.EvaluateAsync(BrowserSite.StoredValues));

        await rig.NavigateAsync("about:blank");
        await rig.RunAsync(core => core.Profile.ClearBrowsingDataAsync());
        foreach (var origin in new[] { server.Origin, server.OtherOrigin })
        {
            await rig.NavigateAsync($"{origin}/read");
            AssertJson(empty, await rig.EvaluateAsync(BrowserSite.StoredValues));
        }
    }

    [Fact]
    public async Task AnIsolatedWorldReadsTheDomButNotThePageAndItsClicksRunPageHandlers()
    {
        await using var server = new WebServer(BrowserSite.Route);
        await using var rig = await Rig.StartAsync(Pages.All(), Tab);
        await rig.NavigateAsync($"{server.Origin}/read");
        var world = await IsolatedWorldAsync(rig, "Foundry Browser Host");

        AssertJson("""{"heading":"Browser fixture","page":"undefined"}""", await rig.EvaluateAsync("({ heading: document.querySelector('h1').textContent, page: typeof window.storageReady })", world));
        Assert.Equal("object", (await rig.EvaluateAsync("typeof window.storageReady")).GetString());

        var snapshot = await rig.EvaluateAsync(BrowserSite.SnapshotScript(), world); // Verbatim from browser-manager.ts.
        var text = snapshot.GetRawText();
        Assert.DoesNotContain("private-password-canary", text, StringComparison.Ordinal);
        Assert.DoesNotContain("hidden-canary", text, StringComparison.Ordinal);
        Assert.Contains("Browser fixture", snapshot.GetProperty("text").GetString(), StringComparison.Ordinal);
        var action = snapshot.GetProperty("nodes").EnumerateArray().Single(node => node.GetProperty("name").GetString() == "Browser demo action");
        Assert.Equal("undefined", (await rig.EvaluateAsync("typeof globalThis.__foundryBrowserTargets")).GetString()); // The page cannot see the host's targets.

        await rig.EvaluateAsync($"HTMLElement.prototype.click.call(globalThis.__foundryBrowserTargets[{int.Parse(action.GetProperty("id").GetString()!, System.Globalization.CultureInfo.InvariantCulture) - 1}])", world);
        Assert.Equal("Approved click ran", (await rig.EvaluateAsync("document.querySelector('#result').textContent")).GetString());
    }

    [Fact]
    public async Task TheFileChooserIsInterceptedAndTheSelectionIsVisibleToThePrecheck()
    {
        await using var server = new WebServer(BrowserSite.Route);
        await using var rig = await Rig.StartAsync(Pages.All(), Tab);
        await rig.NavigateAsync($"{server.Origin}/read");
        await rig.ListenAsync("Page.fileChooserOpened");
        await rig.CdpAsync("Page.enable", new { });
        // Interception first: a click with a user gesture would otherwise open the native dialog.
        await rig.CdpAsync("Page.setInterceptFileChooserDialog", new { enabled = true });
        await rig.CdpAsync("Runtime.evaluate", new { expression = "document.querySelector('input[type=file]').click()", userGesture = true });
        var opened = await rig.WaitForAsync(item => item.Kind == "cdp" && item.Source == "Page.fileChooserOpened", "the intercepted file chooser");
        using var chooser = JsonDocument.Parse(opened.Text!);
        Assert.Equal("selectSingle", chooser.RootElement.GetProperty("mode").GetString());

        // A manual selection, as Playwright's setFiles makes it, which the attach precheck must see from its own world.
        var file = Path.Combine(rig.UserDataFolder, "manual-upload.txt");
        await File.WriteAllTextAsync(file, "manual upload fixture", TestContext.Current.CancellationToken);
        await rig.CdpAsync("DOM.setFileInputFiles", new { files = new[] { file }, backendNodeId = chooser.RootElement.GetProperty("backendNodeId").GetInt32() });
        var check = await IsolatedWorldAsync(rig, "Foundry Browser File Check");
        Assert.True((await rig.EvaluateAsync("[...document.querySelectorAll('input[type=file]')].some(input => input.files?.length>0)", check)).GetBoolean());

        // Unattached, the manual upload goes through.
        await rig.EvaluateAsync("document.querySelector('form').requestSubmit()");
        await rig.WaitForAsync(item => item.Kind == "navigated" && item.Source == $"{server.Origin}/upload", "the upload's response page");
        Assert.Equal("Manual upload received", (await rig.EvaluateAsync("document.body.innerText")).GetString()?.Trim());
        Assert.Contains("manual upload fixture", Encoding.UTF8.GetString(Assert.Single(server.Requests, request => request.Path == "/upload").Body), StringComparison.Ordinal);
    }

    [Fact]
    public async Task WhileAttachedEveryBodyWithoutATextTypeIsBlockedFromTheDocumentAndItsWorkers()
    {
        await using var server = new WebServer(BrowserSite.Route);
        await using var rig = await Rig.StartAsync(Pages.All(), Tab);
        var attached = false;
        rig.OnRequest = (e, environment) =>
        {
            rig.Record(new Observation("request", e.RequestedSourceKind.ToString(), $"{e.Request.Method} {e.Request.Uri}", false));
            if (Volatile.Read(ref attached) && BlockedWhileAttached(e.Request))
            {
                e.Response = environment.CreateWebResourceResponse(null, 403, "Forbidden", "Content-Type: text/plain");
            }
        };
        // Registered for the tab's lifetime and every URL. The shared-worker kind is left out, and the environment runs
        // without shared workers: see TheSharedWorkerKindStallsSharedWorkersAfterAReload.
        await rig.RunAsync(core =>
        {
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.Document | CoreWebView2WebResourceRequestSourceKinds.ServiceWorker);
            return Task.CompletedTask;
        });

        await rig.NavigateAsync($"{server.Origin}/workers.html");
        AssertJson("""{"document":200,"dedicated":200,"shared":"unavailable","service":200,"file":200,"untyped":200,"blob":200,"json":200,"keepalive":200,"redirected":200,"urlencoded":200,"beacon":true}""", await rig.EvaluateAsync("runUploads()"));
        Assert.Equal(10, Uploads(server));
        Assert.Equal("Document", RaisedAs(rig, server, "document"));
        Assert.Equal("Document", RaisedAs(rig, server, "dedicated"));
        Assert.Equal("ServiceWorker", RaisedAs(rig, server, "service"));
        Assert.Equal("Document", RaisedAs(rig, server, "beacon"));
        Assert.Equal("Document", RaisedAs(rig, server, "keepalive"));
        // Both hops of a 307 that keeps its body are raised, so the rule applies to each.
        Assert.Contains(rig.Observations, item => item.Kind == "request" && item.Text == $"POST {server.Origin}/redirect307?to=%2Fupload%3Ffrom%3Dredirected");
        Assert.Equal("Document", RaisedAs(rig, server, "redirected"));

        // Attached on the loaded page, as attachment happens, and again after a reload.
        Volatile.Write(ref attached, true);
        foreach (var reload in new[] { false, true })
        {
            if (reload)
            {
                await rig.NavigateAsync($"{server.Origin}/workers.html");
            }
            var before = Uploads(server);
            AssertJson("""{"document":403,"dedicated":403,"shared":"unavailable","service":403,"file":403,"untyped":403,"blob":200,"json":200,"keepalive":200,"redirected":403,"urlencoded":200,"beacon":true}""", await rig.EvaluateAsync("runUploads()"));
            // Only the text-typed bodies left, among them a blob sent as text: the residual the plan records.
            Assert.Equal(before + 3, Uploads(server));
        }
    }

    [Fact]
    public async Task TheSharedWorkerKindStallsSharedWorkersAfterAReload()
    {
        // Pins the WebView2 behavior that rules out filtering shared workers, which is why the integrated browser runs
        // without them. If this fails, the runtime changed and S5's decision can be revisited.
        await using var server = new WebServer(BrowserSite.Route);
        await using var rig = await Rig.StartAsync(Pages.All(), Tab with { AdditionalBrowserArguments = null });
        await rig.RunAsync(core =>
        {
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.Document | CoreWebView2WebResourceRequestSourceKinds.SharedWorker);
            return Task.CompletedTask;
        });
        await rig.ListenAsync("Target.targetCreated");
        await rig.CdpAsync("Target.setDiscoverTargets", new { discover = true });
        await rig.NavigateAsync($"{server.Origin}/workers.html");
        Assert.Equal(200, (await rig.EvaluateAsync("runUploads()")).GetProperty("shared").GetInt32());
        // The page's own session reports shared workers: the backstop that ends an attachment if one ever appears.
        await rig.WaitForAsync(item => item.Kind == "cdp" && item.Source == "Target.targetCreated" && item.Text!.Contains("\"type\":\"shared_worker\"", StringComparison.Ordinal), "the shared worker's target");

        await rig.NavigateAsync($"{server.Origin}/workers.html");
        Assert.Equal("timeout", (await rig.EvaluateAsync("runUploads()")).GetProperty("shared").GetString());
        Assert.Equal(1, server.Requests.Count(request => request.Path == "/upload?from=shared")); // Nothing was blocked; the request never left.
    }

    [Fact]
    public async Task DownloadsGoOnlyWhereTheHostSaysOrNowhere()
    {
        await using var server = new WebServer(BrowserSite.Route);
        await using var rig = await Rig.StartAsync(Pages.All(), Tab);
        await rig.NavigateAsync($"{server.Origin}/read");
        const string click = "(() => { const link = document.createElement('a'); link.href = '/download'; document.body.append(link); link.click(); })()";

        // Attached: cancelled outright, leaving nothing behind.
        rig.OnDownload = e => e.Cancel = true;
        await rig.EvaluateAsync(click);
        await rig.WaitForAsync(item => item.Kind == "download", "the attached tab's download");
        await Task.Delay(1000, TestContext.Current.CancellationToken);
        Assert.Empty(Directory.EnumerateFileSystemEntries(rig.DownloadFolder));

        // Manual control, after a fresh navigation: the host holds the download until its save dialog answers.
        await rig.NavigateAsync($"{server.Origin}/read");
        var chosen = Path.Combine(rig.UserDataFolder, "chosen", "selected-download.txt");
        Directory.CreateDirectory(Path.GetDirectoryName(chosen)!);
        var finished = new TaskCompletionSource<CoreWebView2DownloadState>(TaskCreationOptions.RunContinuationsAsynchronously);
        rig.OnDownload = e => _ = SaveAsync(e);
        async Task SaveAsync(CoreWebView2DownloadStartingEventArgs e)
        {
            var deferral = e.GetDeferral();
            var proposed = e.ResultFilePath;
            try
            {
                await Task.Delay(500); // The save dialog.
                rig.Record(new Observation("held", proposed, Entries(rig.DownloadFolder), false));
                e.ResultFilePath = chosen;
                e.Handled = true;
                var operation = e.DownloadOperation;
                operation.StateChanged += (_, _) =>
                {
                    if (operation.State != CoreWebView2DownloadState.InProgress)
                    {
                        finished.TrySetResult(operation.State);
                    }
                };
            }
            finally
            {
                deferral.Complete();
            }
        }
        await rig.EvaluateAsync(click);
        Assert.Equal(CoreWebView2DownloadState.Completed, await finished.Task.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken));
        Assert.Equal("browser download fixture", await File.ReadAllTextAsync(chosen, TestContext.Current.CancellationToken));
        var held = Assert.Single(rig.Observations, item => item.Kind == "held");
        Assert.Equal(rig.DownloadFolder, Path.GetDirectoryName(held.Source), ignoreCase: true); // The profile's default folder.
        // While held, the download is already being written there as a temporary file, which then moves to the chosen path.
        Assert.Matches(TemporaryDownload, held.Text);
        Assert.Empty(Directory.EnumerateFileSystemEntries(rig.DownloadFolder));

        // Manual control again: the user cancels the save dialog while the download is held, and the temporary file goes too.
        await rig.NavigateAsync($"{server.Origin}/read");
        var declined = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        rig.OnDownload = e => _ = DeclineAsync(e);
        async Task DeclineAsync(CoreWebView2DownloadStartingEventArgs e)
        {
            var deferral = e.GetDeferral();
            try
            {
                await Task.Delay(500); // The save dialog, cancelled.
                rig.Record(new Observation("held-then-declined", e.ResultFilePath, Entries(rig.DownloadFolder), false));
                e.Cancel = true;
            }
            finally
            {
                deferral.Complete();
                declined.TrySetResult();
            }
        }
        await rig.EvaluateAsync(click);
        await declined.Task.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);
        await Task.Delay(1000, TestContext.Current.CancellationToken);
        Assert.Matches(TemporaryDownload, Assert.Single(rig.Observations, item => item.Kind == "held-then-declined").Text);
        Assert.Empty(Directory.EnumerateFileSystemEntries(rig.DownloadFolder));

        // Without a fresh navigation, another download needs the multiple-downloads permission, which the rig denies.
        await rig.EvaluateAsync(click);
        await rig.WaitForAsync(item => item.Kind == "permission" && item.Text!.StartsWith("MultipleAutomaticDownloads", StringComparison.Ordinal), "the multiple-downloads permission request");
        await Task.Delay(1000, TestContext.Current.CancellationToken);
        Assert.Equal(3, rig.Observations.Count(item => item.Kind == "download"));
        Assert.Equal(["selected-download.txt"], Directory.EnumerateFiles(Path.GetDirectoryName(chosen)!).Select(Path.GetFileName));
        Assert.Empty(Directory.EnumerateFileSystemEntries(rig.DownloadFolder));
    }

    [Fact]
    public async Task RedirectsReachTheHostButOnlyARequestFilterStopsOneBeforeItIsSent()
    {
        await using var server = new WebServer(BrowserSite.Route);
        await using var rig = await Rig.StartAsync(Pages.All(), Tab);
        // browser-manager.ts's safeUrl on the URL as the browser canonicalized it: HTTP or HTTPS, without user
        // information. A URL that does not parse counts as unsafe.
        static bool Unsafe(string uri) =>
            !Uri.TryCreate(uri, UriKind.Absolute, out var parsed) || parsed.Scheme is not ("http" or "https") || parsed.UserInfo.Length > 0;
        rig.OnNavigation = e =>
        {
            if (Unsafe(e.Uri))
            {
                e.Cancel = true;
            }
        };

        // A cross-origin redirect is raised with its destination, which the pendingOrigin logic needs.
        Assert.True((await rig.NavigateAsync(Redirect(server, $"{server.OtherOrigin}/read"))).IsSuccess);
        Assert.Equal($"{server.OtherOrigin}/read", (await rig.WaitForAsync(item => item.Kind == "redirect", "the cross-origin redirect")).Text);
        Assert.Equal($"{server.OtherOrigin}/read", await rig.SourceAsync());

        // Cancelling the redirect's NavigationStarting stops the document, but the redirected request has already gone out.
        var first = $"http://user:secret@127.0.0.1:{server.Port}/unsafe-one";
        Assert.Equal(CoreWebView2WebErrorStatus.OperationCanceled, (await rig.NavigateAsync(Redirect(server, first))).Status);
        Assert.Contains(rig.Observations, item => item.Kind == "redirect" && item.Text == first);
        Assert.False(Assert.Single(server.Requests, request => request.Path == "/unsafe-one").Headers.ContainsKey("Authorization")); // Sent without the credentials.

        // A document request filter sees each redirect hop before it is sent, so the guard can run there as well.
        rig.OnRequest = (e, environment) =>
        {
            if (e.ResourceContext == CoreWebView2WebResourceContext.Document && Unsafe(e.Request.Uri))
            {
                e.Response = environment.CreateWebResourceResponse(null, 403, "Forbidden", "Content-Type: text/plain");
            }
        };
        await rig.RunAsync(core =>
        {
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.Document);
            return Task.CompletedTask;
        });
        var second = $"http://user:secret@127.0.0.1:{server.Port}/unsafe-two";
        Assert.False((await rig.NavigateAsync(Redirect(server, second))).IsSuccess);
        Assert.DoesNotContain(server.Requests, request => request.Path == "/unsafe-two");

        // Redirects to a local file or a data URL never load.
        foreach (var target in new[] { "file:///C:/Windows/win.ini", "data:text/html,redirected" })
        {
            Assert.False((await rig.NavigateAsync(Redirect(server, target))).IsSuccess);
        }
    }

    [Fact]
    public async Task CertificateErrorsAreRefusedBeforeAnyRequest()
    {
        await using var secure = new WebServer(BrowserSite.Route, tls: true);
        await using var rig = await Rig.StartAsync(Pages.All(), Tab);
        var navigation = await rig.NavigateAsync($"{secure.Origin}/read");
        var error = await rig.WaitForAsync(item => item.Kind == "certificate-error", "the certificate error");
        TestContext.Current.TestOutputHelper?.WriteLine($"{error.Text}; navigation {navigation}");
        Assert.False(navigation.IsSuccess);
        Assert.Empty(secure.Requests); // Nothing crossed the refused connection.
    }

    [Fact]
    public async Task BasicAuthenticationIsCancelledWithoutAPrompt()
    {
        await using var server = new WebServer(BrowserSite.Route);
        await using var rig = await Rig.StartAsync(Pages.All(), Tab);
        var navigation = await rig.NavigateAsync($"{server.Origin}/auth");
        await rig.WaitForAsync(item => item.Kind == "basic-authentication", "the authentication request");
        Assert.Equal(new Navigation(false, CoreWebView2WebErrorStatus.ValidAuthenticationCredentialsRequired, 401), navigation);
        Assert.False(Assert.Single(server.Requests).Headers.ContainsKey("Authorization"));
    }

    /// <summary>
    /// The attached-tab body rule. Electron blocked bodies with file or blob parts, and multipart or octet-stream bodies.
    /// WebView2 does not say where a body came from, so every body without a text-like type is blocked instead.
    /// </summary>
    private static bool BlockedWhileAttached(CoreWebView2WebResourceRequest request)
    {
        if (request.Content is null)
        {
            return false;
        }
        var type = request.Headers.Contains("Content-Type") ? request.Headers.GetHeader("Content-Type").Split(';')[0].Trim() : "";
        return !(type.StartsWith("text/", StringComparison.OrdinalIgnoreCase)
            || type.Equals("application/json", StringComparison.OrdinalIgnoreCase)
            || type.EndsWith("+json", StringComparison.OrdinalIgnoreCase)
            || type.Equals("application/x-www-form-urlencoded", StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>The protocol returns properties in its own order, so values compare by name.</summary>
    private static void AssertJson(string expected, JsonElement actual)
    {
        using var document = JsonDocument.Parse(expected);
        Assert.Equal(Canonical(document.RootElement), Canonical(actual));
    }

    private static string Canonical(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.Object => "{" + string.Join(",", element.EnumerateObject().OrderBy(property => property.Name, StringComparer.Ordinal).Select(property => $"{JsonSerializer.Serialize(property.Name)}:{Canonical(property.Value)}")) + "}",
        JsonValueKind.Array => "[" + string.Join(",", element.EnumerateArray().Select(Canonical)) + "]",
        _ => element.GetRawText(),
    };

    private static string Entries(string folder) => string.Join(",", Directory.EnumerateFileSystemEntries(folder).Select(Path.GetFileName));

    private static string Redirect(WebServer server, string target) => $"{server.Origin}/redirect?to={Uri.EscapeDataString(target)}";

    private static int Uploads(WebServer server) => server.Requests.Count(request => request.Path.StartsWith("/upload", StringComparison.Ordinal));

    /// <summary>The source kind the host saw a page's first upload raised as, or null if the host never saw it.</summary>
    private static string? RaisedAs(Rig rig, WebServer server, string from) =>
        rig.Observations.FirstOrDefault(item => item.Kind == "request" && item.Text == $"POST {server.Origin}/upload?from={from}")?.Source;

    /// <summary>An isolated world in the main frame, created as <c>browser-manager.ts</c> does, with the protocol's spelling.</summary>
    private static async Task<int> IsolatedWorldAsync(Rig rig, string name)
    {
        var tree = await rig.CdpAsync("Page.getFrameTree", new { });
        var frame = tree.GetProperty("frameTree").GetProperty("frame").GetProperty("id").GetString();
        var world = await rig.CdpAsync("Page.createIsolatedWorld", new { frameId = frame, worldName = name, grantUniveralAccess = false });
        return world.GetProperty("executionContextId").GetInt32();
    }
}
