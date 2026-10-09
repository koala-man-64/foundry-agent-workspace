namespace Foundry.Spikes.BrowserSurface;

/// <summary>An element's box in CSS pixels, as <c>getBoundingClientRect</c> reports it (fractional).</summary>
internal readonly record struct CssRect(double Left, double Top, double Right, double Bottom);

/// <summary>What the renderer sends the host: whole CSS pixels and visibility (<c>BrowserBoundsSchema</c>).</summary>
internal readonly record struct CssBounds(int X, int Y, int Width, int Height, bool Visible)
{
    public static readonly CssBounds Hidden = new(0, 0, 0, 0, false);

    public CssRect ToRect() => new(X, Y, X + Width, Y + Height);
}

/// <summary>A rectangle in device pixels, edges inclusive-exclusive.</summary>
internal readonly record struct DeviceRect(int Left, int Top, int Right, int Bottom)
{
    public int Width => Right - Left;

    public int Height => Bottom - Top;

    public bool IsEmpty => Width <= 0 || Height <= 0;

    public DeviceRect Offset(int x, int y) => new(Left + x, Top + y, Right + x, Bottom + y);

    public DeviceRect Inflate(int by) => new(Left - by, Top - by, Right + by, Bottom + by);

    public DeviceRect Intersect(DeviceRect other)
    {
        var result = new DeviceRect(Math.Max(Left, other.Left), Math.Max(Top, other.Top), Math.Min(Right, other.Right), Math.Min(Bottom, other.Bottom));
        return result.IsEmpty ? default : result;
    }

    public override string ToString() => FormattableString.Invariant($"({Left},{Top})-({Right},{Bottom}) {Width}x{Height}");
}

/// <summary>Signed error per edge in device pixels: positive where the tab stops short of the area, negative where it overlaps past it.</summary>
internal readonly record struct EdgeErrors(int Left, int Top, int Right, int Bottom)
{
    public int Max => Math.Max(Math.Max(Math.Abs(Left), Math.Abs(Top)), Math.Max(Math.Abs(Right), Math.Abs(Bottom)));

    public override string ToString() => FormattableString.Invariant($"L{Left:+0;-0;0} T{Top:+0;-0;0} R{Right:+0;-0;0} B{Bottom:+0;-0;0}");
}

/// <summary>The bounds arithmetic under test, kept pure so it is unit-tested apart from any display.</summary>
internal static class TabGeometry
{
    /// <summary>
    /// <c>BrowserPanel.tsx</c> <c>sendBounds</c> (lines 56-63), unchanged: whole CSS pixels rounded inward and clamped to the
    /// viewport. The UI is reused as is, so this is what a WPF host receives.
    /// </summary>
    public static CssBounds RendererBounds(CssRect rect, double innerWidth, double innerHeight, bool visible)
    {
        var x = Math.Max(0, Math.Ceiling(rect.Left));
        var y = Math.Max(0, Math.Ceiling(rect.Top));
        var right = Math.Min(innerWidth, Math.Floor(rect.Right));
        var bottom = Math.Min(innerHeight, Math.Floor(rect.Bottom));
        return new CssBounds((int)x, (int)y, (int)Math.Max(0, right - x), (int)Math.Max(0, bottom - y), visible && right > x && bottom > y);
    }

    /// <summary>
    /// Section 6: CSS pixels times the UI zoom factor times the rasterization scale. Each edge is rounded on its own, half
    /// away from zero as Chromium snaps a box, so widths never accumulate rounding.
    /// </summary>
    public static DeviceRect ToDevice(CssRect css, double zoomFactor, double rasterizationScale)
    {
        var scale = zoomFactor * rasterizationScale;
        return new DeviceRect(Round(css.Left * scale), Round(css.Top * scale), Round(css.Right * scale), Round(css.Bottom * scale));
    }

    /// <summary>Keeps the tab inside the UI's client area, as <c>browser-manager.ts</c> <c>syncViews</c> does.</summary>
    public static DeviceRect Clamp(DeviceRect rect, int width, int height)
    {
        var left = Math.Clamp(rect.Left, 0, width);
        var top = Math.Clamp(rect.Top, 0, height);
        return new DeviceRect(left, top, Math.Clamp(rect.Right, left, width), Math.Clamp(rect.Bottom, top, height));
    }

    /// <summary>How far the tab's visible edges sit from the area the UI painted for it.</summary>
    public static EdgeErrors Compare(DeviceRect painted, DeviceRect tab) =>
        new(tab.Left - painted.Left, tab.Top - painted.Top, painted.Right - tab.Right, painted.Bottom - tab.Bottom);

    private static int Round(double value) => (int)Math.Round(value, MidpointRounding.AwayFromZero);
}
