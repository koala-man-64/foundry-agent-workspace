using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Foundry.Platform;

/// <summary>What to launch. Both paths are fully qualified; the command line is passed to CreateProcessW verbatim and
/// callers own its quoting.</summary>
public sealed record ProcessSpec(string Application, string CommandLine, string WorkingDirectory, IReadOnlyDictionary<string, string> Environment);

/// <summary>
/// A process tree confined to its own Job Object from the first instruction (docs/wpf-webview2-migration.md, "Process
/// execution"). The child starts suspended inside the job (PROC_THREAD_ATTRIBUTE_JOB_LIST), inherits only its three
/// standard handles (PROC_THREAD_ATTRIBUTE_HANDLE_LIST), and dies with the job when this object, or its owning
/// process, closes the job handle (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE). Every launch in a Foundry process goes through
/// this class: System.Diagnostics.Process inherits every inheritable handle, including the child pipe ends this class
/// marks inheritable for the moment of launch.
/// </summary>
public sealed class JobProcess : IDisposable
{
    private readonly SafeKernelHandle job;
    private readonly SafeKernelHandle process;

    private JobProcess(SafeKernelHandle job, SafeKernelHandle process, int processId, FileStream input, FileStream output, FileStream error)
    {
        this.job = job;
        this.process = process;
        ProcessId = processId;
        StandardInput = input;
        StandardOutput = output;
        StandardError = error;
    }

    public int ProcessId { get; }

    public FileStream StandardInput { get; }

    public FileStream StandardOutput { get; }

    public FileStream StandardError { get; }

    /// <summary>Processes still running in the job, the root included.</summary>
    public unsafe int ActiveProcesses
    {
        get
        {
            Native.JobBasicAccountingInformation information;
            if (!Native.QueryInformationJobObject(job, Native.JobObjectBasicAccountingInformation, &information, (uint)sizeof(Native.JobBasicAccountingInformation), null))
            {
                throw new Win32Exception(Marshal.GetLastPInvokeError(), "QueryInformationJobObject failed.");
            }
            return (int)information.ActiveProcesses;
        }
    }

    public static unsafe JobProcess Start(ProcessSpec spec)
    {
        Validate(spec);
        var environment = EnvironmentBlock(spec.Environment);

        var job = Native.CreateJobObject(0, null);
        if (job.IsInvalid)
        {
            var failure = Marshal.GetLastPInvokeError();
            job.Dispose();
            throw new Win32Exception(failure, "CreateJobObject failed.");
        }
        SafeFileHandle? inputRead = null, inputWrite = null, outputRead = null, outputWrite = null, errorRead = null, errorWrite = null;
        SafeKernelHandle? processHandle = null;
        try
        {
            var limits = new Native.JobExtendedLimitInformation { BasicLimitInformation = { LimitFlags = Native.JobObjectLimitKillOnJobClose } };
            if (!Native.SetInformationJobObject(job, Native.JobObjectExtendedLimitInformation, &limits, (uint)sizeof(Native.JobExtendedLimitInformation)))
            {
                throw new Win32Exception(Marshal.GetLastPInvokeError(), "SetInformationJobObject failed.");
            }
            (inputRead, inputWrite) = Pipe();
            (outputRead, outputWrite) = Pipe();
            (errorRead, errorWrite) = Pipe();

            Native.ProcessInformation information;
            try
            {
                information = Launch(spec, environment, job, inputRead, outputWrite, errorWrite);
            }
            finally
            {
                // The child holds its own copies now (or never started); the parent must not keep the child's ends.
                inputRead.Dispose(); outputWrite.Dispose(); errorWrite.Dispose();
            }
            using var thread = new SafeKernelHandle(information.Thread);
            processHandle = new SafeKernelHandle(information.Process);
            if (Native.ResumeThread(thread) == uint.MaxValue)
            {
                throw new Win32Exception(Marshal.GetLastPInvokeError(), "ResumeThread failed.");
            }
            return new JobProcess(job, processHandle, (int)information.ProcessId,
                new FileStream(inputWrite, FileAccess.Write, 1), new FileStream(outputRead, FileAccess.Read, 4096), new FileStream(errorRead, FileAccess.Read, 4096));
        }
        catch
        {
            // Closing the job kills a child that was already created.
            inputRead?.Dispose(); outputWrite?.Dispose(); errorWrite?.Dispose();
            inputWrite?.Dispose(); outputRead?.Dispose(); errorRead?.Dispose();
            processHandle?.Dispose();
            job.Dispose();
            throw;
        }
    }

