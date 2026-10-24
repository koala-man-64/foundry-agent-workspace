using System.Security.Cryptography;
using System.Text;
using Foundry.Platform;
using Foundry.Protocol;

namespace Foundry.Runtime;

/// <summary>
/// PreparedEdit (repository.ts): one reviewed whole-file change. Existing edits bind the reviewed content hash;
/// creation uses a null expected hash and additionally binds the observed parent directory identities.
/// </summary>
internal sealed record PreparedEdit(string Root, string Path, string Before, string After, string? ExpectedHash, string ResultingHash, string Fingerprint)
{
    // Creation alone binds the observed parent chain; existing-file wire serialization and fingerprints stay unchanged.
    internal string[]? CreationIdentities { get; init; }
    internal Dictionary<string, object?> ToWire() => new()
    {
        ["root"] = Root, ["path"] = Path, ["before"] = Before, ["after"] = After, ["expectedHash"] = ExpectedHash, ["resultingHash"] = ResultingHash, ["fingerprint"] = Fingerprint,
    };
}

/// <summary>
/// prepareEdit and applyEdit: the reviewed file primitive used by the native tool loop. Its caller owns durable,
/// one-shot approval state. Applying reruns preflight and requires the same fingerprint. New files use rooted
/// create-only access beneath existing parents, and any failure after creation is an unknown outcome.
/// </summary>
internal sealed partial class RepositoryService
{
    internal const string EditLimit = "Edits must be UTF-8 text of at most 64 KB.";
    internal const string EditUnavailable = "Requested file cannot be opened for editing.";
    private const string StaleAtExecution = "Stale edit: file changed before execution.";

    /// <summary>Test seam: called with "boundary" just before the write, while the file is held exclusively, and with
    /// "written" after it, before verification. Creation forwards its per-instance root-opened/pinned/created/written
    /// stages from the shared rooted-create primitive.</summary>
    internal Action<string>? EditStage { get; set; }

    internal PreparedEdit PrepareEdit(string root, string relativePath, string? expectedHash, string after)
    {
        loop.AssertCurrent();
        ArgumentNullException.ThrowIfNull(after);
        // Buffer.byteLength and the write encode a lone surrogate as U+FFFD, as Encoding.UTF8 does.
        if (Encoding.UTF8.GetByteCount(after) > MaximumFileBytes || after.Contains('\0', StringComparison.Ordinal)) throw new WorkspaceReadException(EditLimit);
        using var admitted = RequireRoot(root);
        RepositoryPaths.ValidateRelative(relativePath, false);
        if (expectedHash is null)
        {
            var normalizedCreation = relativePath.Replace('\\', '/');
            string[] identities;
            try { identities = new SafeFileCreation().Inspect(admitted.Path, normalizedCreation); }
            catch (IOException error) { throw new WorkspaceReadException(error.Message); }
            var creationHash = Hash(Encoding.UTF8.GetBytes(after));
            var creationFingerprint = Hash(Encoding.UTF8.GetBytes(JsJson.Stringify(new List<object?>
            {
                admitted.Path, normalizedCreation, null, creationHash, identities.Cast<object?>().ToList(),
            })!));
            return new(admitted.Path, normalizedCreation, "", after, null, creationHash, creationFingerprint) { CreationIdentities = identities };
        }
        // Parents must exist already. Directory creation is a separately approved command.
        var separator = relativePath.LastIndexOfAny(['/', '\\']);
        using (OpenSafe(admitted.Path, separator < 0 ? "" : relativePath[..separator].Replace('\\', '/'), true)) { }
        var target = FinalPath.Resolve(System.IO.Path.Join(admitted.Path, relativePath));
        var current = ReadFileWithin(admitted.Path, relativePath);
        if (!string.Equals((string)current["hash"]!, expectedHash, StringComparison.Ordinal)) throw new WorkspaceReadException("Stale edit: file content changed since it was read.");
        using (var entry = OpenSafe(admitted.Path, relativePath, false))
            if (entry.Entry.Links != 1) throw new WorkspaceReadException("Hard-linked files cannot be edited.");
        // As TypeScript, the path is the request's spelling beneath the real root; the applied result reports the real one.
        var normalized = RepositoryPaths.PortableRelative(admitted.Path, target);
        var resultingHash = Hash(Encoding.UTF8.GetBytes(after));
        var fingerprint = Hash(Encoding.UTF8.GetBytes(JsJson.Stringify(new List<object?> { admitted.Path, normalized, expectedHash, resultingHash })!));
        return new(admitted.Path, normalized, (string)current["content"]!, after, expectedHash, resultingHash, fingerprint);
    }

