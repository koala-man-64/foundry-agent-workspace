using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

public sealed class ProcessTests
{
    [Fact]
    public async Task ReplyIsVisibleBeforeStdinEof()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p1-live-reply-").FullName;
        try
        {
            using var process = Start(scratch);
            var error = process.StandardError.ReadToEndAsync(TestContext.Current.CancellationToken);
            try
            {
                await process.StandardInput.WriteAsync(Request("live"));
                await process.StandardInput.FlushAsync(TestContext.Current.CancellationToken);
                var line = await process.StandardOutput.ReadLineAsync(TestContext.Current.CancellationToken).AsTask().WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
                using var reply = JsonDocument.Parse(line!);
                Assert.Equal("live", reply.RootElement.GetProperty("id").GetString());
                Assert.True(reply.RootElement.TryGetProperty("result", out _));
                Assert.False(process.HasExited);
                process.StandardInput.Close();
                await process.WaitForExitAsync(TestContext.Current.CancellationToken).WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
                Assert.Equal(0, process.ExitCode); Assert.Empty(await error);
            }
            finally { if (!process.HasExited) { process.Kill(true); await process.WaitForExitAsync(TestContext.Current.CancellationToken); } }
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task BrokenStdoutStopsWithoutWaitingForStdinEof()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p1-pipe-fault-").FullName;
        try
        {
            using var process = Start(scratch);
            var error = process.StandardError.ReadToEndAsync(TestContext.Current.CancellationToken);
            process.StandardOutput.Close();
            try
            {
                await process.StandardInput.WriteAsync(Request("pipe-fault"));
                await process.StandardInput.FlushAsync(TestContext.Current.CancellationToken);
                await process.WaitForExitAsync(TestContext.Current.CancellationToken).WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
                Assert.Equal(1, process.ExitCode);
                Assert.Equal("Runtime failed unexpectedly; restart to reconcile retained state.", (await error).Trim());
            }
            finally { if (!process.HasExited) { process.Kill(true); await process.WaitForExitAsync(TestContext.Current.CancellationToken); } }
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task OutputLimitAndStoredProfileErrorRemainBounded()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p1-limits-").FullName;
        try
        {
            await using (var loop = new RuntimeLoop()) await loop.Invoke(() =>
            {
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"));
                store.Execute("INSERT INTO workspace_preferences(id,data) VALUES(1,$p0)", "{\"retained\":\"" + new string('x', 1024 * 1024) + "\"}");
                return Task.FromResult(0);
            });
            var large = await Run(scratch, Request("large"));
            Assert.Equal(0, large.Exit); Assert.Empty(large.Error);
            using (var response = JsonDocument.Parse(large.Output)) Assert.Equal(-32001, response.RootElement.GetProperty("error").GetProperty("code").GetInt32());
            await using (var loop = new RuntimeLoop()) await loop.Invoke(() =>
            {
                using var store = new Store(loop, scratch, Path.Combine(scratch, "injected-root"));
                store.Execute("DELETE FROM workspace_preferences; DELETE FROM profiles;");
                store.Execute("INSERT INTO profiles(id,data) VALUES($p0,$p1)", Store.FakeProfileId, "{\"id\":\"" + Store.FakeProfileId + "\",\"retained\":\"" + new string('x', 100000) + "\"}");
                return Task.FromResult(0);
            });
            var profile = await Run(scratch, Request("profile"));
            Assert.Equal(0, profile.Exit); Assert.Empty(profile.Error);
            using var error = JsonDocument.Parse(profile.Output);
            Assert.Equal("Stored profile is too large to page safely. Repair this profile before using it.", error.RootElement.GetProperty("error").GetProperty("message").GetString());
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task ExactInputLimitCrLfAndOversizedInput()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p1-input-limit-").FullName;
        try
        {
            var request = Request("boundary").TrimEnd('\n');
            var exact = request + new string(' ', 1024 * 1024 - Encoding.UTF8.GetByteCount(request)) + "\n";
            var result = await Run(scratch, exact, 16384);
            Assert.Equal(0, result.Exit); Assert.Empty(result.Error);
            using (var response = JsonDocument.Parse(result.Output)) Assert.Equal("boundary", response.RootElement.GetProperty("id").GetString());
            var oversized = await Run(scratch, exact.TrimEnd('\n') + "\r\n", 16384);
            Assert.Equal(0, oversized.Exit); Assert.Empty(oversized.Output);
            Assert.Equal("Oversized RPC input; runtime stopped.", oversized.Error.Trim());
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task UnmarkedExistingDataNeverProducesReadyOrLeaksItsPath()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p1-refused-secret-fixture-").FullName;
        try
        {
            File.Copy(Path.Combine(Root, "tests/fixtures/databases/v1/workspace.db"), Path.Combine(scratch, "workspace.db"));
            var result = await Run(scratch, "");
            Assert.Equal(1, result.Exit); Assert.Empty(result.Output);
            Assert.Equal("Runtime failed unexpectedly; restart to reconcile retained state.", result.Error.Trim());
        }
        finally { Directory.Delete(scratch, true); }
    }

    private static string Root
    {
        get
        {
            for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
                if (File.Exists(Path.Combine(directory.FullName, "Foundry.slnx"))) return directory.FullName;
            throw new InvalidOperationException("Missing runtime.");
        }
    }
    private static Process Start(string? data)
    {
        var info = new ProcessStartInfo(Path.Combine(Root, "src", "Foundry.Runtime", "bin", "Release", "net10.0-windows", "Foundry.Runtime.exe"))
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
        };
        info.Environment.Remove("FOUNDRY_WORKSPACE_DATA");
        if (data is not null) info.Environment["FOUNDRY_WORKSPACE_DATA"] = data;
        return Process.Start(info) ?? throw new InvalidOperationException("Runtime did not start.");
    }
    private static async Task<(int Exit, string Output, string Error)> Run(string? data, string input, int fragment = 4096)
    {
        using var process = Start(data);
        var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync();
        try
        {
            var bytes = Encoding.UTF8.GetBytes(input);
            for (var index = 0; index < bytes.Length; index += fragment) await process.StandardInput.BaseStream.WriteAsync(bytes.AsMemory(index, Math.Min(fragment, bytes.Length - index)));
            process.StandardInput.Close();
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(50));
            return (process.ExitCode, await output, await error);
        }
        finally { if (!process.HasExited) { process.Kill(true); await process.WaitForExitAsync(); } }
    }
    private static string Request(string id, string method = "workspace.summary", string parameters = "{}") => "{\"jsonrpc\":\"2.0\",\"id\":\"" + id + "\",\"method\":\"" + method + "\",\"params\":" + parameters + "}\n";

    [Theory]
    [InlineData(null), InlineData("v1"), InlineData("v2"), InlineData("v3"), InlineData("v4"), InlineData("v5"), InlineData("v5-wal")]
    public async Task SummaryRunsWithIsolatedDataAndReleasesFiles(string? era)
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p1-process-").FullName;
        try
        {
            if (era is not null)
            {
                foreach (var file in Directory.GetFiles(Path.Combine(Root, "tests", "fixtures", "databases", era), "workspace.db*")) File.Copy(file, Path.Combine(scratch, Path.GetFileName(file)));
                File.WriteAllText(Path.Combine(scratch, Store.IsolationMarker), Store.IsolationDeclaration);
            }
            var result = await Run(scratch, Request("summary"), 1);
            Assert.Equal(0, result.Exit); Assert.Empty(result.Error);
            using var response = JsonDocument.Parse(result.Output);
            Assert.Equal("summary", response.RootElement.GetProperty("id").GetString());
            var summary = response.RootElement.GetProperty("result");
            Assert.Equal("ready", summary.GetProperty("runtime").GetString());
            Assert.True(summary.GetProperty("profiles").GetArrayLength() > 0);
            Assert.True(summary.TryGetProperty("nextProfileAfter", out _));
            Assert.True(summary.TryGetProperty("nextProjectAfter", out _));
            Assert.True(summary.TryGetProperty("preferences", out _));
            Assert.True(summary.TryGetProperty("lastSequence", out _));
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task RepliesRemainCompleteAndPreserveIdsAcrossMultipleRequests()
    {
        var scratch = Directory.CreateTempSubdirectory("foundry-p1-process-").FullName;
        try
        {
            var input = "\n \r\n" + string.Concat(Enumerable.Range(0, 70).Select(index => Request("request-" + index)))
                + Request("unsupported", "profile.probe", "{\"profileId\":\"00000000-0000-4000-8000-000000000001\"}")
                + Request("invalid-params", "workspace.summary", "{\"unexpected\":true}") + "broken\n" + Request("unterminated").TrimEnd('\n');
            var result = await Run(scratch, input, 7);
            Assert.Equal(0, result.Exit); Assert.Empty(result.Error);
            var responses = result.Output.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(line => JsonDocument.Parse(line).RootElement.Clone()).ToArray();
            Assert.Equal(73, responses.Length);
            Assert.Equal(73, responses.Select(item => item.GetProperty("id").GetString()).Distinct().Count());
            Assert.Equal(70, responses.Count(item => item.TryGetProperty("result", out _)));
            Assert.Equal(-32000, responses.Single(item => item.GetProperty("id").GetString() == "unsupported").GetProperty("error").GetProperty("code").GetInt32());
            Assert.Equal("Invalid request.", responses.Single(item => item.GetProperty("id").GetString() == "invalid-params").GetProperty("error").GetProperty("message").GetString());
            Assert.Contains(responses, item => item.GetProperty("id").GetString() == "invalid");
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task MissingConfigurationFailsWithFixedRedactedStderr()
    {
        var result = await Run(null, "");
        Assert.Equal(1, result.Exit); Assert.Empty(result.Output);
        Assert.Equal("Runtime failed unexpectedly; restart to reconcile retained state.", result.Error.Trim());
    }
}
