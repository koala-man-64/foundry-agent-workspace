import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Windows PowerShell 5.1 keeps its module analysis cache in the profile's local application data. These oracles give each
 * command a scratch USERPROFILE, so without a cache every unqualified cmdlet (the offline demo's `Write-Output`, the command
 * helper's `Add-Type`) first analyses every installed module. On a CI image with AWSPowerShell, Microsoft.Graph and SqlServer
 * that takes 10 to 60 seconds and breaks the commands' own timeouts. One warm-up builds the cache under its own scratch
 * profile; each fixture's profile then starts with a copy, as a real profile would. What runs and what it prints are
 * unchanged: PowerShell still reports its first-use progress. The native suite seeds its profiles the same way.
 */
const relative = path.join('AppData', 'Local', 'Microsoft', 'Windows', 'PowerShell', 'ModuleAnalysisCache');
// Resolved at import, before an oracle redirects TEMP to its scratch folder.
const base = tmpdir();
const shared = path.join(base, 'foundry-p2-powershell-module-cache', 'ModuleAnalysisCache');
// PowerShell saves the cache on a delayed timer, so the warm-up waits for the file and for its size to settle.
const script = [
  'Get-Command -CommandType Cmdlet, Function | Out-Null',
  "$cache = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Microsoft\\Windows\\PowerShell\\ModuleAnalysisCache'",
  '$deadline = [DateTime]::UtcNow.AddMinutes(5)',
  'while (-not (Test-Path -LiteralPath $cache) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }',
  '$size = -1',
  'while ((Test-Path -LiteralPath $cache) -and (Get-Item -LiteralPath $cache).Length -ne $size -and [DateTime]::UtcNow -lt $deadline) { $size = (Get-Item -LiteralPath $cache).Length; Start-Sleep -Milliseconds 500 }',
].join('; ');
let warmed: string | null | undefined;

/** Builds the shared cache once; null when PowerShell saved none, in which case profiles stay cold. */
export function warmPowerShellModuleCache(): string | null {
  if (warmed !== undefined) return warmed;
  if (fs.existsSync(shared)) return (warmed = shared);
  const systemRoot = process.env.SystemRoot!;
  const scratch = fs.mkdtempSync(path.join(base, 'foundry-p2-powershell-warm-'));
  try {
    const profile = path.join(scratch, 'profile');
    fs.mkdirSync(path.join(profile, 'AppData', 'Local'), { recursive: true });
    const env = {
      SystemRoot: systemRoot, WINDIR: systemRoot, ComSpec: path.join(systemRoot, 'System32', 'cmd.exe'), PATHEXT: '.COM;.EXE;.BAT;.CMD',
      PATH: [path.join(systemRoot, 'System32'), systemRoot, path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(';'),
      TEMP: scratch, TMP: scratch, USERPROFILE: profile,
    };
    const shell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { env, cwd: scratch, stdio: 'ignore', windowsHide: true, timeout: 600_000 });
    const built = path.join(profile, relative);
    if (!fs.existsSync(built)) return (warmed = null);
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    const staged = `${shared}.${process.pid}.tmp`;
    fs.copyFileSync(built, staged);
    fs.renameSync(staged, shared);
    return (warmed = shared);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Starts a scratch profile with the warm cache, as a profile PowerShell has run under before would have. */
export function seedPowerShellModuleCache(profile: string): void {
  const cache = warmPowerShellModuleCache();
  if (cache === null) return;
  const target = path.join(profile, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(cache, target);
}
