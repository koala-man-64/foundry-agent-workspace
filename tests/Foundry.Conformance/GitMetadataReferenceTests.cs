using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

public sealed class GitMetadataReferenceTests
{
    private static string Root
    {
        get
        {
            for (var root = new DirectoryInfo(AppContext.BaseDirectory); root is not null; root = root.Parent)
                if (File.Exists(Path.Combine(root.FullName, "Foundry.slnx"))) return root.FullName;
            throw new InvalidOperationException("Missing Git metadata corpus.");
        }
    }

    private static readonly JsonElement Corpus = ReadCorpus();
    private static JsonElement ReadCorpus()
    {
        using var document = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(Root, "tests/p2/git-metadata-vectors.json")));
        return document.RootElement.Clone();
    }

    public static IEnumerable<object[]> Cases()
    {
        var index = 0;
        foreach (var item in Corpus.GetProperty("vectors").EnumerateArray()) yield return [item.GetProperty("name").GetString()!, index++];
    }

    [Theory, MemberData(nameof(Cases))]
    public void SuppliedBytesMatchCommittedNodeLexicalOutcomes(string name, int index)
    {
        var item = Corpus.GetProperty("vectors")[index];
        Assert.Equal(name, item.GetProperty("name").GetString());
        var input = new List<byte>();
        foreach (var part in item.GetProperty("input").EnumerateArray())
        {
            if (part.TryGetProperty("text", out var text)) input.AddRange(Encoding.UTF8.GetBytes(text.GetString()!));
            else
            {
                var bytes = Convert.FromHexString(part.GetProperty("hex").GetString()!);
                var count = part.TryGetProperty("count", out var repeated) ? repeated.GetInt32() : 1;
                Assert.InRange(count, 1, 16_385);
                for (var n = 0; n < count; n++) input.AddRange(bytes);
            }
        }
        string? value = null; string? error = null;
        try
        {
            value = item.GetProperty("kind").GetString() == "gitdir"
                ? GitMetadataReference.ParseGitDirectory(input.ToArray())
                : GitMetadataReference.ParseCommonDirectory(input.ToArray());
        }
        catch (WorkspaceReadException exception) { error = exception.Message; }
        var expected = item.GetProperty("expected");
        if (expected.TryGetProperty("error", out var expectedError)) Assert.Equal(expectedError.GetString(), error);
        else { Assert.Null(error); Assert.Equal(expected.GetProperty("value").GetString(), value); }
    }

    [Fact]
    public void OracleSourceBindingsAreCurrent()
    {
        Assert.Equal(1, Corpus.GetProperty("schemaVersion").GetInt32());
        Assert.True(Corpus.GetProperty("vectors").GetArrayLength() > 600);
        foreach (var source in Corpus.GetProperty("oracle").GetProperty("sources").EnumerateArray())
            Assert.Equal(source.GetProperty("sha256").GetString(), Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(Path.Combine(Root, source.GetProperty("path").GetString()!)))));
    }
}
