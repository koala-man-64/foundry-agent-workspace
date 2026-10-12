# S6 desktop run — 11 October 2026

**Measured activation: inconclusive. Human disposition: accepted by Rudy on 11 October 2026.** This was an isolated desktop spike, not product or shipped-installer validation. S4 did not run as part of this trial.

Rudy said: “its fine, the toasts and notifications are working. ill figure out how to turn off \"do not disturb\"”, then explicitly asked to record his S6 acceptance. He accepts the current toast behavior without a further S6 retest or fallback. He will handle Windows notification suppression. This is a human acceptance decision; the incomplete banner evidence and unzipped observation/log conflict below remain unchanged. S6's human decision is resolved; S4 still needs its own result/decision before P0 can close. This acceptance does not authorize main integration.

Source: `e5517ac410f7ab6d5099a380b4114a25e5247f69`, prepared worktree `C:\Users\rdpro\Projects\foundry-agent-workspace-s6`. The run began at 06:31 Chicago time and completed at 07:05. The direct runner executed in the Codex Terminal panel in a normal session; its non-elevated/pre-existing-residue guards admitted the run. Inno Setup 6.7.3 was installed per-user. The broken `C:\tmp\s6\Start-S6.ps1` wrapper was bypassed and unchanged.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\Foundry.Spikes.Toast\Run-S6.ps1 -IsccPath 'C:\Users\rdpro\AppData\Local\Programs\Inno Setup 6\ISCC.exe'
```

Computer-use drove the spike controls; Rudy clicked the Windows toasts and supplied observations. Trials placed the spike behind another window or minimized as required. Banner retries did not yield a clicked activation. Rudy reported that a running game suppressed notifications; Do not disturb was off. Logs usually reported `busy (a full-screen app)` even after the game exited; one unzipped banner reported `accepts notifications` but timed out without activation. This does not establish the cause of all suppression.

| Step | Unzipped | Installed |
|---|---|---|
| 1. Minimized banner | Inconclusive: no activation event after repeated banner timeouts | Inconclusive: immediate timeout, no activation |
| 2. Banner behind another window | Inconclusive: timeout, no activation | Inconclusive: timeout, no activation |
| 3. Notification Center | Conflicting evidence: Rudy said toast present and spike forward; no activation event in JSONL. Not certified | Pass: matching nonce/arguments, `wasInFront:false`, `inFrontAfter800ms:true`; Rudy agreed |
| 4. Taskbar flash | Logged while behind another window; Rudy observed flash | Logged while behind another window; Rudy observed flash |
| 5. Closed-app toast | Rudy: “clicked it and codex app flashed” | Rudy: “clicked it; nothing happened” |

Neither step-5 phase recorded a launch or interactive restart; the runner found zero spike processes three seconds after the confirmation. These closed-app observations do not prove in-process activation or choose a fallback. No valid foreground trial demonstrated a failure, but steps 1–3 did not pass in both phases. Exit code alone is not acceptance evidence. The generated summary has an `unknown` notifier label in its unzipped verdict heading; its detailed phase section and final setting report Enabled. The raw summary is retained unchanged.

## Cleanup

The runner reported no residue or cleanup errors. The uninstaller logged `Uninstallation process succeeded`, `Removed all? Yes`, and no restart needed; earlier in-use deletion attempts were resolved by its later retry. Independent checks after completion found:

- No `Foundry.Spikes.Toast` process.
- No per-user test install folder, Start menu shortcut, or uninstall entry `{CE1A3DDF-7D9D-4FF8-8888-D8AA5D1700AD}_is1`.
- No HKCU AUMID registration or per-app notification settings key for `Foundry.Spikes.S6Toast`.
- No temporary `Foundry.Spikes.S6Toast` launch folder; no executable build outputs remained in the run directory.
- Rudy confirmed “No, it is absent” when checking Windows Settings → System → Notifications for the spike entry. This is human visible-surface evidence, separate from registry checks.

The runner invoked scoped toast-history clearing twice. Windows' internal notification database, jump lists and app-usage history were not inspected or claimed erased. No `-CleanupOnly` recovery was needed. Inno Setup remains installed.

## Evidence and remaining decisions

Original evidence remains under `test-results\spikes\s6-toast-activation\20261011-063102` in the prepared worktree. The ten adjacent files are unchanged copies: [generated summary](summary.md), [unzipped JSONL](phase-unzipped.jsonl), [installed JSONL](phase-installed.jsonl), phase reports, step-5 reports, [console](console.log), [install](install.log) and [uninstall](uninstall.log). No executable artifacts are included.

Rudy's acceptance requires no further S6 retest, COM-activator exploration or fallback change. Any future exploration and main integration still require their own authorization. No product API change, wrapper repair, real-data access, S4 execution or main integration occurred in this S6 run. Explorer/browser drags, side buttons, touch, pen and touchpad were **not tested** for S4 in this run.
