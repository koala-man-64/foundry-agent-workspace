$ErrorActionPreference = 'Stop'

# MCP stdio host. The spec file (path given as the only argument) names the server command; the
# server inherits this host's stdin/stdout pipes directly, so JSON-RPC traffic never passes through
# PowerShell. The host owns a kill-on-close Job Object, terminates the job on cancellation, parent
# runtime death or lifetime expiry, and writes a nonce-bearing result file once the job is verified empty.
if ($args.Count -ne 1) { throw 'MCP host requires exactly one spec path.' }
$spec = Get-Content -Raw -LiteralPath $args[0] | ConvertFrom-Json
if (-not $spec.nonce -or -not $spec.resultPath -or -not $spec.cancelPath -or -not $spec.command) { throw 'Invalid MCP host input.' }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public sealed class McpHostResult {
  public int? exitCode { get; set; }
  public bool cancelled { get; set; }
  public bool parentDied { get; set; }
  public bool lifetimeExpired { get; set; }
  public bool cleanupVerified { get; set; }
  public int processId { get; set; }
}

public static class McpHost {
  const uint CREATE_SUSPENDED = 0x00000004;
  const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  const uint CREATE_NO_WINDOW = 0x08000000;
  const uint STARTF_USESTDHANDLES = 0x00000100;
  const uint HANDLE_FLAG_INHERIT = 0x00000001;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  const uint INFINITE = 0xffffffff;
  const uint WAIT_OBJECT_0 = 0;
  const uint PROCESS_QUERY_INFORMATION = 0x0400;
  const uint SYNCHRONIZE = 0x00100000;
  const int STD_INPUT_HANDLE = -10;
  const int STD_OUTPUT_HANDLE = -11;
  const int STD_ERROR_HANDLE = -12;
  const int JobObjectExtendedLimitInformation = 9;
  const int JobObjectBasicAccountingInformation = 1;
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount; public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION { public long TotalUserTime; public long TotalKernelTime; public long ThisPeriodTotalUserTime; public long ThisPeriodTotalKernelTime; public uint TotalPageFaultCount; public uint TotalProcesses; public uint ActiveProcesses; public uint TotalTerminatedProcesses; }
  const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  const int PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app, StringBuilder commandLine, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr environment, string cwd, ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr attributeList, int attributeCount, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr attributeList, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnSize);
  [DllImport("kernel32.dll", SetLastError=true)] static extern void DeleteProcThreadAttributeList(IntPtr attributeList);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr sa, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, IntPtr returnedLength);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool value, string operation) { if (!value) throw new InvalidOperationException(operation + " failed: " + Marshal.GetLastWin32Error()); }
  static IntPtr Inheritable(int which) { IntPtr handle = GetStdHandle(which); if (handle == IntPtr.Zero || handle == new IntPtr(-1)) throw new InvalidOperationException("Standard handle " + which + " is unavailable."); Check(SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT), "SetHandleInformation"); return handle; }
  static IntPtr EnvironmentBlock(Dictionary<string,string> values) { var keys = new List<string>(values.Keys); keys.Sort(StringComparer.OrdinalIgnoreCase); var text = new StringBuilder(); foreach (var key in keys) text.Append(key).Append('=').Append(values[key]).Append('\0'); text.Append('\0'); return Marshal.StringToHGlobalUni(text.ToString()); }
  static bool JobEmpty(IntPtr job) { int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)); IntPtr memory = Marshal.AllocHGlobal(size); try { Check(QueryInformationJobObject(job, JobObjectBasicAccountingInformation, memory, (uint)size, IntPtr.Zero), "QueryInformationJobObject"); return Marshal.PtrToStructure<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>(memory).ActiveProcesses == 0; } finally { Marshal.FreeHGlobal(memory); } }
  static string Quote(string value) { if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value; var builder = new StringBuilder("\""); int backslashes = 0; foreach (char c in value) { if (c == '\\') { backslashes++; continue; } if (c == '"') { builder.Append('\\', backslashes * 2 + 1).Append('"'); backslashes = 0; continue; } builder.Append('\\', backslashes).Append(c); backslashes = 0; } builder.Append('\\', backslashes * 2).Append('"'); return builder.ToString(); }
  static IntPtr VerifiedParent(int pid, long startedAtMs) { IntPtr parent = OpenProcess(PROCESS_QUERY_INFORMATION | SYNCHRONIZE, false, pid); if (parent == IntPtr.Zero) throw new InvalidOperationException("Runtime parent " + pid + " is unavailable: " + Marshal.GetLastWin32Error()); long created, exited, kernel, user; Check(GetProcessTimes(parent, out created, out exited, out kernel, out user), "GetProcessTimes"); long observedMs = (created / 10000L) - 11644473600000L; if (Math.Abs(observedMs - startedAtMs) > 5000L) { CloseHandle(parent); throw new InvalidOperationException("Runtime parent identity changed."); } return parent; }
  public static McpHostResult Run(string command, string[] arguments, string cwd, Dictionary<string,string> environment, int lifetimeMs, string cancelPath, int parentPid, long parentStartedAtMs) {
    IntPtr job = IntPtr.Zero, parent = IntPtr.Zero, env = IntPtr.Zero, attributes = IntPtr.Zero, handleList = IntPtr.Zero;
    PROCESS_INFORMATION pi = new PROCESS_INFORMATION(); bool processCreated = false; bool assigned = false; bool normalEnd = false; bool attributesInitialized = false;
    try {
      parent = VerifiedParent(parentPid, parentStartedAtMs); job = CreateJobObject(IntPtr.Zero, null); if (job == IntPtr.Zero) throw new InvalidOperationException("CreateJobObject failed: " + Marshal.GetLastWin32Error());
      var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION(); limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      int limitsSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)); IntPtr limitsMemory = Marshal.AllocHGlobal(limitsSize); try { Marshal.StructureToPtr(limits, limitsMemory, false); Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, limitsMemory, (uint)limitsSize), "SetInformationJobObject"); } finally { Marshal.FreeHGlobal(limitsMemory); }
      IntPtr stdIn = Inheritable(STD_INPUT_HANDLE), stdOut = Inheritable(STD_OUTPUT_HANDLE), stdErr = Inheritable(STD_ERROR_HANDLE);
      // Restrict inheritance to exactly the three standard handles: nothing else open in this host reaches the server.
      IntPtr attributeSize = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
      attributes = Marshal.AllocHGlobal(attributeSize); Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref attributeSize), "InitializeProcThreadAttributeList"); attributesInitialized = true;
      var handles = new List<IntPtr>(); foreach (var handle in new[] { stdIn, stdOut, stdErr }) if (!handles.Contains(handle)) handles.Add(handle);
      handleList = Marshal.AllocHGlobal(IntPtr.Size * handles.Count); for (int i = 0; i < handles.Count; i++) Marshal.WriteIntPtr(handleList, i * IntPtr.Size, handles[i]);
      Check(UpdateProcThreadAttribute(attributes, 0, (IntPtr)PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handleList, (IntPtr)(IntPtr.Size * handles.Count), IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute");
      var startup = new STARTUPINFOEX { StartupInfo = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFOEX)), dwFlags = (int)STARTF_USESTDHANDLES, hStdInput = stdIn, hStdOutput = stdOut, hStdError = stdErr }, lpAttributeList = attributes };
      var line = new StringBuilder(Quote(command)); foreach (var argument in arguments) line.Append(' ').Append(Quote(argument));
      if (WaitForSingleObject(parent, 0) == WAIT_OBJECT_0) throw new InvalidOperationException("Runtime parent exited before server launch.");
      env = EnvironmentBlock(environment); Check(CreateProcess(command, line, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, env, cwd, ref startup, out pi), "CreateProcess"); processCreated = true;
      Check(AssignProcessToJobObject(job, pi.hProcess), "AssignProcessToJobObject"); assigned = true;
      if (WaitForSingleObject(parent, 0) == WAIT_OBJECT_0) { TerminateJobObject(job, 4); throw new InvalidOperationException("Runtime parent exited before server resume."); }
      if (ResumeThread(pi.hThread) == 0xffffffff) throw new InvalidOperationException("ResumeThread failed: " + Marshal.GetLastWin32Error());
      var watch = Stopwatch.StartNew(); bool cancelled = false, expired = false, parentDied = false;
      while (WaitForSingleObject(pi.hProcess, 100) != WAIT_OBJECT_0) {
        if (WaitForSingleObject(parent, 0) == WAIT_OBJECT_0) { parentDied = true; TerminateJobObject(job, 4); break; }
        if (File.Exists(cancelPath)) { cancelled = true; TerminateJobObject(job, 1); break; }
        if (lifetimeMs > 0 && watch.ElapsedMilliseconds >= lifetimeMs) { expired = true; TerminateJobObject(job, 2); break; }
      }
      WaitForSingleObject(pi.hProcess, INFINITE); uint code; GetExitCodeProcess(pi.hProcess, out code); normalEnd = !cancelled && !expired && !parentDied;
      // A server that exits on its own may leave descendants behind; end their job membership before reporting.
      if (!JobEmpty(job)) TerminateJobObject(job, 3);
      var verify = Stopwatch.StartNew(); bool empty = JobEmpty(job); while (!empty && verify.ElapsedMilliseconds < 5000) { System.Threading.Thread.Sleep(25); empty = JobEmpty(job); }
      return new McpHostResult { exitCode = normalEnd ? (int?)code : null, cancelled = cancelled, parentDied = parentDied, lifetimeExpired = expired, cleanupVerified = empty, processId = pi.dwProcessId };
    } finally {
      if (processCreated && !assigned && pi.hProcess != IntPtr.Zero) TerminateProcess(pi.hProcess, 3);
      if (processCreated && assigned && job != IntPtr.Zero) TerminateJobObject(job, 3);
      if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread); if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
      if (attributesInitialized) DeleteProcThreadAttributeList(attributes); if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes); if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
      if (env != IntPtr.Zero) Marshal.FreeHGlobal(env); if (job != IntPtr.Zero) CloseHandle(job); if (parent != IntPtr.Zero) CloseHandle(parent);
    }
  }
}
'@ -ErrorAction Stop

try {
  $environment = [System.Collections.Generic.Dictionary[string,string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  if ($spec.environment) { $spec.environment.psobject.Properties | ForEach-Object { $environment.Add($_.Name, [string]$_.Value) } }
  [string[]]$arguments = @(); if ($spec.arguments) { $arguments = @($spec.arguments | ForEach-Object { [string]$_ }) }
  $result = [McpHost]::Run([string]$spec.command, $arguments, [string]$spec.cwd, $environment, [int]$spec.lifetimeMs, [string]$spec.cancelPath, [int]$spec.parentPid, [long]$spec.parentStartedAtMs)
  $result | Add-Member -NotePropertyName nonce -NotePropertyValue ([string]$spec.nonce)
  [System.IO.File]::WriteAllText([string]$spec.resultPath, ($result | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}
