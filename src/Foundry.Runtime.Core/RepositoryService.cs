using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Foundry.Platform;
using Foundry.Protocol;

namespace Foundry.Runtime;

/// <summary>
/// A folder and its Git identity held for one repository operation. Both leases stay pinned across every await of the
/// operation, and <see cref="Revalidate"/> resolves the identity again and requires exact equality (TypeScript's
/// assertGitAdmission), including that a folder with no repository still has none.
/// </summary>
internal sealed class RepositoryAdmission : IDisposable
{
    private readonly RuntimeLoop loop;
    private readonly RepositoryFolderLease folder;
    private readonly GitRepositoryLease? git;
    private readonly bool tracksIdentity;

    private RepositoryAdmission(RuntimeLoop loop, RepositoryFolderLease folder, GitRepositoryLease? git, bool tracksIdentity)
    {
        this.loop = loop; this.folder = folder; this.git = git; this.tracksIdentity = tracksIdentity;
    }

    /// <summary>The canonical folder path.</summary>
    internal string Path => folder.Path;
    internal GitAdmissionIdentity? Identity => git?.Identity;

    /// <summary>The folder and its Git identity, or no identity when no repository encloses it.</summary>
    internal static RepositoryAdmission Open(RuntimeLoop loop, string candidate, string notDirectory = RepositoryFolderLease.Unavailable)
    {
        var folder = RepositoryFolderLease.Open(loop, candidate, notDirectory);
        try { return new(loop, folder, GitRepositoryLease.Open(loop, folder), true); }
        catch { folder.Dispose(); throw; }
    }

    /// <summary>The folder alone, as TypeScript's requireRoot admits it for file access: no Git metadata is read.</summary>
    internal static RepositoryAdmission OpenFolder(RuntimeLoop loop, string candidate, string notDirectory) =>
        new(loop, RepositoryFolderLease.Open(loop, candidate, notDirectory), null, false);

    internal void Revalidate() => Revalidate(git?.Identity);

    /// <summary>Requires the current identity to equal both this admission and an earlier binding.</summary>
    internal void Revalidate(GitAdmissionIdentity? expected)
    {
        loop.AssertCurrent();
        if (!tracksIdentity) throw new InvalidOperationException("This admission does not track a Git identity.");
        if (git is not null) { git.Revalidate(expected); return; }
        using var current = GitRepositoryLease.Open(loop, folder);
        if (current is not null || expected is not null) throw new WorkspaceReadException("Project channel identity changed during admission.");
    }

    public void Dispose()
    {
        loop.AssertCurrent();
        try { git?.Dispose(); } finally { folder.Dispose(); }
    }
}

/// <summary>
/// Native counterpart of TypeScript's RepositoryService (repository.ts): local, read-only repository access, with the
/// mutation operations added by later slices. Every refusal is a <see cref="WorkspaceReadException"/> or a
/// <see cref="RepositoryException"/> carrying TypeScript's message; Node's raw filesystem errors become fixed messages.
/// </summary>
internal sealed class RepositoryService
{
    internal const int MaximumFileBytes = 64 * 1024;
    internal const int MaximumPaths = 5_000;
    internal const string SymbolicLinks = "Symbolic links cannot be accessed.";
    internal const string Missing = "Requested path does not exist.";
    internal const string NotDirectory = "Requested path is not a directory.";
    internal const string Unreadable = "Requested path cannot be read.";
    internal const string NoRepository = "Project channel requires an available local Git project.";
    internal const string WorkingDirectory = "Root must be a working directory.";
    private static readonly CompareInfo Collation = CultureInfo.GetCultureInfo("en-US").CompareInfo;
    private readonly RuntimeLoop loop;
    private readonly Dictionary<string, Task> creating = new(StringComparer.Ordinal);

    internal RepositoryService(RuntimeLoop loop, string worktreeBase, Func<IReadOnlyDictionary<string, string>>? environment = null)
    {
        loop.AssertCurrent();
        this.loop = loop; WorktreeBase = worktreeBase; Git = new GitRunner(loop, worktreeBase, environment);
    }

    internal string WorktreeBase { get; }
    internal GitRunner Git { get; }

    /// <summary>requireRoot: an absolute, local, physical directory that is not itself a Git directory.</summary>
    internal RepositoryAdmission RequireRoot(string candidate) => RequireRoot(candidate, false);

