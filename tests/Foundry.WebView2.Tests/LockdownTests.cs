using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Foundry.Platform;
using Microsoft.Win32;
using Xunit;

namespace Foundry.WebView2.Tests;

/// <summary>
/// Spike S2: the plan's lock-down (section 5). Environment variables and policies override the API's arguments, so the
/// host clears the variables before the first WebView2 call and refuses to start under a policy.
/// </summary>
public sealed class LockdownTests
{
    private const string Benign = "--disable-background-networking";

    [Fact]
    public async Task AnEnvironmentVariableOpensADebugPortUnlessTheHostClearsIt()
    {
        var port = FreePort();
        Environment.SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", $"--remote-debugging-port={port}");
        try
        {
            await using (var exposed = await Rig.StartAsync(Pages.All(), new RigOptions(Benign)))
            {
                await exposed.NavigateAsync(Rig.AppUri);
                Assert.True(await Listening(port), "With nothing cleared, the variable overrides the API arguments and opens a debug port.");
                var lines = await CommandLines(exposed.BrowserProcessId);
                Assert.Contains(lines, line => line.Contains($"--remote-debugging-port={port}", StringComparison.Ordinal));
                TestContext.Current.TestOutputHelper?.WriteLine($"API switch kept under the variable: {lines.Any(line => line.Contains(Benign, StringComparison.Ordinal))}");
            }

            Assert.Equal(["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"], Lockdown.ClearEnvironment());
            await using var locked = await Rig.StartAsync(Pages.All(), new RigOptions(Benign));
            await locked.NavigateAsync(Rig.AppUri);
            Assert.False(await Listening(port, attempts: 2), "After the host clears the variable, no debug port may listen.");
            var cleared = await CommandLines(locked.BrowserProcessId);
            Assert.NotEmpty(cleared);
            Assert.Contains(cleared, line => line.Contains(Benign, StringComparison.Ordinal));
            var forbidden = cleared.SelectMany(line => Lockdown.ForbiddenSwitches.Where(item => line.Contains(item, StringComparison.OrdinalIgnoreCase))).ToList();
            Assert.True(forbidden.Count == 0, $"Forbidden switches in the browser processes: {string.Join(", ", forbidden)}");
        }
        finally
        {
            Environment.SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", null);
        }
    }

    [Fact]
    public async Task APolicyOverridesTheApiArgumentsSoTheHostMustRefuseIt()
    {
        // Writing a WebView2 policy changes the machine's configuration, so this runs only on an ephemeral CI runner.
        Assert.SkipUnless(string.Equals(Environment.GetEnvironmentVariable("GITHUB_ACTIONS"), "true", StringComparison.Ordinal), "Writes a WebView2 policy key; runs only on an ephemeral CI runner.");
        var port = FreePort();
        const string policyRoot = @"Software\Policies\Microsoft\Edge\WebView2";
        Assert.Empty(Lockdown.PolicyValues());
        using (var key = Registry.CurrentUser.CreateSubKey($@"{policyRoot}\AdditionalBrowserArguments"))
        {
            key.SetValue(Path.GetFileName(Environment.ProcessPath!), $"--remote-debugging-port={port}");
        }
        try
        {
            Assert.NotEmpty(Lockdown.PolicyValues()); // What the release host checks before starting.
            Lockdown.ClearEnvironment();
            await using var rig = await Rig.StartAsync(Pages.All(), new RigOptions(Benign));
            await rig.NavigateAsync(Rig.AppUri);
            Assert.True(await Listening(port), "A policy overrides the API arguments even with the variables cleared.");
        }
        finally
        {
            Registry.CurrentUser.DeleteSubKeyTree(policyRoot, throwOnMissingSubKey: false);
        }
    }

