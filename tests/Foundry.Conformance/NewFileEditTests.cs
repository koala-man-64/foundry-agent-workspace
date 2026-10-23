using System.Security.Cryptography;
using System.Text;
using Foundry.Protocol;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

public sealed class NewFileEditTests
{
    [Theory]
    [InlineData("")]
    [InlineData("reviewed 雪🙂\n")]
    public async Task CreationBindsParentsAndContentAndRefusesReplay(string after)
    {
        using var fixture = RepositoryFixture.Create("foundry-native-create-");
        Directory.CreateDirectory(fixture.Local("plain/existing"));
        await using var loop = new RuntimeLoop();
        await loop.Invoke(() =>
        {
            var service = new RepositoryService(loop, fixture.Local("wt"), fixture.Environment);
            var edit = service.PrepareEdit(fixture.Local("plain"), "existing/new.txt", null, after);
            Assert.Equal("", edit.Before);
            Assert.NotNull(edit.CreationIdentities);
            var preimage = JsJson.Stringify(new List<object?> { edit.Root, edit.Path, null, edit.ResultingHash, edit.CreationIdentities.Cast<object?>().ToList() })!;
            Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(preimage))), edit.Fingerprint);
            Assert.False(edit.ToWire().ContainsKey("creationIdentities"));
            var result = service.ApplyEdit(edit);
            Assert.Equal(edit.ResultingHash, result["hash"]);
            Assert.Equal(after, File.ReadAllText(fixture.Local("plain/existing/new.txt")));
            Assert.Equal("none", Assert.Throws<RepositoryException>(() => service.ApplyEdit(edit)).Outcome);
            return Task.FromResult(0);
        });
    }

    [Fact]
    public async Task DirectoryReplacementAfterReviewRefusesBeforeMutation()
    {
        using var fixture = RepositoryFixture.Create("foundry-native-create-parent-");
        Directory.CreateDirectory(fixture.Local("plain/parent"));
        await using var loop = new RuntimeLoop();
        await loop.Invoke(() =>
        {
            var service = new RepositoryService(loop, fixture.Local("wt"), fixture.Environment);
            var edit = service.PrepareEdit(fixture.Local("plain"), "parent/new.txt", null, "reviewed");
            Directory.Move(fixture.Local("plain/parent"), fixture.Local("plain/old"));
            Directory.CreateDirectory(fixture.Local("plain/parent"));
            var refusal = Assert.Throws<RepositoryException>(() => service.ApplyEdit(edit));
            Assert.Equal(("none", "Edit approval is stale."), (refusal.Outcome, refusal.Message));
            Assert.False(File.Exists(fixture.Local("plain/parent/new.txt")));
            Assert.False(File.Exists(fixture.Local("plain/old/new.txt")));
            return Task.FromResult(0);
        });
    }

    [Theory]
    [InlineData("pinned", "none", false)]
    [InlineData("created", "unknown", true)]
    [InlineData("written", "unknown", true)]
    public async Task SuccessfulCreateIsTheMutationBoundary(string stage, string outcome, bool exists)
    {
        using var fixture = RepositoryFixture.Create("foundry-native-create-boundary-");
        Directory.CreateDirectory(fixture.Local("plain"));
        await using var loop = new RuntimeLoop();
        await loop.Invoke(() =>
        {
            var service = new RepositoryService(loop, fixture.Local("wt"), fixture.Environment);
            var edit = service.PrepareEdit(fixture.Local("plain"), "new.txt", null, "");
            service.EditStage = observed => { if (observed == stage) throw new IOException("injected"); };
            Assert.Equal(outcome, Assert.Throws<RepositoryException>(() => service.ApplyEdit(edit)).Outcome);
            Assert.Equal(exists, File.Exists(fixture.Local("plain/new.txt")));
            return Task.FromResult(0);
        });
    }

    [Fact]
    public void OnlyWriteFileAdmitsAnExplicitNullHash()
    {
        Assert.Null(ToolDefinitions.Parse("write_file", new Dictionary<string, object?> { ["path"] = "new.txt", ["expectedHash"] = null, ["content"] = "new" })["expectedHash"]);
        Assert.ThrowsAny<Exception>(() => ToolDefinitions.Parse("write_file", new Dictionary<string, object?> { ["path"] = "new.txt", ["content"] = "new" }));
        Assert.ThrowsAny<Exception>(() => ToolDefinitions.Parse("replace_text", new Dictionary<string, object?> { ["path"] = "new.txt", ["expectedHash"] = null, ["oldText"] = "old", ["newText"] = "new" }));
    }
}
