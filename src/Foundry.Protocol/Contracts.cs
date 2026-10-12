using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Foundry.Protocol;

/// <summary>The frozen contract grammar. Its metadata is checked against the TypeScript authority.</summary>
public static class Contracts
{
    private static readonly JsonElement Rules = Load();
    private static readonly Dictionary<string, string> TimeZoneNames = LoadTimeZones();
    private static string FoldAscii(string value) => new(value.Select(c => c is >= 'A' and <= 'Z' ? (char)(c + 32) : c).ToArray());
    private static Dictionary<string, string> LoadTimeZones()
    {
        using var stream = typeof(Contracts).Assembly.GetManifestResourceStream("Foundry.Protocol.TimeZoneNames.txt")!;
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd().Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToDictionary(FoldAscii, name => name, StringComparer.Ordinal);
    }
    public static string TimeZoneName(string name)
    {
        if (TimeZoneNames.TryGetValue(FoldAscii(name), out var canonical)) return canonical;
        if (Regex.IsMatch(name, "^[+-](?:[01][0-9]|2[0-3])(?::?[0-5][0-9])?$", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1))) return name;
        throw new ArgumentException("Invalid time zone specified: " + name, nameof(name));
    }
    public static IReadOnlyList<string> Names { get; } = Rules.EnumerateObject().Select(p => p.Name).ToArray();

    private static JsonElement Load()
    {
        using var stream = typeof(Contracts).Assembly.GetManifestResourceStream("Foundry.Protocol.Contracts.json")
            ?? throw new InvalidOperationException("Missing protocol contracts.");
        using var document = JsonDocument.Parse(stream);
        return document.RootElement.Clone();
    }

    public static object? Validate(string name, object? value)
    {
        if (value is IWireModel model) value = WireJson.Parse(JsJson.Stringify(model)!);
        if (!Rules.TryGetProperty(name, out var rule)) throw Invalid();
        return Apply(rule, value);
    }

    private static JsonException Invalid() => new("Invalid request.");
    private static bool Has(JsonElement rule, string name) => rule.TryGetProperty(name, out _);
    private static object? Apply(JsonElement rule, object? value)
    {
        var type = rule.GetProperty("type").GetString();
        switch (type)
        {
            case "unknown": return value;
            case "optional" when value is Undefined: return value;
            case "optional": return Apply(rule.GetProperty("innerType"), value);
            case "nullable" when value is null: return null;
            case "nullable": return Apply(rule.GetProperty("innerType"), value);
            case "default" when value is Undefined: return JsJson.FromElement(rule.GetProperty("defaultValue"));
            case "default": return Apply(rule.GetProperty("innerType"), value);
            case "prefault": return Apply(rule.GetProperty("innerType"), value is Undefined ? JsJson.FromElement(rule.GetProperty("defaultValue")) : value);
            case "pipe": return Apply(rule.GetProperty("out"), Apply(rule.GetProperty("in"), value));
            case "transform": return Transform(rule.GetProperty("transform").GetString()!, value);
            case "union":
                foreach (var option in rule.GetProperty("options").EnumerateArray())
                    try { return Apply(option, value); } catch (JsonException) { }
                throw Invalid();
            case "null": if (value is not null) throw Invalid(); break;
            case "boolean": if (value is not bool) throw Invalid(); break;
            case "string": if (value is not string) throw Invalid(); break;
            case "number":
                if (value is WireNumber wire)
                {
                    if (rule.TryGetProperty("checks", out var numericChecks) && numericChecks.EnumerateArray().Any(c => c.GetProperty("check").GetString() == "number_format")
                        && !Regex.IsMatch(wire.Raw, "^(0|-[1-9][0-9]*|[1-9][0-9]*)$", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1))) throw Invalid();
                    value = wire.Value;
                }
                if (value is not double number || !double.IsFinite(number)) throw Invalid();
                break;
            case "enum": case "literal":
                if (!rule.GetProperty("values").EnumerateArray().Any(v => Equals(JsJson.FromElement(v), value))) throw Invalid();
                break;
            case "array":
                if (value is not List<object?> array) throw Invalid();
                value = array.Select(item => Apply(rule.GetProperty("element"), item)).ToList();
                break;
            case "object":
                if (value is not Dictionary<string, object?> input) throw Invalid();
                var shape = rule.GetProperty("shape");
                if (rule.GetProperty("strict").GetBoolean() && input.Keys.Any(key => !Has(shape, key))) throw Invalid();
                var output = new Dictionary<string, object?>(StringComparer.Ordinal);
                foreach (var property in shape.EnumerateObject())
                {
                    var present = input.TryGetValue(property.Name, out var item);
                    if (!present && property.Value.GetProperty("type").GetString() == "unknown") throw Invalid();
                    var normalized = Apply(property.Value, present ? item : Undefined.Value);
                    if (normalized is not Undefined || present) output.Add(property.Name, normalized);
                }
                value = output;
                break;
            case "record":
                if (value is not Dictionary<string, object?> record) throw Invalid();
                value = record.ToDictionary(p => (string)Apply(rule.GetProperty("keyType"), p.Key)!, p => Apply(rule.GetProperty("valueType"), p.Value), StringComparer.Ordinal);
                break;
            default: throw new InvalidOperationException("Unimplemented contract grammar: " + type);
        }
        if (rule.TryGetProperty("checks", out var checks))
            foreach (var check in checks.EnumerateArray()) value = Check(check, value);
        return value;
    }

    private static object? Check(JsonElement check, object? value)
    {
        var kind = check.GetProperty("check").GetString();
        var length = value is string text ? text.Length : value is List<object?> array ? array.Count : 0;
        switch (kind)
        {
            case "overwrite": return Transform(check.GetProperty("tx").GetString()!, value);
            case "min_length": if (length < check.GetProperty("minimum").GetInt32()) throw Invalid(); break;
            case "max_length": if (length > check.GetProperty("maximum").GetInt32()) throw Invalid(); break;
            case "greater_than":
                var minimum = check.GetProperty("value").GetDouble();
                if ((double)value! < minimum || !check.GetProperty("inclusive").GetBoolean() && (double)value! == minimum) throw Invalid();
                break;
            case "less_than":
                var maximum = check.GetProperty("value").GetDouble();
                if ((double)value! > maximum || !check.GetProperty("inclusive").GetBoolean() && (double)value! == maximum) throw Invalid();
                break;
            case "number_format":
                var number = (double)value!;
                if (Math.Truncate(number) != number || Math.Abs(number) > 9007199254740991d) throw Invalid();
                break;
            case "string_format":
                if (check.TryGetProperty("pattern", out var pattern) && !Regex.IsMatch((string)value!, pattern.GetString()!, RegexOptions.ECMAScript | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1))) throw Invalid();
                break;
            case "custom": if (!Refine(check.GetProperty("fn").GetString()!, value)) throw Invalid(); break;
            default: throw new InvalidOperationException("Unimplemented contract check: " + kind);
        }
        return value;
    }

    private static string Transform(string operation, object? value) => operation switch
    {
        "trim" => JsJson.Trim((string)value!),
        "iso" => EcmaIso.Normalize((string)value!),
        _ => throw new InvalidOperationException("Unimplemented contract transform: " + operation)
    };

    private static bool Refine(string operation, object? value)
    {
        var fields = value as Dictionary<string, object?>;
        switch (operation)
        {
            case "channel-bytes": return Encoding.UTF8.GetByteCount((string)value!) <= 2048;
            case "calendar-date": return EcmaIso.IsDate((string)value!);
            case "http-url": return EcmaUrl.TryParse((string)value!, out var uri) && !uri!.HasCredentials;
            case "time-zone":
                var zone = (string)fields!["timeZone"]!;
                // Frozen Node 24/ICU 78 namespace, including IANA links. Windows registry
                // names and Unicode lookalikes must never acquire acceptance via .NET.
                return TimeZoneNames.ContainsKey(FoldAscii(zone))
                    || Regex.IsMatch(zone, "^[+-](?:[01][0-9]|2[0-3])(?::?[0-5][0-9])?$", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
            case "date-range":
                return !fields!.TryGetValue("from", out var from) || from is Undefined || !fields.TryGetValue("to", out var to) || to is Undefined
                    || EcmaIso.Epoch((string)from!) < EcmaIso.Epoch((string)to!);
            case "reply-exclusive": return fields!.TryGetValue("result", out var result) && result is not Undefined ^ fields.TryGetValue("error", out var error) && error is not Undefined;
            case "effort":
                if (!fields!.TryGetValue("effort", out var effort) || effort is Undefined) return true;
                return (string)fields["apiKind"]! switch
                {
                    "responses" => true,
                    "chat-completions" => !Equals(effort, "max"),
                    "anthropic" => new[] { "low", "medium", "high", "xhigh", "max" }.Contains(effort),
                    _ => false
                };
            default: throw new InvalidOperationException("Unimplemented contract refinement: " + operation);
        }
    }

}
