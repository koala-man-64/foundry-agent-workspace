using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Foundry.Protocol;

/// <summary>JSON.parse semantics for retained documents, independent of the strict wire parser.</summary>
public static class PersistedJson
{
    private sealed class Frame(object value)
    {
        internal object Value { get; } = value;
        internal string? Key { get; set; }
    }
    public static object? Parse(string json)
    {
        var reader = new Utf8JsonReader(Encoding.UTF8.GetBytes(json), new JsonReaderOptions { MaxDepth = int.MaxValue });
        var stack = new Stack<Frame>(); object? root = null; var hasRoot = false;
        void Attach(object? value)
        {
            if (stack.Count == 0) { root = value; hasRoot = true; }
            else if (stack.Peek().Value is List<object?> array) array.Add(value);
            else { var frame = stack.Peek(); ((Dictionary<string, object?>)frame.Value)[frame.Key!] = value; }
        }
        while (reader.Read())
        {
            switch (reader.TokenType)
            {
                case JsonTokenType.StartObject:
                    var dictionary = new Dictionary<string, object?>(StringComparer.Ordinal); Attach(dictionary); stack.Push(new(dictionary)); break;
                case JsonTokenType.StartArray:
                    var list = new List<object?>(); Attach(list); stack.Push(new(list)); break;
                case JsonTokenType.EndObject or JsonTokenType.EndArray: stack.Pop(); break;
                case JsonTokenType.PropertyName: stack.Peek().Key = String(reader.ValueSpan); break;
                case JsonTokenType.String: Attach(String(reader.ValueSpan)); break;
                case JsonTokenType.Number: Attach(reader.GetDouble()); break;
                case JsonTokenType.True: Attach(true); break;
                case JsonTokenType.False: Attach(false); break;
                case JsonTokenType.Null: Attach(null); break;
                default: throw new JsonException("Invalid persisted JSON.");
            }
        }
        if (!hasRoot) throw new JsonException("Invalid persisted JSON.");
        return root;
    }
    private static string String(ReadOnlySpan<byte> encoded)
    {
        var text = Encoding.UTF8.GetString(encoded); var result = new StringBuilder();
        for (var index = 0; index < text.Length; index++)
        {
            if (text[index] != '\\') { result.Append(text[index]); continue; }
            switch (text[++index])
            {
                case 'u': result.Append((char)ushort.Parse(text.AsSpan(index + 1, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture)); index += 4; break;
                case 'b': result.Append('\b'); break; case 'f': result.Append('\f'); break;
                case 'n': result.Append('\n'); break; case 'r': result.Append('\r'); break; case 't': result.Append('\t'); break;
                default: result.Append(text[index]); break; // JSON reader already checked quotes, slash and backslash.
            }
        }
        return result.ToString();
    }
}
