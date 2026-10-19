using System.Security.Cryptography;
using System.Text.Json;
using Foundry.Platform;
using Foundry.Protocol;
using Foundry.Providers;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

/// <summary>
/// External-profile chats (P2.4d) against the committed Node steps (tests/p2/external-chat.test.ts), through
/// DevelopmentChat with the same identities, clock and provider answers, over a recording handler. Every step's value or
/// refusal, the rows it changed in every table, its notifications and every request the provider received must match. A
/// start, send or cancel settles first, as the oracle settles it: its task stops running, or (start and send) the provider
/// parks a response once it has read every chunk. The sends after a tool turn build their request from the provider state
/// the store saved, for each kind (P2.4b review N5).
/// </summary>
public sealed class ExternalChatTests
{
    private const string VectorPath = "tests/p2/external-chat-vectors.json";
    private static readonly JsonElement Raw = RepositoryFixture.ReadCorpus(VectorPath);
    private static readonly Dictionary<string, object?> Corpus = (Dictionary<string, object?>)PersistedJson.Parse(File.ReadAllText(Path.Combine(RepositoryFixture.Root, VectorPath)))!;
    private static readonly (string Table, string Sql, string Key, string Name)[] Tables =
    [
        ("tasks", "SELECT rowid AS _rowid,* FROM tasks ORDER BY rowid", "id", "tasks"),
        ("messages", "SELECT rowid AS _rowid,* FROM messages ORDER BY ordinal", "id", "messages"),
        ("requests", "SELECT rowid AS _rowid,* FROM provider_requests ORDER BY rowid", "request_id", "provider_requests"),
        ("usage", "SELECT rowid AS _rowid,* FROM usage_records ORDER BY rowid", "id", "usage_records"),
        ("starts", "SELECT * FROM task_starts ORDER BY rowid", "request_id", "task_starts"),
        ("events", "SELECT * FROM events ORDER BY sequence", "sequence", "events"),
        ("intents", "SELECT rowid AS _rowid,* FROM intents ORDER BY rowid", "id", "intents"),
        ("projects", "SELECT rowid AS _rowid,* FROM projects ORDER BY rowid", "id", "projects"),
        ("profiles", "SELECT rowid AS _rowid,* FROM profiles ORDER BY rowid", "id", "profiles"),
    ];

    public static IEnumerable<object[]> Cases() => Raw.GetProperty("cases").EnumerateArray().Select((item, index) => new object[] { item.GetProperty("name").GetString()!, index });

    [Fact]
    public void VectorsAreBoundToTheirSources() => RepositoryFixture.AssertOracleSources(Raw);

