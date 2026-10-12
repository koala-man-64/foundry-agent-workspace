# Spike S4: input ladder (manual run)

Run 2026-10-11 22:09 -05:00. Windows 10.0.26200.0, WebView2 runtime 154.0.4258.62, SDK 1.0.4258.31.

What the app measured. Rudy's observations go in the recording sheet of docs/spikes/s4-input-ladder.md.

Exit criterion: zero events reach the page except UIA (documented); detach under 100 ms; disabled HWND renders correctly. Otherwise apply decision 7.

## Totals

- Attachments: 19; refused: 0.
- Takeovers: 19; worst detach 16.1 ms; detached under 100 ms with no later agent effect: 19 of 19.
- Agent effects that landed after the human's input: 0 in 0 takeovers.
- **Input events that reached the page or its frames while attached: 0**.
- Hover, focus and scroll events while attached, which the browser can also generate itself: 0.
- Takeovers whose page counts are unknown (counted as failures): 0.
- Page state changes while attached (focus, scroll, navigation): 0.
- Breaches (focus or keys inside an attached tab): 0.
- Rendering while attached: 18 ok, 0 with a problem, 1 not judged on screen.
- Frames reporting to the page's counter: cross-site-frame, same-origin-frame; frames Chromium ran in their own process at attach: 1.

## Takeovers

| Time | Trigger | Detach ms | Agent after input | Restore ms | Input events while attached | Hover/focus | Page state | Agent actions | Rendering | Restored |
|---|---|---|---|---|---|---|---|---|---|---|
| 07:43:28 | left button | 16.1 | none | 93.6 | 0 | 0 | unchanged | 788 | 123 frames/s, 1262 pixels changed in 1 s, brightness shift 0.6 | True |
| 07:45:26 | left button | 0.1 | none | 71.0 | 0 | 0 | unchanged | 23 | 122 frames/s, 586 pixels changed in 1 s, brightness shift 0.1 | True |
| 07:52:20 | left button | 0.1 | none | 72.7 | 0 | 0 | unchanged | 11 | 124 frames/s, 562 pixels changed in 1 s, brightness shift 0.0 | True |
| 07:55:57 | left button | 0.1 | none | 63.6 | 0 | 0 | unchanged | 19 | 177 frames/s, 492 pixels changed in 1 s, brightness shift 0.0 | True |
| 08:00:02 | left button | 0.1 | none | 75.8 | 0 | 0 | unchanged | 8 | 123 frames/s, 601 pixels changed in 1 s, brightness shift 0.0 | True |
| 08:01:50 | left button | 0.1 | none | 69.9 | 0 | 0 | unchanged | 9 | 123 frames/s, 587 pixels changed in 1 s, brightness shift 0.0 | True |
| 08:03:04 | left button | 0.1 | none | 71.8 | 0 | 0 | unchanged | 8 | 181 frames/s, 584 pixels changed in 1 s, brightness shift 0.0 | True |
| 08:12:55 | right button | 0.2 | none | 69.9 | 0 | 0 | unchanged | 166 | 177 frames/s, 639 pixels changed in 1 s, brightness shift 0.0 | True |
| 08:16:12 | middle button | 0.0 | none | 75.5 | 0 | 0 | unchanged | 5 | 150 frames/s, 512 pixels changed in 1 s, brightness shift 0.0 | True |
| 08:17:04 | wheel | 0.0 | none | 63.6 | 0 | 0 | unchanged | 0 | checking… | True |
| 08:18:05 | wheel | 0.0 | none | 74.5 | 0 | 0 | unchanged | 26 | 169 frames/s, 574 pixels changed in 1 s, brightness shift 0.0 | True |
| 08:19:05 | wheel | 0.1 | none | 67.6 | 0 | 0 | unchanged | 13 | 123 frames/s, 525 pixels changed in 1 s, brightness shift 0.0 | True |
| 08:19:58 | left button | 0.0 | none | 77.4 | 0 | 0 | unchanged | 5 | 123 frames/s, 580 pixels changed in 1 s, brightness shift 0.0 | True |
| 08:23:46 | side button | 0.0 | none | 75.0 | 0 | 0 | unchanged | 78 | 123 frames/s, 603 pixels changed in 1 s, brightness shift 0.0 | True |
| 08:26:10 | side button | 0.0 | none | 72.6 | 0 | 0 | unchanged | 170 | 122 frames/s, 609 pixels changed in 1 s, brightness shift 0.0 | True |
| 08:27:23 | horizontal wheel | 15.0 | none | 79.3 | 0 | 0 | unchanged | 65 | 93 frames/s, 648 pixels changed in 1 s, brightness shift 0.0 | True |
| 08:56:48 | left button | 0.0 | none | 76.6 | 0 | 0 | unchanged | 2473 | 123 frames/s, 680 pixels changed in 1 s, brightness shift 0.0 | True |
| 09:04:09 | left button | 0.0 | none | 72.7 | 0 | 0 | unchanged | 581 | 164 frames/s, 609 pixels changed in 1 s, brightness shift 0.0 | True |
| 09:41:08 | the Take control button | 2.3 | none | 85.4 | 0 | 0 | unchanged | 3099 | 177 frames/s, 587 pixels changed in 1 s, brightness shift 0.0 | True |

