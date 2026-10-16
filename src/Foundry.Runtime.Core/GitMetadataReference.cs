using System.Text;
using Foundry.Protocol;

namespace Foundry.Runtime;

/// <summary>Parses supplied metadata bytes only. Results are untrusted references, never admitted paths or Git identities.</summary>
internal static class GitMetadataReference
{
    private const int MaximumBytes = 16_384;
    private const string InvalidMetadata = "Invalid Git project metadata.";

    internal static string ParseGitDirectory(ReadOnlySpan<byte> metadata)
    {
        var text = Decode(metadata);
        const string prefix = "gitdir: ";
        // JavaScript /^gitdir: (.+)$/ has no flags: dot excludes all four ECMAScript line terminators.
        if (!text.StartsWith(prefix, StringComparison.Ordinal) || text.Length == prefix.Length
            || text.AsSpan(prefix.Length).IndexOfAny("\r\n\u2028\u2029") >= 0)
            throw new WorkspaceReadException(InvalidMetadata);
        return CheckReference(text[prefix.Length..]);
    }

    internal static string? ParseCommonDirectory(ReadOnlySpan<byte> metadata)
    {
        var text = Decode(metadata);
        return text.Length == 0 ? null : CheckReference(text);
    }

    private static string Decode(ReadOnlySpan<byte> metadata)
    {
        // This bounds supplied input, not a future file read. Node's UTF-8 decoder replaces invalid sequences.
        if (metadata.Length > MaximumBytes) throw new WorkspaceReadException(InvalidMetadata);
        return JsJson.Trim(Encoding.UTF8.GetString(metadata));
    }

    private static string CheckReference(string reference)
    {
        if (NetworkPathPolicy.IsNetworkOrDevicePath(reference))
            throw new WorkspaceReadException("Projects on network shares are not supported.");
        // No normalization, existence check, canonicalization or local-volume/alias admission occurs here.
        return reference;
    }
}
