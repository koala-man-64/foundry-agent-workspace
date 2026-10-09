using Foundry.Spikes.BrowserSurface;
using Xunit;

namespace Foundry.WebView2.Tests;

/// <summary>
/// The arithmetic and pixel classification behind spike S3's harness. A harness bug here would turn into a false pass,
/// so each rule is pinned apart from any display.
/// </summary>
public sealed class TabGeometryTests
{
    [Fact]
    public void RendererBoundsRoundInwardToWholeCssPixelsAsBrowserPanelDoes()
    {
        var bounds = TabGeometry.RendererBounds(new CssRect(10.37, 20.61, 110.66, 220.04), 400, 300, visible: true);

        Assert.Equal(new CssBounds(11, 21, 99, 199, true), bounds);
    }

    [Fact]
    public void RendererBoundsClampToTheViewportAndHideWhenEmpty()
    {
        Assert.Equal(new CssBounds(0, 0, 400, 300, true), TabGeometry.RendererBounds(new CssRect(-5.5, -1, 999.9, 777), 400, 300, visible: true));
        Assert.Equal(new CssBounds(11, 0, 0, 0, false), TabGeometry.RendererBounds(new CssRect(10.2, -4, 10.8, -2), 400, 300, visible: true));
        Assert.False(TabGeometry.RendererBounds(new CssRect(10, 10, 50, 50), 400, 300, visible: false).Visible);
    }

    [Theory]
    [InlineData(0.5, 1)]
    [InlineData(1.5, 2)]
    [InlineData(2.5, 3)]
    [InlineData(2.49, 2)]
    public void DeviceEdgesRoundHalfAwayFromZeroAsChromiumSnapsABox(double css, int device)
    {
        Assert.Equal(device, TabGeometry.ToDevice(new CssRect(css, css, css, css), 1, 1).Left);
    }

    [Fact]
    public void EachEdgeIsRoundedOnItsOwnSoWidthsNeverAccumulateError()
    {
        // At 150% the edges 1 and 2 land on 1.5 and 3, so the tab spans device pixels 2 to 3. Rounding the origin (2) and
        // the width (round(1.5) = 2) separately would end it at 4, a pixel past the area's painted edge.
        var rect = TabGeometry.ToDevice(new CssRect(1, 1, 2, 2), zoomFactor: 1, rasterizationScale: 1.5);

        Assert.Equal(new DeviceRect(2, 2, 3, 3), rect);
        Assert.Equal(new DeviceRect(30, 60, 90, 120), TabGeometry.ToDevice(new CssRect(10, 20, 30, 40), zoomFactor: 2, rasterizationScale: 1.5));
    }

    [Fact]
    public void ClampKeepsTheTabInsideTheClientArea()
    {
        Assert.Equal(new DeviceRect(0, 5, 100, 80), TabGeometry.Clamp(new DeviceRect(-10, 5, 140, 80), 100, 90));
        Assert.True(TabGeometry.Clamp(new DeviceRect(120, 5, 140, 80), 100, 90).IsEmpty);
    }

    [Fact]
    public void ErrorsArePositiveForAGapAndNegativeForAnOverlap()
    {
        var errors = TabGeometry.Compare(painted: new DeviceRect(100, 100, 200, 200), tab: new DeviceRect(101, 99, 197, 202));

        Assert.Equal(new EdgeErrors(1, -1, 3, -2), errors);
        Assert.Equal(3, errors.Max);
    }

    /// <summary>
    /// Why the as-designed path can miss by more than a device pixel: the UI rounds a fractional edge inward to a whole
    /// CSS pixel before the host multiplies by zoom and scale, while Chromium paints the fractional edge.
    /// </summary>
    [Fact]
    public void WholePixelRendererBoundsCanMissAFractionalEdgeByZoomTimesScale()
    {
        var area = new CssRect(10.37, 20, 110, 220);
        var painted = TabGeometry.ToDevice(area, zoomFactor: 2, rasterizationScale: 2);
        var renderer = TabGeometry.ToDevice(TabGeometry.RendererBounds(area, 1000, 1000, visible: true).ToRect(), zoomFactor: 2, rasterizationScale: 2);

        Assert.Equal(41, painted.Left);  // round(10.37 x 4) = round(41.48)
        Assert.Equal(44, renderer.Left); // round(ceil(10.37) x 4) = 44
        Assert.Equal(3, TabGeometry.Compare(painted, renderer).Left);
    }

    [Fact]
    public void TheCaptureClassifiesThePaletteWithinTolerance()
    {
        Assert.Equal(Paint.Ui, ScreenCapture.Classify(Bgra(0x10, 0x20, 0x40)));
        Assert.Equal(Paint.Area, ScreenCapture.Classify(Bgra(0xF0, 0x08, 0xF4)));
        Assert.Equal(Paint.Tab, ScreenCapture.Classify(Bgra(0x00, 0xFF, 0x00)));
        Assert.Equal(Paint.Other, ScreenCapture.Classify(Bgra(0x80, 0x00, 0x80))); // The area under a modal's backdrop.
        Assert.Equal(Paint.Other, ScreenCapture.Classify(Bgra(0xFF, 0xFF, 0xFF)));
    }

    [Fact]
    public void TheCaptureFindsBoundsSolidityAndStrayPixels()
    {
        // A 6x5 capture at screen (100, 200): Ui everywhere, the Area at x 101-104, y 201-203, one Tab pixel at (105, 204).
        var area = new DeviceRect(100, 200, 106, 205);
        var pixels = new uint[30];
        for (var y = 0; y < 5; y++)
        {
            for (var x = 0; x < 6; x++)
            {
                pixels[(y * 6) + x] = x is >= 1 and <= 4 && y is >= 1 and <= 3 ? Bgra(0xFF, 0x00, 0xFF) : Bgra(0x10, 0x20, 0x40);
            }
        }
        pixels[29] = Bgra(0x00, 0xFF, 0x00);
        var capture = new ScreenCapture(area, pixels);

        var painted = capture.Bounds(Paint.Area, area);
        Assert.Equal(new DeviceRect(101, 201, 105, 204), painted);
        Assert.True(capture.IsSolid(Paint.Area, painted!.Value));
        Assert.False(capture.IsSolid(Paint.Area, new DeviceRect(100, 201, 105, 204)));
        Assert.Equal(1, capture.Count(Paint.Tab, area));
        Assert.Equal(0, capture.Count(Paint.Tab, area, except: new DeviceRect(105, 204, 106, 205)));
        Assert.Null(capture.Bounds(Paint.Other, area));
    }

    [Fact]
    public void TwoCapturesAgreeOnlyWhenEveryPixelClassifiesTheSame()
    {
        var area = new DeviceRect(0, 0, 2, 1);
        var first = new ScreenCapture(area, [Bgra(0x10, 0x20, 0x40), Bgra(0x00, 0xFF, 0x00)]);

        Assert.True(first.SameAs(new ScreenCapture(area, [Bgra(0x12, 0x22, 0x40), Bgra(0x00, 0xF0, 0x00)]))); // Within tolerance.
        Assert.False(first.SameAs(new ScreenCapture(area, [Bgra(0x10, 0x20, 0x40), Bgra(0xFF, 0x00, 0xFF)])));
        Assert.False(first.SameAs(new ScreenCapture(new DeviceRect(1, 0, 3, 1), [Bgra(0x10, 0x20, 0x40), Bgra(0x00, 0xFF, 0x00)])));
    }

    private static uint Bgra(int red, int green, int blue) => (uint)((0xFF << 24) | (red << 16) | (green << 8) | blue);
}
