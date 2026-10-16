# S4 manual desktop observations — fresh run, 11 October 2026

Run in progress. Original generated evidence: `C:\Users\rdpro\Projects\foundry-agent-workspace-s6\test-results\spikes\s4-input-ladder\20261011-073210`.

Started at 07:32 using the unchanged manual runner command in the owner chat's Terminal panel. This replaces the incomplete [07:15 run](../s4-20261011-071536/observations.md), which lost agent activity and reported a harness exception on shutdown. The earlier evidence remains retained separately; it is not silently overwritten or combined into a full pass.

Rudy confirmed baseline typing works, all layers engage, attached input/breaches remain 0, and agent actions rise. Owner readback: Text field `abc`, generation 1 attached, input 0, breaches 0, 30 agent actions with agent text present; 123 frames/s, 1,262 changed pixels in 1 s, brightness shift 0.6. Both frames report, with one out-of-process frame. Baseline and attachment checks pass for this fresh run.

Pending: text services and remaining manual input classes. Earlier keyboard blocking is recorded separately with its inactive-agent limitation. No source changes.

Hardware availability: Rudy confirmed “all the ones you listed”: side mouse buttons, horizontal wheel tilt, touchpad, touchscreen and pen. Their test status remains **not tested** until each is actually exercised and recorded; availability alone is not evidence.

Side Back button first report: Rudy said “Yes: side-button takeover, events 0, no navigation”, but no new attach/takeover exists after the earlier 08:19:58 double-click record. Owner readback remains Manual with 13 takeovers. **Inconclusive**; repeat with owner verifying setup before Rudy's physical input. Owner computer-use setup clicks are not counted as physical test evidence.

Step 7 Back side-button repeat (owner-prepared attachment, Rudy physical button): Rudy reported “Changed to Manual; events 0; no navigation”. Matching side-button takeover at 08:23:46: detach 0.0258 ms, restore 75.0498 ms, restored true, input 0, hover 0, state unchanged, 78 agent actions, no late agent effects. **Pass**; Back button identity supplied by the requested physical trial, event logged as side button.

Step 7 Forward side-button (owner-prepared attachment, Rudy physical button): Rudy reported “Changed to Manual; events 0; no navigation”. Matching side-button takeover at 08:26:10: detach 0.0481 ms, restore 72.5545 ms, restored true, input 0, hover 0, state unchanged, 170 agent actions, no late agent effects. **Pass**; Forward identity supplied by the requested trial, event logged as side button.

Step 7 horizontal wheel tilt: Rudy reported “Horizontal tilt took control; events 0; no scroll”. Matching horizontal-wheel takeover at 08:27:23: detach 15.0483 ms (15 ms input queue), restore 79.3482 ms, restored true, input 0, hover 0, state unchanged, 65 agent actions, no late agent effects. **Pass**.

Step 8 touchpad: when asked to perform a two-finger scroll, Rudy corrected availability: “i dont have this one”. **Not tested** for two-finger scroll, pinch and tap-to-click; the earlier general availability reply is superseded for touchpad. No gesture was inferred or injected.

Step 9a touchscreen: Rudy corrected availability: “No touchscreen; not tested”. **Not tested** for finger tap, swipe and pinch; the earlier general availability reply is superseded for touchscreen.

Step 9b pen: Rudy corrected availability: “No compatible pen; not tested”. **Not tested** for pen hover and contact; the earlier general availability reply is superseded for pen.

Step 10 file drag from Explorer: Rudy dragged the harmless `s4-drag-fixture.txt` to the page drop box and reported “Drop refused; nothing inserted; input 0; still Attached”. Owner readback: generation 33 attached, input 0, breaches 0, takeovers still 16; 592 agent actions. **Pass**; actual drag/refusal is human observation, independently corroborated by post-trial blocked state.

Step 10 text drag setup: Rudy could not select the proposed heading text in a browser. No drag was completed and no pass is inferred. A selectable plain-text source is the next attempt.

Step 10 external text drag: Rudy reported “Cannot perform external text drag; not tested” after the alternative-source instructions. **Not tested**; file-drag evidence does not substitute for text-drag evidence. Notepad launch did not expose a targetable window to computer-use; no content was entered by the owner.

Step 10 browser link drag to cross-site frame: Rudy reported “Link drop refused; no navigation; input 0; still Attached”. Window was minimized at first readback; owner restored it without a page click. Readback: generation 33 still attached, input 0, breaches 0, takeovers still 16, 1,227 agent actions. **Pass**; physical drag/refusal is human observation, independently corroborated by post-trial blocked state. Retained attachment counters will be collected on the next takeover.

