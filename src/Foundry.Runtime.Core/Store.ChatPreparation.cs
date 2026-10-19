namespace Foundry.Runtime;

public sealed partial class Store
{
    // Chat preparation without browser or MCP tool advertisement. This does not dispatch a provider or turn retained calls
    // into execution authority. A turn that advertises tools (a Git-project chat's channel tools) passes them with its
    // system instruction; agent-loop.ts prepareRequest then leads the history with that instruction. Project-channel
    // delivery (enrich) is the agent loop's.
    internal Dictionary<string, object?> PrepareChatRequest(string taskId, Dictionary<string, object?> profile, string fingerprint, string content,
        List<object?>? tools = null, string? system = null)
    {
        loop.AssertCurrent();
        var task = ReadTask(taskId);
        // A coding task is prepared only with the tools its turn advertises.
        if (task.TryGetValue("mode", out var mode) && !Equals(mode, "chat") && !(Equals(mode, "coding") && tools is not null) || Truthy(task.GetValueOrDefault("parentTaskId")))
            throw new NotSupportedException("This request preparation supports ordinary chat and coding tasks only.");
        var state = ReadProviderState(taskId);
        if (state is not null && !Equals(state.GetValueOrDefault("fingerprint"), fingerprint))
            throw new InvalidOperationException("This task has native conversation state for an earlier profile configuration. Create a new task for this configuration.");
        if (HasBlockingUnknown(taskId))
            throw new InvalidOperationException("This task has an unknown mutation outcome. Check the outcome before continuing.");
        if (state is not null)
        {
            var pending = ((List<object?>)state["pending"]!).Cast<Dictionary<string, object?>>();
            var recorded = ((List<object?>)state["results"]!).Cast<Dictionary<string, object?>>().ToArray();
            var results = pending.Select(call => (object?)(recorded.FirstOrDefault(result => Equals(result.GetValueOrDefault("id"), call.GetValueOrDefault("id")))
                ?? new Dictionary<string, object?>
                {
                    ["id"] = call["id"], ["name"] = call["name"], ["isError"] = true,
                    ["content"] = "The previous turn was interrupted. This call was not replayed. Inspect current state before proposing any further action."
                })).ToList();
            return new()
            {
                ["profile"] = profile, ["tools"] = tools ?? [], ["continuation"] = state["continuation"], ["toolResults"] = results,
                ["messages"] = new List<object?> { new Dictionary<string, object?> { ["role"] = "user", ["content"] = content } }
            };
        }
        var messages = ProviderHistory.ApplyCompactions(MessagesWithOrdinals(taskId), ReadCompactions(taskId)).Cast<object?>().ToList();
        if (tools is not null) messages.Insert(0, new Dictionary<string, object?> { ["role"] = "system", ["content"] = system });
        messages.Add(new Dictionary<string, object?> { ["role"] = "user", ["content"] = content });
        var request = new Dictionary<string, object?> { ["profile"] = profile, ["messages"] = messages };
        if (tools is not null) request["tools"] = tools;
        return request;
    }

    /// <summary>Decision 2 of P2.4: whether any MCP server is saved, enabled or not, which a new credential would have to
    /// repair.</summary>
    internal bool HasMcpServers()
    {
        loop.AssertCurrent();
        return Scalar("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mcp_servers'") is not null && Scalar("SELECT 1 FROM mcp_servers LIMIT 1") is not null;
    }

    /// <summary>
    /// Decision 2 of P2.3: whether an enabled MCP server has stored tools, which a coding turn would advertise. A row whose
    /// configuration or tool list does not parse counts as one, as TypeScript's tool listing would fail on it.
    /// </summary>
    internal bool HasExternalTools()
    {
        loop.AssertCurrent();
        // Databases from before external tools have no such table, and so no stored tools.
        if (Scalar("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mcp_servers'") is null) return false;
        foreach (var row in Rows("SELECT data,tools FROM mcp_servers"))
        {
            try
            {
                if (Foundry.Protocol.PersistedJson.Parse((string)row["data"]!) is not Dictionary<string, object?> config) return true;
                if (!Truthy(config.GetValueOrDefault("enabled"))) continue;
                if (Foundry.Protocol.PersistedJson.Parse((string)row["tools"]!) is not List<object?> listed || listed.Count > 0) return true;
            }
            catch (Exception error) when (error is System.Text.Json.JsonException or InvalidCastException) { return true; }
        }
        return false;
    }

    /// <summary>saveProviderState: the task's native conversation, replaced whole.</summary>
    internal void SaveProviderState(string taskId, Dictionary<string, object?> state)
    {
        loop.AssertCurrent();
        Execute("INSERT OR REPLACE INTO intents VALUES($p0,'provider.context',$p1,'complete')", taskId, Foundry.Protocol.JsJson.Stringify(state));
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
