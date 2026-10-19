namespace Foundry.Platform;

/// <summary>
/// The local drive types a directory chain may sit on. The type is read from the drive root (GetDriveType), which opens
/// nothing on the drive, so a mapped network drive is refused before Windows could authenticate to its server (migration
/// plan, decision 8).
/// </summary>
public enum DriveAdmission
{
    /// <summary>
    /// Fixed drives only, <see cref="DirectoryLease"/>'s default: the data directory and the app-owned folders beneath it
    /// (the worktree base and its hooks folder), and a local-path push remote, as TypeScript's requireSupportedRemotes
    /// requires. The executables the runtime launches (Windows PowerShell and git.exe) are held to fixed drives by their
    /// own checks.
    /// </summary>
    Fixed,

    /// <summary>
    /// Fixed or removable drives: a project folder the user chose, the paths beneath it and the Git directories its
    /// metadata names, as TypeScript admits them (Rudy, 19 October 2026). Network and mapped network drives stay refused
    /// (decision 8), as do optical drives, RAM disks, and roots whose type is unknown or that are not mounted.
    /// </summary>
    Project,
}

/// <summary>The rule behind each <see cref="DriveAdmission"/>, and the drive-type probe it reads.</summary>
public static class DriveAdmissions
{
    private static readonly Lock Gate = new();
    private static (string Folder, DriveType Type)[] fakes = [];

    /// <summary>Whether a drive of this type is admitted. Any value other than <see cref="DriveAdmission.Project"/> admits
    /// fixed drives only.</summary>
    public static bool Admits(this DriveAdmission admission, DriveType type) =>
        type is DriveType.Fixed || type is DriveType.Removable && admission is DriveAdmission.Project;

    /// <summary>Whether the drive holding a drive-absolute local path (<c>X:\...</c>) is admitted. Any other form, a UNC or
    /// device path included, is refused before any probe.</summary>
    public static bool Admits(this DriveAdmission admission, string path) => DriveAbsolute(path) && admission.Admits(TypeOf(path));

    /// <summary>The type of the drive holding a drive-absolute local path (<c>X:\...</c>), read from its root without
    /// opening anything on it.</summary>
    public static DriveType TypeOf(string path)
    {
        if (!DriveAbsolute(path)) throw new ArgumentException("A drive-absolute path is required.", nameof(path));
        (string Folder, DriveType Type)? match = null;
        foreach (var fake in Volatile.Read(ref fakes))
            if (Covers(fake.Folder, path) && (match is null || fake.Folder.Length > match.Value.Folder.Length)) match = fake;
        return match?.Type ?? new DriveInfo(path[..3]).DriveType;
    }

    /// <summary>
    /// Test seam: until disposal, the drive type reported for a drive-absolute folder and every path beneath it, so a
    /// fixture can sit on a removable, optical or network "drive" without one. The longest covering folder wins, and every
    /// other path reads its real type. Only this assembly and the test assemblies it names can register.
    /// </summary>
    internal static IDisposable Fake(string folder, DriveType type)
    {
        var entry = (Folder: folder.TrimEnd('\\'), Type: type);
        if (!DriveAbsolute(entry.Folder)) throw new ArgumentException("A drive-absolute folder below the drive root is required.", nameof(folder));
        lock (Gate) Volatile.Write(ref fakes, [.. fakes, entry]);
        return new Registration(entry);
    }

    private static bool DriveAbsolute(string path) => path.Length >= 3 && char.IsAsciiLetter(path[0]) && path[1] == ':' && path[2] == '\\';

    private static bool Covers(string folder, string path) =>
        path.StartsWith(folder, StringComparison.OrdinalIgnoreCase) && (path.Length == folder.Length || path[folder.Length] == '\\');

    private sealed class Registration((string Folder, DriveType Type) entry) : IDisposable
    {
        private bool disposed;
        public void Dispose()
        {
            lock (Gate)
            {
                if (disposed) return;
                disposed = true;
                var remaining = fakes.ToList();
                remaining.Remove(entry);
                Volatile.Write(ref fakes, [.. remaining]);
            }
        }
    }
}
