using System.Text.RegularExpressions;
using Foundry.Platform;

namespace Foundry.Runtime;

/// <summary>TypeScript's GitAdmissionIdentity: canonical project path, repository root, Git directory and common directory.</summary>
internal sealed record GitAdmissionIdentity(string Path, string Root, string GitDirectory, string Common)
{
    /// <summary>Worktree creation serializes per common repository, keyed as TypeScript's common.toLowerCase().</summary>
    internal string SerializationKey => EcmaScriptCase.ToLower(Common);
}

/// <summary>
/// Loop-owned Git identity of an admitted project folder, the native counterpart of resolveGitAdmission. Every component
/// is opened without following reparse points before anything beneath it is touched, pointer files are read with a bound
/// while pinned, and every directory and pointer stays pinned until disposal. Unlike TypeScript it refuses local aliases
/// (junctions, symbolic links) and a common directory that is not a directory. Unwired: no handler uses it yet.
/// </summary>
internal sealed partial class GitRepositoryLease : IDisposable
{
    private const int MetadataBytes = 16_384;
    private const string Invalid = "Invalid Git project metadata.";
    private const string Unavailable = "Project folder is unavailable.";
    private const string Network = "Projects on network shares are not supported.";
    private const string Reparse = "Projects through reparse directories are not supported.";
    private const string Aliased = "The saved folder now resolves to a different location.";
    private const string Changed = "Project channel identity changed during admission.";
    private readonly RuntimeLoop loop;
    private readonly List<IDisposable> pins;
    private bool disposed;

    private GitRepositoryLease(RuntimeLoop loop, List<IDisposable> pins, GitAdmissionIdentity identity)
    {
        this.loop = loop; this.pins = pins; Identity = identity;
    }

    internal GitAdmissionIdentity Identity { get; }

    /// <summary>
    /// The nearest repository at or above the folder, or null when there is none. The caller keeps the folder lease open
    /// for at least as long as this lease; the folder's canonical chain, which the walk probes, is verified and pinned
    /// again here because a subst spelling admitted by the folder lease pins a different chain.
    /// </summary>
    internal static GitRepositoryLease? Open(RuntimeLoop loop, RepositoryFolderLease folder)
    {
        loop.AssertCurrent();
        var pins = new List<IDisposable>();
        GitAdmissionIdentity? identity;
        try { identity = Resolve(folder.Path, pins); }
        catch { Release(pins); throw; }
        if (identity is not null) return new(loop, pins, identity);
        Release(pins);
        return null;
    }

    /// <summary>
    /// TypeScript's assertGitAdmission: a fresh resolution must equal both this lease and the expected binding exactly.
    /// A missing or incomplete expected binding (such as an old three-field one) never matches.
    /// </summary>
    internal void Revalidate(GitAdmissionIdentity? expected)
    {
        loop.AssertCurrent();
        ObjectDisposedException.ThrowIf(disposed, this);
        var transient = new List<IDisposable>();
        try
        {
            var current = Resolve(Identity.Path, transient);
            if (current is null || !Matches(current, Identity) || !Matches(current, expected)) throw new WorkspaceReadException(Changed);
        }
        finally { Release(transient); }
    }

    public void Dispose()
    {
        loop.AssertCurrent();
        if (disposed) return;
        disposed = true;
        Release(pins);
    }

    private static GitAdmissionIdentity? Resolve(string path, List<IDisposable> pins)
    {
        Acquire(path, pins);
        var root = path;
        MetadataEntryKind kind;
        while ((kind = Probe(System.IO.Path.Join(root, ".git"))) == MetadataEntryKind.Missing)
        {
            if (System.IO.Path.GetDirectoryName(root) is not { } parent) return null;
            root = parent;
        }
        var dotGit = System.IO.Path.Join(root, ".git");
        var gitDirectory = kind switch
        {
            MetadataEntryKind.Directory => PinnedDirectory(dotGit, pins),
            MetadataEntryKind.File => PinnedDirectory(Reference(root, GitMetadataReference.ParseGitDirectory(Read(dotGit, Reparse, pins))), pins),
            _ => throw new WorkspaceReadException(Reparse),
        };
        var commonFile = System.IO.Path.Join(gitDirectory, "commondir");
        var common = Probe(commonFile) switch
        {
            MetadataEntryKind.Missing => gitDirectory,
            MetadataEntryKind.File => GitMetadataReference.ParseCommonDirectory(Read(commonFile, Aliased, pins)) is { } pointer
                ? PinnedDirectory(Reference(gitDirectory, pointer), pins)
                : gitDirectory,
            // TypeScript refuses an aliased pointer file because its real path differs from the path it read.
            MetadataEntryKind.Reparse => throw new WorkspaceReadException(Aliased),
            _ => throw new WorkspaceReadException(Invalid),
        };
        return new(path, root, gitDirectory, common);
    }

