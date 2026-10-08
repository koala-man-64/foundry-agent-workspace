using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace Foundry.WebView2.Tests;

/// <summary>
/// The fixture site of <c>tests/e2e/browser.spec.ts</c>, served by <see cref="WebServer"/>, plus a page that uploads
/// from a document and from dedicated, shared and service workers.
/// </summary>
internal static class BrowserSite
{
    // Copied from browser.spec.ts, so the spike runs against the page the Electron scenarios use.
    public const string Fixture = """
        <!doctype html><html><head><title>Browser fixture</title></head><body>
        <h1>Browser fixture</h1><button onclick="document.querySelector('#result').textContent='Approved click ran'">Browser demo action</button>
        <p id="result">No action yet</p><input aria-label="Public text"><input type="password" value="private-password-canary"><input type="hidden" value="hidden-canary">
        <a href="/next">Next page</a><button onclick="window.open('/popup')">Open login popup</button><form action="/upload" method="post" enctype="multipart/form-data"><input type="file" name="fixture" aria-label="Upload"><button>Upload file</button></form>
        <script>
        const seed=location.pathname==='/seed';
        if(seed) localStorage.setItem('fixture-value','persisted');
        window.storageReady=new Promise((resolve,reject)=>{const r=indexedDB.open('fixture-db',1);r.onupgradeneeded=()=>r.result.createObjectStore('values');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;const tx=db.transaction('values',seed?'readwrite':'readonly');const store=tx.objectStore('values');if(seed)store.put('indexed-persisted','key');const get=store.get('key');get.onsuccess=()=>{window.storedValue=get.result??null;};tx.oncomplete=()=>{db.close();resolve();};};});
        </script></body></html>
        """;

    /// <summary>What the scenarios read back: the cookie, local storage and IndexedDB values.</summary>
    public const string StoredValues = "window.storageReady.then(() => ({ cookie: document.cookie, stored: localStorage.getItem('fixture-value'), indexed: window.storedValue }))";

    private const string Send = "const send = async kind => { const data = new FormData(); data.append('fixture', new Blob([`worker upload fixture ${kind}`]), 'fixture.txt'); try { return (await fetch(`/upload?from=${kind}`, { method: 'POST', body: data })).status; } catch { return 'error'; } };\n";

    /// <summary>
    /// Uploads from the document, dedicated, shared and service workers, and request bodies of each kind the attached-tab
    /// rule distinguishes. Each entry is a status, a beacon's queued flag, or "timeout", "error" or "unavailable".
    /// </summary>
    private const string Workers = """
        <!doctype html><html><head><title>Workers fixture</title></head><body><p>Workers fixture</p>
        <script>
        const within = promise => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve('timeout'), 5000))]);
        const post = (from, body, type) => fetch(`/upload?from=${from}`, { method: 'POST', body, headers: type ? { 'Content-Type': type } : {} }).then(response => response.status, () => 'error');
        const form = () => { const data = new FormData(); data.append('fixture', new Blob(['document upload fixture']), 'fixture.txt'); return data; };
        const sendFromDedicated = () => new Promise(resolve => { const worker = new Worker('/dedicated.js'); worker.onmessage = event => { worker.terminate(); resolve(event.data); }; worker.postMessage('go'); });
        const sendFromShared = () => typeof SharedWorker === 'undefined' ? Promise.resolve('unavailable') : new Promise(resolve => { const worker = new SharedWorker('/shared.js'); worker.port.onmessage = event => resolve(event.data); worker.port.start(); worker.port.postMessage('go'); });
        const sendFromService = async () => { const registration = await navigator.serviceWorker.register('/service.js'); await navigator.serviceWorker.ready; return new Promise(resolve => { navigator.serviceWorker.onmessage = event => resolve(event.data); registration.active.postMessage('go'); }); };
        window.runUploads = async () => {
          const results = {
            document: await within(post('document', form())),
            dedicated: await within(sendFromDedicated()),
            shared: await within(sendFromShared()),
            service: await within(sendFromService()),
            file: await within(post('file', new File(['file upload fixture'], 'fixture.pdf', { type: 'application/pdf' }))),
            untyped: await within(post('untyped', new Uint8Array([1, 2, 3]).buffer)),
            blob: await within(post('blob', new Blob(['blob upload fixture'], { type: 'text/plain' }))),
            json: await within(post('json', '{"q":"agent"}', 'application/json')),
            keepalive: await within(fetch('/upload?from=keepalive', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'text/plain' }, body: 'keepalive upload fixture' }).then(response => response.status, () => 'error')),
            redirected: await within(fetch(`/redirect307?to=${encodeURIComponent('/upload?from=redirected')}`, { method: 'POST', body: form() }).then(response => response.status, () => 'error')),
            urlencoded: await within(fetch('/echo', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'q=agent+text' }).then(response => response.status)),
            beacon: navigator.sendBeacon('/upload?from=beacon', new Blob(['beacon upload fixture'])),
          };
          await new Promise(resolve => setTimeout(resolve, 500)); // Let the beacon leave or be refused.
          return results;
        };
        </script></body></html>
        """;

