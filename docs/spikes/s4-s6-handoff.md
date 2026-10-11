# Handoff: run spikes S4 and S6 and record them (P0 exit gate)

Written 11 October 2026 by the Claude session that built the S3/S4/S6 harnesses. This file is a handoff, not product documentation: delete it in the PR that records S4 and S6.

## Where things stand

- **Main is `e5517ac`.** It holds the S3/S6 harnesses, the S4 manual script ([PR #28](https://github.com/koala-man-64/foundry-agent-workspace/pull/28)), and S3 recorded as not run, with the whole-pixel inset accepted ([PR #29](https://github.com/koala-man-64/foundry-agent-workspace/pull/29)).
- **S3 is decided.** Nothing more is needed.
- **S4 and S6 have not run.** There are no results, nothing is registered or installed, and no spike process is running. This was checked on 11 October.
- **P0's exit gate is complete once S4 and S6 are recorded.** P1 starts only when Rudy confirms.

## Rudy's decisions for this run (10 October 2026)

1. **The agent makes the inputs with computer-use** (`mcp__computer-use__*`) while Rudy watches. This replaces the scripts' "Rudy performs every input by hand" for this run. Record it as such: the input is OS-injected through SendInput, not Rudy's hand.
2. **The agent starts the S6 run in the desktop app's Terminal panel** (`mcp__terminal__run_in_terminal`). Rudy answers the script's two console prompts in that tab himself, because no tool can type into a running terminal tab.

## Done already

- **Inno Setup 6.7.3 is installed per-user** at `C:\Users\rdpro\AppData\Local\Programs\Inno Setup 6\`. Rudy approved the install, and it stays installed.
  - Its publisher is **Pyrsys B.V.**, which jrsoftware's [verification page](https://jrsoftware.org/isdl-verify.php) confirms as the official publisher since 6.4.2. The signature is valid.
  - Its executables report version 0.0.0.0.
- **The S6 worktree exists:** a detached worktree of `e5517ac` at `C:\Users\rdpro\Projects\foundry-agent-workspace-s6`, created by the wrapper.
- **The wrapper `C:\tmp\s6\Start-S6.ps1` fails after installing.** Its version check rejects ISCC's 0.0.0.0, and its signer check expects "Jordan Russell". Do not use it again. Run `Run-S6.ps1` directly, as below.
- **Computer-use access** was granted to Notepad (full), File Explorer (click tier only), On-Screen Keyboard and Narrator. Grants last for one session, so request them again.
- **Computer-use minimizes every window that isn't allowlisted** when it takes a screenshot. Rudy's Chrome, ChatGPT, Terminal, Steam and game windows were minimized on 10 October. Tell him when you start.

## Next agent: steps

### 0. Set up

- **Work in your own worktree** on a task branch from `origin/main`. Never commit to main, and never `cd` into the main checkout at `C:\Users\rdpro\Projects\foundry-agent-workspace`; it holds another session's branch.
- **Read first:**
  - `docs/spikes/s6-toast-activation.md`
  - `docs/spikes/s4-input-ladder.md`, including its recording sheet and verdict rules
  - `docs/wpf-webview2-migration.md`: the spike table, and decision 7
  - `AGENTS.md`
- **Load the tools.** Load computer-use with ToolSearch `computer-use` (max 30), and load `mcp__terminal__run_in_terminal` and `mcp__terminal__read_terminal`.
- **Request access** with `request_access`: `Notepad`, `File Explorer`, `On-Screen Keyboard` and `Narrator`, plus `systemKeyCombos`, `clipboardWrite` and `clipboardRead`.
  - Request the spike exes by basename once their windows exist: `Foundry.Spikes.Toast.exe`, `Foundry.Spikes.BrowserSurface.exe`, and `msedgewebview2.exe` if the tab is masked.
  - When a toast, Notification Center or the emoji panel appears, the screenshot note names the process that owns it (for example `textinputhost.exe`). Request that basename too. `ShellExperienceHost.exe` and `ShellHost.exe` were not accepted while no window of theirs was showing.

### 1. S6 (about 15 minutes)

1. **Start the run in the Terminal panel.** Omit `cwd`: the tool refuses the S6 worktree as a directory, and the script resolves every path from its own location.
   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\rdpro\Projects\foundry-agent-workspace-s6\tests\Foundry.Spikes.Toast\Run-S6.ps1 -IsccPath "C:\Users\rdpro\AppData\Local\Programs\Inno Setup 6\ISCC.exe"
   ```
   This exact call was interrupted when the last session ended, before it ran: no results folder exists. Check `test-results\spikes\s6-toast-activation` in the S6 worktree before you start again; the script refuses a second concurrent run (`run.lock`).
2. **Follow the build** with `read_terminal`. Phase A's window, *Foundry S6 toast spike*, opens after the build.
3. **Do steps 1 to 5 in each phase** with computer-use. Use Notepad as "another window".
   - **Valid trials:** a trial counts only if the spike was not in front when the toast was clicked. Before clicking a banner, make sure an allowlisted app is in front; the frontmost app must be allowlisted for a click to go through.
   - **Screenshots:** don't take one within about 1 s after clicking a toast. The spike measures the foreground at 800 ms, and screenshots minimize windows.
   - **Answers:** answer the window's Yes/No questions from your screenshots. Add a note on each step saying the click was made by Claude via computer-use.
   - **Step 5:** ask Rudy in chat to press Enter and type what happened in the Terminal tab.
4. **The script cleans up** the registration, the toasts and the per-user install, and prints `Nothing was left behind` or `LEFT BEHIND` lines. Then check **Settings > System > Notifications** by screenshot only, without changing anything. *Foundry S6 toast spike* should not be listed.
5. **Read the results:** `summary.md` in the newest folder under `C:\Users\rdpro\Projects\foundry-agent-workspace-s6\test-results\spikes\s6-toast-activation\`.

### 2. S4 (about 45 minutes)

1. **Start the app from your worktree.** Use Bash with `run_in_background`, or the Terminal panel:
   ```
   dotnet run --project tests/Foundry.Spikes.BrowserSurface -c Release -- ladder
   ```
2. **Follow `docs/spikes/s4-input-ladder.md`, steps 0 to 16, with computer-use.** Fill its recording sheet as you go, in `recording-sheet.md` in the run's results folder.
   - **The UI webview** has browser accelerator keys and DevTools turned off. F5, Ctrl+P, F12 and the like do nothing there, and zoom still works.
   - **Expected *not tested* entries.** Name each one in the decision:
     - side mouse buttons, because computer-use has no X-button action;
     - touchpad gestures, touch and pen;
     - an IME, unless one is installed;
     - clipboard history, if Windows offers to turn it on (don't);
     - the file drag from File Explorer, because Explorer is click-tier and drags are blocked; Rudy may do that one drag by hand if he wants;
     - the link drag from a browser, because browsers are read-tier.
   - **Step 4, the On-Screen Keyboard:** UIPI may block clicks on it. If so, record that, and note that all of this run's keyboard input is already SendInput-injected.
   - **Step 15** is optional and cannot fail S4. Narrator is granted.
3. **Close the window.** The app writes `summary.md`, `records.jsonl` and `log.txt` under `test-results/spikes/s4-input-ladder/<time>/` in your worktree.

### 3. Record and merge

1. **On your task branch, update three files:**
   - `docs/wpf-webview2-migration.md`: the spike table rows for S4 and S6, with their result and date. Say that the inputs were made by Claude through computer-use (SendInput) with Rudy present, and list the classes not tested. The fallbacks are S4 → decision 7 (ship with **Attach to chat** disabled) and S6 → the in-app Inbox plus a taskbar flash.
   - `docs/implementation-status.md`: the "Next" section still says S6 runs on 9 October. Replace it with the actual runs and results, and state that P0's exit gate is complete, or what blocks it.
   - `docs/spikes/s4-input-ladder.md` and `docs/spikes/s6-toast-activation.md`: a dated status line with the verdict, like the S3 guide has.
2. **Delete this file.** Do not commit the results folders.
3. **Validate**, even for a docs-only change, because CI builds the solution:
   ```
   dotnet build Foundry.slnx -c Release -warnaserror
   ```
4. **Push and open the PR as separate commands:** `git push -u origin <branch>`, then `gh pr create`.
5. **Merge on green.** Rudy's standing P0 authority allows a squash merge once CI is green and the base is current:
   ```
   gh pr merge <n> --squash --match-head-commit <sha>
   ```
   Read CI once at work boundaries; never poll.
6. **Stop.** P1 starts only when Rudy confirms.

## Decisions that go back to Rudy

- **Any spike failure.** Whether decision 7 or the S6 fallback applies, or whether he wants a rerun by hand.
- **Not-tested classes.** Whether the S4 classes that were not tested are acceptable.
- **Disagreements.** The S6 summary flags any disagreement between its measurement and the answers; that is his decision.
- **Changes to product behavior, or to `AGENTS.md`.**

## Hard rules

- Never open `%LOCALAPPDATA%\FoundryAgentWorkspace` with tests or the .NET runtime.
- Never write WebView2 policy registry keys, and never change Windows settings (display scaling, notifications, clipboard history).
- Do not build an automated input harness; computer-use performing the manual script is what Rudy approved.
- Never force-push.
