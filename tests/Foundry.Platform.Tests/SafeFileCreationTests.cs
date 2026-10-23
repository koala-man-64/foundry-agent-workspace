using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Xunit;

namespace Foundry.Platform.Tests;

public sealed class SafeFileCreationTests
{
    [Theory]
    [InlineData("")]
    [InlineData("hello\n")]
    [InlineData("雪🙂\n")]
    public void CreatesExactlyTheReviewedBytesAndRefusesReplay(string content)
    {
        var scratch = Scratch.Directory("foundry-create-content-").FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(scratch, "existing"));
            var creation = new SafeFileCreation();
            var identities = creation.Inspect(scratch, "existing/new.txt");
            Assert.All(identities, identity => Assert.Matches("^[a-f0-9]{16}:[a-f0-9]{32}$", identity));
            var bytes = Encoding.UTF8.GetBytes(content);
            var result = creation.Create(scratch, "existing/new.txt", identities, Convert.ToBase64String(bytes), Hash(bytes));
            Assert.Equal(("success", Hash(bytes), ""), (result.Outcome, result.Hash, result.Error));
            Assert.Equal(bytes, File.ReadAllBytes(Path.Combine(scratch, "existing/new.txt")));
            Assert.Equal("none", creation.Create(scratch, "existing/new.txt", identities, Convert.ToBase64String(bytes), Hash(bytes)).Outcome);
            Assert.Throws<IOException>(() => creation.Inspect(scratch, "existing/new.txt"));
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public void AdmitsExactlySixtyFourKiBUtf8AndRefusesAnyByteMoreOrInvalidContent()
    {
        var scratch = Scratch.Directory("foundry-create-limit-").FullName;
        try
        {
            var creation = new SafeFileCreation();
            var bytes = Encoding.UTF8.GetBytes(new string('é', 32768));
            var identities = creation.Inspect(scratch, "new.txt");
            Assert.Equal("success", creation.Create(scratch, "new.txt", identities, Convert.ToBase64String(bytes), Hash(bytes)).Outcome);
            foreach (var invalid in new[] { new byte[65537], new byte[] { 0xc0, 0xaf }, new byte[] { 0 }, new byte[] { 0xff } })
            {
                Assert.Equal("none", creation.Create(scratch, "invalid.txt", identities, Convert.ToBase64String(invalid), Hash(invalid)).Outcome);
                Assert.False(File.Exists(Path.Combine(scratch, "invalid.txt")));
            }
            Assert.Equal("none", creation.Create(scratch, "invalid.txt", identities, "YQ==", new string('0', 64)).Outcome);
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Theory]
    [InlineData("../escape.txt")]
    [InlineData("C:/absolute.txt")]
    [InlineData("/absolute.txt")]
    [InlineData("x//file.txt")]
    [InlineData(".git/config")]
    [InlineData(".env")]
    [InlineData(".ssh/key.txt")]
    [InlineData("file.txt:stream")]
    [InlineData("CON.txt")]
    [InlineData("space /file.txt")]
    [InlineData("trailing.")]
    [InlineData("x\0.txt")]
    public void RefusesProtectedOrAmbiguousNamesBeforeMutation(string relative)
    {
        var creation = new SafeFileCreation();
        Assert.Throws<IOException>(() => creation.Inspect("C:\\unused", relative));
        Assert.Equal("none", creation.Create("C:\\unused", relative, [], "", Hash([])).Outcome);
    }

    [Fact]
    public void RefusesMissingParentsAndEveryExistingTerminalWithoutOverwriting()
    {
        var scratch = Scratch.Directory("foundry-create-collision-").FullName;
        try
        {
            var creation = new SafeFileCreation();
            Assert.ThrowsAny<IOException>(() => creation.Inspect(scratch, "missing/new.txt"));
            Assert.False(Directory.Exists(Path.Combine(scratch, "missing")));
            var identities = creation.Inspect(scratch, "new.txt");
            File.WriteAllText(Path.Combine(scratch, "new.txt"), "someone else's file");
            Assert.Equal("none", creation.Create(scratch, "new.txt", identities, "", Hash([])).Outcome);
            Assert.Equal("someone else's file", File.ReadAllText(Path.Combine(scratch, "new.txt")));
            Directory.CreateDirectory(Path.Combine(scratch, "directory"));
            Assert.Equal("none", creation.Create(scratch, "directory", identities, "", Hash([])).Outcome);
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public void OrdinaryWindowsCaseAliasesCannotCreateASecondEntryOrBypassCollision()
    {
        var scratch = Scratch.Directory("foundry-create-case-").FullName;
        try
        {
            var parent = Directory.CreateDirectory(Path.Combine(scratch, "parent")).FullName;
            var creation = new SafeFileCreation();
            var identities = creation.Inspect(scratch, "parent/new.txt");
            Assert.Equal(identities, creation.Inspect(scratch, "PARENT/new.txt"));
            File.WriteAllText(Path.Combine(parent, "FILE.TXT"), "unchanged");
            Assert.Equal("none", creation.Create(scratch, "parent/file.txt", identities, "", Hash([])).Outcome);
            Assert.Equal("unchanged", File.ReadAllText(Path.Combine(parent, "FILE.TXT")));
            Assert.Single(Directory.GetFiles(parent));
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task CaseSensitiveSiblingParentsKeepDistinctReviewedIdentities()
    {
        var scratch = Scratch.Directory("foundry-create-sensitive-").FullName;
        try
        {
            var sensitive = Directory.CreateDirectory(Path.Combine(scratch, "sensitive")).FullName;
            var info = new System.Diagnostics.ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "fsutil.exe"))
            {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
            };
            foreach (var argument in new[] { "file", "setCaseSensitiveInfo", sensitive, "enable" }) info.ArgumentList.Add(argument);
            using (var process = System.Diagnostics.Process.Start(info)!)
            {
                var output = process.StandardOutput.ReadToEndAsync(TestContext.Current.CancellationToken);
                var error = process.StandardError.ReadToEndAsync(TestContext.Current.CancellationToken);
                await process.WaitForExitAsync(TestContext.Current.CancellationToken);
                var detail = (await output) + (await error);
                if (process.ExitCode != 0) Assert.Skip($"fsutil cannot enable per-directory case sensitivity here (exit {process.ExitCode}): {detail.Trim()}");
            }
            Directory.CreateDirectory(Path.Combine(sensitive, "Foo"));
            Directory.CreateDirectory(Path.Combine(sensitive, "foo"));
            var creation = new SafeFileCreation();
            var upper = creation.Inspect(scratch, "sensitive/Foo/new.txt");
            var lower = creation.Inspect(scratch, "sensitive/foo/new.txt");
            Assert.NotEqual(upper[^1], lower[^1]);
            Assert.Equal("none", creation.Create(scratch, "sensitive/foo/new.txt", upper, "", Hash([])).Outcome);
            Assert.False(File.Exists(Path.Combine(sensitive, "Foo/new.txt")));
            Assert.False(File.Exists(Path.Combine(sensitive, "foo/new.txt")));
            Assert.Equal("success", creation.Create(scratch, "sensitive/Foo/new.txt", upper, "", Hash([])).Outcome);
            Assert.Equal("success", creation.Create(scratch, "sensitive/foo/new.txt", lower, "", Hash([])).Outcome);
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public void ShortAliasOfProtectedRelativeParentIsRefusedByItsCanonicalName()
    {
        var scratch = Scratch.Directory("foundry-create-short-secret-").FullName;
        try
        {
            var parent = Directory.CreateDirectory(Path.Combine(scratch, "credentials.superlong")).FullName;
            var buffer = new char[32768];
            var length = GetShortPathName(parent, buffer, (uint)buffer.Length);
            if (length == 0 || length >= buffer.Length) Assert.Skip($"An 8.3 spelling is unavailable on this volume (Win32 {Marshal.GetLastWin32Error()}).");
            var shortName = Path.GetFileName(new string(buffer, 0, (int)length));
            if (string.Equals(shortName, Path.GetFileName(parent), StringComparison.OrdinalIgnoreCase)) Assert.Skip("This volume does not generate 8.3 names for the protected parent fixture.");
            var creation = new SafeFileCreation();
            var refusal = Assert.Throws<IOException>(() => creation.Inspect(scratch, shortName + "/new.txt"));
            Assert.Equal("Path contains a forbidden segment.", refusal.Message);
            string[] identities;
            using (var lease = DirectoryLease.AcquireExisting(parent))
                identities = lease.Identities().Select(identity => identity.Volume.ToString("x16", System.Globalization.CultureInfo.InvariantCulture)
                    + ":" + identity.File.ToString("x32", System.Globalization.CultureInfo.InvariantCulture)).ToArray();
            var result = creation.Create(scratch, shortName + "/new.txt", identities, "", Hash([]));
            Assert.Equal(("none", "Path contains a forbidden segment."), (result.Outcome, result.Error));
            Assert.False(File.Exists(Path.Combine(parent, "new.txt")));
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public void AbsoluteRootAncestorsUseSyntaxChecksWhileRelativeNamesUseSecretPolicy()
    {
        var scratch = Scratch.Directory("foundry-create-root-policy-").FullName;
        try
        {
            var root = Directory.CreateDirectory(Path.Combine(scratch, ".env", "repo")).FullName;
            var creation = new SafeFileCreation();
            var identities = creation.Inspect(root, "new.txt");
            Assert.Equal("success", creation.Create(root, "new.txt", identities, "", Hash([])).Outcome);
            Assert.Throws<IOException>(() => creation.Inspect(root, ".env"));
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public void ChangedParentIdentityRefusesBeforeCreation()
    {
        var scratch = Scratch.Directory("foundry-create-parent-change-").FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(scratch, "parent"));
            var creation = new SafeFileCreation();
            var identities = creation.Inspect(scratch, "parent/new.txt");
            Directory.Move(Path.Combine(scratch, "parent"), Path.Combine(scratch, "old"));
            Directory.CreateDirectory(Path.Combine(scratch, "parent"));
            Assert.Equal("none", creation.Create(scratch, "parent/new.txt", identities, "", Hash([])).Outcome);
            Assert.False(File.Exists(Path.Combine(scratch, "parent/new.txt")));
            Assert.False(File.Exists(Path.Combine(scratch, "old/new.txt")));
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public void PinnedParentsAndNewFileRefuseConcurrentWritersRenamesAndDeletes()
    {
        var scratch = Scratch.Directory("foundry-create-pins-").FullName;
        try
        {
            var parent = Directory.CreateDirectory(Path.Combine(scratch, "parent")).FullName;
            var target = Path.Combine(parent, "new.txt");
            var identities = new SafeFileCreation().Inspect(scratch, "parent/new.txt");
            var stages = new List<string>();
            var creation = new SafeFileCreation(stage =>
            {
                stages.Add(stage);
                if (stage == "pinned") Assert.Throws<IOException>(() => Directory.Move(parent, Path.Combine(scratch, "moved")));
                if (stage == "created")
                {
                    Assert.Throws<IOException>(() => { using var writer = new FileStream(target, FileMode.Open, FileAccess.Write, FileShare.ReadWrite); });
                    Assert.Throws<IOException>(() => File.Move(target, Path.Combine(parent, "moved.txt")));
                    Assert.Throws<IOException>(() => File.Delete(target));
                    Assert.False(CreateHardLink(Path.Combine(scratch, "raced-hardlink.txt"), target, IntPtr.Zero));
                }
            });
            Assert.Equal("success", creation.Create(scratch, "parent/new.txt", identities, "", Hash([])).Outcome);
            Assert.Equal(["root-opened", "pinned", "created", "written"], stages);
            File.WriteAllText(target, "released");
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Theory]
    [InlineData("root-opened", "none", false)]
    [InlineData("pinned", "none", false)]
    [InlineData("created", "unknown", true)]
    [InlineData("written", "unknown", true)]
    public void FailuresAfterSuccessfulCreateAreUnknownEvenForEmptyFiles(string boundary, string outcome, bool exists)
    {
        var scratch = Scratch.Directory("foundry-create-outcome-").FullName;
        try
        {
            var identities = new SafeFileCreation().Inspect(scratch, "new.txt");
            var creation = new SafeFileCreation(stage => { if (stage == boundary) throw new IOException("injected"); });
            Assert.Equal(outcome, creation.Create(scratch, "new.txt", identities, "", Hash([])).Outcome);
            Assert.Equal(exists, File.Exists(Path.Combine(scratch, "new.txt")));
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public async Task ParentJunctionsAndTerminalLinksAreRefusedWithoutTouchingTargets()
    {
        var scratch = Scratch.Directory("foundry-create-links-").FullName;
        var junction = Path.Combine(scratch, "link");
        try
        {
            var outside = Directory.CreateDirectory(Path.Combine(scratch, "outside")).FullName;
            var command = Environment.GetEnvironmentVariable("ComSpec")!;
            await Scratch.Run(command, $"\"{command}\" /d /c mklink /J \"{junction}\" \"{outside}\"", scratch, Scratch.Environment(scratch));
            var creation = new SafeFileCreation();
            Assert.Throws<IOException>(() => creation.Inspect(scratch, "link/new.txt"));
            var identities = creation.Inspect(scratch, "new.txt");
            Assert.Equal("none", creation.Create(scratch, "link", identities, "", Hash([])).Outcome);
            Assert.False(File.Exists(Path.Combine(outside, "new.txt")));
        }
        finally { if (Directory.Exists(junction)) Directory.Delete(junction); Directory.Delete(scratch, true); }
    }

    [Fact]
    public void ExistingHardLinksAreNeverOpenedOrOverwritten()
    {
        var scratch = Scratch.Directory("foundry-create-hardlink-").FullName;
        try
        {
            var creation = new SafeFileCreation();
            var identities = creation.Inspect(scratch, "new.txt");
            var original = Path.Combine(scratch, "original.txt");
            File.WriteAllText(original, "unchanged");
            Assert.True(CreateHardLink(Path.Combine(scratch, "new.txt"), original, IntPtr.Zero));
            Assert.Equal("none", creation.Create(scratch, "new.txt", identities, "", Hash([])).Outcome);
            Assert.Equal("unchanged", File.ReadAllText(original));
        }
        finally { Directory.Delete(scratch, true); }
    }

    [Fact]
    public void DriveAliasChangeAfterAnchorCannotRedirectCreation()
    {
        var scratch = Scratch.Directory("foundry-create-drive-alias-").FullName;
        var first = Directory.CreateDirectory(Path.Combine(scratch, "first")).FullName;
        var second = Directory.CreateDirectory(Path.Combine(scratch, "second")).FullName;
        Directory.CreateDirectory(Path.Combine(first, "repo"));
        Directory.CreateDirectory(Path.Combine(second, "repo"));
        var occupied = DriveInfo.GetDrives().Select(drive => char.ToUpperInvariant(drive.Name[0])).ToHashSet();
        var letter = Enumerable.Range('D', 'Z' - 'D' + 1).Select(value => (char)value).Last(value => !occupied.Contains(value));
        var alias = $"{letter}:";
        var firstTarget = @"\??\" + first;
        var secondTarget = @"\??\" + second;
        var defined = false; var redirected = false;
        try
        {
            Assert.True(DefineDosDevice(1 | 8, alias, firstTarget)); defined = true;
            var root = alias + @"\repo";
            var identities = new SafeFileCreation().Inspect(root, "new.txt");
            var creation = new SafeFileCreation(stage =>
            {
                if (stage == "root-opened") { Assert.True(DefineDosDevice(1 | 8, alias, secondTarget)); redirected = true; }
            });
            Assert.Equal("success", creation.Create(root, "new.txt", identities, "", Hash([])).Outcome);
            Assert.True(File.Exists(Path.Combine(first, "repo/new.txt")));
            Assert.False(File.Exists(Path.Combine(second, "repo/new.txt")));
        }
        finally
        {
            if (redirected) Assert.True(DefineDosDevice(1 | 2 | 4 | 8, alias, secondTarget));
            if (defined) Assert.True(DefineDosDevice(1 | 2 | 4 | 8, alias, firstTarget));
            Directory.Delete(scratch, true);
        }
    }

    [Fact]
    public async Task SharedSourceCompilesUnchangedWithWindowsPowerShell()
    {
        var scratch = Scratch.Directory("foundry-create-addtype-").FullName;
        try
        {
            var environment = Scratch.Environment(scratch);
            environment["FOUNDRY_CREATION_SOURCE"] = Path.Combine(Scratch.RepositoryRoot, "src/Foundry.Platform/SafeFileCreation.cs");
            const string script = "Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:FOUNDRY_CREATION_SOURCE)) -Language CSharp -ErrorAction Stop; [Foundry.Platform.SafeFileCreation]::new() | Out-Null; [Console]::Write('compiled')";
            var output = await Scratch.Run(Scratch.PowerShell, $"\"{Scratch.PowerShell}\" -NoLogo -NoProfile -NonInteractive -EncodedCommand {Convert.ToBase64String(Encoding.Unicode.GetBytes(script))}", scratch, environment);
            Assert.Equal("compiled", output);
        }
        finally { Directory.Delete(scratch, true); }
    }

    private static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
    [DllImport("kernel32.dll", EntryPoint = "DefineDosDeviceW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool DefineDosDevice(uint flags, string name, string target);
    [DllImport("kernel32.dll", EntryPoint = "CreateHardLinkW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CreateHardLink(string link, string existing, IntPtr security);
    [DllImport("kernel32.dll", EntryPoint = "GetShortPathNameW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern uint GetShortPathName(string path, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] char[] shortPath, uint length);
}
