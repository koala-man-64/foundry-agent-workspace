using System.Globalization;
using System.IO;
using System.Text.Json;

namespace Foundry.Spikes.BrowserSurface;

/// <summary>
/// A run's evidence under the repository's git-ignored <c>test-results/spikes</c>: a console log, one JSON line per
/// record and a Markdown summary rewritten as the run goes, so an interrupted run keeps what it measured.
/// </summary>
internal sealed class Results
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private readonly string records;
    private readonly string logFile;

    private Results(string directory)
    {
        Directory = directory;
        records = Path.Combine(directory, "records.jsonl");
        logFile = Path.Combine(directory, "log.txt");
    }

    public string Directory { get; }

    public static Results Create(string spike)
    {
        var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture);
        var directory = Path.Combine(RepositoryRoot(), "test-results", "spikes", spike, stamp);
        System.IO.Directory.CreateDirectory(directory);
        return new Results(directory);
    }

    public void Log(string line)
    {
        var stamped = $"{DateTime.Now.ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture)} {line}";
        Console.WriteLine(stamped);
        File.AppendAllText(logFile, stamped + Environment.NewLine);
    }

    public void Record(object record) => File.AppendAllText(records, JsonSerializer.Serialize(record, record.GetType(), Json) + Environment.NewLine);

    public void Write(string name, string text) => File.WriteAllText(Path.Combine(Directory, name), text);

    /// <summary>A short description of where the run happened, for the summary's header.</summary>
    public static string Describe() =>
        $"Windows {Environment.OSVersion.Version}, WebView2 runtime {Microsoft.Web.WebView2.Core.CoreWebView2Environment.GetAvailableBrowserVersionString()}, " +
        $"SDK {typeof(Microsoft.Web.WebView2.Core.CoreWebView2).Assembly.GetName().Version}";

    private static string RepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "Foundry.slnx")))
            {
                return directory.FullName;
            }
        }
        return System.IO.Directory.GetCurrentDirectory();
    }
}

/// <summary>The spike's embedded pages.</summary>
internal static class Pages
{
    public static string Load(string name)
    {
        var text = Read(name);
        return text.Replace("/*BROWSER-PANEL*/", Read("browser-panel.js"), StringComparison.Ordinal)
            .Replace("/*RECORDER*/", Read("recorder.js"), StringComparison.Ordinal);
    }

    private static string Read(string name)
    {
        using var stream = typeof(Pages).Assembly.GetManifestResourceStream(name) ?? throw new InvalidOperationException($"Missing page {name}.");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }
}
