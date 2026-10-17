using System.Globalization;
using System.Text;
using System.Text.Json;
using Foundry.Protocol;

namespace Foundry.Runtime;

/// <summary>A tool call's arguments failed their schema. The message is zod's issue list, the text TypeScript returns to the model.</summary>
internal sealed class ToolArgumentException(string message) : InvalidOperationException(message);

/// <summary>
/// tool-definitions.ts: the six repository tools a coding turn advertises, as z.toJSONSchema writes them (draft-7), and
/// the argument schemas that bind each call. <see cref="Parse"/> reproduces zod 4.6.5 for exactly these schemas: the
/// parsed value in shape order with defaults applied, or a <see cref="ToolArgumentException"/> whose message is
/// JSON.stringify(issues, null, 2) in zod's English locale. String lengths count code points once a string exceeds a
/// limit in UTF-16 units, as zod does; patterns are matched as JavaScript matches them, so "$" never accepts a trailing
/// line feed.
/// </summary>
internal static partial class ToolDefinitions
{
    private const string Source = """
        [
          {
            "name": "list_directory",
            "description": "List a relative directory in the task worktree. The root path is an empty string. Secret files and Git metadata are unavailable.",
            "inputSchema": {
              "$schema": "http://json-schema.org/draft-07/schema#",
              "type": "object",
              "properties": {
                "path": {
                  "default": "",
                  "type": "string",
                  "maxLength": 4096
                }
              },
              "required": [
                "path"
              ],
              "additionalProperties": false
            }
          },
          {
            "name": "read_file",
            "description": "Read a UTF-8 file and its SHA-256 content hash. Paths must be relative to the task worktree.",
            "inputSchema": {
              "$schema": "http://json-schema.org/draft-07/schema#",
              "type": "object",
              "properties": {
                "path": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 4096
                }
              },
              "required": [
                "path"
              ],
              "additionalProperties": false
            }
          },
          {
            "name": "search_text",
            "description": "Find literal text in accessible worktree files. Results are bounded and report skipped content.",
            "inputSchema": {
              "$schema": "http://json-schema.org/draft-07/schema#",
              "type": "object",
              "properties": {
                "query": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 2000
                },
                "path": {
                  "default": "",
                  "type": "string",
                  "maxLength": 4096
                }
              },
              "required": [
                "query",
                "path"
              ],
              "additionalProperties": false
            }
          },
          {
            "name": "write_file",
            "description": "Propose full replacement of an existing file using its exact SHA-256 hash. New-file creation is unavailable through this tool. The user must review and approve the full change.",
            "inputSchema": {
              "$schema": "http://json-schema.org/draft-07/schema#",
              "type": "object",
              "properties": {
                "path": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 4096
                },
                "expectedHash": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "content": {
                  "type": "string",
                  "maxLength": 65536
                }
              },
              "required": [
                "path",
                "expectedHash",
                "content"
              ],
              "additionalProperties": false
            }
          },
          {
            "name": "replace_text",
            "description": "Propose exactly one literal replacement in a file with the expected SHA-256 hash. The match must be unique. The user reviews and approves the change.",
            "inputSchema": {
              "$schema": "http://json-schema.org/draft-07/schema#",
              "type": "object",
              "properties": {
                "path": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 4096
                },
                "expectedHash": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "oldText": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 65536
                },
                "newText": {
                  "type": "string",
                  "maxLength": 65536
                }
              },
              "required": [
                "path",
                "expectedHash",
                "oldText",
                "newText"
              ],
              "additionalProperties": false
            }
          },
          {
            "name": "run_command",
            "description": "Propose a non-interactive PowerShell command in a relative directory. The user must approve the exact command, directory, shell, environment and timeout. Approval is not sandboxing.",
            "inputSchema": {
              "$schema": "http://json-schema.org/draft-07/schema#",
              "type": "object",
              "properties": {
                "command": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 16384
                },
                "cwd": {
                  "default": "",
                  "type": "string",
                  "maxLength": 4096
                },
                "environment": {
                  "default": {},
                  "type": "object",
                  "propertyNames": {
                    "type": "string",
                    "pattern": "^[A-Za-z_][A-Za-z0-9_]*$"
                  },
                  "additionalProperties": {
                    "type": "string",
                    "maxLength": 4096
                  }
                },
                "timeoutMs": {
                  "default": 600000,
                  "type": "integer",
                  "minimum": 100,
                  "maximum": 600000
                }
              },
              "required": [
                "command",
                "cwd",
                "environment",
                "timeoutMs"
              ],
              "additionalProperties": false
            }
          }
        ]
        """;

