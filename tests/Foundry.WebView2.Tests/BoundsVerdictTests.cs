using Foundry.Spikes.BrowserSurface;
using Xunit;

namespace Foundry.WebView2.Tests;

/// <summary>
/// Spike S3's verdict rules, apart from any display: how one photograph is judged, and when a pass at a scale is met.
/// A wrong rule here would print "met" on a failure, so each outcome is pinned.
/// </summary>
public sealed class BoundsVerdictTests
{
    // A 20x12 capture at (100, 200): the painted area at x 104-115, y 203-208 unless a test paints otherwise.
    private static readonly DeviceRect Zone = new(100, 200, 120, 212);
    private static readonly DeviceRect Painted = new(104, 203, 116, 209);

    [Fact]
    public void ATabOnThePaintedAreaPasses()
    {
        var (tab, errors, _, _, outcome, reason) = BoundsSpike.Judge(Painted, Capture(Painted), Zone, placedByEvents: true, obstruction: null);

        Assert.Equal(Painted, tab);
        Assert.Equal(new EdgeErrors(0, 0, 0, 0), errors);
        Assert.Equal(Outcome.Pass, outcome);
        Assert.Null(reason);
    }

    [Theory]
    [InlineData(1, "pass")]
    [InlineData(2, "FAIL")]
    public void AnEdgeMoreThanOnePixelOffFails(int inset, string expected)
    {
        var tab = new DeviceRect(Painted.Left + inset, Painted.Top, Painted.Right, Painted.Bottom);

        Assert.Equal(expected, BoundsSpike.Judge(Painted, Capture(tab, area: Painted), Zone, true, null).Outcome);
    }

    [Fact]
    public void NoTabInViewFailsUnlessSomethingElseCoversTheArea()
    {
        Assert.Equal(Outcome.Fail, BoundsSpike.Judge(Painted, Capture(tab: null, area: Painted), Zone, true, null).Outcome);
        Assert.Equal(Outcome.Obstructed, BoundsSpike.Judge(Painted, Capture(tab: null, area: Painted, other: [(110, 205)]), Zone, true, null).Outcome);
    }

    [Fact]
    public void SomethingAwayFromTheTabIsAnObstructionButASeamAlongItsEdgeFails()
    {
        var tab = new DeviceRect(105, 203, 116, 209); // One pixel short on the left, leaving a column of the area.
        Assert.Equal(Outcome.Obstructed, BoundsSpike.Judge(Painted, Capture(tab, area: Painted, other: [(101, 201)]), Zone, true, null).Outcome);
        Assert.Equal(Outcome.Fail, BoundsSpike.Judge(Painted, Capture(tab, area: Painted, other: [(104, 205)]), Zone, true, null).Outcome);
    }

    [Fact]
    public void AHoleInTheTabFails()
    {
        var capture = Capture(Painted, area: Painted, holes: [(110, 205)]);

        var judged = BoundsSpike.Judge(Painted, capture, Zone, true, null);

        Assert.Equal(Outcome.Fail, judged.Outcome);
        Assert.Equal("the tab is not one solid rectangle", judged.Reason);
    }

    [Fact]
    public void ATabTheHostDidNotReSyncByItselfFailsEvenWhenItLooksRight()
    {
        var judged = BoundsSpike.Judge(Painted, Capture(Painted), Zone, placedByEvents: false, obstruction: null);

        Assert.Equal(Outcome.Fail, judged.Outcome);
        Assert.Equal("the host had not re-synced the tab by itself", judged.Reason);
    }

    [Fact]
    public void AnObstructedOrUnstableAreaIsNeverJudged()
    {
        Assert.Equal(Outcome.Obstructed, BoundsSpike.Judge(Painted, Capture(Painted), Zone, true, "something else covered the painted area").Outcome);
        Assert.Equal(Outcome.Obstructed, BoundsSpike.Judge(Painted, shown: null, Zone, true, null).Outcome);
        Assert.Equal(Outcome.Obstructed, BoundsSpike.Judge(painted: null, Capture(Painted), Zone, true, null).Outcome);
    }

    [Fact]
    public void AScaleIsMetOnlyByACompletePassWithEveryDesignPlacementAndModalPassing()
    {
        Assert.Equal("met", Pass(Placements()).Verdict);
        Assert.Equal("incomplete", Pass(Placements().Skip(1)).Verdict);
        Assert.Equal("incomplete", Pass(Placements(obstructed: 3)).Verdict);
        Assert.Equal("incomplete", Pass(Placements(), Modal(Outcome.Obstructed)).Verdict);
    }

    [Fact]
    public void AFailureDecidesTheScaleEvenWhenSomethingElseWasObstructed()
    {
        Assert.Equal("not met", Pass(Placements(failed: 2, obstructed: 3)).Verdict);
        Assert.Equal("not met", Pass(Placements(), Modal(Outcome.Fail)).Verdict);
        // The exact-rectangle placement is a diagnostic; it never decides the design.
        Assert.Equal("met", Pass(Placements(failed: 1)).Verdict);
    }

    /// <summary>The 18 placements of a pass, alternating design and diagnostic, all passing unless told otherwise.</summary>
    private static IEnumerable<BoundsRecord> Placements(int failed = -1, int obstructed = -1) =>
        Enumerable.Range(0, ScalePass.ExpectedPlacements).Select(index => new BoundsRecord(
            "placement", 1, DateTimeOffset.UnixEpoch, 96, 100, false, 1, 1, 1, 1, "standard", "aligned",
            index % 2 == 0 ? nameof(Placement.Renderer) : nameof(Placement.Exact), default, default, default, default, default,
            true, 0, null, null, null, 0, 0,
            index == failed ? Outcome.Fail : index == obstructed ? Outcome.Obstructed : Outcome.Pass, null));

    private static ModalRecord Modal(string outcome) =>
        new("modal", 1, DateTimeOffset.UnixEpoch, 96, 100, false, "confirmation", true, 0, null, null, outcome, null);

    private static ScalePass Pass(IEnumerable<BoundsRecord> placements, ModalRecord? second = null) =>
        new(1, new Scale(96, 100, false), ScalePass.ScaleChange, [.. placements], [Modal(Outcome.Pass), second ?? Modal(Outcome.Pass)]);

    /// <summary>The zone painted as the UI, with the area, the tab, stray pixels and holes in the tab drawn over it.</summary>
    private static ScreenCapture Capture(DeviceRect? tab, DeviceRect? area = null, (int X, int Y)[]? other = null, (int X, int Y)[]? holes = null)
    {
        var pixels = new uint[Zone.Width * Zone.Height];
        for (var y = Zone.Top; y < Zone.Bottom; y++)
        {
            for (var x = Zone.Left; x < Zone.Right; x++)
            {
                var paint = Bgra(0x10, 0x20, 0x40);
                if (area is { } a && x >= a.Left && x < a.Right && y >= a.Top && y < a.Bottom)
                {
                    paint = Bgra(0xFF, 0x00, 0xFF);
                }
                if (tab is { } t && x >= t.Left && x < t.Right && y >= t.Top && y < t.Bottom && !(holes ?? []).Contains((x, y)))
                {
                    paint = Bgra(0x00, 0xFF, 0x00);
                }
                if ((other ?? []).Contains((x, y)))
                {
                    paint = Bgra(0xFF, 0xFF, 0xFF);
                }
                pixels[((y - Zone.Top) * Zone.Width) + (x - Zone.Left)] = paint;
            }
        }
        return new ScreenCapture(Zone, pixels);
    }

    private static uint Bgra(int red, int green, int blue) => (uint)((0xFF << 24) | (red << 16) | (green << 8) | blue);
}
