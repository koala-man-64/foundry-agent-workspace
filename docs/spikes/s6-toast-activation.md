# Spike S6: toast click activation

**Question** ([plan](../wpf-webview2-migration.md), section 3 and the spike table): does clicking a toast bring the app to the front, both from the unzipped exe and from the per-user installed exe?

**Exit criterion:** it works, or the fallback ships. The fallback is the in-app Inbox plus a taskbar flash.

**How it runs (Rudy's choice, 8 October 2026):** on Rudy's desktop, with him present. Afterwards the per-user app ID registration and the test install are removed.

## What it tests

The plan's toast design:
- WinRT's `ToastNotificationManager`, with the app's AUMID registered under HKCU.
- On the in-process `Activated` event, the host shows and focuses the window and routes, as Electron's `index.ts:63` does.

The spike app, `tests/Foundry.Spikes.Toast`, has the product's relevant traits:
- a GUI-subsystem exe, like `Foundry.exe`;
- the WinRT projection through the `net10.0-windows10.0.19041.0` target framework, with no extra package;
- a self-contained win-x64 publish, as P4 publishes;
- a test-only AUMID, `Foundry.Spikes.S6Toast`. It is distinct from the Electron app's `com.rudy.foundryagentworkspace`, so the real app's notifications are never touched.

`Run-S6.ps1` runs two phases:
- **Phase A, the unzipped exe:** the publish folder is zipped and unzipped, then the exe runs from there.
- **Phase B, the installed exe:** the script installs the spike for this user only with an Inno Setup installer (`PrivilegesRequired=lowest`), as decision 6 ships. It then starts the spike from its Start menu shortcut, which carries the same AUMID.

Each phase opens a window with five steps:

| Step | You do | The app measures |
|---|---|---|
| 1. Banner while minimized | Click the banner after the window minimizes itself | `Activated` fired, the arguments matched the toast, and the window really came to the front |
| 2. Banner while another window is in front | Click another window, then the banner | Same |
| 3. Notification Center | Let the banner time out, then click the toast in Notification Center | Same, plus the banner's time-out |
| 4. Taskbar flash, the fallback | Click another window; the taskbar button should flash | Whether the window was in front when it flashed |
| 5. A toast after the app has closed | Click the toast in Notification Center once the app is gone | Whether Windows started the spike again |

Each step has yes/no questions for what you see, and an optional note.

"Really came to the front" is measured: `GetForegroundWindow` 800 ms after activation. Windows may refuse to let a background app take the foreground and flash its taskbar button instead; that is exactly what this spike needs to know.
- **Valid trials only.** A trial counts only if the window was *not* in front when you clicked the toast. Otherwise "in front" proves nothing; the step then says so and asks you to start again. Only the first activation of each toast counts.
- **Who kept the foreground.** When the window does not come forward, the app records which program kept the foreground. It records the program's name only, in the local results; mind that if you share the summary.

The spike activates the window the plan's way: in process, the way Electron's `window.show(); window.focus()` does. If that cannot take the foreground, a COM toast activator is the untested alternative before the fallback ships. With a COM activator, Windows starts or calls the app out of process and lets it come forward.

**Out of scope:** the spike's ZIP is extracted with .NET, so its files carry no mark-of-the-web. A ZIP downloaded with a browser and unzipped with Explorer does carry it. That affects SmartScreen when the app first starts, not toast activation.

Step 5 is informational. If Windows restarts the spike from the toast, the spike treats the arguments as untrusted, as the plan requires: it records them, shows a message, and does nothing else.

## What it changes on your machine, and how it is undone

| Created by | Item | Removed by |
|---|---|---|
| The spike, at start | `HKCU\Software\Classes\AppUserModelId\Foundry.Spikes.S6Toast` (a display name and a `FoundrySpike` marker) | The script, after each phase and at the end; only if the marker is there |
| The spike | Its toasts in Notification Center | The script, which clears that app ID's toast history |
| Windows, possibly | `HKCU\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\Foundry.Spikes.S6Toast` | The script |
| The installer | `%LOCALAPPDATA%\Programs\Foundry S6 toast spike`, the Start menu shortcut *Foundry S6 toast spike*, and the uninstall entry `{CE1A3DDF-7D9D-4FF8-8888-D8AA5D1700AD}_is1` | The silent uninstaller. The script waits for it, then checks each item |
| The spike, if Windows restarts it from a toast | `%TEMP%\Foundry.Spikes.S6Toast\launches.log` | The script, after copying it into the results |
| The build | The published app, the ZIP and the installer, under `test-results` | The script; logs and results stay |

Cleanup runs whatever happens, including after an error, and touches only these exact names:
- Each cleanup step runs on its own, so one failure cannot skip the others, the residue check or the summary.
- The script checks twice, 3 seconds apart, because Windows can write the per-app notification settings just after the last toast.
- Afterwards it prints `Nothing was left behind`, or a `LEFT BEHIND` line for each item that remains, plus any cleanup problem.
- Windows' own records of apps it has seen are not checked: the notification database, jump lists and app-usage history.

**One run at a time.** A second copy of the script refuses to start while one is running; a lock file under `test-results` holds it. It also refuses to start, before creating anything, when an earlier run left something behind.

If a run is interrupted, for example by closing the terminal, run it again with `-CleanupOnly`. That also deletes the build outputs that every earlier run left under `test-results`.

An app ID key without the spike's marker was not made by the spike. The script leaves it alone and reports it; remove it by hand only if it is yours to remove.

**Check by hand afterwards:** look at **Settings > System > Notifications**. If *Foundry S6 toast spike* is still listed, record it. That list comes from Windows' own notification store, which the script does not edit.

## Before you start

- **A normal PowerShell window.** Not *Run as administrator*: the script refuses to run elevated, because it tests a per-user install.
- **Inno Setup 6.3 or later (`ISCC.exe`)**, which phase B needs to build the installer. It was not installed on this machine on 8 October 2026, and installing it is your call:
  - Inno Setup's own installer offers *Install for me only*, a per-user install without elevation.
  - `winget install --id JRSoftware.InnoSetup -e` installs it for all users, behind a UAC prompt.
  - Either way the script finds it on `PATH` or in its default folders, or you pass `-IsccPath`.
  - The script never installs or removes Inno Setup itself.
  - The installer script itself is proven: CI compiled it on the `windows-2025` runner, with no install step, on 9 October 2026.
- **Notifications on, Do not disturb off.** Otherwise banners do not appear. The spike's window shows what Windows reports, and every record includes it.
- About 15 minutes.

## Run it

From the repository root:
```
powershell -ExecutionPolicy Bypass -File tests\Foundry.Spikes.Toast\Run-S6.ps1
```

1. The script builds everything, which takes a minute or two. Nothing is registered or installed until the build succeeds.
2. **Phase A:** the *Foundry S6 toast spike* window opens for the unzipped exe.
   1. Do steps 1 to 5 in order, answering the questions as you go.
   2. Step 5 closes the window. The script then asks you to click that toast in Notification Center, and to type what happened.
   3. If you skip step 5, use **Finish without step 5**.
3. The script clears phase A's registration and toasts, then installs the spike silently.
4. **Phase B:** the same window opens, started from the Start menu shortcut. Do the same steps.
5. The script uninstalls the spike, removes the registration and toasts, and verifies that nothing is left.

The results land in `test-results/spikes/s6-toast-activation/<time>/`:
- `summary.md`: the verdict per phase, each step's measured facts, your answers and notes, step 5, and the cleanup report;
- `phase-unzipped.jsonl` and `phase-installed.jsonl`: every toast event;
- `install.log` and `uninstall.log`;
- `console.log`.

Other options:
- `-BuildOnly` publishes, zips and compiles the installer, then stops. Nothing is installed, registered or started. It is a quick check of the build.
- `-CleanupOnly` removes what an interrupted run left behind.

## Verdict

For each phase, `summary.md` reports each of steps 1 to 3 over its valid trials:
- *activated, window in front (n of n valid trials)*;
- *activated, window NOT in front in k of n valid trials*, with the program that kept the foreground;
- *not activated*, when you answered that you clicked the toast and the window did not come forward;
- *inconclusive*, when the step was not run, the toast was never clicked, or every trial was invalid. The step is to be repeated; an inconclusive step never counts as a failure.

Next to the measurement, it reports your answers to "Did this window come to the front by itself?".
- **S6 is met** if all three steps show *activated, window in front* in both phases, and your answers agree. If they disagree, the summary says so; the disagreement is a decision for Rudy, not resolved by the script.
- **A phase with an inconclusive step and no failure** reads *inconclusive: repeat the steps marked so*.
- **Otherwise the fallback ships:** the in-app Inbox plus a taskbar flash. Step 4 shows whether the flash works. Before shipping it, consider the untested COM activator described above.
- **Step 5 is informational.** Electron's click handler also lives only in the running process (`index.ts:63`). The summary says whether Windows restarted the spike, either with the toast's arguments or through the Start menu shortcut.
