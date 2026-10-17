using System.ComponentModel;
using System.Text;
using System.Text.Json;
using Foundry.Platform;
using Foundry.Protocol;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

/// <summary>
/// The unwired native command runner against the committed Node outcomes (tests/p2/command-runner.test.ts), with real
/// Windows PowerShell 5.1 runs in disposable worktrees, plus the launch boundary native adds.
/// </summary>
public sealed class CommandRunnerTests
{
    private static readonly JsonElement Corpus = RepositoryFixture.ReadCorpus("tests/p2/command-runner-vectors.json");
    private static readonly string SystemRoot = Environment.GetEnvironmentVariable("SystemRoot")!;
    private static readonly string Shell = FinalPath.Resolve(Path.Combine(SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
    private const string Skipped = "skip";

    private static Dictionary<string, object?> Refusal(string message, bool preflight = false) => new() { ["error"] = message, ["preflight"] = preflight };
    private static Dictionary<string, object?> NotPermitted(string name) => Refusal($"Environment variable {name} is not permitted.");

    /// <summary>
    /// Every step whose native outcome differs from Node's, by case name and step index. Node's raw errors become fixed
    /// refusals; the other entries are the named differences in docs/implementation-status.md (P2.3a).
    /// </summary>
    private static readonly Dictionary<string, object> NativeOutcomes = new(StringComparer.Ordinal)
    {
        ["admits the root and the working directory#3"] = Refusal(RepositoryFolderLease.Unavailable),
        ["admits the root and the working directory#4"] = Refusal(CommandRunner.StateUnreadable),
        ["admits the root and the working directory#5"] = Refusal("Git command failed: fatal: Needed a single revision"),
        ["admits the root and the working directory#12"] = Refusal(RepositoryPaths.Forbidden),
        ["admits the root and the working directory#13"] = Refusal(RepositoryPaths.Forbidden),
        ["admits the root and the working directory#14"] = Refusal(RepositoryService.SymbolicLinks),
        ["admits the root and the working directory#15"] = Refusal(RepositoryService.SymbolicLinks),
        ["admits the root and the working directory#16"] = Refusal(RepositoryService.Missing),
        ["admits the root and the working directory#25"] = Refusal(RepositoryPaths.Forbidden),
        ["refuses a status larger than the Git output limit#1"] = Refusal("Git command failed: "),
        // TypeScript's helper reads its spec in the console code page, so non-ASCII command text reaches PowerShell altered.
        ["runs exactly the approved command#12"] = new Dictionary<string, object?> { ["text"] = "it's \"double\" caf\u00e9 \u6771\u4eac \ud83d\ude00 `n" },
        ["runs exactly the approved command#14"] = new Dictionary<string, object?>
        {
            ["result"] = new Dictionary<string, object?> { ["stdout"] = "caf\ufffd ??\r\n", ["stderr"] = "", ["exitCode"] = 0, ["cancelled"] = false, ["timedOut"] = false, ["cleanupVerified"] = true },
        },
        ["accepts environment names that native refuses#0"] = NotPermitted("DOTNET_ROOT"),
        ["accepts environment names that native refuses#1"] = NotPermitted("dotnet_gcHeapHardLimit"),
        ["accepts environment names that native refuses#2"] = NotPermitted("COMPlus_EnableDiagnostics"),
        ["accepts environment names that native refuses#3"] = NotPermitted("COR_PROFILER"),
        ["accepts environment names that native refuses#4"] = NotPermitted("CORECLR_PROFILER_PATH"),
        ["accepts environment names that native refuses#5"] = NotPermitted("JAVA_TOOL_OPTIONS"),
        ["accepts environment names that native refuses#6"] = NotPermitted("_JAVA_OPTIONS"),
        ["accepts environment names that native refuses#7"] = NotPermitted("PYTHONPATH"),
        ["accepts environment names that native refuses#8"] = NotPermitted("PythonStartup"),
        ["accepts environment names that native refuses#9"] = NotPermitted("PERL5OPT"),
        ["accepts environment names that native refuses#10"] = NotPermitted("RUBYOPT"),
        ["accepts environment names that native refuses#11"] = NotPermitted("__COMPAT_LAYER"),
        // TypeScript prepares a name that differs from TEMP only in case; its helper then fails before launch, recorded unknown.
        ["accepts environment names that native refuses#12"] = NotPermitted("temp"),
        ["accepts environment names that native refuses#13"] = Skipped,
        ["accepts environment names that native refuses#14"] = NotPermitted("Tmp"),
        ["accepts environment names that native refuses#15"] = NotPermitted("UserProfile"),
        ["accepts environment names that native refuses#16"] = NotPermitted("same"),
        // CreateProcess refuses the command line; native knows nothing started, where TypeScript's helper cannot tell.
        ["refuses a command line beyond the Windows limit only when launching#1"] = Refusal(CommandRunner.NotStarted, true),
    };

    public static IEnumerable<object[]> Cases()
    {
        var index = 0;
        foreach (var item in Corpus.GetProperty("cases").EnumerateArray()) yield return [item.GetProperty("name").GetString()!, index++];
    }

    [Theory, MemberData(nameof(Cases))]
    public async Task CommandsMatchCommittedNodeOutcomes(string name, int index)
    {
        var item = Corpus.GetProperty("cases")[index];
        Assert.Equal(name, item.GetProperty("name").GetString());
        using var fixture = RepositoryFixture.Create("foundry-p2-command-");
        foreach (var directory in new[] { "tmp", "profile" }) Directory.CreateDirectory(fixture.Local(directory));
        await fixture.Build(item.GetProperty("tree"));
        var environment = new Dictionary<string, string>(fixture.Environment(), StringComparer.OrdinalIgnoreCase)
        {
            ["TEMP"] = fixture.Local("tmp"), ["TMP"] = fixture.Local("tmp"), ["USERPROFILE"] = fixture.Local("profile"), ["FOUNDRY_P2_CANARY"] = "canary-is-not-inherited",
        };
        IReadOnlyDictionary<string, string> current = environment;
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            var repositories = new RepositoryService(loop, fixture.Local("wt"), () => current);
            var runner = new CommandRunner(loop, repositories, () => current);
            var prepared = new Dictionary<string, PreparedCommand>(StringComparer.Ordinal);
            var groups = new Dictionary<long, string>(); var fingerprints = new Dictionary<string, long>(StringComparer.Ordinal);
            var position = 0;
            foreach (var step in item.GetProperty("steps").EnumerateArray())
            {
                var label = $"{name}#{position++}";
                var expected = step.GetProperty("expected");
                if (NativeOutcomes.TryGetValue(label, out var native))
                {
                    if (native is string) continue;
                    expected = JsonSerializer.SerializeToElement(native);
                }
                else Assert.False(expected.TryGetProperty("systemError", out _) || expected.TryGetProperty("helperFailure", out _), $"{label}: a raw Node outcome needs a native refusal");
                var op = step.GetProperty("op").GetString();
                var actual = new Dictionary<string, object?>();
                try
                {
                    switch (op)
                    {
                        case "prepare":
                            var overrides = step.TryGetProperty("processEnv", out var changes) ? changes : default;
                            var stepEnvironment = new Dictionary<string, string>(environment, StringComparer.OrdinalIgnoreCase);
                            if (overrides.ValueKind == JsonValueKind.Object)
                                foreach (var change in overrides.EnumerateObject())
                                    if (change.Value.ValueKind == JsonValueKind.Null) stepEnvironment.Remove(change.Name); else stepEnvironment[change.Name] = change.Value.GetString()!;
                            current = stepEnvironment;
                            PreparedCommand value;
                            try { value = await runner.Prepare(Root(fixture, step), Request(step)); }
                            finally { current = environment; }
                            if (step.TryGetProperty("as", out var alias)) prepared[alias.GetString()!] = value;
                            actual["prepared"] = Clean(fixture, new Dictionary<string, object?>
                            {
                                ["command"] = value.Command, ["cwd"] = value.Cwd, ["shell"] = value.Shell, ["timeoutMs"] = value.TimeoutMs,
                                ["environment"] = value.Environment.Select(pair => new List<object?> { pair.Key, pair.Value }).ToList(),
                            });
                            // Fingerprints are compared by identity: each Node group must map to one native fingerprint, and back.
                            var group = expected.GetProperty("fingerprint").GetInt64();
                            if (groups.TryGetValue(group, out var known)) Assert.True(known == value.Fingerprint, $"{label}: fingerprint group {group} changed");
                            else { Assert.False(fingerprints.ContainsKey(value.Fingerprint), $"{label}: fingerprint reused for group {group}"); groups[group] = value.Fingerprint; fingerprints[value.Fingerprint] = group; }
                            actual["fingerprint"] = group;
                            break;
                        case "execute":
                            var command = prepared[step.GetProperty("prepared").GetString()!];
                            if (step.TryGetProperty("tamper", out var tamper)) command = Tamper(fixture, command, tamper);
                            using (var cancel = new CancellationTokenSource())
                            {
                                var abort = step.TryGetProperty("abort", out var mode) ? mode : default;
                                if (abort.ValueKind == JsonValueKind.String) await cancel.CancelAsync();
                                var running = runner.Execute(command, cancel.Token);
                                if (abort.ValueKind == JsonValueKind.Object)
                                {
                                    var marker = fixture.Local(abort.GetProperty("afterFile").GetString()!);
                                    var deadline = DateTime.UtcNow.AddSeconds(60);
                                    while (!File.Exists(marker) && !running.IsCompleted && DateTime.UtcNow < deadline) await Task.Delay(50, TestContext.Current.CancellationToken);
                                    await cancel.CancelAsync();
                                }
                                actual["result"] = Clean(fixture, (await running).ToWire());
                            }
                            break;
                        case "executeTwice":
                            var twice = prepared[step.GetProperty("prepared").GetString()!];
                            var first = runner.Execute(twice, CancellationToken.None); var second = runner.Execute(twice, CancellationToken.None);
                            var rejected = new List<object?>(); var fulfilled = 0;
                            foreach (var attempt in new[] { first, second })
                            {
                                try { await attempt; fulfilled++; }
                                catch (InvalidOperationException error) { rejected.Add(Outcome(fixture, error)); }
                            }
                            actual["fulfilled"] = fulfilled; actual["rejected"] = rejected;
                            break;
                        case "discard": runner.Discard(prepared[step.GetProperty("prepared").GetString()!]); break;
                        case "write": fixture.Write(step.GetProperty("file").GetString()!, Text(step.GetProperty("text"))); break;
                        case "touch":
                            var later = DateTime.UtcNow.AddHours(1);
                            File.SetLastWriteTimeUtc(fixture.Local(step.GetProperty("file").GetString()!), later); File.SetLastAccessTimeUtc(fixture.Local(step.GetProperty("file").GetString()!), later);
                            break;
                        case "mkdir": Directory.CreateDirectory(fixture.Local(step.GetProperty("dir").GetString()!)); break;
                        case "junction": await fixture.Junction(step.GetProperty("link").GetString()!, step.GetProperty("target").GetString()!); break;
                        case "unlink": Directory.Delete(fixture.Local(step.GetProperty("link").GetString()!)); break;
                        case "git": await fixture.Git([.. step.GetProperty("args").EnumerateArray().Select(argument => argument.GetString()!)]); break;
                        case "fill":
                            var folder = fixture.Local(step.GetProperty("dir").GetString()!); Directory.CreateDirectory(folder);
                            for (var count = 0; count < step.GetProperty("count").GetInt32(); count++)
                                File.WriteAllText(Path.Combine(folder, $"{step.GetProperty("prefix").GetString()}{count:D5}.txt"), "x");
                            break;
                        case "wait": await Task.Delay(step.GetProperty("ms").GetInt32(), TestContext.Current.CancellationToken); break;
                        case "exists": actual["exists"] = File.Exists(fixture.Local(step.GetProperty("file").GetString()!)); break;
                        case "read": actual["text"] = Clean(fixture, File.ReadAllText(fixture.Local(step.GetProperty("file").GetString()!), Encoding.UTF8)); break;
                        default: throw new InvalidOperationException($"Unknown step {op}.");
                    }
                }
                catch (InvalidOperationException error) when (op is "prepare" or "execute") { actual = Outcome(fixture, error); }
                var serialized = JsonSerializer.SerializeToElement(actual);
                Assert.True(JsonElement.DeepEquals(expected, serialized), $"{label}: expected {expected.GetRawText()}\nactual   {serialized.GetRawText()}");
            }
            return 0;
        });
    }

