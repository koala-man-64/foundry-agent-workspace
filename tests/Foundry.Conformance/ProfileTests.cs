using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Foundry.Protocol;
using Foundry.Providers;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

/// <summary>
/// profile.save, the runtime.credential frame and profile.probe against the committed Node steps (tests/p2/profiles.test.ts),
/// through DevelopmentChat with the same identities, clock and provider answers. Every step's value or refusal, the rows it
/// changed in profiles, provider_requests and events, its notifications and every request the provider received must
/// match. The one named difference is the last step of its own case: a cancellation stream that continues after the abort.
/// TypeScript leaves that request's stream open, so its usage record stays pending; native closes it, recording the
/// request cancelled with its own usage.changed event.
/// </summary>
public sealed partial class ProfileTests
{
    private const string Corpus = "tests/p2/profile-vectors.json";
    private static readonly JsonElement Raw = RepositoryFixture.ReadCorpus(Corpus);
    private static readonly (string Table, string Sql, string Key)[] Tables =
    [
        ("profiles", "SELECT rowid AS _rowid,* FROM profiles ORDER BY rowid", "id"),
        ("requests", "SELECT rowid AS _rowid,* FROM provider_requests ORDER BY rowid", "request_id"),
        ("events", "SELECT * FROM events ORDER BY sequence", "sequence"),
    ];

    public static IEnumerable<object[]> Cases() => Raw.GetProperty("cases").EnumerateArray().Select((item, index) => new object[] { item.GetProperty("name").GetString()!, index });

    [Fact]
    public void VectorsAreBoundToTheirSources() => RepositoryFixture.AssertOracleSources(Raw);

