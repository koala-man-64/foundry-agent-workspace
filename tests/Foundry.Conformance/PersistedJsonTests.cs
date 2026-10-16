using System.Text.Json;
using Foundry.Protocol;
using Xunit;

namespace Foundry.Conformance;

public sealed class PersistedJsonTests
{
    [Fact]
    public void RetainedUnknownDataKeepsLegacyStringsDuplicatesAndDeepValues()
    {
        const string json = "{\"retained\":\"\\ud800\",\"key\":1,\"key\":2,\"\\udfff\":true}";
        var document = (Dictionary<string, object?>)PersistedJson.Parse(json)!;
        Assert.Equal("\ud800", document["retained"]);
        Assert.Equal(2d, document["key"]);
        Assert.Equal(true, document["\udfff"]);
        Assert.Equal("{\"retained\":\"\\ud800\",\"key\":2,\"\\udfff\":true}", JsJson.Stringify(document));
        Assert.Throws<JsonException>(() => WireJson.Parse(json));
        var deep = new string('[', 96) + "\"opaque\"" + new string(']', 96);
        Assert.Equal(deep, JsJson.Stringify(PersistedJson.Parse(deep)));
        Assert.Equal("{\"result\":" + deep + "}", JsJson.Stringify(new { result = PersistedJson.Parse(deep) }));
    }
}
