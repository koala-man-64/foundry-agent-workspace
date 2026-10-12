using System.Text.Json;
using System.Text.Json.Serialization;

namespace Foundry.Protocol;

public sealed record RpcRequest(string Jsonrpc, string Id, string Method, object? Params);
public sealed record RpcError(int Code, string Message);
public sealed record WireNumber(double Value, string Raw);

public static class WireJson
{
    public const int MaximumBytes = 1024 * 1024;
    private static JsonSerializerOptions Options { get; } = new()
    {
        MaxDepth = 32, AllowDuplicateProperties = false, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        NumberHandling = JsonNumberHandling.Strict, RespectNullableAnnotations = true,
        RespectRequiredConstructorParameters = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public static object? Parse(string text)
    {
        for (var index = 0; index < text.Length; index++)
        {
            if (!char.IsSurrogate(text[index])) continue;
            if (!char.IsHighSurrogate(text[index]) || index + 1 >= text.Length || !char.IsLowSurrogate(text[++index])) throw new JsonException("Invalid request.");
        }
        if (text.StartsWith('\uFEFF') || System.Text.Encoding.UTF8.GetByteCount(text) > MaximumBytes) throw new JsonException("Invalid request.");
        return Convert(JsonSerializer.Deserialize<JsonElement>(text, Options));
    }

    public static object? Parse(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length > MaximumBytes || bytes.StartsWith((ReadOnlySpan<byte>)[0xef, 0xbb, 0xbf])) throw new JsonException("Invalid request.");
        return Convert(JsonSerializer.Deserialize<JsonElement>(bytes, Options));
    }

    private static object? Convert(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Number => new WireNumber(value.GetDouble(), value.GetRawText()),
        JsonValueKind.String => value.GetString(), // GetString rejects malformed surrogate escapes.
        JsonValueKind.Array => value.EnumerateArray().Select(Convert).ToList(),
        JsonValueKind.Object => value.EnumerateObject().ToDictionary(p => p.Name, p => Convert(p.Value), StringComparer.Ordinal),
        _ => JsJson.FromElement(value)
    };

    public static RpcRequest Request(object? input)
    {
        var envelope = (Dictionary<string, object?>)Contracts.Validate("frame rpc request", input)!;
        var method = (string)envelope["method"]!;
        var parameters = Contracts.Validate("rpc " + method, envelope["params"]);
        return new("2.0", (string)envelope["id"]!, method, parameters);
    }
}
