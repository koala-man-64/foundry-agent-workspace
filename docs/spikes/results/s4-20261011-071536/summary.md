# Spike S4: input ladder (manual run)

Run 2026-10-11 07:30 -05:00. Windows 10.0.26200.0, WebView2 runtime 154.0.4258.62, SDK 1.0.4258.31.

What the app measured. Rudy's observations go in the recording sheet of docs/spikes/s4-input-ladder.md.

Exit criterion: zero events reach the page except UIA (documented); detach under 100 ms; disabled HWND renders correctly. Otherwise apply decision 7.

## Totals

- Attachments: 2; refused: 0.
- Takeovers: 1; worst detach 0.1 ms; detached under 100 ms with no later agent effect: 1 of 1.
- Agent effects that landed after the human's input: 0 in 0 takeovers.
- **Input events that reached the page or its frames while attached: 0**.
- Hover, focus and scroll events while attached, which the browser can also generate itself: 0.
- Takeovers whose page counts are unknown (counted as failures): 0.
- Page state changes while attached (focus, scroll, navigation): 0.
- Breaches (focus or keys inside an attached tab): 0.
- Rendering while attached: 1 ok, 0 with a problem, 0 not judged on screen.
- Frames reporting to the page's counter: cross-site-frame, same-origin-frame; frames Chromium ran in their own process at attach: 1.

## Takeovers

| Time | Trigger | Detach ms | Agent after input | Restore ms | Input events while attached | Hover/focus | Page state | Agent actions | Rendering | Restored |
|---|---|---|---|---|---|---|---|---|---|---|
| 07:22:26 | left button | 0.1 | none | 71.7 | 0 | 0 | unchanged | 91 | 123 frames/s, 1238 pixels changed in 1 s, brightness shift 0.6 | True |

## Attachments, refusals and breaches

- 07:21:22 attached (generation 1); input while attaching (counted against the attachment): none; hover and focus while attaching: none
- 07:26:53 attached (generation 3); input while attaching (counted against the attachment): none; hover and focus while attaching: none

Detach runs from the human's input to the end of the attachment: for the mouse, wheel, touch and pen from the input's message time (GetMessageTime, about 16 ms resolution); for the Take control button from the click in the UI. The agent's effects are timestamped in the page; an effect after the input means the agent was still acting on the page then. Restore also includes waiting for any agent action in flight, reading the page's counters and re-enabling every layer.