    public static WebResponse Route(WebRequest request) => request.Path.Split('?')[0] switch
    {
        "/seed" => WebResponse.Html(Fixture) with { Headers = new Dictionary<string, string> { ["Set-Cookie"] = "fixture-login=remembered; Max-Age=3600; SameSite=Lax; Path=/" } },
        "/download" => new WebResponse(200, "text/plain", "browser download fixture", new Dictionary<string, string> { ["Content-Disposition"] = "attachment; filename=\"fixture.txt\"" }),
        "/upload" => WebResponse.Html(Encoding.UTF8.GetString(request.Body).Contains("manual upload fixture", StringComparison.Ordinal) ? "<p>Manual upload received</p>" : "<p>Upload content missing</p>"),
        "/auth" => new WebResponse(401, "text/html; charset=utf-8", "<p>Sign-in required</p>", new Dictionary<string, string> { ["WWW-Authenticate"] = "Basic realm=\"fixture\"" }),
        "/echo" => new WebResponse(200, "text/plain", Encoding.UTF8.GetString(request.Body)),
        "/redirect" => new WebResponse(302, "text/plain", "", new Dictionary<string, string> { ["Location"] = Uri.UnescapeDataString(request.Path.Split("?to=", 2)[1]) }),
        "/redirect307" => new WebResponse(307, "text/plain", "", new Dictionary<string, string> { ["Location"] = Uri.UnescapeDataString(request.Path.Split("?to=", 2)[1]) }),
        "/workers.html" => WebResponse.Html(Workers),
        "/dedicated.js" => Script(Send + "onmessage = async () => postMessage(await send('dedicated'));"),
        "/shared.js" => Script(Send + "onconnect = event => { const port = event.ports[0]; port.onmessage = async () => port.postMessage(await send('shared')); port.start(); };"),
        "/service.js" => Script(Send + "self.addEventListener('install', () => self.skipWaiting());\nself.addEventListener('activate', event => event.waitUntil(self.clients.claim()));\nself.addEventListener('message', event => event.waitUntil(send('service').then(status => event.source.postMessage(status))));"),
        _ => WebResponse.Html(Fixture),
    };

    /// <summary>
    /// The integrated browser's <c>SNAPSHOT_SCRIPT</c>, read from <c>browser-manager.ts</c> so the spike runs it verbatim.
    /// It is a template literal without substitutions whose only escapes are doubled backslashes.
    /// </summary>
    public static string SnapshotScript()
    {
        var source = File.ReadAllText(Path.Combine(CdpTests.RepositoryRoot(), "apps", "desktop", "src", "main", "browser-manager.ts"));
        var literal = Regex.Match(source, @"const SNAPSHOT_SCRIPT = `(?<body>[^`]*)`;", RegexOptions.None, TimeSpan.FromSeconds(5)).Groups["body"].Value;
        if (literal.Length == 0 || literal.Contains("${", StringComparison.Ordinal) || Regex.IsMatch(literal.Replace(@"\\", "", StringComparison.Ordinal), @"\\", RegexOptions.None, TimeSpan.FromSeconds(5)))
        {
            throw new InvalidOperationException("SNAPSHOT_SCRIPT is no longer a plain template literal; update the extraction.");
        }
        return literal.Replace(@"\\", @"\", StringComparison.Ordinal);
    }

    private static WebResponse Script(string body) => new(200, "text/javascript; charset=utf-8", body);
}
