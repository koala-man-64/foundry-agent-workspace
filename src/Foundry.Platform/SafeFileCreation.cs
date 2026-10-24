// Shared verbatim with Windows PowerShell 5.1 Add-Type. Keep this file self-contained, safe managed C# 5.
#pragma warning disable 1691
#pragma warning disable 0649, 8600, 8601, 8602, 8603, 8618, 8625
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

namespace Foundry.Platform
{
    /// <summary>Creates one reviewed UTF-8 file beneath existing directories, using only handle-relative opens after
    /// anchoring the drive. It never creates directories, follows reparse points, replaces entries or cleans up unknown
    /// outcomes. This executes with the caller's Windows privileges; it is not a filesystem sandbox.</summary>
    public sealed class SafeFileCreation
    {
        private const int MaximumBytes = 65536;
        private const uint ReadAttributes = 0x80, Synchronize = 0x100000;
        private const uint OpenReparsePoint = 0x200000, SynchronousIo = 0x20, NonDirectory = 0x40;
        private const uint FileOpen = 1, FileCreate = 2;
        private readonly Action<string> stage;
        private static readonly Regex HashPattern = new Regex(@"\A[a-f0-9]{64}\z", RegexOptions.CultureInvariant);
        private static readonly Regex SecretName = new Regex(@"\A(?:\.env(?:\.[^\n\r\u2028\u2029]*)?|\.envrc|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.terraformrc|\.(?:ssh|aws|azure|kube|docker|gnupg)|id_(?:rsa|dsa|ecdsa|ed25519)|credentials?(?:\.[^\n\r\u2028\u2029]*)?|secrets?(?:\.[^\n\r\u2028\u2029]*)?|[^\n\r\u2028\u2029]*\.(?:pem|key|p12|pfx))\z", RegexOptions.CultureInvariant);
        private static readonly Regex DeviceName = new Regex(@"\A(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$|clock\$)(?:\.[^\n\r\u2028\u2029]*)?\z", RegexOptions.CultureInvariant);

        public SafeFileCreation() : this(delegate(string ignored) { }) { }
        [System.Diagnostics.CodeAnalysis.SuppressMessage("Maintainability", "CA1507", Justification = "This source also compiles with the C# 5 Windows PowerShell compiler, which has no nameof.")]
        [System.Diagnostics.CodeAnalysis.SuppressMessage("Maintainability", "CA1510", Justification = "Windows PowerShell uses .NET Framework, which has no ThrowIfNull.")]
        public SafeFileCreation(Action<string> stage)
        {
            if (stage == null) throw new ArgumentNullException("stage");
            this.stage = stage;
        }

        public sealed class Result
        {
            public string Outcome { get; private set; }
            public string Hash { get; private set; }
            public string Error { get; private set; }
            internal Result(string outcome, string hash, string error) { Outcome = outcome; Hash = hash; Error = error; }
        }

        /// <summary>Returns the anchored drive identity followed by every root and relative parent identity. Only a
        /// definitely missing terminal entry qualifies; all other failures refuse without mutation.</summary>
        public string[] Inspect(string root, string relativePath)
        {
            string[] rootParts, parts;
            string drive = ValidatePaths(root, relativePath, out rootParts, out parts);
            using (PinnedParents parents = Pin(drive, rootParts, parts))
            {
                AssertMissing(parents.Last, parts[parts.Length - 1]);
                return parents.Identities.ToArray();
            }
        }

        /// <summary>The caller durably records execution before calling. Once FILE_CREATE succeeds, including for empty
        /// content, any failure is unknown; no file is deleted and the operation is never automatically retried.</summary>
        public Result Create(string root, string relativePath, string[] expectedIdentities, string contentBase64, string expectedHash)
        {
            bool created = false;
            try
            {
                byte[] bytes = ValidateContent(contentBase64, expectedHash);
                string[] rootParts, parts;
                string drive = ValidatePaths(root, relativePath, out rootParts, out parts);
                if (expectedIdentities == null) throw new IOException("Reviewed directory identity is required.");
                using (PinnedParents parents = Pin(drive, rootParts, parts))
                {
                    if (parents.Identities.Count != expectedIdentities.Length) throw new IOException("Directory identity changed since review.");
                    for (int index = 0; index < expectedIdentities.Length; index++)
                        if (!String.Equals(parents.Identities[index], expectedIdentities[index], StringComparison.Ordinal))
                            throw new IOException("Directory identity changed since review.");
                    // FILE_CREATE atomically refuses every existing terminal entry, including a link or directory.
                    using (SafeFileHandle file = OpenRelative(parents.Last, parts[parts.Length - 1], 3 | ReadAttributes | Synchronize,
                        0, FileCreate, NonDirectory | OpenReparsePoint | SynchronousIo, ref created))
                    {
                        CheckRegular(file);
                        stage("created");
                        using (FileStream stream = new FileStream(file, FileAccess.ReadWrite, 4096, false))
                        {
                            stream.Write(bytes, 0, bytes.Length);
                            stream.Flush(true);
                            stage("written");
                            CheckRegular(file);
                            stream.Position = 0;
                            byte[] observed = new byte[bytes.Length + 1];
                            int total = 0;
                            while (total < observed.Length)
                            {
                                int count = stream.Read(observed, total, observed.Length - total);
                                if (count == 0) break;
                                total += count;
                            }
                            if (total != bytes.Length || !String.Equals(Hash(observed, total), expectedHash, StringComparison.Ordinal))
                                throw new IOException("Created file verification failed; inspect the retained operation.");
                            return new Result("success", expectedHash, "");
                        }
                    }
                }
            }
            catch (Exception error) { return new Result(created ? "unknown" : "none", "", error.Message); }
        }

