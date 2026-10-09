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

function Get-Activation($Records, [string]$Step) {
    $hits = @($Records | Where-Object { $_.kind -eq 'activated' -and $_.data.step -eq $Step })
    if ($hits.Count -eq 0) { return 'not activated' }
    if (@($hits | Where-Object { $_.data.inFrontAfter800ms }).Count -gt 0) { return 'activated, window in front' }
    return 'activated, window NOT in front'
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
    Write-Host ''
    Write-Host 'Step 5: the spike has closed and left a toast. Open Notification Center (Windows+N, or click the clock)'
    Write-Host 'and click the toast titled "Foundry S6: 5. Click a toast after the app has closed".'
    Read-Host 'Press Enter here after clicking it' | Out-Null
    Start-Sleep -Seconds 3
    $relaunches = @()
    if (Test-Path -LiteralPath $logFile) { $relaunches = @(Get-Content -LiteralPath $logFile | Select-Object -Skip $logLines) }
    $running = @(Get-SpikeProcesses).Count
    $answer = Read-Host 'What happened? Type n (nothing), s (the spike opened or showed a message), or describe it'
    $text = @(
        "## Step 5, $Label exe: a toast clicked after the app closed",
        '',
        "- Rudy: $answer",
        "- Spike processes running 3 s after the click: $running",
        "- Launches the spike recorded: $(if ($relaunches.Count -gt 0) { $relaunches -join ' / ' } else { 'none' })",
        ''
    )
    Set-Content -LiteralPath (Join-Path $out "step5-$Label.md") -Value $text -Encoding UTF8
    Stop-SpikeProcesses
}

function Write-Summary([string[]]$Residue, [string]$Failure) {
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
        $steps = @('banner-minimized', 'banner-background', 'notification-center') | ForEach-Object { Get-Activation $records $_ }
        $works = @($steps | Where-Object { $_ -ne 'activated, window in front' }).Count -eq 0
        $setting = if ($start) { "notifier $($start.data.notifier), Windows said '$($start.data.notifications)'" } else { 'no start record' }
        $lines.Add("- **$label exe ($setting):** banner while minimized: $($steps[0]); banner while behind another window: $($steps[1]); Notification Center: $($steps[2]). Click activation **$(if ($works) { 'works' } else { 'does not fully work' })**.")
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
    if ($Residue.Count -eq 0) {
        $lines.Add('Nothing was left behind: no install folder, uninstall entry, Start menu shortcut, app ID registration, notification settings or launch log.')
    }
    else {
        foreach ($item in $Residue) { $lines.Add("- LEFT BEHIND: $item") }
    }
    Set-Content -LiteralPath (Join-Path $out 'summary.md') -Value $lines -Encoding UTF8
}

New-Item -ItemType Directory -Force -Path $out | Out-Null
Start-Transcript -LiteralPath (Join-Path $out 'console.log') | Out-Null
$failure = $null
$residue = @()
try {
    if ($CleanupOnly) {
        Write-Step 'Removing what an earlier run left behind'
        return # The finally block below does the work.
    }
    if (-not $BuildOnly -and (Test-Elevated)) {
        throw 'Run this from a normal PowerShell window, not as administrator: the spike tests a per-user install.'
    }
    $before = Get-Residue
    if (-not $BuildOnly -and $before.Count -gt 0) {
        $before | ForEach-Object { Write-Host "Found from an earlier run: $_" }
        throw 'An earlier run left things behind. Run .\Run-S6.ps1 -CleanupOnly first.'
    }
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
        return
    }

    $unzippedExe = Join-Path $unzipped $exeName
    Invoke-Phase 'unzipped' $unzippedExe {
        Start-Process -FilePath $unzippedExe -ArgumentList @('run', '--label', 'unzipped', '--results', "`"$out`"") | Out-Null
    }
    # Phase B starts without phase A's registration or toasts, so it shows what the installed exe does on its own.
    Clear-SpikeRegistration

    Write-Step 'Installing the spike for this user only'
    $installLog = Join-Path $out 'install.log'
    $installer = Start-Process -FilePath $setup -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER', "/LOG=`"$installLog`"") -Wait -PassThru
    $installedExe = Join-Path $installDir $exeName
    if ($installer.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $installedExe) -or -not (Test-Path -LiteralPath $shortcut)) {
        throw "The installer failed (exit code $($installer.ExitCode)); see $installLog."
    }
    Invoke-Phase 'installed' $installedExe {
        # From the Start menu shortcut, as a user starts an installed app; the shortcut carries the spike's AUMID.
        Start-Process -FilePath $shortcut | Out-Null
    }
}
catch {
    $failure = $_.Exception.Message
    Write-Host "S6 run stopped: $failure" -ForegroundColor Red
}
finally {
    if (-not $BuildOnly) {
        Write-Step 'Cleaning up: the spike, its app ID registration, its toasts and the test install'
        Stop-SpikeProcesses
        Clear-SpikeRegistration
        Remove-TestInstall
        $logFile = Join-Path $launchFolder 'launches.log'
        if (Test-Path -LiteralPath $logFile) { Copy-Item -LiteralPath $logFile -Destination (Join-Path $out 'launches.log') }
        if (Test-Path -LiteralPath $launchFolder) { Remove-Item -LiteralPath $launchFolder -Recurse -Force }
        foreach ($binary in @($publish, $unzipped, $zip, $setup)) {
            if (Test-Path -LiteralPath $binary) { Remove-Item -LiteralPath $binary -Recurse -Force }
        }
        $residue = Get-Residue
        if ($residue.Count -eq 0) { Write-Host 'Nothing was left behind.' -ForegroundColor Green }
        else { $residue | ForEach-Object { Write-Host "LEFT BEHIND: $_" -ForegroundColor Red } }
        if (-not $CleanupOnly) {
            Write-Summary $residue $failure
            Write-Host "Summary: $(Join-Path $out 'summary.md')"
        }
    }
    Stop-Transcript | Out-Null
}
if ($failure -or $residue.Count -gt 0) { exit 1 }
exit 0
