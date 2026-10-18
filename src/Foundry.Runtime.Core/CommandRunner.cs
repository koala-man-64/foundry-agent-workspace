using System.ComponentModel;
using System.Globalization;
using System.IO.Enumeration;
using System.Security.Cryptography;
using System.Text;
using Foundry.Platform;
using Foundry.Protocol;

namespace Foundry.Runtime;

/// <summary>TypeScript's CommandPreflightError: the command was refused before it could start, so its outcome is "none".</summary>
public sealed class CommandPreflightException(string message, Exception? inner = null) : InvalidOperationException(message, inner)
{
    public string Outcome { get; } = "none";
}

/// <summary>A proposed command as run_command carries it: the environment changes keep their given order.</summary>
internal sealed record CommandRequest(string Command, string Cwd, IReadOnlyList<KeyValuePair<string, string>> Environment, double TimeoutMs);

/// <summary>The exact command a user reviews: canonical working directory and shell, the complete environment block in
/// TypeScript's order, and a fingerprint over all of it plus the worktree state.</summary>
internal sealed record PreparedCommand(string Command, string Cwd, string Shell, IReadOnlyList<KeyValuePair<string, string>> Environment, int TimeoutMs, string Fingerprint) : IWireModel
{
    public Dictionary<string, object?> ToWire() => new()
    {
        ["command"] = Command, ["cwd"] = Cwd, ["shell"] = Shell, ["environment"] = CommandRunner.EnvironmentObject(Environment), ["timeoutMs"] = TimeoutMs, ["fingerprint"] = Fingerprint,
    };
}

internal sealed record CommandResult(string Stdout, string Stderr, long? ExitCode, bool Cancelled, bool TimedOut, bool CleanupVerified) : IWireModel
{
    public Dictionary<string, object?> ToWire() => new()
    {
        ["stdout"] = Stdout, ["stderr"] = Stderr, ["exitCode"] = ExitCode, ["cancelled"] = Cancelled, ["timedOut"] = TimedOut, ["cleanupVerified"] = CleanupVerified,
    };
}

