using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;

namespace Foundry.Platform;

/// <summary>
/// A directory only the current user, SYSTEM and Administrators can open: the same descriptor and verification as
/// packages/runtime/src/backup-protection.ts, applied at creation rather than afterwards, with no PowerShell process.
/// </summary>
public static class ProtectedDirectory
{
    private const InheritanceFlags ChildrenInherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
    private static readonly SecurityIdentifier LocalSystem = new(WellKnownSidType.LocalSystemSid, null);
    private static readonly SecurityIdentifier Administrators = new(WellKnownSidType.BuiltinAdministratorsSid, null);

    /// <summary>O:owner, protected DACL, full control for owner, SYSTEM and Administrators, inherited by children.</summary>
    public static string Descriptor(SecurityIdentifier owner)
    {
        ArgumentNullException.ThrowIfNull(owner);
        return $"O:{owner.Value}D:P(A;OICI;FA;;;{owner.Value})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";
    }

    /// <summary>
    /// Create a new directory with the descriptor in the same CreateDirectoryW call, so it never exists with inherited
    /// access and no handle opened under inherited access can outlive the change, then verify it. An existing directory
    /// is an error: its history is unknown.
    /// </summary>
    public static unsafe DirectoryInfo Create(string path)
    {
        var owner = CurrentUser();
        var fullPath = Path.GetFullPath(path);
        var security = new DirectorySecurity();
        security.SetSecurityDescriptorSddlForm(Descriptor(owner));
        var descriptor = security.GetSecurityDescriptorBinaryForm();
        fixed (byte* binary = descriptor)
        fixed (char* name = fullPath)
        {
            var attributes = new Native.SecurityAttributes { Length = (uint)sizeof(Native.SecurityAttributes), SecurityDescriptor = binary };
            if (!Native.CreateDirectory(name, &attributes))
            {
                throw new IOException($"Protected directory {fullPath} could not be created.", new Win32Exception(Marshal.GetLastPInvokeError()));
            }
        }
        var directory = new DirectoryInfo(fullPath);
        try
        {
            // Writing the same DACL once more through the inheritance-aware API sets the auto-inherited flag (D:PAI),
            // which CreateDirectoryW never sets: the on-disk state then equals what Set-Acl leaves.
            directory.SetAccessControl(AccessOnly(owner));
            Verify(fullPath);
            return directory;
        }
        catch
        {
            // Nothing can be inside yet; removing the empty directory lets a retry create it afresh. The failure to
            // report is the original one.
            try
            {
                Directory.Delete(fullPath, recursive: false);
            }
            catch (Exception cleanup) when (cleanup is IOException or UnauthorizedAccessException)
            {
            }
            throw;
        }
    }

    /// <summary>The descriptor's three rules as an access-only change, so persisting it writes the DACL and nothing else
    /// (an SDDL-built object would also write the SACL, which needs SeSecurityPrivilege).</summary>
    private static DirectorySecurity AccessOnly(SecurityIdentifier owner)
    {
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        foreach (var sid in new[] { owner, LocalSystem, Administrators })
        {
            security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, ChildrenInherit, PropagationFlags.None, AccessControlType.Allow));
        }
        return security;
    }

    /// <summary>The checks backup-protection.ts runs after writing the ACL (protected, owned, exactly the three rules,
    /// inherited by children), plus: a real directory, not a reparse point that leads elsewhere.</summary>
    public static void Verify(string path)
    {
        var owner = CurrentUser();
        var directory = new DirectoryInfo(path);
        if (!directory.Exists || directory.Attributes.HasFlag(FileAttributes.ReparsePoint))
        {
            throw new UnauthorizedAccessException($"{path} is not a real directory.");
        }
        var actual = directory.GetAccessControl();
        var rules = actual.GetAccessRules(includeExplicit: true, includeInherited: true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>().ToList();
        if (!actual.AreAccessRulesProtected || actual.GetOwner(typeof(SecurityIdentifier)) is not SecurityIdentifier actualOwner || actualOwner != owner || rules.Count != 3)
        {
            throw new UnauthorizedAccessException($"Protection or owner verification failed for {path}.");
        }
        SecurityIdentifier[] allowed = [owner, LocalSystem, Administrators];
        foreach (var rule in rules)
        {
            if (rule.IdentityReference is not SecurityIdentifier sid || !allowed.Contains(sid) || rule.AccessControlType != AccessControlType.Allow
                || rule.FileSystemRights != FileSystemRights.FullControl || rule.IsInherited || rule.InheritanceFlags != ChildrenInherit
                || rule.PropagationFlags != PropagationFlags.None)
            {
                throw new UnauthorizedAccessException($"Unexpected access rule on {path}.");
            }
        }
        foreach (var sid in allowed)
        {
            if (rules.Count(rule => (SecurityIdentifier)rule.IdentityReference == sid) != 1)
            {
                throw new UnauthorizedAccessException($"A required access rule is missing on {path}.");
            }
        }
    }

    private static SecurityIdentifier CurrentUser()
    {
        using var identity = WindowsIdentity.GetCurrent();
        return identity.User ?? throw new InvalidOperationException("The current Windows user has no security identifier.");
    }
}
