namespace Foundry.Spikes.BrowserSurface;

/// <summary>The three solid colors of the S3 pages, and anything else.</summary>
internal enum Paint
{
    Other,
    /// <summary>The UI around the browser area (#102040).</summary>
    Ui,
    /// <summary>The browser area the UI paints for the tab (#ff00ff).</summary>
    Area,
    /// <summary>The tab's page and background (#00ff00).</summary>
    Tab,
}

/// <summary>
/// A screen rectangle as the compositor presented it, classified by color. This is the ground truth for S3: it
/// measures what the user sees, independent of the arithmetic and the APIs it checks.
/// </summary>
internal sealed class ScreenCapture
{
    private const int Tolerance = 40; // Per channel; absorbs color management and HDR tone mapping, far below the palette's spacing.
    private readonly Paint[] paint;

    public ScreenCapture(DeviceRect area, uint[] bgra)
    {
        if (bgra.Length != area.Width * area.Height)
        {
            throw new ArgumentException("The pixel count does not match the area.", nameof(bgra));
        }
        Area = area;
        paint = Array.ConvertAll(bgra, Classify);
    }

    /// <summary>Screen coordinates of the captured rectangle.</summary>
    public DeviceRect Area { get; }

    public static ScreenCapture Take(DeviceRect area) => new(area, Native.CaptureScreen(area));

    public static Paint Classify(uint bgra)
    {
        var blue = (int)(bgra & 0xFF);
        var green = (int)((bgra >> 8) & 0xFF);
        var red = (int)((bgra >> 16) & 0xFF);
        return Near(red, green, blue, 0x10, 0x20, 0x40) ? Paint.Ui
            : Near(red, green, blue, 0xFF, 0x00, 0xFF) ? Paint.Area
            : Near(red, green, blue, 0x00, 0xFF, 0x00) ? Paint.Tab
            : Paint.Other;
    }

    public Paint At(int screenX, int screenY) => paint[((screenY - Area.Top) * Area.Width) + (screenX - Area.Left)];

    /// <summary>The smallest screen rectangle holding every pixel of one paint inside <paramref name="within"/>, or null.</summary>
    public DeviceRect? Bounds(Paint kind, DeviceRect within)
    {
        var zone = within.Intersect(Area);
        int left = int.MaxValue, top = int.MaxValue, right = int.MinValue, bottom = int.MinValue;
        for (var y = zone.Top; y < zone.Bottom; y++)
        {
            for (var x = zone.Left; x < zone.Right; x++)
            {
                if (At(x, y) == kind)
                {
                    left = Math.Min(left, x);
                    top = Math.Min(top, y);
                    right = Math.Max(right, x + 1);
                    bottom = Math.Max(bottom, y + 1);
                }
            }
        }
        return left == int.MaxValue ? null : new DeviceRect(left, top, right, bottom);
    }

    /// <summary>How many pixels of one paint lie inside <paramref name="within"/> and outside <paramref name="except"/>.</summary>
    public int Count(Paint kind, DeviceRect within, DeviceRect except = default)
    {
        var zone = within.Intersect(Area);
        var count = 0;
        for (var y = zone.Top; y < zone.Bottom; y++)
        {
            for (var x = zone.Left; x < zone.Right; x++)
            {
                if (At(x, y) == kind && !(x >= except.Left && x < except.Right && y >= except.Top && y < except.Bottom))
                {
                    count++;
                }
            }
        }
        return count;
    }

    /// <summary>Whether a rectangle is filled with one paint and nothing else.</summary>
    public bool IsSolid(Paint kind, DeviceRect rect) => !rect.IsEmpty && Count(kind, rect) == rect.Width * rect.Height;

    /// <summary>Whether another capture of the same area classified every pixel the same way.</summary>
    public bool SameAs(ScreenCapture other) => Area == other.Area && paint.AsSpan().SequenceEqual(other.paint);

    private static bool Near(int red, int green, int blue, int r, int g, int b) =>
        Math.Abs(red - r) <= Tolerance && Math.Abs(green - g) <= Tolerance && Math.Abs(blue - b) <= Tolerance;
}
