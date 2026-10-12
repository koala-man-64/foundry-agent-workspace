using System.Globalization;
using Foundry.Platform;
using Foundry.Protocol;

namespace Foundry.Runtime;

public static class ScheduleClock
{
    private static DateTimeOffset Parse(string text) => DateTimeOffset.Parse(text, CultureInfo.InvariantCulture);
    private static string LocalStamp(IcuTimeZone zone, DateTimeOffset instant) => Clock.Iso(DateTimeOffset.FromUnixTimeMilliseconds(instant.ToUnixTimeMilliseconds() + zone.OffsetMilliseconds(instant)))[..16];
    private static string LocalStartDay(IcuTimeZone zone, long instant)
    {
        var iso = Clock.Iso(instant + zone.OffsetMilliseconds(instant));
        // Intl's numeric year has no padding or era in the TS schedule helper.
        var yearLength = iso[0] is '+' or '-' ? 7 : 4;
        var year = int.Parse(iso.AsSpan(0, yearLength), CultureInfo.InvariantCulture);
        return string.Concat((year <= 0 ? 1 - year : year).ToString(CultureInfo.InvariantCulture), iso.AsSpan(yearLength, 6));
    }
    public static DateTimeOffset Resolve(string date, string time, string timeZone)
    {
        using var zone = new IcuTimeZone(Contracts.TimeZoneName(timeZone));
        var wall = date + "T" + time; var nominal = Parse(wall + ":00Z");
        var offsets = new HashSet<long>();
        for (var hours = -36; hours <= 36; hours += 6)
        {
            var sample = nominal.AddHours(hours);
            offsets.Add((long)(Parse(LocalStamp(zone, sample) + ":00Z") - sample).TotalMilliseconds);
        }
        var candidates = offsets.Select(offset => nominal.AddMilliseconds(-offset)).Order().ToArray();
        foreach (var candidate in candidates) if (LocalStamp(zone, candidate) == wall) return candidate;
        var low = candidates[0].ToUnixTimeMilliseconds() / 60000; var high = candidates[^1].ToUnixTimeMilliseconds() / 60000;
        if (StringComparer.Ordinal.Compare(LocalStamp(zone, DateTimeOffset.FromUnixTimeMilliseconds(low * 60000)), wall) >= 0
            || StringComparer.Ordinal.Compare(LocalStamp(zone, DateTimeOffset.FromUnixTimeMilliseconds(high * 60000)), wall) < 0) throw new InvalidOperationException("Could not resolve schedule wall-clock time.");
        while (low + 1 < high)
        {
            var middle = (long)Math.Floor((low + high) / 2d);
            if (StringComparer.Ordinal.Compare(LocalStamp(zone, DateTimeOffset.FromUnixTimeMilliseconds(middle * 60000)), wall) < 0) low = middle; else high = middle;
        }
        return DateTimeOffset.FromUnixTimeMilliseconds(high * 60000);
    }

    public static Dictionary<string, object?>? Due(Dictionary<string, object?> schedule, DateTimeOffset now)
    {
        var start = Clock.Epoch((string)schedule["startAt"]!);
        if (now.ToUnixTimeMilliseconds() < start) return null;
        var timeZone = (string)schedule["timeZone"]!; using var zone = new IcuTimeZone(Contracts.TimeZoneName(timeZone));
        var startDay = (string?)schedule.GetValueOrDefault("startDate") ?? LocalStartDay(zone, start);
        var cadence = (string)schedule["cadence"]!; var time = (string)schedule["localTime"]!;
        var candidate = DateOnly.ParseExact(cadence == "once" ? startDay : LocalStamp(zone, now)[..10], "yyyy-MM-dd", CultureInfo.InvariantCulture);
        if (cadence == "weekly") while ((int)candidate.DayOfWeek != (double)schedule["weekDay"]!) candidate = candidate.AddDays(-1);
        var date = candidate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture); var due = Resolve(date, time, timeZone);
        if (cadence != "once" && due > now) { candidate = candidate.AddDays(cadence == "weekly" ? -7 : -1); date = candidate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture); due = Resolve(date, time, timeZone); }
        return StringComparer.Ordinal.Compare(date, startDay) >= 0 && due.ToUnixTimeMilliseconds() >= start && due <= now ? new() { ["localDate"] = date, ["dueAt"] = Clock.Iso(due) } : null;
    }
}
