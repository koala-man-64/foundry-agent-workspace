namespace Foundry.WebView2.Tests;

/// <summary>Pages the rig serves for the foundry-app scheme. Scripts report what happened over the bridge.</summary>
internal static class Pages
{
    /// <summary>The plan's production policy (section 4, "Response headers").</summary>
    public const string AppPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

    private const string Post = "const post = value => chrome.webview.postMessage(typeof value === 'string' ? value : JSON.stringify(value));\n";

    public static Dictionary<string, Page> All() => new(StringComparer.Ordinal)
    {
        [Rig.AppUri] = Html("app.js", AppPolicy),
        ["foundry-app://ui/app.js"] = Script(Post + """
            document.addEventListener('securitypolicyviolation', event => post({ kind: 'csp-violation', directive: event.effectiveDirective }));
            post({ kind: 'hello' });
            post('x'.repeat(1024 * 1024 + 1));
            post('{"kind":"hello",');
            chrome.webview.postMessage({ kind: 'object' });
            try { eval('1'); post({ kind: 'eval', allowed: true }); } catch { post({ kind: 'eval', allowed: false }); }
            const inline = document.createElement('script');
            inline.textContent = "chrome.webview.postMessage(JSON.stringify({ kind: 'inline-ran' }))";
            document.head.append(inline);
            fetch('https://example.invalid/').then(() => post({ kind: 'fetch', allowed: true }), () => post({ kind: 'fetch', allowed: false }));
            post({ kind: 'popup', opened: window.open('foundry-app://ui/popup.html') !== null });
            """),
        ["foundry-app://ui/popup.html"] = Html("app.js", AppPolicy),

        // The frame test relaxes frame-src only so that a frame exists at all: the host must still never hear it.
        ["foundry-app://ui/frames.html"] = Html("frames.js", AppPolicy.Replace("frame-src 'none'", "frame-src foundry-app://evil", StringComparison.Ordinal), "<iframe src=\"foundry-app://evil/frame.html\"></iframe>"),
        ["foundry-app://ui/frames.js"] = Script(Post + "post({ kind: 'frames-ready' });"),
        ["foundry-app://evil/frame.html"] = Html("frame.js", "default-src 'none'; script-src 'self'"),
        ["foundry-app://evil/frame.js"] = Script("const send = () => window.chrome?.webview?.postMessage(JSON.stringify({ kind: 'from-frame' }));\nsend();\nsetInterval(send, 50);"),

        ["foundry-app://ui/redirect.html"] = Html("redirect.js", AppPolicy),
        ["foundry-app://ui/redirect.js"] = Script(Post + "post({ kind: 'leaving' });\nlocation.href = 'foundry-app://evil/landing.html';"),
        ["foundry-app://evil/landing.html"] = Html("landing.js", AppPolicy),
        ["foundry-app://evil/landing.js"] = Script(Post + "post({ kind: 'hello' });"),
    };

    private static Page Html(string script, string policy, string body = "") =>
        new($"<!doctype html><meta charset=\"utf-8\"><title>rig</title><script src=\"/{script}\"></script>{body}", "text/html; charset=utf-8", policy);

    private static Page Script(string body) => new(body, "text/javascript; charset=utf-8");
}