    [Theory, MemberData(nameof(Cases))]
    public async Task ProfilesCredentialsAndProbesMatchNode(string name, int index)
    {
        Assert.NotEmpty(name);
        var corpus = (Dictionary<string, object?>)PersistedJson.Parse(Raw.GetRawText())!;
        var item = (Dictionary<string, object?>)((List<object?>)corpus["cases"]!)[index]!;
        var timestamp = DateTimeOffset.Parse((string)corpus["timestamp"]!, System.Globalization.CultureInfo.InvariantCulture);
        var data = Directory.CreateTempSubdirectory("foundry-p2-profiles-").FullName;
        var era = (string)item["era"]!;
        if (era != "fresh")
        {
            foreach (var file in Directory.GetFiles(Path.Combine(RepositoryFixture.Root, "tests", "fixtures", "databases", era), "workspace.db*")) File.Copy(file, Path.Combine(data, Path.GetFileName(file)));
            File.WriteAllText(Path.Combine(data, Store.IsolationMarker), Store.IsolationDeclaration);
        }
        var credential = "fixture-" + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(12));
        var second = credential + "-second";
        string Scrub(string text) => text.Replace(second, "{credential:2}", StringComparison.Ordinal).Replace(credential, "{credential}", StringComparison.Ordinal);
        var next = 1;
        Guid NewId() => Guid.Parse($"56565656-0000-4000-8000-{next++:000000000000}");
        var handler = new Provider(Scrub);
        await using var loop = new RuntimeLoop(); Store? store = null; DevelopmentChat? chat = null;
        var notifications = new List<object?>();
        await loop.Invoke(() =>
        {
            store = new Store(loop, data, Path.Combine(data, "injected-root"), () => timestamp, NewId, entry =>
            {
                if (DevelopmentChat.SendsNotification(entry)) notifications.Add(entry.ToWire());
            });
            // A short deadline keeps the oracle's 20-second timeout case quick; held requests are released well within it.
            chat = new DevelopmentChat(loop, store, null, () => timestamp, NewId, transport: new AzureTransport(handler), probeDeadline: TimeSpan.FromSeconds(5));
            return Task.FromResult(0);
        });
        Dictionary<string, List<Dictionary<string, object?>>> Rows() => Tables.ToDictionary(table => table.Table, table => store!.SchemaVersion >= 4 || table.Table != "requests" ? store!.Rows(table.Sql) : []);
        Task<Dictionary<string, object?>?> Dispatch(string method, Dictionary<string, object?> parameters) => loop.Invoke(async () =>
        {
            // Program validates every request against its contract first, which orders and trims it as zod does.
            try { return new Dictionary<string, object?> { ["result"] = await chat!.Dispatch(method, (Dictionary<string, object?>)Contracts.Validate("rpc " + method, parameters)!) }; }
            catch (Exception error) when (error is InvalidOperationException or WorkspaceReadException or NotSupportedException) { return new Dictionary<string, object?> { ["error"] = error.Message }; }
        })!;
        Task<Dictionary<string, object?>?>? pending = null;
        try
        {
            var before = await loop.Invoke(() => Task.FromResult(Rows())); var seen = 0; var sent = 0;
            var steps = ((List<object?>)item["steps"]!).Cast<Dictionary<string, object?>>().ToList();
            foreach (var (step, position) in steps.Select((step, position) => (step, position)))
            {
                var method = (string)step["method"]!;
                var parameters = step.GetValueOrDefault("params") as Dictionary<string, object?> ?? [];
                var answers = (step.GetValueOrDefault("answers") as List<object?>)?.Cast<Dictionary<string, object?>>().ToList() ?? [];
                object? value = null; string? error = null;
                Dictionary<string, object?>? outcome = null;
                if (method == "credential")
                {
                    var profileId = (string)parameters["id"]!;
                    var secret = parameters["value"] switch { "{credential}" => credential, "{credential:2}" => second, var other => (string)other! };
                    outcome = await loop.Invoke(() =>
                    {
                        var stored = store!.Profile(profileId);
                        var binding = parameters.GetValueOrDefault("binding") as string
                            ?? (stored is null ? "[]" : JsJson.Stringify(new List<object?> { stored["apiKind"], stored["endpoint"], stored["deployment"] })!);
                        try { chat!.SetCredential(profileId, secret, binding); return Task.FromResult<Dictionary<string, object?>?>(new() { ["result"] = null }); }
                        catch (Exception caught) when (caught is InvalidOperationException or WorkspaceReadException) { return Task.FromResult<Dictionary<string, object?>?>(new() { ["error"] = caught.Message }); }
                    });
                }
                else if (method == "clear-mcp")
                    await loop.Invoke(() => Task.FromResult(store!.Execute("DELETE FROM mcp_servers")));
                else if (method == "probe-start")
                {
                    handler.Queue(answers);
                    pending = Dispatch("profile.probe", parameters);
                    await handler.Held.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);
                    value = new Dictionary<string, object?> { ["started"] = true };
                }
                else if (method == "release")
                {
                    handler.Release();
                    outcome = await pending!; pending = null;
                }
                else
                {
                    if (method == "profile.probe") handler.Queue(answers, first: true);
                    outcome = await Dispatch(method, parameters);
                    if (method == "profile.probe" && pending is null) handler.Clear();
                }
                if (outcome is not null) { value = outcome.GetValueOrDefault("result"); error = outcome.GetValueOrDefault("error") as string; }
                var after = await loop.Invoke(() => Task.FromResult(Rows()));
                var actual = (Dictionary<string, object?>)PersistedJson.Parse(Scrub(JsJson.Stringify(new Dictionary<string, object?>
                {
                    ["value"] = value, ["error"] = error, ["delta"] = Delta(before, after), ["notifications"] = notifications.Skip(seen).ToList(), ["provider"] = handler.Requests.Skip(sent).ToList(),
                })!))!;
                before = after; seen = notifications.Count; sent = handler.Requests.Count;
                var expected = (Dictionary<string, object?>)step["expected"]!;
                if (position == steps.Count - 1 && (expected["value"] as Dictionary<string, object?>)?.GetValueOrDefault("detail") is "Probe cancellation stream continued after abort.")
                    expected = ClosedCancellation(expected, actual);
                Assert.True(JsJson.Stringify(expected) == JsJson.Stringify(actual), $"Step {position} ({method}) differs.\nexpected {JsJson.Stringify(expected)}\nactual   {JsJson.Stringify(actual)}");
            }
        }
        finally
        {
            handler.Release();
            if (pending is not null) await pending;
            await loop.Invoke(async () => { await chat!.Shutdown(); store!.Dispose(); return 0; });
        }
    }

    /// <summary>
    /// The named difference: TypeScript's record of the continued cancellation leaves its usage request pending, with no
    /// usage.changed for it. Native records it cancelled, unmeasured, when the probe closes the stream, and publishes its
    /// usage.changed first. The expectation becomes that, and must then match native exactly.
    /// </summary>
    private static Dictionary<string, object?> ClosedCancellation(Dictionary<string, object?> expected, Dictionary<string, object?> actual)
    {
        var copy = (Dictionary<string, object?>)PersistedJson.Parse(JsJson.Stringify(expected)!)!;
        var requests = (List<object?>)((Dictionary<string, object?>)((Dictionary<string, object?>)copy["delta"]!)["requests"]!)["changed"]!;
        var row = requests.Cast<Dictionary<string, object?>>().Single(candidate => Equals(candidate["outcome"], "pending"));
        row["outcome"] = "cancelled"; row["finished_at"] = row["attempted_at"]; row["reason"] = "Profile check ended without final usage.";
        // Native's own events and notifications are taken as they are, after checking that they add exactly that one
        // usage.changed to TypeScript's, in that order.
        var events = (List<object?>)((Dictionary<string, object?>)((Dictionary<string, object?>)actual["delta"]!)["events"]!)["changed"]!;
        var expectedEvents = (List<object?>)((Dictionary<string, object?>)((Dictionary<string, object?>)copy["delta"]!)["events"]!)["changed"]!;
        Assert.Equal(expectedEvents.Cast<Dictionary<string, object?>>().Select(entry => entry["type"]).Prepend("usage.changed").Order(), events.Cast<Dictionary<string, object?>>().Select(entry => entry["type"]).Order());
        Assert.Contains(events.Cast<Dictionary<string, object?>>(), entry => Equals(entry["type"], "usage.changed") && ((string)entry["data"]!).Contains((string)row["request_id"]!, StringComparison.Ordinal));
        ((Dictionary<string, object?>)((Dictionary<string, object?>)copy["delta"]!)["events"]!)["changed"] = events;
        var notified = (List<object?>)actual["notifications"]!;
        Assert.Equal(((List<object?>)copy["notifications"]!).Count + 1, notified.Count);
        copy["notifications"] = notified;
        return copy;
    }

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

    [GeneratedRegex("\\\\\"token\\\\\":\\\\\"([0-9a-f-]{36})\\\\\"")]
    private static partial Regex Token();

    /// <summary>The oracle's recording fetch: one queued answer per request, a held answer waits for its release, and
    /// "{token}" stands for the token the request carries.</summary>
    private sealed class Provider(Func<string, string> scrub) : HttpMessageHandler
    {
        private static readonly string[] Names = ["accept", "content-type", "api-key", "anthropic-version"];
        private readonly List<Dictionary<string, object?>> answers = [];
        private TaskCompletionSource gate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private TaskCompletionSource held = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal List<object?> Requests { get; } = [];
        internal Task Held => held.Task;

        internal void Queue(List<Dictionary<string, object?>> items, bool first = false) { lock (answers) answers.InsertRange(first ? 0 : answers.Count, items); }
        internal void Clear() { lock (answers) answers.Clear(); }
        internal void Release() { gate.TrySetResult(); gate = new(TaskCreationOptions.RunContinuationsAsynchronously); held = new(TaskCreationOptions.RunContinuationsAsynchronously); }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = Encoding.UTF8.GetString(await request.Content!.ReadAsByteArrayAsync(cancellationToken));
            var headers = new Dictionary<string, object?>();
            foreach (var name in Names)
            {
                var source = name == "content-type" ? (System.Net.Http.Headers.HttpHeaders)request.Content.Headers : request.Headers;
                if (source.NonValidated.TryGetValues(name, out var values)) headers[name] = scrub(string.Join(", ", values));
            }
            lock (Requests) Requests.Add(new Dictionary<string, object?> { ["url"] = request.RequestUri!.AbsoluteUri, ["headers"] = headers, ["body"] = scrub(body) });
            Dictionary<string, object?> answer;
            lock (answers)
            {
                if (answers.Count == 0) throw new HttpRequestException("Unscripted provider request.");
                answer = answers[0]; answers.RemoveAt(0);
            }
            if (Equals(answer.GetValueOrDefault("hold"), true)) { var wait = gate.Task; held.TrySetResult(); await wait.WaitAsync(cancellationToken); }
            var token = Token().Match(body) is { Success: true } match ? match.Groups[1].Value : null;
            var listed = answer.GetValueOrDefault("body") as List<object?>;
            var response = new HttpResponseMessage((HttpStatusCode)(answer.GetValueOrDefault("status") is double status ? (int)status : 200));
            response.Content = listed is null && answer.ContainsKey("body") ? new ByteArrayContent([])
                : new StreamContent(new ProviderTransportTests.ChunkStream(ProviderTransportTests.Chunks([.. (listed ?? []).Select(chunk => chunk is string text && token is not null ? text.Replace("{token}", token, StringComparison.Ordinal) : chunk)]), (string?)answer.GetValueOrDefault("end") ?? "close"));
            return response;
        }
    }
}