    private RepositoryAdmission RequireRoot(string candidate, bool identity)
    {
        loop.AssertCurrent();
        RequireAbsolute(candidate);
        var admission = identity ? RepositoryAdmission.Open(loop, candidate, WorkingDirectory) : RepositoryAdmission.OpenFolder(loop, candidate, WorkingDirectory);
        if (EcmaScriptCase.ToLower(System.IO.Path.GetFileName(admission.Path)) == ".git") { admission.Dispose(); throw new WorkspaceReadException(WorkingDirectory); }
        return admission;
    }

    private static void RequireAbsolute(string candidate)
    {
        if (string.IsNullOrEmpty(candidate) || !(candidate[0] is '/' or '\\' || candidate.Length > 2 && char.IsAsciiLetter(candidate[0]) && candidate[1] == ':' && candidate[2] is '/' or '\\'))
            throw new WorkspaceReadException("Repository root must be an absolute path.");
        if (NetworkPathPolicy.IsNetworkOrDevicePath(candidate)) throw new WorkspaceReadException(RepositoryFolderLease.Network);
    }

    /// <summary>requireRepository: a non-bare Git working tree whose configuration cannot move checkouts elsewhere.</summary>
    internal async Task<RepositoryAdmission> RequireRepository(string candidate)
    {
        var admission = RequireRoot(candidate, true);
        try
        {
            admission.Revalidate();
            Git.Executable(admission.Path);
            admission.Revalidate();
            await RejectCoreWorktree(admission);
            admission.Revalidate();
            var inside = JsJson.Trim((await Run(admission, ["rev-parse", "--is-inside-work-tree"])).Stdout);
            admission.Revalidate();
            var bare = JsJson.Trim((await Run(admission, ["rev-parse", "--is-bare-repository"])).Stdout);
            admission.Revalidate();
            if (inside != "true" || bare != "false") throw new RepositoryException("Path must be a non-bare Git working tree.");
            return admission;
        }
        catch { admission.Dispose(); throw; }
    }

    /// <summary>One Git process in the admitted folder; a folder with no repository is refused before anything runs.</summary>
    internal Task<GitOutput> Run(RepositoryAdmission admission, IReadOnlyList<string> arguments, bool permitTruncation = false, bool allowNonZero = false, GitOptions? options = null)
    {
        if (admission.Identity is null) throw new RepositoryException(NoRepository);
        return Git.Run(admission, admission.Path, arguments, permitTruncation, allowNonZero, options);
    }

    /// <summary>isGitWorkingTree: a security refusal propagates; any other failure classifies the folder as not Git.</summary>
    internal async Task<bool> IsGitWorkingTree(string root)
    {
        using var identity = RepositoryAdmission.Open(loop, root);
        if (identity.Identity is null) return false;
        try
        {
            using var selected = await RequireRepository(root);
            var top = JsJson.Trim((await Run(selected, ["rev-parse", "--show-toplevel"])).Stdout);
            if (NetworkPathPolicy.IsNetworkOrDevicePath(top) || !FinalPath.TryResolve(top, out var canonical)) return false;
            return EcmaScriptCase.ToLower(FinalPath.Resolve(selected.Path)) == EcmaScriptCase.ToLower(FinalPath.Resolve(canonical));
        }
        catch (Exception error) when (error is InvalidOperationException or IOException) { return false; }
        finally { identity.Revalidate(); }
    }

