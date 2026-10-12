using System.Globalization;
using System.Net;
using System.Text;

namespace Foundry.Protocol;

/// <summary>HTTP-special URL rules used by the frozen contracts, checked with the Node URL oracle.</summary>
internal sealed record EcmaUrl(string Scheme, string Host, string Port, string Tail, bool HasCredentials)
{
    internal static bool TryParse(string input, out EcmaUrl? result)
    {
        result = null;
        var text = input.Trim([.. Enumerable.Range(0, 33).Select(value => (char)value)]).Replace("\t", "", StringComparison.Ordinal).Replace("\r", "", StringComparison.Ordinal).Replace("\n", "", StringComparison.Ordinal);
        var colon = text.IndexOf(':');
        if (colon < 0) return false;
        var scheme = text[..colon].ToLowerInvariant();
        if (scheme is not "http" and not "https") return false;
        var remainder = text[(colon + 1)..].Replace('\\', '/').TrimStart('/');
        var boundary = remainder.IndexOfAny(['/', '?', '#']);
        var authority = boundary < 0 ? remainder : remainder[..boundary];
        var tail = boundary < 0 ? "" : remainder[boundary..];
        var at = authority.LastIndexOf('@');
        var credentials = at >= 0 && authority[..at].Trim(':').Length != 0;
        if (at >= 0) authority = authority[(at + 1)..];
        string host, port;
        if (authority.StartsWith('['))
        {
            var end = authority.IndexOf(']');
            if (end < 0 || authority[..end].Contains('%') || !IPAddress.TryParse(authority[1..end], out var address) || address.AddressFamily != System.Net.Sockets.AddressFamily.InterNetworkV6) return false;
            host = "[" + address + "]";
            var suffix = authority[(end + 1)..];
            if (suffix.Length != 0 && !suffix.StartsWith(':')) return false;
            port = suffix.Length == 0 ? "" : suffix[1..];
        }
        else
        {
            var separator = authority.LastIndexOf(':');
            host = separator < 0 ? authority : authority[..separator];
            port = separator < 0 ? "" : authority[(separator + 1)..];
            try { host = DecodeHost(host); if (host.Any(c => c > 127)) host = new IdnMapping { UseStd3AsciiRules = false }.GetAscii(host); host = host.ToLowerInvariant(); }
            catch (ArgumentException) { return false; }
            if (host.Length == 0 || host.Any(c => c <= ' ' || "#/:<>?@[\\]^|%".Contains(c))) return false;
            var segments = (host.EndsWith('.') ? host[..^1] : host).Split('.');
            var last = segments[^1];
            if (last.Length > 0 && (last.All(char.IsAsciiDigit) || last.StartsWith("0x", StringComparison.OrdinalIgnoreCase)))
            {
                if (!TryIpv4(segments, out host)) return false;
            }
        }
        if (port.Length > 0)
        {
            if (!port.All(char.IsAsciiDigit) || !int.TryParse(port, NumberStyles.None, CultureInfo.InvariantCulture, out var number) || number > 65535) return false;
            port = number == (scheme == "http" ? 80 : 443) ? "" : number.ToString(CultureInfo.InvariantCulture);
        }
        result = new(scheme, host, port, tail, credentials); return true;
    }

    private static string DecodeHost(string host)
    {
        var bytes = new List<byte>();
        for (var index = 0; index < host.Length; index++)
        {
            if (host[index] == '%')
            {
                if (index + 2 >= host.Length || !byte.TryParse(host.AsSpan(index + 1, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var value)) throw new ArgumentException("Invalid URL host.");
                bytes.Add(value); index += 2;
            }
            else
            {
                var length = char.IsHighSurrogate(host[index]) && index + 1 < host.Length && char.IsLowSurrogate(host[index + 1]) ? 2 : 1;
                bytes.AddRange(new UTF8Encoding(false, true).GetBytes(host.Substring(index, length))); index += length - 1;
            }
        }
        return new UTF8Encoding(false, true).GetString(bytes.ToArray());
    }
    private static bool TryIpv4(string[] segments, out string host)
    {
        host = "";
        if (segments.Length > 4) return false;
        var parts = new List<ulong>();
        foreach (var segment in segments)
        {
            if (segment.Length == 0) return false;
            var digits = segment; var radix = 10;
            if (digits.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) { radix = 16; digits = digits[2..]; }
            else if (digits.StartsWith('0') && digits.Length > 1) { radix = 8; digits = digits[1..]; }
            ulong number = 0;
            foreach (var digit in digits)
            {
                var value = digit is >= '0' and <= '9' ? digit - '0' : digit is >= 'a' and <= 'f' ? digit - 'a' + 10 : digit is >= 'A' and <= 'F' ? digit - 'A' + 10 : 100;
                if (value >= radix || number > uint.MaxValue / (ulong)radix) return false;
                number = number * (ulong)radix + (ulong)value;
            }
            parts.Add(number);
        }
        if (parts.Take(parts.Count - 1).Any(value => value > 255) || parts[^1] >= 1UL << (8 * (5 - parts.Count))) return false;
        var address = parts[^1];
        for (var index = 0; index < parts.Count - 1; index++) address += parts[index] << (8 * (3 - index));
        host = string.Join('.', Enumerable.Range(0, 4).Select(index => (address >> (8 * (3 - index)) & 255).ToString(CultureInfo.InvariantCulture))); return true;
    }

    internal string AzureEndpoint()
    {
        if (Scheme != "https" || HasCredentials || Port.Length > 0 || !AzureSuffixes.Any(suffix => Host.EndsWith(suffix, StringComparison.Ordinal) && Host.Length > suffix.Length)) throw InvalidEndpoint();
        var query = Tail.IndexOf('?'); var fragment = Tail.IndexOf('#');
        var end = new[] { query, fragment }.Where(index => index >= 0).DefaultIfEmpty(Tail.Length).Min();
        if (query >= 0 && Tail[(query + 1)..(fragment >= query ? fragment : Tail.Length)].Length > 0 || fragment >= 0 && fragment + 1 < Tail.Length) throw InvalidEndpoint();
        var path = Tail[..end];
        var segments = new List<string>();
        foreach (var part in path.Split('/').Skip(1))
        {
            var dotted = part.Replace("%2e", ".", StringComparison.OrdinalIgnoreCase);
            if (dotted == ".") continue;
            if (dotted == "..") { if (segments.Count > 0) segments.RemoveAt(segments.Count - 1); continue; }
            segments.Add(part);
        }
        if (segments.Any(segment => segment.Length != 0) || segments.Count > 1) throw InvalidEndpoint();
        return "https://" + Host + "/" + Tail[end..];
    }
    private static readonly string[] AzureSuffixes = [".openai.azure.com", ".services.ai.azure.com", ".cognitiveservices.azure.com", ".inference.ai.azure.com"];
    private static ArgumentException InvalidEndpoint() => new("Endpoint must be an HTTPS Azure resource URL without path, credentials, query, or fragment.");
}
