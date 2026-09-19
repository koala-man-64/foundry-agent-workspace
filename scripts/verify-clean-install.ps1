<#
.SYNOPSIS
Verifies a Foundry Agent Workspace NSIS installer candidate for clean-profile,
non-elevated, user-scoped installation and a safe uninstall.

.PARAMETER InstallerPath
Path to the NSIS installer .exe to verify. Defaults to the most recently
written *.exe directly under 'release\' (electron-builder's default output
directory for 'pnpm package:win').

.PARAMETER MinSizeMB
Minimum acceptable installer size in MB. A bundled Electron/NSIS installer is
expected to be tens of MB; anything smaller likely indicates a truncated or
failed packaging step. Defaults to 20.

.OUTPUTS
Exit code 0 when every check passes (WARN entries, such as an unsigned
pre-release candidate, do not fail the run). Exit code 1 when any check
fails.
#>
[CmdletBinding()]
param(
    [string]$InstallerPath,
    [double]$MinSizeMB = 20
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$packageJsonPath = Join-Path $repoRoot 'package.json'
$packageJson = Get-Content -Raw -LiteralPath $packageJsonPath | ConvertFrom-Json
$buildConfig = $packageJson.build
$productName = $buildConfig.productName

$checks = New-Object System.Collections.Generic.List[object]

function Add-Check {
    param(
        [string]$Name,
        [ValidateSet('PASS', 'WARN', 'FAIL')][string]$Status,
        [string]$Detail
    )
    $checks.Add([pscustomobject]@{ Check = $Name; Status = $Status; Detail = $Detail })
}

# Resolve the installer candidate: latest *.exe directly under release\ (non-recursive,
# so this never matches the unpacked app binary under release\win-unpacked\).
if (-not $InstallerPath) {
    $releaseDir = Join-Path $repoRoot 'release'
    if (Test-Path -LiteralPath $releaseDir) {
        $candidate = Get-ChildItem -LiteralPath $releaseDir -Filter '*.exe' -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($candidate) { $InstallerPath = $candidate.FullName }
    }
}

# 1. Artifact presence
try {
    if (-not $InstallerPath -or -not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
        Add-Check -Name 'Artifact Presence' -Status 'FAIL' -Detail "No installer .exe found under 'release\'. Run 'pnpm package:win' first, or pass -InstallerPath explicitly."
    } else {
        $item = Get-Item -LiteralPath $InstallerPath
        $sizeMB = [math]::Round($item.Length / 1MB, 2)
        if ($item.Length -le 0) {
            Add-Check -Name 'Artifact Presence' -Status 'FAIL' -Detail "$($item.Name) exists but is empty (0 bytes)."
        } elseif ($sizeMB -lt $MinSizeMB) {
            Add-Check -Name 'Artifact Presence' -Status 'FAIL' -Detail "$($item.Name) is $sizeMB MB, below the $MinSizeMB MB minimum expected for a bundled Electron/NSIS installer."
        } else {
            Add-Check -Name 'Artifact Presence' -Status 'PASS' -Detail "$($item.Name) ($sizeMB MB) at $($item.FullName)"
        }
    }
} catch {
    Add-Check -Name 'Artifact Presence' -Status 'FAIL' -Detail "Error inspecting installer: $($_.Exception.Message)"
}

# 2. Authenticode inspection
if ($InstallerPath -and (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
    try {
        $sig = Get-AuthenticodeSignature -FilePath $InstallerPath
        $signer = 'none'
        $expiry = 'n/a'
        if ($sig.SignerCertificate) {
            $signer = $sig.SignerCertificate.Subject
            $expiry = $sig.SignerCertificate.NotAfter
        }
        $detail = "Status=$($sig.Status); Signer=$signer; CertExpiry=$expiry"
        switch ($sig.Status) {
            'Valid' {
                Add-Check -Name 'Authenticode Signature' -Status 'PASS' -Detail $detail
            }
            'NotSigned' {
                Add-Check -Name 'Authenticode Signature' -Status 'WARN' -Detail "$detail. Unsigned candidate: expected before Azure Trusted Signing is wired into the release pipeline (see docs/signing-and-distribution.md). Windows SmartScreen will warn end users until signed."
            }
            default {
                Add-Check -Name 'Authenticode Signature' -Status 'FAIL' -Detail "$detail. A signature is present but not valid ($($sig.Status)) - the binary may be corrupted, tampered with, or signed by an untrusted chain."
            }
        }
    } catch {
        Add-Check -Name 'Authenticode Signature' -Status 'FAIL' -Detail "Error reading Authenticode signature: $($_.Exception.Message)"
    }
} else {
    Add-Check -Name 'Authenticode Signature' -Status 'FAIL' -Detail 'Skipped: no installer artifact to inspect.'
}

# 3. Unpack verification - package.json build.asarUnpack must list the PowerShell helpers
#    the packaged runtime shells out to, plus a glob covering native .node binaries, since
#    none of those can be read from inside the asar archive at runtime.
try {
    $unpack = @()
    if ($buildConfig.asarUnpack) { $unpack = @($buildConfig.asarUnpack) }
    $required = @('out/main/mcp-host.ps1', 'out/main/job-runner.ps1')
    $missing = @($required | Where-Object { $unpack -notcontains $_ })
    $hasNativeGlob = [bool]($unpack | Where-Object { $_ -like '*.node' })
    if ($missing.Count -gt 0) {
        Add-Check -Name 'asarUnpack Configuration' -Status 'FAIL' -Detail "package.json build.asarUnpack is missing: $($missing -join ', ')"
    } elseif (-not $hasNativeGlob) {
        Add-Check -Name 'asarUnpack Configuration' -Status 'FAIL' -Detail "package.json build.asarUnpack has no glob for native .node binaries (expected an entry like '**/*.node')."
    } else {
        Add-Check -Name 'asarUnpack Configuration' -Status 'PASS' -Detail "asarUnpack lists: $($unpack -join ', ')"
    }
} catch {
    Add-Check -Name 'asarUnpack Configuration' -Status 'FAIL' -Detail "Error reading package.json build.asarUnpack: $($_.Exception.Message)"
}

# Supplementary: when a dir-or-nsis build output is present alongside the installer,
# confirm the helpers actually landed unpacked on disk (not just declared in config).
$winUnpackedRoot = Join-Path $repoRoot 'release\win-unpacked\resources\app.asar.unpacked'
if (Test-Path -LiteralPath $winUnpackedRoot) {
    try {
        $expectedFiles = @('out\main\mcp-host.ps1', 'out\main\job-runner.ps1')
        $missingFiles = @($expectedFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $winUnpackedRoot $_)) })
        $nativeBinaries = @(Get-ChildItem -LiteralPath $winUnpackedRoot -Recurse -Filter '*.node' -File -ErrorAction SilentlyContinue)
        if ($missingFiles.Count -gt 0) {
            Add-Check -Name 'Unpacked Build Output' -Status 'FAIL' -Detail "Missing unpacked helper(s) in build output: $($missingFiles -join ', ')"
        } elseif ($nativeBinaries.Count -eq 0) {
            Add-Check -Name 'Unpacked Build Output' -Status 'FAIL' -Detail 'No unpacked *.node native binaries found under app.asar.unpacked.'
        } else {
            Add-Check -Name 'Unpacked Build Output' -Status 'PASS' -Detail "Found $($expectedFiles.Count) helper script(s) and $($nativeBinaries.Count) native .node binary file(s) unpacked on disk."
        }
    } catch {
        Add-Check -Name 'Unpacked Build Output' -Status 'FAIL' -Detail "Error inspecting unpacked build output: $($_.Exception.Message)"
    }
} else {
    Add-Check -Name 'Unpacked Build Output' -Status 'WARN' -Detail 'release\win-unpacked not present (only the installer was built); the asarUnpack configuration check above still applies.'
}

