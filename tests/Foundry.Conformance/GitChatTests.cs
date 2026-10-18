using System.Runtime.CompilerServices;
using System.Text.Json;
using Foundry.Platform;
using Foundry.Protocol;
using Foundry.Providers;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

/// <summary>
/// Git-project chats against the committed Node steps (tests/p2/git-chat.test.ts): task.start, task.send and task.cancel
/// with the agent loop's tool iterations and the project channel, through DevelopmentChat with the same identities, clock,
/// offline provider and scripts. Every step's value or refusal, the rows it changed in every table, its notifications and
/// each request a provider received must match. A step that names an approved native difference must be refused with
/// that error and change nothing.
/// </summary>
public sealed class GitChatTests
{
    private const string VectorPath = "tests/p2/git-chat-vectors.json";
    private static readonly JsonElement Raw = RepositoryFixture.ReadCorpus(VectorPath);
    private static readonly Dictionary<string, object?> Corpus = (Dictionary<string, object?>)PersistedJson.Parse(File.ReadAllText(Path.Combine(RepositoryFixture.Root, VectorPath)))!;
    private static readonly (string Table, string Sql, string Key)[] Tables =
    [
        ("tasks", "SELECT rowid AS _rowid,* FROM tasks ORDER BY rowid", "id"),
        ("messages", "SELECT rowid AS _rowid,* FROM messages ORDER BY ordinal", "id"),
        ("requests", "SELECT rowid AS _rowid,* FROM provider_requests ORDER BY rowid", "request_id"),
        ("starts", "SELECT * FROM task_starts ORDER BY rowid", "request_id"),
        ("events", "SELECT * FROM events ORDER BY sequence", "sequence"),
        ("intents", "SELECT rowid AS _rowid,* FROM intents ORDER BY rowid", "id"),
        ("projects", "SELECT rowid AS _rowid,* FROM projects ORDER BY rowid", "id"),
    ];

    public static IEnumerable<object[]> Cases() => Raw.GetProperty("cases").EnumerateArray().Select((item, index) => new object[] { item.GetProperty("name").GetString()!, index });

    [Fact]
    public void OracleSourceBindingsAreCurrent()
    {
        Assert.Equal(1, Raw.GetProperty("schemaVersion").GetInt32());
        RepositoryFixture.AssertOracleSources(Raw);
    }

