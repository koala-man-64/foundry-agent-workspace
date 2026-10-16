using System.Text.RegularExpressions;
using Foundry.Platform;

namespace Foundry.Runtime;

/// <summary>
/// TypeScript RepositoryService's lexical path rules (repository.ts). The name patterns reproduce JavaScript regular
/// expressions without the u flag: case-insensitivity folds ASCII letters only (a Kelvin sign never matches "k"), "."
/// excludes the four ECMAScript line terminators, and "$" anchors at the very end.
/// </summary>
internal static partial class RepositoryPaths
{
    internal const string Escapes = "Path escapes the repository root.";
    internal const string Forbidden = "Path contains a forbidden segment.";

    internal static void ValidateRelative(string relativePath, bool allowEmpty)
    {
        if (relativePath is null || !allowEmpty && relativePath.Length == 0) throw new WorkspaceReadException("A relative path is required.");
        if (relativePath.Length == 0) return;
        // path.isAbsolute, path.win32.isAbsolute and /^[a-zA-Z]:/: a leading separator or any drive prefix.
        if (relativePath[0] is '/' or '\\' || relativePath.Length >= 2 && char.IsAsciiLetter(relativePath[0]) && relativePath[1] == ':')
            throw new WorkspaceReadException("Absolute paths are not allowed.");
        foreach (var segment in relativePath.Replace('\\', '/').Split('/'))
            if (segment.Length == 0 || segment is "." or ".." || IsDeniedName(segment)) throw new WorkspaceReadException(Forbidden);
    }

    internal static bool IsDeniedName(string name) =>
        EcmaScriptCase.ToLower(name) == ".git" || name.Contains(':', StringComparison.Ordinal) || name.EndsWith('.') || name.EndsWith(' ')
        || ReservedWindowsName().IsMatch(AsciiLower(name)) || SecretName().IsMatch(AsciiLower(name));

    internal static bool IsDeniedRelativePath(string relativePath) => relativePath.Replace('\\', '/').Split('/').Any(IsDeniedName);

    /// <summary>TypeScript's isInside: path.relative between the resolved, lowercased paths stays at or below the root.</summary>
    internal static bool IsInside(string root, string candidate)
    {
        var parent = Key(root); var child = Key(candidate);
        if (child == parent) return true;
        var prefix = parent.EndsWith('\\') ? parent : parent + "\\";
        return child.StartsWith(prefix, StringComparison.Ordinal);
    }

    /// <summary>path.relative(root, target) with "/" separators, for a target already known to be inside the root.</summary>
    internal static string PortableRelative(string root, string target)
    {
        var parent = FinalPath.Resolve(root); var child = FinalPath.Resolve(target);
        if (Key(child) == Key(parent)) return "";
        var length = parent.EndsWith('\\') ? parent.Length : parent.Length + 1;
        return child[length..].Replace('\\', '/');
    }

    private static string Key(string value) => EcmaScriptCase.ToLower(FinalPath.Resolve(value));

    /// <summary>The only case folding a JavaScript /i pattern without the u flag applies to these ASCII patterns.</summary>
    private static string AsciiLower(string value) => string.Create(value.Length, value, static (span, text) =>
    {
        for (var index = 0; index < text.Length; index++) span[index] = text[index] is >= 'A' and <= 'Z' ? (char)(text[index] + 32) : text[index];
    });

    // JavaScript "." excludes \n, \r, U+2028 and U+2029; "$" without the m flag is the end of input (\z here).
    [GeneratedRegex(@"^(?:\.env(?:\.[^\n\r  ]*)?|\.envrc|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.terraformrc|\.(?:ssh|aws|azure|kube|docker|gnupg)|id_(?:rsa|dsa|ecdsa|ed25519)|credentials?(?:\.[^\n\r  ]*)?|secrets?(?:\.[^\n\r  ]*)?|[^\n\r  ]*\.(?:pem|key|p12|pfx))\z", RegexOptions.CultureInvariant)]
    private static partial Regex SecretName();

    [GeneratedRegex(@"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.[^\n\r  ]*)?\z", RegexOptions.CultureInvariant)]
    private static partial Regex ReservedWindowsName();
}
