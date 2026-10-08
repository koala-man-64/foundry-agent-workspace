using System.Diagnostics.CodeAnalysis;
using System.Text;

namespace Foundry.Platform;

/// <summary>
/// Real paths as Node 24 in Electron 44 computes them. Every member opens its input, so a UNC path reaches the network
/// exactly as it does in the TypeScript runtime; callers validate untrusted input first.
/// </summary>
public static class FinalPath
{
    /// <summary>
    /// fs.promises.realpath and realpathSync.native: the real path, or false when the path cannot be opened. Scope and
    /// containment checks use this and fail closed.
    /// </summary>
    public static bool TryResolve(string path, [NotNullWhen(true)] out string? realPath)
    {
        ArgumentNullException.ThrowIfNull(path);
        realPath = RealPath(NodeWin32Path.Resolve(path, Environment.CurrentDirectory));
        return realPath is not null;
    }

    /// <summary>
    /// The persisted path identity's spelling: the real path, or the resolved path when it cannot be opened, exactly as
    /// packages/runtime/src/store.ts does. The fallback exists only for path_key compatibility; it is no evidence that
    /// the path exists or where it leads.
    /// </summary>
    public static string Canonical(string path)
    {
        ArgumentNullException.ThrowIfNull(path);
        var absolute = NodeWin32Path.Resolve(path, Environment.CurrentDirectory);
        return RealPath(absolute) ?? absolute;
    }

    /// <summary>projects.path_key: <see cref="Canonical"/> lowered with toLocaleLowerCase('en-US').</summary>
    public static string Key(string path) => EcmaScriptCase.ToLower(Canonical(path));

