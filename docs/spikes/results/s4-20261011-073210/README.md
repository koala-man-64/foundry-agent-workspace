# S4 desktop recording — 11 October 2026

The corroborated input trials met their criteria. Rudy accepted S4 with the documented gaps on 12 October 2026: “I accept S4 with the documented gaps.” This resolves the human disposition without converting inconclusive or untested classes into measured passes. No product behavior, fallback or main integration was changed.

## Evidence

Rudy supplied physical inputs and observations; the owner prepared attachments and verified the window and logs. Owner setup clicks are not physical test evidence. Execution used the isolated BrowserSurface ladder spike, not real application data.

- [Generated summary](summary.md), [raw JSONL](records.jsonl), [log](log.txt): unchanged copies from `test-results/spikes/s4-input-ladder/20261011-073210` in the prepared spike worktree.
- [Detailed observations and conflicts](observations.md): identifies targets, user reports, live readbacks and inconclusive attempts.
- [Earlier partial run](../s4-20261011-071536/observations.md): keyboard observations, subsequent inactive agent and shutdown exception retained separately. It is not combined into a clean full-run pass.

The final run records 19 attachments and 19 takeovers, all restored. Worst detach was 16.0594 ms, below 100 ms. Input, hover/focus, breaches, unknown counts, state changes and late agent effects were all zero. Rendering was judged normal in 18 takeovers; the initial wheel trial occurred before agent activity/render judgment and was repeated successfully. Message-time detach uses roughly 16 ms clock resolution on an idle spike; it does not establish busy-product latency.

## Recording sheet

| Step / input | Result | Evidence or limitation |
|---|---|---|
| Manual baseline; attachment layers, active agent and rendering | Pass | Physical baseline plus live layer/counter/render readbacks |
| Keyboard chord sequence | Blocking observed; limited evidence | Earlier partial run, repeated with Attached/input 0/Breaches 0; agent later inactive and shutdown errored. No fresh full keyboard sequence with active agent was completed |
| OSK abc, emoji selection, clipboard-history selection | Pass | Physical OSK use; live Attached/input 0/Breaches 0 with rising agent actions |
| Composition IME; voice | Not tested | No composition IME; voice not exercised |
| Hover over controls and both frames | Pass | Human observation; zero aggregate hover/input |
| Empty area, main button/text field, same-origin field, cross-site button | Pass | Individually identified repeat trials, blocked initial actions, detach below 100 ms |
| Inside/outside page edges | Pass | Separate corroborated trials; conflicting initial batches retained |
| Right/middle click; Back/Forward buttons; vertical/Ctrl/horizontal wheel; double-click | Pass | Identified log records and physical observations; inactive initial wheel and unmatched initial Back report repeated |
| Touchpad, touchscreen, pen | Not tested | Rudy clarified these devices are unavailable |
| External Explorer file drop; browser link drop to cross-site frame | Pass | Physical refusal observations and live counters; final generation aggregate shows no input/state change |
| External text drop | Not tested | Could not perform external text drag |
| Alt+Tab; minimize/restore; repeated Tab traversal from UI | Pass | Physical observations, live counters, logged traversal refusals |
| Windows+D | Not tested | Physical Windows key unavailable; OSK workaround not exercised for this step |
| Move and resize; inside/outside boundaries | Pass | Identified repeats and matching overlay/tab geometry |
| Maximize/restore boundaries | Inconclusive | Human reports of Manual conflict with unchanged Attached generation 37 and no new takeover; no maximized boundary pass certified |
| Explicit Take control | Pass | Matching button trigger: detach 2.2675 ms, restore 85.4091 ms, no input or late effect |
| Manual recovery | Pass by Rudy's observation | Typing, all three buttons, scroll and Tab focus worked; frozen counter unchanged. Window closed before next live readback |
| Optional UI Automation residual | Not tested | No bypass claim; UIA remains the plan's documented residual |

## Finish and cleanup

On resumption the window was already closed. Log and Terminal both show `Finished. Summary` and Terminal returned to its PowerShell prompt, with no subsequent exception for this run. The generated summary timestamps completion rather than the folder's start time; it is preserved verbatim.

Independent read-only checks found no BrowserSurface spike process, no WebView2 process using a `foundry-spike-*` profile, no `foundry-spike-*` directory in the user's temporary directory, and no listener on port 58173. No deletion or recovery command was needed. External fixture/browser windows are outside spike cleanup; no user tabs or contents were removed.

SHA256 comparisons matched all three original files:

| File | SHA256 |
|---|---|
| log.txt | `2392E935F8D429F38349D29F9D5FF8A0E765CDC262436A9D43306D2281821274` |
| records.jsonl | `0DBB006E8411C5123FE17FF2A0639E66F7ADB39F7011885DCAACBC15BAE142B7` |
| summary.md | `CD639F667BD1169B0AD2EACB61004832EF74688E27853136F9AC80A071326692` |

Disposition — Rudy, 12 October 2026: accepted with the limited keyboard evidence, inconclusive maximize/restore edges and named untested classes retained. No further retest or decision-7 fallback is required by this acceptance. Main integration and real-data adoption remain separate approvals.