Step 11 focus: Rudy reported “All three focus checks match” for Alt+Tab away/back, minimize/taskbar restore, and roughly 20 Tabs from empty left UI. Owner readback: generation 33 attached, input 0, breaches 0, takeovers still 16, 2,166 agent actions. Log records repeated refused Tab traversal at 08:52:52–53. **Pass for these three paths.** Physical Windows+D **not tested** because Rudy's Windows key is unavailable. No page/frame focus ring was observed by Rudy.

Step 12 moved-window first report: Rudy said “After moving, aligned and inside-edge takeover; events 0”. Owner readback conflicts: generation 33 still attached, 2,375 agent actions, input/breaches 0, takeovers still 16, and no new takeover record. **Inconclusive**; repeat the physical click inside the white page boundary. No moved-window takeover pass inferred.

Step 12 moved-window inside-edge repeat: Rudy reported “Changed to Manual; events 0”. Matching left-button takeover at 08:56:48: detach 0.0393 ms, restore 76.5505 ms, restored true, input 0, hover 0, no state changes, 2,473 agent actions, no late agent effects. **Pass** for this boundary click after the reported window move. This same attachment collected the file/link drag and focus checks: its aggregate input, hover and page state remained zero/unchanged.

Step 12 moved-window outside edge: Rudy reported “Stayed Attached; input 0” after owner-prepared generation 35 attachment. Owner readback: still attached, input/breaches 0, 287 agent actions, takeovers unchanged at 17. **Pass**. No click was injected into the tested page by the owner.

Step 12 resize inside edge: Rudy reported “Resized, page aligned, inside-edge takeover; events 0”. Matching left-button takeover at 09:04:09: detach 0.039 ms, restore 72.7262 ms, restored true, input 0, hover 0, state unchanged, 581 agent actions, no late effects. **Pass** for the reported resize and inside-edge physical click.

Step 12 resized outside edge: Rudy reported “Stayed Attached; input 0”. Owner readback: generation 37 still attached, input/breaches 0, 726 agent actions, takeovers unchanged at 18. **Pass**.

Step 3 physical Windows-key shortcuts were unavailable: Rudy reported “my windows key doesnt work”. The owner opened the existing Windows On-Screen Keyboard (`osk.exe`) without changing settings, to attempt an alternative text-services route and step 4 injected-key input. No text-services or injected-key pass is inferred from launching it.

Step 4 (On-Screen Keyboard injected letters): Rudy clicked a/b/c on OSK with the spike focused through its title bar and reported “Yes, attached and both counters stayed 0”. Owner readback: generation 1 still attached, input 0, breaches 0, takeovers 0; agent actions increased to 347 with agent text present. **Pass** for injected letter input through OSK. OSK remains open for the text-services attempt.

Step 3a (emoji panel through OSK Windows-logo/period shortcut): Rudy reported “Emoji selected; attached and counters stayed 0”. Owner readback: generation 1 attached, input 0, breaches 0, takeovers 0; agent actions increased to 388. **Pass** through this alternative shortcut route; physical Windows-key route remains unavailable.

Step 3b (clipboard-history selection through OSK Windows-logo/V shortcut): Rudy reported “Entry selected; attached, input 0, Breaches 0”. Owner readback: generation 1 attached, input 0, breaches 0, takeovers 0; agent actions increased to 601. **Pass** through this alternative shortcut route; no clipboard entry contents were collected.

Step 3c (IME composition): Rudy reported “No composition IME installed; not tested”. **Not tested**; nothing installed or enabled. Optional voice typing was not exercised.

Step 5 (physical hover over page controls and both frames): Rudy reported “Yes, all hover checks match”, covering no yellow highlight or hover-event stream. Owner readback: generation 1 attached, input 0, breaches 0, takeovers 0; agent actions increased to 745. **Pass**; attached hover totals will also be retained in the next takeover record.

Step 6 first batch: Rudy reported “there was 1 takeover”. Only one attached left-button trial is logged, at 07:43:28: detach 16.0594 ms, restore 93.6459 ms, restored true, input 0, hover 0, state unchanged, 788 agent actions, agent effects after input 0. **Pass for this left-button takeover**, but click location is not independently identified and the five requested targets are not yet covered. Subsequent trials will be requested individually.

Step 6 empty-area trial: Rudy reported “Yes, empty-area click took control; events 0”. Matching takeover at 07:45:26: detach 0.0558 ms, restore 71.0369 ms, restored true, input 0, hover 0, no state changes, 23 agent actions, no agent effects after input; rendering 122 frames/s, brightness shift 0.1. **Pass**.

Step 6 page-button trial: Rudy reported “Yes: takeover, events 0, button count unchanged”. Matching takeover at 07:52:20: detach 0.0653 ms, restore 72.6598 ms, restored true, input 0, hover 0, no state changes, 11 agent actions, no agent effects after input; rendering 124 frames/s, brightness shift 0.0. **Pass**.

