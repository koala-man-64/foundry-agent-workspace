using System.Globalization;

namespace Foundry.Protocol;

// Zod has already checked the timestamp syntax and calendar date. JavaScript
// permits year zero and offsets up to 23:59; DateTimeOffset cannot represent
// that contract. Integer Gregorian arithmetic also preserves millisecond
// truncation and ISO expanded years when an offset crosses a year boundary.
internal static class EcmaIso
{
    private const long Day = 86_400_000;
    private static long Floor(long value, long divisor) => value >= 0 ? value / divisor : (value - divisor + 1) / divisor;
    private static int Number(ReadOnlySpan<char> text) => int.Parse(text, NumberStyles.None, CultureInfo.InvariantCulture);
    private static long Days(int year, int month, int day)
    {
        year -= month <= 2 ? 1 : 0;
        var era = Floor(year, 400); var within = year - era * 400;
        var ordinal = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1;
        return era * 146097 + within * 365 + within / 4 - within / 100 + ordinal - 719468;
    }
    public static bool IsDate(string text)
    {
        if (text.Length != 10 || text[4] != '-' || text[7] != '-') return false;
        if (!int.TryParse(text.AsSpan(0, 4), NumberStyles.None, CultureInfo.InvariantCulture, out var year)
            || !int.TryParse(text.AsSpan(5, 2), NumberStyles.None, CultureInfo.InvariantCulture, out var month)
            || !int.TryParse(text.AsSpan(8, 2), NumberStyles.None, CultureInfo.InvariantCulture, out var day) || month is < 1 or > 12) return false;
        var maximum = month == 2 ? (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) ? 29 : 28) : month is 4 or 6 or 9 or 11 ? 30 : 31;
        return day >= 1 && day <= maximum;
    }
    public static long Epoch(string text)
    {
        var signed = text[0] is '+' or '-'; var yearLength = signed ? 7 : 4;
        var year = signed ? Number(text.AsSpan(1, 6)) * (text[0] == '-' ? -1 : 1) : Number(text.AsSpan(0, 4));
        var month = Number(text.AsSpan(yearLength + 1, 2)); var day = Number(text.AsSpan(yearLength + 4, 2));
        var hour = Number(text.AsSpan(yearLength + 7, 2)); var minute = Number(text.AsSpan(yearLength + 10, 2)); var second = Number(text.AsSpan(yearLength + 13, 2));
        var end = text[^1] == 'Z' ? text.Length - 1 : text.Length - 6;
        var fractionStart = yearLength + 15;
        var milliseconds = fractionStart < end && text[fractionStart] == '.' ? Number(text[(fractionStart + 1)..end].PadRight(3, '0').AsSpan(0, 3)) : 0;
        var offset = text[^1] == 'Z' ? 0 : (Number(text.AsSpan(end + 1, 2)) * 60 + Number(text.AsSpan(end + 4, 2))) * (text[end] == '+' ? 1 : -1);
        return Days(year, month, day) * Day + ((hour * 60L + minute - offset) * 60 + second) * 1000 + milliseconds;
    }
    public static string Normalize(string text)
    {
        var epoch = Epoch(text); var days = Floor(epoch, Day); var time = epoch - days * Day;
        var shifted = days + 719468; var era = Floor(shifted, 146097); var dayOfEra = shifted - era * 146097;
        var yearOfEra = (dayOfEra - dayOfEra / 1460 + dayOfEra / 36524 - dayOfEra / 146096) / 365;
        var year = yearOfEra + era * 400; var dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100);
        var monthPrime = (5 * dayOfYear + 2) / 153; var day = dayOfYear - (153 * monthPrime + 2) / 5 + 1;
        var month = monthPrime + (monthPrime < 10 ? 3 : -9); year += month <= 2 ? 1 : 0;
        var yearText = year is >= 0 and <= 9999 ? year.ToString("D4", CultureInfo.InvariantCulture) : (year < 0 ? "-" : "+") + Math.Abs(year).ToString("D6", CultureInfo.InvariantCulture);
        return string.Create(CultureInfo.InvariantCulture, $"{yearText}-{month:D2}-{day:D2}T{time / 3600000:D2}:{time / 60000 % 60:D2}:{time / 1000 % 60:D2}.{time % 1000:D3}Z");
    }
}
