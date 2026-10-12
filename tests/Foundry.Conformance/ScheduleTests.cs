using System.Globalization;
using Foundry.Protocol;
using Foundry.Runtime;
using Xunit;

namespace Foundry.Conformance;

public sealed class ScheduleTests
{
    [Fact]
    public void MatchesCommittedNodeVectors()
    {
        using var schedules = ContractTests.Golden("schedules");
        var content = schedules.RootElement.GetProperty("content");
        foreach (var item in content.GetProperty("resolved").EnumerateArray()) Assert.Equal(item.GetProperty("instant").GetString(), Clock.Iso(ScheduleClock.Resolve(item.GetProperty("date").GetString()!, item.GetProperty("time").GetString()!, item.GetProperty("timeZone").GetString()!)));
        foreach (var item in content.GetProperty("due").EnumerateArray()) Assert.Equal(JsJson.Stringify(ContractTests.Decode(item.GetProperty("due"))), JsJson.Stringify(ScheduleClock.Due((Dictionary<string, object?>)ContractTests.Decode(item.GetProperty("schedule"))!, DateTimeOffset.Parse(item.GetProperty("now").GetString()!, CultureInfo.InvariantCulture))));
    }

    [Theory]
    [InlineData("+05", "2026-10-12T07:00:00.000Z")]
    [InlineData("+0530", "2026-10-12T06:30:00.000Z")]
    [InlineData("+05:30", "2026-10-12T06:30:00.000Z")]
    [InlineData("us/eastern", "2026-10-12T16:00:00.000Z")]
    public void AcceptedOffsetAndAliasSpellingsResolve(string zone, string expected) => Assert.Equal(expected, Clock.Iso(ScheduleClock.Resolve("2026-10-12", "12:00", zone)));

    [Fact]
    public void InvalidWindowsZoneDoesNotFallBackToUtc() => Assert.Throws<ArgumentException>(() => ScheduleClock.Resolve("2026-10-12", "12:00", "Pacific Standard Time"));
}
