using System.Collections;
using System.Text;
using Foundry.Platform;
using Foundry.Protocol;

namespace Foundry.Runtime;

/// <summary>A refused or failed repository operation. "unknown" means a mutation may have started and needs reconciliation.</summary>
public sealed class RepositoryException(string message, string outcome = "none", Exception? inner = null) : InvalidOperationException(message, inner)
{
    public string Outcome { get; } = outcome is "none" or "unknown" ? outcome : throw new ArgumentOutOfRangeException(nameof(outcome));
    public bool MutationStarted => Outcome == "unknown";
}

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
    /// asked about, remembered (with a failure) for the life of the service. Network and device entries are skipped before
    /// any probe, which TypeScript resolves; the selected executable must never be inside the current repository.
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
            if (!IsNodeAbsolute(entry) || NetworkPathPolicy.IsNetworkOrDevicePath(entry)) continue;
            var candidate = FinalPath.Resolve(Path.Join(entry, "git.exe"));
            if (!FinalPath.TryResolve(candidate, out var resolved) || !DataClassifier.IsLocal(resolved)) continue;
            if (RepositoryPaths.IsInside(excludedRoot, resolved) || !File.Exists(resolved)) continue;
            return resolved;
        }
        throw new InvalidOperationException("A Git executable was not found in an absolute PATH entry outside the selected repository.");
    }

    private static bool IsNodeAbsolute(string value) =>
        value.Length > 0 && (value[0] is '/' or '\\' || value.Length > 2 && char.IsAsciiLetter(value[0]) && value[1] == ':' && value[2] is '/' or '\\');

    /// <summary>
    /// One Git process with TypeScript's error mapping: failures inside the run become "Git command failed: " with the
    /// trimmed standard error (or the failure's own message), cut to 500 UTF-16 units. A non-zero exit returns its code
    /// only when <paramref name="allowNonZero"/> is set; an output overflow returns the first 256 KiB of standard output
    /// only when <paramref name="permitTruncation"/> is set.
    /// </summary>
    internal async Task<GitOutput> Run(RepositoryAdmission admission, string workingDirectory, IReadOnlyList<string> arguments,
        bool permitTruncation = false, bool allowNonZero = false, GitOptions? options = null)
    {
        loop.AssertCurrent();
        options ??= new();
        admission.Revalidate();
        Completed? completed = null;
        try
        {
            var application = Executable(workingDirectory);
            admission.Revalidate();
            options.BeforeMutation?.Invoke();
            string[] prefix = ["--literal-pathspecs", "--no-pager", "-c", $"core.hooksPath={HooksPath}", "-c", "core.fsmonitor="];
            var all = options.AllowCredentialHelper ? [.. prefix, .. arguments] : (string[])[.. prefix, "-c", "credential.helper=", .. arguments];
            completed = await Execute(application, all, workingDirectory, options.Timeout ?? DefaultTimeout);
            admission.Revalidate();
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
            throw new RepositoryException("Git command failed: " + (detail.Length > 500 ? detail[..500] : detail), "none", error);
        }
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
