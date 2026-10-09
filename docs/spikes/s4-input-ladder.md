# Spike S4: input ladder, manual test script

**Question** ([plan](../wpf-webview2-migration.md), section 6 and the spike table): while a tab is attached to a chat, does any human input reach the page, does a human takeover stop the agent fast enough, and does the page still render while its window is disabled?

**Exit criterion:**
- Zero events reach the page except through UIA, which is documented.
- Detach takes under 100 ms.
- The disabled window renders correctly.

**If S4 fails, decision 7 applies:** ship with **Attach to chat** disabled (view-only browsing). This does not block the cutover.

**How it runs (Rudy's choice, 8 October 2026):** Rudy performs every input by hand, following this script. No program generates input. The app below is the subject of the test; it only records what reaches the page.

## The subject

`tests/Foundry.Spikes.BrowserSurface` in `ladder` mode. It is the plan's browser surface: the UI in one WebView2 environment, and a tab in a separate environment, inside its own child window.

The tab shows a test page from a loopback-only server on this machine. The page embeds two frames:
- a **same-origin frame**;
- a **cross-site frame**, which Chromium runs in its own process, as on real sites.

The page and both frames count every trusted event, and the page shows the total.

### The ladder

Attaching engages all five layers of the ladder, or refuses:
1. **Tab host disabled:** `EnableWindow(false)` on the tab's window, checked afterwards.
2. **Focus out:** keyboard focus moves out of the tab, into the UI. The app checks where focus went, and a disabled window cannot take it back.
3. **Overlay:** an owned layered overlay at alpha 1/255 covers the tab exactly; checked. Any button, wheel, touch or pen contact on it takes control. Moving or hovering does not, as in Electron.
4. **Renderer ignores input:** `Input.setIgnoreInputEvents(true)`. The app knows only that the call was accepted; CDP cannot read it back.
5. **Key chords swallowed:** an `AcceleratorKeyPressed` handler is armed. Any key that still reaches the tab is swallowed, recorded as a breach, and takes control.

It also turns off external drops on the tab, as section 6's upload control does while attached. This test checks the ladder as a whole; it does not isolate what each layer contributes.

### The agent and taking control

While attached, a stand-in agent acts on the page every 0.7 s through host scripts in an isolated world, as `TARGET_SCRIPT` does: it clicks a button and types into a field. Those are untrusted events, counted apart from human input. The page timestamps every agent effect.

Taking control works in the plan's order:
1. The generation is bumped and the attachment ends first.
2. The app lets any agent action already on its way land; it cannot be recalled.
3. It reads the counters.
4. It turns renderer input back on, re-enables the window and removes the overlay.

**Detach is judged two ways**:
- the time from your input to the end of the attachment;
- whether the agent changed the page later than 100 ms after your input.

Both must hold. For the **Take control** button, the time runs from your click in the UI.

### The self-check

`-- ladder --self-check` attaches and takes control three times through the app's own commands, without any input. It passed on 9 October 2026:
- all layers engaged, the agent acted, and no input reached the page or either frame;
- no agent effect landed after a takeover;
- the page rendered at the display's refresh rate while attached, with no dimming.

## Before you start

You need:
- This repository on main, at or after the commit that added `tests/Foundry.Spikes.BrowserSurface`.
- The .NET SDK from `global.json` and the Evergreen WebView2 runtime, both already on this machine.
- Your mouse and keyboard.
- About 45 minutes.

Optional, if you have them:
- a touchscreen or a pen;
- a precision touchpad;
- an installed IME, for example Japanese or Chinese;
- clipboard history (Windows+V);
- Accessibility Insights for Windows or Inspect.exe;
- Narrator.

Do not change Windows settings for this test. If something is off or missing, record *not tested* rather than turning it on, unless you decide to.

Start the app from the repository root:
```
dotnet run --project tests/Foundry.Spikes.BrowserSurface -c Release -- ladder
```

The window **Foundry S4 input ladder** opens:
- **Left panel:** the **Attach to chat** and **Take control** buttons, and the status.
- **Right:** the tab, holding the test page.

The test page shows, in order:
- a large counter;
- the input event types under it, then any hover, focus and scroll events, then the most recent events;
- a turning square, a *Frames rendered* count and a clock;
- form fields: a text field, a text area, an editable box, a button, a link, a list, a checkbox, a drop box and a scroll box. The button, the link, the drop box and the editable box turn yellow under the pointer when hover reaches the page;
- the two frames, each with a field and a button;
- the *Agent* area.

### How to read the screen

**The page's counter** has three phases:
- **Manual browsing:** it counts your input.
- **While attached:** it counts input since the attach. It must stay **0**.
- **After a takeover:** it freezes at the count during the attachment. Your later clicks no longer change it.

**Input events** come only from input: clicks, keys, wheel, touch, drag and drop, paste, composition. **Hover, focus and scroll events** are listed separately, because the browser can also generate them itself, for example right after a window activation. A few of those, at a moment you can explain, are expected. A stream of them while you move the pointer over the tab is a failure.

**The left panel:**

| Line | Meaning | While attached it must show |
|---|---|---|
| Badge | *Manual*, or *Attached · generation N* | *Attached* |
| Layers | each layer with ✓ or ✗; attach is refused unless all are ✓ | all ✓ |
| Agent actions | the stand-in agent's clicks and typing | rising |
| Human input on page | input events in the page and its frames since attaching, then any hover and focus events | **0** input events |
| Rendering | frames per second, pixels changed in a second and brightness shift, measured after attaching; or *not judged on screen* if the window was not fully in view | at least 20 frames/s (normally your display's refresh rate), pixels changing, shift under 4 |
| Last takeover | trigger, detach time, restore time, human events during that attachment, and any agent effect after your input | detach under 100 ms; 0 human events; no agent effect after the input |
| Breaches | focus or a key reaching an attached tab | **0** |

### Recording sheet

Copy this table into a note. For each input class write **pass**, **fail** or **not tested**, with what you saw. The app records the numbers itself.

| Step | Input class | What to check | Observed | Result |
|---|---|---|---|---|
| 0 | baseline | Manual typing reaches the page | | |
| 1 | attach | All layers ✓; agent acts; page renders normally | | |
| 2 | keyboard | Counter stays 0; tab does nothing | | |
| 3a | emoji panel (text services) | Counter 0 | | |
| 3b | clipboard history (Win+V) | Counter 0 | | |
| 3c | IME | Counter 0 | | |
| 4 | on-screen keyboard (injected keys) | Counter 0 | | |
| 5 | hover | Counter 0; no yellow highlight; still attached | | |
| 6 | left click, including in both frames | Takes control; detach times; 0 human events | | |
| 7 | other buttons, wheel, double-click | Same as 6 | | |
| 8 | touchpad | Same as 6 | | |
| 9a | touch | Same as 6 | | |
| 9b | pen | Hover does not take control; tap does | | |
| 10 | drag and drop | Refused; counter 0 | | |
| 11 | focus moves, Tab traversal | Focus never enters the tab | | |
| 12 | move and resize | The overlay follows the tab | | |
| 13 | Take control button | Detach under 100 ms | | |
| 14 | after takeover | The tab works again | | |
| 15 | UIA (documented residual) | What UIA can do | | |

## Steps

### 0. Baseline: manual browsing reaches the page

1. With the badge showing *Manual*, click in the page's **Text field** and type `abc`.

**Observe:** the counter rises, with `keydown`, `input` and the like listed under it. This proves the recorder sees your input.

### 1. Attach

1. Click **Attach to chat**.

**Observe:**
- The badge shows *Attached · generation N*.
- **Layers** shows all ✓.
- The page's title becomes *Human input that reached this page while attached*, and the counter shows 0.
- *Agent clicks* rises and `agent agent …` appears in the agent field, about every 0.7 s.
- The square keeps turning and *Frames rendered* keeps rising.
- The page looks exactly as before: not dimmed, not grayed, not frozen.
- After about 1.5 s, **Rendering** shows its measurements.
- The log may list hover and focus events that arrived while attaching, such as the tab's `blur`. Those are reported with the attachment, not counted against it. Input events count from the moment the attach begins, before any layer engages, so input that slips in while the layers engage does count against it.
- The log line ends with how many frames Chromium runs in their own process. It should be 1: the cross-site frame.

**Record:** the Layers and Rendering lines, and whether the page looked normal.

### 2. Keyboard while attached (do not click the tab)

Keyboard focus is in the UI, never in the tab. Press each of these in turn and watch the counter:
- Letters `abc`, Tab three times, Enter, Space, the arrow keys.
- Ctrl+A, Ctrl+C, Ctrl+V with text on the clipboard, Ctrl+Z.
- Ctrl+F, Ctrl+P, Ctrl+S, F5, Ctrl+R, Ctrl+W, Alt+Left, Alt+Right.
- Ctrl+plus, Ctrl+minus, Ctrl+0, F11, F12, Ctrl+Shift+I, Esc, Shift+F10, and the menu key if your keyboard has one.

Do not press Alt+F4: it closes the app.

**Observe:**
- The counter stays 0, and **Breaches** stays 0.
- Nothing happens in the tab or its frames: no find bar, print dialog, reload, navigation or zoom change.
- The badge stays *Attached*.

The keys go to the UI. A zoom key or Ctrl+wheel may zoom the UI itself; the tab must follow its area.

### 3. Text services: emoji panel, clipboard history and IME

Still attached:
1. **Windows+.** (period): pick an emoji from the emoji panel. This uses the same text services an IME does and is always available, so it is not optional.
2. **Windows+V:** if clipboard history is on, pick an entry. If Windows offers to turn it on, do not; record *not tested*.
3. **IME:** if one is installed, switch to it with Windows+Space, compose some text, commit it, and switch back. Otherwise record *not tested*.
4. **Optional:** Windows+H (voice typing).

**Observe:** the counter stays 0. Whatever is inserted goes to the UI or nowhere, never into the page's or the frames' fields.

### 4. On-screen keyboard (injected keys)

The On-Screen Keyboard sends its keys through `SendInput`, as an automated harness would. This covers injected keyboard input.

1. Still attached, open it with Windows+Ctrl+O and type a few letters on it.
2. Close it with Windows+Ctrl+O.

**Observe:** the counter stays 0.

### 5. Hover without clicking

1. Still attached, move the pointer slowly across the tab: over its fields, the button, the link, the drop box and both frames.
2. Rest it over the button for a few seconds.

**Observe:**
- The counter stays 0, and no hover events stream in.
- Nothing turns yellow under the pointer.
- The badge stays *Attached*: hovering is not taking control.

### 6. A click takes control (five times)

Repeat five times:
1. Attach if needed, and wait two seconds.
2. Click once inside the tab. Each time click somewhere different:
   - an empty area;
   - the page's button;
   - the text field;
   - **the field in the same-origin frame**;
   - **the button in the cross-site frame**.

**Observe each time:**
- The badge switches to *Manual* at once.
- The page's counter freezes, at 0.
- **Last takeover** reads `left button: detached in X ms (restored in Y ms); human events while attached 0`. If it adds *agent changed the page N ms after the input*, N must be under 100.

Then check the edges once:
1. Attach, and click inside the tab within a pixel or two of its edge. It must take control.
2. Attach again, and click just outside the tab, on the UI. It must not take control.

**Record:**
- the five detach times;
- any agent effect after the input;
- the edge results.

### 7. Other buttons, the wheel and double-click

Attach before each of these, and do it over the tab:
- a right-click;
- a middle-click;
- the side (back or forward) buttons, if your mouse has them;
- a wheel scroll;
- a wheel tilt (horizontal scroll), if your mouse has one;
- Ctrl+wheel;
- a double-click.

**Observe each time:**
- It takes control.
- Detach is under 100 ms, with no agent effect after it.
- Human events are 0.
- No context menu, navigation, scroll or zoom happens in the page.

If the wheel does not take control, Windows sent it to the UI, which has the keyboard focus. That happens when *Scroll inactive windows when I hover over them* is off. Then it must not reach the page either; record which happened.

### 8. Touchpad gestures (if you have a precision touchpad)

Attach before each gesture, and do it over the tab:
- a two-finger scroll;
- a pinch;
- a tap, if tap-to-click is on.

**Observe:** each gesture takes control, or reaches nothing. The page never scrolls or zooms while attached.

### 9. Touch and pen (if available)

Attach before each of these:
- **Touch:** tap the tab, swipe across it, pinch it.
- **Pen:** first hover over the tab without touching it. That must not take control. Then tap it.

**Observe:** each contact takes control. **Last takeover** names a *touch contact* or a *pen contact*, and human events are 0.

If you have no touchscreen or pen, record *not tested*: this run then gives no evidence for touch or pen.

### 10. Drag and drop

Attach before each of these drags:
1. Drag a file from File Explorer onto the page's **Drop files or text here** box, and drop it.
2. Select some text in Notepad or a browser, drag it onto the page's **Text field**, and drop it.
3. Drag a link, for example from a browser's address bar, onto the cross-site frame, and drop it.

**Observe each time:**
- The cursor shows that a drop is not allowed over the tab, and nothing lands in the page or a frame.
- The counter stays 0.
- The badge stays *Attached*: Windows sends no clicks during a drag.

After the three drags, click the tab to take control and check that **Last takeover** shows 0 human events.

### 11. Focus moves and Tab traversal

Attach, then:
1. Press Alt+Tab to another app, then Alt+Tab back.
2. Minimize the window from its title bar, then restore it from the taskbar.
3. Click in the left panel, then press Tab about 20 times. When focus reaches the end of the UI, the host would normally move it into the tab. While attached it refuses, and the log says *Tab-key traversal into the attached tab was refused*. This checks the host's own traversal rule, which the product must also implement. The platform's share of the evidence is that a disabled window cannot take focus.
4. Press Windows+D twice: to the desktop and back.

**Observe:**
- Focus never enters the tab: no focus ring appears in the page or its frames.
- The counter and **Breaches** stay 0.
- After each restore the badge still says *Attached*, and a click on the tab still takes control: the overlay came back with the window.

A `focus` or `blur` listed under hover and focus events right after an activation is the browser's own; note it.

### 12. Move and resize while attached

Attach, then in turn:
1. Drag the window by its title bar to another place.
2. Resize it from a corner.
3. Maximize it, then restore it.

**Observe after each:**
- The tab still lines up with its area.
- A click at the tab's edges takes control.
- A click just outside the tab does not.

Re-attach after each takeover.

### 13. The Take control button

1. Attach, then click **Take control** in the left panel.

**Observe:** the badge shows *Manual*, and **Last takeover** reads `the Take control button: detached in X ms`, measured from your click.

### 14. The tab works again after a takeover

After any takeover:
1. Click into the page's **Text field** and type.
2. Click the page's button and the frames' buttons.
3. Scroll the scroll box.
4. Press Tab from the UI's last control: focus moves into the tab.

**Observe:** the page responds normally. Typed text appears, the click count rises, and the box scrolls. The frozen counter does not change; that is expected.

### 15. UI Automation (optional, a documented residual)

UI Automation goes around the ladder by design. Section 6 accepts this residual: UIA invocations bypass the ladder, and screen-reader users cannot use the pane while it is attached. This step documents what UIA can do; it cannot fail S4.

Attach, then use one of these tools:
- **Accessibility Insights for Windows or Inspect.exe:** select the page's **Text field** and use the Value pattern's *Set value* with `uia`. Or select the page's button and use the Invoke pattern.
- **Narrator:**
  1. Start it with Ctrl+Windows+Enter.
  2. Move into the tab with Caps Lock and the arrow keys.
  3. Press Caps Lock+Enter on the page's button.
  4. Stop Narrator with Ctrl+Windows+Enter.

**Record:**
- whether the field's value or the button's click count changed;
- whether the counter counted it as a trusted `input`;
- whether the badge stayed *Attached*.

### 16. Finish

1. Close the window. The app writes `summary.md`.
2. Send Claude the results folder path and the filled recording sheet. Claude records the decision in the plan.

The results are in `test-results/spikes/s4-input-ladder/<time>/`:
- `summary.md`: per takeover, the trigger, the detach and restore times, any agent effect after the input, the input and the hover/focus events during the attachment, and page state changes (focus, scroll, navigation); plus the events while attaching, refused attachments, breaches and the frames that reported;
- `records.jsonl`: every attach, takeover and breach;
- `log.txt`.

## Verdict

**S4 passes for the input classes tested when all of these hold:**
- **No human input:** every attached step except 15 shows 0 input events in the page and its frames, 0 breaches, no page state change, and no reaction in the tab.
- **Fast detach:** every takeover in steps 6, 7, 8, 9 and 13 detached in under 100 ms, with no agent effect later than 100 ms after the input.
- **Correct rendering:** step 1 shows the page rendering normally while attached, and step 14 shows it fully usable afterwards.
- **Known counts:** no takeover's counts are *unknown*. A page or frame that reloaded, a frame that stopped reporting, or a page that could not be read counts as a failure. The left panel shows *UNKNOWN* in red when that happens.

**Classes marked *not tested* must be named in the decision.** These are typically touch, pen, an IME or clipboard history. This run gives no evidence for them; Rudy decides whether that is enough or whether decision 7 applies.

**If anything fails,** record the step and the layer involved. Decision 7 then applies: ship with **Attach to chat** disabled (view-only browsing), which does not block the cutover.

**About the numbers:**
- **Detach for the mouse, wheel, touch and pen** runs from the input's message time to the end of the attachment. The message time comes from `GetMessageTime`, which has about 16 ms resolution, so `0.0 ms` means the input was handled within the same timer tick.
- **Detach for the button** runs from your click in the UI.
- **Idle thread.** The host's UI thread is otherwise idle during this test, which flatters these numbers compared with a busy app.
- **Restore** also waits for any agent action in flight and for the frames' counts, then reads the counters and re-enables every layer. Expect tens of milliseconds.
