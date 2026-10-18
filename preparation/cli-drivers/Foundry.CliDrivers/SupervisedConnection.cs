using Foundry.Platform;

namespace Foundry.CliDrivers;

/// <summary>Explicit low-level process transport; callers supply an admitted native ProcessSpec. No discovery or live CLI defaults.</summary>
internal static class SupervisedConnection
{
    public static ICliConnection Start(ProcessSpec specification, CliLimits? limits = null, int stderrBytes = 64 * 1024)
    {
        (limits ?? new CliLimits()).Validate();
        if (stderrBytes is < 1 or > 1024 * 1024) throw new ArgumentOutOfRangeException(nameof(stderrBytes));
        var job = JobProcess.Start(specification);
        var drain = DrainAsync(job, stderrBytes);
        return new JsonLineConnection(job.StandardInput, job.StandardOutput, limits, async () =>
        {
            try
            {
                job.StandardInput.Dispose();
                if (!await job.WaitForEmptyAsync(TimeSpan.FromMilliseconds(250)).ConfigureAwait(false)) job.Terminate(1);
                if (!await job.WaitForEmptyAsync(TimeSpan.FromSeconds(3)).ConfigureAwait(false))
                    throw new IOException("CLI process tree cleanup could not be verified.");
                await drain.ConfigureAwait(false);
            }
            finally { job.Dispose(); }
        });
    }

    private static async Task DrainAsync(JobProcess job, int limit)
    {
        var buffer = new byte[4096];
        long received = 0;
        int count;
        while ((count = await job.StandardError.ReadAsync(buffer).ConfigureAwait(false)) != 0)
        {
            // Discard diagnostics: stderr can contain credentials or full provider payloads.
            received += count;
            if (received > limit)
            {
                job.Terminate(1);
                throw new IOException("CLI stderr exceeded its byte limit.");
            }
        }
    }
}
