import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const run = promisify(execFile);

/** Create a private per-backup directory before any database bytes are copied into it. */
export async function protectedBackupPath(parent: string, filename: string): Promise<string> {
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(parent, 'private-'));
  try {
    if (process.platform === 'win32') await restrictWindowsDirectory(directory);
    else {
      await chmod(directory, 0o700);
      if (((await stat(directory)).mode & 0o777) !== 0o700) throw new Error('Backup directory permissions could not be verified.');
    }
    return join(directory, filename);
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw new Error('Backup directory protection failed; the database was not changed.', { cause: error });
  }
}

const restrictAndVerify = String.raw`
$ErrorActionPreference = 'Stop'
$backup = $env:FOUNDRY_BACKUP_DIRECTORY
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sddl = 'O:' + $owner + 'D:P(A;OICI;FA;;;' + $owner + ')(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetSecurityDescriptorSddlForm($sddl)
Set-Acl -LiteralPath $backup -AclObject $acl
$actual = Get-Acl -LiteralPath $backup
$allowed = @($owner, 'S-1-5-18', 'S-1-5-32-544')
$rules = @($actual.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))
if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $owner -or $rules.Count -ne 3) { throw 'Backup ACL protection or owner verification failed.' }
foreach ($rule in $rules) {
  if ($allowed -notcontains $rule.IdentityReference.Value -or $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or $rule.IsInherited -or $rule.InheritanceFlags -ne ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit)) { throw 'Backup ACL contains an unexpected access rule.' }
}
foreach ($sid in $allowed) { if (@($rules | Where-Object { $_.IdentityReference.Value -eq $sid }).Count -ne 1) { throw 'Backup ACL is missing a required access rule.' } }
`;

async function restrictWindowsDirectory(directory: string): Promise<void> {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const shell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(restrictAndVerify, 'utf16le').toString('base64');
  await run(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true,
    timeout: 15_000,
    env: { SystemRoot: systemRoot, WINDIR: systemRoot, FOUNDRY_BACKUP_DIRECTORY: directory },
  });
  // The PowerShell process verified the ACL after writing it. No backup data exists before this point.
}
