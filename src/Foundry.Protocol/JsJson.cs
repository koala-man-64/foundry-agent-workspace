using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Foundry.Protocol;

/// <summary>Explicit absence is different from JSON null, including in hash inputs.</summary>
public sealed class Undefined
{
    private Undefined() { }
    public static Undefined Value { get; } = new();
}

public static class JsJson
{
    // ECMAScript WhiteSpace and LineTerminator: what String.prototype.trim and Number() remove.
    private static readonly char[] Whitespace = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff".ToCharArray();
    public static string Trim(string value) => value.Trim(Whitespace);
    public static string TrimStart(string value) => value.TrimStart(Whitespace);
    private static readonly JsonSerializerOptions RecordOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    public static string? Stringify(object? value)
    {
        if (value is Undefined) return null;
        var output = new StringBuilder();
        Write(output, value);
        return output.ToString();
    }

    public static object? FromElement(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Null => null,
        JsonValueKind.Undefined => Undefined.Value,
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.String => value.GetString(),
        JsonValueKind.Number => value.GetDouble(),
        JsonValueKind.Array => value.EnumerateArray().Select(FromElement).ToList(),
        JsonValueKind.Object => value.EnumerateObject().ToDictionary(p => p.Name, p => FromElement(p.Value), StringComparer.Ordinal),
        _ => throw new JsonException("Unsupported JSON value.")
    };

    private static void Write(StringBuilder output, object? value)
    {
        switch (value)
        {
            case IWireModel model: Write(output, model.ToWire()); break;
            case null or Undefined: output.Append("null"); break;
            case bool boolean: output.Append(boolean ? "true" : "false"); break;
            case string text: Quote(output, text); break;
            case double number: output.Append(Number(number)); break;
            case byte or sbyte or short or ushort or int or uint or long or ulong or float or decimal:
                output.Append(Number(Convert.ToDouble(value, CultureInfo.InvariantCulture))); break;
            case WireNumber number: output.Append(Number(number.Value)); break;
            case JsonElement element: Write(output, FromElement(element)); break;
            case IDictionary<string, object?> properties:
                output.Append('{');
                var first = true;
                foreach (var property in properties.OrderBy(p => ArrayIndex(p.Key) is null ? 1 : 0).ThenBy(p => ArrayIndex(p.Key) ?? 0))
                {
                    if (property.Value is Undefined) continue;
                    if (!first) output.Append(',');
                    first = false;
                    Quote(output, property.Key); output.Append(':'); Write(output, property.Value);
                }
                output.Append('}'); break;
            case System.Collections.IDictionary dictionary:
                var values = new Dictionary<string, object?>();
                foreach (System.Collections.DictionaryEntry entry in dictionary) values.Add((string)entry.Key, entry.Value);
                Write(output, values); break;
            case System.Collections.IEnumerable items:
                output.Append('['); first = true;
                foreach (var item in items) { if (!first) output.Append(','); first = false; Write(output, item); }
                output.Append(']'); break;
            default:
                // Visit properties directly: a .NET serialization roundtrip would replace
                // retained lone UTF-16 units and impose its unrelated document-depth limit.
                var record = value.GetType().GetProperties(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public)
                    .Where(property => property.CanRead && property.GetIndexParameters().Length == 0)
                    .ToDictionary(property => RecordOptions.PropertyNamingPolicy!.ConvertName(property.Name), property => property.GetValue(value), StringComparer.Ordinal);
                Write(output, record);
                break;
        }
    }

    private static uint? ArrayIndex(string key) => uint.TryParse(key, NumberStyles.None, CultureInfo.InvariantCulture, out var index)
        && index != uint.MaxValue && index.ToString(CultureInfo.InvariantCulture) == key ? index : null;

    private static string Number(double value)
    {
        if (!double.IsFinite(value)) return "null";
        if (value == 0) return "0";
        var text = value.ToString("R", CultureInfo.InvariantCulture).ToLowerInvariant();
        var parts = text.Split('e');
        if (parts.Length == 1) return text;
        var exponent = int.Parse(parts[1], CultureInfo.InvariantCulture);
        if (exponent < -6 || exponent >= 21) return parts[0] + "e" + (exponent >= 0 ? "+" : "-") + Math.Abs(exponent).ToString(CultureInfo.InvariantCulture);
        var negative = parts[0].StartsWith('-');
        var digits = parts[0].TrimStart('-').Replace(".", "", StringComparison.Ordinal);
        var point = 1 + exponent;
        var expanded = point <= 0 ? "0." + new string('0', -point) + digits
            : point >= digits.Length ? digits + new string('0', point - digits.Length)
            : digits.Insert(point, ".");
        return (negative ? "-" : "") + expanded;
    }

    private static void Quote(StringBuilder output, string value)
    {
        output.Append('"');
        for (var index = 0; index < value.Length; index++)
        {
            var c = value[index];
            switch (c)
            {
                case '"': output.Append("\\\""); break;
                case '\\': output.Append("\\\\"); break;
                case '\b': output.Append("\\b"); break;
                case '\f': output.Append("\\f"); break;
                case '\n': output.Append("\\n"); break;
                case '\r': output.Append("\\r"); break;
                case '\t': output.Append("\\t"); break;
                default:
                    if (c < 32 || char.IsSurrogate(c) && !(char.IsHighSurrogate(c) && index + 1 < value.Length && char.IsLowSurrogate(value[index + 1]))
                        && !(char.IsLowSurrogate(c) && index > 0 && char.IsHighSurrogate(value[index - 1])))
                        output.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else output.Append(c);
                    break;
            }
        }
        output.Append('"');
    }
}

public static class Clock
{
    public static string Iso(DateTimeOffset instant) => instant.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
    public static string Iso(long epochMilliseconds) => EcmaIso.Format(epochMilliseconds);
    // Input syntax is validated by the frozen protocol before use.
    public static long Epoch(string validatedIsoTimestamp) => EcmaIso.Epoch(validatedIsoTimestamp);
}
