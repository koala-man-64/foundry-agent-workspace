using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace Foundry.Conformance;

/// <summary>
/// The P2.4 oracles' recording fetch, as a handler: each request's URL, the headers the adapter sets and its body are
/// recorded, scrubbed of the credential, and the request is answered with the next queued answer. A held answer waits for
/// its release; a hanging body counts a park once every chunk has been read. In an answer's chunks, "{token}" stands for
/// the token the request carries, and <paramref name="expand"/> rewrites the rest.
/// </summary>
internal sealed partial class RecordingProvider(Func<string, string> scrub, Func<string, string>? expand = null) : HttpMessageHandler
{
    private static readonly string[] Names = ["accept", "content-type", "api-key", "anthropic-version"];
    private readonly List<Dictionary<string, object?>> answers = [];
    private TaskCompletionSource gate = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private TaskCompletionSource held = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int parks;
    internal List<object?> Requests { get; } = [];
    internal Task Held => held.Task;
    internal int Parks => Volatile.Read(ref parks);

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
        string Chunk(string text) => (expand ?? (value => value))(token is null ? text : text.Replace("{token}", token, StringComparison.Ordinal));
        var listed = answer.GetValueOrDefault("body") as List<object?>;
        var response = new HttpResponseMessage((HttpStatusCode)(answer.GetValueOrDefault("status") is double status ? (int)status : 200));
        response.Content = listed is null && answer.ContainsKey("body") ? new ByteArrayContent([])
            : new StreamContent(new ProviderTransportTests.ChunkStream(ProviderTransportTests.Chunks([.. (listed ?? []).Select(chunk => chunk is string text ? Chunk(text) : chunk)]),
                (string?)answer.GetValueOrDefault("end") ?? "close", () => Interlocked.Increment(ref parks)));
        return response;
    }

    [GeneratedRegex("\\\\\"token\\\\\":\\\\\"([0-9a-f-]{36})\\\\\"")]
    private static partial Regex Token();
}
