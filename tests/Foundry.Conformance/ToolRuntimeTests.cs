using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Foundry.Platform;
using Foundry.Protocol;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

/// <summary>
/// The unwired native coding tools against the committed Node outcomes (tests/p2/tool-runtime.test.ts): the advertised
/// definitions byte for byte, zod's parse of every tool's arguments with its exact issue text, search over the same
/// trees, and the same tool calls through ToolRuntime with their decisions, cancellations, approval rows and events,
/// cleaned as the oracle cleans them. Native-only tests pin the named differences.
/// </summary>
public sealed partial class ToolRuntimeTests
{
    private const string VectorPath = "tests/p2/tool-runtime-vectors.json";
    private static readonly JsonElement Raw = RepositoryFixture.ReadCorpus(VectorPath);
    private static readonly Dictionary<string, object?> Corpus = (Dictionary<string, object?>)PersistedJson.Parse(File.ReadAllText(Path.Combine(RepositoryFixture.Root, VectorPath)))!;
    private static readonly string SystemRoot = Environment.GetEnvironmentVariable("SystemRoot")!;
    private static readonly string Shell = FinalPath.Resolve(Path.Combine(SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));

    /// <summary>Where Node raised a raw filesystem error, native refuses with its own fixed message.</summary>
    private static readonly Dictionary<string, string> NativeRefusals = new(StringComparer.Ordinal)
    {
        ["reads and refusals#2"] = RepositoryService.Missing,
        ["reads and refusals#3"] = RepositoryService.NotDirectory,
        ["reads and refusals#10"] = RepositoryService.Missing,
        ["edits#3"] = RepositoryService.Missing,
        ["commands#3"] = RepositoryService.Missing,
        ["search walk#9"] = RepositoryService.Missing,
        ["search walk#10"] = RepositoryService.NotDirectory,
    };

    public static IEnumerable<object[]> SearchCases() => Raw.GetProperty("search").EnumerateArray().Select((item, index) => new object[] { item.GetProperty("name").GetString()!, index });

    public static IEnumerable<object[]> ExecutionCases() => Raw.GetProperty("executions").EnumerateArray().Select((item, index) => new object[] { item.GetProperty("name").GetString()!, index });

    [Fact]
    public void OracleSourceBindingsAreCurrentAndEveryRawErrorHasANativeRefusal()
    {
        Assert.Equal(1, Raw.GetProperty("schemaVersion").GetInt32());
        RepositoryFixture.AssertOracleSources(Raw);
        var raw = new List<string>();
        foreach (var item in Raw.GetProperty("search").EnumerateArray())
            raw.AddRange(item.GetProperty("results").EnumerateArray().Select((result, index) => (result, index)).Where(entry => entry.result.TryGetProperty("systemError", out _))
                .Select(entry => $"search {item.GetProperty("name").GetString()}#{entry.index}"));
        foreach (var item in Raw.GetProperty("executions").EnumerateArray())
            raw.AddRange(item.GetProperty("steps").EnumerateArray().Select((step, index) => (step, index))
                .Where(entry => entry.step.GetProperty("result").GetProperty("content").ValueKind == JsonValueKind.Object)
                .Select(entry => $"{item.GetProperty("name").GetString()}#{entry.index}"));
        Assert.Equal(NativeRefusals.Keys.Order(StringComparer.Ordinal), raw.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void DefinitionsAreByteExact() => Assert.Equal((string)Corpus["definitions"]!, JsJson.Stringify(ToolDefinitions.All));

    [Fact]
    public void ArgumentsMatchZod()
    {
        var position = 0;
        foreach (var item in ((List<object?>)Corpus["arguments"]!).Cast<Dictionary<string, object?>>())
        {
            var label = $"arguments #{position++} {item["tool"]} {JsJson.Stringify(item["input"])}";
            string? value = null, error = null;
            try { value = JsJson.Stringify(Pin(ToolDefinitions.Parse((string)item["tool"]!, Expand(item["input"])))); }
            catch (ToolArgumentException exception) { error = exception.Message; }
            if (item.TryGetValue("value", out var expected)) Assert.True(JsJson.Stringify(expected) == value, $"{label}: expected {JsJson.Stringify(expected)}\nactual   {value ?? error}");
            else Assert.True(Equals(item["error"], error), $"{label}: expected {item["error"]}\nactual   {error ?? value}");
        }
    }

    [Theory, MemberData(nameof(SearchCases))]
    public async Task SearchMatchesNode(string name, int index)
    {
        var item = Raw.GetProperty("search")[index];
        var expected = (Dictionary<string, object?>)((List<object?>)Corpus["search"]!)[index]!;
        using var fixture = RepositoryFixture.Create("foundry-p2-search-");
        await fixture.Build(item.GetProperty("tree"));
        foreach (var fill in ((List<object?>)expected["fills"]!).Cast<Dictionary<string, object?>>())
            for (var count = 0; count < (int)(double)fill["count"]!; count++) fixture.Write($"{fill["dir"]}/f{count.ToString("D5", CultureInfo.InvariantCulture)}.txt", (string)fill["text"]!);
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            var repositories = new RepositoryService(loop, fixture.Local("wt"), fixture.Environment);
            var position = 0;
            foreach (var query in ((List<object?>)expected["results"]!).Cast<Dictionary<string, object?>>())
            {
                var label = $"search {name}#{position++}";
                string? value = null, error = null;
                try { value = await repositories.Search(fixture.Local("repo"), (string)Expand(query["query"])!, query.GetValueOrDefault("path") as string ?? ""); }
                catch (WorkspaceReadException exception) { error = (string)fixture.Normalize(exception.Message)!; }
                if (query.ContainsKey("systemError")) Assert.True(NativeRefusals[label] == error, $"{label}: expected {NativeRefusals[label]}, actual {error ?? value}");
                else if (query.TryGetValue("value", out var text)) Assert.True(Equals(text, value), $"{label}: expected {text}\nactual   {value ?? error}");
                else Assert.True(Equals(query["error"], error), $"{label}: expected {query["error"]}, actual {error ?? value}");
            }
            return 0;
        });
    }