    internal static int FreePort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    /// <summary>Whether something accepts connections on the loopback port. A refused connect on Windows takes about two
    /// seconds of retries, so a negative check uses few attempts.</summary>
    private static async Task<bool> Listening(int port, int attempts = 10)
    {
        for (var attempt = 0; attempt < attempts; attempt++)
        {
            using var client = new TcpClient();
            try
            {
                await client.ConnectAsync(IPAddress.Loopback, port, TestContext.Current.CancellationToken).AsTask().WaitAsync(TimeSpan.FromSeconds(2), TestContext.Current.CancellationToken);
                return true;
            }
            catch (Exception error) when (error is SocketException or TimeoutException)
            {
                await Task.Delay(300, TestContext.Current.CancellationToken);
            }
        }
        return false;
    }

    /// <summary>The browser process's command line and its children's, through WMI in Windows PowerShell.</summary>
    private static async Task<List<string>> CommandLines(uint browserProcessId)
    {
        var powerShell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
        var script = $"Get-CimInstance Win32_Process -Filter 'ProcessId={browserProcessId} OR ParentProcessId={browserProcessId}' | ForEach-Object {{ $_.CommandLine }} | ConvertTo-Json -Compress";
        var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var name in new[] { "SystemRoot", "WINDIR", "PATH", "TEMP", "TMP", "USERPROFILE" })
        {
            if (Environment.GetEnvironmentVariable(name) is { } value)
            {
                environment[name] = value;
            }
        }
        using var job = JobProcess.Start(new ProcessSpec(powerShell, $"\"{powerShell}\" -NoLogo -NoProfile -NonInteractive -EncodedCommand {Convert.ToBase64String(Encoding.Unicode.GetBytes(script))}", Path.GetTempPath(), environment));
        await job.StandardInput.DisposeAsync();
        var output = await new StreamReader(job.StandardOutput).ReadToEndAsync(TestContext.Current.CancellationToken);
        await job.WaitForExitAsync(TestContext.Current.CancellationToken);
        using var document = JsonDocument.Parse(output);
        return document.RootElement.ValueKind == JsonValueKind.Array
            ? document.RootElement.EnumerateArray().Select(item => item.GetString() ?? string.Empty).ToList()
            : [document.RootElement.GetString() ?? string.Empty];
    }
}

/// <summary>A prototype of the plan's lock-down steps (section 5).</summary>
internal static class Lockdown
{
    public static readonly string[] Variables =
    [
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "WEBVIEW2_USER_DATA_FOLDER", "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER",
        "WEBVIEW2_RELEASE_CHANNEL_PREFERENCE", "WEBVIEW2_CHANNEL_SEARCH_KIND",
    ];

    public static readonly string[] ForbiddenSwitches =
    [
        "remote-debugging", "remote-allow-origins", "auto-open-devtools-for-tabs", "disable-web-security", "no-sandbox",
        "disable-site-isolation-trials", "ignore-certificate-errors", "allow-running-insecure-content", "allow-insecure-localhost",
        "allow-file-access-from-files", "unsafely-treat-insecure-origin-as-secure", "log-net-log", "net-log-capture-mode",
        "enable-logging", "proxy-server",
    ];

    /// <summary>Read and clear every WebView2 override variable before the first WebView2 call; return the names that were set.</summary>
    public static List<string> ClearEnvironment()
    {
        var set = Variables.Where(name => Environment.GetEnvironmentVariable(name) is not null).ToList();
        foreach (var name in set)
        {
            Environment.SetEnvironmentVariable(name, null);
        }
        return set;
    }

    /// <summary>Every value under the WebView2 policy keys in either hive; a release host refuses to start if any exist.</summary>
    public static List<string> PolicyValues()
    {
        var found = new List<string>();
        foreach (var hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
        {
            using var root = hive.OpenSubKey(@"Software\Policies\Microsoft\Edge\WebView2");
            if (root is not null)
            {
                Collect(root, found);
            }
        }
        return found;
    }

    private static void Collect(RegistryKey key, List<string> found)
    {
        found.AddRange(key.GetValueNames().Select(name => $@"{key.Name}\{name}"));
        foreach (var child in key.GetSubKeyNames())
        {
            using var subKey = key.OpenSubKey(child);
            if (subKey is not null)
            {
                Collect(subKey, found);
            }
        }
    }
}
