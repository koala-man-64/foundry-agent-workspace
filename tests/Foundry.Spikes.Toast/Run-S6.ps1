<#
.SYNOPSIS
Spike S6: toast click activation from the unzipped exe and from the per-user installed exe.

.DESCRIPTION
Run it at your desktop, in a normal (not elevated) PowerShell window. See docs/spikes/s6-toast-activation.md.

It publishes the toast spike self-contained for win-x64, zips it and unzips it as a user would, and compiles a
per-user Inno Setup installer. Then:
  Phase A runs the unzipped exe.
  Phase B installs the spike for this user only and starts it from its Start menu shortcut.
Each phase opens a window with five steps. Whatever happens, the script then removes the spike's per-user app ID
registration, its toasts and the test install, and reports anything left behind. It changes no other setting.

.PARAMETER IsccPath
ISCC.exe from Inno Setup 6. If omitted, PATH and the default install folders are searched.

.PARAMETER BuildOnly
Publish, zip and compile the installer, then stop. Nothing is installed, registered or started.

.PARAMETER CleanupOnly
Remove what an interrupted earlier run left behind, and report anything that remains.

.OUTPUTS
Results in test-results\spikes\s6-toast-activation\<time>\, with summary.md. Exit code 0 when the run finished and
nothing was left behind; 1 otherwise.
#>
[CmdletBinding()]
param(
    [string]$IsccPath,
    [switch]$BuildOnly,
    [switch]$CleanupOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$project = Join-Path $PSScriptRoot 'Foundry.Spikes.Toast.csproj'
$setupScript = Join-Path $PSScriptRoot 's6.iss'
$runsRoot = Join-Path $repoRoot 'test-results\spikes\s6-toast-activation'
$out = Join-Path $runsRoot (Get-Date -Format 'yyyyMMdd-HHmmss')
$publish = Join-Path $out 'publish'
$zip = Join-Path $out 'FoundryS6ToastSpike.zip'
$unzipped = Join-Path $out 'unzipped'
$setup = Join-Path $out 'FoundryS6ToastSpikeSetup.exe'

# Everything the spike, its installer or Windows creates for it. Cleanup touches these exact names and nothing else.
$aumid = 'Foundry.Spikes.S6Toast'
$exeName = 'Foundry.Spikes.Toast.exe'
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Foundry S6 toast spike'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{CE1A3DDF-7D9D-4FF8-8888-D8AA5D1700AD}_is1'
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Foundry S6 toast spike.lnk'
$aumidKey = "HKCU:\Software\Classes\AppUserModelId\$aumid"
$settingsKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\$aumid"
$launchFolder = Join-Path ([IO.Path]::GetTempPath()) $aumid

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host "== $Text" -ForegroundColor Cyan
}

function Test-Elevated {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal $identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Find-Iscc {
    if ($IsccPath) {
        if (-not (Test-Path -LiteralPath $IsccPath -PathType Leaf)) { throw "ISCC.exe was not found at $IsccPath." }
        return (Resolve-Path -LiteralPath $IsccPath).Path
    }
    $command = Get-Command 'ISCC.exe' -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, (Join-Path $env:LOCALAPPDATA 'Programs'))) {
        if (-not $base) { continue }
        $candidate = Join-Path $base 'Inno Setup 6\ISCC.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    throw 'Inno Setup 6 (ISCC.exe) was not found. Install Inno Setup 6 or pass -IsccPath. Nothing was installed or registered.'
}

function Get-Residue {
    $found = @()
    if (Test-Path -LiteralPath $installDir) { $found += "install folder $installDir" }
    if (Test-Path -LiteralPath $uninstallKey) { $found += "uninstall entry $uninstallKey" }
    if (Test-Path -LiteralPath $shortcut) { $found += "Start menu shortcut $shortcut" }
    if (Test-Path -LiteralPath $aumidKey) { $found += "app ID registration $aumidKey" }
    if (Test-Path -LiteralPath $settingsKey) { $found += "notification settings $settingsKey" }
    if (Test-Path -LiteralPath $launchFolder) { $found += "launch log folder $launchFolder" }
    return , $found
}

