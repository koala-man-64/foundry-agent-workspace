using Foundry.Platform;

namespace Foundry.Runtime;

/// <summary>
/// Loop-owned local folder identity, pinned for a repository operation. Every component of the chain is pinned against
/// rename and deletion, but entries inside the pinned directories may still be created, renamed or replaced, so Git's
/// lock-file renames and ordinary file edits keep working while the lease is held.
/// </summary>
internal sealed class RepositoryFolderLease : IDisposable
{
    internal const string Network = "Projects on network shares are not supported.";
    internal const string Reparse = "Projects through reparse directories are not supported.";
    internal const string Unavailable = "Project folder is unavailable.";
    private readonly RuntimeLoop loop;
    private readonly DirectoryLease lease;
    private RepositoryFolderLease(RuntimeLoop loop, DirectoryLease lease, string path)
    {
        this.loop = loop; this.lease = lease; Path = path;
    }
    internal string Path { get; }

    /// <param name="notDirectory">The caller's refusal for an existing entry that is not a directory, as TypeScript words it at that call site.</param>
    internal static RepositoryFolderLease Open(RuntimeLoop loop, string candidate, string notDirectory = Unavailable)
    {
        loop.AssertCurrent();
        if (NetworkPathPolicy.IsNetworkOrDevicePath(candidate)) throw new WorkspaceReadException(Network);
        if (!System.IO.Path.IsPathRooted(candidate) || candidate.Length >= 2 && candidate[1] == ':' && (candidate.Length < 3 || candidate[2] is not ('\\' or '/')))
            throw new WorkspaceReadException("Repository root must be an absolute path.");
        var absolute = System.IO.Path.GetFullPath(candidate);
        if (!DataClassifier.IsLocal(absolute)) throw new WorkspaceReadException("Project folder identity cannot be established.");
        if (new DriveInfo(absolute[..3]).DriveType is DriveType.Network) throw new WorkspaceReadException(Network);
        DirectoryLease lease;
        try { lease = DirectoryLease.AcquireExistingSharingWrites(absolute); }
        catch (ReparsePointException) { throw new WorkspaceReadException(Reparse); }
        catch (IOException)
        {
            // Classification only: the refusal already happened, and nothing is admitted from this probe.
            MetadataEntryKind kind;
            try { kind = MetadataFile.Probe(absolute); } catch (IOException) { kind = MetadataEntryKind.Missing; }
            throw new WorkspaceReadException(kind is MetadataEntryKind.File ? notDirectory : Unavailable);
        }
        try
        {
            if (!FinalPath.TryResolve(absolute, out var resolved) || !DataClassifier.IsLocal(resolved) || !Directory.Exists(resolved))
                throw new WorkspaceReadException(Unavailable);
            return new(loop, lease, resolved);
        }
        catch { lease.Dispose(); throw; }
    }
    public void Dispose() { loop.AssertCurrent(); lease.Dispose(); }
}
