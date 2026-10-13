using Foundry.Platform;

namespace Foundry.Runtime;

/// <summary>Frozen assignment-scope rules; no filesystem access or execution authority.</summary>
public static class ScopePolicy
{
    public const int MaxScopePaths = 32;
    private static readonly string[] ReservedNames = ["con", "prn", "aux", "nul"];
    private static readonly string[] LiteralSecrets = [".envrc", ".npmrc", ".pypirc", ".netrc", ".pgpass", ".terraformrc", ".ssh", ".aws", ".azure", ".kube", ".docker", ".gnupg", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];
    private static readonly string[] SecretNames = [".env", "credential", "credentials", "secret", "secrets"];
    private static readonly string[] SecretExtensions = [".pem", ".key", ".p12", ".pfx"];

    public static string NormalizePath(string? value, bool allowRoot)
    {
        if (value is null) throw new InvalidOperationException("Scope paths must be strings.");
        var portable = value.Replace('\\', '/').TrimEnd('/');
        if (portable.Length == 0)
        {
            if (allowRoot) return "";
            throw new InvalidOperationException("Write scope cannot be the whole repository.");
        }
        if (portable[0] == '/' || portable.Length >= 2 && char.IsAsciiLetter(portable[0]) && portable[1] == ':')
            throw new InvalidOperationException("Scope paths must be repository-relative.");
        foreach (var segment in portable.Split('/'))
        {
            if (segment.Length == 0 || segment is "." or "..")
                throw new InvalidOperationException("Scope paths cannot contain empty, \".\" or \"..\" segments.");
            var key = EcmaScriptCase.ToLower(segment);
            if (key is ".git" or ".gitmodules" or ".gitattributes" || segment.Contains(':', StringComparison.Ordinal) || segment[^1] is '.' or ' '
                || ReservedName(segment) || SecretName(segment) || segment.Any(c => c <= '\u001f' || c is '*' or '?' or '"' or '<' or '>' or '|'))
                throw new InvalidOperationException("Scope path segment \"" + segment[..Math.Min(64, segment.Length)] + "\" is not permitted.");
        }
        return portable;
    }

    public static string[] Normalize(IReadOnlyList<string> values, bool allowRoot)
    {
        if (values.Count > MaxScopePaths) throw new InvalidOperationException("Too many scope paths.");
        var normalized = values.Select(value => NormalizePath(value, allowRoot)).Distinct(StringComparer.Ordinal).ToArray();
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var entry in normalized)
            if (!keys.Add(EcmaScriptCase.ToLower(entry))) throw new InvalidOperationException("Scope paths differ only by case.");
        Array.Sort(normalized, StringComparer.Ordinal); // JavaScript Array.sort uses UTF-16 code units.
        return normalized;
    }

    public static bool Covers(string scope, string candidate)
    {
        var left = EcmaScriptCase.ToLower(scope);
        var right = EcmaScriptCase.ToLower(candidate.Replace('\\', '/'));
        return left.Length == 0 || right == left || right.StartsWith(left + "/", StringComparison.Ordinal);
    }

    public static bool InScope(IReadOnlyList<string> scopes, string candidate)
    {
        string normalized;
        try { normalized = NormalizePath(candidate, false); }
        catch (InvalidOperationException) { return false; }
        return scopes.Any(scope => Covers(scope, normalized));
    }

    public static bool Overlap(IReadOnlyList<string> left, IReadOnlyList<string> right)
        => left.Any(a => right.Any(b => Covers(a, b) || Covers(b, a)));

    public static void AssertAcyclic(IReadOnlyDictionary<string, string[]> edges)
    {
        var visiting = new HashSet<string>(StringComparer.Ordinal);
        var done = new HashSet<string>(StringComparer.Ordinal);
        foreach (var start in edges.Keys)
        {
            var stack = new Stack<(string Node, int Next)>();
            if (done.Contains(start)) continue;
            visiting.Add(start); stack.Push((start, 0));
            while (stack.TryPop(out var frame))
            {
                var dependencies = edges[frame.Node];
                if (frame.Next == dependencies.Length) { visiting.Remove(frame.Node); done.Add(frame.Node); continue; }
                var predecessor = dependencies[frame.Next];
                if (!edges.ContainsKey(predecessor)) throw new InvalidOperationException("Assignment dependency references an unknown assignment.");
                stack.Push((frame.Node, frame.Next + 1));
                if (done.Contains(predecessor)) continue;
                if (!visiting.Add(predecessor)) throw new InvalidOperationException("Assignment dependencies contain a cycle.");
                stack.Push((predecessor, 0));
            }
        }
    }

    public static bool Ordered(IReadOnlyDictionary<string, string[]> edges, string a, string b)
    {
        bool Reaches(string from, string to)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var stack = new Stack<string>(); stack.Push(from);
            while (stack.TryPop(out var node))
            {
                if (node == to) return true;
                if (!seen.Add(node) || !edges.TryGetValue(node, out var next)) continue;
                for (var index = next.Length - 1; index >= 0; index--) stack.Push(next[index]);
            }
            return false;
        }
        return Reaches(a, b) || Reaches(b, a);
    }

    // The authority's /i expressions lack /u. Non-ASCII folding into ASCII is
    // excluded by ECMAScript Canonicalize; .NET's ignore-case regex differs.
    private static string LegacyAsciiKey(string value) => string.Create(value.Length, value, (chars, source) =>
    {
        for (var index = 0; index < chars.Length; index++) chars[index] = source[index] is >= 'A' and <= 'Z' ? (char)(source[index] + 32) : source[index];
    });
    private static bool DotMatches(string value) => !value.Any(c => c is '\r' or '\n' or '\u2028' or '\u2029');
    private static bool NamedWithExtension(string value, string name) => value == name || value.StartsWith(name + ".", StringComparison.Ordinal) && DotMatches(value[(name.Length + 1)..]);
    private static bool ReservedName(string segment)
    {
        var key = LegacyAsciiKey(segment);
        return ReservedNames.Any(name => NamedWithExtension(key, name))
            || key.Length >= 4 && (key.StartsWith("com", StringComparison.Ordinal) || key.StartsWith("lpt", StringComparison.Ordinal))
                && key[3] is >= '1' and <= '9' && NamedWithExtension(key, key[..4]);
    }
    private static bool SecretName(string segment)
    {
        var key = LegacyAsciiKey(segment);
        if (LiteralSecrets.Contains(key, StringComparer.Ordinal)) return true;
        if (SecretNames.Any(name => NamedWithExtension(key, name))) return true;
        return DotMatches(key) && SecretExtensions.Any(extension => key.EndsWith(extension, StringComparison.Ordinal));
    }
}