function Get-SpikeProcesses {
    # Only the spike's own exe, from the test install or from a run folder.
    @(Get-Process -Name 'Foundry.Spikes.Toast' -ErrorAction SilentlyContinue | Where-Object {
        $path = $null
        try { $path = $_.Path } catch { $path = $null }
        $path -and ($path.StartsWith($installDir + '\', [StringComparison]::OrdinalIgnoreCase) -or $path.StartsWith($runsRoot + '\', [StringComparison]::OrdinalIgnoreCase))
    })
}

function Stop-SpikeProcesses {
    foreach ($process in Get-SpikeProcesses) {
        Write-Host "Closing a running spike (process $($process.Id))."
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        $process.WaitForExit(10000) | Out-Null
    }
}

function Clear-SpikeRegistration {
    # The spike's toasts first, through WinRT, then its app ID key (only with the spike's marker) and the per-app
    # notification settings Windows may have created for it.
    try {
        $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
        [Windows.UI.Notifications.ToastNotificationManager]::History.Clear($aumid)
    }
    catch {
        Write-Warning "Could not clear the spike's toasts from Notification Center: $($_.Exception.Message)"
    }
    if (Test-Path -LiteralPath $aumidKey) {
        $marker = Get-ItemProperty -LiteralPath $aumidKey -Name 'FoundrySpike' -ErrorAction SilentlyContinue
        if ($marker -and $marker.FoundrySpike -eq 'S6') {
            Remove-Item -LiteralPath $aumidKey -Recurse -Force
        }
        else {
            Write-Warning "$aumidKey exists without the spike's marker, so it was left alone."
        }
    }
    if (Test-Path -LiteralPath $settingsKey) { Remove-Item -LiteralPath $settingsKey -Recurse -Force }
}

function Remove-TestInstall {
    $uninstaller = Join-Path $installDir 'unins000.exe'
    if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
        Write-Host 'Uninstalling the test install.'
        $log = Join-Path $out 'uninstall.log'
        Start-Process -FilePath $uninstaller -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=`"$log`"") -Wait | Out-Null
        # The uninstaller finishes in a temporary copy of itself; wait until the folder and its entry are gone.
        $deadline = (Get-Date).AddSeconds(120)
        while (((Test-Path -LiteralPath $installDir) -or (Test-Path -LiteralPath $uninstallKey)) -and ((Get-Date) -lt $deadline)) {
            Start-Sleep -Milliseconds 500
        }
    }
    elseif (Test-Path -LiteralPath (Join-Path $installDir $exeName)) {
        # A partial install without its uninstaller: the folder is the spike's own, recognized by its exe.
        Remove-Item -LiteralPath $installDir -Recurse -Force
    }
    if ((Test-Path -LiteralPath $uninstallKey) -and -not (Test-Path -LiteralPath $installDir)) {
        Remove-Item -LiteralPath $uninstallKey -Recurse -Force
    }
    if (Test-Path -LiteralPath $shortcut) {
        $target = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut).TargetPath
        if ($target -and $target.StartsWith($installDir + '\', [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $shortcut -Force
        }
        else {
            Write-Warning "$shortcut does not point into the test install, so it was left alone."
        }
    }
}

