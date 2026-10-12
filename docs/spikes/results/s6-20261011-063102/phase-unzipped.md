## Phase: unzipped exe

Started 2026-10-11 06:31:25 -05:00 from `C:\Users\rdpro\Projects\foundry-agent-workspace-s6\test-results\spikes\s6-toast-activation\20261011-063102\unzipped\Foundry.Spikes.Toast.exe`. Notifier setting at the end: Enabled.

| Step | What happened (measured) | Rudy's answers | Notes |
|---|---|---|---|
| 1. Click the banner while this window is minimized | toast shown at 06:32:08; banner timed out (now in Notification Center); toast shown at 06:33:06; banner timed out (now in Notification Center); toast shown at 06:35:37; banner timed out (now in Notification Center); toast shown at 06:36:22; banner timed out (now in Notification Center); toast shown at 06:36:54; banner timed out (now in Notification Center); toast shown at 06:38:13; banner timed out (now in Notification Center); toast shown at 06:42:13; banner timed out (now in Notification Center) | - | Banner trials were suppressed or timed out without a click. Windows reported busy (a full-screen app) on most trials; one reported accepts notifications but timed out without activation. Inconclusive; no failed foreground trial was observed. |
| 2. Click the banner while another window is in front | toast shown at 06:42:55; banner timed out (now in Notification Center) | - | Banner immediately timed out while Windows reported busy (a full-screen app). No toast click or activation event. Inconclusive; foreground activation was not tested. |
| 3. Click the toast in Notification Center | toast shown at 06:43:43; banner timed out (now in Notification Center) | Was the toast in Notification Center? Yes; Did this window come to the front by itself? Yes | Rudy reports the toast was present and the spike came forward. At readback there was no activated event in phase-unzipped.jsonl; observation and instrumentation disagree. Do not certify this trial. |
| 4. The fallback: a taskbar flash | flash started while another window was in front | Did the taskbar button flash? Yes | - |
| 5. Click a toast after the app has closed | toast shown at 06:47:59; banner timed out (now in Notification Center) | - | - |
