using System.Text;
using System.Text.Json;

namespace Foundry.Platform;

/// <summary>
/// ECMAScript String.prototype.toLowerCase, which V8 also uses for toLocaleLowerCase in every locale except tr, az, lt
/// and el: ICU's full lowercase mapping in the root locale. Unlike .NET's ToLower it maps U+0130 to "i̇" and applies
/// the final-sigma rule. The tables (EcmaScriptLowercase.json) are Electron 44's Unicode 17.0 data, generated and
/// drift-checked by tests/golden/ecmascript-case.test.ts, so persisted path keys do not move with the system ICU.
/// </summary>
internal static class EcmaScriptCase
{
    private const int CapitalSigma = 0x03A3;
    private static readonly Lazy<Tables> Data = new(Tables.Load);

    public static string UnicodeVersion => Data.Value.Unicode;

    public static string ToLower(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        var tables = Data.Value;
        var result = new StringBuilder(value.Length);
        for (var index = 0; index < value.Length;)
        {
            var (codePoint, width) = At(value, index);
            if (codePoint == CapitalSigma)
            {
                result.Append(IsFinalSigma(value, index, width, tables) ? 'ς' : 'σ');
            }
            else if (tables.Lower.TryGetValue(codePoint, out var lower))
            {
                result.Append(lower);
            }
            else
            {
                result.Append(value, index, width);
            }
            index += width;
        }
        return result.ToString();
    }

    /// <summary>
    /// SpecialCasing's Final_Sigma as ICU evaluates it: preceded by a cased letter with only case-ignorable characters
    /// between, and not followed by one. A character that is both counts as case-ignorable, as in ICU's
    /// ucase_getTypeOrIgnorable.
    /// </summary>
    private static bool IsFinalSigma(string value, int index, int width, Tables tables)
    {
        var before = index;
        var precededByCased = false;
        while (before > 0)
        {
            var (codePoint, size) = Before(value, before);
            before -= size;
            if (!tables.IsCaseIgnorable(codePoint))
            {
                precededByCased = tables.IsCased(codePoint);
                break;
            }
        }
        if (!precededByCased)
        {
            return false;
        }
        for (var after = index + width; after < value.Length;)
        {
            var (codePoint, size) = At(value, after);
            after += size;
            if (!tables.IsCaseIgnorable(codePoint))
            {
                return !tables.IsCased(codePoint);
            }
        }
        return true;
    }

    /// <summary>The code point at <paramref name="index"/>; an unpaired surrogate stands for itself, as in ICU.</summary>
    private static (int CodePoint, int Width) At(string value, int index) =>
        char.IsHighSurrogate(value[index]) && index + 1 < value.Length && char.IsLowSurrogate(value[index + 1])
            ? (char.ConvertToUtf32(value[index], value[index + 1]), 2)
            : (value[index], 1);

    private static (int CodePoint, int Width) Before(string value, int index) =>
        char.IsLowSurrogate(value[index - 1]) && index >= 2 && char.IsHighSurrogate(value[index - 2])
            ? (char.ConvertToUtf32(value[index - 2], value[index - 1]), 2)
            : (value[index - 1], 1);

    private sealed class Tables
    {
        private readonly int[] casedStarts;
        private readonly int[] casedEnds;
        private readonly int[] ignorableStarts;
        private readonly int[] ignorableEnds;

        private Tables(string unicode, Dictionary<int, string> lower, int[][] cased, int[][] ignorable)
        {
            Unicode = unicode;
            Lower = lower;
            casedStarts = cased.Select(range => range[0]).ToArray();
            casedEnds = cased.Select(range => range[1]).ToArray();
            ignorableStarts = ignorable.Select(range => range[0]).ToArray();
            ignorableEnds = ignorable.Select(range => range[1]).ToArray();
        }

        public string Unicode { get; }

        public Dictionary<int, string> Lower { get; }

        public bool IsCased(int codePoint) => Contains(casedStarts, casedEnds, codePoint);

        public bool IsCaseIgnorable(int codePoint) => Contains(ignorableStarts, ignorableEnds, codePoint);

        public static Tables Load()
        {
            using var stream = typeof(EcmaScriptCase).Assembly.GetManifestResourceStream("Foundry.Platform.EcmaScriptLowercase.json")
                ?? throw new InvalidOperationException("The embedded lowercase tables are missing.");
            using var document = JsonDocument.Parse(stream);
            var root = document.RootElement;
            var lower = new Dictionary<int, string>();
            foreach (var row in root.GetProperty("lower").EnumerateArray())
            {
                var values = row.EnumerateArray().Select(item => item.GetInt32()).ToArray();
                lower.Add(values[0], string.Concat(values.Skip(1).Select(char.ConvertFromUtf32)));
            }
            return new Tables(root.GetProperty("unicode").GetString() ?? string.Empty, lower, Ranges(root.GetProperty("cased")), Ranges(root.GetProperty("caseIgnorable")));
        }

        private static int[][] Ranges(JsonElement element) =>
            element.EnumerateArray().Select(range => range.EnumerateArray().Select(item => item.GetInt32()).ToArray()).ToArray();

        /// <summary>Binary search over sorted, disjoint inclusive ranges.</summary>
        private static bool Contains(int[] starts, int[] ends, int codePoint)
        {
            var index = Array.BinarySearch(starts, codePoint);
            if (index < 0)
            {
                index = ~index - 1;
            }
            return index >= 0 && codePoint <= ends[index];
        }
    }
}
