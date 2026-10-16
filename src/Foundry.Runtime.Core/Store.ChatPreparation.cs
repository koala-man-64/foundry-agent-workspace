namespace Foundry.Runtime;

public sealed partial class Store
{
    // Chat preparation without browser/channel/MCP/tool advertisement. This does
    // not dispatch a provider or turn retained calls into execution authority.
    internal Dictionary<string, object?> PrepareChatRequest(string taskId, Dictionary<string, object?> profile, string fingerprint, string content)
    {
        loop.AssertCurrent();
        var task = ReadTask(taskId);
        if (task.TryGetValue("mode", out var mode) && !Equals(mode, "chat") || Truthy(task.GetValueOrDefault("parentTaskId")))
            throw new NotSupportedException("This request preparation supports ordinary chat tasks only.");
        var state = ReadProviderState(taskId);
        if (state is not null && !Equals(state.GetValueOrDefault("fingerprint"), fingerprint))
            throw new InvalidOperationException("This task has native conversation state for an earlier profile configuration. Create a new task for this configuration.");
        if (HasBlockingUnknown(taskId))
            throw new InvalidOperationException("This task has an unknown mutation outcome. Check the outcome before continuing.");
        if (state is not null)
        {
            var pending = ((List<object?>)state["pending"]!).Cast<Dictionary<string, object?>>();
            var recorded = ((List<object?>)state["results"]!).Cast<Dictionary<string, object?>>().ToArray();
            var results = pending.Select(call => recorded.FirstOrDefault(result => Equals(result.GetValueOrDefault("id"), call.GetValueOrDefault("id")))
                ?? new Dictionary<string, object?>
                {
                    ["id"] = call["id"], ["name"] = call["name"], ["isError"] = true,
                    ["content"] = "The previous turn was interrupted. This call was not replayed. Inspect current state before proposing any further action."
                }).ToList();
            return new()
            {
                ["profile"] = profile, ["tools"] = new List<object?>(), ["continuation"] = state["continuation"], ["toolResults"] = results,
                ["messages"] = new List<object?> { new Dictionary<string, object?> { ["role"] = "user", ["content"] = content } }
            };
        }
        var messages = ProviderHistory.ApplyCompactions(MessagesWithOrdinals(taskId), ReadCompactions(taskId));
        messages.Add(new() { ["role"] = "user", ["content"] = content });
        return new() { ["profile"] = profile, ["messages"] = messages };
    }

    internal bool HasBlockingUnknown(string taskId)
    {
        loop.AssertCurrent();
        foreach (var row in Rows("SELECT data,state FROM intents WHERE kind='tool.approval' ORDER BY rowid"))
        {
            var approval = Document((string)row["data"]!);
            if (!Equals(approval.GetValueOrDefault("taskId"), taskId) || !Equals(row["state"], "unknown")) continue;
            var browser = approval.GetValueOrDefault("browser");
            var acknowledgment = browser is Dictionary<string, object?> document ? document.GetValueOrDefault("acknowledgment") : null;
            if (!Truthy(browser) || !Truthy(acknowledgment)) return true;
        }
        return false;
    }
}