    /// <summary>
    /// Fully qualified paths; no NUL anywhere (Windows would silently truncate at it); and an .exe application, as the
    /// MCP configuration already requires (mcp.ts). CreateProcessW hands .bat and .cmd files to cmd.exe, whose parsing
    /// differs from the quoting callers apply, so batch files run only through an explicit cmd.exe command line.
    /// </summary>
    private static void Validate(ProcessSpec spec)
    {
        ArgumentNullException.ThrowIfNull(spec);
        foreach (var (value, name) in new[] { (spec.Application, "application"), (spec.CommandLine, "command line"), (spec.WorkingDirectory, "working directory") })
        {
            if (value is null || value.Contains('\0', StringComparison.Ordinal))
            {
                throw new ArgumentException($"The {name} is missing or contains NUL.", nameof(spec));
            }
        }
        if (!Path.IsPathFullyQualified(spec.Application) || !Path.IsPathFullyQualified(spec.WorkingDirectory))
        {
            throw new ArgumentException("The application and working directory must be fully qualified paths.", nameof(spec));
        }
        if (!spec.Application.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException("The application must be an .exe; run scripts and batch files through their interpreter.", nameof(spec));
        }
    }

    /// <summary>Wait for the root process to exit and return its exit code. Descendants may still run; see <see cref="ActiveProcesses"/>.</summary>
    public async Task<int> WaitForExitAsync(CancellationToken cancellationToken = default)
    {
        using var wait = new ProcessWait(process);
        await wait.Completion.WaitAsync(cancellationToken).ConfigureAwait(false);
        return ExitCode();
    }

    /// <summary>Terminate every process in the job.</summary>
    public void Terminate(uint exitCode)
    {
        if (!Native.TerminateJobObject(job, exitCode))
        {
            throw new Win32Exception(Marshal.GetLastPInvokeError(), "TerminateJobObject failed.");
        }
    }