        private static byte[] ValidateContent(string base64, string expectedHash)
        {
            if (base64 == null || base64.Length > 87384 || expectedHash == null || !HashPattern.IsMatch(expectedHash))
                throw new IOException("File creation content or hash is invalid.");
            byte[] bytes = Convert.FromBase64String(base64);
            if (bytes.Length > MaximumBytes) throw new IOException("Edits must be UTF-8 text of at most 64 KB.");
            new UTF8Encoding(false, true).GetString(bytes);
            if (Array.IndexOf(bytes, (byte)0) >= 0) throw new IOException("Edits must be UTF-8 text of at most 64 KB.");
            if (!String.Equals(Hash(bytes, bytes.Length), expectedHash, StringComparison.Ordinal)) throw new IOException("File creation hash does not match the reviewed content.");
            return bytes;
        }

        [System.Diagnostics.CodeAnalysis.SuppressMessage("Performance", "CA1850", Justification = "The shared Windows PowerShell .NET Framework source has no static SHA256.HashData API.")]
        private static string Hash(byte[] bytes, int count)
        {
            using (SHA256 sha = SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(bytes, 0, count);
                const string digits = "0123456789abcdef";
                char[] text = new char[hash.Length * 2];
                for (int index = 0; index < hash.Length; index++) { text[index * 2] = digits[hash[index] >> 4]; text[index * 2 + 1] = digits[hash[index] & 15]; }
                return new string(text);
            }
        }

        private static string ValidatePaths(string root, string relative, out string[] rootParts, out string[] parts)
        {
            if (root == null || root.Length < 3 || root.Length > 4096 || !AsciiLetter(root[0]) || root[1] != ':' || (root[2] != '\\' && root[2] != '/'))
                throw new IOException("A local drive-absolute repository root is required.");
            string normalized = root.Replace('/', '\\');
            string suffix = normalized.Substring(3).TrimEnd('\\');
            rootParts = suffix.Length == 0 ? Array.Empty<string>() : suffix.Split('\\');
            if (relative == null || relative.Length == 0 || relative.Length > 4096) throw new IOException("A bounded relative file path is required.");
            parts = relative.Replace('\\', '/').Split('/');
            foreach (string part in rootParts) ValidateSyntax(part);
            foreach (string part in parts) ValidatePart(part);
            return normalized.Substring(0, 3);
        }

