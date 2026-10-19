using Foundry.Platform;

namespace Foundry.Conformance;

/// <summary>
/// Places a corpus fixture on a fake removable drive (Rudy's drive decision, 19 October 2026). TypeScript reads no drive
/// type for project folders, so every committed Node outcome must hold unchanged when the fixture's folders report a
/// removable drive. The app-owned folders inside the fixture (the data directory, or the worktree base and its hooks
/// folder) keep their real fixed drive, as on a machine whose data directory is on a fixed drive.
/// </summary>
internal sealed class RemovableDrive : IDisposable
{
    private readonly List<IDisposable> registrations = [];
    private RemovableDrive() { }

    /// <returns>Nothing when <paramref name="removable"/> is false, so a replay can run either way.</returns>
    internal static RemovableDrive? Place(bool removable, string scratch, params string[] appOwned)
    {
        if (!removable) return null;
        var drive = new RemovableDrive();
        drive.registrations.Add(DriveAdmissions.Fake(scratch, DriveType.Removable));
        foreach (var folder in appOwned) drive.registrations.Add(DriveAdmissions.Fake(folder, DriveType.Fixed));
        return drive;
    }

    public void Dispose()
    {
        for (var index = registrations.Count - 1; index >= 0; index--) registrations[index].Dispose();
        registrations.Clear();
    }
}