    [Theory, MemberData(nameof(Cases))]
    public async Task GitChatsMatchNode(string name, int index)
    {
        var item = (Dictionary<string, object?>)((List<object?>)Corpus["cases"]!)[index]!;
        Assert.Equal(name, item["name"]);
        var scripted = (bool)item["scripted"]!; var budgets = item["budgets"] as Dictionary<string, object?>;
        var scripts = (Dictionary<string, object?>)Corpus["scripts"]!; var secret = (string)Corpus["secret"]!;
        var timestamp = DateTimeOffset.Parse((string)Corpus["timestamp"]!, System.Globalization.CultureInfo.InvariantCulture);
        using var fixture = RepositoryFixture.Create("foundry-p2-git-chat-");
        fixture.Write("work/repo/README.md", "hello\n"); fixture.Write("work/repo/src/a.ts", "export const a = 1;\n"); fixture.Write("work/repo/docs/b.md", "# b\n");
        await fixture.Git("-C", "work/repo", "init", "-q"); await fixture.Git("-C", "work/repo", "add", "-A"); await fixture.Git("-C", "work/repo", "commit", "-qm", "fixture");
        var data = Directory.CreateDirectory(fixture.Local("data")).FullName;
        await using var loop = new RuntimeLoop(); Store? store = null; DevelopmentChat? chat = null;
        var notifications = new List<object?>(); var provider = new List<object?>(); var next = 1;
        Guid NewId() => Guid.Parse($"78787878-0000-4000-8000-{next++:000000000000}");
        var fake = new FakeChatProvider(id: NewId);

        async IAsyncEnumerable<ProviderChatEvent> Script(ProviderRequest request, [EnumeratorCancellation] CancellationToken token)
        {
            // The oracle's scripted provider pauses for a macrotask first, as the offline provider pauses.
            await Task.Delay(1, token); loop.AssertCurrent();
            if (token.IsCancellationRequested) throw new OperationCanceledException("This operation was aborted", token);
            var last = request.Messages.LastOrDefault(message => message.Role == "user")?.Content ?? "";
            var state = request.Continuation?.Data as Dictionary<string, object?>;
            var (script, step) = last.StartsWith("script:", StringComparison.Ordinal)
                ? (last["script:".Length..].Split(' ')[0], 0)
                : (state?.GetValueOrDefault("script") as string, (int)((state?.GetValueOrDefault("step") as double? ?? -1) + 1));
            var events = script is not null && scripts.GetValueOrDefault(script) is List<object?> responses && step < responses.Count ? (List<object?>)responses[step]! : null;
            if (events is null) throw new InvalidOperationException($"Unscripted request: {script ?? "none"} {step}.");
            foreach (var entry in events.Cast<Dictionary<string, object?>>())
            {
                switch ((string)entry["type"]!)
                {
                    case "insert-unknown":
                        foreach (var row in store!.Rows("SELECT id FROM tasks WHERE json_extract(data,'$.status')='running' ORDER BY rowid"))
                            store.Execute("INSERT INTO intents VALUES($p0,'tool.approval',$p1,'unknown')", $"scripted-unknown-{row["id"]}", JsJson.Stringify(new Dictionary<string, object?> { ["taskId"] = row["id"] }));
                        break;
                    case "text":
                        yield return new ProviderText(entry.GetValueOrDefault("repeat") is List<object?> repeat
                            ? string.Concat(Enumerable.Repeat((string)repeat[0]!, (int)(double)repeat[1]!)) : (string)entry["text"]!);
                        break;
                    case "tool_call":
                        var call = (Dictionary<string, object?>)entry["call"]!;
                        yield return new ProviderToolCall((string)call["id"]!, (string)call["name"]!, call.GetValueOrDefault("arguments"));
                        break;
                    default:
                        if (Equals(entry.GetValueOrDefault("omit"), true)) { yield return new ProviderDone(null); break; }
                        var continuation = new Dictionary<string, object?> { ["stage"] = "complete", ["calls"] = new List<object?>(), ["script"] = script, ["step"] = (double)step };
                        if (Equals(entry.GetValueOrDefault("secret"), true)) continuation["note"] = secret;
                        if (entry.GetValueOrDefault("pad") is double pad) continuation["pad"] = new string('x', (int)pad);
                        yield return new ProviderDone(new(entry.GetValueOrDefault("apiKind") as string ?? "fake", continuation));
                        break;
                }
            }
        }

        IAsyncEnumerable<ProviderChatEvent> Stream(ProviderRequest request, CancellationToken token)
        {
            var view = new Dictionary<string, object?>
            {
                ["messages"] = request.Messages.Select(message => (object?)new Dictionary<string, object?> { ["role"] = message.Role, ["content"] = message.Content }).ToList(),
            };
            if (request.Tools is not null) view["tools"] = request.Tools.Cast<object?>().ToList();
            if (request.Continuation is not null) view["continuation"] = request.Continuation.ToWire();
            if (request.ToolResults is not null)
                view["toolResults"] = request.ToolResults.Select(result => (object?)new Dictionary<string, object?> { ["id"] = result.Id, ["name"] = result.Name, ["content"] = result.Content, ["isError"] = result.IsError }).ToList();
            provider.Add(view);
            return scripted ? Script(request, token) : fake.StreamTurn(request, token);
        }

        await loop.Invoke(() =>
        {
            store = new Store(loop, data, Path.Combine(fixture.Scratch, "injected-root"), () => timestamp, NewId, item =>
            {
                if (!DevelopmentChat.SendsNotification(item)) return;
                notifications.Add(item.Sequence == 0 ? new Dictionary<string, object?> { ["sequence"] = 0, ["type"] = item.Type, ["data"] = item.Data, ["taskId"] = item.TaskId, ["createdAt"] = item.CreatedAt } : item.ToWire());
            });
            chat = new DevelopmentChat(loop, store, Stream, () => timestamp, NewId, fixture.Environment);
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
        // The project key TypeScript's formula gives the fixture's common directory; the oracle replaces it the same way.
        var key = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(EcmaScriptCase.ToLower(Path.Join(fixture.Scratch, "work", "repo", ".git")))));
        Dictionary<string, List<Dictionary<string, object?>>> Rows() => Tables.ToDictionary(table => table.Table, table => store!.Rows(table.Sql));
        try
        {
            var before = await loop.Invoke(() => Task.FromResult(Rows())); var seen = 0; var requested = 0;
            foreach (var (step, position) in ((List<object?>)item["steps"]!).Cast<Dictionary<string, object?>>().Select((step, position) => (step, position)))
            {
                var method = (string)step["method"]!; var parameters = (Dictionary<string, object?>)Expand(step["params"])!;
                // A budget of 0 is the first request's reservation and -1 the first two requests', as the oracle measured them.
                if (parameters.GetValueOrDefault("tokenBudget") is double sentinel && sentinel is 0 or -1)
                    parameters["tokenBudget"] = budgets?.GetValueOrDefault(sentinel == 0 ? "0" : "-1") ?? 10_000_000d;
                if (method == "wait")
                    while (await loop.Invoke(() => Task.FromResult(Equals(store!.ReadTask((string)parameters["taskId"]!)["status"], "running")))) await Task.Delay(1, TestContext.Current.CancellationToken);
                var actual = await loop.Invoke(async () =>
                {
                    object? value = null; string? error = null;
                    try
                    {
                        switch (method)
                        {
                            case "wait": break;
                            case "seed-intent":
                                store!.Execute("INSERT INTO intents VALUES($p0,$p1,$p2,$p3)", parameters["id"], parameters["kind"], JsJson.Stringify(parameters["data"]), parameters["state"]);
                                break;
                            case "seed-seen":
                                var profile = store!.Profile(Store.FakeProfileId)!;
                                store.SaveProviderState((string)parameters["taskId"]!, new()
                                {
                                    ["fingerprint"] = Compatibility.ProfileFingerprint(profile),
                                    ["continuation"] = new Dictionary<string, object?> { ["apiKind"] = "fake", ["data"] = new Dictionary<string, object?> { ["stage"] = "complete", ["calls"] = new List<object?>() } },
                                    ["pending"] = new List<object?>(), ["results"] = new List<object?>(),
                                    ["seenToolCallIds"] = Enumerable.Range(0, (int)(double)parameters["count"]!).Select(number => (object?)$"seen-{number}").ToList(),
                                });
                                break;
                            default:
                                value = await chat!.Dispatch(method, (Dictionary<string, object?>)Contracts.Validate("rpc " + method, parameters)!);
                                break;
                        }
                        if (method == "project.add" && value is Dictionary<string, object?> project && Equals(project["kind"], "git")) expanded["{project}"] = (string)project["id"]!;
                        if (method == "task.start" && step.GetValueOrDefault("as") is string label && value is Dictionary<string, object?> task) expanded[$"{{task:{label}}}"] = (string)task["id"]!;
                    }
                    catch (Exception exception) when (exception is InvalidOperationException or NotSupportedException) { error = exception.Message; }
                    var after = Rows();
                    var record = fixture.Normalize(new Dictionary<string, object?>
                    {
                        ["value"] = value, ["error"] = error, ["delta"] = Delta(before, after),
                        ["notifications"] = notifications.Skip(seen).ToList(), ["provider"] = provider.Skip(requested).ToList(),
                    });
                    before = after; seen = notifications.Count; requested = provider.Count;
                    return record;
                });
                if (step.GetValueOrDefault("native") is Dictionary<string, object?> native)
                {
                    var unchanged = new Dictionary<string, object?> { ["value"] = null, ["error"] = native["error"], ["delta"] = new Dictionary<string, object?>(), ["notifications"] = new List<object?>(), ["provider"] = new List<object?>() };
                    Assert.Equal(JsJson.Stringify(unchanged), JsJson.Stringify(actual));
                }
                else
                {
                    var expected = JsJson.Stringify(step["expected"]); var observed = JsJson.Stringify(actual)!.Replace(key, "{project-key}", StringComparison.Ordinal);
                    Assert.True(expected == observed, $"step {position} ({method}):\nexpected {expected}\nactual   {observed}");
                }
            }
        }
        finally { await loop.Invoke(async () => { try { await chat!.Shutdown(); } finally { store!.Dispose(); } return 0; }); }
    }

    /// <summary>The oracle's delta: the rows each table added or changed since the previous step, and the keys it removed.</summary>
    private static Dictionary<string, object?> Delta(Dictionary<string, List<Dictionary<string, object?>>> before, Dictionary<string, List<Dictionary<string, object?>>> after)
    {
        var output = new Dictionary<string, object?>();
        foreach (var (table, _, key) in Tables)
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
