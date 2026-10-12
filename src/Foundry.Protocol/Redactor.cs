using System.Text;
using System.Text.RegularExpressions;

namespace Foundry.Protocol;

public sealed class Redactor
{
    private readonly HashSet<string> seen = new(StringComparer.Ordinal);
    private readonly List<string> secrets = [];
    private const string Whitespace = @"[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]";
    private static readonly Regex PrivateKey = Pattern(@"-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)");
    private static readonly Regex Tokens = Pattern(@"\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b");
    private static readonly Regex Labels = Pattern(@"\b(authorization\s*[:=]\s*(?:bearer\s+)?|(?:api[_-]?key|password|client_secret|access_token)\s*[:=]\s*)[^\s,;""']+", true);
    private static readonly Regex Bearer = Pattern(@"\bbearer\s+[A-Za-z0-9._~+/-]{16,}=*", true);
    public void Add(string secret)
    {
        ArgumentNullException.ThrowIfNull(secret);
        if (secret.Length < 4) return;
        var value = secret;
        for (var level = 0; level < 3 && seen.Add(value); level++) { secrets.Add(value); value = JsJson.Stringify(value)![1..^1]; }
    }
    public string Text(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        foreach (var secret in secrets) value = value.Replace(secret, "[REDACTED]", StringComparison.Ordinal);
        value = PrivateKey.Replace(value, "[REDACTED PRIVATE KEY]");
        value = Tokens.Replace(value, "[REDACTED]");
        value = Labels.Replace(value, "$1[REDACTED]");
        return Bearer.Replace(value, "bearer [REDACTED]");
    }
    private static Regex Pattern(string pattern, bool foldAscii = false)
    {
        var output = new StringBuilder();
        var inside = false;
        for (var index = 0; index < pattern.Length; index++)
        {
            var c = pattern[index];
            if (c == '\\' && index + 1 < pattern.Length)
            {
                var next = pattern[++index];
                if (next == 's') output.Append(inside ? Whitespace[1..^1] : Whitespace);
                else output.Append('\\').Append(next);
            }
            else
            {
                if (c == '[') inside = true;
                if (c == ']') inside = false;
                if (foldAscii && !inside && char.IsAsciiLetter(c)) output.Append('[').Append(char.ToLowerInvariant(c)).Append(char.ToUpperInvariant(c)).Append(']');
                else output.Append(c);
            }
        }
        return new Regex(output.ToString(), RegexOptions.ECMAScript | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
    }
}
