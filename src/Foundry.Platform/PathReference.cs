namespace Foundry.Platform;

/// <summary>Resolves a Git pointer against the directory that holds it, as Node's path.win32.resolve(base, reference).</summary>
public static class PathReference
{
    /// <summary>
    /// The resolved absolute path, or null for a drive-relative reference to a drive other than the base's ("D:x"
    /// against "C:\..."): Node resolves that from per-drive process state (the "=D:" variable or the current directory),
    /// so the result would not be a property of the repository.
    /// </summary>
    public static string? Resolve(string basePath, string reference)
    {
        ArgumentNullException.ThrowIfNull(basePath);
        ArgumentNullException.ThrowIfNull(reference);
        if (basePath.Length < 3 || !char.IsAsciiLetter(basePath[0]) || basePath[1] != ':' || basePath[2] != '\\')
            throw new ArgumentException("The base must be an absolute drive path.", nameof(basePath));
        if (reference.Length >= 2 && char.IsAsciiLetter(reference[0]) && reference[1] == ':' && (reference.Length == 2 || reference[2] is not ('\\' or '/')))
        {
            // Node compares devices with toLowerCase (for ASCII letters, a case-insensitive match), then keeps the
            // reference's spelling of the device and resolves the remainder against the base.
            if (char.ToLowerInvariant(reference[0]) != char.ToLowerInvariant(basePath[0])) return null;
            return string.Concat(reference.AsSpan(0, 2), NodeWin32Path.Resolve(reference[2..], basePath).AsSpan(2));
        }
        return NodeWin32Path.Resolve(reference, basePath);
    }
}