    [Fact]
    public void OracleSourceBindingsAreCurrentAndEveryNamedDifferenceExists()
    {
        Assert.Equal(1, Corpus.GetProperty("schemaVersion").GetInt32());
        RepositoryFixture.AssertOracleSources(Corpus);
        var labels = Corpus.GetProperty("cases").EnumerateArray()
            .SelectMany(item => item.GetProperty("steps").EnumerateArray().Select((_, position) => $"{item.GetProperty("name").GetString()}#{position}")).ToHashSet(StringComparer.Ordinal);
        Assert.All(NativeOutcomes.Keys, label => Assert.Contains(label, labels));
    }

    /// <summary>H1: the worktree-state Git calls go through the runner's guard, so a planted hook refuses preparation and
    /// no Git process starts.</summary>
    [Fact]
    public async Task APlantedHookRefusesPreparationBeforeGitRuns()
    {
        using var fixture = await Repository("foundry-p2-command-hooks-");
        fixture.Write("wt/.empty-git-hooks/post-index-change", "#!/bin/sh\nexit 0\n");
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            var repositories = new RepositoryService(loop, fixture.Local("wt"), fixture.Environment);
            var launches = 0; repositories.Git.Launching = _ => launches++;
            var runner = new CommandRunner(loop, repositories, fixture.Environment);
            var refused = await Assert.ThrowsAsync<GitCommandException>(() => runner.Prepare(fixture.Local("repo"), Say("never")));
            Assert.Equal("Git command failed: " + repositories.Git.HooksNotEmptyMessage, refused.Message);
            Assert.Equal(0, launches);
            File.Delete(fixture.Local("wt/.empty-git-hooks/post-index-change"));
            await runner.Prepare(fixture.Local("repo"), Say("now"));
            Assert.Equal(2, launches);
            return 0;
        });
    }

    /// <summary>TypeScript's pre-approval state ran Git with an empty core.hooksPath, which Git resolves to the drive root
    /// (review of #35). Native state calls always name the app's hooks folder.</summary>
    [Fact]
    public async Task StateGitCallsNameTheAppHooksFolder()
    {
        using var fixture = await Repository("foundry-p2-command-hookspath-");
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            var repositories = new RepositoryService(loop, fixture.Local("wt"), fixture.Environment);
            var lines = new List<string>(); repositories.Git.Launching = spec => lines.Add(spec.CommandLine);
            await new CommandRunner(loop, repositories, fixture.Environment).Prepare(fixture.Local("repo"), Say("x"));
            Assert.Equal(2, lines.Count);
            Assert.All(lines, line => Assert.Contains("core.hooksPath=" + repositories.Git.HooksPath, line, StringComparison.Ordinal));
            Assert.All(lines, line => Assert.DoesNotContain("core.hooksPath= ", line, StringComparison.Ordinal));
            return 0;
        });
    }

    /// <summary>The launch is exactly what was reviewed: the shell, its fixed switches with the command as UTF-16LE Base64,
    /// the canonical working directory and the reviewed environment block, nothing inherited.</summary>
    [Fact]
    public async Task TheLaunchIsTheReviewedCommandLineDirectoryAndEnvironment()
    {
        using var fixture = await Repository("foundry-p2-command-launch-");
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            var runner = new CommandRunner(loop, new RepositoryService(loop, fixture.Local("wt"), fixture.Environment), fixture.Environment);
            ProcessSpec? launched = null; runner.Launching = spec => launched = spec;
            var command = await runner.Prepare(fixture.Local("repo"), new("[Console]::Out.WriteLine('\u00e9')", "src", [new("ZETA", "z")], 10_000));
            var result = await runner.Execute(command, CancellationToken.None);
            Assert.Equal(0, result.ExitCode);
            Assert.NotNull(launched);
            Assert.Equal(Shell, launched.Application);
            Assert.Equal($"\"{Shell}\" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "
                + Convert.ToBase64String(Encoding.Unicode.GetBytes("[Console]::Out.WriteLine('\u00e9')")), launched.CommandLine);
            Assert.Equal(fixture.Local("repo\\src"), launched.WorkingDirectory);
            Assert.Equal(command.Environment.ToDictionary(pair => pair.Key, pair => pair.Value), launched.Environment);
            Assert.DoesNotContain(launched.Environment.Keys, key => key.StartsWith("GIT_", StringComparison.OrdinalIgnoreCase) || key == "HOME");
            return 0;
        });
    }

    /// <summary>Native difference: a launch that fails before the process is resumed is known not to have started ("none"),
    /// and the capability stays consumed.</summary>
    [Fact]
    public async Task ALaunchFailureIsKnownNotToHaveStarted()
    {
        using var fixture = await Repository("foundry-p2-command-unstarted-");
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            var runner = new CommandRunner(loop, new RepositoryService(loop, fixture.Local("wt"), fixture.Environment), fixture.Environment);
            runner.Launching = _ => throw new Win32Exception(206);
            var command = await runner.Prepare(fixture.Local("repo"), Say("x"));
            var refused = await Assert.ThrowsAsync<CommandPreflightException>(() => runner.Execute(command, CancellationToken.None));
            Assert.Equal((CommandRunner.NotStarted, "none"), (refused.Message, refused.Outcome));
            runner.Launching = null;
            Assert.Equal(CommandRunner.UnknownCommand, (await Assert.ThrowsAsync<CommandPreflightException>(() => runner.Execute(command, CancellationToken.None))).Message);
            return 0;
        });
    }

    /// <summary>Cancellation before launch never starts the command.</summary>
    [Fact]
    public async Task CancellationBeforeLaunchNeverStartsTheCommand()
    {
        using var fixture = await Repository("foundry-p2-command-cancelled-");
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            var runner = new CommandRunner(loop, new RepositoryService(loop, fixture.Local("wt"), fixture.Environment), fixture.Environment);
            var launches = 0; runner.Launching = _ => launches++;
            var command = await runner.Prepare(fixture.Local("repo"), Say("x"));
            var refused = await Assert.ThrowsAsync<CommandPreflightException>(() => runner.Execute(command, new CancellationToken(true)));
            Assert.Equal(CommandRunner.Aborted, refused.Message);
            Assert.Equal(0, launches);
            return 0;
        });
    }

    /// <summary>A timeout ends the whole tree, including a grandchild started after the root.</summary>
    [Fact]
    public async Task ATimeoutEndsTheWholeTree()
    {
        using var fixture = await Repository("foundry-p2-command-timeout-tree-");
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            var runner = new CommandRunner(loop, new RepositoryService(loop, fixture.Local("wt"), fixture.Environment), fixture.Environment);
            var command = await runner.Prepare(fixture.Local("repo"), new(
                "$a = '-NoProfile -NonInteractive -Command \"[IO.File]::WriteAllText(''started.txt'', ''x''); [Threading.Thread]::Sleep(15000); [IO.File]::WriteAllText(''orphan.txt'', ''x'')\"'; "
                + "$i = [Diagnostics.ProcessStartInfo]::new(\"$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\", $a); $i.UseShellExecute = $false; $i.CreateNoWindow = $true; "
                + "[void][Diagnostics.Process]::Start($i); [Threading.Thread]::Sleep(60000)", "", [], 8_000));
            var result = await runner.Execute(command, CancellationToken.None);
            Assert.True(result.TimedOut && result.CleanupVerified && result.ExitCode is null);
            return 0;
        });
        Assert.True(File.Exists(fixture.Local("repo/started.txt")), "The grandchild never started, so the test proves nothing.");
        // The grandchild would write its marker 15 seconds after it started, well after the 8-second timeout.
        await Task.Delay(16_000, TestContext.Current.CancellationToken);
        Assert.False(File.Exists(fixture.Local("repo/orphan.txt")));
    }

    /// <summary>The console host Windows starts for the root inside the job can outlive it briefly. It is not a
    /// descendant: commands that start nothing never report one.</summary>
    [Fact]
    public async Task TheRootsConsoleHostIsNotABackgroundDescendant()
    {
        using var fixture = await Repository("foundry-p2-command-console-host-");
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            var runner = new CommandRunner(loop, new RepositoryService(loop, fixture.Local("wt"), fixture.Environment), fixture.Environment);
            for (var run = 0; run < 40; run++)
            {
                var result = await runner.Execute(await runner.Prepare(fixture.Local("repo"), Say($"run {run}")), CancellationToken.None);
                Assert.Equal(($"run {run}\r\n", "", (long?)0, true), (result.Stdout, result.Stderr, result.ExitCode, result.CleanupVerified));
            }
            return 0;
        });
    }

    /// <summary>The decision itself, deterministically: only a process that is not the system console host counts, and a
    /// process whose image cannot be read has exited.</summary>
    [Fact]
    public void OnlyAProcessOtherThanTheConsoleHostIsADescendant()
    {
        var host = Path.Join(Environment.SystemDirectory, "conhost.exe");
        Assert.False(CommandRunner.HasDescendant([]));
        Assert.False(CommandRunner.HasDescendant([host]));
        Assert.False(CommandRunner.HasDescendant([host.ToUpperInvariant(), null]));
        Assert.True(CommandRunner.HasDescendant([host, Shell]));
        Assert.True(CommandRunner.HasDescendant([Path.Join(Path.GetTempPath(), "conhost.exe")]));
    }

    /// <summary>The record keeps its own copy of the approved changes.</summary>
    [Fact]
    public async Task ACallersLaterEditCannotChangeTheApprovedEnvironment()
    {
        using var fixture = await Repository("foundry-p2-command-copy-");
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            var runner = new CommandRunner(loop, new RepositoryService(loop, fixture.Local("wt"), fixture.Environment), fixture.Environment);
            var changes = new List<KeyValuePair<string, string>> { new("CHOICE", "approved") };
            var command = await runner.Prepare(fixture.Local("repo"), new("[Console]::Out.WriteLine([Environment]::GetEnvironmentVariable('CHOICE'))", "", changes, 10_000));
            changes[0] = new("CHOICE", "edited");
            Assert.Equal("approved\r\n", (await runner.Execute(command, CancellationToken.None)).Stdout);
            return 0;
        });
    }

    [Fact]
    public async Task TheRunnerRequiresItsOwningLoop()
    {
        using var fixture = await Repository("foundry-p2-command-affinity-");
        await using var loop = new RuntimeLoop();
        var runner = await loop.Invoke(() => Task.FromResult(new CommandRunner(loop, new RepositoryService(loop, fixture.Local("wt"), fixture.Environment), fixture.Environment)));
        await Assert.ThrowsAsync<InvalidOperationException>(() => runner.Prepare(fixture.Local("repo"), Say("x")));
    }

    [Theory]
    [InlineData(@"C:\WINDOWS", "System32", @"C:\WINDOWS\System32")]
    [InlineData(@"C:\WINDOWS\", "Temp", @"C:\WINDOWS\Temp")]
    [InlineData("C:/Windows//", "System32", @"C:\Windows\System32")]
    [InlineData(@"C:\Windows\.\x\..", "Temp", @"C:\Windows\Temp")]
    public void JoinMatchesNodeWin32Join(string first, string second, string expected) => Assert.Equal(expected, CommandRunner.NodeJoin(first, second));

    [Theory]
    [InlineData(@"C:\a\b", @"C:\a")]
    [InlineData(@"C:\a\b\", @"C:\a")]
    [InlineData(@"C:\a", @"C:\")]
    [InlineData(@"C:\", @"C:\")]
    [InlineData(@"\a", @"\")]
    [InlineData("a", ".")]
    public void DirnameMatchesNodeWin32Dirname(string path, string expected) => Assert.Equal(expected, CommandRunner.NodeDirname(path));

    private static CommandRequest Say(string text) => new($"[Console]::Out.WriteLine('{text}')", "", [], 10_000);

    private static async Task<RepositoryFixture> Repository(string prefix)
    {
        var fixture = RepositoryFixture.Create(prefix);
        fixture.Write("repo/README.md", "hello\n"); fixture.Write("repo/src/a.ts", "export const a = 1;\n");
        await fixture.Git("-C", "repo", "init", "-q"); await fixture.Git("-C", "repo", "add", "-A"); await fixture.Git("-C", "repo", "commit", "-qm", "fixture");
        return fixture;
    }

    private static string Root(RepositoryFixture fixture, JsonElement step)
    {
        if (!step.TryGetProperty("root", out var root)) return fixture.Local("repo");
        var value = root.GetString()!;
        return value is "" or "relative" ? value : fixture.Local(value);
    }

    private static CommandRequest Request(JsonElement step) => new(
        Text(step.GetProperty("command")),
        step.TryGetProperty("cwd", out var cwd) ? cwd.GetString()! : "",
        step.TryGetProperty("environment", out var environment) ? [.. environment.EnumerateArray().Select(pair => new KeyValuePair<string, string>(pair[0].GetString()!, pair[1].GetString()!))] : [],
        step.TryGetProperty("timeoutMs", out var timeout) ? timeout.GetDouble() : 10_000);

    private static string Text(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.String) return value.GetString()!;
        var (unit, count) = (value.GetProperty("repeat")[0].GetString()!, value.GetProperty("repeat")[1].GetInt32());
        return unit.Length == 1 ? new string(unit[0], count) : string.Concat(Enumerable.Repeat(unit, count));
    }

    private static PreparedCommand Tamper(RepositoryFixture fixture, PreparedCommand command, JsonElement tamper)
    {
        var value = tamper[1];
        string Expand() => value.GetString()!.Replace("{scratch}", fixture.Scratch, StringComparison.Ordinal);
        return tamper[0].GetString() switch
        {
            "command" => command with { Command = Expand() },
            "cwd" => command with { Cwd = Expand() },
            "shell" => command with { Shell = Expand() },
            "timeoutMs" => command with { TimeoutMs = value.GetInt32() },
            "fingerprint" => command with { Fingerprint = Expand() },
            "environment" => command with { Environment = [.. value.EnumerateObject().Select(pair => new KeyValuePair<string, string>(pair.Name, pair.Value.GetString()!))] },
            var field => throw new InvalidOperationException($"Unknown field {field}."),
        };
    }

    private static Dictionary<string, object?> Outcome(RepositoryFixture fixture, InvalidOperationException error) => new()
    {
        ["error"] = Clean(fixture, error.Message), ["preflight"] = error is CommandPreflightException,
    };

    /// <summary>The oracle's normalization: the shell and SystemRoot become placeholders, then the scratch paths.</summary>
    private static object? Clean(RepositoryFixture fixture, object? value) => fixture.Normalize(Machine(value));

    private static object? Machine(object? value) => value switch
    {
        string text => text.Replace(Shell, "{shell}", StringComparison.Ordinal).Replace(SystemRoot, "{SystemRoot}", StringComparison.Ordinal),
        IDictionary<string, object?> map => map.ToDictionary(pair => pair.Key, pair => Machine(pair.Value)),
        System.Collections.IEnumerable items => items.Cast<object?>().Select(Machine).ToList(),
        _ => value,
    };
}