function Read-Phase([string]$Label) {
    $file = Join-Path $out "phase-$Label.jsonl"
    if (-not (Test-Path -LiteralPath $file)) { return , @() }
    return , @(Get-Content -LiteralPath $file -Encoding UTF8 | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
}

function Get-Activation($Records, [string]$Step, [string]$Answer) {
    # One trial per toast (its first activation). A trial counts only if the window was not already in front when the
    # toast was clicked; otherwise "in front" proves nothing. Every valid trial must have brought the window forward.
    # A step that was not run properly is inconclusive, never a failure: it is to be repeated.
    $shown = @($Records | Where-Object { $_.kind -eq 'shown' -and $_.data.step -eq $Step }).Count
    $first = @($Records | Where-Object { $_.kind -eq 'activated' -and $_.data.step -eq $Step } | Group-Object { $_.data.nonce } | ForEach-Object { $_.Group[0] })
    if ($shown -eq 0) { return [pscustomobject]@{ Result = 'inconclusive'; Text = 'not run' } }
    if ($first.Count -eq 0) {
        if ($Answer -eq 'No') { return [pscustomobject]@{ Result = 'fail'; Text = 'not activated, although you answered that you clicked it and the window did not come forward' } }
        return [pscustomobject]@{ Result = 'inconclusive'; Text = 'shown but never activated: repeat the step and click the toast' }
    }
    $valid = @($first | Where-Object { -not $_.data.wasInFront })
    if ($valid.Count -eq 0) { return [pscustomobject]@{ Result = 'inconclusive'; Text = 'no valid trial (the window was already in front): repeat the step' } }
    $inFront = @($valid | Where-Object { $_.data.inFrontAfter800ms }).Count
    if ($inFront -eq $valid.Count) { return [pscustomobject]@{ Result = 'pass'; Text = "activated, window in front ($inFront of $($valid.Count) valid trials)" } }
    $holders = @($valid | Where-Object { -not $_.data.inFrontAfter800ms } | ForEach-Object { $_.data.foregroundProcess } | Where-Object { $_ } | Select-Object -Unique)
    return [pscustomobject]@{ Result = 'fail'; Text = "activated, window NOT in front in $($valid.Count - $inFront) of $($valid.Count) valid trials$(if ($holders.Count -gt 0) { " ($($holders -join ', ') kept the foreground)" })" }
}

function Get-Answer($Records, [string]$Step, [string]$Question) {
    $answer = @($Records | Where-Object { $_.kind -eq 'answer' -and $_.data.step -eq $Step -and $_.data.question -eq $Question }) | Select-Object -Last 1
    if ($answer) { return $answer.data.answer }
    return 'no answer'
}

function Wait-SpikeProcess([string]$ExePath) {
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        $process = Get-SpikeProcesses | Where-Object { $_.Path -eq $ExePath } | Select-Object -First 1
        if ($process) { return $process }
        Start-Sleep -Milliseconds 300
    }
    throw "The spike did not start from $ExePath."
}

function Invoke-Phase([string]$Label, [string]$ExePath, [scriptblock]$Launch) {
    Write-Step "Phase ${Label}: a window titled 'Foundry S6 toast spike' opens. Do its five steps in order."
    Write-Host 'Step 5 closes the window for you; or use "Finish without step 5".'
    & $Launch
    $process = Wait-SpikeProcess $ExePath
    $process.WaitForExit()
    $records = Read-Phase $Label
    if (@($records | Where-Object { $_.kind -eq 'shown' -and $_.data.step -eq 'app-closed' }).Count -eq 0) { return }
    $logLines = 0
    $logFile = Join-Path $launchFolder 'launches.log'
    if (Test-Path -LiteralPath $logFile) { $logLines = @(Get-Content -LiteralPath $logFile).Count }
    $startsBefore = @($records | Where-Object { $_.kind -eq 'start' }).Count
    Write-Host ''
    Write-Host 'Step 5: the spike has closed and left a toast. Open Notification Center (Windows+N, or click the clock)'
    Write-Host 'and click the toast titled "Foundry S6: 5. Click a toast after the app has closed".'
    Read-Host 'Press Enter here after clicking it' | Out-Null
    Start-Sleep -Seconds 3
    # Windows can restart the spike two ways: with the toast's arguments (recorded in launches.log), or through the
    # Start menu shortcut, whose own arguments open a second interactive window (a new start record).
    $relaunches = @()
    if (Test-Path -LiteralPath $logFile) { $relaunches = @(Get-Content -LiteralPath $logFile | Select-Object -Skip $logLines) }
    $after = Read-Phase $Label
    $restarts = @($after | Where-Object { $_.kind -eq 'start' }).Count - $startsBefore
    $running = @(Get-SpikeProcesses).Count
    $answer = Read-Host 'What happened? Type n (nothing), s (the spike opened or showed a message), or describe it'
    $text = @(
        "## Step 5, $Label exe: a toast clicked after the app closed",
        '',
        "- Rudy: $answer",
        "- Spike processes running 3 s after the click: $running",
        "- Launches with arguments the spike did not choose: $(if ($relaunches.Count -gt 0) { $relaunches -join ' / ' } else { 'none' })",
        "- Interactive restarts (new start records): $restarts",
        ''
    )
    Set-Content -LiteralPath (Join-Path $out "step5-$Label.md") -Value $text -Encoding UTF8
    Stop-SpikeProcesses
}

