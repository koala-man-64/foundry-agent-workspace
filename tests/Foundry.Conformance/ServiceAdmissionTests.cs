using Foundry.Protocol;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

public sealed class ServiceAdmissionTests
{
    private static readonly string[] DeferredModes = ["chat", "coding", "coordinated"];
    [Theory]
    [InlineData("project.update"), InlineData("workspace.preferences.save")]
    public async Task EventFailureRollsBackMutation(string method)
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-admission-rollback-").FullName;
        try
        {
            await using var loop = new RuntimeLoop();
            Store? owned = null;
            await loop.Invoke(async () =>
            {
                var notifications = new List<WorkspaceEvent>();
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), publish: notifications.Add); owned = store;
                var projectId = "17171717-0000-4000-8000-000000000001";
                store.Execute("INSERT INTO projects(id,path_key,data) VALUES($p0,'stable',$p1)", projectId, JsJson.Stringify(new { id = projectId, hidden = false, opaque = new { retained = true } }));
                var before = JsJson.Stringify(new { project = store.Project(projectId), preferences = store.Preferences(), events = store.Rows("SELECT * FROM events") });
                store.Execute("CREATE TEMP TRIGGER fail_admission_event BEFORE INSERT ON events WHEN NEW.type IN ('projects.changed','preferences.changed') BEGIN SELECT RAISE(ABORT,'Injected event failure'); END");
                var service = new DevelopmentChat(loop, store);
                await Assert.ThrowsAsync<Microsoft.Data.Sqlite.SqliteException>(() => service.Dispatch(method, method == "project.update" ? new() { ["projectId"] = projectId, ["hidden"] = true } : new() { ["mode"] = "coding" }));
                Assert.Equal(before, JsJson.Stringify(new { project = store.Project(projectId), preferences = store.Preferences(), events = store.Rows("SELECT * FROM events") }));
                Assert.Empty(notifications);
                store.Execute("DROP TRIGGER fail_admission_event");
                await service.Shutdown(); return 0;
            });
            Assert.Throws<InvalidOperationException>(() => owned!.UpdateProject(new()));
            Assert.Throws<InvalidOperationException>(() => owned!.UpdatePreferences(new()));
        }
        finally { Directory.Delete(scratch, true); }
    }
    [Fact]
    public async Task DeferredOperationsCannotReserveOrCreateState()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-admission-denial-").FullName;
        try
        {
            await using var loop = new RuntimeLoop();
            await loop.Invoke(async () =>
            {
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"));
                store.WorkspacePathKeyProbe = _ => throw new InvalidOperationException("Unexpected path probe.");
                var service = new DevelopmentChat(loop, store);
                string Snapshot() => JsJson.Stringify(new { tasks = store.Rows("SELECT * FROM tasks"), starts = store.Rows("SELECT * FROM task_starts"), intents = store.Rows("SELECT * FROM intents"), projects = store.Rows("SELECT * FROM projects"), events = store.Rows("SELECT * FROM events") })!;
                var before = Snapshot();
                // project.add is served now; a missing folder is refused before any path-key probe or write.
                Assert.Equal("Project folder is unavailable.", (await Assert.ThrowsAsync<WorkspaceReadException>(() => service.Dispatch("project.add", new() { ["path"] = Path.Combine(scratch, "missing-project") }))).Message);
                await Assert.ThrowsAsync<NotSupportedException>(() => service.Dispatch("task.create", new() { ["projectPath"] = "C:\\never-probe" }));
                await Assert.ThrowsAsync<NotSupportedException>(() => service.Dispatch("workspace.upgrade", new()));
                foreach (var mode in DeferredModes)
                    await Assert.ThrowsAsync<NotSupportedException>(() => service.Dispatch("task.start", new()
                    {
                        ["requestId"] = Guid.NewGuid().ToString(), ["projectId"] = Guid.NewGuid().ToString(),
                        ["content"] = "test", ["profileId"] = Store.FakeProfileId, ["mode"] = mode, ["tokenBudget"] = 100000
                    }));
                Assert.Equal(before, Snapshot());
                await service.Shutdown(); return 0;
            });
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task FailedNotificationDoesNotRollBackOrAllowRepeatMutation()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-admission-delivery-").FullName;
        try
        {
            await using var loop = new RuntimeLoop();
            await loop.Invoke(async () =>
            {
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), publish: _ => throw new InvalidOperationException("Injected delivery failure."));
                var service = new DevelopmentChat(loop, store);
                await Assert.ThrowsAsync<EventDeliveryException>(() => service.Dispatch("workspace.preferences.save", new() { ["mode"] = "coding" }));
                Assert.Equal("coding", store.Preferences()["mode"]);
                Assert.Equal(1L, store.Scalar("SELECT COUNT(*) FROM events WHERE type='preferences.changed'"));
                await Assert.ThrowsAsync<InvalidOperationException>(() => service.Dispatch("workspace.preferences.save", new() { ["mode"] = "chat" }));
                Assert.Equal("coding", store.Preferences()["mode"]);
                Assert.Equal(1L, store.Scalar("SELECT COUNT(*) FROM events WHERE type='preferences.changed'"));
                await Assert.ThrowsAsync<InvalidOperationException>(() => service.Shutdown()); return 0;
            });
        }
        finally { Directory.Delete(scratch, true); }
    }

    private static string Root
    {
        get
        {
            for (var root = new DirectoryInfo(AppContext.BaseDirectory); root is not null; root = root.Parent)
                if (File.Exists(Path.Combine(root.FullName, "Foundry.slnx"))) return root.FullName;
            throw new InvalidOperationException("Missing admission corpus.");
        }
    }

    [Theory]
    [InlineData("fresh"), InlineData("v1"), InlineData("v2"), InlineData("v3"), InlineData("v4"), InlineData("v5"), InlineData("v5-wal")]
    public async Task ServiceMutationAndAdmissionMatchNode(string era)
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p2-admission-").FullName;
        try
        {
            if (era != "fresh")
            {
                foreach (var file in Directory.GetFiles(Path.Combine(Root, "tests/fixtures/databases", era), "workspace.db*")) File.Copy(file, Path.Combine(scratch, Path.GetFileName(file)));
                File.WriteAllText(Path.Combine(scratch, Store.IsolationMarker), Store.IsolationDeclaration);
            }
            var corpus = (Dictionary<string, object?>)PersistedJson.Parse(File.ReadAllText(Path.Combine(Root, "tests/p2/service-admission-vectors.json")))!;
            var scenario = ((List<object?>)corpus["cases"]!).Cast<Dictionary<string, object?>>().Single(item => Equals(item["era"], era));
            await using var loop = new RuntimeLoop();
            await loop.Invoke(async () =>
            {
                var notifications = new List<object?>();
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"), () => DateTimeOffset.Parse((string)corpus["stamp"]!, System.Globalization.CultureInfo.InvariantCulture), publish: item => notifications.Add(item.ToWire()));
                var project = (Dictionary<string, object?>)corpus["project"]!;
                if (store.SchemaVersion >= 3)
                {
                    store.Execute("INSERT INTO projects(id,path_key,data) VALUES($p0,'preserve-this-path-key',$p1)", project["id"], JsJson.Stringify(project));
                    store.SavePreferences((Dictionary<string, object?>)corpus["preferences"]!);
                }
                var firstSequence = store.Scalar("SELECT COALESCE(MAX(sequence),0) FROM events");
                Assert.Equal(JsJson.Stringify(scenario["firstSequence"]), JsJson.Stringify(firstSequence));
                notifications.Clear();
                var service = new DevelopmentChat(loop, store);
                foreach (var step in ((List<object?>)scenario["steps"]!).Cast<Dictionary<string, object?>>())
                {
                    object? value = null; string? error = null;
                    try { value = await service.Dispatch((string)step["method"]!, (Dictionary<string, object?>)step["params"]!); }
                    catch (InvalidOperationException exception) { error = exception.Message; }
                    Assert.Equal(step["error"], error);
                    Assert.Equal(JsJson.Stringify(step["value"]), JsJson.Stringify(value));
                    Assert.Equal(JsJson.Stringify(step["project"]), JsJson.Stringify(store.SchemaVersion < 3 ? null : store.Rows("SELECT rowid,* FROM projects WHERE id=$p0", project["id"]).Single()));
                    Assert.Equal(JsJson.Stringify(step["preferences"]), JsJson.Stringify(store.Preferences()));
                    Assert.Equal(JsJson.Stringify(step["events"]), JsJson.Stringify(store.Rows("SELECT * FROM events WHERE sequence>$p0 ORDER BY sequence", firstSequence)));
                    Assert.Equal(JsJson.Stringify(step["notifications"]), JsJson.Stringify(notifications));
                }
                await service.Shutdown();
                return 0;
            });
        }
        finally { Directory.Delete(scratch, true); }
    }
}