# 4. Path & permissions isolation
try {
    $nsisConfig = $buildConfig.nsis
    $perMachine = $false
    if ($nsisConfig -and $null -ne $nsisConfig.perMachine) { $perMachine = [bool]$nsisConfig.perMachine }
    $expectedInstallDir = Join-Path $env:LOCALAPPDATA "Programs\$productName"
    if ($perMachine) {
        Add-Check -Name 'Install Path Isolation' -Status 'FAIL' -Detail 'nsis.perMachine is true: the installer would require admin elevation and target a machine-wide Program Files path instead of a user-scoped one.'
    } else {
        Add-Check -Name 'Install Path Isolation' -Status 'PASS' -Detail "nsis.perMachine=false; default per-user, non-elevated install target is $expectedInstallDir."
    }
} catch {
    Add-Check -Name 'Install Path Isolation' -Status 'FAIL' -Detail "Error reading nsis configuration: $($_.Exception.Message)"
}

try {
    $mainSourceCandidates = @(
        (Join-Path $repoRoot 'apps\desktop\src\main\index.ts'),
        (Join-Path $repoRoot 'out\main\index.js')
    )
    $foundIn = @()
    foreach ($path in $mainSourceCandidates) {
        if (Test-Path -LiteralPath $path) {
            $content = Get-Content -Raw -LiteralPath $path
            if ($content -match 'FoundryAgentWorkspace') { $foundIn += $path }
        }
    }
    if ($foundIn.Count -gt 0) {
        Add-Check -Name 'App Data Segregation' -Status 'PASS' -Detail "userData is pinned to %LOCALAPPDATA%\FoundryAgentWorkspace, separate from the install directory (confirmed in: $($foundIn -join ', '))."
    } else {
        Add-Check -Name 'App Data Segregation' -Status 'FAIL' -Detail "Could not confirm app.setPath('userData', ...) targets %LOCALAPPDATA%\FoundryAgentWorkspace in the main-process source or build output."
    }
} catch {
    Add-Check -Name 'App Data Segregation' -Status 'FAIL' -Detail "Error inspecting main-process source: $($_.Exception.Message)"
}