function Write-Summary([string[]]$Residue, [string]$Failure, [string[]]$Errors) {
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('# Spike S6: toast click activation')
    $lines.Add('')
    $lines.Add("Run $(Get-Date -Format 'yyyy-MM-dd HH:mm zzz') on Windows $([Environment]::OSVersion.Version). Results: $out")
    $lines.Add('')
    $lines.Add('Exit criterion: toast click activation works from the unzipped exe and the installed exe, or the fallback (the in-app Inbox plus a taskbar flash) ships.')
    $lines.Add('')
    $lines.Add('## Verdict (measured)')
    $lines.Add('')
    foreach ($label in @('unzipped', 'installed')) {
        $records = Read-Phase $label
        if ($records.Count -eq 0) {
            $lines.Add("- **$label exe:** not run.")
            continue
        }
        $start = $records | Where-Object { $_.kind -eq 'start' } | Select-Object -First 1
        $names = @('banner-minimized', 'banner-background', 'notification-center')
        # Rudy's own answers must agree with the measurement; a disagreement is reported, not resolved.
        $answers = @($names | ForEach-Object { Get-Answer $records $_ 'Did this window come to the front by itself?' })
        $steps = @(for ($index = 0; $index -lt $names.Count; $index++) { Get-Activation $records $names[$index] $answers[$index] })
        $failed = @($steps | Where-Object { $_.Result -eq 'fail' }).Count
        $inconclusive = @($steps | Where-Object { $_.Result -eq 'inconclusive' }).Count
        $agree = @($answers | Where-Object { $_ -ne 'Yes' }).Count -eq 0
        $setting = if ($start) { "notifier $($start.data.notifier), Windows said '$($start.data.notifications)'" } else { 'no start record' }
        $verdict = if ($failed -gt 0) { 'does not fully work' }
            elseif ($inconclusive -gt 0) { 'inconclusive: repeat the steps marked so' }
            elseif ($agree) { 'works' }
            else { 'measured to work, but your answers disagree' }
        $lines.Add("- **$label exe ($setting):** banner while minimized: $($steps[0].Text); banner while behind another window: $($steps[1].Text); Notification Center: $($steps[2].Text). Your answers to 'came to the front by itself': $($answers -join ', '). Click activation **$verdict**.")
        $flash = Get-Answer $records 'taskbar-flash' 'Did the taskbar button flash?'
        $lines.Add("  The fallback's taskbar flash, by your answer: $flash.")
    }
    if ($Failure) { $lines.Add("- The run stopped early: $Failure") }
    $lines.Add('')
    foreach ($name in @('phase-unzipped-error.txt', 'phase-installed-error.txt')) {
        $file = Join-Path $out $name
        if (Test-Path -LiteralPath $file) {
            $lines.Add("**The spike could not start its toasts ($name):**")
            $lines.Add('')
            $lines.Add('```')
            $lines.Add((Get-Content -LiteralPath $file -Raw -Encoding UTF8))
            $lines.Add('```')
            $lines.Add('')
        }
    }
    foreach ($name in @('phase-unzipped.md', 'phase-installed.md', 'step5-unzipped.md', 'step5-installed.md')) {
        $file = Join-Path $out $name
        if (Test-Path -LiteralPath $file) {
            $lines.Add((Get-Content -LiteralPath $file -Raw -Encoding UTF8))
        }
    }
    $lines.Add('## Cleanup')
    $lines.Add('')
    if ($Residue.Count -eq 0 -and $Errors.Count -eq 0) {
        $lines.Add('Nothing checked was left behind: no install folder, uninstall entry, Start menu shortcut, app ID registration, notification settings or launch log.')
    }
    foreach ($item in $Residue) { $lines.Add("- LEFT BEHIND: $item") }
    foreach ($item in $Errors) { $lines.Add("- Cleanup problem: $item") }
    $lines.Add('')
    $lines.Add('Not checked: records Windows keeps about apps it has seen, such as its notification database, jump lists and app-usage history.')
    Set-Content -LiteralPath (Join-Path $out 'summary.md') -Value $lines -Encoding UTF8
}

