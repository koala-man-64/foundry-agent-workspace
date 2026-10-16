using System.Text.Json;
using Foundry.Protocol;
using Foundry.Protocol.Models;
using Xunit;

namespace Foundry.Conformance;

public sealed class ModelTests
{
    [Fact]
    public void TypedSurfaceIsCompleteAndAbsenceRemainsDistinctFromNull()
    {
        Assert.Equal(Contracts.Names.Order(StringComparer.Ordinal), ContractModelTypes.Inputs.Keys.Order(StringComparer.Ordinal));
        Assert.Equal(Contracts.Names.Where(name => name.StartsWith("rpc ", StringComparison.Ordinal)).Select(name => name[4..]).Order(StringComparer.Ordinal), ContractModelTypes.Results.Keys.Order(StringComparer.Ordinal));
        Assert.All(ContractModelTypes.Inputs.Values, type => Assert.True(typeof(IWireModel).IsAssignableFrom(type)));
        var update = new RpcProjectUpdateInput { ProjectId = "00000000-0000-4000-8000-000000000002", Name = "  fixture  " };
        var normalized = (Dictionary<string, object?>)Contracts.Validate("rpc project.update", update)!;
        Assert.Equal("fixture", normalized["name"]);
        Assert.DoesNotContain("hidden", JsJson.Stringify(update)!);
        var channel = new RpcChannelSendInput { TaskId = update.ProjectId, RequestId = update.ProjectId, Content = "fixture", RecipientTaskId = new Specified<string?>(null) };
        Assert.Contains("\"recipientTaskId\":null", JsJson.Stringify(channel)!);
        Assert.Throws<JsonException>(() => Contracts.Validate("rpc project.update", update with { Name = "" }));
        Assert.Equal("[null,0,1]", JsJson.Stringify(new[] { double.NaN, -0d, 1d }));
        Assert.Equal("{\"10\":\"ten\",\"z\":\"last\"}", JsJson.Stringify(new Dictionary<string, string> { ["z"] = "last", ["10"] = "ten" }));
    }
}