/// <summary>
/// TypeScript's CommandRunner (command-runner.ts) and its job-runner.ps1 helper, in process: an already-approved Windows
/// PowerShell command runs through <see cref="JobProcess"/>, in its own kill-on-close Job Object that this runtime owns, so
/// the whole tree dies with the runtime. It inherits only its three pipe ends and the reviewed environment block. A
/// prepared command is a one-shot capability: execution consumes it before its first await, prepares it again from the
/// retained root, working directory and changes, and requires the same fingerprint, which covers the shell's hash and the
/// worktree's HEAD, status and content. Commands run with the user's Windows privileges; approval is not a sandbox.
/// </summary>
internal sealed class CommandRunner
{
    internal const int MaximumCommandCharacters = 64 * 1024;
    internal const int MaximumEnvironmentEntries = 64;
    internal const int MaximumEnvironmentValueCharacters = 4 * 1024;
    internal const int MaximumTimeoutMilliseconds = 10 * 60 * 1000;
    internal const int MaximumStreamBytes = 64 * 1024;
    internal const int MaximumStateFiles = 10_000;
    internal const int MaximumStateFolders = 10_000;
    internal const long MaximumStateBytes = 64L * 1024 * 1024;
    internal const string Truncated = "\n[output truncated]";
    internal const string BackgroundTerminated = "\n[background job descendants terminated]";
    internal const string Aborted = "This operation was aborted";
    internal const string UnknownCommand = "Prepared command is unknown or has changed.";
    internal const string StaleCommand = "Prepared command fingerprint is stale; request approval again.";
    internal const string NotStarted = "The command could not be started.";
    internal const string StateUnreadable = "Worktree state could not be read safely.";
    internal const string TooLarge = "Worktree is too large to fingerprint safely.";
    internal const string SystemRootUnavailable = "SystemRoot is unavailable.";
    internal const string ShellUnavailable = "Windows PowerShell executable is unavailable.";
    internal static readonly TimeSpan CleanupWindow = TimeSpan.FromSeconds(5);
    /// <summary>job-runner's HELPER_GRACE_MS: the bound on everything after the command ends.</summary>
    internal static readonly TimeSpan SettleWindow = TimeSpan.FromSeconds(10);
    private static readonly CompareInfo Collation = CultureInfo.GetCultureInfo("en-US").CompareInfo;
    private static readonly Comparer<string> LocaleOrder = Comparer<string>.Create((left, right) => Collation.Compare(left, right, CompareOptions.None));
    private static readonly string[] Words = ["credential", "secret", "token", "password", "authorization", "apikey", "api_key", "api-key", "cookie", "proxy", "node_options"];
    private static readonly HashSet<string> Reserved = new(["path", "comspec", "systemroot", "windir", "pathext", "psmodulepath"], StringComparer.Ordinal);
    // Plan section 8: variables that load code into a runtime the command starts. Native-only, refused before approval.
    private static readonly string[] DeniedPrefixes = ["DOTNET_", "COMPLUS_", "COR_", "CORECLR_"];
    private static readonly HashSet<string> DeniedNames = new(["JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "PYTHONPATH", "PYTHONSTARTUP", "PERL5OPT", "RUBYOPT", "__COMPAT_LAYER"], StringComparer.OrdinalIgnoreCase);
    private static readonly string[] BaseNames = ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "PATH", "TEMP", "TMP", "USERPROFILE"];

    private readonly RuntimeLoop loop;
    private readonly RepositoryService repositories;
    private readonly Func<IReadOnlyDictionary<string, string>> inherited;
    private readonly Dictionary<string, Record> prepared = new(StringComparer.Ordinal);

    internal CommandRunner(RuntimeLoop loop, RepositoryService repositories, Func<IReadOnlyDictionary<string, string>>? environment = null)
    {
        loop.AssertCurrent();
        this.loop = loop; this.repositories = repositories; inherited = environment ?? GitRunner.ProcessEnvironment;
    }

    /// <summary>Observed by tests just before launch: the exact application, command line, directory and environment.</summary>
    internal Action<ProcessSpec>? Launching { get; set; }

    private sealed record Record(string Root, string RelativeCwd, IReadOnlyList<KeyValuePair<string, string>> Changes, PreparedCommand Prepared);

    internal static Dictionary<string, object?> EnvironmentObject(IReadOnlyList<KeyValuePair<string, string>> environment)
    {
        var values = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var (name, value) in environment) values[name] = value;
        return values;
    }

    internal async Task<PreparedCommand> Prepare(string root, CommandRequest request)
    {
        loop.AssertCurrent();
        using var preflight = await Preflight(root, request);
        // The record keeps its own copy of the changes: re-preparation must not see a caller's later edit.
        prepared[preflight.Command.Fingerprint] = new(preflight.Root, preflight.RelativeCwd, [.. request.Environment], preflight.Command);
        return preflight.Command;
    }

    internal void Discard(PreparedCommand command) { loop.AssertCurrent(); prepared.Remove(command.Fingerprint); }

    internal async Task<CommandResult> Execute(PreparedCommand command, CancellationToken cancellationToken)
    {
        loop.AssertCurrent();
        Admitted fresh;
        try
        {
            if (!prepared.TryGetValue(command.Fingerprint, out var record) || !Same(record.Prepared, command)) throw new InvalidOperationException(UnknownCommand);
            // Consumed before the first await, so a second caller cannot replay this capability.
            prepared.Remove(command.Fingerprint);
            fresh = await Preflight(record.Root, new(command.Command, record.RelativeCwd, record.Changes, command.TimeoutMs));
            try
            {
                if (!string.Equals(fresh.Command.Fingerprint, command.Fingerprint, StringComparison.Ordinal)) throw new InvalidOperationException(StaleCommand);
                if (cancellationToken.IsCancellationRequested) throw new OperationCanceledException(Aborted, cancellationToken);
            }
            catch { fresh.Dispose(); throw; }
        }
        catch (Exception error) when (error is not CommandPreflightException)
        {
            throw new CommandPreflightException(error is OperationCanceledException ? Aborted : error.Message, error);
        }
        try { return await Run(fresh, cancellationToken); }
        finally { prepared.Remove(command.Fingerprint); }
    }

