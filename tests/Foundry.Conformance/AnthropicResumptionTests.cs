using Foundry.Protocol;
using Foundry.Providers;
using Xunit;

namespace Foundry.Conformance;

/// <summary>
/// T-1, dual-landed: when an Anthropic continuation has several pending calls and the next request carries one user
/// message, that message joins every result's block, in the request's order. The merge used to carry only the first, so
/// Anthropic refused the unanswered tool_use blocks on every later turn. The stream oracle pins the same request.
/// </summary>
public sealed class AnthropicResumptionTests
{
    [Theory]
    [InlineData(2)]
    [InlineData(3)]
    public void ANewUserMessageJoinsEveryPendingCallsResult(int count)
    {
        var ids = Enumerable.Range(1, count).Select(index => $"toolu_{index}").ToList();
        var assistant = new Dictionary<string, object?>
        {
            ["role"] = "assistant",
            ["content"] = new List<object?>([new Dictionary<string, object?> { ["type"] = "thinking", ["thinking"] = "hidden", ["signature"] = "sig" },
                .. ids.Select(id => (object?)new Dictionary<string, object?> { ["type"] = "tool_use", ["id"] = id, ["name"] = "read_file", ["input"] = new Dictionary<string, object?>() })]),
        };
        var data = new Dictionary<string, object?>
        {
            ["messages"] = new List<object?> { new Dictionary<string, object?> { ["role"] = "user", ["content"] = "first" }, assistant },
            ["system"] = "Kept system.",
            ["calls"] = ids.Select(id => (object?)new Dictionary<string, object?> { ["id"] = id, ["name"] = "read_file", ["arguments"] = new Dictionary<string, object?>() }).ToList(),
        };
        // The results arrive in the reverse of the calls' order, and the request keeps the results' order.
        var results = ids.Select((id, index) => new ProviderToolResult(id, "read_file", $"result {index + 1}", index == 1)).Reverse().ToList();
        var request = new ProviderRequest([new ProviderMessage("system", "dropped"), new ProviderMessage("user", "please continue")], new ProviderContinuation("anthropic", data),
            [new ProviderTool("read_file", "Read a file.", new Dictionary<string, object?>())], results)
        {
            Profile = new Dictionary<string, object?>
            {
                ["id"] = "0c46787b-9dce-4a8d-a8aa-6fe7f8a44d53", ["name"] = "Resumption", ["apiKind"] = "anthropic", ["endpoint"] = "https://sample.services.ai.azure.com",
                ["deployment"] = "test-model", ["contextLimit"] = 4096d, ["outputLimit"] = 256d,
            },
            Credential = "fixture-credential",
        };

        var prepared = AzureRequests.Prepare("anthropic", request);

        var merged = new Dictionary<string, object?>
        {
            ["role"] = "user",
            ["content"] = new List<object?>([.. results.Select(result => (object?)new Dictionary<string, object?> { ["type"] = "tool_result", ["tool_use_id"] = result.Id, ["content"] = result.Content, ["is_error"] = result.IsError }),
                new Dictionary<string, object?> { ["type"] = "text", ["text"] = "please continue" }]),
        };
        var expected = new List<object?> { new Dictionary<string, object?> { ["role"] = "user", ["content"] = "first" }, assistant, merged };
        Assert.Equal(JsJson.Stringify(expected), JsJson.Stringify(prepared.Body["messages"]));
        Assert.Equal("Kept system.", prepared.Body["system"]);
        // The stored state is the request's history, so the next continuation carries the same answered turn.
        Assert.Equal(JsJson.Stringify(expected), JsJson.Stringify(prepared.State["messages"]));
    }
}