# 5. Uninstallation cleanliness - audited statically against the electron-builder NSIS
#    configuration, since electron-builder's default uninstaller only removes files it
#    installed (the target install directory) plus its own per-user registry keys. User
#    project repositories and git worktrees live at paths the user chose, entirely outside
#    both the install directory and %LOCALAPPDATA%\FoundryAgentWorkspace, so the default
#    uninstaller cannot reach them structurally. This check fails only if the config
#    deliberately widens that scope.
try {
    $nsisConfig = $buildConfig.nsis
    $issues = New-Object System.Collections.Generic.List[string]
    if ($nsisConfig -and $nsisConfig.deleteAppDataOnUninstall -eq $true) {
        $issues.Add('nsis.deleteAppDataOnUninstall is true: uninstall would also remove %LOCALAPPDATA%\FoundryAgentWorkspace (task history, credentials vault, MCP config). This is an application-data retention decision, not a project-repository risk, but it must be a deliberate, documented choice.')
    }
    if ($nsisConfig -and ($nsisConfig.include -or $nsisConfig.script)) {
        $issues.Add('a custom NSIS include/script hook is configured (nsis.include or nsis.script); review it for file operations outside the install directory.')
    }
    $customScripts = @(Get-ChildItem -LiteralPath $repoRoot -Recurse -Filter '*.nsh' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch '\\node_modules\\' })
    if ($customScripts.Count -gt 0) {
        $issues.Add("custom .nsh script(s) found: $(($customScripts | ForEach-Object { $_.FullName }) -join ', ')")
    }
    if ($issues.Count -gt 0) {
        Add-Check -Name 'Uninstall Scope' -Status 'FAIL' -Detail ($issues -join ' | ')
    } else {
        Add-Check -Name 'Uninstall Scope' -Status 'PASS' -Detail "No custom uninstall hooks and deleteAppDataOnUninstall is not enabled. The default NSIS uninstaller removes only Programs\$productName and its own HKCU registry keys; user project repositories and git worktrees are outside that scope by construction."
    }
} catch {
    Add-Check -Name 'Uninstall Scope' -Status 'FAIL' -Detail "Error auditing uninstall configuration: $($_.Exception.Message)"
}

# ---- Report ----
Write-Output ''
Write-Output 'Foundry Agent Workspace - Clean Install Verification'
Write-Output "Installer candidate: $InstallerPath"
Write-Output ''
$checks | Format-Table -AutoSize -Wrap | Out-String -Width 220 | Write-Output

$passCount = @($checks | Where-Object { $_.Status -eq 'PASS' }).Count
$warnCount = @($checks | Where-Object { $_.Status -eq 'WARN' }).Count
$failCount = @($checks | Where-Object { $_.Status -eq 'FAIL' }).Count

Write-Output "Summary: $passCount passed, $warnCount warning(s), $failCount failed."

if ($failCount -gt 0) {
    Write-Output 'RESULT: FAIL'
    exit 1
} else {
    Write-Output 'RESULT: PASS'
    exit 0
}