    [Theory, MemberData(nameof(ExecutionCases))]
    public async Task ExecutionsMatchNode(string name, int index)
    {
        var item = Raw.GetProperty("executions")[index];
        var steps = ((List<object?>)((Dictionary<string, object?>)((List<object?>)Corpus["executions"]!)[index]!)["steps"]!).Cast<Dictionary<string, object?>>().ToList();
        using var fixture = RepositoryFixture.Create("foundry-p2-tools-");
        foreach (var folder in new[] { "tmp", "profile", "data" }) Directory.CreateDirectory(fixture.Local(folder));
        await fixture.Build(item.GetProperty("tree"));
        var environment = new Dictionary<string, string>(fixture.Environment(), StringComparer.OrdinalIgnoreCase)
        {
            ["TEMP"] = fixture.Local("tmp"), ["TMP"] = fixture.Local("tmp"), ["USERPROFILE"] = fixture.Local("profile"),
        };
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            using var store = new Store(loop, fixture.Local("data"), Path.Combine(fixture.Scratch, "injected-root"));
            var repositories = new RepositoryService(loop, Path.Combine(fixture.Local("data"), "wt"), () => environment);
            var tools = new ToolRuntime(loop, store, repositories, new CommandRunner(loop, repositories, () => environment), new Redactor(), new ExecutionSlots(loop), () => DateTimeOffset.UtcNow, Guid.NewGuid);
            foreach (var task in ((List<object?>)Corpus["tasks"]!).Cast<Dictionary<string, object?>>())
                store.SaveTask((Dictionary<string, object?>)PersistedJson.Parse(JsJson.Stringify(task)!.Replace("{scratch}", fixture.Scratch.Replace("\\", "\\\\", StringComparison.Ordinal), StringComparison.Ordinal))!);
            var cleaner = new Cleaner(fixture.Scratch, Shell, SystemRoot);
            List<Dictionary<string, object?>> Rows() => store.Rows("SELECT rowid AS _rowid,* FROM intents WHERE kind='tool.approval' ORDER BY rowid");
            var position = 0;
            foreach (var expected in steps)
            {
                var label = $"{name}#{position++}";
                var step = (Dictionary<string, object?>)expected["call"]!;
                var taskId = Id((int)(double)step["task"]!);
                var sequence = (long)store.Scalar("SELECT COALESCE(MAX(sequence),0) FROM events")!;
                var known = Rows().Select(row => (string)row["id"]!).ToHashSet(StringComparer.Ordinal);
                Dictionary<string, object?>? Fresh() => Rows().FirstOrDefault(row => !known.Contains((string)row["id"]!));
                using var cancellation = new CancellationTokenSource();
                if (Equals(step.GetValueOrDefault("abort"), "before")) await cancellation.CancelAsync();
                var pending = tools.Execute(store.ReadTask(taskId), new ToolCall((string)step["id"]!, (string)step["name"]!, Expand(step["arguments"])), cancellation.Token);
                async Task<object?> Decide(Dictionary<string, object?> decision)
                {
                    if (decision.ContainsKey("cancel")) { await cancellation.CancelAsync(); return new Dictionary<string, object?> { ["cancelled"] = true }; }
                    if (decision.TryGetValue("revoke", out var revoke)) { tools.RevokeWaiting(Id((int)(double)revoke!)); return new Dictionary<string, object?> { ["revoked"] = revoke }; }
                    var approval = Fresh()!;
                    var nonce = (string)((Dictionary<string, object?>)PersistedJson.Parse((string)approval["data"]!)!)["nonce"]!;
                    try
                    {
                        return new Dictionary<string, object?>
                        {
                            ["value"] = tools.Decide(Id(decision.TryGetValue("taskId", out var other) ? (int)(double)other! : (int)(double)step["task"]!),
                                Equals(decision.GetValueOrDefault("approvalId"), "missing") ? Id(999) : (string)approval["id"]!, Equals(decision.GetValueOrDefault("nonce"), "wrong") ? "wrong-nonce" : nonce,
                                (string)decision["decide"]!),
                        };
                    }
                    catch (WorkspaceReadException exception) { return new Dictionary<string, object?> { ["error"] = exception.Message }; }
                }
                var decisions = new List<object?>(); Dictionary<string, object?>? proposal = null;
                if (step.GetValueOrDefault("whileWaiting") is List<object?> changes)
                {
                    for (var wait = 0; wait < 6000 && !pending.IsCompleted && Fresh() is null; wait++) await Task.Delay(5);
                    proposal = Fresh();
                    foreach (var change in changes.Cast<Dictionary<string, object?>>())
                    {
                        if (change.ContainsKey("decide") || change.ContainsKey("cancel") || change.ContainsKey("revoke")) decisions.Add(await Decide(change));
                        else
                        {
                            using var tree = JsonDocument.Parse("[" + JsJson.Stringify(change) + "]");
                            await fixture.Build(tree.RootElement);
                        }
                    }
                }
                var outcome = await pending;
                object? content = outcome.Content;
                if (NativeRefusals.TryGetValue(label, out var refusal))
                {
                    Assert.True(outcome.IsError && outcome.Content == refusal, $"{label}: expected native refusal {refusal}, actual {outcome.Content}");
                    content = ((Dictionary<string, object?>)expected["result"]!)["content"];
                }
                var after = new List<object?>();
                foreach (var decision in ((List<object?>?)step.GetValueOrDefault("after") ?? []).Cast<Dictionary<string, object?>>()) after.Add(await Decide(decision));
                cleaner.Remember(Rows());
                var record = new Dictionary<string, object?>
                {
                    ["call"] = step, ["result"] = new Dictionary<string, object?> { ["id"] = outcome.Id, ["name"] = outcome.Name, ["content"] = content, ["isError"] = outcome.IsError },
                };
                if (proposal is not null) record["proposal"] = proposal;
                record["decisions"] = decisions; record["after"] = after;
                record["row"] = Rows().FirstOrDefault(row => !known.Contains((string)row["id"]!));
                record["events"] = store.Rows("SELECT * FROM events WHERE sequence>$p0 ORDER BY sequence", sequence);
                if (step.GetValueOrDefault("read") is string read) record["read"] = Encoding.UTF8.GetString(File.ReadAllBytes(fixture.Local("repo/" + read)));
                var actual = JsJson.Stringify(cleaner.Clean(record));
                Assert.True(JsJson.Stringify(expected) == actual, $"{label}: expected {JsJson.Stringify(expected)}\nactual   {actual}");
            }
            return 0;
        });
    }

    [Fact]
    public async Task DecisionsOnApprovalsNoCallAwaitsMatchNodeAndChangeNothing()
    {
        using var fixture = RepositoryFixture.Create("foundry-p2-decide-");
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            using var store = new Store(loop, fixture.Scratch, Path.Combine(fixture.Scratch, "injected-root"));
            var repositories = new RepositoryService(loop, fixture.Local("wt"), fixture.Environment);
            var tools = new ToolRuntime(loop, store, repositories, new CommandRunner(loop, repositories, fixture.Environment), new Redactor(), new ExecutionSlots(loop), () => DateTimeOffset.UtcNow, Guid.NewGuid);
            foreach (var task in ((List<object?>)Corpus["tasks"]!).Cast<Dictionary<string, object?>>())
                store.SaveTask((Dictionary<string, object?>)PersistedJson.Parse(JsJson.Stringify(task)!.Replace("{scratch}", fixture.Scratch.Replace("\\", "\\\\", StringComparison.Ordinal), StringComparison.Ordinal))!);
            foreach (var approval in ((List<object?>)Corpus["stored"]!).Cast<Dictionary<string, object?>>())
                store.Execute("INSERT INTO intents VALUES ($p0,'tool.approval',$p1,$p2)", approval["id"], JsJson.Stringify(approval), approval["state"]);
            string Rows() => JsJson.Stringify(store.Rows("SELECT rowid,* FROM intents")) + JsJson.Stringify(store.Rows("SELECT * FROM events"));
            var before = Rows();
            foreach (var item in ((List<object?>)Corpus["decisions"]!).Cast<Dictionary<string, object?>>())
            {
                object? value = null; string? error = null;
                try { value = tools.Decide(Id((int)(double)item["task"]!), Id((int)(double)item["approval"]!), (string)item["nonce"]!, (string)item["decision"]!); }
                catch (WorkspaceReadException exception) { error = exception.Message; }
                Assert.True(JsJson.Stringify(item.GetValueOrDefault("value")) == JsJson.Stringify(value) && Equals(item.GetValueOrDefault("error"), error), $"{JsJson.Stringify(item)}: actual {JsJson.Stringify(value)} {error}");
            }
            Assert.Equal(before, Rows());
            await Task.CompletedTask;
            return 0;
        });
    }

    /// <summary>The oracle's one-pass cleaning, in its order: paths, then fingerprints, UUIDs and timestamps, then pinning.</summary>
    private sealed partial class Cleaner(string scratch, string shell, string systemRoot)
    {
        private readonly Dictionary<string, string> uuids = new(StringComparer.Ordinal);
        private readonly List<(string Raw, string Name)> fingerprints = [];

        internal void Remember(IEnumerable<Dictionary<string, object?>> rows)
        {
            foreach (var row in rows)
            {
                var data = (Dictionary<string, object?>)PersistedJson.Parse((string)row["data"]!)!;
                if (data.GetValueOrDefault("fingerprint") is string { Length: > 0 } fingerprint && fingerprints.All(entry => entry.Raw != fingerprint))
                    fingerprints.Add((fingerprint, $"{{fingerprint:{fingerprints.Count + 1}}}"));
            }
        }

        internal object? Clean(object? value) => value switch
        {
            string text => Pin(Text(text)),
            IDictionary<string, object?> map => map.ToDictionary(pair => pair.Key, pair => Clean(pair.Value)),
            System.Collections.IEnumerable items => items.Cast<object?>().Select(Clean).ToList(),
            _ => value,
        };

        private string Text(string value)
        {
            var text = value;
            foreach (var (raw, name) in new[] { (scratch, "scratch"), (shell, "shell"), (systemRoot, "SystemRoot") })
                text = text.Replace(raw.Replace("\\", "\\\\", StringComparison.Ordinal), $"{{{name}-json}}", StringComparison.Ordinal).Replace(raw, $"{{{name}}}", StringComparison.Ordinal);
            foreach (var (raw, name) in fingerprints) text = text.Replace(raw, name, StringComparison.Ordinal);
            text = Uuid().Replace(text, match =>
            {
                if (!uuids.TryGetValue(match.Value, out var placeholder)) uuids[match.Value] = placeholder = $"{{uuid:{uuids.Count + 1}}}";
                return placeholder;
            });
            return Timestamp().Replace(text, "{time}");
        }

        [GeneratedRegex(@"\b(?!14141414-)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", RegexOptions.CultureInvariant)]
        private static partial Regex Uuid();

        [GeneratedRegex(@"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", RegexOptions.CultureInvariant)]
        private static partial Regex Timestamp();
    }

    private static string Id(int number) => $"14141414-0000-4000-8000-{number.ToString("D12", CultureInfo.InvariantCulture)}";

    /// <summary>The oracle's expand: { $repeat: [text, count] } becomes text repeated.</summary>
    private static object? Expand(object? value) => value switch
    {
        Dictionary<string, object?> map when map.GetValueOrDefault("$repeat") is List<object?> repeat => string.Concat(Enumerable.Repeat((string)repeat[0]!, (int)(double)repeat[1]!)),
        Dictionary<string, object?> map => map.ToDictionary(pair => pair.Key, pair => Expand(pair.Value), StringComparer.Ordinal),
        List<object?> items => items.Select(Expand).ToList(),
        _ => value,
    };

    /// <summary>The oracle's pin: a string over 4,096 units becomes its length and SHA-256.</summary>
    private static object? Pin(object? value) => value switch
    {
        string text => text.Length > 4096 ? new Dictionary<string, object?> { ["length"] = text.Length, ["sha256"] = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text))) } : text,
        IDictionary<string, object?> map => map.ToDictionary(pair => pair.Key, pair => Pin(pair.Value)),
        System.Collections.IList items => items.Cast<object?>().Select(Pin).ToList(),
        _ => value,
    };
}
