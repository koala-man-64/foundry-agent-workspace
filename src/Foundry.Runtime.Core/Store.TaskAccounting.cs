using System.Globalization;
using Foundry.Protocol;

namespace Foundry.Runtime;

internal sealed record TaskReservation(double Amount, string RequestId) : IWireModel
{
    public Dictionary<string, object?> ToWire() => new() { ["amount"] = Amount, ["requestId"] = RequestId };
}

public sealed partial class Store
{
    // Single-task accounting only. Coordinated tasks use a separate shared ledger.
    // Callers own task/profile admission and redaction/length checks on metadata.
    internal TaskReservation AdmitTaskRequest(Dictionary<string, object?> task, IReadOnlyDictionary<string, object?> request)
    {
        loop.AssertCurrent();
        return Transaction(() =>
        {
            var current = ReadTask((string)task["id"]!);
            var amount = RequestAccounting.ReserveRequest(current, request);
            var requestId = id().ToString();
            SaveTask(new(current) { ["usedTokens"] = TaskNumber(current["usedTokens"]) + amount, ["status"] = "running" });
            BeginUsage(requestId, task, (IReadOnlyDictionary<string, object?>)request["profile"]!, amount, "conversation");
            return new TaskReservation(amount, requestId);
        });
    }

    internal bool SettleTaskRequest(string taskId, TaskReservation reservation, IReadOnlyDictionary<string, object?>? detail, string outcome, string? reason = null, IReadOnlyDictionary<string, object?>? metadata = null)
    {
        loop.AssertCurrent();
        var measured = detail is null ? null : RequestAccounting.MeasuredUsage(detail);
        return Transaction(() =>
        {
            if (SchemaVersion >= 4)
            {
                if (!FinishUsage(reservation.RequestId, measured, outcome, reason, metadata)) return false;
            }
            else
            {
                if (HasUsage(reservation.RequestId)) return false;
                SaveUsageRecord(new()
                {
                    ["id"] = id().ToString(), ["taskId"] = taskId, ["requestId"] = reservation.RequestId, ["reservedTokens"] = reservation.Amount,
                    ["promptTokens"] = SqlField(measured, "inputTokens"), ["completionTokens"] = SqlField(measured, "outputTokens"),
                    ["cacheReadTokens"] = SqlField(measured, "cacheReadTokens"), ["cacheCreationTokens"] = SqlField(measured, "cacheCreationTokens"),
                    ["usageKnown"] = measured is not null, ["reason"] = reason, ["createdAt"] = Clock.Iso(now())
                });
            }
            var current = ReadTask(taskId);
            var used = measured is null ? reservation.Amount : TaskNumber(measured["inputTokens"]) + TaskNumber(measured["outputTokens"]);
            SaveTask(new(current) { ["usedTokens"] = TaskNumber(current["usedTokens"]) - reservation.Amount + used, ["updatedAt"] = Clock.Iso(now()) });
            return true;
        });
    }

    internal void SaveUsageRecord(Dictionary<string, object?> record)
    {
        loop.AssertCurrent();
        Execute("""
            INSERT INTO usage_records(id,task_id,request_id,reserved,prompt_tokens,completion_tokens,cache_read_tokens,cache_creation_tokens,usage_known,reason,created_at)
            VALUES($p0,$p1,$p2,$p3,$p4,$p5,$p6,$p7,$p8,$p9,$p10)
            """, record["id"], record["taskId"], record["requestId"], record["reservedTokens"], SqlField(record, "promptTokens"), SqlField(record, "completionTokens"),
            SqlField(record, "cacheReadTokens"), SqlField(record, "cacheCreationTokens"), Equals(record["usageKnown"], true) ? 1 : 0, SqlField(record, "reason"), record["createdAt"]);
    }

    private static double TaskNumber(object? value) => Convert.ToDouble(value, CultureInfo.InvariantCulture);
}
