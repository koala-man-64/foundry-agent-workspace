using System.Text.Json;
using System.Text.Json.Serialization;

namespace Foundry.Protocol.Tests;

/// <summary>
/// The strict reader spike S8b proposes for Foundry.Protocol (docs/wpf-webview2-migration.md, "JSON"). Both trust
/// boundaries parse with it: the WebView2 bridge receives strings and the runtime's stdio framing receives UTF-8 bytes.
/// </summary>
internal static class CandidateJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        MaxDepth = 32,
        AllowDuplicateProperties = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        NumberHandling = JsonNumberHandling.Strict,
        RespectNullableAnnotations = true,
        RespectRequiredConstructorParameters = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        AllowTrailingCommas = false,
        ReadCommentHandling = JsonCommentHandling.Disallow,
    };

    /// <summary>The bridge path: WebView2 hands the host a .NET string.</summary>
    public static T FromText<T>(string text) => JsonSerializer.Deserialize<T>(text, Options) ?? throw new JsonException("A message cannot be null.");

    /// <summary>
    /// The stdio path. JSON.parse rejects a leading byte order mark. The span reader does too, but stream reads skip a
    /// UTF-8 BOM, so the framing rejects it explicitly and the rule does not depend on the read API.
    /// </summary>
    public static T FromLine<T>(ReadOnlySpan<byte> line)
    {
        if (line.StartsWith((ReadOnlySpan<byte>)[0xEF, 0xBB, 0xBF]))
        {
            throw new JsonException("A message must not start with a byte order mark.");
        }
        return JsonSerializer.Deserialize<T>(line, Options) ?? throw new JsonException("A message cannot be null.");
    }
}

internal sealed record RpcEnvelope(string Jsonrpc, string Id, string Method, JsonElement Params);

internal sealed record TaskIdentity(string TaskId);

internal sealed record CompactParams(string TaskId, int KeepRecent);

internal sealed record SendParams(string TaskId, string Content);

internal sealed record RetireParams(string TaskId, string Confirm);
