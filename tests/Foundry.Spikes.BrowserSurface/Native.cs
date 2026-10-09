using System.Runtime.InteropServices;

[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]

namespace Foundry.Spikes.BrowserSurface;

/// <summary>A Win32 rectangle in device pixels.</summary>
[StructLayout(LayoutKind.Sequential)]
internal struct NativeRect
{
    public int Left, Top, Right, Bottom;

    public readonly DeviceRect ToDevice() => new(Left, Top, Right, Bottom);
}

[StructLayout(LayoutKind.Sequential)]
internal struct NativePoint
{
    public int X, Y;
}

/// <summary>user32, gdi32 and dwmapi entry points for the spike host. Blittable signatures only.</summary>
internal static unsafe partial class Native
{
    public const int WsChild = 0x40000000;
    public const int WsPopup = unchecked((int)0x80000000);
    public const int WsClipSiblings = 0x04000000;
    public const int WsClipChildren = 0x02000000;
    public const int WsExLayered = 0x00080000;
    public const int WsExNoActivate = 0x08000000;
    public const int WsExToolWindow = 0x00000080;

    public const uint SwpNoSize = 0x0001;
    public const uint SwpNoMove = 0x0002;
    public const uint SwpNoZOrder = 0x0004;
    public const uint SwpNoActivate = 0x0010;
    public const uint SwpShowWindow = 0x0040;
    public const uint SwpHideWindow = 0x0080;
    public const uint SwpNoOwnerZOrder = 0x0200;
    public static readonly nint HwndTop = 0;

    public const uint LwaAlpha = 0x2;
    public const uint MonitorDefaultToNearest = 2;
    public const uint GwEnabledPopup = 6;

    public const uint WmMove = 0x0003;
    public const uint WmSize = 0x0005;
    public const uint WmClose = 0x0010;
    public const uint WmSetCursor = 0x0020;
    public const uint WmMouseActivate = 0x0021;
    public const uint WmNcDestroy = 0x0082;
    public const uint WmTouch = 0x0240;
    public const uint WmPointerUpdate = 0x0245;
    public const uint WmPointerDown = 0x0246;
    public const uint WmPointerWheel = 0x024E;
    public const uint WmPointerHWheel = 0x024F;
    public const uint WmMouseMove = 0x0200;
    public const uint WmLButtonDown = 0x0201;
    public const uint WmLButtonDoubleClick = 0x0203;
    public const uint WmRButtonDown = 0x0204;
    public const uint WmRButtonDoubleClick = 0x0206;
    public const uint WmMButtonDown = 0x0207;
    public const uint WmMButtonDoubleClick = 0x0209;
    public const uint WmMouseWheel = 0x020A;
    public const uint WmXButtonDown = 0x020B;
    public const uint WmXButtonDoubleClick = 0x020D;
    public const uint WmMouseHWheel = 0x020E;
    public const nint MaNoActivate = 3;

    public const int PointerTypeTouch = 2;
    public const int PointerTypePen = 3;
    public const int PointerTypeMouse = 4;
    public const int PointerTypeTouchpad = 5;

    private const uint SrcCopy = 0x00CC0020;
    private const uint DibRgbColors = 0;

