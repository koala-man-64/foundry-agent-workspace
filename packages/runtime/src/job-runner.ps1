$ErrorActionPreference = 'Stop'

# The launcher receives this JSON only on stdin. Command output never shares this channel.
$spec = [Console]::In.ReadToEnd() | ConvertFrom-Json
if (-not $spec.nonce -or -not $spec.resultPath -or -not $spec.cancelPath) { throw 'Invalid command helper input.' }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

public sealed class JobRunResult {
  public string stdout { get; set; }
  public string stderr { get; set; }
  public int? exitCode { get; set; }
  public bool cancelled { get; set; }
  public bool timedOut { get; set; }
  public bool cleanupVerified { get; set; }
}

public static class JobRun {
  const uint CREATE_SUSPENDED = 0x00000004;
  const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  const uint STARTF_USESTDHANDLES = 0x00000100;
  const uint HANDLE_FLAG_INHERIT = 0x00000001;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  const uint INFINITE = 0xffffffff;
  const uint WAIT_OBJECT_0 = 0;
  const uint PROCESS_QUERY_INFORMATION = 0x0400;
  const uint SYNCHRONIZE = 0x00100000;
  const uint STILL_ACTIVE = 259;
  const int JobObjectExtendedLimitInformation = 9;
  const int JobObjectBasicAccountingInformation = 1;
  [StructLayout(LayoutKind.Sequential)] public struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount; public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION { public long TotalUserTime; public long TotalKernelTime; public long ThisPeriodTotalUserTime; public long ThisPeriodTotalKernelTime; public uint TotalPageFaultCount; public uint TotalProcesses; public uint ActiveProcesses; public uint TotalTerminatedProcesses; }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app, StringBuilder commandLine, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr environment, string cwd, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION pi);
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
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES sa, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr handle, byte[] buffer, uint count, out uint read, IntPtr overlapped);
  static void Check(bool value, string operation) { if (!value) throw new InvalidOperationException(operation + " failed: " + Marshal.GetLastWin32Error()); }
  static IntPtr PipeRead(out IntPtr write) { SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = true }; IntPtr read; Check(CreatePipe(out read, out write, ref sa, 0), "CreatePipe"); Check(SetHandleInformation(read, HANDLE_FLAG_INHERIT, 0), "SetHandleInformation"); return read; }
  static string ReadLimited(IntPtr handle) { var bytes = new List<byte>(); var buffer = new byte[4096]; try { while (true) { uint read; if (!ReadFile(handle, buffer, (uint)buffer.Length, out read, IntPtr.Zero)) { int error = Marshal.GetLastWin32Error(); if (error == 109) break; throw new InvalidOperationException("ReadFile failed: " + error); } if (read == 0) break; int remaining = 65536 - bytes.Count; if (remaining > 0) bytes.AddRange(new ArraySegment<byte>(buffer, 0, Math.Min((int)read, remaining))); } } finally { CloseHandle(handle); } var value = Encoding.UTF8.GetString(bytes.ToArray()); return bytes.Count >= 65536 ? value + "\n[output truncated]" : value; }
  static IntPtr EnvironmentBlock(Dictionary<string,string> values) { var keys = new List<string>(values.Keys); keys.Sort(StringComparer.OrdinalIgnoreCase); var text = new StringBuilder(); foreach (var key in keys) text.Append(key).Append('=').Append(values[key]).Append('\0'); text.Append('\0'); return Marshal.StringToHGlobalUni(text.ToString()); }
  static bool JobEmpty(IntPtr job) { int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)); IntPtr memory = Marshal.AllocHGlobal(size); try { Check(QueryInformationJobObject(job, JobObjectBasicAccountingInformation, memory, (uint)size, IntPtr.Zero), "QueryInformationJobObject"); return Marshal.PtrToStructure<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>(memory).ActiveProcesses == 0; } finally { Marshal.FreeHGlobal(memory); } }
  static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
  static IntPtr VerifiedParent(int pid, long startedAtMs) { IntPtr parent = OpenProcess(PROCESS_QUERY_INFORMATION | SYNCHRONIZE, false, pid); if (parent == IntPtr.Zero) throw new InvalidOperationException("Runtime parent " + pid + " is unavailable: " + Marshal.GetLastWin32Error()); long created, exited, kernel, user; Check(GetProcessTimes(parent, out created, out exited, out kernel, out user), "GetProcessTimes"); long observedMs = (created / 10000L) - 11644473600000L; if (Math.Abs(observedMs - startedAtMs) > 5000L) { CloseHandle(parent); throw new InvalidOperationException("Runtime parent identity changed."); } return parent; }
  public static JobRunResult Run(string shell, string command, string cwd, Dictionary<string,string> environment, int timeoutMs, string cancelPath, int parentPid, long parentStartedAtMs) {
    IntPtr job = IntPtr.Zero, parent = IntPtr.Zero, stdoutRead = IntPtr.Zero, stdoutWrite = IntPtr.Zero, stderrRead = IntPtr.Zero, stderrWrite = IntPtr.Zero, stdinRead = IntPtr.Zero, stdinWrite = IntPtr.Zero, env = IntPtr.Zero;
    PROCESS_INFORMATION pi = new PROCESS_INFORMATION(); bool processCreated = false; bool assigned = false; bool normalEnd = false;
    try {
      parent = VerifiedParent(parentPid, parentStartedAtMs); job = CreateJobObject(IntPtr.Zero, null); if (job == IntPtr.Zero) throw new InvalidOperationException("CreateJobObject failed: " + Marshal.GetLastWin32Error());
      var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION(); limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      int limitsSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)); IntPtr limitsMemory = Marshal.AllocHGlobal(limitsSize); try { Marshal.StructureToPtr(limits, limitsMemory, false); Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, limitsMemory, (uint)limitsSize), "SetInformationJobObject"); } finally { Marshal.FreeHGlobal(limitsMemory); }
      stdoutRead = PipeRead(out stdoutWrite); stderrRead = PipeRead(out stderrWrite); stdinRead = PipeRead(out stdinWrite);
      var startup = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFO)), dwFlags = (int)STARTF_USESTDHANDLES, hStdInput = stdinRead, hStdOutput = stdoutWrite, hStdError = stderrWrite };
      string encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(command)); var line = new StringBuilder(Quote(shell) + " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + encoded);
      if (WaitForSingleObject(parent, 0) == WAIT_OBJECT_0) throw new InvalidOperationException("Runtime parent exited before command launch.");
      env = EnvironmentBlock(environment); Check(CreateProcess(shell, line, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, env, cwd, ref startup, out pi), "CreateProcess"); processCreated = true;
      CloseHandle(stdinRead); stdinRead = IntPtr.Zero; CloseHandle(stdinWrite); stdinWrite = IntPtr.Zero; CloseHandle(stdoutWrite); stdoutWrite = IntPtr.Zero; CloseHandle(stderrWrite); stderrWrite = IntPtr.Zero;
      Check(AssignProcessToJobObject(job, pi.hProcess), "AssignProcessToJobObject"); assigned = true; if (WaitForSingleObject(parent, 0) == WAIT_OBJECT_0) { TerminateJobObject(job, 4); throw new InvalidOperationException("Runtime parent exited before command resume."); } if (ResumeThread(pi.hThread) == 0xffffffff) throw new InvalidOperationException("ResumeThread failed: " + Marshal.GetLastWin32Error());
      IntPtr stdoutHandle = stdoutRead; stdoutRead = IntPtr.Zero; IntPtr stderrHandle = stderrRead; stderrRead = IntPtr.Zero; Task<string> stdout = Task.Run(() => ReadLimited(stdoutHandle)); Task<string> stderr = Task.Run(() => ReadLimited(stderrHandle));
      var watch = Stopwatch.StartNew(); bool cancelled = false, timedOut = false, parentDied = false, backgroundTerminated = false;
      while (WaitForSingleObject(pi.hProcess, 50) != WAIT_OBJECT_0) { if (WaitForSingleObject(parent, 0) == WAIT_OBJECT_0) { parentDied = true; TerminateJobObject(job, 4); break; } if (File.Exists(cancelPath)) { cancelled = true; TerminateJobObject(job, 1); break; } if (watch.ElapsedMilliseconds >= timeoutMs) { timedOut = true; TerminateJobObject(job, 2); break; } }
      WaitForSingleObject(pi.hProcess, INFINITE); uint code; GetExitCodeProcess(pi.hProcess, out code); normalEnd = !cancelled && !timedOut && !parentDied;
      // A background descendant can retain stdout/stderr after the root exits. End its Job membership before draining pipes.
      if (normalEnd && !JobEmpty(job)) { backgroundTerminated = true; TerminateJobObject(job, 3); }
      var verify = Stopwatch.StartNew(); bool empty = JobEmpty(job); while (!empty && verify.ElapsedMilliseconds < 5000) { System.Threading.Thread.Sleep(25); empty = JobEmpty(job); }
      Task.WaitAll(stdout, stderr);
      return new JobRunResult { stdout = stdout.Result, stderr = stderr.Result + (backgroundTerminated ? "\n[background job descendants terminated]" : "") + (parentDied ? "\n[runtime parent exited; job terminated]" : ""), exitCode = normalEnd ? (int?)code : null, cancelled = cancelled || parentDied, timedOut = timedOut, cleanupVerified = empty };
    } finally {
      if (processCreated && !assigned && pi.hProcess != IntPtr.Zero) TerminateProcess(pi.hProcess, 3);
      if (processCreated && assigned && !normalEnd && job != IntPtr.Zero) TerminateJobObject(job, 3);
      if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread); if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
      if (stdoutRead != IntPtr.Zero) CloseHandle(stdoutRead); if (stdoutWrite != IntPtr.Zero) CloseHandle(stdoutWrite); if (stderrRead != IntPtr.Zero) CloseHandle(stderrRead); if (stderrWrite != IntPtr.Zero) CloseHandle(stderrWrite); if (stdinRead != IntPtr.Zero) CloseHandle(stdinRead); if (stdinWrite != IntPtr.Zero) CloseHandle(stdinWrite);
      if (env != IntPtr.Zero) Marshal.FreeHGlobal(env); if (job != IntPtr.Zero) CloseHandle(job); if (parent != IntPtr.Zero) CloseHandle(parent);
    }
  }
}
'@ -ErrorAction Stop

try {
  $environment = [System.Collections.Generic.Dictionary[string,string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $spec.environment.psobject.Properties | ForEach-Object { $environment.Add($_.Name, [string]$_.Value) }
  $result = [JobRun]::Run([string]$spec.shell, [string]$spec.command, [string]$spec.cwd, $environment, [int]$spec.timeoutMs, [string]$spec.cancelPath, [int]$spec.parentPid, [long]$spec.parentStartedAtMs)
  $result | Add-Member -NotePropertyName nonce -NotePropertyValue ([string]$spec.nonce)
  [System.IO.File]::WriteAllText([string]$spec.resultPath, ($result | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
  exit 0
} catch {
  # Do not write command output to helper stdout; Node treats a missing nonce-bearing result as untrusted.
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}
