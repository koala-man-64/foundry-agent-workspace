using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Foundry.Protocol;

public sealed class McpConfigurationException(string message) : Exception(message);

public static class Compatibility
{
    private static readonly string[] ProfileFields = ["apiKind", "endpoint", "deployment", "credentialRef", "contextLimit", "outputLimit", "effort"];
    public static string Hash(object? value) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(JsJson.Stringify(value) ?? throw new ArgumentException("Hash input is absent.", nameof(value)))));
    public static string ProfileFingerprint(Dictionary<string, object?> profile) => Hash(ProfileFields.ToDictionary(key => key, key => profile.GetValueOrDefault(key, Undefined.Value)));
    public static string ProviderProfileFingerprint(Dictionary<string, object?> profile)
    {
        var fields = ProfileFields.Where(key => key != "credentialRef").ToDictionary(key => key, key => profile.GetValueOrDefault(key, Undefined.Value));
        if (!Equals(profile["apiKind"], "fake"))
        {
            if (!EcmaUrl.TryParse((string)profile["endpoint"]!, out var endpoint)) throw new ArgumentException("Endpoint must be a valid HTTPS Azure URL.", nameof(profile));
            fields["endpoint"] = endpoint!.AzureEndpoint();
        }
        return Hash(fields);
    }
    /// <summary>
    /// normalizeEndpoint of packages/providers: the WHATWG serialization of an HTTPS Azure resource endpoint with no path,
    /// credentials, query or fragment, or an <see cref="ArgumentException"/> with TypeScript's message. An input WHATWG parses
    /// under another scheme gets the second message, as TypeScript gives it; for a non-special scheme this assumes that
    /// WHATWG parses it, which it does except for an authority it cannot read (the message is the only difference).
    /// </summary>
    public static string AzureEndpoint(string endpoint)
    {
        ArgumentNullException.ThrowIfNull(endpoint);
        if (EcmaUrl.TryParse(endpoint, out var url)) return url!.AzureEndpoint();
        throw new ArgumentException(OtherScheme(endpoint) ? "Endpoint must be an HTTPS Azure resource URL without path, credentials, query, or fragment." : "Endpoint must be a valid HTTPS Azure URL.");
    }
    private static bool OtherScheme(string endpoint)
    {
        var text = endpoint.Trim([.. Enumerable.Range(0, 33).Select(value => (char)value)]).Replace("\t", "", StringComparison.Ordinal).Replace("\r", "", StringComparison.Ordinal).Replace("\n", "", StringComparison.Ordinal);
        var colon = text.IndexOf(':', StringComparison.Ordinal);
        if (colon < 1 || !char.IsAsciiLetter(text[0]) || !text[..colon].All(c => char.IsAsciiLetterOrDigit(c) || c is '+' or '-' or '.')) return false;
        var scheme = text[..colon].ToLowerInvariant();
        if (scheme is "http" or "https") return false;
        // The other special schemes with a host parse as http does; file and non-special schemes parse.
        return scheme is not ("ftp" or "ws" or "wss") || EcmaUrl.TryParse("http" + text[colon..], out _);
    }
    public static List<object?> SortManifest(List<object?> entries) => entries.OrderBy(entry => (string)((Dictionary<string, object?>)entry!)["path"]!, Utf8Order.Instance).ToList();
    private sealed class Utf8Order : IComparer<string>
    {
        internal static Utf8Order Instance { get; } = new();
        public int Compare(string? x, string? y) => Encoding.UTF8.GetBytes(x ?? "").AsSpan().SequenceCompareTo(Encoding.UTF8.GetBytes(y ?? ""));
    }

    private static readonly Regex ForbiddenEnvironment = new(@"(?:credential|secret|token|password|passwd|authorization|api[_-]?key|cookie|proxy|node_options|bearer|private)|(?:^|_)(?:auth|key|keys|pass|pat|pwd|session|signing)(?:_|$)", RegexOptions.ECMAScript | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
    private static readonly Regex ReservedEnvironment = new(@"^(?:path|comspec|systemroot|windir|pathext|psmodulepath|temp|tmp|userprofile)$", RegexOptions.ECMAScript | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
    private static readonly string[] McpConfigurationFields = ["id", "key", "name", "command", "arguments", "cwd", "environment", "enabled", "readOnlyTools", "callTimeoutMs"];
    public static Dictionary<string, object?> SanitizeStoredMcp(Dictionary<string, object?> server, Redactor redactor)
    {
        var config = McpConfigurationFields.ToDictionary(key => key, key => server.GetValueOrDefault(key, Undefined.Value));
        try { CheckMcp(config, redactor); return server; }
        catch (Exception error) when (error is McpConfigurationException or System.Text.Json.JsonException)
        {
            var safe = new Dictionary<string, object?>(server)
            {
                ["name"] = redactor.Text((string)server["name"]!), ["command"] = redactor.Text((string)server["command"]!),
                ["cwd"] = "", ["arguments"] = new List<object?>(), ["environment"] = new Dictionary<string, object?>(),
                ["enabled"] = false, ["tools"] = new List<object?>(), ["readOnlyTools"] = new List<object?>(), ["serverInfo"] = null, ["running"] = false,
                ["lastError"] = "Configuration quarantined: unsafe stored values were removed. Review and save a new configuration. Historical backups may retain old values."
            };
            return safe;
        }
    }
    public static Dictionary<string, object?> CheckMcp(object? input, Redactor redactor)
    {
        ArgumentNullException.ThrowIfNull(redactor);
        var config = (Dictionary<string, object?>)Contracts.Validate("rpc mcp.save", input)!;
        var environment = (Dictionary<string, object?>)config["environment"]!;
        foreach (var key in environment.Keys)
        {
            // JavaScript /i without /u folds ASCII identifiers, not Kelvin sign or long s.
            var folded = new string(key.Select(c => c is >= 'A' and <= 'Z' ? (char)(c + 32) : c).ToArray());
            if (ForbiddenEnvironment.IsMatch(folded) || ReservedEnvironment.IsMatch(folded)) throw new McpConfigurationException("An environment variable name is not permitted for MCP servers.");
        }
        var fields = new List<(string Name, string Value)> { ("name", (string)config["name"]!), ("command", (string)config["command"]!), ("cwd", (string)config["cwd"]!) };
        fields.AddRange(((List<object?>)config["arguments"]!).Select((value, index) => ("argument " + (index + 1), (string)value!)));
        fields.AddRange(environment.Select(p => ("environment " + p.Key, (string)p.Value!)));
        foreach (var (name, value) in fields)
            if (value.Contains('\0') || redactor.Text(value) != value) throw new McpConfigurationException("MCP " + name + " contains invalid or secret-like content and cannot be stored.");
        return config;
    }
}