    private sealed class Admitted(RepositoryAdmission root, DirectoryLease cwd, PreparedCommand command, string relativeCwd) : IDisposable
    {
        internal PreparedCommand Command { get; } = command;
        internal string Root => root.Path;
        internal string RelativeCwd { get; } = relativeCwd;
        private bool disposed;
        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            try { cwd.Dispose(); } finally { root.Dispose(); }
        }
    }

    /// <summary>prepareInternal, in TypeScript's order: the request, the root, the working directory, the shell, the
    /// environment, the worktree state and the shell's hash. The root and working directory stay pinned until disposal.</summary>
    private async Task<Admitted> Preflight(string root, CommandRequest request)
    {
        loop.AssertCurrent();
        Validate(request);
        var timeout = (int)request.TimeoutMs;
        var admission = AdmitRoot(root);
        DirectoryLease? cwdLease = null;
        try
        {
            (cwdLease, var cwd, var relativeCwd) = AdmitWorkingDirectory(admission.Path, request.Cwd);
            var environment = inherited();
            var shell = ResolveShell(admission.Path, environment);
            var block = MinimalEnvironment(environment, request.Environment);
            var state = await WorktreeState(admission);
            var shellHash = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(shell)));
            var preimage = new Dictionary<string, object?>
            {
                ["command"] = request.Command, ["cwd"] = cwd, ["shell"] = shell, ["shellHash"] = shellHash, ["environment"] = EnvironmentObject(block), ["timeoutMs"] = timeout, ["state"] = state,
            };
            var fingerprint = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(JsJson.Stringify(preimage)!)));
            return new(admission, cwdLease, new(request.Command, cwd, shell, block, timeout, fingerprint), relativeCwd);
        }
        catch
        {
            cwdLease?.Dispose(); admission.Dispose();
            throw;
        }
    }

    /// <summary>validateArgs, with its messages and order. Two native refusals follow TypeScript's own checks, so a request
    /// TypeScript refuses gets TypeScript's message: the plan's runtime-loader names, and any name that differs only in case
    /// from another change or a base variable (TypeScript passes both, and its helper then fails before launch).</summary>
    private static void Validate(CommandRequest request)
    {
        if (request.Command is null || JsJson.Trim(request.Command).Length == 0 || request.Command.Length > MaximumCommandCharacters || request.Command.Contains('\0', StringComparison.Ordinal))
            throw new WorkspaceReadException("Command must be non-empty, NUL-free, and within the size limit.");
        if (!double.IsFinite(request.TimeoutMs) || Math.Floor(request.TimeoutMs) != request.TimeoutMs || request.TimeoutMs < 1 || request.TimeoutMs > MaximumTimeoutMilliseconds)
            throw new WorkspaceReadException("Timeout must be an integer from 1 through 600000 milliseconds.");
        if (request.Environment.Count > MaximumEnvironmentEntries) throw new WorkspaceReadException("Too many environment variables were requested.");
        foreach (var (name, value) in request.Environment)
        {
            if (!IsName(name) || Reserved.Contains(AsciiLower(name)) || Words.Any(AsciiLower(name).Contains)) throw new WorkspaceReadException($"Environment variable {name} is not permitted.");
            if (value is null || value.Length > MaximumEnvironmentValueCharacters || value.Contains('\0', StringComparison.Ordinal)) throw new WorkspaceReadException($"Environment variable {name} has an invalid value.");
        }
        var seen = new HashSet<string>(BaseNames, StringComparer.Ordinal);
        foreach (var (name, _) in request.Environment)
        {
            var collides = seen.Any(other => !string.Equals(other, name, StringComparison.Ordinal) && string.Equals(other, name, StringComparison.OrdinalIgnoreCase))
                || request.Environment.Count(pair => string.Equals(pair.Key, name, StringComparison.Ordinal)) > 1;
            if (collides || DeniedNames.Contains(name) || DeniedPrefixes.Any(prefix => name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)))
                throw new WorkspaceReadException($"Environment variable {name} is not permitted.");
            seen.Add(name);
        }
    }

    /// <summary>/^[A-Za-z_][A-Za-z0-9_]*$/.</summary>
    private static bool IsName(string name) => name.Length > 0 && (char.IsAsciiLetter(name[0]) || name[0] == '_') && name.All(character => char.IsAsciiLetterOrDigit(character) || character == '_');

    private static string AsciiLower(string value) => string.Create(value.Length, value, static (span, text) =>
    {
        for (var index = 0; index < text.Length; index++) span[index] = text[index] is >= 'A' and <= 'Z' ? (char)(text[index] + 32) : text[index];
    });

    /// <summary>canonicalDirectory(root): absolute, local and a directory, pinned with its Git identity. A network or device
    /// root is refused before anything is opened.</summary>
    private RepositoryAdmission AdmitRoot(string root)
    {
        if (string.IsNullOrEmpty(root) || !RepositoryPaths.IsNodeAbsolute(root)) throw new WorkspaceReadException("Root must be an absolute path.");
        return RepositoryAdmission.Open(loop, root, "Root must be a directory.");
    }

    /// <summary>canonicalWorktreeDirectory: a worktree-relative path without "..", resolved inside the root. Native pins the
    /// directory's chain and refuses any reparse point in it, and refuses a segment ending in a dot or space, where Node
    /// follows links and lets Win32 strip the ending.</summary>
    private static (DirectoryLease Lease, string Path, string Relative) AdmitWorkingDirectory(string root, string relative)
    {
        if (relative is null || relative.Length > 0 && relative[0] is '/' or '\\' || relative.Length >= 2 && char.IsAsciiLetter(relative[0]) && relative[1] == ':')
            throw new WorkspaceReadException("Working directory must be a worktree-relative path.");
        var normalized = relative.Replace('\\', '/');
        if (normalized.Split('/').Any(segment => segment == "..")) throw new WorkspaceReadException("Working directory must not traverse outside the worktree.");
        if (normalized.Contains('\0', StringComparison.Ordinal) || normalized.Contains(':', StringComparison.Ordinal) || RepositoryPaths.HasAmbiguousSegment(normalized))
            throw new WorkspaceReadException(RepositoryPaths.Forbidden);
        var candidate = Path.GetFullPath(Path.Join(root, normalized.Length == 0 ? "." : normalized));
        DirectoryLease lease;
        try { lease = DirectoryLease.AcquireExistingSharingWrites(candidate); }
        catch (ReparsePointException) { throw new WorkspaceReadException(RepositoryService.SymbolicLinks); }
        catch (IOException)
        {
            MetadataEntryKind kind;
            try { kind = MetadataFile.Probe(candidate); } catch (IOException) { kind = MetadataEntryKind.Missing; }
            throw new WorkspaceReadException(kind switch
            {
                MetadataEntryKind.File => "Working directory must be a directory.",
                MetadataEntryKind.Missing => RepositoryService.Missing,
                MetadataEntryKind.Reparse => RepositoryService.SymbolicLinks,
                _ => RepositoryService.Unreadable,
            });
        }
        try
        {
            if (!FinalPath.TryResolve(candidate, out var cwd) || !DataClassifier.IsLocal(cwd)) throw new WorkspaceReadException(RepositoryService.Unreadable);
            if (!RepositoryPaths.IsInside(root, cwd)) throw new WorkspaceReadException("Working directory must remain inside the approved root.");
            return (lease, cwd, RepositoryPaths.PortableRelative(root, cwd));
        }
        catch { lease.Dispose(); throw; }
    }

    /// <summary>resolveWindowsPowerShell: %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe, resolved, outside the
    /// root and a regular file. A SystemRoot that is not on a fixed local drive is refused before it is probed.</summary>
    private static string ResolveShell(string root, IReadOnlyDictionary<string, string> environment)
    {
        var systemRoot = environment.GetValueOrDefault("SystemRoot") ?? environment.GetValueOrDefault("WINDIR");
        if (string.IsNullOrEmpty(systemRoot) || !RepositoryPaths.IsNodeAbsolute(systemRoot) || NetworkPathPolicy.IsNetworkOrDevicePath(systemRoot)) throw new WorkspaceReadException(SystemRootUnavailable);
        var lexical = Path.GetFullPath(NodeJoin(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
        if (!DataClassifier.IsLocal(lexical) || new DriveInfo(lexical[..3]).DriveType is not DriveType.Fixed || !FinalPath.TryResolve(lexical, out var shell) || !DataClassifier.IsLocal(shell))
            throw new WorkspaceReadException(ShellUnavailable);
        if (RepositoryPaths.IsInside(root, shell)) throw new WorkspaceReadException("PowerShell executable must not resolve inside the approved root.");
        if (MetadataFile.Probe(shell) != MetadataEntryKind.File) throw new WorkspaceReadException(ShellUnavailable);
        return shell;
    }

    /// <summary>minimalEnvironment: the eight base variables, then the approved changes, sorted as localeCompare sorts.</summary>
    private static List<KeyValuePair<string, string>> MinimalEnvironment(IReadOnlyDictionary<string, string> environment, IReadOnlyList<KeyValuePair<string, string>> changes)
    {
        var systemRoot = environment.GetValueOrDefault("SystemRoot") ?? environment.GetValueOrDefault("WINDIR");
        if (systemRoot is null || !RepositoryPaths.IsNodeAbsolute(systemRoot)) throw new WorkspaceReadException(SystemRootUnavailable);
        var temp = environment.GetValueOrDefault("TEMP") ?? environment.GetValueOrDefault("TMP") ?? NodeJoin(systemRoot, "Temp");
        var profile = environment.GetValueOrDefault("USERPROFILE") ?? NodeDirname(temp);
        var block = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["SystemRoot"] = systemRoot, ["WINDIR"] = systemRoot, ["ComSpec"] = NodeJoin(systemRoot, "System32", "cmd.exe"), ["PATHEXT"] = ".COM;.EXE;.BAT;.CMD",
            ["PATH"] = string.Join(';', NodeJoin(systemRoot, "System32"), systemRoot, NodeJoin(systemRoot, "System32", "WindowsPowerShell", "v1.0")),
            ["TEMP"] = temp, ["TMP"] = temp, ["USERPROFILE"] = profile,
        };
        foreach (var (name, value) in changes) block[name] = value;
        return [.. block.OrderBy(pair => pair.Key, LocaleOrder)];
    }

    /// <summary>
    /// worktreeState: HEAD, porcelain status and a digest of the content beneath the root (Git's metadata excluded), at most
    /// 10,000 files and 64 MiB. Git runs through <see cref="GitRunner"/>, so the app's empty hooks folder applies and
    /// `core.hooksPath` is never empty. The digest runs off the loop and never follows a reparse point.
    /// </summary>
    private async Task<string> WorktreeState(RepositoryAdmission admission)
    {
        if (admission.Identity is null) throw new WorkspaceReadException(StateUnreadable);
        var head = JsJson.Trim((await repositories.Run(admission, ["rev-parse", "--verify", "HEAD^{commit}"])).Stdout);
        var status = (await repositories.Run(admission, ["status", "--porcelain=v1", "-z"])).Stdout;
        loop.AssertCurrent();
        var content = await RuntimeLoop.Offload(admission.Path, ContentState);
        loop.AssertCurrent();
        return head + "\0" + status + "\0" + content;
    }

    /// <summary>
    /// contentState: entries in localeCompare order; ".git" skipped at every level; a directory as D, then its entries; a
    /// regular file as F with its size and bytes. Native hashes a symbolic link or junction by its stored target without
    /// following it, as TypeScript hashes readlink, and refuses any other reparse point, which Node would read through.
    /// Files are opened by their exact names without following a reparse point. The walk keeps its own stack in the same
    /// pre-order, so a deep tree cannot exhaust the thread's stack (Node's async recursion does not grow one), and folders
    /// and links count against their own limit of 10,000, where TypeScript counts files only.
    /// </summary>
    private static string ContentState(string root)
    {
        using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var files = 0; var folders = 0; long bytes = 0;
        void Add(string text) => digest.AppendData(Encoding.UTF8.GetBytes(text));
        var pending = new Stack<Folder>();
        pending.Push(new(root, "", Entries(root)));
        while (pending.Count > 0)
        {
            var folder = pending.Peek();
            if (folder.Next == folder.Entries.Count) { pending.Pop(); continue; }
            var (name, attributes) = folder.Entries[folder.Next++];
            if (name == ".git") continue;
            var target = Path.Join(folder.Directory, name);
            var relative = folder.Prefix.Length == 0 ? name : folder.Prefix + "/" + name;
            if ((attributes.HasFlag(FileAttributes.ReparsePoint) || attributes.HasFlag(FileAttributes.Directory)) && ++folders > MaximumStateFolders)
                throw new WorkspaceReadException(TooLarge);
            if (attributes.HasFlag(FileAttributes.ReparsePoint))
            {
                string? link;
                try { link = (attributes.HasFlag(FileAttributes.Directory) ? (FileSystemInfo)new DirectoryInfo(@"\\?\" + target) : new FileInfo(@"\\?\" + target)).LinkTarget; }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException) { throw new WorkspaceReadException(StateUnreadable); }
                Add($"L\0{relative}\0{link ?? throw new WorkspaceReadException(StateUnreadable)}\0");
                continue;
            }
            if (attributes.HasFlag(FileAttributes.Directory)) { Add($"D\0{relative}\0"); pending.Push(new(target, relative, Entries(target))); continue; }
            if (attributes.HasFlag(FileAttributes.Device)) continue;
            byte[] content;
            try
            {
                using var entry = ExistingEntry.TryOpen(target) ?? throw new WorkspaceReadException(StateUnreadable);
                if (entry.IsReparsePoint || entry.IsDirectory) throw new WorkspaceReadException(StateUnreadable);
                files++; bytes += entry.Length;
                if (files > MaximumStateFiles || bytes > MaximumStateBytes) throw new WorkspaceReadException(TooLarge);
                Add($"F\0{relative}\0{entry.Length.ToString(CultureInfo.InvariantCulture)}\0");
                content = entry.ReadBounded((int)entry.Length);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidDataException) { throw new WorkspaceReadException(StateUnreadable); }
            digest.AppendData(content);
        }
        return Convert.ToHexStringLower(digest.GetHashAndReset());
    }

    /// <summary>A folder of the walk: its sorted entries and the next one to visit.</summary>
    private sealed class Folder(string directory, string prefix, List<(string Name, FileAttributes Attributes)> entries)
    {
        internal string Directory { get; } = directory;
        internal string Prefix { get; } = prefix;
        internal List<(string Name, FileAttributes Attributes)> Entries { get; } = entries;
        internal int Next { get; set; }
    }

    /// <summary>One folder's entries, read whole and sorted as localeCompare sorts.</summary>
    private static List<(string Name, FileAttributes Attributes)> Entries(string directory)
    {
        List<(string Name, FileAttributes Attributes)> entries;
        try
        {
            entries = [.. new FileSystemEnumerable<(string, FileAttributes)>(@"\\?\" + directory, (ref FileSystemEntry entry) => (entry.FileName.ToString(), entry.Attributes),
                new EnumerationOptions { AttributesToSkip = 0, IgnoreInaccessible = false, RecurseSubdirectories = false, ReturnSpecialDirectories = false })];
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { throw new WorkspaceReadException(StateUnreadable); }
        return [.. entries.OrderBy(entry => entry.Name, LocaleOrder)];
    }

    /// <summary>
    /// The helper's run, in process. Cancellation and the timeout terminate the job. After a normal exit, anything still in
    /// the job is terminated; it is reported as a background descendant unless it is only the system console host, which
    /// Windows starts for the root inside the job (TypeScript's command shared its helper's console instead). Cleanup is
    /// verified when the job is empty within five seconds. Each stream keeps its first 64 KiB, drained to its end on the
    /// thread pool. Everything after the command ends is bounded by one settle window, as TypeScript's watchdog bounds its
    /// helper: a process stuck in I/O that cannot be cancelled, or a pipe write end held outside the job, ends the wait with
    /// cleanup unverified and the output kept so far.
    /// </summary>
    private async Task<CommandResult> Run(Admitted preflight, CancellationToken cancellationToken)
    {
        var command = preflight.Command;
        JobProcess process;
        try
        {
            var spec = new ProcessSpec(command.Shell, CommandLine(command.Shell, command.Command), command.Cwd,
                command.Environment.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal));
            Launching?.Invoke(spec);
            process = JobProcess.Start(spec);
        }
        // Nothing was resumed: JobProcess closes the job, and with it any suspended child, before rethrowing.
        catch (Exception error) when (error is Win32Exception or ArgumentException or IOException) { throw new CommandPreflightException(NotStarted, error); }
        // The process holds its own working directory now; the command may manage the rest of its tree.
        finally { preflight.Dispose(); }
        using (process)
        using (var reading = new CancellationTokenSource())
        {
            try
            {
                process.StandardInput.Dispose();
                var output = JobProcess.DrainAsync(process.StandardOutput, MaximumStreamBytes, reading.Token);
                var error = JobProcess.DrainAsync(process.StandardError, MaximumStreamBytes, reading.Token);
                var exited = process.WaitForExitAsync(CancellationToken.None); // Cancellation terminates the job; the exit is still awaited.
                Observe(exited);
                bool wasCancelled = false, timedOut = false;
                using (var stop = new CancellationTokenSource())
                {
                    var timer = loop.Delay(TimeSpan.FromMilliseconds(command.TimeoutMs), stop.Token);
                    var cancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                    using (cancellationToken.Register(() => cancelled.TrySetResult()))
                    {
                        var first = await Task.WhenAny(exited, timer, cancelled.Task);
                        loop.AssertCurrent();
                        if (first == cancelled.Task) { wasCancelled = true; Terminate(process, 1); }
                        else if (first == timer) { timedOut = true; Terminate(process, 2); }
                    }
                    stop.Cancel();
                    try { await timer; } catch (OperationCanceledException) { }
                }
                using var settling = new CancellationTokenSource();
                var settle = loop.Delay(SettleWindow, settling.Token);
                try
                {
                    long? code = await Task.WhenAny(exited, settle) == exited ? await exited : null;
                    loop.AssertCurrent();
                    var normalEnd = code is not null && !wasCancelled && !timedOut;
                    var background = false;
                    // A background descendant can keep the pipes open after the root exits; end its job membership first.
                    if (normalEnd && process.ActiveProcesses > 0) { background = HasDescendant(process.ProcessImages()); Terminate(process, 3); }
                    var verified = code is not null && await process.WaitForEmptyAsync(CleanupWindow, CancellationToken.None);
                    loop.AssertCurrent();
                    var streams = Task.WhenAll(output, error);
                    if (await Task.WhenAny(streams, settle) != streams) { await reading.CancelAsync(); verified = false; }
                    await streams;
                    loop.AssertCurrent();
                    return new(Bounded(Decode(await output)), Bounded(Decode(await error) + (background ? BackgroundTerminated : "")),
                        normalEnd ? code : null, wasCancelled, timedOut, verified);
                }
                finally
                {
                    await settling.CancelAsync();
                    try { await settle; } catch (OperationCanceledException) { }
                }
            }
            finally { await reading.CancelAsync(); }
        }
    }

    /// <summary>The helper's command line: the quoted shell, its fixed switches, and the command as UTF-16LE Base64.</summary>
    internal static string CommandLine(string shell, string command) =>
        "\"" + shell.Replace("\"", "\\\"", StringComparison.Ordinal) + "\" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(command));

    private static readonly string ConsoleHost = Path.Join(Environment.SystemDirectory, "conhost.exe");

    /// <summary>Whether a job that outlived its root still holds a descendant: a live process other than the system console
    /// host. A live process whose image cannot be read counts as one.</summary>
    internal static bool HasDescendant(IEnumerable<string?> images) =>
        images.Any(image => image is null || !string.Equals(image, ConsoleHost, StringComparison.OrdinalIgnoreCase));

    /// <summary>A pending exit wait faults when the process is disposed first; nothing else reads it then.</summary>
    private static void Observe(Task task) =>
        task.ContinueWith(static completed => _ = completed.Exception, CancellationToken.None,
            TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);

    private static void Terminate(JobProcess process, uint code)
    {
        // Verification, not this call, decides whether cleanup succeeded.
        try { process.Terminate(code); } catch (Win32Exception) { }
    }

    /// <summary>The helper's decoding: UTF-8 with replacement, marked once the kept bytes reach the limit.</summary>
    private static string Decode(byte[] bytes) => Encoding.UTF8.GetString(bytes) + (bytes.Length >= MaximumStreamBytes ? Truncated : "");

    /// <summary>boundedText: at most 64 Ki UTF-16 units, then the marker.</summary>
    private static string Bounded(string value) => value.Length <= 64 * 1024 ? value : value[..(64 * 1024)] + Truncated;

    private static bool Same(PreparedCommand left, PreparedCommand right) =>
        string.Equals(left.Command, right.Command, StringComparison.Ordinal) && string.Equals(left.Cwd, right.Cwd, StringComparison.Ordinal)
        && string.Equals(left.Shell, right.Shell, StringComparison.Ordinal) && left.TimeoutMs == right.TimeoutMs
        && string.Equals(left.Fingerprint, right.Fingerprint, StringComparison.Ordinal) && left.Environment.SequenceEqual(right.Environment);

    /// <summary>path.win32.join for these fixed segments: "\" between parts, "/" read as "\", repeated separators collapsed,
    /// "." and ".." resolved.</summary>
    internal static string NodeJoin(params string[] parts)
    {
        var text = string.Join('\\', parts.Where(part => part.Length > 0)).Replace('/', '\\');
        var root = text.Length >= 2 && text[1] == ':' ? text[..2] + (text.Length > 2 && text[2] == '\\' ? "\\" : "") : text.StartsWith('\\') ? "\\" : "";
        var segments = new List<string>();
        foreach (var segment in text[root.Length..].Split('\\'))
        {
            if (segment.Length == 0 || segment == ".") continue;
            if (segment == ".." && segments.Count > 0 && segments[^1] != "..") { segments.RemoveAt(segments.Count - 1); continue; }
            if (segment == ".." && root.Length > 0) continue;
            segments.Add(segment);
        }
        var joined = root + string.Join('\\', segments);
        return joined.Length == 0 ? "." : text.EndsWith('\\') && segments.Count > 0 ? joined + "\\" : joined;
    }

    /// <summary>path.win32.dirname.</summary>
    internal static string NodeDirname(string path)
    {
        static bool Separator(char character) => character is '\\' or '/';
        var rootLength = path.Length >= 2 && path[1] == ':' ? path.Length >= 3 && Separator(path[2]) ? 3 : 2 : path.Length > 0 && Separator(path[0]) ? 1 : 0;
        var end = path.Length;
        while (end > rootLength && Separator(path[end - 1])) end--;
        var index = end - 1;
        while (index >= rootLength && !Separator(path[index])) index--;
        if (index < rootLength) return rootLength > 0 ? path[..rootLength] : ".";
        while (index > rootLength && Separator(path[index - 1])) index--;
        return index < rootLength || index == 0 ? path[..Math.Max(rootLength, 1)] : path[..index];
    }
}