    /// <summary>Only for paths whose parent chain is already pinned and verified free of reparse points.</summary>
    private static MetadataEntryKind Probe(string path)
    {
        try { return MetadataFile.Probe(path); }
        catch (IOException) { throw new WorkspaceReadException(Unavailable); }
    }

    private static byte[] Read(string path, string reparseMessage, List<IDisposable> pins)
    {
        PinnedMetadataFile file;
        try { file = PinnedMetadataFile.OpenExisting(path); }
        catch (ReparsePointException) { throw new WorkspaceReadException(reparseMessage); }
        catch (IOException) { throw new WorkspaceReadException(Unavailable); }
        pins.Add(file);
        try { return file.ReadBounded(MetadataBytes); }
        catch (InvalidDataException) { throw new WorkspaceReadException(Invalid); }
        catch (IOException) { throw new WorkspaceReadException(Unavailable); }
    }

    private static string Reference(string basePath, string reference) => PathReference.Resolve(basePath, reference) ?? throw new WorkspaceReadException(Invalid);

    /// <summary>
    /// Pins a referenced directory and returns its canonical path. The raw reference was already screened for network
    /// and device forms; mapped network drives are refused before any open, and every component is verified free of
    /// reparse points before anything beneath it is opened, so no probe can be redirected to another location.
    /// </summary>
    private static string PinnedDirectory(string candidate, List<IDisposable> pins)
    {
        // A name Win32 would read as another entry is refused outright: a component ending in a dot or space (which
        // GetFullPath keeps when it is not the last), a stream suffix or NUL, or a reserved device name. Opens are also
        // namespaced, so verification and traversal always reach the same entry.
        if (!DataClassifier.IsLocal(candidate) || !string.Equals(System.IO.Path.GetFullPath(candidate), candidate, StringComparison.Ordinal)
            || candidate[3..].Split('\\').Any(component => component.EndsWith('.') || component.EndsWith(' ') || ReservedName().IsMatch(component)))
            throw new WorkspaceReadException(Invalid);
        if (new DriveInfo(candidate[..3]).DriveType is DriveType.Network) throw new WorkspaceReadException(Network);
        if (System.IO.Path.GetDirectoryName(candidate) is { } parent) Acquire(parent, pins);
        if (Probe(candidate) is MetadataEntryKind.File) throw new WorkspaceReadException(Invalid);
        Acquire(candidate, pins);
        if (!FinalPath.TryResolve(candidate, out var canonical) || !DataClassifier.IsLocal(canonical)) throw new WorkspaceReadException(Unavailable);
        // A subst drive or 8.3 spelling names the same objects through another chain; verify and pin that chain too.
        if (!string.Equals(canonical, candidate, StringComparison.OrdinalIgnoreCase)) Acquire(canonical, pins);
        return canonical;
    }

    private static void Acquire(string directory, List<IDisposable> pins)
    {
        // Git renames lock files into these directories while the lease is held; only the components themselves are frozen.
        try { pins.Add(DirectoryLease.AcquireExistingSharingWrites(directory)); }
        catch (ReparsePointException) { throw new WorkspaceReadException(Reparse); }
        catch (IOException) { throw new WorkspaceReadException(Unavailable); }
    }

    private static bool Matches(GitAdmissionIdentity current, GitAdmissionIdentity? expected) =>
        expected is not null && Complete(expected)
        && string.Equals(current.Path, expected.Path, StringComparison.Ordinal)
        && string.Equals(current.Root, expected.Root, StringComparison.Ordinal)
        && string.Equals(current.GitDirectory, expected.GitDirectory, StringComparison.Ordinal)
        && string.Equals(current.Common, expected.Common, StringComparison.Ordinal);

    private static bool Complete(GitAdmissionIdentity value) =>
        !string.IsNullOrEmpty(value.Path) && !string.IsNullOrEmpty(value.Root) && !string.IsNullOrEmpty(value.GitDirectory) && !string.IsNullOrEmpty(value.Common);

    private static void Release(List<IDisposable> handles)
    {
        for (var index = handles.Count - 1; index >= 0; index--) handles[index].Dispose();
        handles.Clear();
    }

    [GeneratedRegex(@"^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:[ .].*)?$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ReservedName();
}