    /// <summary>
    /// applyEdit: a failure before the write is "none"; once the write starts, any failure is "unknown", including a
    /// verification that does not find the reviewed result. The file is opened exclusively for the whole check-and-write
    /// (readers that share writing may still read it), so no other writer, rename, delete or replacement can change what was checked before it is
    /// replaced, and the result is verified by name while still held. TypeScript opens the file shared and re-checks the
    /// name's identity before writing. The host filesystem is not a sandbox: this runs with the user's Windows rights.
    /// </summary>
    internal Dictionary<string, object?> ApplyEdit(PreparedEdit edit)
    {
        loop.AssertCurrent();
        ArgumentNullException.ThrowIfNull(edit);
        PreparedEdit fresh;
        try
        {
            fresh = PrepareEdit(edit.Root, edit.Path, edit.ExpectedHash, edit.After);
            if (!string.Equals(fresh.Fingerprint, edit.Fingerprint, StringComparison.Ordinal)) throw new WorkspaceReadException("Edit approval is stale.");
        }
        catch (Exception error)
        {
            throw new RepositoryException(error.Message, "none", error);
        }
        if (fresh.ExpectedHash is null)
        {
            var creation = new SafeFileCreation(stage => EditStage?.Invoke(stage));
            var result = creation.Create(fresh.Root, fresh.Path, fresh.CreationIdentities!, Convert.ToBase64String(Encoding.UTF8.GetBytes(fresh.After)), fresh.ResultingHash);
            if (result.Outcome != "success") throw new RepositoryException(result.Error, result.Outcome);
            return new() { ["path"] = fresh.Path, ["hash"] = result.Hash };
        }
        var mutationStarted = false;
        try
        {
            using var admitted = RequireRoot(fresh.Root);
            using var target = OpenSafe(admitted.Path, fresh.Path, false, rewrite: true);
            var opened = target.Entry;
            if (opened.IsDirectory || opened.Links != 1) throw new WorkspaceReadException("Only unlinked regular files can be edited.");
            byte[] current;
            // The reviewed content fits the read limit, so a larger file has changed.
            try { current = opened.ReadBounded(MaximumFileBytes); }
            catch (InvalidDataException) { throw new WorkspaceReadException(StaleAtExecution); }
            if (!string.Equals(Hash(current), fresh.ExpectedHash, StringComparison.Ordinal)) throw new WorkspaceReadException(StaleAtExecution);
            // Re-check canonical identity immediately before mutation.
            using (var named = OpenSafe(admitted.Path, fresh.Path, false))
                if (named.Entry.Identity() != opened.Identity()) throw new WorkspaceReadException("File identity changed before execution.");
            EditStage?.Invoke("boundary");
            mutationStarted = true;
            opened.Rewrite(Encoding.UTF8.GetBytes(fresh.After));
            EditStage?.Invoke("written");
            var result = ReadFileWithin(admitted.Path, fresh.Path);
            if (!string.Equals((string)result["hash"]!, fresh.ResultingHash, StringComparison.Ordinal)) throw new WorkspaceReadException("File verification failed; inspect the retained operation.");
            return new() { ["path"] = result["path"], ["hash"] = result["hash"] };
        }
        catch (Exception error)
        {
            throw new RepositoryException(error.Message, mutationStarted ? "unknown" : "none", error);
        }
    }

    private static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
}
