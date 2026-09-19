# Signing and distribution

Phase 05, Workstream C. Covers the Windows NSIS installer produced by
`pnpm package:win`: its Authenticode signature disposition, how to install
into a clean profile for qualification, and what uninstall does and does not
remove. Verification for all three is automated in
`scripts/verify-clean-install.ps1` (see [Automated verification](#automated-verification)).

## Authenticode signature disposition

### Current state: unsigned

No code-signing certificate is wired into the packaging pipeline yet.
`pnpm package:win` invokes `signtool.exe` during the electron-builder build,
but with no `CSC_LINK`/`CSC_KEY_PASSWORD` (or Azure Trusted Signing
equivalent, below) configured, the resulting binaries are **not signed**:
`Get-AuthenticodeSignature` reports `NotSigned`. This is expected for local
and CI dev builds today and is not treated as a failure by
`verify-clean-install.ps1` (it is reported as a warning) — but it must not be
the state of a build offered for install outside the engineering team.

### SmartScreen handling for unsigned builds

An unsigned installer triggers Windows SmartScreen's "Windows protected your
PC" interstitial on first run, for both the installer and the installed
application executable. Until signing is wired in:

- Qualification and internal dry runs must go through "More info" ->
  "Run anyway" deliberately, and that step must be recorded as an accepted
  deviation in the qualification evidence, not silently clicked through.
- The installer must not be distributed outside the engineering team while
  unsigned. There is no reputation-building shortcut around SmartScreen other
  than a trusted signature; an unsigned binary accumulating install counts
  does not reduce the warning.
- Do not ask testers to disable SmartScreen, add exclusions, or change
  execution policy to work around the warning — that masks the real
  pre-release state instead of fixing it.

### Azure Trusted Signing configuration (target state)

The release pipeline should sign through
[Azure Trusted Signing](https://learn.microsoft.com/azure/trusted-signing/overview)
rather than a self-managed EV certificate:

1. Provision a Trusted Signing account and a certificate profile scoped to
   this app's publisher identity (one-time Azure setup, outside this repo).
2. In CI, authenticate to Azure (workload identity federation / OIDC
   preferred over a stored secret) and install the
   [Trusted Signing dlib](https://learn.microsoft.com/azure/trusted-signing/how-to-signing-integrations)
   for `signtool.exe`.
3. Configure electron-builder's Windows `sign` hook (`build.win.sign` in
   `package.json`, or a `beforeBuild`/custom sign script) to invoke
   `signtool.exe sign /fd SHA256 /tr <timestamp-url> /td SHA256 /dlib
   <Azure.CodeSigning.Dlib.dll> /dmdf <metadata.json>` against both
   `release\win-unpacked\<product>.exe` and the generated
   `release\<product> Setup <version>.exe`. electron-builder signs the
   unpacked executable and the NSIS installer as separate steps in the same
   build; both must be covered.
4. Never commit the Trusted Signing metadata file, certificate, or Azure
   credentials to this repository. They belong in CI secret storage /
   workload identity configuration only.
5. Re-run `scripts/verify-clean-install.ps1` against the signed candidate.
   `Get-AuthenticodeSignature` should report `Valid` with a signer subject
   matching the Trusted Signing certificate profile; the script promotes
   that from a warning to a pass and records the signer and certificate
   expiry in its output.

Until step 3 is wired into CI, treat every installer as unsigned per the
section above.

## Clean-profile installation steps

Qualification must be run against a clean Windows profile (no prior install,
no leftover `%LOCALAPPDATA%\FoundryAgentWorkspace` or registry keys), so that
first-run behavior matches what a new user sees.

1. **Prepare a clean profile.** Use a fresh Windows sandbox/VM, or a
   dedicated local test account that has never had this app installed. Do
   not reuse a profile from a previous qualification pass without first
   completing the uninstall steps below and confirming the paths in
   [Retention policy](#retention-policy-for-user-data-and-repositories-upon-uninstallation)
   are gone.
2. **Build the candidate.** `pnpm build && pnpm package:win` from a clean
   worktree at the commit being qualified. Output lands in `release\`.
3. **Run automated verification first.**
   `powershell -File scripts\verify-clean-install.ps1` against the built
   `.exe` before any manual step — it catches configuration regressions
   (elevation, unpack, uninstall scope) cheaply, before a human spends time
   on a manual install.
4. **Run the installer as the test account**, not an elevated/admin prompt.
   The installer must not request UAC elevation (`nsis.perMachine: false`);
   if Windows prompts for administrator credentials, that is a packaging
   regression, not an expected step.
5. **Confirm the install location** is
   `%LOCALAPPDATA%\Programs\Foundry Agent Workspace` (per-user, no admin
   rights implied), not `%ProgramFiles%`.
6. **Launch the app** and confirm first run creates
   `%LOCALAPPDATA%\FoundryAgentWorkspace` (application data: task database,
   credential vault, MCP configuration) separate from the install directory,
   and that no files are written outside those two locations or a project
   path the user explicitly opens.
7. **Exercise the packaged smoke path**: open or create a project, run a
   coding task through at least one approval, and confirm the git worktree
   it creates lives under the project's own repository, not under either
   app-owned directory.
8. **Record evidence**: `verify-clean-install.ps1` output, a screenshot of
   the install location and first-run state, and the Authenticode status
   actually observed (expected `NotSigned` until Trusted Signing is wired
   in; anything else is a regression to investigate before proceeding).

## Retention policy for user data and repositories upon uninstallation

Uninstall is performed through Windows "Apps & features" (per-user, no
elevation required, matching the per-user install) or by running the
generated uninstaller directly.

**What uninstall removes:**

- The install directory, `%LOCALAPPDATA%\Programs\Foundry Agent Workspace`,
  and everything under it (application binaries, `resources\app.asar`, the
  unpacked helpers and native modules).
- The per-user (`HKCU`) uninstall registry entry electron-builder's NSIS
  target creates for the app. No `HKLM` (machine-wide) keys are written or
  removed, consistent with the per-user, non-elevated install.

**What uninstall does not remove, by default:**

- `%LOCALAPPDATA%\FoundryAgentWorkspace` — the application data directory
  (task history database, credential vault, MCP server configuration).
  `nsis.deleteAppDataOnUninstall` is not set, so electron-builder's default
  (leave application data in place) applies. This is a deliberate choice:
  a user who reinstalls keeps their task history and configured MCP
  servers, and an accidental or exploratory uninstall does not silently
  destroy the credential vault. A user who wants a fully clean removal must
  delete `%LOCALAPPDATA%\FoundryAgentWorkspace` manually after
  uninstalling; this should be called out in end-user uninstall guidance
  if/when one is written, rather than automated, so it stays an explicit
  user decision.
- **User project repositories and git worktrees.** These live at paths the
  user chose when opening a project (anywhere on disk, entirely outside
  both `%LOCALAPPDATA%\Programs\Foundry Agent Workspace` and
  `%LOCALAPPDATA%\FoundryAgentWorkspace`). The app never registers those
  paths with the installer/uninstaller, so the default NSIS uninstaller has
  no mechanism to reach them — this is a structural guarantee of the
  per-user install layout, not a filter or exclusion list that could be
  bypassed by a future config change. Any future packaging change that adds
  a custom NSIS uninstall hook (`nsis.include` / `nsis.script`, or a
  `.nsh` file) must be reviewed against this guarantee before it ships;
  `verify-clean-install.ps1`'s "Uninstall Scope" check fails the build if
  such a hook appears without this document being updated to explain it.

## Automated verification

`scripts/verify-clean-install.ps1 [-InstallerPath <path>] [-MinSizeMB <n>]`
checks, against the installer candidate (default: the newest `*.exe`
directly under `release\`):

| Check | What it verifies |
| --- | --- |
| Artifact Presence | The installer `.exe` exists and is a plausible size for a bundled Electron/NSIS build. |
| Authenticode Signature | Signer, status and certificate expiry via `Get-AuthenticodeSignature`; `NotSigned` warns (see above), an invalid/tampered signature fails. |
| asarUnpack Configuration | `package.json` `build.asarUnpack` lists `out/main/mcp-host.ps1`, `out/main/job-runner.ps1` and a native `.node` glob. |
| Unpacked Build Output | When `release\win-unpacked` is present, confirms those helpers and native binaries actually landed unpacked on disk. |
| Install Path Isolation | `nsis.perMachine` is `false`, so install targets the per-user `%LOCALAPPDATA%\Programs\Foundry Agent Workspace` path without elevation. |
| App Data Segregation | The main process pins `userData` to `%LOCALAPPDATA%\FoundryAgentWorkspace`, separate from the install directory. |
| Uninstall Scope | No `nsis.deleteAppDataOnUninstall`, custom NSIS include/script hook, or `.nsh` file widens uninstall beyond the install directory and its own registry keys. |

Exit code `0` means every check passed (warnings, such as an unsigned
pre-signing-pipeline candidate, do not fail the run); `1` means at least one
check failed. Run it as part of every packaging change and before any
qualification pass.
