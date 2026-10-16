using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Foundry.Platform;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

/// <summary>
/// Disposable repository trees for the Git/files conformance suites, built exactly as the Node oracles build them. Fixture
/// and runtime Git share an isolated HOME, no system configuration and the C locale, so outcomes do not depend on the
/// machine's Git configuration.
/// </summary>
internal sealed class RepositoryFixture : IDisposable
{
    private readonly List<string> links = [];

    private RepositoryFixture(string scratch)
    {
        Scratch = scratch;
        Home = Directory.CreateDirectory(Path.Combine(scratch, "home")).FullName;
    }

    internal string Scratch { get; }
    internal string Home { get; }

    internal static RepositoryFixture Create(string prefix) => new(FinalPath.Canonical(Directory.CreateTempSubdirectory(prefix).FullName));

    internal static string Root
    {
        get
        {
            for (var root = new DirectoryInfo(AppContext.BaseDirectory); root is not null; root = root.Parent)
                if (File.Exists(Path.Combine(root.FullName, "Foundry.slnx"))) return root.FullName;
            throw new InvalidOperationException("Missing repository root.");
        }
    }

    internal static JsonElement ReadCorpus(string relative)
    {
        using var document = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(Root, relative)));
        return document.RootElement.Clone();
    }

    internal static void AssertOracleSources(JsonElement corpus)
    {
        foreach (var source in corpus.GetProperty("oracle").GetProperty("sources").EnumerateArray())
            Assert.Equal(source.GetProperty("sha256").GetString(), Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(Path.Combine(Root, source.GetProperty("path").GetString()!)))));
    }

    internal Dictionary<string, string> Isolation => new(StringComparer.OrdinalIgnoreCase)
    {
        ["GIT_CONFIG_NOSYSTEM"] = "1", ["HOME"] = Home, ["XDG_CONFIG_HOME"] = Home, ["LC_ALL"] = "C", ["LANG"] = "C", ["LANGUAGE"] = "C",
    };

    /// <summary>The runtime's inherited environment for these fixtures: the process environment plus the isolation.</summary>
    internal IReadOnlyDictionary<string, string> Environment()
    {
        var values = new Dictionary<string, string>(GitRunner.ProcessEnvironment(), StringComparer.OrdinalIgnoreCase);
        foreach (var (name, value) in Isolation) values[name] = value;
        return values;
    }

    internal string Local(string relative) => Path.Combine(Scratch, relative.Replace('/', '\\'));

    internal async Task Build(JsonElement tree)
    {
        foreach (var step in tree.EnumerateArray())
        {
            if (step.TryGetProperty("dir", out var directory)) Directory.CreateDirectory(Local(directory.GetString()!));
            else if (step.TryGetProperty("file", out var file))
            {
                byte[] bytes = step.TryGetProperty("base64", out var base64) ? Convert.FromBase64String(base64.GetString()!)
                    : step.TryGetProperty("repeat", out var repeat) ? Encoding.UTF8.GetBytes(string.Concat(Enumerable.Repeat(repeat[0].GetString()!, repeat[1].GetInt32())))
                    : Encoding.UTF8.GetBytes(step.GetProperty("text").GetString()!);
                Write(file.GetString()!, bytes);
            }
            else if (step.TryGetProperty("junction", out var junction)) await Junction(junction.GetString()!, step.GetProperty("target").GetString()!);
            else if (step.TryGetProperty("hardlink", out var hardlink)) await Command(Comspec, ["/d", "/c", "mklink", "/H", Local(hardlink.GetString()!), Local(step.GetProperty("target").GetString()!)]);
            else if (step.TryGetProperty("remove", out var removed)) File.Delete(Local(removed.GetString()!));
            else await Git([.. step.GetProperty("git").EnumerateArray().Select(argument => argument.GetString()!)]);
        }
    }

    /// <summary>Names are written literally (a trailing space or dot, reserved device names), as Node's namespaced writes do.</summary>
    internal void Write(string relative, byte[] bytes)
    {
        var target = Local(relative);
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        File.WriteAllBytes(@"\\?\" + target, bytes);
    }

    internal void Write(string relative, string text) => Write(relative, Encoding.UTF8.GetBytes(text));

    internal async Task Junction(string link, string target)
    {
        await Command(Comspec, ["/d", "/c", "mklink", "/J", Local(link), Local(target)]);
        links.Add(Local(link));
    }

    internal Task Git(params string[] arguments) => Command("git", [
        "-c", $"core.hooksPath={Path.Combine(Scratch, "no-fixture-hooks")}", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-c", "core.autocrlf=false",
        "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", .. arguments], fixture: true);

    internal async Task<string> GitOutput(params string[] arguments)
    {
        var output = new StringBuilder();
        await Command("git", arguments, fixture: true, output);
        return output.ToString().Trim();
    }

    private static string Comspec => System.Environment.GetEnvironmentVariable("ComSpec") ?? Path.Combine(System.Environment.GetFolderPath(System.Environment.SpecialFolder.System), "cmd.exe");

    private async Task Command(string application, IEnumerable<string> arguments, bool fixture = false, StringBuilder? capture = null)
    {
        var info = new ProcessStartInfo(application) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = Scratch };
        foreach (var argument in arguments) info.ArgumentList.Add(argument);
        foreach (var name in info.Environment.Keys.Where(key => key.StartsWith("GIT_", StringComparison.OrdinalIgnoreCase)).ToList()) info.Environment.Remove(name);
        if (fixture)
        {
            foreach (var (name, value) in Isolation) info.Environment[name] = value;
            info.Environment["GIT_AUTHOR_DATE"] = "2026-01-01T00:00:00Z"; info.Environment["GIT_COMMITTER_DATE"] = "2026-01-01T00:00:00Z";
        }
        using var process = Process.Start(info)!;
        var output = process.StandardOutput.ReadToEndAsync(TestContext.Current.CancellationToken); var error = process.StandardError.ReadToEndAsync(TestContext.Current.CancellationToken);
        await process.WaitForExitAsync(TestContext.Current.CancellationToken);
        Assert.True(process.ExitCode == 0, $"{application} exited with {process.ExitCode}: {await output}{await error}");
        capture?.Append(await output);
    }

    /// <summary>The oracle's normalization: scratch paths become placeholders, and long strings are pinned by length and hash.</summary>
    internal object? Normalize(object? value) => value switch
    {
        string text => Long(text.Replace(Scratch, "{scratch}", StringComparison.Ordinal).Replace(Scratch.Replace('\\', '/'), "{scratch/}", StringComparison.Ordinal)),
        IDictionary<string, object?> map => map.ToDictionary(pair => pair.Key, pair => Normalize(pair.Value)),
        System.Collections.IEnumerable items => items.Cast<object?>().Select(Normalize).ToList(),
        _ => value,
    };

    private static object Long(string text) => text.Length > 4096
        ? new Dictionary<string, object?> { ["length"] = text.Length, ["sha256"] = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text))) }
        : text;

    public void Dispose()
    {
        foreach (var link in links) if (Directory.Exists(link)) Directory.Delete(link);
        var root = @"\\?\" + Scratch;
        // Git writes read-only object files; literal names (trailing dots or spaces) need the namespaced spelling.
        foreach (var file in new DirectoryInfo(root).EnumerateFiles("*", new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = FileAttributes.ReparsePoint }))
            file.Attributes = FileAttributes.Normal;
        Directory.Delete(root, true);
    }
}
