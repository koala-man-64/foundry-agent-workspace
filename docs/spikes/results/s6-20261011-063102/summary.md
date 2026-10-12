# Spike S6: toast click activation

Run 2026-10-11 07:05 -05:00 on Windows 10.0.26200.0. Results: C:\Users\rdpro\Projects\foundry-agent-workspace-s6\test-results\spikes\s6-toast-activation\20261011-063102

Exit criterion: toast click activation works from the unzipped exe and the installed exe, or the fallback (the in-app Inbox plus a taskbar flash) ships.

## Verdict (measured)

- **unzipped exe (notifier unknown (), Windows said 'busy (a full-screen app)'):** banner while minimized: shown but never activated: repeat the step and click the toast; banner while behind another window: shown but never activated: repeat the step and click the toast; Notification Center: shown but never activated: repeat the step and click the toast. Your answers to 'came to the front by itself': no answer, no answer, Yes. Click activation **inconclusive: repeat the steps marked so**.
  The fallback's taskbar flash, by your answer: Yes.
- **installed exe (notifier Enabled, Windows said 'busy (a full-screen app)'):** banner while minimized: shown but never activated: repeat the step and click the toast; banner while behind another window: shown but never activated: repeat the step and click the toast; Notification Center: activated, window in front (1 of 1 valid trials). Your answers to 'came to the front by itself': no answer, no answer, Yes. Click activation **inconclusive: repeat the steps marked so**.
  The fallback's taskbar flash, by your answer: Yes.

## Phase: unzipped exe

Started 2026-10-11 06:31:25 -05:00 from `C:\Users\rdpro\Projects\foundry-agent-workspace-s6\test-results\spikes\s6-toast-activation\20261011-063102\unzipped\Foundry.Spikes.Toast.exe`. Notifier setting at the end: Enabled.

| Step | What happened (measured) | Rudy's answers | Notes |
|---|---|---|---|
| 1. Click the banner while this window is minimized | toast shown at 06:32:08; banner timed out (now in Notification Center); toast shown at 06:33:06; banner timed out (now in Notification Center); toast shown at 06:35:37; banner timed out (now in Notification Center); toast shown at 06:36:22; banner timed out (now in Notification Center); toast shown at 06:36:54; banner timed out (now in Notification Center); toast shown at 06:38:13; banner timed out (now in Notification Center); toast shown at 06:42:13; banner timed out (now in Notification Center) | - | Banner trials were suppressed or timed out without a click. Windows reported busy (a full-screen app) on most trials; one reported accepts notifications but timed out without activation. Inconclusive; no failed foreground trial was observed. |
| 2. Click the banner while another window is in front | toast shown at 06:42:55; banner timed out (now in Notification Center) | - | Banner immediately timed out while Windows reported busy (a full-screen app). No toast click or activation event. Inconclusive; foreground activation was not tested. |
| 3. Click the toast in Notification Center | toast shown at 06:43:43; banner timed out (now in Notification Center) | Was the toast in Notification Center? Yes; Did this window come to the front by itself? Yes | Rudy reports the toast was present and the spike came forward. At readback there was no activated event in phase-unzipped.jsonl; observation and instrumentation disagree. Do not certify this trial. |
| 4. The fallback: a taskbar flash | flash started while another window was in front | Did the taskbar button flash? Yes | - |
| 5. Click a toast after the app has closed | toast shown at 06:47:59; banner timed out (now in Notification Center) | - | - |

## Phase: installed exe

Started 2026-10-11 06:51:18 -05:00 from `C:\Users\rdpro\AppData\Local\Programs\Foundry S6 toast spike\Foundry.Spikes.Toast.exe`. Notifier setting at the end: Enabled.

| Step | What happened (measured) | Rudy's answers | Notes |
|---|---|---|---|
| 1. Click the banner while this window is minimized | toast shown at 06:51:52; banner timed out (now in Notification Center) | - | Banner immediately timed out while Windows reported busy (a full-screen app). No click or activation recorded. Inconclusive; no foreground activation trial completed. |
| 2. Click the banner while another window is in front | toast shown at 06:52:19; banner timed out (now in Notification Center) | - | Banner immediately timed out while Windows reported busy (a full-screen app), with File Explorer placed in front. No click or activation recorded. Inconclusive. |
| 3. Click the toast in Notification Center | toast shown at 06:52:57; banner timed out (now in Notification Center); toast shown at 06:53:47; banner timed out (now in Notification Center); toast shown at 06:53:51; banner timed out (now in Notification Center); activated 14.1 s after showing; window IN FRONT (measured) | Was the toast in Notification Center? Yes; Did this window come to the front by itself? Yes | - |
| 4. The fallback: a taskbar flash | flash started while another window was in front | Did the taskbar button flash? Yes | - |
| 5. Click a toast after the app has closed | toast shown at 06:59:16; banner timed out (now in Notification Center) | - | - |

## Step 5, unzipped exe: a toast clicked after the app closed

- Rudy: clicked it and codex app flashed
- Spike processes running 3 s after the click: 0
- Launches with arguments the spike did not choose: none
- Interactive restarts (new start records): 0


## Step 5, installed exe: a toast clicked after the app closed

- Rudy: clicked it; nothing happened
- Spike processes running 3 s after the click: 0
- Launches with arguments the spike did not choose: none
- Interactive restarts (new start records): 0


## Cleanup

Nothing checked was left behind: no install folder, uninstall entry, Start menu shortcut, app ID registration, notification settings or launch log.

Not checked: records Windows keeps about apps it has seen, such as its notification database, jump lists and app-usage history.
