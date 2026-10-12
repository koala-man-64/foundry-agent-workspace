using System.Security.Cryptography;
using System.Text.Json;
using Xunit;

namespace Foundry.Conformance;

public sealed class InventoryTests
{
    [Fact]
    public void CommittedInputsAndCoverageRemainComplete()
    {
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "Foundry.slnx"))) root = root.Parent;
        Assert.NotNull(root);
        using var inventory = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(root.FullName, "tests/Foundry.Conformance/BaselineInventory.json")));
        var files = inventory.RootElement.GetProperty("files").EnumerateArray().ToDictionary(x => x.GetProperty("path").GetString()!, x => x.GetProperty("sha256").GetString()!);
        var actual = Directory.GetFiles(Path.Combine(root.FullName, "tests/golden/data"), "*.json")
            .Concat(Directory.GetFiles(Path.Combine(root.FullName, "tests/fixtures/databases"), "*", SearchOption.AllDirectories))
            .Select(path => Path.GetRelativePath(root.FullName, path).Replace('\\', '/')).Order(StringComparer.Ordinal);
        Assert.Equal(files.Keys.Order(StringComparer.Ordinal), actual);
        foreach (var (path, hash) in files) Assert.Equal(hash, Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(Path.Combine(root.FullName, path)))));
        var contracts = inventory.RootElement.GetProperty("contracts").EnumerateArray().Select(x => x.GetString()!).Order(StringComparer.Ordinal);
        using var corpus = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(root.FullName, "tests/golden/data/rpc-corpus.json")));
        Assert.Equal(contracts, corpus.RootElement.GetProperty("content").EnumerateArray().Select(x => x.GetProperty("schema").GetString()!).Order(StringComparer.Ordinal));
        foreach (var entry in corpus.RootElement.GetProperty("content").EnumerateArray()) Assert.NotEmpty(entry.GetProperty("cases").EnumerateArray());
    }
}
