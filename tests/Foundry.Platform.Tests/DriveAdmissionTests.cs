using Xunit;

namespace Foundry.Platform.Tests;

/// <summary>
/// Rudy's drive decision (19 October 2026): projects may sit on fixed or removable drives, as TypeScript admits them; the
/// data directory, app-owned folders and launched executables stay fixed-only; network and mapped network drives stay
/// refused (decision 8). Drive types other than the real fixed one are faked with <see cref="DriveAdmissions.Fake"/>.
/// </summary>
public sealed class DriveAdmissionTests
{
    private static readonly DriveType[] Refused = [DriveType.Network, DriveType.NoRootDirectory, DriveType.Unknown, DriveType.CDRom, DriveType.Ram];

    public static TheoryData<DriveType> RefusedTypes() => [.. Refused];

    [Fact]
    public void FixedDrivesAreAdmittedEverywhereAndRemovableDrivesOnlyForProjects()
    {
        foreach (var type in Enum.GetValues<DriveType>())
        {
            Assert.Equal(type is DriveType.Fixed, DriveAdmission.Fixed.Admits(type));
            Assert.Equal(type is DriveType.Fixed or DriveType.Removable, DriveAdmission.Project.Admits(type));
        }
        // An undefined admission value fails closed to fixed drives only.
        Assert.True(((DriveAdmission)7).Admits(DriveType.Fixed));
        Assert.False(((DriveAdmission)7).Admits(DriveType.Removable));
    }

    [Theory]
    [InlineData(@"\\server\share\project"), InlineData("//server/share/project"), InlineData(@"\\?\C:\project"), InlineData(@"\\.\C:\project")]
    [InlineData("C:project"), InlineData("C:/project"), InlineData(@"\project"), InlineData("project"), InlineData("")]
    public void OnlyDriveAbsolutePathsAreProbed(string path)
    {
        Assert.False(DriveAdmission.Project.Admits(path));
        Assert.False(DriveAdmission.Fixed.Admits(path));
        Assert.Throws<ArgumentException>(() => DriveAdmissions.TypeOf(path));
    }

    [Fact]
    public void AFakeCoversItsFolderAndEverythingBeneathItUntilDisposal()
    {
        var scratch = FinalPath.Canonical(Scratch.Directory("foundry-drive-fake-").FullName);
        try
        {
            var project = Path.Combine(scratch, "project"); var sibling = Path.Combine(scratch, "project-sibling"); var inner = Path.Combine(project, "inner");
            using (DriveAdmissions.Fake(project + "\\", DriveType.Removable))
            {
                Assert.Equal(DriveType.Removable, DriveAdmissions.TypeOf(project));
                Assert.Equal(DriveType.Removable, DriveAdmissions.TypeOf(project.ToUpperInvariant() + "\\child"));
                Assert.Equal(DriveType.Fixed, DriveAdmissions.TypeOf(sibling));
                Assert.Equal(DriveType.Fixed, DriveAdmissions.TypeOf(scratch));
                using (DriveAdmissions.Fake(inner, DriveType.CDRom))
                {
                    // The longest covering folder wins.
                    Assert.Equal(DriveType.CDRom, DriveAdmissions.TypeOf(Path.Combine(inner, "x")));
                    Assert.Equal(DriveType.Removable, DriveAdmissions.TypeOf(Path.Combine(project, "x")));
                }
                Assert.Equal(DriveType.Removable, DriveAdmissions.TypeOf(Path.Combine(inner, "x")));
            }
            Assert.Equal(DriveType.Fixed, DriveAdmissions.TypeOf(project));
            Assert.Throws<ArgumentException>(() => DriveAdmissions.Fake(scratch[..3], DriveType.Removable));
            Assert.Throws<ArgumentException>(() => DriveAdmissions.Fake("relative", DriveType.Removable));
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public void LeasesStayFixedOnlyUnlessTheCallerAdmitsProjectDrives()
    {
        var scratch = FinalPath.Canonical(Scratch.Directory("foundry-drive-lease-").FullName);
        try
        {
            var folder = Directory.CreateDirectory(Path.Combine(scratch, "project", "folder")).FullName;
            using (DriveAdmissions.Fake(scratch, DriveType.Removable))
            {
                // The data directory, app-owned folders and executables keep the fixed-only default.
                Assert.Throws<IOException>(() => DirectoryLease.Acquire(folder));
                Assert.Throws<IOException>(() => DirectoryLease.AcquireExisting(folder));
                Assert.Throws<IOException>(() => DirectoryLease.AcquireSharingWrites(folder));
                Assert.Throws<IOException>(() => DirectoryLease.AcquireExistingSharingWrites(folder));
                Assert.Throws<IOException>(() => DirectoryLease.AcquireExistingSharingWrites(folder, DriveAdmission.Fixed));
                using (var lease = DirectoryLease.AcquireExistingSharingWrites(folder, DriveAdmission.Project))
                {
                    Assert.NotEmpty(lease.Identities());
                    Assert.Throws<IOException>(() => Directory.Move(folder, folder + "-moved"));
                }
            }
            using (DirectoryLease.AcquireExisting(folder)) { }
        }
        finally { Directory.Delete(scratch, true); }
    }

    /// <summary>Every other drive type is refused for projects before any component is opened: the chain passes through a
    /// junction, which an open would refuse as a <see cref="ReparsePointException"/>, but the refusal is the plain one.</summary>
    [Theory, MemberData(nameof(RefusedTypes))]
    public async Task ProjectLeasesRefuseEveryOtherDriveTypeBeforeOpening(DriveType type)
    {
        var scratch = FinalPath.Canonical(Scratch.Directory("foundry-drive-refused-").FullName);
        var link = Path.Combine(scratch, "link");
        try
        {
            var target = Directory.CreateDirectory(Path.Combine(scratch, "target", "inner")).FullName;
            await Scratch.Run(Comspec, $"\"{Comspec}\" /d /c mklink /J \"{link}\" \"{Path.GetDirectoryName(target)}\"", scratch, Scratch.Environment(scratch));
            var through = Path.Combine(link, "inner");
            Assert.Throws<ReparsePointException>(() => DirectoryLease.AcquireExistingSharingWrites(through, DriveAdmission.Project));
            using (DriveAdmissions.Fake(scratch, type))
            {
                Assert.False(DriveAdmission.Project.Admits(through));
                Assert.Throws<IOException>(() => DirectoryLease.AcquireExistingSharingWrites(through, DriveAdmission.Project));
                Assert.Throws<IOException>(() => DirectoryLease.AcquireExistingSharingWrites(target, DriveAdmission.Project));
            }
        }
        finally
        {
            if (Directory.Exists(link)) Directory.Delete(link);
            Directory.Delete(scratch, true);
        }
    }

    private static string Comspec => Environment.GetEnvironmentVariable("ComSpec") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
}
