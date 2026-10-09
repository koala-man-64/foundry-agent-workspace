using System.Runtime.InteropServices;

namespace Foundry.Spikes.BrowserSurface;

/// <summary>
/// A plain Win32 window on the UI thread, so the host decides its style, position and messages exactly, without WPF's
/// layout or hit testing. The WPF dispatcher pumps its messages.
/// </summary>
internal sealed unsafe class NativeWindow : IDisposable
{
    private const string ClassName = "FoundrySpikeSurface";
    private static readonly Dictionary<nint, NativeWindow> Live = [];
    private static ushort classAtom;

    /// <param name="style">Window style; WS_CHILD windows take <paramref name="parent"/> as their parent, popups as their owner.</param>
    public NativeWindow(string name, int style, int extendedStyle, nint parent)
    {
        EnsureClass();
        Handle = Native.CreateWindow(extendedStyle, classAtom, name, style, 0, 0, 1, 1, parent, 0, Native.GetModuleHandle(null), 0);
        if (Handle == 0)
        {
            throw new InvalidOperationException($"CreateWindowEx failed: {Marshal.GetLastPInvokeError()}");
        }
        Live[Handle] = this;
    }

    public nint Handle { get; private set; }

    /// <summary>Sees each message first; a non-null result handles it.</summary>
    public Func<uint, nint, nint, nint?>? OnMessage { get; set; }

    /// <summary>Reports an exception thrown by <see cref="OnMessage"/>, which must not unwind into native code.</summary>
    public static Action<Exception>? OnError { get; set; }

    public void Dispose()
    {
        if (Handle != 0)
        {
            Native.DestroyWindow(Handle);
            Live.Remove(Handle);
            Handle = 0;
        }
    }

    private static void EnsureClass()
    {
        if (classAtom != 0)
        {
            return;
        }
        fixed (char* name = ClassName)
        {
            var windowClass = new Native.WindowClass
            {
                Size = (uint)sizeof(Native.WindowClass),
                Procedure = &Procedure,
                Instance = Native.GetModuleHandle(null),
                Cursor = Native.LoadCursor(0, 32512), // IDC_ARROW
                ClassName = name,
            };
            classAtom = Native.RegisterClass(&windowClass);
        }
        if (classAtom == 0)
        {
            throw new InvalidOperationException($"RegisterClassEx failed: {Marshal.GetLastPInvokeError()}");
        }
    }

    [UnmanagedCallersOnly]
    private static nint Procedure(nint window, uint message, nint wParam, nint lParam)
    {
        if (Live.TryGetValue(window, out var owner) && owner.OnMessage is { } handler)
        {
            try
            {
                if (handler(message, wParam, lParam) is { } result)
                {
                    return result;
                }
            }
            catch (Exception error) when (OnError is not null)
            {
                OnError(error);
            }
        }
        if (message == Native.WmNcDestroy)
        {
            Live.Remove(window);
        }
        return Native.DefaultWindowProcedure(window, message, wParam, lParam);
    }
}
