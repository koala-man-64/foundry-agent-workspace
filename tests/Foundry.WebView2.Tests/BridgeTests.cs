using Xunit;

// Each test drives a real browser process; one at a time keeps them from competing and keeps environment variables
// (LockdownTests) from leaking into another test's WebView2.
[assembly: Xunit.v3.Parallelization(Mode = Xunit.Sdk.ParallelMode.None)]

namespace Foundry.WebView2.Tests;

/// <summary>Spike S2: what reaches the host from the app document, from frames, popups and other origins.</summary>
public sealed class BridgeTests
{
    private static bool Reported(Observation item, string kind) => item.Kind == "message" && item.IsString && item.Text?.Contains($"\"kind\":\"{kind}\"", StringComparison.Ordinal) == true;

    [Fact]
    public async Task OnlyAStrictJsonStringFromTheAppUriPassesTheGate()
    {
        await using var rig = await Rig.StartAsync(Pages.All());
        await rig.NavigateAsync(Rig.AppUri);
        await rig.WaitForAsync(item => Reported(item, "popup"), "the app script to finish");
        var messages = rig.Messages.ToList();

        Assert.All(messages, item => Assert.Equal(Rig.AppUri, item.Source)); // Source is the exact document URI.
        Assert.True(GatePrototype.Accepts(Assert.Single(messages, item => item.Text == "{\"kind\":\"hello\"}")));
        var oversized = Assert.Single(messages, item => item.Text?.Length == GatePrototype.MaxBytes + 1); // Delivered whole.
        var malformed = Assert.Single(messages, item => item.Text == "{\"kind\":\"hello\",");
        var structured = Assert.Single(messages, item => !item.IsString); // postMessage(object) is not a string message.
        Assert.Equal([oversized, malformed, structured], messages.Where(item => !GatePrototype.Accepts(item)));
    }

    [Fact]
    public async Task TheCustomSchemeHeaderPolicyBlocksEvalInlineScriptAndNetwork()
    {
        await using var rig = await Rig.StartAsync(Pages.All());
        await rig.NavigateAsync(Rig.AppUri);
        var eval = await rig.WaitForAsync(item => Reported(item, "eval"), "the eval probe");
        Assert.Contains("\"allowed\":false", eval.Text, StringComparison.Ordinal);
        var fetch = await rig.WaitForAsync(item => Reported(item, "fetch"), "the fetch probe");
        Assert.Contains("\"allowed\":false", fetch.Text, StringComparison.Ordinal);
        await rig.WaitForAsync(item => Reported(item, "csp-violation") && item.Text!.Contains("connect-src", StringComparison.Ordinal), "the connect-src violation");
        await rig.WaitForAsync(item => Reported(item, "csp-violation") && item.Text!.Contains("script-src", StringComparison.Ordinal), "the inline-script violation");
        Assert.DoesNotContain(rig.Messages, item => Reported(item, "inline-ran"));
    }

    [Fact]
    public async Task APopupIsSeenAndRefused()
    {
        await using var rig = await Rig.StartAsync(Pages.All());
        await rig.NavigateAsync(Rig.AppUri);
        var popup = await rig.WaitForAsync(item => Reported(item, "popup"), "the popup probe");
        Assert.Contains("\"opened\":false", popup.Text, StringComparison.Ordinal);
        Assert.Equal("foundry-app://ui/popup.html", Assert.Single(rig.Observations, item => item.Kind == "new-window").Text);
    }

    [Fact]
    public async Task FrameMessagesNeverReachTheTopLevelEvent()
    {
        await using var rig = await Rig.StartAsync(Pages.All());
        await rig.NavigateAsync("foundry-app://ui/frames.html");
        await rig.WaitForAsync(item => Reported(item, "frames-ready"), "the top-level script");
        await rig.WaitForAsync(item => item.Kind == "frame-created", "FrameCreated, which lets the host treat any frame as fatal");
        await Task.Delay(1500, TestContext.Current.CancellationToken); // The frame posts every 50 ms.
        Assert.DoesNotContain(rig.Messages, item => Reported(item, "from-frame"));
    }

    [Fact]
    public async Task AMessageFromAnotherOriginCarriesThatOriginAndFailsTheGate()
    {
        await using var rig = await Rig.StartAsync(Pages.All());
        await rig.NavigateAsync("foundry-app://ui/redirect.html");
        var foreign = await rig.WaitForAsync(item => Reported(item, "hello"), "the landing page's message");
        Assert.Equal("foundry-app://evil/landing.html", foreign.Source);
        Assert.False(GatePrototype.Accepts(foreign));
    }

    [Fact]
    public async Task CancellingForeignNavigationKeepsTheAppDocument()
    {
        await using var rig = await Rig.StartAsync(Pages.All(), new RigOptions(CancelForeignNavigation: true));
        await rig.NavigateAsync("foundry-app://ui/redirect.html");
        await rig.WaitForAsync(item => item.Kind == "navigation-cancelled" && item.Text == "foundry-app://evil/landing.html", "the cancelled navigation");
        await Task.Delay(1000, TestContext.Current.CancellationToken);
        Assert.Equal("foundry-app://ui/redirect.html", await rig.SourceAsync());
        Assert.DoesNotContain(rig.Messages, item => item.Source.StartsWith("foundry-app://evil", StringComparison.Ordinal));
    }
}
