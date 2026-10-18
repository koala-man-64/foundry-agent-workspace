using System.Globalization;
using System.Text;
using Foundry.Protocol;

namespace Foundry.Providers;

/// <summary>A provider payload that is not JSON as JSON.parse reads it, or that nests deeper than <see cref="ProviderJson.MaxDepth"/>.</summary>
internal sealed class ProviderJsonException(string message) : Exception(message);

/// <summary>
/// JSON.parse over the decoded text, for provider payloads and tool-call arguments. Objects are dictionaries in source order
/// (a repeated key keeps its first position and its last value, <c>__proto__</c> is an ordinary key), arrays are lists, numbers
/// are doubles (<c>1e400</c> is infinite, as in JavaScript), and lone surrogates survive. It reads UTF-16 directly, so text
/// that holds a lone surrogate parses as JavaScript parses it. Nesting deeper than <see cref="MaxDepth"/> is refused before
/// any recursive walk (JsJson, the runtime's checks) can exhaust the native stack, where TypeScript fails such a payload
/// only when a recursive walk overflows its own stack (a named difference).
/// </summary>
internal static class ProviderJson
{
    internal const int MaxDepth = 256;

    internal static object? Parse(string text)
    {
        var index = 0;
        var stack = new Stack<(object Container, string? Key)>();
        object? root = null; var hasRoot = false;
        void Skip() { while (index < text.Length && text[index] is ' ' or '\t' or '\n' or '\r') index++; }
        ProviderJsonException Invalid() => new("Invalid JSON.");
        void Attach(object? value)
        {
            if (stack.Count == 0) { root = value; hasRoot = true; return; }
            var (container, key) = stack.Peek();
            if (container is List<object?> list) list.Add(value);
            else ((Dictionary<string, object?>)container)[key!] = value;
        }
        while (true)
        {
            Skip();
            if (index >= text.Length) throw Invalid();
            var c = text[index];
            object? value;
            if (c == '{' || c == '[')
            {
                if (stack.Count >= MaxDepth) throw new ProviderJsonException("JSON nests too deeply.");
                index++;
                object container = c == '{' ? new Dictionary<string, object?>(StringComparer.Ordinal) : new List<object?>();
                Attach(container);
                Skip();
                if (index < text.Length && text[index] == (c == '{' ? '}' : ']')) { index++; value = null; goto Closed; }
                stack.Push((container, null));
                if (c == '{') { ReadKey(); continue; }
                continue;
            }
            value = c switch
            {
                '"' => ReadString(),
                't' => Literal("true", true),
                'f' => Literal("false", false),
                'n' => Literal("null", null),
                _ when c == '-' || char.IsAsciiDigit(c) => ReadNumber(),
                _ => throw Invalid(),
            };
            Attach(value);
        Closed:
            // After a value: close containers or move to the next member.
            while (true)
            {
                Skip();
                if (stack.Count == 0)
                {
                    if (index != text.Length || !hasRoot) throw Invalid();
                    return root;
                }
                if (index >= text.Length) throw Invalid();
                var (container, _) = stack.Peek();
                var close = container is List<object?> ? ']' : '}';
                if (text[index] == close) { index++; stack.Pop(); continue; }
                if (text[index] != ',') throw Invalid();
                index++;
                if (container is Dictionary<string, object?>) ReadKey();
                break;
            }
        }

        void ReadKey()
        {
            Skip();
            if (index >= text.Length || text[index] != '"') throw Invalid();
            var key = ReadString();
            Skip();
            if (index >= text.Length || text[index] != ':') throw Invalid();
            index++;
            var (container, _) = stack.Pop();
            stack.Push((container, key));
        }

        object? Literal(string word, object? result)
        {
            if (string.CompareOrdinal(text, index, word, 0, word.Length) != 0) throw Invalid();
            index += word.Length; return result;
        }

        string ReadString()
        {
            index++; // opening quote
            var output = new StringBuilder();
            while (true)
            {
                if (index >= text.Length) throw Invalid();
                var c = text[index++];
                if (c == '"') return output.ToString();
                if (c < ' ') throw Invalid();
                if (c != '\\') { output.Append(c); continue; }
                if (index >= text.Length) throw Invalid();
                var escape = text[index++];
                switch (escape)
                {
                    case '"': output.Append('"'); break;
                    case '\\': output.Append('\\'); break;
                    case '/': output.Append('/'); break;
                    case 'b': output.Append('\b'); break;
                    case 'f': output.Append('\f'); break;
                    case 'n': output.Append('\n'); break;
                    case 'r': output.Append('\r'); break;
                    case 't': output.Append('\t'); break;
                    case 'u':
                        if (index + 4 > text.Length || !ushort.TryParse(text.AsSpan(index, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var unit)) throw Invalid();
                        output.Append((char)unit); index += 4; break;
                    default: throw Invalid();
                }
            }
        }

        double ReadNumber()
        {
            var start = index;
            if (text[index] == '-') index++;
            if (index >= text.Length) throw Invalid();
            if (text[index] == '0') index++;
            else if (text[index] is >= '1' and <= '9') { while (index < text.Length && char.IsAsciiDigit(text[index])) index++; }
            else throw Invalid();
            if (index < text.Length && text[index] == '.')
            {
                index++;
                if (index >= text.Length || !char.IsAsciiDigit(text[index])) throw Invalid();
                while (index < text.Length && char.IsAsciiDigit(text[index])) index++;
            }
            if (index < text.Length && text[index] is 'e' or 'E')
            {
                index++;
                if (index < text.Length && text[index] is '+' or '-') index++;
                if (index >= text.Length || !char.IsAsciiDigit(text[index])) throw Invalid();
                while (index < text.Length && char.IsAsciiDigit(text[index])) index++;
            }
            // Correctly rounded, and infinite beyond the double range, as JavaScript's.
            return double.Parse(text.AsSpan(start, index - start), NumberStyles.Float, CultureInfo.InvariantCulture);
        }
    }

    /// <summary>A member as JavaScript reads it: <see cref="Undefined.Value"/> when the value is not an object or lacks it.</summary>
    internal static object? Member(object? value, string key) =>
        value is Dictionary<string, object?> record && record.TryGetValue(key, out var member) ? member : Undefined.Value;

    internal static bool IsRecord(object? value) => value is Dictionary<string, object?>;
    internal static bool Nullish(object? value) => value is null or Undefined;
    /// <summary>JavaScript truthiness.</summary>
    internal static bool Truthy(object? value) => value switch
    {
        null or Undefined => false,
        bool flag => flag,
        double number => number != 0 && !double.IsNaN(number),
        string text => text.Length > 0,
        _ => true,
    };
    internal static bool IsInteger(object? value) => value is double number && double.IsFinite(number) && Math.Floor(number) == number;
    internal static bool ValidUsageInteger(object? value) => value is double number && IsInteger(number) && Math.Abs(number) <= 9007199254740991 && number >= 0;

    /// <summary>String(value) for a JSON.parse value.</summary>
    internal static string JsString(object? value) => value switch
    {
        null => "null",
        Undefined => "undefined",
        string text => text,
        bool flag => flag ? "true" : "false",
        double number => double.IsNaN(number) ? "NaN" : double.IsPositiveInfinity(number) ? "Infinity" : double.IsNegativeInfinity(number) ? "-Infinity" : JsJson.Stringify(number)!,
        List<object?> items => string.Join(',', items.Select(item => item is null or Undefined ? "" : JsString(item))),
        _ => "[object Object]",
    };
}
