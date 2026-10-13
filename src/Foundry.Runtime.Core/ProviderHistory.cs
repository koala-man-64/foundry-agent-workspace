using System.Globalization;

namespace Foundry.Runtime;

/// <summary>Complete-message provider history. Retained summaries are data, never execution authority.</summary>
internal static class ProviderHistory
{
    internal static List<Dictionary<string, object?>> ApplyCompactions(IEnumerable<IReadOnlyDictionary<string, object?>> messages, IEnumerable<IReadOnlyDictionary<string, object?>> compactions)
    {
        var ordered = compactions.OrderBy(record => Number(record["fromOrdinal"])).ToArray();
        var output = new List<Dictionary<string, object?>>();
        var emitted = new HashSet<string>(StringComparer.Ordinal);
        foreach (var message in messages)
        {
            if (!Equals(message.GetValueOrDefault("status"), "complete")) continue;
            var ordinal = Number(message["ordinal"]);
            var range = ordered.FirstOrDefault(record => ordinal >= Number(record["fromOrdinal"]) && ordinal <= Number(record["toOrdinal"]));
            if (range is null)
            {
                output.Add(new() { ["role"] = message["role"], ["content"] = message["content"] });
                continue;
            }
            if (!emitted.Add((string)range["id"]!)) continue;
            if (output.Count > 0 && Equals(output[^1]["role"], "user"))
                output[^1]["content"] = (string)output[^1]["content"]! + "\n\n---\n\n" + (string)range["summary"]!;
            else output.Add(new() { ["role"] = "user", ["content"] = range["summary"] });
        }
        return output;
    }

    private static double Number(object? value) => Convert.ToDouble(value, CultureInfo.InvariantCulture);
}