Step 6 main-text-field trial: Rudy reported “Yes: text-field takeover, events 0”. Matching takeover at 07:55:57: detach 0.0529 ms, restore 63.5705 ms, restored true, input 0, hover 0, no state changes, 19 agent actions, no agent effects after input; rendering 177 frames/s, brightness shift 0.0. **Pass**.

Step 6 same-origin-frame field trial: Rudy reported “Yes: same-origin frame takeover, events 0”. Matching takeover at 08:00:02: detach 0.0649 ms, restore 75.7862 ms, restored true, input 0, hover 0, no state changes, 8 agent actions, no agent effects after input; rendering 123 frames/s, brightness shift 0.0. **Pass**.

Step 6 cross-site-frame button trial: Rudy reported “Yes: cross-site frame takeover, events 0, button not activated”. Matching takeover at 08:01:50: detach 0.0516 ms, restore 69.8719 ms, restored true, input 0, hover 0, no state changes, 9 agent actions, no agent effects after input; rendering 123 frames/s, brightness shift 0.0. **Pass**. All five individually identified click targets now pass; maximum detach among those five is 0.0653 ms. The earlier unspecified click remains a separate valid trial (16.0594 ms).

Step 6 edge batch: Rudy reported “Inside took control; outside stayed attached; input 0”. Inside-edge takeover at 08:03:04: detach 0.0573 ms, restore 71.7808 ms, restored true, input 0, hover 0, no state changes, 8 agent actions, no late agent effects. **Inside-edge pass.** Outside-edge evidence conflicts: no subsequent attach record and owner readback is Manual. Outside-edge trial **inconclusive**, to repeat independently while attached.

Step 6 outside-edge repeat: Rudy reported “Confirmed Attached before and after outside click”. Owner readback: generation 15 attached, input 0, breaches 0, 59 agent actions; takeovers remain 7, with no takeover after the 08:10:58 attachment. **Pass** for clicking outside the page without detaching.

Step 7 right-button trial: Rudy reported “Yes: right-click takeover, events 0, no page menu”. Matching right-button takeover at 08:12:55: detach 0.1639 ms, restore 69.9185 ms, restored true, input 0, hover 0, no state changes, 166 agent actions, no agent effects after input. **Pass**.

Step 7 middle-button trial: Rudy reported “Yes: middle-click takeover, events 0, no auto-scroll”. Matching middle-button takeover at 08:16:12: detach 0.0239 ms, restore 75.5367 ms, restored true, input 0, hover 0, no state changes, 5 agent actions, no agent effects after input. **Pass**.

Step 7 vertical-wheel first attempt: Rudy reported “Wheel took control; events 0; page did not scroll”. Matching wheel takeover at 08:17:04: detach 0.0306 ms, restore 63.5684 ms, input 0, hover 0, state unchanged, but attachment lasted only 0.786 s, agent actions 0, rendering still checking. Input blocking observed; **active-agent timing inconclusive**, repeat after agent activity begins.

Step 7 vertical-wheel repeat: Rudy reported “Waited for at least 3 actions; takeover, events 0, no scroll”. Matching wheel takeover at 08:18:05: detach 0.0482 ms, restore 74.4811 ms, restored true, input 0, hover 0, state unchanged, 26 agent actions, no late agent effects; rendering 169 frames/s, brightness shift 0.0. **Pass**.

Step 7 Ctrl+wheel: Rudy reported “Yes: Ctrl+wheel takeover, events 0, no page zoom/scroll”. Matching wheel takeover at 08:19:05: detach 0.1226 ms, restore 67.6498 ms, restored true, input 0, hover 0, state unchanged, 13 agent actions, no late agent effects; rendering 123 frames/s, brightness shift 0.0. **Pass** for this Ctrl-modified wheel trial; modifier supplied by Rudy's observation, trigger logged as wheel.

Step 7 double-click: Rudy reported “Takeover; attached events 0; no unexpected page effect”. Matching left-button takeover at 08:19:58: detach 0.044 ms, restore 77.3593 ms, restored true, input 0, hover 0, state unchanged, 5 agent actions, no late agent effects; rendering 123 frames/s, brightness shift 0.0. **Pass** for blocking the initiating click and ending attachment; second-click observation retained separately from the initiating trigger.

Optional hardware clarification: Rudy initially said all listed devices were available, then explicitly clarified no touchpad, touchscreen, or compatible pen. Their scrolling/gesture/contact/hover trials are **not tested**. Mouse side buttons and horizontal tilt were available and tested.

