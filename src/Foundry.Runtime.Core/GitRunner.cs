using System.Collections;
using System.Text;
using Foundry.Platform;
using Foundry.Protocol;

namespace Foundry.Runtime;

/// <summary>
/// TypeScript's RepositoryError: a repository operation whose caller classified the outcome. "none" means no mutation
/// started; "unknown" means one may have, and the retained intent needs reconciliation. Only the caller that knows where
/// its final mutation boundary was may classify; plain refusals and Git failures carry no outcome.
/// </summary>
public sealed class RepositoryException(string message, string outcome = "none", Exception? inner = null) : InvalidOperationException(message, inner)
{
    public string Outcome { get; } = outcome is "none" or "unknown" ? outcome : throw new ArgumentOutOfRangeException(nameof(outcome));
    public bool MutationStarted => Outcome == "unknown";
}

/// <summary>
/// A Git process that failed, timed out, overflowed or ran while the admitted identity changed: TypeScript's plain
/// "Git command failed: " error. It never claims whether the command mutated anything; callers decide, as TypeScript's
/// createTaskWorktree does with the flag its final-boundary callback sets.
/// </summary>
public sealed class GitCommandException(string message, Exception? inner = null) : InvalidOperationException(message, inner);

internal sealed record GitOutput(string Stdout, bool Truncated, long ExitCode);

internal sealed record GitOptions(TimeSpan? Timeout = null, bool AllowCredentialHelper = false, Action? BeforeMutation = null);

/// <summary>
/// TypeScript RepositoryService.git (repository.ts) and gitEnvironment (git-environment.ts). Git runs only through
/// <see cref="JobProcess"/>: hooks point at an empty directory, fsmonitor and (unless allowed) credential helpers are off,
/// every inherited GIT_* variable is removed, and the admitted identity is revalidated before launch, at the final
/// boundary before a mutation, and after exit. A timeout or an output overflow terminates the whole process tree, where
/// Node's execFile signals only the root process.
/// </summary>
internal sealed class GitRunner
{
    internal const int MaximumOutputBytes = 256 * 1024;
    internal static readonly TimeSpan DefaultTimeout = TimeSpan.FromMilliseconds(15_000);
    internal const string EmptyHooksDirectory = ".empty-git-hooks";
    private readonly RuntimeLoop loop;
    private readonly string worktreeBase;
    private readonly Func<IReadOnlyDictionary<string, string>> inherited;
    private string? executable;
    private Exception? executableFailure;

    internal GitRunner(RuntimeLoop loop, string worktreeBase, Func<IReadOnlyDictionary<string, string>>? environment = null)
    {
        loop.AssertCurrent();
        this.loop = loop; this.worktreeBase = worktreeBase; inherited = environment ?? ProcessEnvironment;
    }

    /// <summary>Launches observed by tests: the exact command line and environment block handed to <see cref="JobProcess"/>.</summary>
    internal Action<ProcessSpec>? Launching { get; set; }

    internal string HooksPath => Path.Join(FinalPath.Resolve(worktreeBase), EmptyHooksDirectory);

