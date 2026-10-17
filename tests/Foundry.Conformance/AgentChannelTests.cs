using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
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
            var chat = new DevelopmentChat(loop, store, (messages, continuation, token) => new FakeChatProvider().StreamTurn(messages, continuation, token), null, null, fixture.Environment);
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
                if (binding == "incomplete") identity.Remove("path");
                store.FinishIntent(store.Intent("channel.identity", new Dictionary<string, object?> { ["taskId"] = task["id"], ["identity"] = identity }), "complete");
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
            var chat = new DevelopmentChat(loop, store, (messages, continuation, token) => new FakeChatProvider().StreamTurn(messages, continuation, token), null, null, fixture.Environment);
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

    /// <summary>The oracle's cleaning: scratch paths, then project keys in order of first appearance, then timestamps.</summary>
    private sealed partial class Cleaner(string scratch)
    {
        private readonly Dictionary<string, string> projects = new(StringComparer.Ordinal);

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
            text = ProjectKey().Replace(text, match =>
            {
                if (!projects.TryGetValue(match.Value, out var placeholder)) projects[match.Value] = placeholder = $"{{project:{projects.Count + 1}}}";
                return placeholder;
            });
            return Timestamp().Replace(text, "{time}");
        }

        [GeneratedRegex(@"\b[0-9a-f]{64}\b", RegexOptions.CultureInvariant)]
        private static partial Regex ProjectKey();

        [GeneratedRegex(@"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", RegexOptions.CultureInvariant)]
        private static partial Regex Timestamp();
    }

    private static string Id(double number) => $"15151515-0000-4000-8000-{((long)number).ToString("D12", CultureInfo.InvariantCulture)}";

    private static string RequestId(double number) => $"16161616-0000-4000-8000-{((long)number).ToString("D12", CultureInfo.InvariantCulture)}";
}
