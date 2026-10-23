using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Foundry.Protocol;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

/// <summary>
/// The unwired one-shot existing-file edit primitive against the committed Node outcomes
/// (tests/p2/existing-file-edit.test.ts), plus the exclusive write window and outcome classification native adds.
/// </summary>
public sealed class ExistingFileEditTests
{
    private static readonly JsonElement Corpus = RepositoryFixture.ReadCorpus("tests/p2/existing-file-edit-vectors.json");

    /// <summary>Where Node raised a raw filesystem error, native refuses with its own fixed message and the same outcome.</summary>
    private static readonly Dictionary<string, string> NativeRefusals = new(StringComparer.Ordinal)
    {
        ["creates one reviewed absent file and refuses an unavailable root#2"] = RepositoryFolderLease.Unavailable,
        ["refuses roots that are not working directories#4"] = RepositoryFolderLease.Unavailable,
        ["refuses directories, missing files and missing parents#1"] = RepositoryService.Missing,
        ["refuses directories, missing files and missing parents#2"] = RepositoryService.Missing,
        ["refuses directories, missing files and missing parents#3"] = RepositoryService.Missing,
        ["refuses a file removed after review#2"] = RepositoryService.Missing,
        ["refuses a read-only file at execution#2"] = RepositoryService.EditUnavailable,
    };

    public static IEnumerable<object[]> Cases()
    {
        var index = 0;
        foreach (var item in Corpus.GetProperty("cases").EnumerateArray()) yield return [item.GetProperty("name").GetString()!, index++];
    }

