# S4 manual desktop observations — 11 October 2026

Partial run closed through its normal window control after the stand-in agent stopped acting. Summary was written and the process exited, but shutdown reported an unhandled harness exception. No overall S4 verdict; a fresh run is required for remaining steps.

Original generated evidence: `C:\Users\rdpro\Projects\foundry-agent-workspace-s6\test-results\spikes\s4-input-ladder\20261011-071536`.

The owner launched `dotnet run --project tests/Foundry.Spikes.BrowserSurface -c Release -- ladder` in the Codex Terminal panel. Rudy supplies physical test inputs. This is not `--self-check` or an injected-input certification. The test uses isolated temporary WebView2 profiles and loopback pages; no real application data.

| Step | Human observation | Owner readback | Disposition |
|---|---|---|---|
| 0. Baseline | Rudy: “Yes: abc appears and the counter rises” | Manual badge; Text field value `abc`; counter 24; three each of keydown, keypress, beforeinput, textInput, input and keyup | Pass |
| 1. Attach and rendering | Rudy: “Yes, all checks match” | Generation 1; five layers checked, external drop off; same-origin and cross-site frames present, one out-of-process frame; input 0, breaches 0, 32 agent actions at readback; 123 frames/s, 1,238 changed pixels in 1 s, brightness shift 0.6 | Pass |
| 2. Keyboard, first attempt | Rudy: “All tested; input 0, breaches 0, still attached” | Readback conflicts: left-button takeover at 07:22:26, detach 0.0545 ms, restore 71.7306 ms, attached input 0, agent effects after input 0. Current badge Manual; manual page counter 86 with keyboard events. Which keys ran before takeover is unknown | Inconclusive; repeat while attached |
| 2. Keyboard, repeat | Rudy: “Repeated: stayed Attached, input 0, Breaches 0” | Generation 3 remains attached, input 0, breaches 0; no new takeover; log says Tab traversal into attached tab refused at 07:27:20. Rendering remains 123 frames/s. Agent actions read 0 in this attachment, unlike generation 1 | Input-blocking checks pass; agent activity in this attachment needs verification |

Other steps remain pending. Explorer file drag, browser link drag, side mouse buttons, touch, pen and touchpad are not tested unless separately exercised and recorded. Missing optional input hardware or Windows features will remain not tested; no settings changes are authorized by this script.

Before step 3, Rudy confirmed “No, agent actions stay at 0” after watching five seconds. Generation 3 had no agent actions despite remaining attached and rendering. Generation 1 had 91 agent actions before its earlier takeover. The owner closed the window normally to preserve the generated summary and release the isolated profiles/server. The precise cause of lost agent activity is unproven; generation 3 is not evidence for active-agent takeover timing. No source changes were made.

At 07:30:23 shutdown saved `summary.md`, then logged an unhandled `System.ArgumentException: Value does not fall within the expected range` from `CoreWebView2.CallDevToolsProtocolMethodAsync` through `Surface.EvaluateAsync`, `LadderSpike.AgentActAsync` and `RestoreAsync`. The exception is harness evidence, not a certified ladder failure. The process was absent afterward; cleanup must not be inferred solely from the summary's “Finished” message.
