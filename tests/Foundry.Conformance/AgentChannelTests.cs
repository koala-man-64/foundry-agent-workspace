using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Foundry.Platform;
using Foundry.Protocol;
using Foundry.Providers;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

/// <summary>
/// The native project channel against the committed Node outcomes (tests/p2/agent-channel.test.ts): the channel tool
/// definitions and system text byte for byte, then the same channel.get and channel.send calls through DevelopmentChat,
/// the same channel tool calls through its ToolRuntime, and enrich/acknowledge on the same channel, with every value or
/// refusal and every event row each step adds, cleaned as the oracle cleans them.
/// </summary>
public sealed partial class AgentChannelTests
{
    private const string VectorPath = "tests/p2/agent-channel-vectors.json";
    private static readonly JsonElement Raw = RepositoryFixture.ReadCorpus(VectorPath);
    private static readonly string[] Outcomes = ["value", "error", "systemError", "events"];
    private static readonly string[] UnreadableReceipts = ["{}", "{\"cursor\":\"3\"}", "{\"cursor\":1.5}"];
    private static readonly int[] RetainedReplays = [10, 4400];
    private static readonly double[] BoundTasks = [1, 2];
    private static readonly Dictionary<string, object?> Corpus = (Dictionary<string, object?>)PersistedJson.Parse(File.ReadAllText(Path.Combine(RepositoryFixture.Root, VectorPath)))!;

    public static IEnumerable<object[]> Cases() => Raw.GetProperty("cases").EnumerateArray().Select((item, index) => new object[] { item.GetProperty("name").GetString()!, index });

    [Fact]
    public void OracleSourceBindingsAreCurrent()
    {
        Assert.Equal(1, Raw.GetProperty("schemaVersion").GetInt32());
        RepositoryFixture.AssertOracleSources(Raw);
    }

    [Fact]
    public void DefinitionsAndSystemTextAreByteExact()
    {
        Assert.Equal((string)Corpus["definitions"]!, JsJson.Stringify(ToolDefinitions.Channel));
        Assert.Equal(ToolDefinitions.ChannelSystem, (string)Corpus["system"]!);
    }