        private static bool AsciiLetter(char value) { return value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z'; }
        private static void ValidateSyntax(string part)
        {
            if (part.Length == 0 || part == "." || part == ".." || part[part.Length - 1] == '.' || part[part.Length - 1] == ' ')
                throw new IOException("Path contains a forbidden segment.");
            foreach (char value in part)
                if (value < 32 || value == ':' || value == '<' || value == '>' || value == '"' || value == '|' || value == '?' || value == '*' || value == '/' || value == '\\')
                    throw new IOException("Path contains a forbidden segment.");
        }
        private static void ValidatePart(string part)
        {
            ValidateSyntax(part);
            char[] lower = part.ToCharArray();
            for (int index = 0; index < lower.Length; index++) if (lower[index] >= 'A' && lower[index] <= 'Z') lower[index] = (char)(lower[index] + 32);
            string name = new string(lower);
            if (name == ".git" || SecretName.IsMatch(name) || DeviceName.IsMatch(name)) throw new IOException("Path contains a forbidden segment.");
        }

        private sealed class PinnedParents : IDisposable
        {
            internal readonly List<SafeFileHandle> Handles = new List<SafeFileHandle>();
            internal readonly List<string> Identities = new List<string>();
            internal SafeFileHandle Last { get { return Handles[Handles.Count - 1]; } }
            public void Dispose() { for (int index = Handles.Count - 1; index >= 0; index--) Handles[index].Dispose(); }
            internal void Add(SafeFileHandle handle, bool enforceNamePolicy)
            {
                Handles.Add(handle);
                FileInformation information = Information(handle);
                if ((information.Attributes & 0x400) != 0 || (information.Attributes & 0x10) == 0)
                    throw new IOException("Only existing non-reparse directories are available for file creation.");
                ValidateFinalNames(handle, enforceNamePolicy);
                FileIdInformation identity;
                if (!GetFileInformationByHandleEx(handle, 18, out identity, (uint)Marshal.SizeOf<FileIdInformation>()))
                    throw new IOException("Directory identity cannot be established.");
                Identities.Add(identity.VolumeSerial.ToString("x16", CultureInfo.InvariantCulture) + ":" + identity.High.ToString("x16", CultureInfo.InvariantCulture) + identity.Low.ToString("x16", CultureInfo.InvariantCulture));
            }
        }

        private PinnedParents Pin(string drive, string[] rootParts, string[] parts)
        {
            // Reject network/unsupported drives before opening; verify the anchored volume again without a drive alias.
            uint type = GetDriveType(drive);
            if (type != 2 && type != 3) throw new IOException("File creation requires a local fixed or removable drive.");
            PinnedParents parents = new PinnedParents();
            try
            {
                SafeFileHandle anchor = CreateFile(@"\\?\" + drive, 1 | ReadAttributes | Synchronize, 1, IntPtr.Zero, 3, 0x02000000 | OpenReparsePoint, IntPtr.Zero);
                if (anchor.IsInvalid) { anchor.Dispose(); throw new IOException("Drive root cannot be opened safely."); }
                parents.Add(anchor, false);
                string actual = FinalName(anchor);
                int end = actual.IndexOf("}\\", StringComparison.Ordinal);
                if (!actual.StartsWith(@"\\?\Volume{", StringComparison.OrdinalIgnoreCase) || end < 0)
                    throw new IOException("Anchored drive identity cannot be established.");
                type = GetDriveType(actual.Substring(0, end + 2));
                if (type != 2 && type != 3) throw new IOException("File creation requires a local fixed or removable drive.");
                stage("root-opened");
                bool ignored = false;
                foreach (string part in rootParts)
                    parents.Add(OpenRelative(parents.Last, part, 1 | ReadAttributes | Synchronize, 1, FileOpen, OpenReparsePoint | SynchronousIo, ref ignored), false);
                for (int index = 0; index < parts.Length - 1; index++)
                    parents.Add(OpenRelative(parents.Last, parts[index], 1 | ReadAttributes | Synchronize, 1, FileOpen, OpenReparsePoint | SynchronousIo, ref ignored), true);
                stage("pinned");
                return parents;
            }
            catch { parents.Dispose(); throw; }
        }

        private static void AssertMissing(SafeFileHandle parent, string leaf)
        {
            bool ignored = false;
            try
            {
                using (OpenRelative(parent, leaf, ReadAttributes | Synchronize, 7, FileOpen, OpenReparsePoint | SynchronousIo, ref ignored)) { }
            }
            catch (NtOpenException error) { if (error.Status == unchecked((int)0xc0000034)) return; throw; }
            throw new IOException("Creation target already exists; request a new review.");
        }

        private static FileInformation Information(SafeFileHandle handle)
        {
            FileInformation information;
            if (!GetFileInformationByHandle(handle, out information)) throw new IOException("File identity cannot be established.");
            return information;
        }
        private static string FinalName(SafeFileHandle handle)
        {
            char[] name = new char[512];
            uint length = GetFinalPathNameByHandle(handle, name, (uint)name.Length, 1);
            if (length >= name.Length && length < 32768)
            {
                name = new char[(int)length + 1];
                length = GetFinalPathNameByHandle(handle, name, (uint)name.Length, 1);
            }
            if (length == 0 || length >= name.Length) throw new IOException("Canonical file identity cannot be established.");
            return new string(name, 0, (int)length);
        }
        private static void ValidateFinalNames(SafeFileHandle handle, bool enforceNamePolicy)
        {
            string final = FinalName(handle);
            int end = final.IndexOf("}\\", StringComparison.Ordinal);
            if (!final.StartsWith(@"\\?\Volume{", StringComparison.OrdinalIgnoreCase) || end < 0)
                throw new IOException("Only local volume paths are available for file creation.");
            string relative = final.Substring(end + 2).TrimEnd('\\');
            if (relative.Length != 0)
            {
                string[] parts = relative.Split('\\');
                foreach (string part in parts) ValidateSyntax(part);
                if (enforceNamePolicy) ValidatePart(parts[parts.Length - 1]);
            }
        }
        private static void CheckRegular(SafeFileHandle handle)
        {
            FileInformation information = Information(handle);
            if ((information.Attributes & (0x400 | 0x10 | 0x40)) != 0 || information.Links != 1)
                throw new IOException("Only an unlinked regular file can be created.");
            ValidateFinalNames(handle, true);
        }

        private sealed class NtOpenException : IOException
        {
            internal readonly int Status;
            internal NtOpenException(int status) : base("Handle-relative file access was refused.", new Win32Exception(unchecked((int)RtlNtStatusToDosError(status)))) { Status = status; }
        }

        private static SafeFileHandle OpenRelative(SafeFileHandle parent, string name, uint access, uint share, uint disposition, uint options, ref bool created)
        {
            IntPtr text = Marshal.StringToHGlobalUni(name);
            IntPtr unicode = IntPtr.Zero;
            bool added = false;
            try
            {
                UnicodeString value = new UnicodeString();
                value.Length = checked((ushort)(name.Length * 2)); value.MaximumLength = value.Length; value.Buffer = text;
                unicode = Marshal.AllocHGlobal(Marshal.SizeOf<UnicodeString>());
                Marshal.StructureToPtr(value, unicode, false);
                parent.DangerousAddRef(ref added);
                ObjectAttributes attributes = new ObjectAttributes();
                attributes.Length = (uint)Marshal.SizeOf<ObjectAttributes>(); attributes.RootDirectory = parent.DangerousGetHandle(); attributes.ObjectName = unicode;
                SafeFileHandle opened;
                IoStatusBlock statusBlock;
                // A lost managed/native return cannot prove that FILE_CREATE had no effect. Only a returned failure
                // status restores the known-unstarted outcome; successful creation includes an empty file.
                if (disposition == FileCreate) created = true;
                int status = NtCreateFile(out opened, access, ref attributes, out statusBlock, IntPtr.Zero, 0x80, share, disposition, options, IntPtr.Zero, 0);
                if (status < 0) { if (disposition == FileCreate) created = false; opened.Dispose(); throw new NtOpenException(status); }
                if (opened.IsInvalid) { opened.Dispose(); throw new IOException("Handle-relative file identity cannot be established."); }
                if (disposition == FileCreate && statusBlock.Information.ToUInt64() != 2)
                { opened.Dispose(); throw new IOException("File creation outcome cannot be established."); }
                return opened;
            }
            finally
            {
                if (added) parent.DangerousRelease();
                if (unicode != IntPtr.Zero) Marshal.FreeHGlobal(unicode);
                Marshal.FreeHGlobal(text);
            }
        }

        [StructLayout(LayoutKind.Sequential)] private struct UnicodeString { internal ushort Length, MaximumLength; internal IntPtr Buffer; }
        [StructLayout(LayoutKind.Sequential)] private struct ObjectAttributes { internal uint Length; internal IntPtr RootDirectory, ObjectName; internal uint Attributes; internal IntPtr SecurityDescriptor, SecurityQualityOfService; }
        [StructLayout(LayoutKind.Sequential)] private struct IoStatusBlock { internal IntPtr Status; internal UIntPtr Information; }
        [StructLayout(LayoutKind.Sequential)] private struct FileIdInformation { internal ulong VolumeSerial, Low, High; }
        [StructLayout(LayoutKind.Sequential)] private struct FileInformation
        {
            internal uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
            internal uint VolumeSerial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
        }

        [DllImport("ntdll.dll", ExactSpelling = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern int NtCreateFile(out SafeFileHandle handle, uint access, ref ObjectAttributes attributes, out IoStatusBlock status, IntPtr allocationSize, uint fileAttributes, uint share, uint disposition, uint options, IntPtr ea, uint eaLength);
        [DllImport("ntdll.dll", ExactSpelling = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern uint RtlNtStatusToDosError(int status);
        [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", EntryPoint = "GetDriveTypeW", CharSet = CharSet.Unicode, ExactSpelling = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern uint GetDriveType(string root);
        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation information);
        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int informationClass, out FileIdInformation information, uint size);
        [DllImport("kernel32.dll", EntryPoint = "GetFinalPathNameByHandleW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern uint GetFinalPathNameByHandle(SafeFileHandle file, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] char[] path, uint length, uint flags);
    }
}
