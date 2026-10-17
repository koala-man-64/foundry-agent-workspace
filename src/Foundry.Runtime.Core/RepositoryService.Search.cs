using System.Globalization;
using Foundry.Protocol;

namespace Foundry.Runtime;

/// <summary>
/// search (repository.ts): literal text in the accessible files beneath a folder of the worktree, depth first. Each
/// folder taken from the stack and each entry listed counts as a visit; after 2,000 visits, or at 100 matches, the result
/// is truncated. node_modules, dist, out, coverage and .venv are counted as skipped and not entered, as is a file that
/// cannot be read (binary, too large, denied or unreadable). Lines split on "\n" or "\r\n", a match is an ordinal
/// substring, and its text is the line's first 500 UTF-16 units. Listing and reading are the read tools' own, so links,
/// reparse points, secret-named and Git metadata paths are never visited.
/// </summary>
internal sealed partial class RepositoryService
{
    private static readonly string[] SkippedFolders = ["node_modules", "dist", "out", "coverage", ".venv"];

    /// <summary>
    /// The JSON text of { matches, truncated, skipped }, which the search_text tool returns. The root is admitted once and
    /// held for the walk, which runs off the loop: TypeScript admits it again for every listing and read.
    /// </summary>
    internal async Task<string> Search(string root, string query, string start = "")
    {
        loop.AssertCurrent();
        using var admitted = RequireRoot(root);
        return await RuntimeLoop.Offload(Pack(admitted.Path, query, start), SearchPacked);
    }

    private static string SearchPacked(string packed)
    {
        var (root, rest) = Unpack(packed);
        var (query, start) = Unpack(rest);
        return JsJson.Stringify(SearchWithin(root, query, start))!;
    }

    internal static Dictionary<string, object?> SearchWithin(string root, string query, string start)
    {
        var pending = new List<string> { start };
        var matches = new List<object?>();
        var visited = 0; var skipped = 0; var truncated = false;
        Dictionary<string, object?> Result(bool cut) => new() { ["matches"] = matches, ["truncated"] = cut, ["skipped"] = skipped };
        while (pending.Count > 0)
        {
            var current = pending[^1]; pending.RemoveAt(pending.Count - 1);
            if (++visited > 2000) { truncated = true; break; }
            foreach (var entry in ListFilesWithin(root, current))
            {
                if (++visited > 2000) return Result(true);
                var path = (string)entry["path"]!;
                if ((string)entry["kind"]! == "directory")
                {
                    if (SkippedFolders.Contains(path[(path.LastIndexOfAny(['/', '\\']) + 1)..], StringComparer.Ordinal)) skipped++;
                    else pending.Add(path);
                    continue;
                }
                Dictionary<string, object?> file;
                // TypeScript skips whatever stops the read; native's read refusals are these.
                try { file = ReadFileWithin(root, path); }
                catch (Exception error) when (error is WorkspaceReadException or IOException or UnauthorizedAccessException) { skipped++; continue; }
                var line = 0;
                foreach (var text in Lines((string)file["content"]!))
                {
                    line++;
                    if (text.Contains(query, StringComparison.Ordinal))
                        matches.Add(new Dictionary<string, object?> { ["path"] = file["path"], ["line"] = line, ["text"] = text.Length > 500 ? text[..500] : text });
                    if (matches.Count >= 100) return Result(true);
                }
            }
        }
        return Result(truncated);
    }

    /// <summary>content.split(/\r?\n/).</summary>
    private static IEnumerable<string> Lines(string content)
    {
        var start = 0;
        for (var index = content.IndexOf('\n', StringComparison.Ordinal); index >= 0; index = content.IndexOf('\n', start))
        {
            var end = index > start && content[index - 1] == '\r' ? index - 1 : index;
            yield return content[start..end];
            start = index + 1;
        }
        yield return content[start..];
    }

    // Offload carries plain values only. A length prefix keeps every character of the query and the paths.
    private static string Pack(string first, string second, string third) =>
        string.Concat(first.Length.ToString(CultureInfo.InvariantCulture), ":", first, second.Length.ToString(CultureInfo.InvariantCulture), ":", second, third);

    private static (string Head, string Tail) Unpack(string packed)
    {
        var colon = packed.IndexOf(':', StringComparison.Ordinal);
        var length = int.Parse(packed.AsSpan(0, colon), NumberStyles.None, CultureInfo.InvariantCulture);
        return (packed.Substring(colon + 1, length), packed[(colon + 1 + length)..]);
    }
}