    [Theory, MemberData(nameof(Cases))]
    public async Task ChannelMatchesNode(string name, int index)
    {
        var item = (Dictionary<string, object?>)((List<object?>)Corpus["cases"]!)[index]!;
        Assert.Equal(name, item["name"]);
        using var fixture = RepositoryFixture.Create("foundry-p2-channel-");
        await fixture.Build(Raw.GetProperty("tree"));
        var data = Directory.CreateDirectory(fixture.Local("data")).FullName;
        var stamp = (string)Corpus["stamp"]!;
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            using var store = new Store(loop, data, Path.Combine(fixture.Scratch, "injected-root"));
            var chat = new DevelopmentChat(loop, store, (request, token) => new FakeChatProvider().StreamTurn(request, token), null, null, fixture.Environment);
            foreach (var seed in ((List<object?>)item["seeds"]!).Cast<Dictionary<string, object?>>())
            {
                var projectPath = fixture.Local((string)seed["at"]!);
                var task = new Dictionary<string, object?>
                {
                    ["id"] = Id((double)seed["n"]!), ["title"] = seed["title"], ["profileId"] = Store.FakeProfileId, ["status"] = "running", ["createdAt"] = stamp, ["updatedAt"] = stamp,
                    ["tokenBudget"] = 100000d, ["usedTokens"] = 0d, ["mode"] = "coding", ["workspaceKind"] = "git", ["projectPath"] = projectPath, ["worktreePath"] = projectPath,
                    ["branch"] = "fixture", ["baseCommit"] = new string('a', 40),
                };
                foreach (var (key, value) in (Dictionary<string, object?>?)seed.GetValueOrDefault("extra") ?? []) task[key] = value;
                store.SaveTask(task);
                if (seed.GetValueOrDefault("binding") is not string binding) continue;
                // Trusted admission binds the identity it resolved; an incomplete older binding lacks the path.
                using var admission = RepositoryAdmission.Open(loop, projectPath);
                var identity = new Dictionary<string, object?> { ["path"] = admission.Identity!.Path, ["root"] = admission.Identity.Root, ["gitDirectory"] = admission.Identity.GitDirectory, ["common"] = admission.Identity.Common };
                var full = new Dictionary<string, object?>(identity);
                if (binding != "full") identity.Remove("path");
                store.FinishIntent(store.Intent("channel.identity", new Dictionary<string, object?> { ["taskId"] = task["id"], ["identity"] = identity }), "complete");
                if (binding == "incomplete-then-full") store.FinishIntent(store.Intent("channel.identity", new Dictionary<string, object?> { ["taskId"] = task["id"], ["identity"] = full }), "complete");
            }
            var cleaner = new Cleaner(fixture.Scratch);
            long? lastCursor = null;
            var position = 0;
            foreach (var expected in ((List<object?>)item["steps"]!).Cast<Dictionary<string, object?>>())
            {
                var label = $"{name}#{position++}";
                var op = (string)expected["op"]!;
                var taskId = Id((double)expected["task"]!);
                var sequence = (long)store.Scalar("SELECT COALESCE(MAX(sequence),0) FROM events")!;
                // A fresh record in the oracle's key order: the step, then its outcome, then its events.
                var record = expected.Where(pair => !Outcomes.Contains(pair.Key)).ToDictionary(pair => pair.Key, pair => pair.Value);
                try
                {
                    object? value;
                    switch (op)
                    {
                        case "get":
                            var query = new Dictionary<string, object?> { ["taskId"] = taskId };
                            if (expected.GetValueOrDefault("before") is double before) query["before"] = before;
                            if (expected.GetValueOrDefault("afterTask") is double after) query["afterTaskId"] = Id(after);
                            value = await chat.Dispatch("channel.get", query);
                            break;
                        case "send":
                            var message = new Dictionary<string, object?> { ["taskId"] = taskId, ["requestId"] = RequestId((double)expected["request"]!) };
                            if (expected.TryGetValue("recipient", out var recipient)) message["recipientTaskId"] = recipient is double number ? Id(number) : null;
                            message["content"] = expected["content"];
                            value = await chat.Dispatch("channel.send", message);
                            break;
                        case "tool":
                            value = (await chat.Tools.Execute(store.ReadTask(taskId), new ToolCall($"call-{position}", (string)expected["name"]!, expected["arguments"]), CancellationToken.None)).ToWire();
                            break;
                        case "enrich":
                            var request = new Dictionary<string, object?>
                            {
                                ["profile"] = new Dictionary<string, object?> { ["contextLimit"] = expected["contextLimit"] },
                                ["messages"] = new List<object?>
                                {
                                    new Dictionary<string, object?> { ["role"] = "system", ["content"] = "Trusted system instructions" }, new Dictionary<string, object?> { ["role"] = "user", ["content"] = "Continue" },
                                },
                            };
                            var enriched = chat.Tools.Channel.Enrich(store.ReadTask(taskId), request);
                            var cursor = enriched.TryGetValue("channelCursor", out var channelCursor) ? channelCursor : Undefined.Value;
                            lastCursor = cursor is long last ? last : null;
                            value = new Dictionary<string, object?> { ["channelCursor"] = cursor, ["messages"] = enriched["messages"] };
                            break;
                        case "acknowledge":
                            chat.Tools.Channel.Acknowledge(taskId, lastCursor);
                            value = lastCursor;
                            break;
                        case "plant":
                            var project = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(EcmaScriptCase.ToLower(Path.Join(fixture.Scratch, "a", ".git")))));
                            store.Event("channel.message", new Dictionary<string, object?>
                            {
                                ["recipientTaskId"] = null, ["content"] = "Planted password=fixture-secret-value", ["project"] = project, ["callId"] = "planted", ["actor"] = "user",
                                ["senderTitle"] = "Planted api_key=fixture-secret-value",
                            }, taskId);
                            value = null;
                            break;
                        default:
                            for (var count = 0; count < (int)(double)expected["count"]!; count++)
                                store.Event("channel.message", new Dictionary<string, object?>
                                {
                                    ["recipientTaskId"] = null, ["content"] = $"Filler {count}", ["project"] = new string('f', 64), ["callId"] = $"fill-{count}", ["actor"] = "user", ["senderTitle"] = "Filler",
                                }, taskId);
                            value = null;
                            break;
                    }
                    record["value"] = value;
                }
                catch (WorkspaceReadException error) { record["error"] = error.Message; }
                record["events"] = op == "fill" ? new List<object?>() : store.Rows("SELECT * FROM events WHERE sequence>$p0 ORDER BY sequence", sequence);
                var actual = JsJson.Stringify(cleaner.Clean(record));
                Assert.True(JsJson.Stringify(expected) == actual, $"{label}: expected {JsJson.Stringify(expected)}\nactual   {actual}");
            }
            return 0;
        });
    }

    /// <summary>
    /// Native difference (alias refusal): a task whose project path reaches the project through a junction is not resolved,
    /// so it is not listed, and its reads and sends are refused. TypeScript follows the alias to the same identity and
    /// shares the channel with it. The binding is the one TypeScript's admission would have written.
    /// </summary>
    [Fact]
    public async Task AProjectReachedThroughAJunctionIsRefused()
    {
        using var fixture = RepositoryFixture.Create("foundry-p2-channel-alias-");
        Directory.CreateDirectory(fixture.Local("a/.git"));
        await fixture.Junction("alias", "a");
        var data = Directory.CreateDirectory(fixture.Local("data")).FullName;
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            using var store = new Store(loop, data, Path.Combine(fixture.Scratch, "injected-root"));
            var chat = new DevelopmentChat(loop, store, (request, token) => new FakeChatProvider().StreamTurn(request, token), null, null, fixture.Environment);
            Dictionary<string, object?> identity;
            using (var admission = RepositoryAdmission.Open(loop, fixture.Local("a")))
                identity = new() { ["path"] = admission.Identity!.Path, ["root"] = admission.Identity.Root, ["gitDirectory"] = admission.Identity.GitDirectory, ["common"] = admission.Identity.Common };
            foreach (var (number, at) in new[] { (1d, "a"), (2d, "alias") })
            {
                store.SaveTask(new()
                {
                    ["id"] = Id(number), ["title"] = $"Task {number}", ["profileId"] = Store.FakeProfileId, ["status"] = "running", ["createdAt"] = "2026-01-01T00:00:00.000Z",
                    ["updatedAt"] = "2026-01-01T00:00:00.000Z", ["tokenBudget"] = 100000d, ["usedTokens"] = 0d, ["mode"] = "coding", ["workspaceKind"] = "git", ["projectPath"] = fixture.Local(at),
                    ["worktreePath"] = fixture.Local(at), ["branch"] = "fixture", ["baseCommit"] = new string('a', 40),
                });
                store.FinishIntent(store.Intent("channel.identity", new Dictionary<string, object?> { ["taskId"] = Id(number), ["identity"] = identity }), "complete");
            }
            var view = (Dictionary<string, object?>)(await chat.Dispatch("channel.get", new() { ["taskId"] = Id(1) }))!;
            Assert.Equal([Id(1)], ((List<object?>)view["participants"]!).Cast<Dictionary<string, object?>>().Select(item => item["taskId"]));
            await Assert.ThrowsAsync<WorkspaceReadException>(() => chat.Dispatch("channel.get", new() { ["taskId"] = Id(2) }));
            await Assert.ThrowsAsync<WorkspaceReadException>(() => chat.Dispatch("channel.send", new() { ["taskId"] = Id(2), ["requestId"] = RequestId(1), ["content"] = "From the alias" }));
            await Assert.ThrowsAsync<WorkspaceReadException>(() => chat.Dispatch("channel.send", new() { ["taskId"] = Id(1), ["requestId"] = RequestId(2), ["recipientTaskId"] = Id(2), ["content"] = "To the alias" }));
            Assert.Empty(store.Rows("SELECT * FROM events WHERE type LIKE 'channel.%'"));
            return 0;
        });
    }

    /// <summary>
    /// Review L1 of P2.3d: a channel row the index cannot read is passed over, so the channel keeps working for every
    /// project. TypeScript's index fails on malformed JSON and files a message without a project under no project.
    /// </summary>
    [Fact]
    public Task AChannelRowItCannotReadIsPassedOver() => WithChannel(async (fixture, store, chat) =>
    {
        var project = ProjectKey(fixture, "a");
        foreach (var data in new[]
        {
            "not json", "[]", "null", "{\"recipientTaskId\":null,\"content\":\"x\",\"callId\":\"c\",\"actor\":\"user\",\"senderTitle\":\"t\"}",
            "{\"recipientTaskId\":null,\"content\":\"x\",\"project\":\"" + project + "\",\"callId\":\"c\",\"senderTitle\":\"t\"}",
            "{\"recipientTaskId\":5,\"content\":\"x\",\"project\":\"" + project + "\",\"callId\":\"c\",\"actor\":\"user\",\"senderTitle\":\"t\"}",
            "{\"recipientTaskId\":null,\"content\":7,\"project\":\"" + project + "\",\"callId\":\"c\",\"actor\":\"user\",\"senderTitle\":\"t\"}",
            "{\"recipientTaskId\":null,\"content\":\"x\",\"project\":\"" + project + "\",\"callId\":7,\"actor\":\"user\",\"senderTitle\":\"t\"}",
            // A request id nested 100,000 deep would overflow the stack if it were serialized into the index's key.
            "{\"recipientTaskId\":null,\"content\":\"x\",\"project\":\"" + project + "\",\"callId\":" + new string('[', 100_000) + new string(']', 100_000) + ",\"actor\":\"user\",\"senderTitle\":\"t\"}",
        })
            store.Execute("INSERT INTO events(type,task_id,data,created_at,version,source,root_task_id) VALUES('channel.message',$p0,$p1,'2026-01-02T00:00:00.000Z',1,'runtime',$p0)", Id(1), data);
        foreach (var data in UnreadableReceipts)
            store.Execute("INSERT INTO events(type,task_id,data,created_at,version,source,root_task_id) VALUES('channel.received',$p0,$p1,'2026-01-02T00:00:00.000Z',1,'runtime',$p0)", Id(2), data);
        await chat.Dispatch("channel.send", new() { ["taskId"] = Id(1), ["requestId"] = RequestId(1), ["content"] = "Readable" });
        var view = (Dictionary<string, object?>)(await chat.Dispatch("channel.get", new() { ["taskId"] = Id(2) }))!;
        Assert.Equal(["Readable"], ((List<object?>)view["messages"]!).Cast<Dictionary<string, object?>>().Select(message => message["content"]));
    });

    /// <summary>
    /// Review M1 of P2.3d: a message written inside a transaction that rolls back never enters the index, even when the
    /// channel is read inside that transaction, so the channel keeps answering and the request id stays free. TypeScript's
    /// index would keep that sequence. A send refuses to run inside a transaction at all, since the index is not current there.
    /// </summary>
    [Fact]
    public Task AMessageAnEnclosingTransactionRollsBackNeverEntersTheIndex() => WithChannel(async (fixture, store, chat) =>
    {
        var project = ProjectKey(fixture, "a");
        Func<int> enclosing = () =>
        {
            store.Event("channel.message", new Dictionary<string, object?>
            {
                ["recipientTaskId"] = null, ["content"] = "Gone", ["project"] = project, ["callId"] = "rolled-back", ["actor"] = "user", ["senderTitle"] = "Task 1",
            }, Id(1));
            Assert.Empty((List<object?>)chat.Tools.Channel.View(Id(2))["messages"]!);
            Assert.Equal("Channel sends run outside any enclosing transaction.",
                Assert.Throws<InvalidOperationException>(() => chat.Tools.Channel.Send(Id(1), "inside", new Dictionary<string, object?> { ["content"] = "Inside" }, "user")).Message);
            throw new InvalidOperationException("Roll the enclosing transaction back.");
        };
        Assert.Equal("Roll the enclosing transaction back.", Assert.Throws<InvalidOperationException>(() => store.Transaction(enclosing)).Message);
        var view = (Dictionary<string, object?>)(await chat.Dispatch("channel.get", new() { ["taskId"] = Id(2) }))!;
        Assert.Empty((List<object?>)view["messages"]!);
        var kept = chat.Tools.Channel.Send(Id(1), "rolled-back", new Dictionary<string, object?> { ["content"] = "Kept" }, "user");
        Assert.Equal("Kept", kept["content"]);
        Assert.Single(store.Rows("SELECT * FROM events WHERE type='channel.message'"));
    });

    /// <summary>Review L2 of P2.3d: a long history is indexed in batches of 2,000 rows, every row of every batch counted.</summary>
    [Fact]
    public Task ALongHistoryIsIndexedAcrossBatches() => WithChannel(async (fixture, store, chat) =>
    {
        var project = ProjectKey(fixture, "a");
        store.Transaction(() =>
        {
            for (var index = 0; index < 4500; index++)
                store.Event("channel.message", new Dictionary<string, object?>
                {
                    ["recipientTaskId"] = null, ["content"] = $"Retained {index}", ["project"] = project, ["callId"] = $"retained-{index}", ["actor"] = "user", ["senderTitle"] = "Task 1",
                }, Id(1));
            return 0;
        });
        var view = (Dictionary<string, object?>)(await chat.Dispatch("channel.get", new() { ["taskId"] = Id(2) }))!;
        var messages = ((List<object?>)view["messages"]!).Cast<Dictionary<string, object?>>().ToList();
        Assert.Equal(("Retained 4480", "Retained 4499"), ((string)messages[0]["content"]!, (string)messages[^1]["content"]!));
        // A read across the first batch boundary returns each message once, in order.
        var read = (Dictionary<string, object?>)PersistedJson.Parse(JsJson.Stringify(chat.Tools.Channel.Execute(Id(2), new ToolCall("read", "read_agent_messages", new Dictionary<string, object?> { ["after"] = 1990d })))!)!;
        Assert.Equal(Enumerable.Range(1991, 20).Select(sequence => (double)sequence), ((List<object?>)read["messages"]!).Cast<Dictionary<string, object?>>().Select(message => (double)message["sequence"]!));
        // Replays of an early and a late message prove both batches indexed; the count across all of them holds the limit.
        foreach (var index in RetainedReplays)
            Assert.Equal($"Retained {index}", chat.Tools.Channel.Send(Id(1), $"retained-{index}", new Dictionary<string, object?> { ["content"] = $"Retained {index}" }, "user")["content"]);
        Assert.Equal("Task channel-message limit reached.", Assert.Throws<WorkspaceReadException>(() => chat.Tools.Channel.Send(Id(1), "new", new Dictionary<string, object?> { ["content"] = "New" }, "user")).Message);
    });

    /// <summary>
    /// Security I-1 and data L2 of P2.3d: a participants page passes over a task bound to another project without
    /// admitting its folder, since it could only resolve to its binding's project. Tasks bound to this project, and
    /// unbound Git tasks anywhere, are admitted as TypeScript admits every task, so the page is unchanged.
    /// </summary>
    [Fact]
    public Task AParticipantsPageAdmitsOnlyTasksThatCanShareItsProject() => WithChannel(async (fixture, store, chat, loop) =>
    {
        Directory.CreateDirectory(fixture.Local("b/.git"));
        Dictionary<string, object?> other;
        using (var admission = RepositoryAdmission.Open(loop, fixture.Local("b")))
            other = new() { ["path"] = admission.Identity!.Path, ["root"] = admission.Identity.Root, ["gitDirectory"] = admission.Identity.GitDirectory, ["common"] = admission.Identity.Common };
        for (var number = 10; number <= 30; number++)
        {
            store.SaveTask(new()
            {
                ["id"] = Id(number), ["title"] = $"Task {number}", ["profileId"] = Store.FakeProfileId, ["status"] = "running", ["createdAt"] = "2026-01-01T00:00:00.000Z",
                ["updatedAt"] = "2026-01-01T00:00:00.000Z", ["tokenBudget"] = 100000d, ["usedTokens"] = 0d, ["mode"] = "coding", ["workspaceKind"] = "git", ["projectPath"] = fixture.Local("b"),
                ["worktreePath"] = fixture.Local("b"), ["branch"] = "fixture", ["baseCommit"] = new string('a', 40),
            });
            // Task 30 is a legacy task: no binding, so only its folder can say which project it belongs to.
            if (number < 30) store.FinishIntent(store.Intent("channel.identity", new Dictionary<string, object?> { ["taskId"] = Id(number), ["identity"] = other }), "complete");
        }
        var before = chat.Tools.Channel.Admissions;
        var page = chat.Tools.Channel.Participants(Id(1), null);
        Assert.Equal([Id(1), Id(2)], ((List<object?>)page["participants"]!).Cast<Dictionary<string, object?>>().Select(item => item["taskId"]));
        // The caller, its two project tasks and the legacy task; none of the twenty tasks bound to b.
        Assert.Equal(4, chat.Tools.Channel.Admissions - before);
        Assert.Equal(21, ((List<object?>)chat.Tools.Channel.Participants(Id(10), null)["participants"]!).Count);
        await Task.CompletedTask;
    });

    private static string ProjectKey(RepositoryFixture fixture, string name) =>
        Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(EcmaScriptCase.ToLower(Path.Join(fixture.Scratch, name, ".git")))));

    /// <summary>A store and chat over project a, with two running tasks bound to it.</summary>
    private static async Task WithChannel(Func<RepositoryFixture, Store, DevelopmentChat, Task> body) => await WithChannel((fixture, store, chat, _) => body(fixture, store, chat));

    /// <summary>As above, with the loop the store and chat run on.</summary>
    private static async Task WithChannel(Func<RepositoryFixture, Store, DevelopmentChat, RuntimeLoop, Task> body)
    {
        using var fixture = RepositoryFixture.Create("foundry-p2-channel-native-");
        Directory.CreateDirectory(fixture.Local("a/.git"));
        var data = Directory.CreateDirectory(fixture.Local("data")).FullName;
        await using var loop = new RuntimeLoop();
        await loop.Invoke(async () =>
        {
            using var store = new Store(loop, data, Path.Combine(fixture.Scratch, "injected-root"));
            var chat = new DevelopmentChat(loop, store, (request, token) => new FakeChatProvider().StreamTurn(request, token), null, null, fixture.Environment);
            Dictionary<string, object?> identity;
            using (var admission = RepositoryAdmission.Open(loop, fixture.Local("a")))
                identity = new() { ["path"] = admission.Identity!.Path, ["root"] = admission.Identity.Root, ["gitDirectory"] = admission.Identity.GitDirectory, ["common"] = admission.Identity.Common };
            foreach (var number in BoundTasks)
            {
                store.SaveTask(new()
                {
                    ["id"] = Id(number), ["title"] = $"Task {number}", ["profileId"] = Store.FakeProfileId, ["status"] = "running", ["createdAt"] = "2026-01-01T00:00:00.000Z",
                    ["updatedAt"] = "2026-01-01T00:00:00.000Z", ["tokenBudget"] = 100000d, ["usedTokens"] = 0d, ["mode"] = "coding", ["workspaceKind"] = "git", ["projectPath"] = fixture.Local("a"),
                    ["worktreePath"] = fixture.Local("a"), ["branch"] = "fixture", ["baseCommit"] = new string('a', 40),
                });
                store.FinishIntent(store.Intent("channel.identity", new Dictionary<string, object?> { ["taskId"] = Id(number), ["identity"] = identity }), "complete");
            }
            await body(fixture, store, chat, loop);
            return 0;
        });
    }

    /// <summary>The oracle's cleaning: scratch paths, then the project keys TypeScript's formula gives for this run's common
    /// directories, then timestamps. A key computed any other way stays visible and fails the comparison.</summary>
    private sealed partial class Cleaner(string scratch)
    {
        private readonly Dictionary<string, string> projects = new[] { "a", "b" }.ToDictionary(
            name => Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(EcmaScriptCase.ToLower(Path.Join(scratch, name, ".git"))))),
            name => $"{{project:{name}}}", StringComparer.Ordinal);

        internal object? Clean(object? value) => value switch
        {
            string text => Text(text),
            IDictionary<string, object?> map => map.ToDictionary(pair => pair.Key, pair => Clean(pair.Value)),
            System.Collections.IEnumerable items => items.Cast<object?>().Select(Clean).ToList(),
            _ => value,
        };

        private string Text(string value)
        {
            var text = value.Replace(scratch.Replace("\\", "\\\\", StringComparison.Ordinal), "{scratch-json}", StringComparison.Ordinal).Replace(scratch, "{scratch}", StringComparison.Ordinal);
            foreach (var (key, name) in projects) text = text.Replace(key, name, StringComparison.Ordinal);
            return Timestamp().Replace(text, "{time}");
        }

        [GeneratedRegex(@"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", RegexOptions.CultureInvariant)]
        private static partial Regex Timestamp();
    }

    private static string Id(double number) => $"15151515-0000-4000-8000-{((long)number).ToString("D12", CultureInfo.InvariantCulture)}";

    private static string RequestId(double number) => $"16161616-0000-4000-8000-{((long)number).ToString("D12", CultureInfo.InvariantCulture)}";
}
