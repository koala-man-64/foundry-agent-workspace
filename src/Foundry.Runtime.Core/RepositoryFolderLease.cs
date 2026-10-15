using Foundry.Platform;

namespace Foundry.Runtime;

/// <summary>Loop-owned local folder identity pinned for a future repository operation.</summary>
internal sealed class RepositoryFolderLease : IDisposable
{
    private readonly RuntimeLoop loop;
    private readonly DirectoryLease lease;
    private RepositoryFolderLease(RuntimeLoop loop, DirectoryLease lease, string path)
    {
        this.loop = loop; this.lease = lease; Path = path;
    }
    internal string Path { get; }

    internal static RepositoryFolderLease Open(RuntimeLoop loop, string candidate)
    {
        loop.AssertCurrent();
        if (NetworkPathPolicy.IsNetworkOrDevicePath(candidate)) throw new WorkspaceReadException("Projects on network shares are not supported.");
        if (!System.IO.Path.IsPathRooted(candidate) || candidate.Length >= 2 && candidate[1] == ':' && (candidate.Length < 3 || candidate[2] is not ('\\' or '/')))
            throw new WorkspaceReadException("Repository root must be an absolute path.");
        var absolute = System.IO.Path.GetFullPath(candidate);
        if (!DataClassifier.IsLocal(absolute)) throw new WorkspaceReadException("Project folder identity cannot be established.");
        DirectoryLease lease;
        try { lease = DirectoryLease.AcquireExisting(absolute); }
        catch (IOException error) when (error.Message == "Reparse directories require data-adoption review.")
        {
            throw new WorkspaceReadException("Projects through reparse directories are not supported.");
        }
        try
        {
            if (!FinalPath.TryResolve(absolute, out var resolved) || !DataClassifier.IsLocal(resolved) || !Directory.Exists(resolved))
                throw new WorkspaceReadException("Project folder is unavailable.");
            return new(loop, lease, resolved);
        }
        catch { lease.Dispose(); throw; }
    }
    public void Dispose() { loop.AssertCurrent(); lease.Dispose(); }
}
