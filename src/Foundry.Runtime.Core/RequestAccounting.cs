using System.Globalization;
using System.Text;
using Foundry.Protocol;

namespace Foundry.Runtime;

/// <summary>State-free request budgeting and validation of provider usage measurements.</summary>
internal static class RequestAccounting
{
    private const double MaximumSafeInteger = 9_007_199_254_740_991d;
    private static readonly string[] ContextFields = ["messages", "tools", "continuation", "toolResults"];

    internal static double EstimateContext(IReadOnlyDictionary<string, object?> request)
    {
        var context = ContextFields.ToDictionary(key => key, key => request.TryGetValue(key, out var value) ? value : Undefined.Value, StringComparer.Ordinal);
        var profile = (IReadOnlyDictionary<string, object?>)request["profile"]!;
        return Encoding.UTF8.GetByteCount(JsJson.Stringify(context)!) + 512d + Number(profile["outputLimit"]);
    }
    internal static double EstimateRequest(IReadOnlyDictionary<string, object?> request)
    {
        var reservation = EstimateContext(request);
        var profile = (IReadOnlyDictionary<string, object?>)request["profile"]!;
        if (reservation > Number(profile["contextLimit"])) throw new InvalidOperationException("Conservative context limit reached. Compact this task from its Usage panel or create a new task.");
        return reservation;
    }
    internal static double ReserveRequest(IReadOnlyDictionary<string, object?> task, IReadOnlyDictionary<string, object?> request)
    {
        var reservation = EstimateRequest(request);
        if (Number(task["usedTokens"]) + reservation > Number(task["tokenBudget"])) throw new InvalidOperationException("Insufficient task budget for the conservative request reservation.");
        return reservation;
    }
    internal static Dictionary<string, object?>? MeasuredUsage(IReadOnlyDictionary<string, object?> value)
    {
        var input = Number(value.GetValueOrDefault("inputTokens"));
        var output = Number(value.GetValueOrDefault("outputTokens"));
        if (!Valid(input) || !Valid(output) || !Valid(input + output)) return null;
        static object Subset(object? raw, double total)
        {
            var amount = Number(raw);
            return Valid(amount) && amount <= total ? amount : Undefined.Value;
        }
        var read = Subset(value.GetValueOrDefault("cacheReadTokens"), input);
        var creation = Subset(value.GetValueOrDefault("cacheCreationTokens"), input);
        if ((read is double first ? first : 0) + (creation is double second ? second : 0) > input) read = creation = Undefined.Value;
        return new()
        {
            ["type"] = "usage", ["inputTokens"] = input, ["outputTokens"] = output,
            ["cacheReadTokens"] = read, ["cacheCreationTokens"] = creation,
            ["reasoningTokens"] = Subset(value.GetValueOrDefault("reasoningTokens"), output)
        };
    }
    private static bool Valid(double value) => double.IsFinite(value) && value >= 0 && value <= MaximumSafeInteger && Math.Truncate(value) == value;
    private static double Number(object? value) => value is byte or sbyte or short or ushort or int or uint or long or ulong or float or double or decimal
        ? Convert.ToDouble(value, CultureInfo.InvariantCulture) : double.NaN;
}