function Invoke-Safely([string]$What, [scriptblock]$Do) {
    # One failing cleanup step must not stop the others, the residue check or the summary.
    try { & $Do }
    catch {
        $message = "$What failed: $($_.Exception.Message)"
        $cleanupErrors.Add($message)
        Write-Warning $message
    }
}

# One run at a time: a second run's cleanup would otherwise remove the first run's install mid-phase. The handle is
# released when this process ends, however it ends, so a closed terminal leaves no stale lock.
New-Item -ItemType Directory -Force -Path $runsRoot | Out-Null
try {
    $lock = [IO.File]::Open((Join-Path $runsRoot 'run.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
}
catch {
    Write-Host 'Another Run-S6.ps1 is running. Let it finish, then try again.' -ForegroundColor Red
    exit 1
}
if (-not $BuildOnly -and -not $CleanupOnly) {
    # Refusals happen before anything is created, so they never trigger the cleanup below.
    $refusal = $null
    $before = Get-Residue
    if (Test-Elevated) {
        $refusal = 'Run this from a normal PowerShell window, not as administrator: the spike tests a per-user install.'
    }
    elseif ($before.Count -gt 0) {
        $before | ForEach-Object { Write-Host "Found from an earlier run: $_" }
        $refusal = 'An earlier run left things behind. Run .\Run-S6.ps1 -CleanupOnly first. An app ID key without the spike''s marker was not made by the spike; remove it by hand if it is yours to remove.'
    }
    if ($refusal) {
        Write-Host $refusal -ForegroundColor Red
        $lock.Dispose()
        exit 1
    }
}

New-Item -ItemType Directory -Force -Path $out | Out-Null
Start-Transcript -LiteralPath (Join-Path $out 'console.log') | Out-Null
$failure = $null
$residue = @()
$cleanupErrors = New-Object System.Collections.Generic.List[string]
try {
    if ($CleanupOnly) {
        Write-Step 'Removing what an earlier run left behind'
    }
    else {
        $iscc = Find-Iscc

        Write-Step 'Publishing the spike self-contained for win-x64'
        & dotnet publish $project -c Release -r win-x64 --self-contained -o $publish -p:DebugType=none --nologo
        if ($LASTEXITCODE -ne 0) { throw 'dotnet publish failed.' }

        Write-Step 'Zipping and unzipping it, as a user would'
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::CreateFromDirectory($publish, $zip)
        [IO.Compression.ZipFile]::ExtractToDirectory($zip, $unzipped)

        Write-Step 'Compiling the per-user installer'
        & $iscc /Qp "/O$out" "/DSourceDir=$publish" "/DResults=$out" $setupScript
        if ($LASTEXITCODE -ne 0) { throw 'ISCC failed.' }

        if ($BuildOnly) {
            Write-Host "Built $zip and $setup. Nothing was installed, registered or started."
        }
        else {
            $unzippedExe = Join-Path $unzipped $exeName
            Invoke-Phase 'unzipped' $unzippedExe {
                Start-Process -FilePath $unzippedExe -ArgumentList @('run', '--label', 'unzipped', '--results', "`"$out`"") | Out-Null
            }
            # Phase B starts without phase A's registration or toasts, so it shows what the installed exe does on its own.
            Clear-SpikeRegistration

            Write-Step 'Installing the spike for this user only'
            $installLog = Join-Path $out 'install.log'
            # Per-user because s6.iss sets PrivilegesRequired=lowest; no override switch is needed.
            $installer = Start-Process -FilePath $setup -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=`"$installLog`"") -Wait -PassThru
            $installedExe = Join-Path $installDir $exeName
            if ($installer.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $installedExe) -or -not (Test-Path -LiteralPath $shortcut)) {
                throw "The installer failed (exit code $($installer.ExitCode)); see $installLog."
            }
            Invoke-Phase 'installed' $installedExe {
                # From the Start menu shortcut, as a user starts an installed app; the shortcut carries the spike's AUMID.
                Start-Process -FilePath $shortcut | Out-Null
            }
        }
    }
}
catch {
    $failure = $_.Exception.Message
    Write-Host "S6 run stopped: $failure" -ForegroundColor Red
}
finally {
    if (-not $BuildOnly) {
        Write-Step 'Cleaning up: the spike, its app ID registration, its toasts and the test install'
        Invoke-Safely 'Closing the spike' { Stop-SpikeProcesses }
        Invoke-Safely 'Clearing the app ID registration and toasts' { Clear-SpikeRegistration }
        Invoke-Safely 'Removing the test install' { Remove-TestInstall }
        Invoke-Safely 'Collecting the launch log' {
            $logFile = Join-Path $launchFolder 'launches.log'
            if (Test-Path -LiteralPath $logFile) { Copy-Item -LiteralPath $logFile -Destination (Join-Path $out 'launches.log') }
            if (Test-Path -LiteralPath $launchFolder) { Remove-Item -LiteralPath $launchFolder -Recurse -Force }
        }
        Invoke-Safely 'Removing build outputs' {
            # This run's and any interrupted run's: fixed names under the spike's own results folder. Logs stay.
            foreach ($run in @(Get-ChildItem -LiteralPath $runsRoot -Directory)) {
                foreach ($name in @('publish', 'unzipped', 'FoundryS6ToastSpike.zip', 'FoundryS6ToastSpikeSetup.exe')) {
                    $binary = Join-Path $run.FullName $name
                    if (Test-Path -LiteralPath $binary) { Remove-Item -LiteralPath $binary -Recurse -Force }
                }
            }
        }
        # Windows may write the per-app notification settings shortly after the last toast; look twice.
        Start-Sleep -Seconds 3
        Invoke-Safely 'Clearing the app ID registration and toasts again' { Clear-SpikeRegistration }
        $residue = Get-Residue
        if ($residue.Count -eq 0 -and $cleanupErrors.Count -eq 0) { Write-Host 'Nothing was left behind.' -ForegroundColor Green }
        $residue | ForEach-Object { Write-Host "LEFT BEHIND: $_" -ForegroundColor Red }
        if (-not $CleanupOnly) {
            Invoke-Safely 'Writing the summary' { Write-Summary $residue $failure $cleanupErrors.ToArray() }
            Write-Host "Summary: $(Join-Path $out 'summary.md')"
        }
    }
    Stop-Transcript | Out-Null
    $lock.Dispose()
}
if ($failure -or $residue.Count -gt 0 -or $cleanupErrors.Count -gt 0) { exit 1 }
exit 0
