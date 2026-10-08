using System.Collections;
using System.Globalization;
using System.Text;
using System.Text.Json;
using Xunit;

namespace Foundry.Platform.Tests;

/// <summary>
/// Spike S7: FinalPath against the TypeScript runtime's pathKey on the same machine and the same real tree.
/// scripts/golden-path-key.mjs mirrors store.ts (guarded by tests/golden/path-key.test.ts) and runs under the node.exe on
/// PATH, which must be Node 24 as in Electron 44; Node is required, never skipped. Drive-relative inputs ("C:foo") are
/// excluded: they depend on the hidden "=C:" variables, which no child environment can carry.
/// </summary>
public sealed class FinalPathTests
{
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    private sealed record NodeKey(string Input, string Canonical, string Key);

    [Fact]
    public async Task KeysMatchTheTypeScriptRuntimeOnARealTree()
    {
        var root = Scratch.Directory("foundry-path-key-").FullName;
        var corpus = await BuildCorpus(root);
        var expected = await NodeKeys(corpus);
        Assert.Equal(corpus.Count, expected.Count);

        var mismatches = new List<string>();
        for (var index = 0; index < corpus.Count; index++)
        {
            var input = corpus[index];
            Assert.Equal(input, expected[index].Input);
            var canonical = FinalPath.Canonical(input);
            var key = FinalPath.Key(input);
            if (!string.Equals(canonical, expected[index].Canonical, StringComparison.Ordinal) || !string.Equals(key, expected[index].Key, StringComparison.Ordinal))
            {
                mismatches.Add($"{Show(input)}: node {Show(expected[index].Canonical)} / {Show(expected[index].Key)}, C# {Show(canonical)} / {Show(key)}");
            }
        }
        Assert.True(mismatches.Count == 0, string.Join(Environment.NewLine, mismatches));
        TestContext.Current.TestOutputHelper?.WriteLine($"{corpus.Count} paths agree with Node.");
    }

    [Fact]
    public async Task ALongPathResolvesThroughItsJunction()
    {
        // Proves the long-path case above exercised the real path, not the fallback: the junction must be resolved.
        var root = Scratch.Directory("foundry-path-long-").FullName;
        var target = Directory.CreateDirectory(Path.Combine(root, "Target")).FullName;
        await CreateJunction(Path.Combine(root, "junction"), target);
        var deep = Path.Combine(root, "junction");
        while (deep.Length < 300)
        {
            deep = Path.Combine(deep, "segment-0123456789");
        }
        Directory.CreateDirectory(deep);
        Assert.StartsWith(target + Path.DirectorySeparatorChar, FinalPath.Canonical(deep), StringComparison.Ordinal);
    }

    [Fact]
    public void ANulCharacterFallsBackInsteadOfOpeningThePrefix()
    {
        var root = Scratch.Directory("foundry-path-nul-").FullName;
        var input = root + "\\" + "\0tail";
        Assert.Equal(input, FinalPath.Canonical(input));
        Assert.False(FinalPath.TryResolve(input, out _));
    }

    [Fact]
    public void TryResolveFailsClosedWhereCanonicalFallsBack()
    {
        var root = Scratch.Directory("foundry-path-resolve-").FullName;
        var existing = Directory.CreateDirectory(Path.Combine(root, "Existing")).FullName;
        Assert.True(FinalPath.TryResolve(Path.Combine(root, "EXISTING"), out var real));
        Assert.Equal(existing, real);
        Assert.Equal(FinalPath.Canonical(Path.Combine(root, "EXISTING")), real);

        var missing = Path.Combine(root, "missing");
        Assert.False(FinalPath.TryResolve(missing, out var none));
        Assert.Null(none);
        Assert.Equal(missing, FinalPath.Canonical(missing));
        Assert.False(FinalPath.TryResolve(existing + ".", out _)); // Node namespaces the path, so the trailing dot names another entry.
    }

