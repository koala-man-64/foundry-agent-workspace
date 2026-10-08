using System.Collections;
using System.IO;
using Foundry.Platform;
using Xunit;

namespace Foundry.WebView2.Tests;

/// <summary>
/// Spike S9: the plan's E2E build drives both WebView2 environments (the app UI and the integrated browser) with
/// Playwright's connectOverCDP, with the debug port passed through the API only. Two rigs stand in for the two
/// environments, each with its own user-data folder, browser process and port.
/// </summary>
public sealed class CdpTests
{
    [Fact]
    public async Task PlaywrightAttachesOverCdpToEachEnvironment()
    {
        var repository = RepositoryRoot();
        Assert.SkipUnless(Directory.Exists(Path.Combine(repository, "node_modules", "@playwright", "test")), "Needs the repository's node_modules (pnpm install) for Playwright.");
        var node = (Environment.GetEnvironmentVariable("PATH") ?? string.Empty).Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
            .Select(directory => Path.Combine(directory.Trim('"'), "node.exe")).FirstOrDefault(File.Exists)
            ?? throw new InvalidOperationException("node.exe was not found on PATH.");
        var (appPort, browserPort) = (LockdownTests.FreePort(), LockdownTests.FreePort());
        await using var app = await Rig.StartAsync(Pages.All(), new RigOptions($"--remote-debugging-port={appPort}"));
        await using var browser = await Rig.StartAsync(Pages.All(), new RigOptions($"--remote-debugging-port={browserPort}"));
        await app.NavigateAsync(Rig.AppUri);
        await browser.NavigateAsync("foundry-app://ui/frames.html");
        Assert.NotEqual(app.BrowserProcessId, browser.BrowserProcessId);

        var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            environment[(string)entry.Key] = (string?)entry.Value ?? string.Empty;
        }
        var script = Path.Combine(repository, "tests", "Foundry.WebView2.Tests", "cdp-attach.mjs");
        using var job = JobProcess.Start(new ProcessSpec(node, $"\"{node}\" \"{script}\" {appPort} {browserPort}", repository, environment));
        await job.StandardInput.DisposeAsync();
        var output = new StreamReader(job.StandardOutput).ReadToEndAsync(TestContext.Current.CancellationToken);
        var errors = new StreamReader(job.StandardError).ReadToEndAsync(TestContext.Current.CancellationToken);
        Assert.True(await job.WaitForExitAsync(TestContext.Current.CancellationToken) == 0, await errors);
        var text = await output;
        TestContext.Current.TestOutputHelper?.WriteLine(text);
        Assert.Contains($"port {appPort}: 1 context(s), page {Rig.AppUri}", text, StringComparison.Ordinal);
        Assert.Contains($"port {browserPort}: 1 context(s), page foundry-app://ui/frames.html", text, StringComparison.Ordinal);
        Assert.Equal(Rig.AppUri, await app.SourceAsync()); // Detaching left the host's browser running.
    }

    private static string RepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "Foundry.slnx")))
            {
                return directory.FullName;
            }
        }
        throw new InvalidOperationException("Foundry.slnx was not found above the test output directory.");
    }
}