    /// <summary>fs.realpathSync.native on Windows: Node's namespacing, then libuv uv_fs_realpath (open with no access
    /// and FILE_FLAG_BACKUP_SEMANTICS, read the final DOS path, strip the \\?\ prefix and turn \\?\UNC\ into \\).</summary>
    private static unsafe string? RealPath(string resolved)
    {
        if (resolved.Contains('\0', StringComparison.Ordinal))
        {
            return null; // Node rejects the argument before libuv; CreateFileW would silently open the prefix.
        }
        using var handle = OpenForQuery(Namespaced(resolved));
        if (handle.IsInvalid)
        {
            return null;
        }
        var buffer = new char[512];
        while (true)
        {
            uint length;
            fixed (char* pointer = buffer)
            {
                length = Native.GetFinalPathNameByHandle(handle, pointer, (uint)buffer.Length, Native.VolumeNameDos);
            }
            if (length == 0)
            {
                return null;
            }
            if (length < buffer.Length)
            {
                var final = new string(buffer, 0, (int)length);
                if (final.StartsWith(@"\\?\UNC\", StringComparison.Ordinal))
                {
                    return string.Concat(@"\\", final.AsSpan(8));
                }
                return final.StartsWith(@"\\?\", StringComparison.Ordinal) ? final[4..] : null;
            }
            buffer = new char[length];
        }
    }

    /// <summary>Node's C++ ToNamespacedPath (src/path.cc), which the realpath binding applies before libuv: drive and
    /// UNC paths get the \\?\ prefix, so Win32 normalization never strips trailing dots or spaces and MAX_PATH does not
    /// apply. Device paths (\\.\, \\?\) pass through.</summary>
    private static string Namespaced(string resolved)
    {
        if (resolved.Length <= 2)
        {
            return resolved;
        }
        if (resolved[0] == '\\')
        {
            return resolved[1] == '\\' && resolved[2] is not '?' and not '.' ? string.Concat(@"\\?\UNC\", resolved.AsSpan(2)) : resolved;
        }
        return char.IsAsciiLetter(resolved[0]) && resolved[1] == ':' && resolved[2] == '\\' ? @"\\?\" + resolved : resolved;
    }

    private static unsafe Microsoft.Win32.SafeHandles.SafeFileHandle OpenForQuery(string path)
    {
        fixed (char* name = path)
        {
            // No access and no sharing with FILE_FLAG_BACKUP_SEMANTICS, exactly as libuv opens it. The anonymous quality of
            // service, which libuv omits and .NET's own file APIs always pass, changes nothing for files and directories;
            // a named-pipe server that a device or UNC path reaches cannot impersonate the caller.
            return Native.CreateFile(name, 0, 0, 0, Native.OpenExisting,
                Native.FileAttributeNormal | Native.FileFlagBackupSemantics | Native.SecuritySqosPresent | Native.SecurityAnonymous, 0);
        }
    }
}

/// <summary>A port of Node 24's path.win32.resolve for a single path (lib/path.js), used where the real path is unknown.</summary>
internal static class NodeWin32Path
{
    public static string Resolve(string path, string currentDirectory)
    {
        // Node's fast path: "" or "." with a current directory that starts with a separator is returned unnormalized.
        if (path is "" or "." && currentDirectory.Length > 0 && IsSeparator(currentDirectory[0]))
        {
            return currentDirectory;
        }
        var resolvedDevice = string.Empty;
        var resolvedTail = string.Empty;
        var resolvedAbsolute = false;
        foreach (var candidate in new[] { path, null })
        {
            string current;
            if (candidate is not null)
            {
                if (candidate.Length == 0)
                {
                    continue;
                }
                current = candidate;
            }
            else if (resolvedDevice.Length == 0)
            {
                current = currentDirectory;
            }
            else
            {
                // Node consults the per-drive "=C:" environment variable before process.cwd().
                current = Environment.GetEnvironmentVariable($"={resolvedDevice}") is { Length: > 0 } driveDirectory ? driveDirectory : currentDirectory;
                if (current.Length > 2 && !SameDevice(current[..2], resolvedDevice) && current[2] == '\\')
                {
                    current = $@"{resolvedDevice}\";
                }
            }

            var (device, rootEnd, isAbsolute) = Root(current);
            if (device.Length > 0)
            {
                if (resolvedDevice.Length > 0)
                {
                    if (!SameDevice(device, resolvedDevice))
                    {
                        continue;
                    }
                }
                else
                {
                    resolvedDevice = device;
                }
            }
            if (resolvedAbsolute)
            {
                if (resolvedDevice.Length > 0)
                {
                    break;
                }
            }
            else
            {
                resolvedTail = $@"{current[rootEnd..]}\{resolvedTail}";
                resolvedAbsolute = isAbsolute;
                if (isAbsolute && resolvedDevice.Length > 0)
                {
                    break;
                }
            }
        }
        resolvedTail = Normalize(resolvedTail, !resolvedAbsolute);
        if (resolvedAbsolute)
        {
            return $@"{resolvedDevice}\{resolvedTail}";
        }
        var relative = resolvedDevice + resolvedTail;
        return relative.Length > 0 ? relative : ".";
    }

    private static bool IsSeparator(char value) => value is '/' or '\\';

    /// <summary>Node compares devices with toLowerCase, not a case-insensitive ordinal comparison.</summary>
    private static bool SameDevice(string left, string right) =>
        string.Equals(EcmaScriptCase.ToLower(left), EcmaScriptCase.ToLower(right), StringComparison.Ordinal);

    private static (string Device, int RootEnd, bool IsAbsolute) Root(string path)
    {
        var length = path.Length;
        if (length == 0)
        {
            return (string.Empty, 0, false);
        }
        if (length == 1)
        {
            return IsSeparator(path[0]) ? (string.Empty, 1, true) : (string.Empty, 0, false);
        }
        if (IsSeparator(path[0]))
        {
            if (!IsSeparator(path[1]))
            {
                return (string.Empty, 1, true);
            }
            var j = 2;
            var last = j;
            while (j < length && !IsSeparator(path[j])) j++;
            if (j < length && j != last)
            {
                var firstPart = path[last..j];
                last = j;
                while (j < length && IsSeparator(path[j])) j++;
                if (j < length && j != last)
                {
                    last = j;
                    while (j < length && !IsSeparator(path[j])) j++;
                    if (j == length || j != last)
                    {
                        return firstPart is not "." and not "?"
                            ? ($@"\\{firstPart}\{path[last..j]}", j, true)
                            : ($@"\\{firstPart}", 4, true);
                    }
                }
            }
            return (string.Empty, 0, true);
        }
        if (char.IsAsciiLetter(path[0]) && path[1] == ':')
        {
            return length > 2 && IsSeparator(path[2]) ? (path[..2], 3, true) : (path[..2], 2, false);
        }
        return (string.Empty, 0, false);
    }

    /// <summary>Node's normalizeString with the Windows separator.</summary>
    private static string Normalize(string path, bool allowAboveRoot)
    {
        var result = new StringBuilder();
        var lastSegmentLength = 0;
        var lastSlash = -1;
        var dots = 0;
        var code = '\0';
        for (var i = 0; i <= path.Length; ++i)
        {
            if (i < path.Length)
            {
                code = path[i];
            }
            else if (IsSeparator(code))
            {
                break;
            }
            else
            {
                code = '/';
            }

            if (IsSeparator(code))
            {
                if (lastSlash == i - 1 || dots == 1)
                {
                    // Empty segment or ".": skip.
                }
                else if (dots == 2)
                {
                    if (result.Length < 2 || lastSegmentLength != 2 || result[^1] != '.' || result[^2] != '.')
                    {
                        if (result.Length > 2)
                        {
                            var lastSlashIndex = result.Length - lastSegmentLength - 1;
                            if (lastSlashIndex == -1)
                            {
                                result.Clear();
                                lastSegmentLength = 0;
                            }
                            else
                            {
                                result.Length = lastSlashIndex;
                                lastSegmentLength = result.Length - 1 - LastSeparator(result);
                            }
                            lastSlash = i;
                            dots = 0;
                            continue;
                        }
                        if (result.Length != 0)
                        {
                            result.Clear();
                            lastSegmentLength = 0;
                            lastSlash = i;
                            dots = 0;
                            continue;
                        }
                    }
                    if (allowAboveRoot)
                    {
                        result.Append(result.Length > 0 ? @"\.." : "..");
                        lastSegmentLength = 2;
                    }
                }
                else
                {
                    if (result.Length > 0)
                    {
                        result.Append('\\');
                    }
                    result.Append(path.AsSpan(lastSlash + 1, i - lastSlash - 1));
                    lastSegmentLength = i - lastSlash - 1;
                }
                lastSlash = i;
                dots = 0;
            }
            else if (code == '.' && dots != -1)
            {
                ++dots;
            }
            else
            {
                dots = -1;
            }
        }
        return result.ToString();
    }

    /// <summary>Scans back over one segment only, so collapsing ".." stays linear in the path length.</summary>
    private static int LastSeparator(StringBuilder builder)
    {
        for (var index = builder.Length - 1; index >= 0; index--)
        {
            if (builder[index] == '\\')
            {
                return index;
            }
        }
        return -1;
    }
}
