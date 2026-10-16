using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Foundry.Platform;

/// <summary>Windows ICU's IANA history, rather than the Windows registry's reduced historic rules.</summary>
public sealed partial class IcuTimeZone : IDisposable
{
    private sealed class SafeCalendar : SafeHandleZeroOrMinusOneIsInvalid
    {
        public SafeCalendar() : base(true) { }
        internal SafeCalendar(nint value) : this() => SetHandle(value);
        protected override bool ReleaseHandle() { IcuTimeZone.Close(handle); return true; }
    }
    private readonly SafeCalendar calendar;
    public unsafe IcuTimeZone(string name)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        if (name.Contains('\0')) throw new ArgumentException("Invalid time zone.", nameof(name));
        if (name.Length >= 3 && name[0] is '+' or '-')
        {
            var digits = name[1..].Replace(":", "", StringComparison.Ordinal);
            if (digits.Length is not 2 and not 4 || !digits.All(char.IsAsciiDigit)) throw new ArgumentException("Invalid time zone.", nameof(name));
            name = "GMT" + name[0] + digits[..2] + ":" + (digits.Length == 4 ? digits[2..] : "00");
        }
        var status = 0;
        var canonical = new char[256];
        fixed (char* zone = name)
        fixed (char* output = canonical)
        {
            byte system;
            _ = Canonical(zone, name.Length, output, canonical.Length, &system, &status);
            if (status > 0) throw new ArgumentException("Invalid time zone.", nameof(name));
            status = 0;
            // UCAL_GREGORIAN=1; an explicit locale avoids dependence on the user's calendar preferences.
            calendar = new SafeCalendar(Open(zone, name.Length, "en_CA", 1, &status));
        }
        if (status > 0 || calendar.IsInvalid) { Dispose(); throw new InvalidOperationException("Time-zone initialization failed."); }
    }

    public long OffsetMilliseconds(DateTimeOffset instant) => OffsetMilliseconds(instant.ToUnixTimeMilliseconds());
    public unsafe long OffsetMilliseconds(long epochMilliseconds)
    {
        ObjectDisposedException.ThrowIf(calendar.IsClosed || calendar.IsInvalid, this);
        var status = 0;
        SetMillis(calendar, epochMilliseconds, &status);
        var offset = Get(calendar, 15, &status); // UCAL_ZONE_OFFSET
        var daylight = Get(calendar, 16, &status); // UCAL_DST_OFFSET
        if (status > 0) throw new InvalidOperationException("Time-zone conversion failed.");
        return (long)offset + daylight;
    }
    public void Dispose()
    {
        calendar.Dispose();
        GC.SuppressFinalize(this);
    }

    [LibraryImport("icu.dll", EntryPoint = "ucal_open", StringMarshalling = StringMarshalling.Utf8)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static unsafe partial nint Open(char* zone, int length, string locale, int type, int* status);
    [LibraryImport("icu.dll", EntryPoint = "ucal_close")]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static partial void Close(nint calendar);
    [LibraryImport("icu.dll", EntryPoint = "ucal_setMillis")]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static unsafe partial void SetMillis(SafeCalendar calendar, double instant, int* status);
    [LibraryImport("icu.dll", EntryPoint = "ucal_get")]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static unsafe partial int Get(SafeCalendar calendar, int field, int* status);
    [LibraryImport("icu.dll", EntryPoint = "ucal_getCanonicalTimeZoneID")]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static unsafe partial int Canonical(char* zone, int length, char* output, int capacity, byte* system, int* status);
}