    [Theory, MemberData(nameof(Cases))]
    public async Task ExternalChatsMatchNode(string name, int index)
    {
        var item = (Dictionary<string, object?>)((List<object?>)Corpus["cases"]!)[index]!;
        Assert.Equal(name, item["name"]);
        var timestamp = (string)Corpus["timestamp"]!; var head = (int)(double)Corpus["head"]!;
        var clock = DateTimeOffset.Parse(timestamp, System.Globalization.CultureInfo.InvariantCulture);
        using var fixture = RepositoryFixture.Create("foundry-p2-external-chat-");
        fixture.Write("work/repo/README.md", "hello\n"); fixture.Write("work/repo/src/a.ts", "export const a = 1;\n"); fixture.Write("work/repo/docs/b.md", "# b\n");
        await fixture.Git("-C", "work/repo", "init", "-q"); await fixture.Git("-C", "work/repo", "add", "-A"); await fixture.Git("-C", "work/repo", "commit", "-qm", "fixture");
        Directory.CreateDirectory(fixture.Local("work/folder"));
        var data = Directory.CreateDirectory(fixture.Local("data")).FullName;
        var era = (string)item["era"]!;
        if (era != "fresh")
        {
            foreach (var file in Directory.GetFiles(Path.Combine(RepositoryFixture.Root, "tests", "fixtures", "databases", era), "workspace.db*")) File.Copy(file, Path.Combine(data, Path.GetFileName(file)));
            File.WriteAllText(Path.Combine(data, Store.IsolationMarker), Store.IsolationDeclaration);
        }
        // Built at run time, in the oracle's shape, so no fixture holds a credential.
        var credential = "fixture-" + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(12));
        string Scrub(string text) => text.Replace(credential, "{credential}", StringComparison.Ordinal);
        string Secret(string text) => text.Replace("{credential:head}", credential[..head], StringComparison.Ordinal)
            .Replace("{credential:tail}", credential[head..], StringComparison.Ordinal).Replace("{credential}", credential, StringComparison.Ordinal);
        var handler = new RecordingProvider(Scrub, Secret);
        var next = 1;
        Guid NewId() => Guid.Parse($"89898989-0000-4000-8000-{next++:000000000000}");
        var environment = fixture.Environment();
        await using var loop = new RuntimeLoop(); Store? store = null; DevelopmentChat? chat = null;
        var notifications = new List<object?>();
        await loop.Invoke(() =>
        {
            store = new Store(loop, data, Path.Combine(fixture.Scratch, "injected-root"), () => clock, NewId, entry =>
            {
                if (!DevelopmentChat.SendsNotification(entry)) return;
                notifications.Add(entry.Sequence == 0 ? new Dictionary<string, object?> { ["sequence"] = 0, ["type"] = entry.Type, ["data"] = entry.Data, ["taskId"] = entry.TaskId, ["createdAt"] = entry.CreatedAt } : entry.ToWire());
            });
            chat = new DevelopmentChat(loop, store, null, () => clock, NewId, () => environment, new AzureTransport(handler), TimeSpan.FromSeconds(5));
            return Task.FromResult(0);
        });
        var expanded = new Dictionary<string, string>(StringComparer.Ordinal);
        object? Expand(object? value) => value switch
        {
            string text => expanded.Aggregate(text.Replace("{scratch}", fixture.Scratch, StringComparison.Ordinal), (current, pair) => current.Replace(pair.Key, pair.Value, StringComparison.Ordinal)),
            Dictionary<string, object?> map => map.ToDictionary(pair => pair.Key, pair => Expand(pair.Value)),
            List<object?> items => items.Select(Expand).ToList(),
            _ => value,
        };
        var key = Convert.ToHexStringLower(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(EcmaScriptCase.ToLower(Path.Join(fixture.Scratch, "work", "repo", ".git")))));
        Dictionary<string, List<Dictionary<string, object?>>> Rows() => Tables.ToDictionary(table => table.Table,
            table => store!.Rows("SELECT name FROM sqlite_master WHERE type='table' AND name=$p0", table.Name).Count > 0 ? store.Rows(table.Sql) : []);
        try
        {
            var before = await loop.Invoke(() => Task.FromResult(Rows())); var seen = 0; var sent = 0;
            foreach (var (step, position) in ((List<object?>)item["steps"]!).Cast<Dictionary<string, object?>>().Select((step, position) => (step, position)))
            {
                var method = (string)step["method"]!;
                var parameters = (Dictionary<string, object?>)Expand(step.GetValueOrDefault("params") ?? new Dictionary<string, object?>())!;
                var answers = (step.GetValueOrDefault("answers") as List<object?>)?.Cast<Dictionary<string, object?>>().ToList();
                object? value = null; string? error = null;
                var parked = handler.Parks;
                await loop.Invoke(async () =>
                {
                    try
                    {
                        switch (method)
                        {
                            case "credential":
                                var stored = store!.Profile((string)parameters["id"]!)!;
                                chat!.SetCredential((string)stored["id"]!, credential, JsJson.Stringify(new List<object?> { stored["apiKind"], stored["endpoint"], stored["deployment"] })!);
                                break;
                            case "seed-verified":
                                var profile = store!.Profile((string)parameters["profileId"]!)!;
                                store.SaveProfile(new(profile)
                                {
                                    ["verifiedAt"] = timestamp, ["verificationFingerprint"] = Equals(parameters.GetValueOrDefault("stale"), true) ? "stale-fingerprint" : Compatibility.ProfileFingerprint(profile),
                                    ["capabilities"] = new Dictionary<string, object?> { ["streaming"] = true, ["tools"] = parameters["tools"], ["continuation"] = parameters["continuation"], ["cancellation"] = true, ["usage"] = true },
                                });
                                break;
                            case "clear-mcp": store!.Execute("DELETE FROM mcp_servers"); break;
                            default:
                                if (answers is not null) { handler.Clear(); handler.Queue(answers); }
                                value = await chat!.Dispatch(method, (Dictionary<string, object?>)Contracts.Validate("rpc " + method, parameters)!);
                                if (method == "profile.probe") handler.Clear();
                                if (method == "project.add") expanded["{project}"] = (string)((Dictionary<string, object?>)value!)["id"]!;
                                if (method == "task.start") expanded[$"{{task:{step["as"]}}}"] = (string)((Dictionary<string, object?>)value!)["id"]!;
                                break;
                        }
                    }
                    catch (Exception exception) when (exception is InvalidOperationException or NotSupportedException) { error = exception.Message; }
                    return 0;
                });
                if (error is null && method is "task.start" or "task.send" or "task.cancel")
                {
                    var taskId = (string)(method == "task.start" ? ((Dictionary<string, object?>)value!)["id"] : parameters["taskId"])!;
                    for (var n = 0; await loop.Invoke(() => Task.FromResult(Equals(store!.ReadTask(taskId)["status"], "running"))) && (method == "task.cancel" || handler.Parks == parked); n++)
                    {
                        Assert.True(n < 6000, "The step did not settle.");
                        await Task.Delay(5, TestContext.Current.CancellationToken);
                    }
                }
                if (method is "task.start" or "task.send") handler.Clear();
                var after = await loop.Invoke(() => Task.FromResult(Rows()));
                var record = fixture.Normalize(new Dictionary<string, object?>
                {
                    ["value"] = value, ["error"] = error, ["delta"] = Delta(before, after), ["notifications"] = notifications.Skip(seen).ToList(), ["provider"] = handler.Requests.Skip(sent).ToList(),
                });
                before = after; seen = notifications.Count; sent = handler.Requests.Count;
                var expected = JsJson.Stringify(step["expected"]);
                var observed = JsJson.Stringify(PersistedJson.Parse(Scrub(JsJson.Stringify(record)!).Replace(key, "{project-key}", StringComparison.Ordinal)));
                Assert.True(expected == observed, $"step {position} ({method}):\nexpected {expected}\nactual   {observed}");
            }
        }
        finally { await loop.Invoke(async () => { try { await chat!.Shutdown(); } finally { store!.Dispose(); } return 0; }); }
    }

    /// <summary>The oracle's delta: the rows each table added or changed since the previous step, and the keys it removed.</summary>
    private static Dictionary<string, object?> Delta(Dictionary<string, List<Dictionary<string, object?>>> before, Dictionary<string, List<Dictionary<string, object?>>> after)
    {
        var output = new Dictionary<string, object?>();
        foreach (var (table, _, key, _) in Tables)
        {
            var prior = before[table].ToDictionary(row => JsJson.Stringify(row[key])!, row => JsJson.Stringify(row), StringComparer.Ordinal);
            var current = after[table].Select(row => JsJson.Stringify(row[key])!).ToHashSet(StringComparer.Ordinal);
            var changed = after[table].Where(row => prior.GetValueOrDefault(JsJson.Stringify(row[key])!) != JsJson.Stringify(row)).Cast<object?>().ToList();
            var removed = before[table].Where(row => !current.Contains(JsJson.Stringify(row[key])!)).Select(row => row[key]).ToList();
            if (changed.Count > 0 || removed.Count > 0) output[table] = new Dictionary<string, object?> { ["changed"] = changed, ["removed"] = removed };
        }
        return output;
    }
}