    internal static IReadOnlyDictionary<string, string> ProcessEnvironment()
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables()) values[(string)entry.Key] = (string?)entry.Value ?? "";
        return values;
    }

    /// <summary>
    /// gitEnvironment(): drop every variable whose name.toUpperCase() starts with GIT_, then pin the two Git settings.
    /// JavaScript upper-cases the dotless ı to I, which .NET's invariant casing does not, and no other character's full
    /// upper-case mapping can produce that prefix, so the rule is exactly [gG][iIı][tT]_.
    /// </summary>
    internal static Dictionary<string, string> Sanitize(IReadOnlyDictionary<string, string> source)
    {
        var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (name, value) in source)
            if (!(name.Length >= 4 && name[0] is 'g' or 'G' && name[1] is 'i' or 'I' or 'ı' && name[2] is 't' or 'T' && name[3] == '_')) environment[name] = value;
        environment["GIT_CONFIG_NOSYSTEM"] = "1";
        environment["GIT_TERMINAL_PROMPT"] = "0";
        return environment;
    }

    /// <summary>
    /// getGitExecutable: the first git.exe in an absolute PATH entry that is a regular file outside the repository first
    /// asked about, remembered (with a failure) for the life of the service. Entries that are network or device paths, or
    /// that are not on a fixed local drive, are skipped before any probe (TypeScript resolves them); as in TypeScript, a
    /// link inside a local entry is still followed. The selected executable must never be inside the current repository.
    /// </summary>
    internal string Executable(string excludedRoot)
    {
        loop.AssertCurrent();
        if (executable is null && executableFailure is null)
        {
            try { executable = Resolve(excludedRoot); }
            catch (InvalidOperationException error) { executableFailure = error; }
        }
        if (executableFailure is not null) throw new InvalidOperationException(executableFailure.Message, executableFailure);
        if (RepositoryPaths.IsInside(excludedRoot, executable!)) throw new InvalidOperationException("Git executable resolves inside the selected repository.");
        return executable!;
    }

    private string Resolve(string excludedRoot)
    {
        var path = inherited().TryGetValue("PATH", out var value) ? value : "";
        foreach (var raw in path.Split(';'))
        {
            var entry = JsJson.Trim(raw);
            if (entry.StartsWith('"')) entry = entry[1..];
            if (entry.EndsWith('"')) entry = entry[..^1];
            if (!RepositoryPaths.IsNodeAbsolute(entry) || NetworkPathPolicy.IsNetworkOrDevicePath(entry)) continue;
            var candidate = FinalPath.Resolve(Path.Join(entry, "git.exe"));
            // Mapped network and removable drives are refused by type before anything on them is opened.
            if (!DataClassifier.IsLocal(candidate) || new DriveInfo(candidate[..3]).DriveType is not DriveType.Fixed) continue;
            if (!FinalPath.TryResolve(candidate, out var resolved) || !DataClassifier.IsLocal(resolved)) continue;
            if (RepositoryPaths.IsInside(excludedRoot, resolved) || !File.Exists(resolved)) continue;
            return resolved;
        }
        throw new InvalidOperationException("A Git executable was not found in an absolute PATH entry outside the selected repository.");
    }

    /// <summary>
    /// One Git process in the admitted folder, with TypeScript's error mapping: failures inside the run become a
    /// <see cref="GitCommandException"/> "Git command failed: " with the trimmed standard error (or the failure's own
    /// message), cut to 500 UTF-16 units. A non-zero exit returns its code only when <paramref name="allowNonZero"/> is
    /// set; an output overflow returns the first 256 KiB of standard output only when <paramref name="permitTruncation"/>
    /// is set. A running process is not cancelled by shutdown; it ends within its timeout, as TypeScript's drain waits.
    /// </summary>
    internal async Task<GitOutput> Run(RepositoryAdmission admission, IReadOnlyList<string> arguments,
        bool permitTruncation = false, bool allowNonZero = false, GitOptions? options = null)
    {
        loop.AssertCurrent();
        options ??= new();
        var workingDirectory = admission.Path;
        admission.Revalidate();
        Completed? completed = null;
        DirectoryLease? hooks = null;
        try
        {
            var application = Executable(workingDirectory);
            hooks = GuardHooks();
            admission.Revalidate();
            options.BeforeMutation?.Invoke();
            string[] prefix = ["--literal-pathspecs", "--no-pager", "-c", $"core.hooksPath={HooksPath}", "-c", "core.fsmonitor="];
            var all = options.AllowCredentialHelper ? [.. prefix, .. arguments] : (string[])[.. prefix, "-c", "credential.helper=", .. arguments];
            completed = await Execute(application, all, workingDirectory, options.Timeout ?? DefaultTimeout);
            admission.Revalidate();
            // An entry that appeared during the run may have run as a hook: the run is not trusted.
            if (hooks is null) hooks = GuardHooks(); else RequireNoHooks();
            if (completed.Overflowed)
            {
                if (permitTruncation) return new(completed.Stdout, true, 0);
                throw new GitFailure(completed.Stderr);
            }
            if (completed.TimedOut || completed.LaunchFailed) throw new GitFailure(completed.Stderr);
            if (completed.ExitCode != 0)
            {
                if (allowNonZero) return new(completed.Stdout, false, completed.ExitCode);
                throw new GitFailure(completed.Stderr);
            }
            return new(completed.Stdout, false, 0);
        }
        catch (Exception error) when (error is GitFailure or InvalidOperationException or IOException or System.ComponentModel.Win32Exception)
        {
            var detail = JsJson.Trim(error is GitFailure failure ? failure.Stderr : error.Message);
            throw new GitCommandException("Git command failed: " + (detail.Length > 500 ? detail[..500] : detail), error);
        }
        finally { hooks?.Dispose(); }
    }

    internal const string HooksNotEmpty = "The app-owned Git hooks folder must be empty.";

    /// <summary>
    /// Hooks stay disabled only while the hooks folder holds nothing: `--no-verify` does not cover post-commit,
    /// post-checkout or reference-transaction. Before launch the folder must be missing, or a directory whose whole chain
    /// is pinned free of reparse points (so it cannot be renamed, deleted or swapped for a link while held) and that has no
    /// entries; the pin is held until exit, when the folder is checked again. A directory handle cannot forbid new entries,
    /// so a same-user process can still add one during a run: that run then fails, and the next launch refuses before
    /// anything starts, so one planted file never becomes lasting execution.
    /// </summary>
    private DirectoryLease? GuardHooks()
    {
        var path = HooksPath;
        if (!DataClassifier.IsLocal(path) || RepositoryPaths.HasAmbiguousSegment(path)) throw new InvalidOperationException(HooksNotEmpty);
        MetadataEntryKind kind;
        try { kind = MetadataFile.Probe(path); }
        catch (IOException error) { throw new InvalidOperationException(HooksNotEmpty, error); }
        if (kind == MetadataEntryKind.Missing) return null;
        if (kind != MetadataEntryKind.Directory) throw new InvalidOperationException(HooksNotEmpty);
        DirectoryLease lease;
        try { lease = DirectoryLease.AcquireExistingSharingWrites(path); }
        catch (IOException error) { throw new InvalidOperationException(HooksNotEmpty, error); }
        try { RequireNoHooks(); return lease; }
        catch { lease.Dispose(); throw; }
    }

    private void RequireNoHooks()
    {
        bool any;
        try
        {
            using var entries = new System.IO.Enumeration.FileSystemEnumerable<bool>(@"\\?\" + HooksPath, (ref System.IO.Enumeration.FileSystemEntry _) => true,
                new EnumerationOptions { AttributesToSkip = 0, IgnoreInaccessible = false, RecurseSubdirectories = false, ReturnSpecialDirectories = false }).GetEnumerator();
            any = entries.MoveNext();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { throw new InvalidOperationException(HooksNotEmpty, error); }
        if (any) throw new InvalidOperationException(HooksNotEmpty);
    }

    private sealed class GitFailure(string stderr) : Exception(stderr) { internal string Stderr { get; } = stderr; }
    private sealed record Completed(string Stdout, string Stderr, long ExitCode, bool TimedOut, bool Overflowed, bool LaunchFailed);

    private async Task<Completed> Execute(string application, IReadOnlyList<string> arguments, string workingDirectory, TimeSpan timeout)
    {
        var environment = Sanitize(inherited());
        // libuv quotes argv[0] and every argument with the MSVCRT rules (quote_cmd_arg); NUL is refused before launch as Node does.
        if (arguments.Any(argument => argument.Contains('\0', StringComparison.Ordinal))) throw new InvalidOperationException("The argument must be a string without null bytes.");
        var spec = new ProcessSpec(application, string.Join(' ', new[] { application }.Concat(arguments).Select(Quote)), workingDirectory, environment);
        Launching?.Invoke(spec);
        JobProcess process;
        try { process = JobProcess.Start(spec); }
        catch (Exception error) when (error is System.ComponentModel.Win32Exception or ArgumentException) { return new("", "", -1, false, false, true); }
        using (process)
        {
            process.StandardInput.Dispose();
            var overflow = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var stdout = Collect(process.StandardOutput, overflow);
            var stderr = Collect(process.StandardError, overflow);
            var exited = process.WaitForExitAsync();
            var finished = Task.WhenAll(stdout, stderr, exited);
            using var stop = new CancellationTokenSource();
            var timer = loop.Delay(timeout, stop.Token);
            var first = await Task.WhenAny(finished, timer, overflow.Task);
            var timedOut = first == timer; var overflowed = overflow.Task.IsCompleted;
            if (first != finished) process.Terminate(1);
            stop.Cancel();
            try { await timer; } catch (OperationCanceledException) { }
            await Task.WhenAll(stdout, stderr);
            var code = await exited;
            return new(Decode(await stdout), Decode(await stderr), unchecked((uint)code), timedOut && !overflowed, overflowed, false);
        }
    }

    /// <summary>Reads a stream to its end, keeping at most the first 256 KiB; one byte more signals an overflow.</summary>
    private static async Task<byte[]> Collect(FileStream stream, TaskCompletionSource overflow)
    {
        var kept = new MemoryStream(); var buffer = new byte[16 * 1024];
        while (true)
        {
            int read;
            try { read = await stream.ReadAsync(buffer); }
            catch (IOException) { break; } // The pipe breaks when the tree is terminated.
            if (read == 0) break;
            var room = MaximumOutputBytes - (int)kept.Length;
            kept.Write(buffer, 0, Math.Min(room, read));
            if (read > room) { overflow.TrySetResult(); break; }
        }
        return kept.ToArray();
    }

    private static string Decode(byte[] bytes) => Encoding.UTF8.GetString(bytes);

    /// <summary>MSVCRT argument quoting, as libuv's quote_cmd_arg produces it for Node's child_process.</summary>
    internal static string Quote(string argument)
    {
        if (argument.Length == 0) return "\"\"";
        if (argument.IndexOfAny([' ', '\t', '"']) < 0) return argument;
        if (argument.IndexOfAny(['"', '\\']) < 0) return "\"" + argument + "\"";
        var quoted = new StringBuilder("\"");
        var backslashes = 0;
        foreach (var character in argument)
        {
            if (character == '\\') { backslashes++; continue; }
            quoted.Append('\\', character == '"' ? backslashes * 2 + 1 : backslashes).Append(character);
            backslashes = 0;
        }
        return quoted.Append('\\', backslashes * 2).Append('"').ToString();
    }
}