    private static async Task<List<string>> BuildCorpus(string root)
    {
        var mixed = Directory.CreateDirectory(Path.Combine(root, "Mixed")).FullName;
        Directory.CreateDirectory(Path.Combine(mixed, "Sub"));
        await File.WriteAllTextAsync(Path.Combine(mixed, "file.txt"), "x", TestContext.Current.CancellationToken);
        Directory.CreateDirectory(Path.Combine(root, "\u00dcn\u00efc\u00f6d\u00e9"));
        Directory.CreateDirectory(Path.Combine(root, "\u0130stanbul"));
        Directory.CreateDirectory(Path.Combine(root, "\u0391\u03a3", "Sub"));
        Directory.CreateDirectory(Path.Combine(root, "\u0391\u03a3.d"));
        var spaced = Directory.CreateDirectory(Path.Combine(root, "Long Directory Name With Spaces")).FullName;
        await CreateJunction(Path.Combine(root, "junction"), mixed);
        var symlink = TryCreateSymbolicLink(Path.Combine(root, "symlink"), mixed);
        var deep = root;
        while (deep.Length < 300)
        {
            deep = Path.Combine(deep, "segment-0123456789");
        }
        Directory.CreateDirectory(deep);
        var shortName = (await Scratch.Run(Comspec, $"\"{Comspec}\" /d /c for %I in (\"{spaced}\") do @echo %~sI", root, Scratch.Environment(root))).Trim();
        var systemDrive = Path.GetPathRoot(root)!;

        var corpus = new List<string>
        {
            root,
            mixed,
            Path.Combine(root, "mIXED"),
            Path.Combine(root, "missing", "..", "Mixed"),
            root.Replace('\\', '/') + "/Mixed/",
            Path.Combine(root, "Mixed") + @"\.\Sub\\",
            Path.Combine(root, "Mixed", "file.txt"),
            Path.Combine(root, "Mixed") + ".",
            Path.Combine(root, "Mixed") + " ",
            Path.Combine(root, "\u00dcn\u00efc\u00f6d\u00e9"),
            Path.Combine(root, "\u00dcN\u00cfC\u00d6D\u00c9"),
            Path.Combine(root, "U\u0308n\u00efc\u00f6d\u00e9"),
            Path.Combine(root, "\u0130stanbul"),
            Path.Combine(root, "\u0130STANBUL"),
            Path.Combine(root, "\u0391\u03a3"),
            Path.Combine(root, "\u03b1\u03c2"),
            Path.Combine(root, "\u0391\u03a3", "Sub"),
            Path.Combine(root, "\u0391\u03a3.d"),
            Path.Combine(root, "missing", "\u0391\u03a3"),
            Path.Combine(root, "missing", "Child"),
            Path.Combine(root, "junction"),
            Path.Combine(root, "JUNCTION", "Sub"),
            Path.Combine(root, "junction", ".."),
            spaced,
            shortName,
            deep,
            deep.ToUpperInvariant(),
            @"\\?\" + mixed,
            @"\\?\" + Path.Combine(root, "missing"),
            @"\\.\" + mixed,
            @"\\.\pipe\foundry-no-such-pipe",
            @"\\localhost\" + systemDrive[0] + @"$\Windows",
            @"\\localhost\no-such-share-foundry\x",
            systemDrive,
            systemDrive.ToLowerInvariant(),
            "",
            ".",
            "relative-path-that-does-not-exist",
            mixed + "\0tail",
        };
        if (symlink is not null)
        {
            corpus.Add(symlink);
            corpus.Add(Path.Combine(symlink, "Sub"));
        }
        return corpus;
    }

    private static string Comspec => Environment.GetEnvironmentVariable("ComSpec") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");

    private static Task<string> CreateJunction(string link, string target) =>
        Scratch.Run(Comspec, $"\"{Comspec}\" /d /c mklink /J \"{link}\" \"{target}\"", Path.GetDirectoryName(link)!, Scratch.Environment(Path.GetDirectoryName(link)!));

    /// <summary>Directory symbolic links need Developer Mode or elevation; when they are unavailable the corpus says so.</summary>
    private static string? TryCreateSymbolicLink(string link, string target)
    {
        try
        {
            Directory.CreateSymbolicLink(link, target);
            return link;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            TestContext.Current.TestOutputHelper?.WriteLine($"Symbolic link case not covered: {exception.Message}");
            return null;
        }
    }

    private static async Task<List<NodeKey>> NodeKeys(List<string> corpus)
    {
        var node = FindOnPath("node.exe") ?? throw new InvalidOperationException("node.exe was not found on PATH; the FinalPath oracle needs Node.");
        var script = Path.Combine(Scratch.RepositoryRoot, "scripts", "golden-path-key.mjs");
        var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            environment[(string)entry.Key] = (string?)entry.Value ?? string.Empty;
        }
        var version = (await Scratch.Run(node, $"\"{node}\" -p process.versions.node", Environment.CurrentDirectory, environment)).Trim();
        Assert.True(version.StartsWith("24.", StringComparison.Ordinal), $"The oracle must be Node 24, the runtime of Electron 44; PATH has Node {version}.");
        // Same working directory, so relative inputs resolve against the same current directory.
        var output = await Scratch.Run(node, $"\"{node}\" \"{script}\"", Environment.CurrentDirectory, environment, JsonSerializer.Serialize(corpus));
        return JsonSerializer.Deserialize<List<NodeKey>>(output, Web)
            ?? throw new InvalidOperationException("The Node oracle returned no keys.");
    }

    private static string? FindOnPath(string file) =>
        (Environment.GetEnvironmentVariable("PATH") ?? string.Empty).Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(directory => Path.Combine(directory.Trim('"'), file))
            .FirstOrDefault(File.Exists);

    private static string Show(string value)
    {
        var builder = new StringBuilder("\"");
        foreach (var character in value)
        {
            if (character is < ' ' or > '~')
            {
                builder.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
            }
            else
            {
                builder.Append(character);
            }
        }
        return builder.Append('"').ToString();
    }
}
