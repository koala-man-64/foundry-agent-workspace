using Foundry.Protocol;
using Foundry.Providers;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

/// <summary>Project-backed chats, in folders and a Git project, through DevelopmentChat against the committed Node steps
/// (tests/p2/folder-chat.test.ts).</summary>
public sealed class FolderChatTests
{
    [Fact]
    public Task ProjectChatsMatchCommittedNodeSteps() => Replay(removable: false);

    /// <summary>The same committed Node outcomes with the fixture on a removable drive (Rudy, 19 October 2026): TypeScript
    /// reads no drive type for project folders, so nothing may change. The data directory stays fixed.</summary>
    [Fact]
    public Task ProjectChatsOnARemovableDriveMatchTheSameSteps() => Replay(removable: true);

    private static async Task Replay(bool removable)
    {
        var corpus = (Dictionary<string, object?>)PersistedJson.Parse(File.ReadAllText(Path.Combine(RepositoryFixture.Root, "tests/p2/folder-chat-vectors.json")))!;
        RepositoryFixture.AssertOracleSources(RepositoryFixture.ReadCorpus("tests/p2/folder-chat-vectors.json"));
        var timestamp = DateTimeOffset.Parse((string)corpus["timestamp"]!, System.Globalization.CultureInfo.InvariantCulture);
        using var fixture = RepositoryFixture.Create("foundry-p2-folder-chat-");
        // Projects live in their own subtree beside the data folder, which the rename steps move within.
        fixture.Write("work/plain/a.txt", "a\n"); Directory.CreateDirectory(fixture.Local("work/plain/sub"));
        fixture.Write("work/repo/README.md", "hello\n"); fixture.Write("work/repo/src/a.ts", "export const a = 1;\n"); fixture.Write("work/repo/docs/b.md", "# b\n");
        await fixture.Git("-C", "work/repo", "init", "-q"); await fixture.Git("-C", "work/repo", "add", "-A"); await fixture.Git("-C", "work/repo", "commit", "-qm", "fixture");
        var data = Directory.CreateDirectory(fixture.Local("data")).FullName;
        using var drive = RemovableDrive.Place(removable, fixture.Scratch, data);
        await using var loop = new RuntimeLoop(); Store? store = null; DevelopmentChat? chat = null;
        var events = new List<object?>(); var next = 1;
        Guid NewId() => Guid.Parse($"77777777-0000-4000-8000-{next++:000000000000}");
        await loop.Invoke(() =>
        {
            store = new Store(loop, data, Path.Combine(fixture.Scratch, "injected-root"), () => timestamp, NewId, item =>
            {
                if (!DevelopmentChat.SendsNotification(item)) return;
                events.Add(item.Sequence == 0 ? new Dictionary<string, object?> { ["sequence"] = 0, ["type"] = item.Type, ["data"] = item.Data, ["taskId"] = item.TaskId, ["createdAt"] = item.CreatedAt } : item.ToWire());
            });
            chat = new DevelopmentChat(loop, store, null, () => timestamp, NewId, fixture.Environment);
            return Task.FromResult(0);
        });
        var expanded = new Dictionary<string, string>(StringComparer.Ordinal);
        string Expand(string text) => expanded.Aggregate(text.Replace("{scratch}", fixture.Scratch, StringComparison.Ordinal), (value, pair) => value.Replace(pair.Key, pair.Value, StringComparison.Ordinal));
        object? previous = null;
        try
        {
            foreach (var step in ((List<object?>)corpus["steps"]!).Cast<Dictionary<string, object?>>())
            {
                var method = (string)step["method"]!; var input = (Dictionary<string, object?>)step["params"]!;
                var parameters = input.ToDictionary(pair => pair.Key, pair => pair.Value is string text ? Expand(text) : pair.Value);
                if (method == "wait")
                    while (await loop.Invoke(() => Task.FromResult(Equals(store!.ReadTask((string)parameters["taskId"]!)["status"], "running")))) await Task.Delay(1, TestContext.Current.CancellationToken);
                if (method == "rename") Directory.Move(fixture.Local((string)parameters["from"]!), fixture.Local((string)parameters["to"]!));
                var actual = await loop.Invoke(async () =>
                {
                    object? value = null; string? error = null;
                    try
                    {
                        if (method is not ("wait" or "rename")) value = await chat!.Dispatch(method, (Dictionary<string, object?>)Contracts.Validate("rpc " + method, parameters)!);
                        if (method == "project.add" && value is Dictionary<string, object?> project && Equals(project["kind"], "git")) expanded["{git-project}"] = (string)project["id"]!;
                        if (method == "task.start" && value is Dictionary<string, object?> task) expanded["{task}"] = (string)task["id"]!;
                    }
                    catch (Exception exception) when (exception is InvalidOperationException or NotSupportedException) { error = exception.Message; }
                    // As the oracle, every part of the snapshot is normalized (scratch paths, path keys and long strings).
                    var snapshot = (Dictionary<string, object?>)fixture.Normalize(new Dictionary<string, object?>
                    {
                        ["tasks"] = store!.Rows("SELECT rowid AS _rowid,* FROM tasks WHERE id LIKE '77777777-%' ORDER BY rowid"),
                        ["messages"] = store.Rows("SELECT rowid AS _rowid,* FROM messages WHERE id LIKE '77777777-%' ORDER BY ordinal"),
                        ["requests"] = store.Rows("SELECT rowid AS _rowid,* FROM provider_requests WHERE request_id LIKE '77777777-%' ORDER BY rowid"),
                        ["starts"] = store.Rows("SELECT * FROM task_starts WHERE request_id LIKE '77777777-%' ORDER BY rowid"),
                        ["events"] = store.Rows("SELECT * FROM events WHERE task_id LIKE '77777777-%' OR type = 'projects.changed' ORDER BY sequence"),
                        ["projects"] = store.Rows("SELECT rowid AS _rowid,* FROM projects ORDER BY rowid"),
                        ["notifications"] = events.ToList(),
                    })!;
                    return (object?)new Dictionary<string, object?> { ["value"] = fixture.Normalize(value), ["error"] = fixture.Normalize(error) }
                        .Concat(snapshot).ToDictionary(pair => pair.Key, pair => pair.Value);
                });
                if (step.GetValueOrDefault("native") is Dictionary<string, object?> native)
                {
                    // The approved difference refuses before any reservation: the snapshot is the previous step's.
                    var observed = (Dictionary<string, object?>)actual!;
                    Assert.Equal(native["error"], observed["error"]); Assert.Null(observed["value"]);
                    var unchanged = new Dictionary<string, object?>((Dictionary<string, object?>)previous!) { ["value"] = null, ["error"] = native["error"] };
                    Assert.Equal(JsJson.Stringify(unchanged), JsJson.Stringify(actual));
                }
                else Assert.Equal(JsJson.Stringify(step["expected"]), JsJson.Stringify(actual));
                previous = step["expected"];
            }
        }
        finally { await loop.Invoke(async () => { try { await chat!.Shutdown(); } finally { store!.Dispose(); } return 0; }); }
    }
}
