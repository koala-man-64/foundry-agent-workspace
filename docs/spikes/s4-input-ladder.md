# Spike S4: input ladder, manual test script

**Question** ([plan](../wpf-webview2-migration.md), section 6 and the spike table): while a tab is attached to a chat, does any human input reach the page, does a human takeover detach the agent fast enough, and does the page still render while its window is disabled?

**Exit criterion:**
- Zero events reach the page except through UIA, which is documented.
- Detach takes under 100 ms.
- The disabled window renders correctly.

**If S4 fails, decision 7 applies:** ship with **Attach to chat** disabled (view-only browsing). This does not block the cutover.

**How it runs (Rudy's choice, 8 October 2026):** Rudy performs every input by hand, following this script. No program generates input. The app below is the subject of the test; it only records what reaches the page.

## The subject

`tests/Foundry.Spikes.BrowserSurface` in `ladder` mode. It is the plan's browser surface: the UI in one WebView2 environment, and a tab in a separate environment, inside its own child window.

Attaching engages all five layers of the ladder, verifying each, or refuses:
1. **Tab host disabled:** `EnableWindow(false)` on the tab's window.
2. **Focus out:** keyboard focus moves out of the tab, into the UI. A disabled window cannot take it back.
3. **Overlay:** an owned layered overlay at alpha 1/255 covers the tab exactly. Any button, wheel, touch or pen contact on it takes control. Moving or hovering does not, as in Electron.
4. **Renderer ignores input:** the CDP call `Input.setIgnoreInputEvents(true)`.
5. **Key chords swallowed:** `AcceleratorKeyPressed` swallows any key that still reaches the tab, records a breach and takes control.

It also turns off external drops on the tab, as section 6's upload control does while attached.

While attached, a stand-in agent acts on the page every 0.7 s through host scripts in an isolated world, as `TARGET_SCRIPT` does: it clicks a button and types into a field. Those are untrusted events and are counted apart from human input.

Taking control works in the plan's order. The generation is bumped and the attachment ends first. Then the app reads the page's counters, turns renderer input back on, re-enables the window and removes the overlay.

`-- ladder --self-check` attaches and takes control three times through the app's own commands, without any input. It passed on 8 October 2026:
- all layers engaged every time, the agent acted, and no human events reached the page;
- the page rendered at about 100 frames/s while attached, with no dimming;
- restore took 2 to 4 ms.

## Before you start

You need:
- This repository on main, at or after the commit that added `tests/Foundry.Spikes.BrowserSurface`.
- The .NET SDK from `global.json` and the Evergreen WebView2 runtime, both already on this machine.
- Your mouse and keyboard.
- About 40 minutes.

Optional, if you have them:
- a touchscreen or a pen;
- a precision touchpad;
- an installed IME, for example Japanese or Chinese;
- clipboard history (Windows+V);
- Accessibility Insights for Windows or Inspect.exe;
- Narrator.

Do not change Windows settings for this test. If something optional is off or missing, record *not available* rather than turning it on, unless you decide to.

Start the app from the repository root:
```
dotnet run --project tests/Foundry.Spikes.BrowserSurface -c Release -- ladder
```

The window **Foundry S4 input ladder** opens:
- **Left panel:** the **Attach to chat** and **Take control** buttons, and the status.
- **Right:** the tab, holding a test page.

The test page shows, in order:
- a large counter titled *Human input that reached this page*, with the event types under it;
- a turning square and a *Frames rendered* count;
- form fields: a text field, a text area, an editable box, a button, a link, a list, a checkbox, a drop box and a scroll box;
- the *Agent* area.

### How to read the left panel

| Line | Meaning | While attached it must show |
|---|---|---|
| Badge | *Manual*, or *Attached · generation N* | *Attached* |
| Layers | each layer with ✓ or ✗; attach is refused unless all are ✓ | all ✓ |
| Agent actions | the stand-in agent's clicks and typing | rising |
| Human input on page | trusted events the page received since attaching | **0** |
| Rendering | frames per second, pixels changed in a second, brightness shift, measured after attaching | about 60 frames/s or more, pixels changing, shift under 4 |
| Last takeover | trigger, detach time, restore time, human events during that attachment | detach under 100 ms; human events 0 |
| Breaches | focus or a key reaching an attached tab | **0** |

The page's own large counter shows the same human-input count. It resets each time you attach.

### Recording sheet

Copy this table into a note and fill in *Observed* and *Result* as you go. The app records the numbers itself; you record what you saw.

| Step | What to check | Observed | Result |
|---|---|---|---|
| 0 | Manual typing reaches the page | | |
| 1 | Attach: all layers ✓; agent acts; page renders normally | | |
| 2 | Keyboard: page counter stays 0; tab does nothing | | |
| 3 | Clipboard history, emoji panel, IME: counter 0 | | |
| 4 | On-screen keyboard: counter 0 | | |
| 5 | Hover: counter 0; still attached | | |
| 6 | Left click ×5: takes control each time; detach times; 0 human events | | |
| 7 | Right, middle, side buttons, wheel, tilt, Ctrl+wheel, double-click | | |
| 8 | Touchpad gestures | | |
| 9 | Touch and pen | | |
| 10 | Drag and drop: refused; counter 0 | | |
| 11 | Focus attempts: focus never enters the tab | | |
| 12 | Move and resize: the overlay follows the tab | | |
| 13 | Take control button | | |
| 14 | After takeover the tab works normally | | |
| 15 | UIA (optional, documented residual) | | |

## Steps

### 0. Baseline: manual browsing reaches the page

1. With the badge showing *Manual*, click in the page's **Text field** and type `abc`.

**Observe:** the page's counter rises, with `keydown`, `input` and the like listed under it. This proves the recorder sees human input.

**Record:** the counter value. **Pass** if it rose.

### 1. Attach

1. Click **Attach to chat**.

**Observe:**
- The badge shows *Attached · generation N*.
- **Layers** shows all ✓: tab host disabled, focus out of the tab, overlay over the tab, renderer ignores input, key chords swallowed, external drop off.
- The page's counter resets to 0.
- *Agent clicks* rises and `agent agent …` appears in the agent field, about every 0.7 s.
- The square keeps turning and *Frames rendered* keeps rising.
- The page looks exactly as before: not dimmed, not grayed, not frozen.
- After about 1.5 s, **Rendering** shows the frame rate, the pixels changed and the brightness shift.

**Record:** the Layers line, the Rendering line, and whether the page looked normal.

**Pass** if all layers are ✓, the agent acts, and the page renders normally.

### 2. Keyboard while attached (do not click the tab)

Keyboard focus is in the UI, never in the tab. Press each of these in turn and watch the page's counter:
- Letters `abc`, Tab three times, Enter, Space, the arrow keys.
- Ctrl+A, Ctrl+C, Ctrl+V with text on the clipboard, Ctrl+Z.
- Ctrl+F, Ctrl+P, Ctrl+S, F5, Ctrl+R, Ctrl+W, Alt+Left, Alt+Right.
- Ctrl+plus, Ctrl+minus, Ctrl+0, F11, F12, Ctrl+Shift+I, Esc, Shift+F10, and the menu key if your keyboard has one.

Do not press Alt+F4: it closes the app.

**Observe:**
- The counter stays 0, and **Breaches** stays 0.
- Nothing happens in the tab: no find bar, print dialog, reload, navigation or zoom change.
- The badge stays *Attached*.

The keys go to the UI, which ignores most of them. Anything the UI itself does is not a tab event, but note it.

**Record:** the counter after the step, and any reaction in the tab. **Pass** if the counter is 0 and the tab did nothing.

### 3. Clipboard history, emoji panel and IME

Still attached:
1. **Windows+V:** if clipboard history is on, pick an entry. If Windows offers to turn it on, do not; record *not available*.
2. **Windows+.** (period): pick an emoji from the emoji panel.
3. **IME:** if one is installed, switch to it with Windows+Space, compose some text and commit it. Then switch back.
4. **Optional:** Windows+H (voice typing), if you use it.

**Observe:** the counter stays 0. Whatever is inserted goes to the UI or nowhere, never into the page's fields.

**Record:** the counter, and *not available* for anything you could not try. **Pass** if the counter is 0.

### 4. On-screen keyboard

1. Still attached, open the On-Screen Keyboard with Windows+Ctrl+O and type a few letters on it.
2. Close it again with Windows+Ctrl+O.

**Observe:** the counter stays 0.

**Record:** the counter. **Pass** if it is 0.

### 5. Hover without clicking

1. Still attached, move the mouse across the tab: over its fields, the button and the link.
2. Rest it over the button for a few seconds.

**Observe:**
- The counter stays 0, with no `mousemove` or `pointerover`.
- The page shows no hover effects.
- The badge stays *Attached*: hovering is not taking control.

**Record:** the counter and the badge. **Pass** if the counter is 0 and the badge still says *Attached*.

### 6. A click takes control (five times)

Repeat five times:
1. Attach if needed, and wait two seconds.
2. Click once inside the tab. Each time click somewhere different: an empty area, the button, the text field, the link, near an edge or a corner.

**Observe each time:**
- The badge switches to *Manual* at once.
- **Last takeover** reads `left button: detached in X ms (restored in Y ms); human events while attached 0`.
- The click itself did not reach the page: the human-event count at takeover is 0.

Then check the edges once:
1. Attach, and click inside the tab within a pixel or two of its edge. It must take control.
2. Attach again, and click just outside the tab, on the UI. It must not take control.

**Record:** the five detach times, and the edge results.

**Pass** if every detach is under 100 ms, every takeover shows 0 human events, and both edge results are as expected.

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
- Detach is under 100 ms.
- Human events are 0.
- No context menu, navigation, scroll or zoom happens in the page.

If the Windows setting *Scroll inactive windows when I hover over them* is off, the wheel goes to the UI instead. Then it neither takes control nor reaches the page; record that.

**Record:** each trigger and its detach time. **Pass** if all of them take control in under 100 ms with 0 human events.

### 8. Touchpad gestures (if you have a precision touchpad)

Attach before each gesture, and do it over the tab:
- a two-finger scroll;
- a pinch;
- a tap, if tap-to-click is on.

**Observe:** each gesture takes control, or reaches nothing. The page never scrolls or zooms while attached.

**Record:** each gesture and what happened.

### 9. Touch and pen (if available)

Attach before each of these:
- **Touch:** tap the tab, swipe across it, pinch it.
- **Pen:** first hover over the tab without touching it. That must not take control. Then tap it.

**Observe:** each contact takes control. **Last takeover** names a *touch contact* or a *pen contact*, and human events are 0.

**Record:** each input, its trigger name and detach time.

### 10. Drag and drop

Attach before each of these drags:
1. Drag a file from File Explorer onto the page's **Drop files or text here** box, and drop it.
2. Select some text in Notepad or a browser, drag it onto the page's **Text field**, and drop it.
3. Drag a link, for example from a browser's address bar, onto the tab, and drop it.

**Observe each time:**
- The cursor shows that a drop is not allowed over the tab, and nothing lands in the page.
- The counter stays 0.
- The badge stays *Attached*: Windows sends no clicks during a drag.

After the three drags, click the tab to take control and check that **Last takeover** shows 0 human events.

**Record:** each drag and the counter. **Pass** if all three were refused with the counter at 0.

### 11. Focus attempts

Attach, then:
1. Press Alt+Tab to another app, then Alt+Tab back.
2. Minimize the window from its title bar, then restore it from the taskbar.
3. Click in the left panel, then press Tab about 20 times to cycle through the UI.
4. Press Windows+D twice: to the desktop and back.

**Observe:**
- Focus never enters the tab: no focus ring appears in the page.
- The counter and **Breaches** stay 0.
- After each restore the badge still says *Attached*, and a click on the tab still takes control: the overlay came back with the window.

**Record:** the counter and **Breaches** after the step. **Pass** if both are 0 and the click still takes control.

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

**Record:** anything misaligned. **Pass** if the overlay followed the tab every time.

### 13. The Take control button

1. Attach, then click **Take control** in the left panel.

**Observe:** the badge shows *Manual*, and **Last takeover** reads `the Take control button: detached in X ms`.

**Record:** the detach time. **Pass** if it is under 100 ms.

### 14. The tab works again after a takeover

After any takeover:
1. Click into the page's **Text field** and type.
2. Click the page's button.
3. Scroll the scroll box.

**Observe:** the counter rises, and the page responds normally: typed text appears, the button's click count rises, and the box scrolls.

**Record:** whether it all worked. **Pass** if the page responds normally.

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
- whether the counter rose;
- whether the badge stayed *Attached*.

### 16. Finish

1. Close the window. The app writes `summary.md`.
2. Send Claude the results folder path and the filled recording sheet. Claude records the decision in the plan.

The results are in `test-results/spikes/s4-input-ladder/<time>/`:
- `summary.md`: the takeovers, with trigger, detach and restore times, and human events during each attachment; plus refused attachments and breaches;
- `records.jsonl`: every attach, takeover and breach;
- `log.txt`.

## Verdict

**S4 passes when all of these hold:**
- **No human input:** every attached step except 15 shows 0 human events, 0 breaches, and no reaction in the tab.
- **Fast detach:** every detach in steps 6, 7, 8, 9 and 13 is under 100 ms.
- **Correct rendering:** step 1 shows the page rendering normally while attached, and step 14 shows it fully usable afterwards.

If any of these fails, record the step and the layer involved. Decision 7 then applies: ship with **Attach to chat** disabled (view-only browsing), which does not block the cutover.

**About the numbers:**
- **Detach** runs from the input's message time to the end of the attachment. The message time comes from `GetMessageTime`, which has about 16 ms resolution, so `0.0 ms` means the input was handled within the same timer tick.
- **Restore** also includes reading the page's counters and re-enabling every layer.