    /// <summary>Cleanup is verified only when the job reports no active process within the timeout.</summary>
    public async Task<bool> WaitForEmptyAsync(TimeSpan timeout, CancellationToken cancellationToken = default)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (ActiveProcesses > 0)
        {
            if (DateTime.UtcNow >= deadline)
            {
                return false;
            }
            await Task.Delay(50, cancellationToken).ConfigureAwait(false);
        }
        return true;
    }

    /// <summary>
    /// Closing the job handle kills anything still running in it; it closes first, so a failing stream cannot leave the
    /// tree alive. A pending <see cref="WaitForExitAsync"/> then faults with <see cref="ObjectDisposedException"/>
    /// rather than reporting an exit code. An instance that is dropped without disposal kills its tree when the job
    /// handle is finalized, so callers keep it reachable for the tree's lifetime, not just its streams.
    /// </summary>
    public void Dispose()
    {
        job.Dispose();
        process.Dispose();
        StandardInput.Dispose();
        StandardOutput.Dispose();
        StandardError.Dispose();
    }

    private unsafe int ExitCode()
    {
        uint exitCode;
        if (!Native.GetExitCodeProcess(process, &exitCode))
        {
            throw new Win32Exception(Marshal.GetLastPInvokeError(), "GetExitCodeProcess failed.");
        }
        return unchecked((int)exitCode);
    }

    private static unsafe Native.ProcessInformation Launch(ProcessSpec spec, char[] environment, SafeKernelHandle job, SafeFileHandle input, SafeFileHandle output, SafeFileHandle error)
    {
        nuint size = 0;
        Native.InitializeProcThreadAttributeList(null, 2, 0, &size);
        var list = NativeMemory.Alloc(size);
        var referenced = new SafeHandle[] { job, input, output, error };
        var references = 0;
        try
        {
            foreach (var handle in referenced)
            {
                var added = false;
                handle.DangerousAddRef(ref added);
                references++;
            }
            if (!Native.InitializeProcThreadAttributeList(list, 2, 0, &size))
            {
                throw new Win32Exception(Marshal.GetLastPInvokeError(), "InitializeProcThreadAttributeList failed.");
            }
            try
            {
                var inherited = stackalloc nint[3] { input.DangerousGetHandle(), output.DangerousGetHandle(), error.DangerousGetHandle() };
                var jobs = stackalloc nint[1] { job.DangerousGetHandle() };
                if (!Native.UpdateProcThreadAttribute(list, 0, Native.ProcThreadAttributeHandleList, inherited, (nuint)(3 * sizeof(nint)), null, null)
                    || !Native.UpdateProcThreadAttribute(list, 0, Native.ProcThreadAttributeJobList, jobs, (nuint)sizeof(nint), null, null))
                {
                    throw new Win32Exception(Marshal.GetLastPInvokeError(), "UpdateProcThreadAttribute failed.");
                }
                var startup = new Native.StartupInfoEx
                {
                    StartupInfo = new Native.StartupInfo
                    {
                        Cb = (uint)sizeof(Native.StartupInfoEx),
                        Flags = Native.StartfUseStdHandles,
                        StandardInput = input.DangerousGetHandle(),
                        StandardOutput = output.DangerousGetHandle(),
                        StandardError = error.DangerousGetHandle(),
                    },
                    AttributeList = list,
                };
                var commandLine = (spec.CommandLine + '\0').ToCharArray(); // CreateProcessW may write to this buffer.
                Native.ProcessInformation information;
                // The child ends become inheritable only for this call, which HANDLE_LIST limits to them; the caller
                // closes them as soon as it returns. Any launcher that passes no handle list could inherit them in
                // between, which is why every launch goes through this class.
                MakeInheritable(input);
                MakeInheritable(output);
                MakeInheritable(error);
                fixed (char* application = spec.Application)
                fixed (char* command = commandLine)
                fixed (char* block = environment)
                fixed (char* directory = spec.WorkingDirectory)
                {
                    if (!Native.CreateProcess(application, command, 0, 0, inheritHandles: true,
                        Native.CreateSuspended | Native.ExtendedStartupInfoPresent | Native.CreateUnicodeEnvironment | Native.CreateNoWindow,
                        block, directory, &startup, &information))
                    {
                        throw new Win32Exception(Marshal.GetLastPInvokeError(), $"CreateProcess failed for {spec.Application}.");
                    }
                }
                return information;
            }
            finally
            {
                Native.DeleteProcThreadAttributeList(list);
            }
        }
        finally
        {
            for (var index = 0; index < references; index++)
            {
                referenced[index].DangerousRelease();
            }
            NativeMemory.Free(list);
        }
    }

    /// <summary>An anonymous pipe; both ends start non-inheritable.</summary>
    private static unsafe (SafeFileHandle Read, SafeFileHandle Write) Pipe()
    {
        nint read, write;
        var attributes = new Native.SecurityAttributes { Length = (uint)sizeof(Native.SecurityAttributes) };
        if (!Native.CreatePipe(&read, &write, &attributes, 0))
        {
            throw new Win32Exception(Marshal.GetLastPInvokeError(), "CreatePipe failed.");
        }
        return (new SafeFileHandle(read, ownsHandle: true), new SafeFileHandle(write, ownsHandle: true));
    }

    private static void MakeInheritable(SafeFileHandle handle)
    {
        if (!Native.SetHandleInformation(handle, Native.HandleFlagInherit, Native.HandleFlagInherit))
        {
            throw new Win32Exception(Marshal.GetLastPInvokeError(), "SetHandleInformation failed.");
        }
    }

    /// <summary>name=value pairs, sorted case-insensitively as CreateProcessW expects, each NUL-terminated, then a final
    /// NUL. Windows names are case-insensitive, so two names that differ only in case are rejected.</summary>
    private static char[] EnvironmentBlock(IReadOnlyDictionary<string, string> environment)
    {
        ArgumentNullException.ThrowIfNull(environment);
        var block = new StringBuilder();
        string? previous = null;
        foreach (var (name, value) in environment.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase))
        {
            if (name.Length == 0 || name.Contains('=', StringComparison.Ordinal) || name.Contains('\0', StringComparison.Ordinal)
                || value is null || value.Contains('\0', StringComparison.Ordinal))
            {
                throw new ArgumentException($"Environment entry '{name}' is not representable.", nameof(environment));
            }
            if (string.Equals(previous, name, StringComparison.OrdinalIgnoreCase))
            {
                throw new ArgumentException($"Environment entry '{name}' appears more than once.", nameof(environment));
            }
            previous = name;
            block.Append(name).Append('=').Append(value).Append('\0');
        }
        return block.Append('\0').ToString().ToCharArray();
    }

    /// <summary>Completes when the process handle is signaled, without blocking a thread.</summary>
    private sealed class ProcessWait : IDisposable
    {
        private readonly ProcessWaitHandle handle;
        private readonly RegisteredWaitHandle registration;
        private readonly TaskCompletionSource completion = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public ProcessWait(SafeKernelHandle process)
        {
            handle = new ProcessWaitHandle(process);
            registration = ThreadPool.RegisterWaitForSingleObject(handle, static (state, _) => ((TaskCompletionSource)state!).TrySetResult(), completion, Timeout.Infinite, executeOnlyOnce: true);
        }

        public Task Completion => completion.Task;

        public void Dispose()
        {
            registration.Unregister(null);
            handle.Dispose(); // The registration keeps its own reference until the thread pool stops waiting.
        }
    }

    /// <summary>A wait handle that owns a duplicate of the process handle, so the thread pool may still be waiting on it
    /// after the JobProcess itself is disposed.</summary>
    private sealed class ProcessWaitHandle : WaitHandle
    {
        public ProcessWaitHandle(SafeKernelHandle process)
        {
            if (!Native.DuplicateHandle(Native.CurrentProcess, process, Native.CurrentProcess, out var duplicate, 0, inherit: false, Native.DuplicateSameAccess))
            {
                var failure = Marshal.GetLastPInvokeError();
                duplicate.Dispose();
                throw new Win32Exception(failure, "DuplicateHandle failed.");
            }
            SafeWaitHandle = duplicate;
        }
    }
}
