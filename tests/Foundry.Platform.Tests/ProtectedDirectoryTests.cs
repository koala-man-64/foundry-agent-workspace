using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.RegularExpressions;
using Xunit;

namespace Foundry.Platform.Tests;

/// <summary>Spike S7: the managed, create-time ACL equals what backup-protection.ts writes and verifies with PowerShell.</summary>
public sealed partial class ProtectedDirectoryTests
{
    private const AccessControlSections OwnerGroupAndAccess = AccessControlSections.Owner | AccessControlSections.Group | AccessControlSections.Access;

    [Fact]
    public async Task TheCreatedDescriptorEqualsThePowerShellReference()
    {
        var scratch = Scratch.Directory("foundry-acl-");
        var reference = Directory.CreateDirectory(Path.Combine(scratch.FullName, "reference")).FullName;
        await RunTypeScriptProtection(reference);

        var created = ProtectedDirectory.Create(Path.Combine(scratch.FullName, "created")).FullName;

        Assert.Equal(Sddl(reference), Sddl(created));
        ProtectedDirectory.Verify(reference);
        TestContext.Current.TestOutputHelper?.WriteLine(Sddl(created));
    }

    [Fact]
    public void ChildrenInheritExactlyTheThreeRules()
    {
        var created = ProtectedDirectory.Create(Path.Combine(Scratch.Directory("foundry-acl-child-").FullName, "created")).FullName;
        var file = Path.Combine(created, "credential.bin");
        File.WriteAllBytes(file, [1]);
        var rules = new FileInfo(file).GetAccessControl().GetAccessRules(includeExplicit: true, includeInherited: true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>().ToList();
        Assert.Equal(3, rules.Count);
        Assert.All(rules, rule => Assert.True(rule.IsInherited && rule.AccessControlType == AccessControlType.Allow && rule.FileSystemRights == FileSystemRights.FullControl));
        Assert.Equal(
            new[] { CurrentUser(), new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null) }.Select(sid => sid.Value).Order(StringComparer.Ordinal),
            rules.Select(rule => rule.IdentityReference.Value).Order(StringComparer.Ordinal));
    }

    [Fact]
    public void AnExistingDirectoryIsRefused()
    {
        var existing = Scratch.Directory("foundry-acl-existing-").FullName;
        Assert.Throws<IOException>(() => ProtectedDirectory.Create(existing));
        Assert.Throws<UnauthorizedAccessException>(() => ProtectedDirectory.Verify(existing));
    }

    [Fact]
    public void AnExtraRuleFailsVerification()
    {
        var created = new DirectoryInfo(ProtectedDirectory.Create(Path.Combine(Scratch.Directory("foundry-acl-extra-").FullName, "created")).FullName);
        var security = created.GetAccessControl();
        security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null), FileSystemRights.Read, AccessControlType.Allow));
        created.SetAccessControl(security);
        Assert.Throws<UnauthorizedAccessException>(() => ProtectedDirectory.Verify(created.FullName));
    }

    [Fact]
    public void AnUninheritedRuleFailsVerification()
    {
        var created = new DirectoryInfo(ProtectedDirectory.Create(Path.Combine(Scratch.Directory("foundry-acl-flags-").FullName, "created")).FullName);
        var security = created.GetAccessControl();
        security.RemoveAccessRuleAll(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, AccessControlType.Allow));
        created.SetAccessControl(security);
        Assert.Throws<UnauthorizedAccessException>(() => ProtectedDirectory.Verify(created.FullName));
    }

    [Fact]
    public void ADenyRuleFailsVerification()
    {
        var created = new DirectoryInfo(ProtectedDirectory.Create(Path.Combine(Scratch.Directory("foundry-acl-deny-").FullName, "created")).FullName);
        var security = created.GetAccessControl();
        security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null), FileSystemRights.Write, AccessControlType.Deny));
        created.SetAccessControl(security);
        Assert.Throws<UnauthorizedAccessException>(() => ProtectedDirectory.Verify(created.FullName));
    }

    [Fact]
    public void AnUnprotectedDaclFailsVerification()
    {
        var created = new DirectoryInfo(ProtectedDirectory.Create(Path.Combine(Scratch.Directory("foundry-acl-open-").FullName, "created")).FullName);
        var security = created.GetAccessControl();
        security.SetAccessRuleProtection(isProtected: false, preserveInheritance: true);
        created.SetAccessControl(security);
        Assert.Throws<UnauthorizedAccessException>(() => ProtectedDirectory.Verify(created.FullName));
    }

    [Fact]
    public async Task AJunctionToAProtectedDirectoryFailsVerification()
    {
        var scratch = Scratch.Directory("foundry-acl-junction-").FullName;
        var created = ProtectedDirectory.Create(Path.Combine(scratch, "created")).FullName;
        var link = Path.Combine(scratch, "link");
        var comspec = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
        await Scratch.Run(comspec, $"\"{comspec}\" /d /c mklink /J \"{link}\" \"{created}\"", scratch, Scratch.Environment(scratch));
        Assert.Throws<UnauthorizedAccessException>(() => ProtectedDirectory.Verify(link));
    }

    /// <summary>Runs the exact script from backup-protection.ts with the environment it passes.</summary>
    private static async Task RunTypeScriptProtection(string directory)
    {
        var source = await File.ReadAllTextAsync(Path.Combine(Scratch.RepositoryRoot, "packages", "runtime", "src", "backup-protection.ts"), TestContext.Current.CancellationToken);
        var script = RestrictAndVerify().Match(source);
        Assert.True(script.Success, "restrictAndVerify was not found in backup-protection.ts.");
        var systemRoot = Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows";
        var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["SystemRoot"] = systemRoot,
            ["WINDIR"] = systemRoot,
            ["FOUNDRY_BACKUP_DIRECTORY"] = directory,
        };
        await Scratch.Run(Scratch.PowerShell, Scratch.EncodedCommand(script.Groups[1].Value), directory, environment);
    }

    private static string Sddl(string directory) => new DirectoryInfo(directory).GetAccessControl().GetSecurityDescriptorSddlForm(OwnerGroupAndAccess);

    private static SecurityIdentifier CurrentUser()
    {
        using var identity = WindowsIdentity.GetCurrent();
        return identity.User!;
    }

    [GeneratedRegex(@"const restrictAndVerify = String\.raw`([^`]*)`;")]
    private static partial Regex RestrictAndVerify();
}