    internal List<Dictionary<string, object?>> ListFiles(string root, string relativePath = "")
    {
        using var admitted = RequireRoot(root);
        using var target = OpenSafe(admitted.Path, relativePath, true);
        if (!target.Entry.IsDirectory) throw new WorkspaceReadException(NotDirectory);
        var entries = new List<Dictionary<string, object?>>();
        List<(string Name, FileAttributes Attributes)> children;
        try
        {
            children = [.. new System.IO.Enumeration.FileSystemEnumerable<(string, FileAttributes)>(@"\\?\" + target.Path,
                (ref System.IO.Enumeration.FileSystemEntry entry) => (entry.FileName.ToString(), entry.Attributes),
                new EnumerationOptions { AttributesToSkip = 0, IgnoreInaccessible = false, RecurseSubdirectories = false, ReturnSpecialDirectories = false })];
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { throw new WorkspaceReadException(Unreadable); }
        foreach (var (name, attributes) in children)
        {
            // libuv reports every reparse point as a link, which listFiles skips.
            if (RepositoryPaths.IsDeniedName(name) || attributes.HasFlag(FileAttributes.ReparsePoint) || attributes.HasFlag(FileAttributes.Device)) continue;
            var relative = RepositoryPaths.PortableRelative(admitted.Path, System.IO.Path.Join(target.Path, name));
            if (relative.Length == 0 || RepositoryPaths.IsDeniedRelativePath(relative)) continue;
            entries.Add(new() { ["path"] = relative, ["kind"] = attributes.HasFlag(FileAttributes.Directory) ? "directory" : "file" });
        }
        // localeCompare in the en-US collation; OrderBy is stable, like Array.prototype.sort.
        return [.. entries.OrderBy(entry => (string)entry["path"]!, Comparer<string>.Create((left, right) => Collation.Compare(left, right, CompareOptions.None)))];
    }

    internal Dictionary<string, object?> ReadFile(string root, string relativePath)
    {
        using var admitted = RequireRoot(root);
        return ReadFileWithin(admitted.Path, relativePath);
    }

    /// <summary>readFile beneath an already admitted root: bounded, UTF-8 only, read through the verified handle.</summary>
    internal static Dictionary<string, object?> ReadFileWithin(string root, string relativePath)
    {
        using var target = OpenSafe(root, relativePath, false);
        if (target.Entry.IsDirectory) throw new WorkspaceReadException("Requested path is not a regular file.");
        var exceeds = $"File exceeds the {MaximumFileBytes} byte read limit.";
        if (target.Entry.Length > MaximumFileBytes) throw new WorkspaceReadException(exceeds);
        byte[] bytes;
        try { bytes = target.Entry.ReadBounded(MaximumFileBytes); }
        catch (InvalidDataException) { throw new WorkspaceReadException(exceeds); }
        catch (IOException) { throw new WorkspaceReadException(Unreadable); }
        if (bytes.Contains((byte)0)) throw new WorkspaceReadException("Binary files cannot be read.");
        string content;
        try { content = new UTF8Encoding(false, true).GetString(bytes); }
        catch (DecoderFallbackException) { throw new WorkspaceReadException("Binary files cannot be read."); }
        // TextDecoder consumes a leading byte order mark; the hash still covers the file's bytes.
        if (content.StartsWith('\uFEFF')) content = content[1..];
        return new() { ["path"] = RepositoryPaths.PortableRelative(root, target.Path), ["content"] = content, ["hash"] = Convert.ToHexStringLower(SHA256.HashData(bytes)) };
    }

    /// <summary>A validated relative path, its parent chain pinned and verified free of reparse points, and the entry itself
    /// opened without following one. Containment and the sensitive-name rules are checked on the entry's real path.</summary>
    internal sealed class SafeEntry(DirectoryLease chain, ExistingEntry entry, string path) : IDisposable
    {
        internal ExistingEntry Entry { get; } = entry;
        internal string Path { get; } = path;
        public void Dispose() { try { Entry.Dispose(); } finally { chain.Dispose(); } }
    }

    internal static SafeEntry OpenSafe(string root, string relativePath, bool allowDirectory)
    {
        RepositoryPaths.ValidateRelative(relativePath, allowDirectory);
        var candidate = FinalPath.Resolve(System.IO.Path.Join(root, relativePath.Length == 0 ? "." : relativePath));
        if (!RepositoryPaths.IsInside(root, candidate)) throw new WorkspaceReadException(RepositoryPaths.Escapes);
        var parent = System.IO.Path.GetDirectoryName(candidate) ?? candidate;
        DirectoryLease chain;
        try { chain = DirectoryLease.AcquireExistingSharingWrites(parent); }
        catch (ReparsePointException) { throw new WorkspaceReadException(SymbolicLinks); }
        catch (IOException) { throw new WorkspaceReadException(Missing); }
        try
        {
            ExistingEntry? entry;
            try { entry = ExistingEntry.TryOpen(candidate); }
            catch (IOException) { throw new WorkspaceReadException(Unreadable); }
            if (entry is null) throw new WorkspaceReadException(Missing);
            try
            {
                if (entry.IsReparsePoint) throw new WorkspaceReadException(SymbolicLinks);
                var resolved = entry.FinalPath() ?? throw new WorkspaceReadException(Unreadable);
                if (!RepositoryPaths.IsInside(root, resolved)) throw new WorkspaceReadException(RepositoryPaths.Escapes);
                if (RepositoryPaths.IsDeniedRelativePath(RepositoryPaths.PortableRelative(root, resolved))) throw new WorkspaceReadException("Path is not available.");
                return new(chain, entry, resolved);
            }
            catch { entry.Dispose(); throw; }
        }
        catch { chain.Dispose(); throw; }
    }

    /// <summary>Tracked modifications plus untracked files (ignored files excluded), as Git reports them. Read-only.</summary>
    internal async Task<List<string>> UncommittedPaths(string root)
    {
        using var admission = await RequireRepository(root);
        return await UncommittedPaths(admission);
    }

    internal async Task<List<string>> UncommittedPaths(RepositoryAdmission admission)
    {
        var fields = (await Run(admission, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).Stdout.Split('\0');
        var paths = new List<string>();
        for (var index = 0; index < fields.Length; index++)
        {
            var entry = fields[index];
            if (entry.Length == 0) continue;
            paths.Add(entry.Length > 3 ? entry[3..] : "");
            if (entry.StartsWith('R') || entry.StartsWith('C')) index++;
        }
        return paths;
    }

    internal async Task<Dictionary<string, object?>> Diff(string root)
    {
        using var admission = await RequireRepository(root);
        var safe = await SafeDiffPaths(admission);
        var summary = safe.Count > 0 ? (await Run(admission, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--stat", "HEAD", "--", .. safe])).Stdout : "";
        var patch = safe.Count > 0 ? await Run(admission, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--binary", "HEAD", "--", .. safe], permitTruncation: true) : new GitOutput("", false, 0);
        var omitUntracked = await HasSensitiveTrackedDeletion(admission);
        var untracked = omitUntracked ? [] : (await Run(admission, ["ls-files", "--others", "--exclude-standard", "-z"])).Stdout.Split('\0').Where(name => name.Length > 0).ToList();
        var truncated = patch.Truncated; var output = patch.Stdout; var stat = summary;
        foreach (var name in untracked.Take(100))
        {
            if (RepositoryPaths.IsDeniedRelativePath(name)) continue;
            Dictionary<string, object?> file;
            try { file = ReadFileWithin(admission.Path, name); }
            catch (InvalidOperationException) { continue; } // Unsupported or denied untracked content remains unavailable.
            var path = (string)file["path"]!;
            var addition = $"diff --git a/{path} b/{path}\nnew file\n--- /dev/null\n+++ b/{path}\n{string.Join('\n', ((string)file["content"]!).Split('\n').Select(line => "+" + line))}\n";
            if (Encoding.UTF8.GetByteCount(output + addition) > GitRunner.MaximumOutputBytes) { truncated = true; break; }
            output += addition; stat += $"{path} | new file\n";
        }
        if (omitUntracked) stat += "Untracked content omitted because a sensitive tracked deletion is present.\n";
        return new() { ["summary"] = stat, ["patch"] = output, ["truncated"] = truncated || untracked.Count > 100 || omitUntracked };
    }

    private async Task<List<string>> SafeDiffPaths(RepositoryAdmission admission)
    {
        var fields = (await Run(admission, ["diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--name-status", "-z", "HEAD", "--"])).Stdout.Split('\0');
        var safe = new List<string>(); var seen = new HashSet<string>(StringComparer.Ordinal);
        var count = 0;
        for (var index = 0; index < fields.Length - 1;)
        {
            var code = fields[index++];
            if (code.Length == 0) continue;
            var first = index < fields.Length ? fields[index++] : "";
            var second = code.StartsWith('R') || code.StartsWith('C') ? index < fields.Length ? fields[index++] : "" : null;
            if (first.Length == 0 || second is { Length: 0 }) throw new RepositoryException("Git returned malformed changed-path data.");
            string[] paths = second is null ? [first] : [first, second];
            count += paths.Length;
            if (count > MaximumPaths) throw new RepositoryException("Too many changed paths to safely render a diff.");
            // A rename or copy inherits the sensitive classification of either endpoint.
            if (paths.Any(RepositoryPaths.IsDeniedRelativePath)) continue;
            foreach (var path in paths) if (seen.Add(path)) safe.Add(path);
        }
        return safe;
    }

    private async Task<bool> HasSensitiveTrackedDeletion(RepositoryAdmission admission)
    {
        var fields = (await Run(admission, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-status", "-z", "HEAD", "--"])).Stdout.Split('\0');
        for (var index = 0; index < fields.Length - 1;)
        {
            var code = fields[index++];
            if (code.Length == 0) continue;
            var path = index < fields.Length ? fields[index++] : "";
            if (path.Length == 0) throw new RepositoryException("Git returned malformed changed-path data.");
            if (code.StartsWith('D') && RepositoryPaths.IsDeniedRelativePath(path)) return true;
        }
        return false;
    }

    private async Task RejectCoreWorktree(RepositoryAdmission admission)
    {
        var result = await Run(admission, ["config", "--null", "--get-all", "core.worktree"], allowNonZero: true);
        if (result.ExitCode == 1) return;
        if (result.ExitCode != 0) throw new RepositoryException("Unable to inspect Git core.worktree configuration.");
        if (result.Stdout.Length > 0) throw new RepositoryException("Repository configures core.worktree; refusing to materialize files outside the app-owned worktree.");
    }

    internal async Task RejectTrackedFilters(RepositoryAdmission admission)
    {
        var tracked = (await Run(admission, ["ls-files", "-z"])).Stdout.Split('\0').Where(name => name.Length > 0).ToList();
        if (tracked.Count > MaximumPaths) throw new RepositoryException("Repository has too many tracked paths to safely inspect filters.");
        await RejectFilters(admission, tracked);
    }

    /// <summary>Any path with a filter attribute is refused: clean and smudge filters run arbitrary commands during add and checkout.</summary>
    internal async Task RejectFilters(RepositoryAdmission admission, IReadOnlyList<string> candidates)
    {
        if (candidates.Count > MaximumPaths) throw new RepositoryException("Too many paths to safely inspect filters.");
        for (var index = 0; index < candidates.Count; index += 100)
        {
            var values = (await Run(admission, ["check-attr", "-z", "filter", "--", .. candidates.Skip(index).Take(100)])).Stdout.Split('\0');
            if (Filtered(values)) throw new RepositoryException("Repository uses Git filters; refusing because filters may execute code.");
        }
    }

    /// <summary>Filter attributes come from the selected tree, which may differ from the current checkout.</summary>
    internal async Task RejectTrackedFiltersAtRevision(RepositoryAdmission admission, string commit)
    {
        var tracked = (await Run(admission, ["ls-tree", "-r", "-z", "--name-only", commit])).Stdout.Split('\0').Where(name => name.Length > 0).ToList();
        if (tracked.Count > MaximumPaths) throw new RepositoryException("Repository has too many tracked paths to safely inspect filters.");
        for (var index = 0; index < tracked.Count; index += 100)
        {
            var values = (await Run(admission, ["check-attr", $"--source={commit}", "-z", "filter", "--", .. tracked.Skip(index).Take(100)])).Stdout.Split('\0');
            if (Filtered(values)) throw new RepositoryException("Selected revision uses Git filters; refusing because checkout may execute code.");
        }
    }

    private static bool Filtered(string[] values) => values.Where((value, position) => position % 3 == 2 && value.Length > 0 && value != "unspecified").Any();

    /// <summary>
    /// The per-common-repository queue (TypeScript's creating map): operations with one key run one at a time in arrival
    /// order, a failure never blocks its successor, and the key is released when its last operation settles.
    /// </summary>
    internal async Task<T> Serialize<T>(string key, Func<Task<T>> operation)
    {
        loop.AssertCurrent();
        var previous = creating.GetValueOrDefault(key) ?? Task.CompletedTask;
        var current = After(previous, operation);
        creating[key] = current;
        try { return await current; }
        finally { if (creating.TryGetValue(key, out var latest) && ReferenceEquals(latest, current)) creating.Remove(key); }

        static async Task<T> After(Task previous, Func<Task<T>> operation)
        {
            try { await previous; } catch (Exception) { /* A failed predecessor never blocks its successor. */ }
            return await operation();
        }
    }

    internal bool IsSerializing(string key) { loop.AssertCurrent(); return creating.ContainsKey(key); }
}