    [Theory, MemberData(nameof(Cases))]
    public async Task EditsMatchCommittedNodeOutcomesAndFinalBytes(string name, int index)
    {
        var item = Corpus.GetProperty("cases")[index];
        Assert.Equal(name, item.GetProperty("name").GetString());
        using var fixture = RepositoryFixture.Create("foundry-p2-edit-");
        await fixture.Build(item.GetProperty("tree"));
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            var service = new RepositoryService(loop, fixture.Local("wt"), fixture.Environment);
            var prepared = new Dictionary<string, PreparedEdit>(StringComparer.Ordinal);
            var position = 0;
            foreach (var step in item.GetProperty("steps").EnumerateArray())
            {
                object? value = null; string? error = null; string? outcome = null;
                try { value = await Perform(service, fixture, step, prepared); }
                catch (InvalidOperationException exception) { error = (string)fixture.Normalize(exception.Message)!; outcome = (exception as RepositoryException)?.Outcome; }
                var expected = step.GetProperty("expected");
                var label = $"{name}#{position++}";
                if (expected.TryGetProperty("result", out var result))
                {
                    Assert.True(error is null, $"{label}: {error}");
                    var actual = JsonSerializer.SerializeToElement(fixture.Normalize(value));
                    Assert.True(JsonElement.DeepEquals(result, actual), $"{label}: expected {result.GetRawText()}\nactual   {actual.GetRawText()}");
                    continue;
                }
                Assert.Equal(expected.GetProperty("outcome").ValueKind == JsonValueKind.Null ? null : expected.GetProperty("outcome").GetString(), outcome);
                if (expected.TryGetProperty("error", out var message)) Assert.Equal(message.GetString(), error);
                else Assert.Equal(NativeRefusals[label], error);
            }
            return 0;
        });
        var files = item.GetProperty("files").EnumerateArray().Select(pair => (pair[0].GetString()!, pair[1].GetString()!)).ToList();
        Assert.Equal(files, Files(fixture.Scratch));
    }

    [Fact]
    public void OracleSourceBindingsAreCurrentAndEveryRawErrorHasANativeRefusal()
    {
        Assert.Equal(1, Corpus.GetProperty("schemaVersion").GetInt32());
        RepositoryFixture.AssertOracleSources(Corpus);
        var raw = new List<string>();
        foreach (var item in Corpus.GetProperty("cases").EnumerateArray())
        {
            var position = 0;
            foreach (var step in item.GetProperty("steps").EnumerateArray())
                if (step.GetProperty("expected").TryGetProperty("systemError", out _)) raw.Add($"{item.GetProperty("name").GetString()}#{position++}"); else position++;
        }
        Assert.Equal(NativeRefusals.Keys.Order(StringComparer.Ordinal), raw.Order(StringComparer.Ordinal));
    }

    /// <summary>Native difference: a file another handle can write is refused before anything is written, where Node's
    /// shared open would proceed.</summary>
    [Fact]
    public async Task AnotherWriterRefusesTheEditBeforeAnythingIsWritten()
    {
        using var fixture = RepositoryFixture.Create("foundry-p2-edit-writer-");
        fixture.Write("plain/a.txt", "hello\n");
        await using var loop = new RuntimeLoop();
        await loop.Invoke(() =>
        {
            var service = new RepositoryService(loop, fixture.Local("wt"), fixture.Environment);
            var edit = service.PrepareEdit(fixture.Local("plain"), "a.txt", Sha(fixture.Local("plain/a.txt")), "changed\n");
            using (new FileStream(fixture.Local("plain/a.txt"), FileMode.Open, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete))
            {
                var refused = Assert.Throws<RepositoryException>(() => service.ApplyEdit(edit));
                Assert.Equal((RepositoryService.EditUnavailable, "none"), (refused.Message, refused.Outcome));
            }
            Assert.Equal("hello\n", File.ReadAllText(fixture.Local("plain/a.txt")));
            Assert.Equal(edit.ResultingHash, service.ApplyEdit(edit)["hash"]);
            return Task.FromResult(0);
        });
        Assert.Equal("changed\n", File.ReadAllText(fixture.Local("plain/a.txt")));
    }

    /// <summary>
    /// From the content check to the verified write the file is held exclusively: readers that share writing still read it, but no other
    /// writer, rename, delete or replacement of it or its folders can start, so what was checked is what is replaced.
    /// </summary>
    [Fact]
    public async Task NothingCanChangeTheFileAtTheWriteBoundary()
    {
        using var fixture = RepositoryFixture.Create("foundry-p2-edit-boundary-");
        fixture.Write("plain/sub/a.txt", "hello\n"); fixture.Write("plain/other.txt", "other\n");
        var file = fixture.Local("plain/sub/a.txt");
        var attempts = new List<string>();
        await using var loop = new RuntimeLoop();
        await loop.Invoke(() =>
        {
            var service = new RepositoryService(loop, fixture.Local("wt"), fixture.Environment);
            var edit = service.PrepareEdit(fixture.Local("plain"), "sub/a.txt", Sha(file), "changed\n");
            service.EditStage = stage =>
            {
                if (stage != "boundary") return;
                using (var reader = new StreamReader(new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))) Assert.Equal("hello\n", reader.ReadToEnd());
                void Refused(string what, Action action)
                {
                    try { action(); attempts.Add(what + " succeeded"); }
                    catch (Exception error) when (error is IOException or UnauthorizedAccessException) { attempts.Add(what + " refused"); }
                }
                Refused("write", () => File.WriteAllText(file, "raced\n"));
                Refused("rename", () => File.Move(file, fixture.Local("plain/sub/moved.txt")));
                Refused("replace", () => File.Move(fixture.Local("plain/other.txt"), file, overwrite: true));
                Refused("delete", () => File.Delete(file));
                Refused("rename folder", () => Directory.Move(fixture.Local("plain/sub"), fixture.Local("plain/moved")));
            };
            Assert.Equal(new Dictionary<string, object?> { ["path"] = "sub/a.txt", ["hash"] = edit.ResultingHash }, service.ApplyEdit(edit));
            return Task.FromResult(0);
        });
        Assert.Equal(["write refused", "rename refused", "replace refused", "delete refused", "rename folder refused"], attempts);
        Assert.Equal("changed\n", File.ReadAllText(file)); Assert.Equal("other\n", File.ReadAllText(fixture.Local("plain/other.txt")));
    }

    /// <summary>A failure before the write is "none" and leaves the file; once the write starts, any failure is "unknown".</summary>
    [Fact]
    public async Task FailuresAreClassifiedByWhetherTheWriteStarted()
    {
        using var fixture = RepositoryFixture.Create("foundry-p2-edit-outcome-");
        fixture.Write("plain/a.txt", "hello\n");
        var file = fixture.Local("plain/a.txt");
        await using var loop = new RuntimeLoop();
        await loop.Invoke(() =>
        {
            var service = new RepositoryService(loop, fixture.Local("wt"), fixture.Environment);
            var edit = service.PrepareEdit(fixture.Local("plain"), "a.txt", Sha(file), "changed\n");
            service.EditStage = stage => { if (stage == "boundary") throw new InvalidOperationException("Injected before the write."); };
            var before = Assert.Throws<RepositoryException>(() => service.ApplyEdit(edit));
            Assert.Equal(("Injected before the write.", "none"), (before.Message, before.Outcome));
            Assert.Equal("hello\n", File.ReadAllText(file));
            service.EditStage = stage => { if (stage == "written") throw new IOException("Injected after the write."); };
            var after = Assert.Throws<RepositoryException>(() => service.ApplyEdit(edit));
            Assert.Equal(("Injected after the write.", "unknown"), (after.Message, after.Outcome));
            Assert.Equal("changed\n", File.ReadAllText(file));
            // The written content no longer matches the reviewed hash: the same approval cannot apply again.
            service.EditStage = null;
            var replay = Assert.Throws<RepositoryException>(() => service.ApplyEdit(edit));
            Assert.Equal(("Stale edit: file content changed since it was read.", "none"), (replay.Message, replay.Outcome));
            return Task.FromResult(0);
        });
    }

    [Fact]
    public async Task EditsRequireTheOwningLoop()
    {
        await using var loop = new RuntimeLoop();
        var service = await loop.Invoke(() => Task.FromResult(new RepositoryService(loop, Path.Combine(Path.GetTempPath(), "unused"))));
        Assert.Throws<InvalidOperationException>(() => service.PrepareEdit("C:\\unused", "a.txt", new string('0', 64), "x"));
        var edit = new PreparedEdit("C:\\unused", "a.txt", "", "x", new string('0', 64), new string('0', 64), new string('0', 64));
        Assert.Throws<InvalidOperationException>(() => service.ApplyEdit(edit));
    }

    private static async Task<object?> Perform(RepositoryService service, RepositoryFixture fixture, JsonElement step, Dictionary<string, PreparedEdit> prepared)
    {
        string Local(string name) => fixture.Local(step.GetProperty(name).GetString()!);
        switch (step.GetProperty("op").GetString())
        {
            case "prepare":
                {
                    var expectedHash = step.GetProperty("reviewed") switch
                    {
                        { ValueKind: JsonValueKind.Null } => null,
                        { ValueKind: JsonValueKind.String } literal => literal.GetString(),
                        var reference => Sha(fixture.Local(reference.GetProperty("hashOf").GetString()!)),
                    };
                    var after = step.GetProperty("after") is { ValueKind: JsonValueKind.String } text ? text.GetString()!
                        : string.Concat(Enumerable.Repeat(step.GetProperty("after").GetProperty("repeat")[0].GetString()!, step.GetProperty("after").GetProperty("repeat")[1].GetInt32()));
                    var root = step.GetProperty("root").GetString()!;
                    var edit = service.PrepareEdit(root is "" or "relative" ? root : fixture.Local(root), step.GetProperty("path").GetString()!, expectedHash, after);
                    if (step.TryGetProperty("as", out var alias)) prepared[alias.GetString()!] = edit;
                    var fields = new List<object?> { edit.Root, edit.Path, edit.ExpectedHash, edit.ResultingHash };
                    if (edit.ExpectedHash is null) fields.Add(edit.CreationIdentities!.Cast<object?>().ToList());
                    var actualPreimage = JsJson.Stringify(fields)!;
                    Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(actualPreimage))), edit.Fingerprint);
                    if (edit.ExpectedHash is null) fields[^1] = "{creation-identities}";
                    return new Dictionary<string, object?>(edit.ToWire()) { ["fingerprint"] = new Dictionary<string, object?> { ["preimage"] = JsJson.Stringify(fields)! } };
                }
            case "apply":
                {
                    var edit = prepared[step.GetProperty("edit").GetString()!];
                    if (step.TryGetProperty("tamper", out var tamper))
                    {
                        if (tamper.TryGetProperty("after", out var after)) edit = edit with { After = after.GetString()! };
                        if (tamper.TryGetProperty("fingerprint", out var fingerprint)) edit = edit with { Fingerprint = fingerprint.GetString()! };
                    }
                    return service.ApplyEdit(edit);
                }
            case "write": File.WriteAllText(Local("file"), step.GetProperty("text").GetString()!); return null;
            case "rename": File.Move(Local("from"), Local("to")); return null;
            case "remove": File.Delete(Local("file")); return null;
            case "hardlink":
                await fixture.Build(JsonSerializer.SerializeToElement(new[] { new Dictionary<string, string> { ["hardlink"] = step.GetProperty("link").GetString()!, ["target"] = step.GetProperty("target").GetString()! } }));
                return null;
            case "readonly": File.SetAttributes(Local("file"), FileAttributes.ReadOnly); return null;
            default: throw new InvalidOperationException("Unknown step.");
        }
    }

    private static string Sha(string path) => Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(path)));

    /// <summary>The oracle's listing: every file except Git metadata, the isolated home and anything behind a link, ordinally.</summary>
    private static List<(string, string)> Files(string scratch)
    {
        var found = new List<(string, string)>();
        void Visit(string relative)
        {
            foreach (var entry in new DirectoryInfo(@"\\?\" + Path.Join(scratch, relative.Replace('/', '\\'))).EnumerateFileSystemInfos())
            {
                var child = relative.Length > 0 ? relative + "/" + entry.Name : entry.Name;
                if (entry.Attributes.HasFlag(FileAttributes.ReparsePoint) || entry.Name == ".git" || child == "home") continue;
                if (entry.Attributes.HasFlag(FileAttributes.Directory)) Visit(child);
                else found.Add((child, Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(entry.FullName)))));
            }
        }
        Visit("");
        return [.. found.OrderBy(pair => pair.Item1, StringComparer.Ordinal)];
    }
}