## Attachments, refusals and breaches

- 07:34:13 attached (generation 1); input while attaching (counted against the attachment): none; hover and focus while attaching: none
- 07:45:09 attached (generation 3); input while attaching (counted against the attachment): none; hover and focus while attaching: none
- 07:52:12 attached (generation 5); input while attaching (counted against the attachment): none; hover and focus while attaching: none
- 07:55:44 attached (generation 7); input while attaching (counted against the attachment): none; hover and focus while attaching: none
- 07:59:55 attached (generation 9); input while attaching (counted against the attachment): none; hover and focus while attaching: none
- 08:01:43 attached (generation 11); input while attaching (counted against the attachment): none; hover and focus while attaching: none
- 08:02:58 attached (generation 13); input while attaching (counted against the attachment): none; hover and focus while attaching: none
- 08:10:58 attached (generation 15); input while attaching (counted against the attachment): none; hover and focus while attaching: none
- 08:16:07 attached (generation 17); input while attaching (counted against the attachment): none; hover and focus while attaching: none
- 08:17:03 attached (generation 19); input while attaching (counted against the attachment): none; hover and focus while attaching: none
- 08:17:46 attached (generation 21); input while attaching (counted against the attachment): none; hover and focus while attaching: none
- 08:18:55 attached (generation 23); input while attaching (counted against the attachment): none; hover and focus while attaching: none
- 08:19:54 attached (generation 25); input while attaching (counted against the attachment): none; hover and focus while attaching: none
- 08:22:50 attached (generation 27); input while attaching (counted against the attachment): none; hover and focus while attaching: none
- 08:24:10 attached (generation 29); input while attaching (counted against the attachment): none; hover and focus while attaching: none
- 08:26:37 attached (generation 31); input while attaching (counted against the attachment): none; hover and focus while attaching: none
- 08:27:48 attached (generation 33); input while attaching (counted against the attachment): none; hover and focus while attaching: none
- 08:57:20 attached (generation 35); input while attaching (counted against the attachment): none; hover and focus while attaching: none
- 09:04:47 attached (generation 37); input while attaching (counted against the attachment): none; hover and focus while attaching: none

Detach runs from the human's input to the end of the attachment: for the mouse, wheel, touch and pen from the input's message time (GetMessageTime, about 16 ms resolution); for the Take control button from the click in the UI. The agent's effects are timestamped in the page; an effect after the input means the agent was still acting on the page then. Restore also includes waiting for any agent action in flight, reading the page's counters and re-enabling every layer.
