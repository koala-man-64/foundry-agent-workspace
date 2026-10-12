using System.Text;
using Foundry.Protocol;
using Xunit;

namespace Foundry.Conformance;

public sealed class FramingTests
{
    [Fact]
    public void FragmentedUnicodeMultipleFramesCrLfAndBlankLines()
    {
        using var reader = new LineReader(16);
        var lines = new List<byte[]>();
        foreach (var value in Encoding.UTF8.GetBytes("😀é\r\n \t\nabc\nunterminated")) lines.AddRange(reader.Push([value]));
        Assert.Equal(["😀é\r", " \t", "abc"], lines.Select(Encoding.UTF8.GetString));
        Assert.True(LineReader.IsBlank(lines[1]));
        reader.Finish();
        Assert.Equal("next", Encoding.UTF8.GetString(Assert.Single(reader.Push("next\n"u8))));
    }

    [Fact]
    public void LimitBelongsToNormalizedLineNotTransportChunk()
    {
        using var reader = new LineReader(4);
        Assert.Equal(3, reader.Push("1234\n1234\n1234\n"u8).Count);
        Assert.Throws<InvalidDataException>(() => reader.Push("12345\n"u8));
        using var crlf = new LineReader(4);
        Assert.Throws<InvalidDataException>(() => crlf.Push("1234\r\n"u8));
        using var malformed = new LineReader(2);
        Assert.Throws<InvalidDataException>(() => malformed.Push([0xff])); // Node decodes U+FFFD: three UTF-8 bytes.
    }

    [Fact]
    public void ExactOneMiBAndFragmentedBoundary()
    {
        using var reader = new LineReader();
        var bytes = Encoding.UTF8.GetBytes(new string('x', WireJson.MaximumBytes - 4) + "😀\n");
        Assert.Empty(reader.Push(bytes.AsSpan(0, bytes.Length - 4)));
        Assert.Equal(WireJson.MaximumBytes, Assert.Single(reader.Push(bytes.AsSpan(bytes.Length - 4))).Length);
        Assert.Throws<InvalidDataException>(() => reader.Push(Encoding.UTF8.GetBytes(new string('x', WireJson.MaximumBytes + 1))));
    }
}