    private const string HashPattern = "/^[a-f0-9]{64}$/";
    private const string KeyPattern = "/^[A-Za-z_][A-Za-z0-9_]*$/";
    private const double MaximumSafeInteger = 9_007_199_254_740_991;

    /// <summary>TOOL_DEFINITIONS, in advertised order.</summary>
    internal static IReadOnlyList<Dictionary<string, object?>> All { get; } = Load();

    internal static bool IsTool(string name) => Shape(name) is not null;

    /// <summary>ToolArguments[name].parse(input).</summary>
    internal static Dictionary<string, object?> Parse(string name, object? input)
    {
        var shape = Shape(name) ?? throw new ArgumentOutOfRangeException(nameof(name));
        var issues = new List<Dictionary<string, object?>>();
        if (input is not Dictionary<string, object?> fields) throw Failure([Type("object", input, [])]);
        var output = new Dictionary<string, object?>();
        foreach (var (key, field) in shape)
        {
            var parsed = field(fields.TryGetValue(key, out var value) ? value : Undefined.Value, [key], issues);
            if (parsed is not null) output[key] = parsed;
        }
        var unknown = JavaScriptKeys(fields).Where(key => !shape.Any(field => field.Key == key)).ToList();
        if (unknown.Count > 0)
            issues.Add(new()
            {
                ["code"] = "unrecognized_keys", ["keys"] = unknown.Cast<object?>().ToList(), ["path"] = new List<object?>(),
                // zod's joinValues quotes each key without escaping it.
                ["message"] = $"Unrecognized key{(unknown.Count > 1 ? "s" : "")}: {string.Join(", ", unknown.Select(key => $"\"{key}\""))}",
            });
        if (issues.Count > 0) throw Failure(issues);
        return output;
    }

    private delegate object? Field(object? value, List<object?> path, List<Dictionary<string, object?>> issues);

    private static List<KeyValuePair<string, Field>>? Shape(string name)
    {
        Field relativePath = (value, path, issues) => Text(value, path, issues, 1, 4096);
        Field hash = (value, path, issues) => Text(value, path, issues, null, null, (HashPattern, IsHash));
        Field optionalPath = (value, path, issues) => value is Undefined ? "" : Text(value, path, issues, null, 4096);
        return name switch
        {
            "list_directory" => [new("path", optionalPath)],
            "read_file" => [new("path", relativePath)],
            "search_text" => [new("query", (value, path, issues) => Text(value, path, issues, 1, 2000)), new("path", optionalPath)],
            "write_file" => [new("path", relativePath), new("expectedHash", hash), new("content", (value, path, issues) => Text(value, path, issues, null, 65536))],
            "replace_text" =>
            [
                new("path", relativePath), new("expectedHash", hash), new("oldText", (value, path, issues) => Text(value, path, issues, 1, 65536)),
                new("newText", (value, path, issues) => Text(value, path, issues, null, 65536)),
            ],
            "run_command" =>
            [
                new("command", (value, path, issues) => Text(value, path, issues, 1, 16384)), new("cwd", optionalPath), new("environment", (value, path, issues) => Environment(value, path, issues)),
                new("timeoutMs", (value, path, issues) => Timeout(value, path, issues)),
            ],
            _ => null,
        };
    }

    /// <summary>z.string() with its min, max and regex checks, in that order; every failing check is reported.</summary>
    private static string? Text(object? value, List<object?> path, List<Dictionary<string, object?>> issues, int? minimum, int? maximum, (string Source, Func<string, bool> Test)? pattern = null)
    {
        if (value is not string text)
        {
            issues.Add(Type("string", value, path));
            // zod's length checks guard themselves with `when` (any value with a length), so they run after the type issue
            // too, comparing that length as JavaScript compares it with a number.
            var length = value switch
            {
                List<object?> items => items.Count,
                Dictionary<string, object?> map when map.TryGetValue("length", out var raw) => ToNumber(raw),
                _ => (double?)null,
            };
            if (length is double units)
            {
                var origin = value is List<object?> ? "array" : "unknown";
                string Bound(string relation, int limit) => origin == "array" ? $"expected array to have {relation}{limit} items" : $"expected unknown to be {relation}{limit}";
                if (minimum is int least && !(units >= least)) issues.Add(Size("too_small", origin, "minimum", least, path, $"Too small: {Bound(">=", least)}"));
                if (maximum is int most && !(units <= most)) issues.Add(Size("too_big", origin, "maximum", most, path, $"Too big: {Bound("<=", most)}"));
            }
            return null;
        }
        if (minimum is int floor)
        {
            var length = text.Length >= floor && text.Length < floor * 2 ? CodePoints(text) : text.Length;
            if (length < floor) issues.Add(Size("too_small", "string", "minimum", floor, path, $"Too small: expected string to have >={floor} characters"));
        }
        if (maximum is int ceiling)
        {
            var length = text.Length > ceiling ? CodePoints(text) : text.Length;
            if (length > ceiling) issues.Add(Size("too_big", "string", "maximum", ceiling, path, $"Too big: expected string to have <={ceiling} characters"));
        }
        if (pattern is { } rule && !rule.Test(text))
            issues.Add(new() { ["origin"] = "string", ["code"] = "invalid_format", ["format"] = "regex", ["pattern"] = rule.Source, ["path"] = path, ["message"] = $"Invalid string: must match pattern {rule.Source}" });
        return text;
    }

    /// <summary>z.record(key regex, z.string().max(4096)).default({}). A key that fails is reported and its value not checked.
    /// zod passes over a "__proto__" key entirely: it is neither checked nor kept.</summary>
    private static Dictionary<string, object?>? Environment(object? value, List<object?> path, List<Dictionary<string, object?>> issues)
    {
        if (value is Undefined) return new Dictionary<string, object?>();
        if (value is not Dictionary<string, object?> entries) { issues.Add(Type("record", value, path)); return null; }
        var output = new Dictionary<string, object?>();
        foreach (var key in JavaScriptKeys(entries))
        {
            if (key == "__proto__") continue;
            List<object?> entryPath = [.. path, key];
            if (!IsKey(key))
            {
                var nested = new Dictionary<string, object?>
                {
                    ["origin"] = "string", ["code"] = "invalid_format", ["format"] = "regex", ["pattern"] = KeyPattern, ["path"] = new List<object?>(),
                    ["message"] = $"Invalid string: must match pattern {KeyPattern}",
                };
                issues.Add(new() { ["code"] = "invalid_key", ["origin"] = "record", ["issues"] = new List<object?> { nested }, ["path"] = entryPath, ["message"] = "Invalid key in record" });
                continue;
            }
            if (Text(entries[key], entryPath, issues, null, 4096) is string text) output[key] = text;
        }
        return output;
    }

    /// <summary>z.number().int().min(100).max(600000).default(600000). A fraction stops at the int check; an integer outside
    /// the safe range is reported, and the range checks still run.</summary>
    private static double? Timeout(object? value, List<object?> path, List<Dictionary<string, object?>> issues)
    {
        if (value is Undefined) return 600000;
        if (value is not double number || double.IsNaN(number)) { issues.Add(Type("number", value, path)); return null; }
        if (double.IsInfinity(number) || Math.Floor(number) != number)
        {
            issues.Add(new() { ["expected"] = "int", ["format"] = "safeint", ["code"] = "invalid_type", ["path"] = path, ["message"] = "Invalid input: expected int, received number" });
            return null;
        }
        const string note = "Integers must be within the safe integer range.";
        if (number > MaximumSafeInteger)
            issues.Add(new() { ["code"] = "too_big", ["maximum"] = MaximumSafeInteger, ["note"] = note, ["origin"] = "int", ["inclusive"] = true, ["path"] = path, ["message"] = "Too big: expected int to be <=9007199254740991" });
        else if (number < -MaximumSafeInteger)
            issues.Add(new() { ["code"] = "too_small", ["minimum"] = -MaximumSafeInteger, ["note"] = note, ["origin"] = "int", ["inclusive"] = true, ["path"] = path, ["message"] = "Too small: expected int to be >=-9007199254740991" });
        if (number < 100) issues.Add(Size("too_small", "number", "minimum", 100, path, "Too small: expected number to be >=100"));
        if (number > 600000) issues.Add(Size("too_big", "number", "maximum", 600000, path, "Too big: expected number to be <=600000"));
        return number;
    }

    private static Dictionary<string, object?> Type(string expected, object? value, List<object?> path) =>
        new() { ["expected"] = expected, ["code"] = "invalid_type", ["path"] = path, ["message"] = $"Invalid input: expected {expected}, received {Received(value)}" };

    private static Dictionary<string, object?> Size(string code, string origin, string bound, double limit, List<object?> path, string message) =>
        new() { ["origin"] = origin, ["code"] = code, [bound] = limit, ["inclusive"] = true, ["path"] = path, ["message"] = message };

    /// <summary>zod's parsedType for a JSON value.</summary>
    private static string Received(object? value) => value switch
    {
        Undefined => "undefined",
        null => "null",
        bool => "boolean",
        double number => double.IsNaN(number) ? "NaN" : "number",
        string => "string",
        List<object?> => "array",
        _ => "object",
    };

    /// <summary>JavaScript's ToNumber for a JSON value: an array through its comma join, an object as NaN.</summary>
    private static double ToNumber(object? value) => value switch
    {
        null => 0,
        bool flag => flag ? 1 : 0,
        double number => number,
        string text => StringToNumber(text),
        List<object?> items => StringToNumber(Join(items)),
        _ => double.NaN,
    };

    private static string Join(List<object?> items) => string.Join(",", items.Select(item => item switch
    {
        null => "",
        string text => text,
        bool flag => flag ? "true" : "false",
        double number => JsJson.Stringify(number)!,
        List<object?> nested => Join(nested),
        _ => "[object Object]",
    }));

    /// <summary>StringToNumber: trimmed; empty is zero; a 0x, 0o or 0b integer; Infinity with an optional sign; or a decimal
    /// literal. Anything else is NaN.</summary>
    private static double StringToNumber(string value)
    {
        var text = JsJson.Trim(value);
        if (text.Length == 0) return 0;
        if (text.Length > 2 && text[0] == '0' && char.ToLowerInvariant(text[1]) is 'x' or 'o' or 'b')
        {
            var radix = char.ToLowerInvariant(text[1]) switch { 'x' => 16, 'o' => 8, _ => 2 };
            var total = System.Numerics.BigInteger.Zero;
            foreach (var character in text.AsSpan(2))
            {
                var digit = char.IsAsciiDigit(character) ? character - '0' : char.IsAsciiLetter(character) ? char.ToLowerInvariant(character) - 'a' + 10 : 99;
                if (digit >= radix) return double.NaN;
                total = total * radix + digit;
            }
            return (double)total;
        }
        if ((text[0] is '+' or '-' ? text[1..] : text) == "Infinity") return text[0] == '-' ? double.NegativeInfinity : double.PositiveInfinity;
        return DecimalLiteral().IsMatch(text) ? double.Parse(text, NumberStyles.Float, CultureInfo.InvariantCulture) : double.NaN;
    }

    [System.Text.RegularExpressions.GeneratedRegex(@"\A[+-]?(?:[0-9]+\.?[0-9]*(?:[eE][+-]?[0-9]+)?|\.[0-9]+(?:[eE][+-]?[0-9]+)?)\z", System.Text.RegularExpressions.RegexOptions.CultureInvariant)]
    private static partial System.Text.RegularExpressions.Regex DecimalLiteral();

    /// <summary>util.codePointLength: UTF-16 units, less one for each high surrogate followed by a low one.</summary>
    private static int CodePoints(string text)
    {
        var count = text.Length;
        for (var index = 0; index < text.Length - 1; index++)
            if (char.IsHighSurrogate(text[index]) && char.IsLowSurrogate(text[index + 1])) { count--; index++; }
        return count;
    }

    private static bool IsHash(string text) => text.Length == 64 && text.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static bool IsKey(string text) =>
        text.Length > 0 && (char.IsAsciiLetter(text[0]) || text[0] == '_') && text.All(character => char.IsAsciiLetterOrDigit(character) || character == '_');

    /// <summary>A JavaScript object's own string keys: array indices in ascending order, then the rest as inserted.</summary>
    private static IEnumerable<string> JavaScriptKeys(Dictionary<string, object?> value) =>
        value.Keys.Select((key, index) => (Key: key, Index: ArrayIndex(key), Order: index)).OrderBy(entry => entry.Index is null ? 1 : 0).ThenBy(entry => entry.Index ?? 0).ThenBy(entry => entry.Order).Select(entry => entry.Key);

    private static uint? ArrayIndex(string key) =>
        uint.TryParse(key, NumberStyles.None, CultureInfo.InvariantCulture, out var index) && index != uint.MaxValue && index.ToString(CultureInfo.InvariantCulture) == key ? index : null;

    private static ToolArgumentException Failure(List<Dictionary<string, object?>> issues)
    {
        var output = new StringBuilder();
        Pretty(output, issues, 0);
        return new(output.ToString());
    }

    /// <summary>JSON.stringify(value, null, 2).</summary>
    private static void Pretty(StringBuilder output, object? value, int depth)
    {
        var inner = new string(' ', (depth + 1) * 2);
        switch (value)
        {
            case System.Collections.IList { Count: 0 }: output.Append("[]"); break;
            case System.Collections.IList items:
                output.Append("[\n");
                for (var index = 0; index < items.Count; index++)
                {
                    output.Append(inner); Pretty(output, items[index], depth + 1);
                    output.Append(index < items.Count - 1 ? ",\n" : "\n");
                }
                output.Append(new string(' ', depth * 2)).Append(']');
                break;
            case Dictionary<string, object?> { Count: 0 }: output.Append("{}"); break;
            case Dictionary<string, object?> properties:
                output.Append("{\n");
                var keys = JavaScriptKeys(properties).ToList();
                for (var index = 0; index < keys.Count; index++)
                {
                    output.Append(inner).Append(JsJson.Stringify(keys[index])).Append(": "); Pretty(output, properties[keys[index]], depth + 1);
                    output.Append(index < keys.Count - 1 ? ",\n" : "\n");
                }
                output.Append(new string(' ', depth * 2)).Append('}');
                break;
            default: output.Append(JsJson.Stringify(value)); break;
        }
    }

    private static List<Dictionary<string, object?>> Load()
    {
        using var document = JsonDocument.Parse(Source);
        return [.. ((List<object?>)JsJson.FromElement(document.RootElement)!).Cast<Dictionary<string, object?>>()];
    }
}