    [StructLayout(LayoutKind.Sequential)]
    public struct WindowClass
    {
        public uint Size;
        public uint Style;
        public delegate* unmanaged<nint, uint, nint, nint, nint> Procedure;
        public int ClassExtra, WindowExtra;
        public nint Instance, Icon, Cursor, Background;
        public char* MenuName;
        public char* ClassName;
        public nint SmallIcon;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo
    {
        public uint Size;
        public NativeRect Monitor;
        public NativeRect Work;
        public uint Flags;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BitmapInfoHeader
    {
        public uint Size;
        public int Width, Height;
        public ushort Planes, BitCount;
        public uint Compression, SizeImage;
        public int XPelsPerMeter, YPelsPerMeter;
        public uint ColorsUsed, ColorsImportant;
    }

    [LibraryImport("user32.dll", EntryPoint = "RegisterClassExW", SetLastError = true)]
    public static partial ushort RegisterClass(WindowClass* windowClass);

    [LibraryImport("user32.dll", EntryPoint = "CreateWindowExW", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    public static partial nint CreateWindow(int extendedStyle, nint classAtom, string name, int style, int x, int y, int width, int height, nint parent, nint menu, nint instance, nint parameter);

    [LibraryImport("user32.dll", EntryPoint = "DefWindowProcW")]
    public static partial nint DefaultWindowProcedure(nint window, uint message, nint wParam, nint lParam);

    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool DestroyWindow(nint window);

    [LibraryImport("user32.dll", EntryPoint = "LoadCursorW")]
    public static partial nint LoadCursor(nint instance, nint name);

    [LibraryImport("kernel32.dll", EntryPoint = "GetModuleHandleW", StringMarshalling = StringMarshalling.Utf16)]
    public static partial nint GetModuleHandle(string? name);

    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool SetWindowPos(nint window, nint insertAfter, int x, int y, int width, int height, uint flags);

    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool GetWindowRect(nint window, out NativeRect rect);

    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool GetClientRect(nint window, out NativeRect rect);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool ClientToScreen(nint window, ref NativePoint point);

    [LibraryImport("user32.dll")]
    public static partial uint GetDpiForWindow(nint window);

    /// <summary>Returns whether the window was disabled before the call.</summary>
    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool EnableWindow(nint window, [MarshalAs(UnmanagedType.Bool)] bool enable);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool IsWindowEnabled(nint window);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool IsWindowVisible(nint window);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool IsChild(nint parent, nint window);

    [LibraryImport("user32.dll")]
    public static partial nint GetFocus();

    [LibraryImport("user32.dll")]
    public static partial nint SetFocus(nint window);

    [LibraryImport("user32.dll")]
    public static partial nint GetForegroundWindow();

    /// <summary>The visible, enabled window at a screen point; disabled and hidden windows are skipped.</summary>
    [LibraryImport("user32.dll")]
    public static partial nint WindowFromPoint(NativePoint point);

    [LibraryImport("user32.dll")]
    public static partial nint GetWindow(nint window, uint command);

    [LibraryImport("user32.dll", EntryPoint = "PostMessageW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool PostMessage(nint window, uint message, nint wParam, nint lParam);

    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool SetLayeredWindowAttributes(nint window, uint colorKey, byte alpha, uint flags);

    /// <summary>The tick count (GetTickCount, milliseconds) at which the current message was posted.</summary>
    [LibraryImport("user32.dll")]
    public static partial int GetMessageTime();

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool GetPointerType(uint pointerId, out int pointerType);

    [LibraryImport("user32.dll")]
    private static partial nint MonitorFromWindow(nint window, uint flags);

    [LibraryImport("user32.dll", EntryPoint = "GetMonitorInfoW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetMonitorInfo(nint monitor, ref MonitorInfo info);

    [LibraryImport("user32.dll")]
    private static partial nint GetDC(nint window);

    [LibraryImport("user32.dll")]
    private static partial int ReleaseDC(nint window, nint deviceContext);

    [LibraryImport("gdi32.dll")]
    private static partial nint CreateCompatibleDC(nint deviceContext);

    [LibraryImport("gdi32.dll")]
    private static partial nint CreateCompatibleBitmap(nint deviceContext, int width, int height);

    [LibraryImport("gdi32.dll")]
    private static partial nint SelectObject(nint deviceContext, nint gdiObject);

    [LibraryImport("gdi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool BitBlt(nint destination, int x, int y, int width, int height, nint source, int sourceX, int sourceY, uint operation);

    [LibraryImport("gdi32.dll")]
    private static partial int GetDIBits(nint deviceContext, nint bitmap, uint start, uint lines, void* bits, BitmapInfoHeader* info, uint usage);

    [LibraryImport("gdi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool DeleteObject(nint gdiObject);

    [LibraryImport("gdi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool DeleteDC(nint deviceContext);

    [LibraryImport("dwmapi.dll")]
    private static partial int DwmFlush();

    public static DeviceRect WindowRect(nint window) => GetWindowRect(window, out var rect) ? rect.ToDevice() : default;

    /// <summary>The client area in screen coordinates.</summary>
    public static DeviceRect ClientScreenRect(nint window)
    {
        if (!GetClientRect(window, out var client))
        {
            return default;
        }
        var origin = new NativePoint();
        ClientToScreen(window, ref origin);
        return new DeviceRect(origin.X, origin.Y, origin.X + client.Right, origin.Y + client.Bottom);
    }

    /// <summary>The work area of the monitor nearest the window, in device pixels.</summary>
    public static DeviceRect WorkArea(nint window)
    {
        var info = new MonitorInfo { Size = (uint)sizeof(MonitorInfo) };
        return GetMonitorInfo(MonitorFromWindow(window, MonitorDefaultToNearest), ref info) ? info.Work.ToDevice() : default;
    }

    /// <summary>Waits until the compositor has presented the next frame.</summary>
    public static void FlushComposition() => _ = DwmFlush();

    /// <summary>Copies a screen rectangle as composed by the desktop window manager, as 32-bit BGRA rows, top-down.</summary>
    public static uint[] CaptureScreen(DeviceRect area)
    {
        var pixels = new uint[area.Width * area.Height];
        var screen = GetDC(0);
        var memory = CreateCompatibleDC(screen);
        var bitmap = CreateCompatibleBitmap(screen, area.Width, area.Height);
        var previous = SelectObject(memory, bitmap);
        try
        {
            if (!BitBlt(memory, 0, 0, area.Width, area.Height, screen, area.Left, area.Top, SrcCopy))
            {
                throw new InvalidOperationException($"BitBlt failed: {Marshal.GetLastPInvokeError()}");
            }
            SelectObject(memory, previous);
            previous = 0;
            // The header is followed by space for the three color masks GetDIBits may write.
            var header = stackalloc byte[sizeof(BitmapInfoHeader) + 16];
            var info = (BitmapInfoHeader*)header;
            *info = new BitmapInfoHeader { Size = (uint)sizeof(BitmapInfoHeader), Width = area.Width, Height = -area.Height, Planes = 1, BitCount = 32 };
            fixed (uint* bits = pixels)
            {
                if (GetDIBits(memory, bitmap, 0, (uint)area.Height, bits, info, DibRgbColors) != area.Height)
                {
                    throw new InvalidOperationException("GetDIBits returned fewer rows than requested.");
                }
            }
            return pixels;
        }
        finally
        {
            if (previous != 0)
            {
                SelectObject(memory, previous);
            }
            DeleteObject(bitmap);
            DeleteDC(memory);
            _ = ReleaseDC(0, screen);
        }
    }
}
