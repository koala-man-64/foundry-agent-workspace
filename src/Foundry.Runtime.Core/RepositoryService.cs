using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
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

    /// <summary>As <see cref="Open"/>, or null when the path names an existing entry that is not a directory.</summary>
    internal static RepositoryAdmission? TryOpenDirectory(RuntimeLoop loop, string candidate)
    {
        if (RepositoryFolderLease.TryOpen(loop, candidate) is not { } folder) return null;
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
/// <see cref="GitCommandException"/> carrying TypeScript's message, and neither claims an outcome: only the caller that
/// knows its final mutation boundary classifies one (<see cref="RepositoryException"/>). Node's raw filesystem errors
/// become fixed messages.
/// </summary>
internal sealed partial class RepositoryService
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
        if (string.IsNullOrEmpty(candidate) || !RepositoryPaths.IsNodeAbsolute(candidate))
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
            if (inside != "true" || bare != "false") throw new WorkspaceReadException("Path must be a non-bare Git working tree.");
            return admission;
        }
        catch { admission.Dispose(); throw; }
    }

    /// <summary>One Git process in the admitted folder; a folder with no repository is refused before anything runs.</summary>
    internal Task<GitOutput> Run(RepositoryAdmission admission, IReadOnlyList<string> arguments, bool permitTruncation = false, bool allowNonZero = false, GitOptions? options = null)
    {
        if (admission.Identity is null) throw new WorkspaceReadException(NoRepository);
        return Git.Run(admission, arguments, permitTruncation, allowNonZero, options);
    }

    /// <summary>isGitWorkingTree: a security refusal propagates; any other failure classifies the folder as not Git.</summary>
    internal async Task<bool> IsGitWorkingTree(string root)
    {
        // TypeScript walks up from a file to the enclosing repository and then fails requireRoot inside its catch-all, so an
        // existing entry that is not a directory is simply not a Git working tree. Native does not read the ancestors' Git
        // metadata for it.
        using var identity = RepositoryAdmission.TryOpenDirectory(loop, root);
        if (identity?.Identity is null) return false;
        try
        {
            using var selected = await RequireRepository(root);
            var top = JsJson.Trim((await Run(selected, ["rev-parse", "--show-toplevel"])).Stdout);
            // Git's own report is opened only when it names a fixed local drive: nothing in it can reach the network.
            var lexical = FinalPath.Resolve(top);
            if (NetworkPathPolicy.IsNetworkOrDevicePath(top) || !DataClassifier.IsLocal(lexical) || new DriveInfo(lexical[..3]).DriveType is not DriveType.Fixed
                || !FinalPath.TryResolve(lexical, out var canonical)) return false;
            return EcmaScriptCase.ToLower(FinalPath.Resolve(selected.Path)) == EcmaScriptCase.ToLower(FinalPath.Resolve(canonical));
        }
        catch (Exception error) when (error is InvalidOperationException or IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception) { return false; }
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
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { throw new WorkspaceReadException(Unreadable); }
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

    /// <remarks>With <paramref name="rewrite"/>, the entry is opened for one exclusive in-place rewrite
    /// (<see cref="ExistingEntry.TryOpenForRewrite"/>) instead of shared reading.</remarks>
    internal static SafeEntry OpenSafe(string root, string relativePath, bool allowDirectory, bool rewrite = false)
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
            try { entry = rewrite ? ExistingEntry.TryOpenForRewrite(candidate) : ExistingEntry.TryOpen(candidate); }
            catch (IOException) { throw new WorkspaceReadException(rewrite ? EditUnavailable : Unreadable); }
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

    internal async Task<List<string>> UncommittedPaths(RepositoryAdmission admission) => [.. (await ChangedEntries(admission)).Select(entry => entry.Path)];

    /// <summary>Each status entry's path and, for a rename or copy in either status column, its source, which porcelain v1
    /// writes after it. An intent-to-add path renamed in the worktree is reported in the second column.</summary>
    private async Task<List<(string Path, string? Source)>> ChangedEntries(RepositoryAdmission admission)
    {
        var fields = (await Run(admission, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).Stdout.Split('\0');
        var entries = new List<(string Path, string? Source)>();
        for (var index = 0; index < fields.Length; index++)
        {
            var entry = fields[index];
            if (entry.Length == 0) continue;
            var path = entry.Length > 3 ? entry[3..] : "";
            if (entry[0] is 'R' or 'C' || entry.Length > 1 && entry[1] is 'R' or 'C') entries.Add((path, ++index < fields.Length ? fields[index] : null));
            else entries.Add((path, null));
        }
        return entries;
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
            // Unsupported, denied or unreadable untracked content remains unavailable, as TypeScript's catch-all skips it.
            catch (Exception error) when (error is InvalidOperationException or IOException or UnauthorizedAccessException) { continue; }
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
            if (first.Length == 0 || second is { Length: 0 }) throw new WorkspaceReadException("Git returned malformed changed-path data.");
            string[] paths = second is null ? [first] : [first, second];
            count += paths.Length;
            if (count > MaximumPaths) throw new WorkspaceReadException("Too many changed paths to safely render a diff.");
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
            if (path.Length == 0) throw new WorkspaceReadException("Git returned malformed changed-path data.");
            if (code.StartsWith('D') && RepositoryPaths.IsDeniedRelativePath(path)) return true;
        }
        return false;
    }

    private async Task RejectCoreWorktree(RepositoryAdmission admission)
    {
        var result = await Run(admission, ["config", "--null", "--get-all", "core.worktree"], allowNonZero: true);
        if (result.ExitCode == 1) return;
        if (result.ExitCode != 0) throw new WorkspaceReadException("Unable to inspect Git core.worktree configuration.");
        if (result.Stdout.Length > 0) throw new WorkspaceReadException("Repository configures core.worktree; refusing to materialize files outside the app-owned worktree.");
    }

    internal async Task RejectTrackedFilters(RepositoryAdmission admission)
    {
        var tracked = (await Run(admission, ["ls-files", "-z"])).Stdout.Split('\0').Where(name => name.Length > 0).ToList();
        if (tracked.Count > MaximumPaths) throw new WorkspaceReadException("Repository has too many tracked paths to safely inspect filters.");
        await RejectFilters(admission, tracked);
    }

    /// <summary>Any path with a filter attribute is refused: clean and smudge filters run arbitrary commands during add and checkout.</summary>
    internal async Task RejectFilters(RepositoryAdmission admission, IReadOnlyList<string> candidates)
    {
        if (candidates.Count > MaximumPaths) throw new WorkspaceReadException("Too many paths to safely inspect filters.");
        for (var index = 0; index < candidates.Count; index += 100)
        {
            var values = (await Run(admission, ["check-attr", "-z", "filter", "--", .. candidates.Skip(index).Take(100)])).Stdout.Split('\0');
            if (Filtered(values)) throw new WorkspaceReadException("Repository uses Git filters; refusing because filters may execute code.");
        }
    }

    /// <summary>Filter attributes come from the selected tree, which may differ from the current checkout.</summary>
    internal async Task RejectTrackedFiltersAtRevision(RepositoryAdmission admission, string commit)
    {
        // Callers pass the full object id rev-parse returned, never a name Git could read as an option or another revision.
        if (!(commit.Length is 40 or 64) || !commit.All(char.IsAsciiHexDigitLower)) throw new WorkspaceReadException("A full local commit object id is required.");
        var tracked = (await Run(admission, ["ls-tree", "-r", "-z", "--name-only", commit])).Stdout.Split('\0').Where(name => name.Length > 0).ToList();
        if (tracked.Count > MaximumPaths) throw new WorkspaceReadException("Repository has too many tracked paths to safely inspect filters.");
        for (var index = 0; index < tracked.Count; index += 100)
        {
            var values = (await Run(admission, ["check-attr", $"--source={commit}", "-z", "filter", "--", .. tracked.Skip(index).Take(100)])).Stdout.Split('\0');
            if (Filtered(values)) throw new WorkspaceReadException("Selected revision uses Git filters; refusing because checkout may execute code.");
        }
    }

    private static bool Filtered(string[] values) => values.Where((value, position) => position % 3 == 2 && value.Length > 0 && value != "unspecified").Any();

    /// <summary>
    /// The per-common-repository queue (TypeScript's creating map), keyed by <see cref="GitAdmissionIdentity.SerializationKey"/>:
    /// operations with one key run one at a time in arrival order, a failure never blocks its successor, and the key is
    /// released when its last operation settles. As TypeScript's .then always defers, an operation starts only after its
    /// key is registered and the caller has its task, never synchronously inside this call.
    /// </summary>
    internal async Task<T> Serialize<T>(string key, Func<Task<T>> operation)
    {
        loop.AssertCurrent();
        var previous = creating.GetValueOrDefault(key) ?? Task.CompletedTask;
        var registered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var current = After(previous, registered.Task, operation);
        creating[key] = current;
        registered.SetResult();
        try { return await current; }
        finally { if (creating.TryGetValue(key, out var latest) && ReferenceEquals(latest, current)) creating.Remove(key); }

        static async Task<T> After(Task previous, Task registered, Func<Task<T>> operation)
        {
            await registered;
            try { await previous; } catch (Exception) { /* A failed predecessor never blocks its successor. */ }
            return await operation();
        }
    }

    internal bool IsSerializing(string key) { loop.AssertCurrent(); return creating.ContainsKey(key); }

    internal sealed record CreatedWorktree(string WorktreePath, string Branch, string BaseCommit);

    /// <summary>Test seam: awaited inside the serialized section just before the worktree base is prepared, where
    /// TypeScript's own tests intercept prepareWorktreeBase.</summary>
    internal Func<Task>? PreparingWorktreeBase { get; set; }

    /// <summary>
    /// createTaskWorktree: an app-owned worktree for a new task, serialized per common repository. The caller's admitted
    /// identity is revalidated across every await, at the final boundary before `worktree add`, and before checkout.
    /// A failure before that boundary is "none"; any failure after it is "unknown", and nothing ever retries it.
    /// </summary>
    internal async Task<CreatedWorktree> CreateTaskWorktree(string projectPath, string taskId, GitAdmissionIdentity? admitted)
    {
        loop.AssertCurrent();
        RepositoryAdmission? project = null;
        GitAdmissionIdentity identity;
        try
        {
            project = RepositoryAdmission.Open(loop, projectPath);
            identity = admitted ?? project.Identity ?? throw new WorkspaceReadException(NoRepository);
            project.Revalidate(identity);
        }
        catch (Exception error) when (error is InvalidOperationException or IOException or UnauthorizedAccessException)
        {
            project?.Dispose();
            throw new RepositoryException(error.Message, "none", error);
        }
        using (project) return await Serialize(identity.SerializationKey, () => CreateTaskWorktreeSerialized(project, taskId, identity));
    }

    private async Task<CreatedWorktree> CreateTaskWorktreeSerialized(RepositoryAdmission project, string taskId, GitAdmissionIdentity identity)
    {
        var mutationStarted = false;
        try
        {
            project.Revalidate(identity);
            string baseCommit;
            using (var root = await RequireRepository(project.Path))
            {
                project.Revalidate(identity);
                baseCommit = JsJson.Trim((await Run(root, ["rev-parse", "--verify", "HEAD^{commit}"])).Stdout);
                project.Revalidate(identity);
                if (baseCommit.Length == 0) throw new WorkspaceReadException("Repository does not have a valid HEAD commit.");
                await RejectTrackedFiltersAtRevision(root, baseCommit);
                project.Revalidate(identity);
            }
            var id = RequireTaskId(taskId);
            var branch = "codex/task/" + id;
            if (PreparingWorktreeBase is { } preparing) await preparing();
            var (lease, worktreeBase) = PrepareWorktreeBase();
            using (lease)
            {
                var worktreePath = Path.Join(worktreeBase, id);
                project.Revalidate(identity);
                await Run(project, ["worktree", "add", "--no-checkout", "-b", branch, worktreePath, baseCommit], options: new(BeforeMutation: () =>
                {
                    project.Revalidate(identity);
                    // Set only at the final process boundary; every later failure leaves an unknown outcome.
                    mutationStarted = true;
                }));
                project.Revalidate(identity);
                using var worktree = RepositoryAdmission.Open(loop, worktreePath);
                if (worktree.Identity is not { } created || !string.Equals(created.Common, identity.Common, StringComparison.Ordinal))
                    throw new WorkspaceReadException("Created worktree does not belong to the admitted repository.");
                // Checkout may run filters, so it follows the filter check at the selected revision, with hooks disabled.
                await Run(worktree, ["checkout", "--no-recurse-submodules", branch], options: new(BeforeMutation: () => project.Revalidate(identity)));
                project.Revalidate(identity);
                return new(worktreePath, branch, baseCommit);
            }
        }
        catch (RepositoryException) { throw; }
        catch (Exception error)
        {
            throw new RepositoryException(error.Message, mutationStarted ? "unknown" : "none", error);
        }
    }

    /// <summary>
    /// prepareWorktreeBase: the base and its empty hooks directory exist. The base's existing chain is pinned and verified
    /// free of reparse points before anything is created beneath it, and the base stays pinned while the worktree is added.
    /// </summary>
    private (DirectoryLease Lease, string Path) PrepareWorktreeBase()
    {
        const string Unavailable = "The app-owned worktree folder is unavailable.";
        var requested = FinalPath.Resolve(WorktreeBase);
        if (!DataClassifier.IsLocal(requested) || RepositoryPaths.HasAmbiguousSegment(requested)) throw new WorkspaceReadException(Unavailable);
        try
        {
            using (DirectoryLease.Acquire(requested)) Directory.CreateDirectory(@"\\?\" + requested);
            var lease = DirectoryLease.AcquireExistingSharingWrites(requested);
            try
            {
                if (!FinalPath.TryResolve(requested, out var resolved) || !DataClassifier.IsLocal(resolved)) throw new WorkspaceReadException(Unavailable);
                Directory.CreateDirectory(@"\\?\" + Path.Join(resolved, GitRunner.EmptyHooksDirectory));
                return (lease, resolved);
            }
            catch { lease.Dispose(); throw; }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { throw new WorkspaceReadException(Unavailable); }
    }

    internal async Task<string> HeadCommit(string worktreePath)
    {
        using var repository = await RequireRepository(worktreePath);
        return JsJson.Trim((await Run(repository, ["rev-parse", "HEAD"])).Stdout);
    }

    internal sealed record CommitResult(string Commit, List<string> ChangedPaths);

    /// <summary>
    /// commitAll: the user's explicit commit of every change in the task worktree. Refusals before staging are "none";
    /// from `git add` on, every failure is "unknown". Admission failures before that carry no outcome, so the caller treats
    /// them as unknown, as TypeScript does. Secret-named paths are never staged, hooks stay disabled, signing is off, and
    /// the identity comes from the user's Git configuration. Since the review of #36, in both runtimes: the worktree must still belong to the task's
    /// project repository (<see cref="RequireTaskWorktree"/>), the source of a staged rename or copy is screened as well
    /// as its destination, and the staged screen lists paths without rename detection, so a secret-named path cannot be
    /// committed under another name.
    /// </summary>
    internal async Task<CommitResult> CommitAll(string root, string projectPath, string? boundCommon, string expectedBranch, string message)
    {
        using var repository = await RequireRepository(root);
        await RequireTaskWorktree(repository, projectPath, boundCommon);
        var branch = JsJson.Trim((await Run(repository, ["rev-parse", "--abbrev-ref", "HEAD"])).Stdout);
        if (branch != expectedBranch) throw new RepositoryException($"The worktree is on {branch}, not the task branch {expectedBranch}.");
        var entries = await ChangedEntries(repository);
        var dirty = entries.Select(entry => entry.Path).ToList();
        if (dirty.Count == 0) throw new RepositoryException("There are no changes to commit.");
        var denied = entries.SelectMany(entry => entry.Source is null ? [entry.Path] : new[] { entry.Path, entry.Source }).Where(RepositoryPaths.IsDeniedRelativePath).ToList();
        if (denied.Count > 0) throw new RepositoryException($"Refusing to commit secret-named paths: {string.Join(", ", denied.Take(5))}. Remove or ignore them first.");
        // `git add` runs clean filters, and attributes may have changed since the worktree was created.
        try { await RejectTrackedFilters(repository); await RejectFilters(repository, dirty); }
        catch (Exception error) when (error is InvalidOperationException or IOException) { throw new RepositoryException(error.Message, "none", error); }
        try
        {
            await Run(repository, ["add", "--all", "--", "."]);
            var staged = (await Run(repository, ["diff", "--cached", "--name-only", "-z"])).Stdout.Split('\0').Where(path => path.Length > 0).ToList();
            if (staged.Count == 0) { await Run(repository, ["reset", "-q"]); throw new WorkspaceReadException("Nothing was staged."); }
            var screened = (await Run(repository, ["diff", "--cached", "--name-only", "--no-renames", "-z"])).Stdout.Split('\0').Where(path => path.Length > 0);
            if (staged.Concat(screened).Any(RepositoryPaths.IsDeniedRelativePath)) { await Run(repository, ["reset", "-q"]); throw new WorkspaceReadException("A secret-named path was staged; the index was reset and nothing was committed."); }
            await Run(repository, ["-c", "commit.gpgsign=false", "commit", "--quiet", "--no-verify", "-m", message]);
            return new(JsJson.Trim((await Run(repository, ["rev-parse", "--verify", "HEAD^{commit}"])).Stdout), staged);
        }
        catch (Exception error) { throw new RepositoryException(error.Message, "unknown", error); }
    }

    /// <summary>
    /// push: the user's explicit push of the task branch to a remote configured in the project repository. It never
    /// forces or prompts; only here may the user's credential helper run. Any failure of the push itself is "unknown".
    /// Since the review of #36, in both runtimes: the worktree must still belong to the task's project repository, whose remotes are the ones
    /// checked (<see cref="RequireTaskWorktree"/>), and the repository's own configuration must pass
    /// <see cref="RequireTrustedPushConfiguration"/>.
    /// </summary>
    internal async Task<string> Push(string root, string projectPath, string? boundCommon, string remote, string branch)
    {
        using var repository = await RequireRepository(root);
        using var project = await RequireRepository(projectPath);
        RequireTaskWorktree(repository, project, boundCommon);
        var url = await Run(project, ["remote", "get-url", "--", remote], allowNonZero: true);
        if (url.ExitCode != 0 || JsJson.Trim(url.Stdout).Length == 0) throw new RepositoryException($"Remote {remote} is not configured in the project repository.");
        var current = JsJson.Trim((await Run(repository, ["rev-parse", "--abbrev-ref", "HEAD"])).Stdout);
        if (current != branch) throw new RepositoryException($"The worktree is on {current}, not the task branch {branch}.");
        try
        {
            await RequireTrustedPushConfiguration(repository);
            var pushUrls = (await Run(repository, ["remote", "get-url", "--push", "--all", "--", remote])).Stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries);
            RequireSupportedRemotes(remote, pushUrls);
        }
        catch (Exception error) when (error is not RepositoryException && error is InvalidOperationException or IOException) { throw new RepositoryException(error.Message, "none", error); }
        try
        {
            var result = await Run(repository, [.. TrustedProtocols, "push", "--no-verify", "--porcelain", "--", remote, $"refs/heads/{branch}:refs/heads/{branch}"],
                options: new(TimeSpan.FromMilliseconds(120_000), AllowCredentialHelper: true));
            return JsJson.Trim(result.Stdout);
        }
        catch (Exception error) { throw new RepositoryException(error.Message, "unknown", error); }
    }

    /// <summary>verifyPushOutcome: whether the remote branch contains the attempted commit; null when that cannot be established.</summary>
    internal async Task<bool?> VerifyPushOutcome(string projectPath, string worktreePath, string? boundCommon, string remote, string branch, string? expectedCommit)
    {
        try
        {
            using var project = await RequireRepository(projectPath);
            var commit = expectedCommit ?? await TaskWorktreeHead(worktreePath, project, boundCommon);
            // Since the review of #36, in both runtimes: ls-remote reads the remote's fetch URLs, so a remote whose push URLs differ cannot be
            // verified here; it stays unknown rather than being judged against another server.
            var fetchUrls = await Run(project, ["remote", "get-url", "--all", "--", remote], allowNonZero: true);
            var pushUrls = await Run(project, ["remote", "get-url", "--push", "--all", "--", remote], allowNonZero: true);
            if (fetchUrls.ExitCode != 0 || pushUrls.ExitCode != 0 || !string.Equals(fetchUrls.Stdout, pushUrls.Stdout, StringComparison.Ordinal)) return null;
            RequireSupportedRemotes(remote, fetchUrls.Stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries));
            await RequireTrustedPushConfiguration(project);
            var result = await Run(project, [.. TrustedProtocols, "ls-remote", "--heads", remote, $"refs/heads/{branch}"], allowNonZero: true, options: new(AllowCredentialHelper: true));
            if (result.ExitCode != 0) return null;
            var output = JsJson.Trim(result.Stdout);
            var match = RemoteTip().Match(output);
            if (!match.Success) return output.Length == 0 ? false : null;
            var tip = match.Groups[1].Value;
            if (string.Equals(tip, commit, StringComparison.OrdinalIgnoreCase)) return true;
            return (await Run(project, ["merge-base", "--is-ancestor", commit, tip], allowNonZero: true)).ExitCode == 0 ? true : null;
        }
        catch (Exception error) when (error is InvalidOperationException or IOException or UnauthorizedAccessException) { return null; }
    }

    /// <summary>The task worktree's HEAD, read only once the worktree still belongs to the task's project repository.</summary>
    private async Task<string> TaskWorktreeHead(string worktreePath, RepositoryAdmission project, string? boundCommon)
    {
        using var worktree = await RequireRepository(worktreePath);
        RequireTaskWorktree(worktree, project, boundCommon);
        return JsJson.Trim((await Run(worktree, ["rev-parse", "HEAD"])).Stdout);
    }

    /// <summary>
    /// verifyCommitOutcome: whether the ambiguous commit is the clean HEAD on its base with the expected message. Since the
    /// review of #36, in both runtimes: a worktree that no longer belongs to the task's project repository proves nothing, so it stays unknown.
    /// </summary>
    internal async Task<bool?> VerifyCommitOutcome(string worktreePath, string projectPath, string? boundCommon, string? baseCommit, string? expectedMessage)
    {
        if (string.IsNullOrEmpty(baseCommit)) return null;
        try
        {
            using var repository = await RequireRepository(worktreePath);
            using (var project = await RequireRepository(projectPath)) RequireTaskWorktree(repository, project, boundCommon);
            var head = JsJson.Trim((await Run(repository, ["rev-parse", "HEAD"])).Stdout);
            if (head == baseCommit) return false;
            var parent = await Run(repository, ["rev-parse", "HEAD^"], allowNonZero: true);
            var log = await Run(repository, ["log", "-1", "--format=%B", "HEAD"], allowNonZero: true);
            var messageMatches = string.IsNullOrEmpty(expectedMessage) || JsJson.Trim(log.Stdout) == JsJson.Trim(expectedMessage);
            var clean = (await UncommittedPaths(repository)).Count == 0;
            return parent.ExitCode == 0 && JsJson.Trim(parent.Stdout) == baseCommit && messageMatches && clean ? true : null;
        }
        catch (Exception error) when (error is InvalidOperationException or IOException or UnauthorizedAccessException) { return null; }
    }

    /// <summary>
    /// removeWorktree: `git worktree remove` without --force, so Git itself refuses untracked or modified files; the
    /// branch is kept. Only a worktree inside the app-owned base qualifies. A failed removal that left the worktree in
    /// place is "none"; one that removed it is "unknown".
    /// </summary>
    internal async Task RemoveWorktree(string projectPath, string worktreePath)
    {
        using var project = await RequireRepository(projectPath);
        var requested = FinalPath.Resolve(WorktreeBase);
        if (NetworkPathPolicy.IsNetworkOrDevicePath(worktreePath)) throw new WorkspaceReadException(RepositoryFolderLease.Network);
        if (!DataClassifier.IsLocal(requested) || !FinalPath.TryResolve(requested, out var worktreeBase)) throw new WorkspaceReadException("The app-owned worktree folder is unavailable.");
        if (!DataClassifier.IsLocal(FinalPath.Resolve(worktreePath)) || !FinalPath.TryResolve(worktreePath, out var target)) throw new WorkspaceReadException(Missing);
        if (!RepositoryPaths.IsInside(worktreeBase, target) || RepositoryPaths.IsInside(target, worktreeBase)) throw new RepositoryException("Only app-owned task worktrees can be retired.");
        try { await Run(project, ["worktree", "remove", "--", target]); }
        catch (Exception error)
        {
            // As TypeScript's stat, a worktree whose presence cannot be established counts as gone: the outcome is unknown.
            bool stillThere;
            try { stillThere = MetadataFile.Probe(target) is not MetadataEntryKind.Missing; } catch (IOException) { stillThere = false; }
            throw new RepositoryException(error.Message, stillThere ? "none" : "unknown", error);
        }
    }

    /// <summary>Transports a push or remote check may use: https, ssh and local paths. Plain git, http and ext:: are denied
    /// by name too, because a protocol-specific key in the user's global configuration would beat the generic one.</summary>
    private static readonly string[] TrustedProtocols =
    [
        "-c", "protocol.allow=never", "-c", "protocol.ext.allow=never", "-c", "protocol.git.allow=never", "-c", "protocol.http.allow=never",
        "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always", "-c", "protocol.file.allow=always",
    ];

    internal static string UnsupportedRemote(string remote) => $"Remote {remote} points at a network share, through a link, or at a location push does not use.";

    internal static string RelativeRemote(string remote) => $"Remote {remote} is not a full local path, such as C:\\repos\\name.git, which push requires for a local remote.";

    /// <summary>
    /// Decision 8 for remotes: whether a remote URL, as Git resolves it, names a network share (UNC, device or any file://
    /// host form) or a drive letter that is mapped to one or unavailable, where any access would make Windows
    /// authenticate to a server. Git percent-decodes file:// URLs before using them, so any file:// URL holding a percent
    /// sign is refused outright rather than decoded here. https, ssh and scp-like URLs are transports, limited by
    /// <see cref="TrustedProtocols"/>.
    /// </summary>
    internal static bool IsNetworkRemote(string url)
    {
        if (LocalRemotePath(url) is not { } value) return !IsTransportRemote(url);
        if (NetworkPathPolicy.IsNetworkOrDevicePath(value)) return true;
        if (value.Length >= 2 && char.IsAsciiLetter(value[0]) && value[1] == ':')
            return new DriveInfo(value[..1]).DriveType is DriveType.Network or DriveType.NoRootDirectory;
        return false;
    }

    /// <summary>
    /// Whether Git, under <see cref="TrustedProtocols"/>, would use a remote URL's transport at all: https, ssh and file
    /// URLs with the lowercase schemes Git matches, scp-like ssh, and local paths. Git refuses any other scheme, any other
    /// spelling of these, and every `&lt;helper&gt;::` form only once the command runs, which would leave a push's outcome
    /// unknown and its remote check unable to resolve it. Git also refuses, before it connects, a URL with leading
    /// whitespace (it does not trim), one starting with `-`, `rsync:`, and an ssh URL whose host starts with `-`.
    /// </summary>
    internal static bool IsPermittedRemoteForm(string url)
    {
        if (url.Length > 0 && (url[0] == '-' || JsJson.Trim(url[..1]).Length == 0) || url.StartsWith("rsync:", StringComparison.Ordinal)) return false;
        var value = JsJson.Trim(url);
        if (HelperTransport().IsMatch(value)) return false;
        var scheme = value.IndexOf("://", StringComparison.Ordinal);
        if (scheme < 0) return true;
        var name = value[..scheme];
        if (name is not ("https" or "ssh" or "git+ssh" or "ssh+git" or "file")) return false;
        return name is "https" or "file" || !value[(scheme + 3)..].StartsWith('-');
    }

    [GeneratedRegex(@"^[A-Za-z][A-Za-z0-9+.-]*::", RegexOptions.CultureInvariant)]
    private static partial Regex HelperTransport();

    /// <summary>An https, ssh, scp-like or other scheme URL that is not file://.</summary>
    private static bool IsTransportRemote(string url)
    {
        var value = JsJson.Trim(url);
        var scheme = value.IndexOf("://", StringComparison.Ordinal);
        if (scheme > 0) return !value[..scheme].Equals("file", StringComparison.OrdinalIgnoreCase);
        // scp-like [user@]host:path: a colon before any slash, and not a drive letter.
        var colon = value.IndexOf(':', StringComparison.Ordinal);
        var separator = value.IndexOfAny(['/', '\\']);
        return colon > 1 && (separator < 0 || colon < separator);
    }

    /// <summary>The local path a remote URL names (a plain path, or a file:// URL with no host and no percent sign); null for
    /// a transport URL and for any file:// URL that is refused. Git opens `file://localhost/...` as the UNC path
    /// `//localhost/...`, so a host, localhost included, is a share.</summary>
    private static string? LocalRemotePath(string url)
    {
        if (IsTransportRemote(url)) return null;
        var value = JsJson.Trim(url);
        var scheme = value.IndexOf("://", StringComparison.Ordinal);
        if (scheme < 0) return value;
        var rest = value[(scheme + 3)..];
        if (rest.Contains('%', StringComparison.Ordinal)) return null;
        var slash = rest.IndexOf('/', StringComparison.Ordinal);
        var host = slash < 0 ? rest : rest[..slash];
        if (host.Length > 0) return null;
        var path = slash < 0 ? "" : rest[slash..];
        return path.Length > 2 && path[0] == '/' && char.IsAsciiLetter(path[1]) && path[2] == ':' ? path[1..] : path;
    }

    /// <summary>
    /// Every URL a push or remote check would use must be in a form Git uses under <see cref="TrustedProtocols"/>
    /// (<see cref="IsPermittedRemoteForm"/>), and must be a transport or a fully qualified local folder (`C:\...`, `C:/...`
    /// or `file:///C:/...`) on a fixed local drive whose existing chain holds no link of any kind (checked without following
    /// one), so the named path is neither a share nor reached through a link to one. The check is not held across the push.
    /// A relative local path is refused, Git's `~` expansion and drive-relative paths (`C:repo`) with it, with its own message
    /// (Rudy, 17 October 2026). Content that arrives with a project cannot know where it is unpacked, so this is how it would
    /// name a destination the project ships, and Git opens
    /// a destination's own layout (`&lt;path&gt;/.git`, `&lt;path&gt;.git`, a gitfile, objects/info/alternates), which can
    /// lead elsewhere, a share included, and runs its receive-pack hooks. Neither is screened, in either runtime: a fully
    /// qualified destination is the user's own and is trusted.
    /// </summary>
    private static void RequireSupportedRemotes(string remote, IEnumerable<string> urls)
    {
        foreach (var url in urls)
        {
            if (!IsPermittedRemoteForm(url) || IsNetworkRemote(url)) throw new RepositoryException(UnsupportedRemote(remote));
            if (LocalRemotePath(url) is not { } local) continue;
            if (local.Contains('\0', StringComparison.Ordinal) || RepositoryPaths.HasAmbiguousSegment(local)) throw new RepositoryException(UnsupportedRemote(remote));
            var resolved = Path.GetFullPath(local);
            if (!DataClassifier.IsLocal(resolved)) throw new RepositoryException(UnsupportedRemote(remote));
            try { using (DirectoryLease.AcquireSharingWrites(resolved)) { } }
            catch (IOException error) { throw new RepositoryException(UnsupportedRemote(remote), "none", error); }
        }
    }

    private static readonly HashSet<string> TrustedCoreKeys = new(StringComparer.Ordinal)
    {
        "repositoryformatversion", "filemode", "bare", "logallrefupdates", "symlinks", "ignorecase",
        "autocrlf", "eol", "safecrlf", "longpaths", "precomposeunicode", "quotepath", "fscache",
    };

    /// <summary>
    /// Since the review of #36, in both runtimes (Rudy chose the allowlist on 17 October 2026). Push and remote verification honor
    /// the repository's own configuration, which can run programs (credential helpers, core.sshCommand, transport
    /// programs, ext:: URLs) or redirect where and how Git connects. Before either runs, every key that the repository's
    /// configuration sets (its local and worktree scopes, with everything they include) must be one that neither runs a
    /// program nor changes the connection. Anything else, including include directives, refuses with "none". The user's
    /// global configuration is theirs and is not screened. A blocklist could never be complete; unknown keys refuse.
    /// Limits, accepted by Rudy on 17 October 2026: a remote that is a local folder path runs that destination
    /// repository's own receive-pack hooks and configuration, as Git's local transport does not pass this process's
    /// settings on; and the configuration is screened just before the push, so a same-user process that rewrites it in
    /// between is not detected. Network shares are refused separately (<see cref="IsNetworkRemote"/>).
    /// </summary>
    private async Task RequireTrustedPushConfiguration(RepositoryAdmission admission)
    {
        var fields = (await Run(admission, ["config", "--list", "--show-scope", "-z"])).Stdout.Split('\0');
        for (var index = 0; index + 1 < fields.Length; index += 2)
        {
            if (fields[index] is "global" or "system" or "command") continue;
            var entry = fields[index + 1];
            var newline = entry.IndexOf('\n', StringComparison.Ordinal);
            var key = newline < 0 ? entry : entry[..newline];
            if (!TrustedPushKey(key, out var shown))
                throw new RepositoryException($"Push refused: the repository's own Git configuration sets {shown}, which push does not trust. Move it to your global Git configuration or remove it.");
        }
    }

    /// <summary>Whether a configuration key is inert for a push; <paramref name="shown"/> names it without its subsection,
    /// which can hold a URL with credentials.</summary>
    private static bool TrustedPushKey(string key, out string shown)
    {
        var first = key.IndexOf('.', StringComparison.Ordinal); var last = key.LastIndexOf('.');
        var section = first > 0 ? key[..first] : key; var variable = last >= 0 && last < key.Length - 1 ? key[(last + 1)..] : "";
        var subsection = first > 0 && last > first;
        shown = subsection ? $"{section}.*.{variable}" : key;
        if (first <= 0 || variable.Length == 0) return false;
        return (section, subsection) switch
        {
            ("core", false) => TrustedCoreKeys.Contains(variable),
            ("extensions", false) => true,
            ("user", false) => variable is "name" or "email" or "useconfigonly",
            ("remote", true) => variable is "url" or "pushurl" or "fetch" or "push" or "tagopt" or "prune",
            ("branch", true) => variable is "remote" or "pushremote" or "merge" or "rebase",
            ("pull", false) => variable is "rebase" or "ff",
            ("push", false) => variable is "default",
            _ => false,
        };
    }

    internal const string ForeignWorktree = "The task worktree no longer belongs to the task's project repository.";

    /// <summary>
    /// Since the review of #36, in both runtimes: before a publication mutation, the worktree must share the project repository's
    /// common directory, and that must still be the one bound when the task was created (when a binding exists). A
    /// replaced folder holding another repository, with its own configuration and remotes, is never committed to or pushed
    /// from. The held worktree admission keeps that identity pinned for the rest of the operation. Refusals are "none".
    /// </summary>
    private async Task RequireTaskWorktree(RepositoryAdmission worktree, string projectPath, string? boundCommon)
    {
        RepositoryAdmission project;
        try { project = await RequireRepository(projectPath); }
        catch (Exception error) when (error is InvalidOperationException or IOException or UnauthorizedAccessException) { throw new RepositoryException(error.Message, "none", error); }
        using (project) RequireTaskWorktree(worktree, project, boundCommon);
    }

    private static void RequireTaskWorktree(RepositoryAdmission worktree, RepositoryAdmission project, string? boundCommon)
    {
        var common = worktree.Identity?.Common;
        if (common is null || !string.Equals(common, project.Identity?.Common, StringComparison.Ordinal) || boundCommon is not null && !string.Equals(common, boundCommon, StringComparison.Ordinal))
            throw new RepositoryException(ForeignWorktree);
    }

    // SHA-1 or SHA-256 object names (review of #36, in both runtimes).
    [GeneratedRegex(@"^([0-9a-fA-F]{64}|[0-9a-fA-F]{40})\s+", RegexOptions.CultureInvariant)]
    private static partial Regex RemoteTip();

    /// <summary>requireTaskId: a UUID, lowercased, matched exactly as TypeScript's ASCII pattern does.</summary>
    private static string RequireTaskId(string taskId) => TaskId().IsMatch(taskId) ? taskId.ToLowerInvariant() : throw new WorkspaceReadException("Task id must be a UUID.");

    [GeneratedRegex(@"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\z", RegexOptions.CultureInvariant)]
    private static partial Regex TaskId();
}