Step 7 Back side-button first report had no corresponding new takeover and is **inconclusive**. Owner prepared a fresh active attachment for each repeat. Back repeat at 08:23:46: detach 0.0258 ms, restore 75.0498 ms, 78 agent actions. Forward at 08:26:10: detach 0.0481 ms, restore 72.5545 ms, 170 agent actions. Rudy reported Manual, events 0, no navigation for both. Both records show restored true, input/hover 0, unchanged state, no late agent effects. **Pass** for both identified repeats.

Step 7 horizontal wheel tilt at 08:27:23: Rudy reported takeover, events 0, no scroll. Detach 15.0483 ms including 15 ms input queue delay; restore 79.3482 ms; 65 agent actions; restored true, input/hover 0, unchanged state, no late agent effects; rendering 93 frames/s. **Pass**.

Step 10 external file drag: Rudy dragged the harmless s4-drag-fixture.txt from Explorer and reported refused drop, no insertion, input 0, still Attached. Owner readback generation 33: input/Breaches 0, 592 agent actions, takeovers unchanged at 16. **Pass**. External text drag could not be performed even with a separate source app: **not tested**. External browser link drag to the cross-site frame: Rudy reported refused drop, no navigation, input 0, still Attached. Owner readback generation 33: input/Breaches 0, 1227 agent actions, takeovers unchanged. **Pass**.

Step 11 focus: Rudy reported Alt+Tab away/back, minimize/taskbar restore, and about 20 Tab presses from the left UI all stayed Attached with input/Breaches 0 and no page/frame focus ring. Owner readback generation 33: 2166 agent actions, counters 0, takeovers unchanged; Tab traversal refusals logged 08:52:50–53. **Pass** for those three checks. Windows+D **not tested** (physical Windows key unavailable).

Step 12 move: first inside-edge report did not match a new takeover and is **inconclusive**. Precise repeat at 08:56:48: Rudy reported Manual, events 0. Matching record: detach 0.0393 ms, restore 76.5505 ms, restored true, input/hover 0, state unchanged, 2473 agent actions, no late effects. **Pass** for repeat. This record also corroborates zero input/hover and unchanged page state throughout the preceding generation-33 drag/focus interval. Outside moved edge: Rudy reported still Attached, input 0; owner readback generation 35, input/Breaches 0, 287 agent actions, takeovers unchanged at 17. **Pass**.

Step 12 resize: Rudy reported aligned page and inside-edge takeover with events 0. Matching 09:04:09 record: detach 0.039 ms, restore 72.7262 ms, restored true, input/hover 0, unchanged state, 581 agent actions, no late effects. **Pass**. Subsequent attachment geometry changed to 1334×921, with overlay/tab rectangles matching. Outside resized edge: Rudy reported still Attached, input 0; owner readback generation 37, input/Breaches 0, 726 agent actions, takeovers unchanged at 18. **Pass**.

Step 12 maximize/restore: Rudy reported alignment at both sizes and restored inside-edge takeover, events 0. Owner readback remained Attached generation 37 with no new takeover record. A separately requested maximized inside-edge trial was also reported Manual/events 0, but the next readback found the window minimized, and after restoring it the badge still read Attached generation 37, takeovers 18; the title-bar action read Maximize. **Both edge trials inconclusive due to conflicting observations.** Alignment is a human observation only; no maximized boundary pass is certified. Proceeding to the explicit Take control button trial while preserving the conflict.

Step 13 explicit Take control: Rudy reported Manual, events 0. Live readback agreed; matching 09:41:08 record identifies the Take control button, detach 2.2675 ms (2 ms queue), restore 85.4091 ms, restored true, input/hover 0, unchanged state, 3099 agent actions, no late agent effects, rendering 177 frames/s. **Pass**. The generation-37 attachment aggregate has no input, hover, state changes, or unknown counts despite the preceding conflicting edge reports.

Step 14 Manual recovery: Rudy reported “All work normally in Manual mode; the frozen counter stayed unchanged”, covering typed text, main/embedded-frame buttons, scrolling and Tab focus entry. **Pass by physical human observation**; the attachment counter is expected to remain frozen. On resumption the spike was already closed, so no additional live Manual readback was available.

Step 15 optional UIA: **not tested**. No UIA bypass result is claimed.

Step 16 finish and cleanup: no target S4 window returned by computer-use. The generated summary and log ending “Finished. Summary” exist. Independent inspection found no Foundry.Spikes.BrowserSurface process, no WebView2 process referencing foundry-spike profiles, no foundry-spike-* directories in the user's temporary directory, and no listener on port 58173. No cleanup deletion was needed. The original summary.md, records.jsonl and log.txt were copied unchanged beside this sheet; SHA256 hashes match all three originals. The generated summary labels its timestamp with the finish time rather than the folder's start time; original text is preserved.
