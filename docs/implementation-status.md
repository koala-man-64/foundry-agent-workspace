# Implementation status

## WPF + WebView2 migration — P1 privately qualified; P2 in progress, integration held

Recorded 8 October 2026. The [migration plan](wpf-webview2-migration.md) replaces Electron and Node with three parts, delivered in a single cutover:
- a WPF host on .NET 10;
- WebView2 hosting the existing React UI;
- a C# runtime.

**No product behavior has moved.** The Electron application and the TypeScript runtime remain the product and the behavioral authority.

P0 deliverables so far:
- The approved plan (#12).
- The .NET solution skeleton (`Foundry.slnx`): the seven projects of the plan's layout, with placeholder entry points that exit non-zero; `global.json` (SDK 10.0.300, no roll-forward); central package management; lock files restored in locked mode in CI; nuget.org-only source mapping; NuGet audit with warnings as errors.
- Culture-sensitive string analyzers (CA1304, CA1305, CA1309, CA1310, CA1311) as errors.
- `BannedSymbols.txt` enforcing the runtime loop model (41 entries) and, since S7, `BannedSymbols.Launch.txt` in every product project, so processes launch only through `JobProcess` (2 entries). Each entry was shown to fire with a temporary probe.
- `Foundry.Architecture.Tests` enforcing the dependency graph and trust boundaries. Injected violations were shown to fail.
- The `.NET build` workflow: locked restore, build with warnings as errors, and test on every pull request.
- Golden vectors (`tests/golden`) that pin TypeScript behavior for the port: `JSON.stringify` edges and hashes, both profile fingerprints, UTF-8-ordered handoff manifests, schedule gaps and folds, redaction regex semantics, and MCP admission. The RPC corpus covers 99 schemas (RPC methods, bridge channels and non-RPC frames) with 4,149 seeded and mutated cases and zod's verdicts, plus 15 wire-level parser cases. The unit tests fail on drift. `scripts/golden-path-key.mjs` mirrors `pathKey` for machine-local cross-language checks and is proven equal to the runtime's.

- Fixture databases (`tests/fixtures/databases`): six real databases written by each schema era’s own runtime (`f75d1ed`, `2b42bb7`, `cdec0a3`, `0212982`, current main), driven over stdio through one shared profile and each era’s confirmed upgrade, so later fixtures hold every earlier era’s row shapes. They include an abruptly stopped v5 with an uncheckpointed WAL and a response in flight. Each fixture’s `expected-after-open.json` pins what the current `Store` changes on open (the `user_version` stamp, the DDL that re-runs on every open, and `recover()`’s transitions); the unit tests keep it current. Paths come from a name-free scratch root, and the generator rejects any output containing the user name or profile path.

- Spike S8a (SQLite parity), adopted. Microsoft.Data.Sqlite 10.0.12 (SQLite 3.53.3) returns better-sqlite3 13.0.3's (SQLite 3.53.4) results for every recorded query on all six fixtures. That includes the real search SQL, FTS5, both expression and descending indexes, and JSON, number and date functions. A live WAL database backs up and verifies, and read-only opens see WAL pages. `tests/Foundry.Runtime.Tests` keeps the parity under test; the decision is recorded in the plan.

- Spike S8b (strict JSON reader), decided. Both host boundaries reject non-canonical integers (`4.0`, `4e0`), lone-surrogate escapes and a leading BOM, in addition to the plan's duplicate-key, depth and unknown-property rules. `tests/Foundry.Protocol.Tests` proves all 15 wire cases on the bridge-string and stdio-byte paths. `rpc-wire.json` now records a decision for every case.

- Spike S7 (Win32 primitives), adopted. `Foundry.Platform` now holds `JobProcess`, `FinalPath`, `ProtectedDirectory` and `ProtectedSecret` on hand-written `LibraryImport` interop. `tests/Foundry.Platform.Tests` (62 tests) proves them:
  - **Process trees.** The TypeScript process-cleanup scenarios pass natively. Killing a real job owner reclaims its nested tree. A decoy inheritable handle stays out of the child, and concurrent launches never share pipe ends. Because a redirected `Process.Start` does inherit that handle, all product code now bans `System.Diagnostics.Process`.
  - **Path keys.** `FinalPath` matches Node 24's `pathKey` across a real-tree corpus. The spike found two Node behaviors that the port now reproduces: realpath namespacing (trailing dots, trailing spaces and long paths) and full-case lowercasing (`İ` and the final sigma). The lowercase ships as Electron 44's Unicode 17 tables, so keys do not move with Windows' older ICU. Scope checks get a no-fallback `TryResolve`.
  - **Protected directories.** The on-disk descriptor equals the PowerShell result.
  - **DPAPI writes.** Entropy must be a digest, and the write-through atomic write keeps the old file on failure.

  The independent security review (Sonnet, high, from its definition) returned a conditional GO. Every condition is addressed and covered by tests.

  S7 and S8, the two spikes that gate P1 code, are now both complete.

- The stdio trace recorder (`scripts/runtime-trace.mjs`) taps a driver's runtime child from inside the driver. It records both directions, stderr and exit as JSON lines, never writes credential values, never throws into or delays the driver, and provides a normalizer and a `compare` command for differential runs.
  - `pnpm smoke:package` records each runtime launch when `FOUNDRY_RUNTIME_TRACE` is set. Traced and untraced runs pass against the packaged runtime.
  - Two traced runs diverge after 139 normalized records: polls observe racing states, concurrent children interleave events, and the event count varies. P2's differential traces therefore need deterministic scenarios; the plan records this.
  - The independent review (Sonnet, high, from its definition) returned NO-GO on the first version. The findings were redaction gaps for malformed, batched and encoded frames; tap failures that could reach the driver; and a listener that changed when the driver read. All are fixed. Tests inject each case, and mutations show that each test fails without its fix.

- The zod-free limits module (`packages/protocol/src/limits.ts`). It imports nothing and holds the three values the renderer used from the protocol package: `CHANNEL_LIMITS`, `ORCHESTRATION_LIMITS` and `supportedEfforts`. The zod modules build on it and re-export it, so the package's public API is unchanged.
  - An ESLint rule keeps every other renderer import from the protocol type-only.
  - The renderer bundle drops from 1,503,829 to 1,289,682 bytes and holds no zod.
  - The golden RPC corpus shows every schema verdict unchanged. All 21 Electron E2E tests pass.

- Spike S1 (publish layout), decided.
  - The runtime starts without WPF.
  - Two self-contained apphosts can share a folder, but their closures disagree on two files: a facade versus WPF's `WindowsBase.dll`, and the `ProtectedData` package versus WindowsDesktop's copy. Publish's newest-file copy then leaves each app a file its deps.json did not select.
  - P4 therefore publishes the runtime into its own subfolder: 34 MB more zipped (94 MB in total) for no reconciliation. The plan records sizes and start-up times.

- Spike S10 (exclusion, restore, installer), decided.
  - **Exclusion signals.** The `FileShare.None` probe reads the database, WAL and shared memory as busy while an idle TypeScript runtime holds them, without changing them. Electron's Chromium `lockfile` is held while the app runs, so both signals are verified.
  - **Restore hazard.** Copying a backup over a database that a connection still holds succeeds and is then silently undone by that connection's close-time checkpoint, so the rollback runbook now restores by rename. The rename is refused while any holder exists.
  - **Installer.** The `windows-2025` runner compiles a per-user Inno Setup installer with no install step.

- Spike S2 (bridge and lock-down), decided. `tests/Foundry.WebView2.Tests` runs a real WebView2 serving the `foundry-app` scheme with header CSP, and a prototype of the plan's gate.
  - **Gate.** The prototype accepts the app document's well-formed messages and rejects exactly the oversized, malformed, non-string and foreign-origin ones. WebView2 delivers oversized strings whole, so the host enforces the 1 MiB cap.
  - **CSP.** The header blocks `eval`, inline script and `fetch`.
  - **Frames and popups.** Frames never reach the host's message handler, and a handled `NewWindowRequested` opens nothing.
  - **Lock-down.** `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` opens a debug port for a non-elevated host, and clearing the five variables closes it. Elevated processes, including the CI runner's, ignore both the variable and an HKCU policy. The artifact audit's debug-port check must therefore launch non-elevated; the plan records this.

- Spike S9 (CI runner and CDP), decided. The `windows-2025` runner hosts WebView2, and Playwright's `connectOverCDP` attaches to two environments through API-only debug ports. The .NET workflow now installs the locked Node dependencies, so this attach runs on every pull request.

- Spike S5 (integrated-browser parity), decided. `BrowserParityTests` (12 tests) reproduces against real loopback origins what both `browser.spec` scenarios and `browser-manager.ts` rely on:
  - persistence across a restart, on the named profile;
  - popup adoption with its opener, configured like any tab;
  - per-origin and whole-profile clearing;
  - `SNAPSHOT_SCRIPT` run verbatim in an isolated world;
  - file-chooser interception and the selected-file precheck;
  - held and cancelled downloads;
  - certificate and basic-authentication refusal;
  - upload blocking for documents, dedicated and service workers, beacons and redirected requests.

  WebView2 differences changed the plan's browser design (section 6):
  - **Downloads.** Held downloads are written early, so they are staged in a host folder that is swept at startup.
  - **Redirects.** A cancelled redirect has already sent its request, so the navigation guard runs in a request filter.
  - **Shared workers.** Their requests cannot be filtered: the filter kind stalls them after a reload. The integrated browser runs without shared workers, with target discovery as a backstop.
  - **Upload bodies.** WebView2 does not reveal whether a body came from a file or a blob. While attached, every body without a text-like type is therefore blocked. This is a heuristic, because the page chooses the type. A raw page-held file or blob sent as text remains a residual, which Rudy accepted.
  - **`chrome.webview`.** It exists in every page and frame, so the negative test checks that nothing posted through it reaches the host.

  The independent security review (Sonnet, high, from its definition) returned NO-GO on the first version. It found overstated upload and shared-worker claims and several Electron guards the plan had not carried over. It returned GO on the fixes, and its two remaining recommendations are applied:
  - the body rule is described as a heuristic;
  - attach confirms that shared workers are absent in every frame.

  Section 6's prescriptions that S5 left untested are listed among the plan's security tests.

- Run-ready harnesses for the three host spikes that Rudy runs himself ([docs/spikes](spikes/)). None of them changes a system setting.
  - **S3 (tab bounds).** `tests/Foundry.Spikes.BrowserSurface` measures on screen while Rudy switches display scaling. Its arithmetic and pixel classification are unit-tested.
    - A preview at 100%, with 125 to 200% simulated, shows exact placement, re-synced by the host on its own.
    - It also shows the UI's whole-pixel bounds missing near-worst fractional layouts by up to zoom × scale: 4 px at 200% and zoom 2.
    - Rudy decided on 9 October 2026 not to run S3 (see Next).
  - **S4 (input ladder).** The same app implements section 6's five-layer ladder as the subject of a manual test script; nothing generates input.
    - The test page has a same-origin and a cross-site frame.
    - Detach is judged by when the agent last changed the page.
    - Its self-check passed.
  - **S6 (toasts).** `tests/Foundry.Spikes.Toast` and `Run-S6.ps1` test the unzipped exe and a per-user Inno Setup install, then remove the registration and the install and verify that nothing is left. CI compiled the installer.
  - **Reviews.** Independent reviews of security and of test validity reshaped all three. After its findings were fixed, the security review gave GO for running S6 on Rudy's machine. The test-validity review's findings are all resolved.

Next, as Rudy decided on 9 October 2026:
- **S3: decided without a run, by Rudy's decision.**
  - The preview is S3's only evidence.
  - Rudy accepted the UI's whole-pixel inset with no protocol change. The criterion is restated as "within the UI's whole-pixel rounding, never over the UI".
  - P3's exit gate checks it with `browser.spec` at 100/150/200% DPI and zoom 2.
- **S4: desktop run completed 11 October 2026; tested input classes passed; accepted by Rudy with documented gaps on 12 October 2026.** The [recording sheet, raw results and cleanup](spikes/results/s4-20261011-073210/README.md) retain 19 takeovers: worst detach 16.0594 ms; zero attached input/hover events, breaches, unknown counts, page state changes or late agent effects; all restores succeeded. Physical clicks in the page and both frames, right/middle/side buttons, vertical/Ctrl/horizontal wheel, double-click, OSK text/emoji/clipboard, hover, external file/link drags, focus checks, move/resize edges and Take control passed the identified trials. Rudy confirmed normal Manual typing, buttons, scrolling and focus afterward. Keyboard chords were observed blocked in the earlier partial run, which later had an inactive agent and a shutdown exception; that limitation is preserved separately. Maximize/restore edge reports conflict with live readback and remain **inconclusive**. IME, voice, touchpad, touch, pen, external text drag, Windows+D and UIA are **not tested**. Final summary saved; independent checks found no spike processes, temporary spike profiles or loopback listener. Rudy's acceptance below resolves this run's disposition without invoking decision 7; no main integration authorized.
- **S6: desktop run completed 11 October 2026; activation inconclusive.** The [results and cleanup evidence](spikes/results/s6-20261011-063102/README.md) preserve the generated summary, both phase JSONL files, installer/uninstaller logs and console transcript. Installed Notification Center activation passed (one valid trial; behind another window, matching arguments, foreground after 800 ms), agreeing with Rudy. Steps 1–2 in both phases timed out without activation; these are inconclusive, not observed foreground failures. Unzipped step 3 has conflicting evidence: Rudy observed foreground activation, but no activation event was recorded. Taskbar flash was observed in both phases. After app closure, Rudy reported “clicked it and codex app flashed” (unzipped) and “clicked it; nothing happened” (installed); neither phase recorded a spike restart. Runner cleanup and independent residue checks passed; Rudy confirmed the spike was absent from Windows Settings → System → Notifications. Rudy's subsequent acceptance is recorded below; the measured limitations remain unchanged.

**S6 disposition — Rudy, 11 October 2026:** accepts the current toast/notification behavior without further retest or fallback; he will handle Windows Do not disturb. This resolves the S6 human decision while retaining the inconclusive measured trials and conflicting observation above. No COM-activator exploration is required by this acceptance.

**S4 disposition — Rudy, 12 October 2026:** “I accept S4 with the documented gaps.” This accepts the limited keyboard evidence, inconclusive maximize/restore boundary trials, and named untested classes. It resolves the S4 human decision; no additional retest or decision-7 fallback is required by this acceptance. Raw measurements and gaps remain unchanged.

With S3, S4 and S6 decided and the other spike outcomes recorded, P0's documented spike exit gates are resolved. Next is P1 **Contract & platform**: protocol corpus parity, the runtime loop, the Store and `workspace.summary`, building on the S7 platform primitives. P1 must prove full corpus agreement, identical normalized fixture dumps and structure, and green platform security tests, with independent security/data review where required. Re-baseline the migration schedule after P0. The local evidence/decision changes still require their review and authorized main integration; this acceptance authorizes neither integration nor real-data adoption.

These program rules hold until the P5 cutover:
- Protocol and runtime features are frozen, except the planned P4 deltas: adoption RPCs and removal of the JavaScript script language.
- Security and data-loss fixes land in both implementations and are listed below.
- The .NET runtime never opens the real data directory before adoption.

Dual-landed fixes:
- **Saved-project/preference transition atomicity and failed-delivery admission** (13 October 2026). Independent P2 data review found that TypeScript saved these records and inserted their events in separate commits. Both implementations now commit each mutation and event together and notify afterward. Event insertion failure rolls back the state; notification failure retains the authoritative commit and closes admission to retries. Security re-review additionally required stopping independent orchestration and automation on delivery failure: TypeScript closes both synchronously and rechecks closing after awaited Git-state/pin validation before a new child or script launch. C# has no orchestration/script execution handler yet and denies these operations before mutation; those future ports must retain these guards. Never-launched scripts remain queued for safe recovery, and already-admitted work keeps conservative intent recovery. This is a data-integrity/lifecycle correction under the dual-landed-fix rule, not a feature expansion.
- **Fractional usage-trend date bounds** (13 October 2026). Rudy explicitly authorized correcting both runtimes after independent security review found that lexical UTC timestamp comparisons rejected `.1Z`–`.12Z` and excluded equivalent `.100Z` records. Both local implementations now compare exact instant keys, preserving arbitrary fractional precision and inclusive endpoints; SQL retains an indexable whole-second candidate window. No stored rows, keys, schema or API were rewritten. The original failing observations are retained in `test-results/p2-usage-trend-fraction-before.json`. Final validation and independent review are recorded below; external publication remains held.
- **Refusing network-share paths from the renderer** (plan decision 8). Landed in the TypeScript runtime on 8 October 2026; the C# runtime takes the same test cases when it is ported.
  - **The exposure:** a compromised renderer could make Windows send the user's NTLM credentials to any server it named.
  - **Inputs now refused:** UNC, device and NT-namespace paths given to `project.add`, `task.create`, a hook's working directory, or an MCP server's command, working directory or absolute arguments. The check runs before any filesystem call.
  - **Mapped drives:** a project whose canonical path is a network drive is refused.
  - **Saved before the fix:** a project or task saved on a share is reported unavailable and never probed, and Git operations on it are refused. Hooks and MCP servers saved with network paths are refused at launch.
  - **Review:** the independent security review (Sonnet, high, from its definition) returned GO. Its follow-ups are applied: a spy proves no share is resolved before the check, and saved paths are no longer probed. Removing any one of the 13 checks makes a test fail.

| Seat | Model / effort | Selection source | Routing reason |
| --- | --- | --- | --- |
| Architecture and delivery (`architecture-review-agent`) | Sonnet / high | Agent definition frontmatter | Independent architecture view; parallel reading of main, protocol, runtime and providers |
| Security (`cloud-security-vulnerability-expert`) | Sonnet / high | Agent definition frontmatter | Required independent review for credential, IPC, filesystem and process changes |
| Data integrity and concurrency (`db-steward`) | Sonnet / high | Agent definition frontmatter | In-place adoption and the Node-to-.NET concurrency model carry the highest-consequence risk |

The owner (Claude Opus 5.5, max effort) chaired two review rounds and kept the test strategy and synthesis. The owner also verified the disputed facts, for example the CDP `grantUniveralAccess` spelling and that `setCredential` clears profile verification. The review produced a plan, not an implementation; its acceptance criteria are not evidence that any migration phase exists.

## P1 contract and platform foundation — local implementation delivered

Recorded 12 October 2026. Rudy authorized proceeding locally on the accepted P0 records before their integration: “Yes—continue P1 locally; keep integration held.” He subsequently authorized private publication and Windows CI. Main integration and real-data adoption remain held; the later P2 authorization is recorded below. The development executable requires an explicit isolated data directory; existing data additionally requires the disposable-copy marker. A marker never grants real-root admission.

The baseline inventory is `tests/Foundry.Conformance/BaselineInventory.json`: starting revision `e5517ac410f7ab6d5099a380b4114a25e5247f69`, local prerequisite revision [3bf7462](https://github.com/koala-man-64/foundry-agent-workspace/commit/3bf7462e085368a4eb34cc1fdc5e9b3cef84513c), unchanged SDK/package pins, hashes of all ten golden files and fifteen era-fixture files, and the complete contract inventory. Inspection found **89 existing RPC methods**, not the historical plan's 86; five non-RPC frames, two RPC envelopes and three bridge inputs make 99 schemas. No protocol methods were added.

Baseline validation: locked .NET restore and Release warnings-as-errors build passed; existing solution tests passed 171 with one environment-policy skip. Baseline `pnpm check` passed type checking, lint and 483 TypeScript tests. Final P1 validation: locked restore; full Release build with warnings as errors, zero warnings/errors; all Microsoft.Testing.Platform solution tests: **4,439 passed, zero failed, one intentional ephemeral-CI registry-policy skip, 4,440 total**. This includes **4,268 conformance tests with no skips**, frozen corpus normalization, supporting parity vectors, every era opening/recovery and schema structure, loop affinity/shutdown, transaction/outbox faults, protected WAL-aware backups/upgrades, filesystem admission and process framing/EOF/limits/resource release. `pnpm check` passed type checking, lint and **490 tests across 55 files**, including immutable golden/oracle cases. `git diff --check` passed. The committed revision is retained in `test-results/p1-final-revision.txt`; final logs are `test-results/p1-final-{restore,build,tests,pnpm-check}.txt`. Required checks run again after the final evidence amendment, so these logs identify the exact final revision rather than an earlier working tree.

Independent read-only security and data/concurrency reviews accepted the current P1 source. Both used GPT-6 Luna/max, selected by the supplied AGENTS.md Critical lane approved tuple from the provider-confirmed GPT-6.1 Sol/medium owner. Security independently rebuilt and passed 4,240 focused conformance tests; data review independently rebuilt and passed all 10 backup/upgrade regressions. Reviewed byte fingerprints and scope are retained in `tests/Foundry.Conformance/ReviewedSources.json`; Git text normalization can change line endings. The owner fixed and regression-tested filesystem link/rename admission, strict ISO/time-zone parity, rejected asynchronous transaction callbacks, loop shutdown/late continuations, failed rollback publication, exact typed backup verification and broken stdout. No shipping TypeScript defect with a present-path trigger was established. A proposed TEXT/blob backup finding was withdrawn after verification against pinned Microsoft.Data.Sqlite 10.0.12 and its regression test. Review agents could not register provider sessions with agentcoord (`session_token_unavailable`) and made no edits or resource claims.

The **P1 implementation is privately delivered and Windows-qualified** in six reviewable increments plus the disposable-fixture CI correction. [Final source 3d0fab7](https://github.com/koala-man-64/foundry-agent-workspace/commit/3d0fab7442f7f1bbb78470423e1d53893125ca6b) passed [Windows CI 38343524316](https://github.com/koala-man-64/foundry-agent-workspace/actions/runs/38343524316): locked restore, zero-warning Release build, **4,440 tests passed, zero failed or skipped**, including the registry-policy gate. Main integration is a separate held authorization and is not implied by publication or CI success. FULL SQLite durability and publication only after the outermost commit are the two approved behavioral differences. The strict incoming parser keeps the named S8b differences, while persisted parsing preserves unknown properties and opaque provider state. Adoption operations, v6 fences, renderer changes and shipping packaging remain deferred.

| Local increment | Revision and validation |
| --- | --- |
| 1 — baseline and conformance harness | [ecfeb3f](https://github.com/koala-man-64/foundry-agent-workspace/commit/ecfeb3f065759c9d822a1ea442fcade5960b1479). Validated from a clean `git archive` snapshot: locked restore; Release build with warnings as errors, zero warnings/errors; Microsoft.Testing.Platform solution run: 171 passed, 2 environment skips, 173 total. The skips are the ephemeral-CI-only registry-policy test and the CDP test because the archive has no `node_modules`. The owner checkout's existing baseline run passed CDP and had only the policy skip. Logs: `test-results/p1-increment1-{restore,build,tests}.txt`. Inventory coverage and committed input hashes pass. |
| 2 — protocol and parity utilities | [020b929](https://github.com/koala-man-64/foundry-agent-workspace/commit/020b929a31747ebdf459d263e85e1dfe33473941). Clean archive snapshot locked restore, full Release build with warnings as errors (zero warnings/errors), 4,198 conformance tests passed with no skips. Logs: `test-results/p1-increment2-{restore,build,tests}.txt`. Covers all 99 frozen schemas, 89 typed result surfaces, strict string/byte parsing, framing, JavaScript serialization/hashes, redaction/MCP checks, manifests and committed schedule vectors. Node regressions verify offsets through ±23:59, year zero, expanded-year normalization and fraction truncation. |
| 3 — execution loop | [1392079](https://github.com/koala-man-64/foundry-agent-workspace/commit/13920792061441ede78a0fb995a5d21c2bb0b882). Clean archive snapshot locked restore, full Release warnings-as-errors build with zero warnings/errors; 4,209 conformance tests passed without skips. Logs: `test-results/p1-increment3-{restore,build,tests}.txt`. FIFO posting, atomic admission/closure, await interleaving, thread/context affinity, task/cancellation and raw-context failures, state-free offload, async-void rejection, late-continuation denial, drain and thread joining are covered. |
| 4 — Store opening, schema and recovery | [d1767de](https://github.com/koala-man-64/foundry-agent-workspace/commit/d1767dee4b4bbb8989769cf84287cc42d28f1c8a). Clean archive snapshot locked restore and full Release warnings-as-errors build passed with zero warnings/errors; 4,235 conformance tests passed with no skips. Logs: `test-results/p1-increment4-{restore,build,tests}.txt`. All six eras (including WAL) retain version and match committed normalized schema/row changes; backups compare every schema object and exact typed cell bytes/rowids. Schema SQL and execution order match the TypeScript manifest byte-for-byte. Fresh/v≤5 data, real-root/alias denial, v6/fence refusal, marker and database link denial, rollback and protected backup faults are covered. |
| 5 — transaction and event outbox acceptance | [bea2cd1](https://github.com/koala-man-64/foundry-agent-workspace/commit/bea2cd1d6dc5e85f08f93012ce3ffe5d3b1f0916). Clean archive snapshot locked restore and full Release warnings-as-errors build passed with zero warnings/errors; 4,242 conformance tests passed with no skips. Logs: `test-results/p1-increment5-{restore,build,tests}.txt`. Covers deferred/immediate nesting, savepoint rollback, command enlistment, task-returning callback rejection, complete rollback, durable sequence ordering, no early publication, sequence-zero progress and committed mutation authority after delivery failure. |
| 6 — development runtime and summary | Final private branch HEAD (link unavailable), recorded in `test-results/p1-final-revision.txt`. Exact-final full-solution and TypeScript evidence is listed above. Implements only `workspace.summary`, preserving bounded pages, cursors, preferences, event sequence and runtime shape. Known unsupported methods validate before a bounded rejection; no partial handler executes. Process tests cover fragmented/multiple/malformed/oversized frames, Unicode, fixture and populated summaries, request IDs, output limits, broken stdout, startup refusal, EOF draining and resource release. Committed Node summary vectors are ordinary immutable expectations. |

The synchronous transaction/outbox primitives are co-located with Store opening in increment 4 because recovery must run atomically and persist its transition events. Increment 5 separately earns the transaction/outbox fault and publication gate; it introduces no feature mutations. No upgrade or adoption operation is exposed by the executable.

Development invocation requires an explicit new disposable directory, for example:

```powershell
$env:FOUNDRY_WORKSPACE_DATA = 'C:\tmp\foundry-p1-scratch'
dotnet .\src\Foundry.Runtime\bin\Release\net10.0-windows\Foundry.Runtime.dll
```

Send newline-delimited JSON-RPC on stdin. Stdout contains only protocol frames. Existing fixture/scratch copies require `.foundry-p1-isolated` with the exact declaration `P1 disposable development data; not adopted application data.` followed by a newline; this declaration does not override real-root or alias refusal. Tests use injected roots, immutable fixture copies and controlled clocks/IDs. Do not point this executable at application data. The shipping Electron supervisor continues to run TypeScript.

The final-check first pass exposed an architecture regex matching the forbidden construct's name inside a private exception message. Changing only the diagnostic text to `async-void` passed both reviewers' exact-delta review. A pre-existing TypeScript trace-normalization test also failed because stdout and stderr delivery interleaved differently; its isolated rerun passed all eight tests, without weakening expectations or changing shipping code. Initial failed evidence is retained in `test-results/p1-final-tests-initial-failure.txt` and `test-results/p1-final-pnpm-initial-failure.txt`; isolated trace evidence is `test-results/p1-trace-retest.txt`.

Cleanup evidence comes from process, Store, backup and loop tests: child exit, released SQLite files, removable disposable data directories and joined loop threads. One independent review scratch directory remains ignored at `tests/Foundry.Conformance/bin/Debug/net10.0-windows/marker-review-m9385xnshadmv5dnlq2`. Execution policy rejected its recursive deletion; no alternate deletion route was attempted. This retention is separate from tested runtime resource release.

Remaining gates and risks: the existing WebView2 registry-policy test intentionally runs only on an ephemeral Windows CI runner; the first hosted run exercised it successfully, but the full corrected-revision Windows run must also pass. Main integration and real-data adoption remain held. Native Windows ICU behavior is pinned by committed Node vectors, and URL compatibility is bounded by the committed corpus; future P2 inputs may require additional differentials. P2 must start with security suites and Store/projects/tasks under a fake provider. All other runtime handlers, Electron switching, v6/adoption and cutover remain deferred and require their own authorization. No renderer or shipping packaging path changed, so Electron E2E and packaging gates remain at P2 under the approved P1 scope.

After P0, the approved phase ranges total **33–44 weeks** through P5; after P1 they total **29–39 weeks**, retaining the original solo-plus-AI uncertainty (±40%). Increment 1 found three already-existing methods beyond the historical inventory; it added no feature scope. Keep P1's approved 4–5 week range as a planning baseline, rather than deriving a delivery date from local test speed. Refine the P2 range after its first security/store/tasks slice. No schedule estimate authorizes integration, adoption or cutover.

### Hosted Windows qualification continuation — 12 October 2026

Rudy authorized publishing the private P1 branch and running Windows CI, while explicitly keeping main integration, adoption and P2 held. The [accepted foundation source](https://github.com/koala-man-64/foundry-agent-workspace/commit/d142e705e8d985f5af917853ec07187778222cd2) and its six increments are now published. [Hosted run 38342056907](https://github.com/koala-man-64/foundry-agent-workspace/actions/runs/38342056907) passed restore/build and all platform/WebView2 tests, including the registry-policy test, with no skips. The full run failed four summary-era comparisons: the synthetic fixture paths existed on the generator's machine but not on the hosted runner. Its complete log is retained at `test-results/p1-windows-ci-38342056907.log`; this failure is not reported as P1 success.

The qualification correction changes only the C# summary test and its TypeScript oracle. Each materializes project folders beneath its private disposable copy, updates only copied `data.path`, and normalizes only returned paths to the unchanged committed wire expectations. Original fixture bytes and `path_key` values are preserved; production code and shipping paths are unchanged. Both now exercise disappearance of an owned project folder and assert the raw `unavailable` result. Generated numeric directory names and canonical containment checks bound setup/deletion, and TypeScript assertions remain outside the dispatch-error catch. Independent security and data reviewers (GPT-6 Luna/max, supplied AGENTS.md Critical lane selection) accepted this exact bounded delta after those containment improvements.

During the security review, a Python SQLite read-only probe against original fixtures created/touched sidecars. The reviewer disclosed the operations and stopped. The owner preserved those bytes under `test-results/fixture-review-sideeffects`, restored the tracked SHM bytes from the accepted revision, and moved only the generated untracked sidecars into that evidence directory. Full inventory/hash validation is required again; no original database or WAL was rewritten. Reviewers must inspect source or disposable database copies, since read-only SQLite can still alter WAL/SHM sidecars.

The corrected exact-revision Windows run passed and the P1 owner closed its work, claims and session. Evidence is retained in `test-results/p1-windows-ci-final.json` and `test-results/p1-publication-ownership-closeout.json`. Main integration, real-data adoption, v6 and shipping changes remain held independently. P2 was subsequently authorized below. The sticky hook-classification fix is owned by the separate project-bound chat `1. Fix sticky delivery intent (AB4032)`; its source/CI/install/trust gates do not change the P1 result.

## P2 runtime port — in progress

Recorded 13 October 2026. Rudy instructed “proceed with p2.” This authorizes the approved ordered runtime port and its development-only Electron integration once the relevant slices pass; it does not authorize main integration, real-data adoption, schema v6 or cutover. Work starts from [P1 revision 3d0fab7](https://github.com/koala-man-64/foundry-agent-workspace/commit/3d0fab7442f7f1bbb78470423e1d53893125ca6b). The app attached a separate P2 worktree, but the central hook's active-checkout containment rule denied Git mutation there. Prepared changes were preserved and copied into the clean active checkout on the private `codex/p2-runtime-port` branch (link unavailable), at the identical base. No outside-checkout Git mutation or hook bypass occurred. The Electron/TypeScript application remains the shipping product and behavioral authority.

The first increment ports stateless scope normalization, segment-aware coverage/overlap, dependency-graph cycle/reachability checks and network/device path classification. JavaScript ASCII-only regular-expression case folding, ECMAScript lowercase, UTF-16 ordering/error truncation and exact error messages are preserved. The existing summary path classifier now uses the shared prefix policy without changing admission behavior. These helpers confer no filesystem or command authority. `tests/p2/security-vectors.json` holds **855** committed Node outcomes; ordinary Node and C# tests never regenerate expectations. Coverage includes the existing scope/network cases plus Unicode, invalid/secret/reserved paths, path-count limits, graph errors and path-prefix negatives.

Increment validation: locked restore and full Release build with warnings as errors passed with zero warnings/errors. Microsoft.Testing.Platform: **5,294 passed, zero failed, one local registry-policy skip, 5,295 total**, including **5,123 conformance tests without skips**. The ordinary Node oracle passed. `pnpm check` passed type checking, lint and **491 tests across 56 files**. Logs are retained in `test-results/p2-security-{build,all-tests,node-tests,pnpm-check}.txt`; the active checkout's repeated build/solution checks use `p2-security-active-{build,tests}.txt`. Independent read-only security review by the existing GPT-6 Luna/max leaf, selected through the supplied AGENTS.md Critical lane approved tuple, accepted the production policy delta and independently passed the initial 804 cases. The owner then expanded only corpus coverage to 855 and reran the conformance and ordinary Node tests.

The next local increment implements internal profile/project/preferences persistence and task-start reservation, lookup, completion and pending-only clearing. A **16-step committed Node trace** compares returned documents, exact persisted JSON, row identities and path keys. Unknown properties remain intact; project updates preserve their original path key and rowid; profile replacement matches the existing Node replacement behavior. The task-start tests retain failed/unknown records and prove restart changes pending to unknown without recreating a task. These are Store prerequisites, not executable RPC handlers. RPC filesystem admission, project event publication, task/message mutation and fake-provider execution remain to be ported.

Workspace increment validation: locked restore and full Release build with zero warnings/errors; **5,298 solution tests passed, zero failed, one local registry-policy skip, 5,299 total**; all four focused workspace tests passed; ordinary Node oracle passed; `pnpm check` passed type checking, lint and **492 tests across 57 files**; `git diff --check` passed. Logs: `test-results/p2-workspace-{build,tests,all-tests,node-tests,pnpm-check}.txt` and `test-results/p2-final-restore.txt`. Independent security and data reviewers, both existing GPT-6 Luna/max leaves selected through the supplied AGENTS.md Critical lane approved tuple, accepted the exact production delta and each passed all four focused C# tests. Security also passed the ordinary Node oracle. The owner fixed a test gap: an instance-local, loop-guarded path-key probe seam now makes the off-loop regression fail if a path probe runs before affinity rejection. The final reviewed production SHA-256 is `05C119CE4C341859566CD6F36954A8F39B70AA820C60978CA5B6576CDEB775BF`; the immutable workspace corpus SHA-256 is `E791E80979C8B5B88164BA33C31A91997654B797B2C9F131EB5D1600E45CA96E`.

Security review withdrew a proposed schema gate inside the low-level path-key helpers after checking the TypeScript migrations: those helpers intentionally run after v3 DDL but before the cached schema version changes. The C# methods have no production call sites yet. Future service handlers must preserve the existing order: schema admission, lexical network/device refusal, canonical/mapped-drive checks, then Store access. No shipping security defect or dual-implementation hotfix was established by this increment.

Rudy's native Hub reply `call_281d99e2f5894e51859d9675aca95be7` authorized publication and Windows CI **only** for the reviewed security/workspace increments at [c2e7b44](https://github.com/koala-man-64/foundry-agent-workspace/commit/c2e7b442b6df6ab1ca355124643a43523d3d49d4). The owner verified the human reply, pushed that exact hash, confirmed the remote head, and dispatched [Windows CI 38392798527](https://github.com/koala-man-64/foundry-agent-workspace/actions/runs/38392798527) against the identical source. The run **passed: 5,299 tests, zero failed or skipped; locked restore and zero-warning/error Release build**. This includes the ephemeral registry-policy gate. The sole owner watch exited successfully; no pending CI monitor remains. The remote head was reverified as the authorized hash after the newer local increments were committed. Those later task/message/fake-provider changes and this evidence amendment remain unpublished and excluded from this exact-source authorization. Full hosted log: `test-results/p2-windows-ci-38392798527.log`; receipt: `test-results/p2-publication-ci-receipt.json`.

### Local task/message persistence continuation

Local P2 implementation continues independently of the external publication gate. Internal task saves now preserve archive omission/null/empty semantics, update read projections and generation counters, retain unknown JSON, and emit the existing lifecycle/root events. Message saves preserve rowids and global ordinals while atomically maintaining redacted FTS rows, generation counters and completion events. `tests/p2/task-store-vectors.json` pins **22 steps across seven scenarios**: fresh data and disposable copies of all six actual fixture eras, including uncheckpointed WAL. Ordinary Node/C# tests read committed expectations and never regenerate them. Additional faults cover outer/nested rollback, a failed search-projection update, committed task/event authority after notification failure and loop-affinity rejection. No executable handler or adoption operation uses these internal methods yet.

Validation of the combined local continuation: zero-warning Release warnings-as-errors build; **5,338 solution tests passed, zero failed, one local registry-policy skip, 5,339 total**; `pnpm check` passed type checking, lint and **494 tests across 59 files**; `git diff --check` passed. The focused task suite passed **10/10**, and its ordinary Node oracle passed **1/1**. Independent data review accepted exact `Store.Tasks.cs` SHA-256 `60DEDC881499FA76B0F139D893EB22280C0EAC1A748977161EA8FD49BE4C6C8E`; independent security review accepted the same source and the offline fake-chat candidate. Both used existing GPT-6 Luna/max leaves selected by the supplied AGENTS.md Critical lane approved tuple; no new implementation owner was created. Logs: `test-results/p2-task-store-{build,tests,node-tests}.txt`, `p2-task-fake-all-tests.txt` and `p2-task-fake-pnpm-check.txt`. Reviewers used disposable copies and opened no original fixture SQLite database.

### Local offline fake-chat continuation

`Foundry.Providers.FakeChatProvider` implements only the offline no-tools text/continuation slice. It has no profile verification, tool execution, credentials, network, paid-provider or fallback path, and is not yet the complete provider adapter or an executable task handler. Provider-internal typed records stay in the Providers assembly; frozen protocol source is unchanged. **28 committed Node cases** pin last-user selection, empty text, opaque continuation preservation/validation, UTF-16 12-unit chunks (including split lone surrogates), exact errors and default abort outcomes. Node's final-text cancellation quirk is preserved: cancellation between the final yield and timer-listener setup can still be followed by `done`. This is existing provider behavior, not evidence that runtime task cancellation is correct. Runtime cancellation and reservation settlement must be ported and tested before binding executable handlers.

The fake-chat suite passed **30/30** C# tests, including controlled pending-pause cancellation, continuation affinity on the RuntimeLoop and early disposal without starting a pause. Its ordinary Node oracle passed **1/1**. The combined local checks above cover the exact candidate; independent security review passed the two focused C# suites **40/40** and both Node oracles **2/2**. Reviewed `FakeChatProvider.cs` SHA-256: `0589CB5AD9F1110808E4FA26A49BAAF8DBF0DEE72F3F3D218BF5C11069443F50`. Logs: `test-results/p2-fake-chat-{build,tests,node-tests}.txt`. No new dependency or global analyzer suppression was introduced. These newer task/message and fake-chat increments remain local and excluded from the exact-source publication approval above.

### Local context and measurement validation

The stateless `RequestAccounting` prerequisite reproduces byte-based context/reservation estimates and revalidates injected provider usage. It uses the compatibility serializer with the existing fixed context-field order and omission rules, includes native continuation/tool results, adds the existing 512-byte allowance and output reservation, and preserves strict `>` limits and context-before-task-budget error order. Unsafe, fractional, negative or nonnumeric input/output totals remain unknown; invalid optional subsets are omitted, and overlapping cache subsets are both omitted. It assumes validated profile/task contracts and introduces no executable admission or ledger mutation.

**469 committed Node cases** plus three nonfinite injection tests passed **472/472** focused C# tests and the ordinary Node oracle. Independent data review accepted the exact source after the owner added six dual-failure vectors proving context error precedence. `RequestAccounting.cs` SHA-256: `623212B994B0FB77E774382CD4EC5BCCA4E7648EF21A7973C6494C0B57A459BE`; corpus SHA-256: `DB30D954F132D6432600703E6FF1102066B3BDBF7D477701CC89776F771E5467`. Final combined local solution: **5,810 passed, zero failed, one local policy skip, 5,811 total**; `pnpm check`: **495 passed across 60 files**, with type checking/lint passed; zero-warning Release build and `git diff --check` passed. Logs: `test-results/p2-accounting-{build,tests,node-tests,all-tests,pnpm-check}.txt`. This continuation remains local and outside the c2e7b44 publication authorization.

### Local persisted usage lifecycle

Internal Store primitives now reproduce request admission, first-attempt marking, one-time terminal settlement and identity lookup. New request tracking remains disabled before schema v4, including reservation validation, while identity lookup checks retained legacy usage records in those eras; supported eras reject unsafe, negative, fractional or nonfinite reservations. Attribution snapshots the existing root title with the TypeScript fallback rules, and settlement preserves known usage on cancelled/failed requests. The existing restart recovery marks unfinished requests interrupted without replay. These primitives do not themselves reserve or settle task budgets, normalize measurements, dispatch inference or expose a handler; their eventual caller must perform those operations atomically with the ledger.

`tests/p2/usage-store-vectors.json` pins **26 operations across seven disposable-copy eras**, including uncheckpointed WAL and a pre-existing legacy usage record. The C# focused suite passed **11/11**: era traces plus outer/savepoint rollback, duplicate admission rollback, authoritative commit despite publication failure, nonfinite rejection and loop-affinity checks even on a disabled ledger. The ordinary Node oracle passed; expected results are regenerated only under the explicit development flag. Final corrected source passed zero-warning/error Release build, **5,821 solution tests with zero failures and one expected local policy skip (5,822 total)**, and `pnpm check` with **496 tests across 61 files**, type checking and lint. `git diff --check` passed. Logs: `test-results/p2-usage-{build,tests,node-tests,all-tests,pnpm-check}.txt`. The oracle's invalid draft role was corrected to the actual `child` enum. Independent data review found a legacy lookup mismatch; the owner fixed it against the actual Store wrapper, added the retained-record regression and reran affected checks. The existing read-only GPT-6 Luna/max reviewer (AGENTS.md Critical route, selected for independent persistence/concurrency evidence) accepted the exact corrected source and reran focused tests **11/11** plus the ordinary Node oracle **1/1**. Source SHA-256: `521FFDBD778C46BC9B40FAEAC87359D5085F095A704BEEB29A26E452B4C0BA57`; corpus SHA-256: `4101B9ED2962C067E5AD3DA2C7D47CAF84ABF51E66A3943AC32DFAF979E4A6BF`. No original fixture database was opened. This increment remains local and outside the earlier exact-source publication approval.

### Local bounded message-history projections

Internal `MessagePage` and `MessageContent` reproduce the existing query projections without exposing an RPC handler. They take already-validated parameters, use task-scoped SQL, redact content before clipping, preserve unknown metadata and source rows, and retain the existing high-water/before cursors and ordering. Pages use the **256 KiB minus 1 KiB** item allowance and **4 KiB** excerpts; content chunks retain the **64 KiB** request maximum, UTF-8 alignment and fallback behavior, and halve escaped chunks until the **256 KiB** response cap is met. These reads never grant provider, repository or tool authority.

**106 committed Node query outcomes** cover seven disposable fixture eras: empty/missing tasks, cross-task content denial, cursor stability, secret redaction, exact item-cap acceptance and one-byte-over refusal, partial-page continuation, multibyte boundaries, offsets inside code points, lone surrogates and JSON-escape expansion. The focused C# suite passed **7/7** and verifies unchanged retained rows plus loop affinity; the ordinary Node oracle passed **1/1**. Final Release build had zero warnings/errors; solution tests passed **5,828 with zero failures and one expected local policy skip (5,829 total)**; `pnpm check` passed type checking, lint and **497 tests across 62 files**. `git diff --check` passed. The existing GPT-6 Luna/max read-only data reviewer (AGENTS.md Critical route, chosen for independent data/read-projection evidence) accepted exact source SHA-256 `9FA9D87FF0A8DFCB4D2426CEBB765FA8EB987F9C253B2923301E825C2A6B19AB` and corpus `E7B685A6DB8F6321914ED73198D4DBF9CFA3254AE61640680018877AF2C84046`, independently running the focused suites. No original fixture database was opened. Logs: `test-results/p2-messages-{build,tests,node-tests,all-tests,pnpm-check}.txt`. This increment remains local and outside the earlier publication approval.

### Local atomic single-task request accounting

Internal admission now reserves an ordinary task's conservative budget and inserts its request in one transaction. Terminal accounting revalidates measured usage and commits the request/legacy usage record with its task-budget adjustment; invalid or absent measurements retain the reservation conservatively. Repeated settlement of the same request does not charge twice. Context and budget errors leave no partial mutation, and failed admission/settlement or outer transactions roll back the task, ledger and events together. Task/profile admission, metadata redaction/length checks, lifecycle status and notifications remain caller responsibilities; this is not the coordinated shared ledger or an executable provider handler.

The oracle pins **15 operations across seven disposable-copy eras**, using the actual TypeScript admission helper, legacy hooks and Store operations with the terminal transaction assembled from `AgentLoop.run`. It includes failure/cancellation usage, unsafe measurement fallback, budget/context refusal and restart. The post-recovery settlement probe exercises helper behavior only; it grants no replay authority, and pre-v4 recovery retains the existing generic unknown-usage semantics. Exact vectors exposed a C# parity defect in the order of generated legacy recovery IDs. C# now generates the usage-record ID before the request ID, matching TypeScript; the shipping implementation and expected results were not weakened or changed.

The focused C# suite passed **9/9** and the ordinary Node oracle **1/1**. Faults cover trigger-aborted admission and settlement, duplicate IDs, outer rollback, committed settlement despite delivery failure and loop-affinity rejection. Final Release build had zero warnings/errors; solution tests passed **5,837 with zero failures and one expected local policy skip (5,838 total)**; `pnpm check` passed type checking, lint and **498 tests across 63 files**; `git diff --check` passed. The existing GPT-6 Luna/max independent read-only data reviewer (AGENTS.md Critical route, selected for persistence/concurrency evidence) accepted source SHA-256 `48A3BD2A502558258E1B2B918094E5EB1CEC422AED4A546C2C8F988135F783DC`, recovery source `A3988C512267D2BA3A6A869ED5E0ECD9E6EF5C50C2C76D7F91015AF4150F6C1C`, and corpus `DE8D15987BBC9AFB372424CB1C6D192FB0EB1333189E5267A360D64970F4300D`, rerunning the focused suites. No original fixture database was opened. Logs: `test-results/p2-task-accounting-{build,tests,node-tests,all-tests,pnpm-check}.txt`. This increment remains local and outside the earlier publication approval.

### Local provider-facing retained history

Internal preparation reads preserve complete stored message documents and override any embedded ordinal with the durable SQL ordinal, map retained compaction ranges, and return opaque provider state without strict incoming-message parsing or rewriting. The pure history transform sends only complete messages, replaces ranges with their retained summaries, preserves stable range order and overlap precedence, handles duplicate IDs exactly, and merges a summary into a preceding user message with the existing separator. These are internal provider preparation reads; public history remains paged through the bounded projections above. They do not validate or execute native continuation, grant tool authority, check profile fingerprints, or dispatch inference.

**144 committed Node transform cases** plus **seven disposable-era read projections** passed **151/151** focused C# tests and **2/2** ordinary Node oracles. Coverage includes incomplete/missing status, input ordering, same-start overlapping ranges, case-sensitive and duplicate identities, empty summaries, unknown properties, SQL-ordinal precedence, opaque native data and lone surrogates. Read tests confirm unchanged source rows and independent returned copies; Store methods reject off-loop access. Final Release build had zero warnings/errors; solution tests passed **5,988 with zero failures and one expected local policy skip (5,989 total)**; `pnpm check` passed type checking, lint and **500 tests across 64 files**; `git diff --check` passed. The existing GPT-6 Luna/max read-only data reviewer (AGENTS.md Critical route, selected for independent persisted-data/history evidence) accepted the exact candidate and independently reran focused tests. Source SHA-256: `Store.History.cs` `F1BDC8B9A3C81F6992EB283522D64B61BDEA1952BC7C7B7078DBE327308E7ED3`; `ProviderHistory.cs` `30F8D5A5F990A82957134A7BE90057BAF9CEFEDD16F6473013370325856CDC14`. Corpus hashes: `2EF7E8D3DFAF89497A46C4756EDDCBD209A778809927FE8ED233E29B1866A544` and `757B651F596C9C187A1AB3B623FA094D41E3AFAD72C27EA224FE212EDF84232B`. No original fixture SQLite was opened. Logs: `test-results/p2-history-{build,tests,node-tests,all-tests,pnpm-check}.txt`. This increment remains local and outside the earlier publication approval.

### Local ordinary-chat request preparation

Internal chat preparation reproduces the native-state fingerprint gate before the blocking-unknown gate, reads approval status from SQL rather than retained JSON, preserves existing browser-acknowledgment truthiness, and replaces unfinished calls with a retained result or an explicit interruption error without replay. Otherwise it builds complete-message history with retained compaction summaries and appends the new user content. Opaque continuation and stored rows remain unchanged. This supports ordinary chat without browser/channel/MCP/tool advertisement; caller profile/capability admission and runtime execution/cancellation remain separate.

Independent data review found that the first candidate rejected an omitted optional task mode. The owner fixed the legacy-chat path and doubled the corpus to **96 cases across seven disposable eras (672 outcomes)**, retaining explicit unsupported-mode and parent-task rejection. The corrected candidate passed focused C# **7/7**, ordinary Node **1/1**, zero-warning/error Release build, **5,995 solution tests with zero failures and one expected local policy skip (5,996 total)**, and `pnpm check` with type checking, lint and **501 tests across 65 files**. `git diff --check` passed. Existing GPT-6 Luna/max read-only security and data reviewers, selected by the AGENTS.md Critical route for independent admission/persistence evidence, accepted corrected source SHA-256 `C86123800D22C12F5FA92EF9D46BFB4625B697DE43A7B4E4A2B5259AFD43F0C3` and corpus `555F01D7CB3B5A212BDD5C221B9552580FEA3415B4252B8997384E80A7361247`, independently rerunning focused checks. No original fixture SQLite or live provider was accessed. Logs: `test-results/p2-preparation-{build,tests,node-tests,all-tests,pnpm-check}.txt`. This remains local, with no new executable handler and no additional publication authority.

### Local development fake-chat execution

The explicit development opt-in `FOUNDRY_RUNTIME_P2_CHAT=1` now enables `task.start`, `task.send`, `task.cancel`, `task.read`, `task.messages` and `task.messageContent`, alongside `workspace.summary`, in `Foundry.Runtime.exe`. Explicit isolated data configuration remains mandatory. Without the opt-in, the executable retains its P1 summary-only behavior. This slice admits only ordinary projectless chat with the offline fake profile; known unsupported operations return bounded errors before executing a partial handler. Repository-backed/child tasks, external profiles, unresolved mutation intents, incompatible fingerprints and later native stages cannot admit a provider request. No Electron selector, real-data access, tools or live provider are enabled.

The service preserves exact request-ID/hash coalescing and retained start-intent rules, atomic message/budget/request admission, three provider slots, loop-affine cancellation, conservative unknown usage and selected canonical notifications. Only the two approved JavaScript deferral sites queue work. EOF closes admission and cancels/drains owned turns under the existing process shutdown bound; output remains single-writer protocol traffic. A final provider completion after cancellation cannot become success. A postcommit notification failure closes admission at the earliest loop catch, signals fatal process shutdown and retains the authoritative mutation for conservative recovery. Independent data review found and the owner fixed an orphaned-start path, a queued-start ordering gap and an incorrect failed marker on a committed retry. These were C# port defects; no shipping TypeScript defect or dual-implementation hotfix was established.

Validation: **30/30 focused C# execution/process tests**, including six copied fixture eras (v1/v2 refuse creation; v3–v5 execute without an upgrade), coalescing/conflicts, controlled slot cancellation, malformed/oversized provider streams, three committed-delivery faults, early admission denials, fragmented Unicode, batched replies and immediate EOF. A committed **ten-step Node service trace** agrees on exact stored rows, notifications and returned values. An additional **actual Node/C# stdin/stdout process differential** passes, normalizing only generated identities and wall-clock timestamps; nondeterministic progress is asserted separately. Run this explicit gate after both builds with `pnpm exec vitest run --config tests/p2/process.config.ts`; ordinary Node checks do not acquire a .NET dependency or silently skip this gate. Ordinary tests never regenerate expected corpus files.

Locked restore and Release warnings-as-errors build pass with zero warnings/errors. Final solution tests pass **6,025, zero failures, one expected local registry-policy skip (6,026 total)**. `pnpm check` passes type checking, lint and **502 tests across 66 files**; `git diff --check` passes. The unchanged Electron/TypeScript user paths pass **21/21 E2E tests**, local package creation and package/expansion smoke. Those are shipping-baseline evidence; they do not establish Electron+.NET or complete P2 smoke parity. Current logs and focused results are in `test-results/p2-execution-{build,dotnet,node,focused,process-parity,package-smoke,e2e-retention}.*`. Both existing read-only independent reviewers accepted the final service hash: **GPT-6 Luna/max**, selected through the supplied AGENTS.md Critical approved route for security and persistence/concurrency evidence. Security independently exercised the focused process/loop tests and real process differential before the final bounded catch change; both reviewers inspected that final change and regression, with final testing retained by the owner. No new reviewer was spawned. Intentional FULL durability and publication after outermost commit remain unchanged. The execution corpus SHA-256 is `B755B863DEDAFCB9A2D1C5078DE07D9733EC34C665BF8F2424A8C6D2675F4769`; reviewed service source SHA-256 is `AE10DD6B326733B663E3C5B5C56BF36DB99936B509EEEB622C9A5F2D09C8C3FE`.

**Artifact retention correction:** the first baseline E2E run used Playwright's default output directory and cleared older ignored `test-results` receipts, including local raw logs/fixture-review side effects. Committed spike results, corpus/fixture bytes and source records remain intact. `playwright.config.ts` now confines automatic cleanup to `test-results/e2e`; a focused workspace rerun passes and preserves the current receipts. Published P1 and P2 Windows logs/receipts were fetched again from their original successful provider runs without dispatching CI. The unavailable older local bytes are not represented as restored evidence.

### Local workspace/task/event read pages

Six further complete query handlers are bound in the same explicit development opt-in: `workspace.profiles`, `workspace.projects`, `profile.read`, `workspace.tasks`, `workspace.events` and `task.timeline`. Profile/project pages retain the 128 KiB budget; single-profile reads retain 256 KiB; task/event pages retain 256 KiB minus the 1 KiB metadata allowance. The parameterized helper preserves `workspace.summary`'s independent 25-item/96 KiB budgets. Task pages preserve legacy/current archive and child filtering, fixed-order filter hashes, cursor/high-water behavior, recent-first-page refusal, and the historical legacy locale ordering. Events preserve legacy/runtime tags, omission, root/child timeline scope, malformed-data screening and redacted 4 KiB payload limits. Stored documents and source rows are not rewritten by reads.

The committed Node vectors compare all six methods across **seven disposable eras** and include exact page limits and one-byte-over refusals, partial pages, mixed-case identities, cursor conflicts, unknown fields and malformed/secret/oversized events. Both harnesses materialize numeric project directories solely inside their checked disposable roots, rewrite only copied project `data.path`, and normalize only returned paths to the unchanged golden contract. Removing a checked private project directory produces the raw unavailable result. Independent data review found this portability issue before acceptance; expected corpus results were not weakened. Both Node and C# verify unchanged task/event/profile snapshots after every query. The actual executable differential now exercises all six queries as well as the fake-chat path.

Final validation: zero-warning/error Release build; **6,032 solution tests passed, zero failed, one expected local registry-policy skip (6,033 total)**; **7/7** copied-era C# comparisons; ordinary Node oracle and the expanded actual-process differential passed; `pnpm check` passed type checking, lint and **503 tests across 67 files**; `git diff --check` passed. Evidence is retained in `test-results/p2-pages-{build,dotnet,node,node-oracle,focused,process-parity}.*`. The preceding 21-test Electron/TypeScript and package/expansion-smoke baseline applies to unchanged shipping source; no Electron+.NET proof is inferred.

Independent data review accepted the exact production source; the existing security reviewer found no new execution/data authority and accepted the local parity scope with two inherited residuals. Both reviewers are the existing **GPT-6 Luna/max** read-only leaves selected through the supplied AGENTS.md Critical approved route; no new spawn occurred. Owner validation retains the final tests. Source SHA-256: `Store.WorkspacePages.cs` `879B79E2864288FE306C24907596F1F45F6F100E08E1A202D539E8568AB6DB43`; `Store.Summary.cs` `267D017C7A4BBE0AFA41C38AE22E125CEEE6F7ABA6C7311584CCAA3A6721E0D9`; `DevelopmentChat.cs` `35D5341C1BD2023503350745D42F3982CC4AC264D865FBF0F1CFFF3EC33168CF`. Corpus SHA-256: `EA3D8821302E4AAB8FE9AA42364C498289EA6F176EB5E4C306C26D8C36814886`.

**Shared residuals for further P2 security qualification:** pre-v5 task pages currently parse/sort all retained tasks, so response size is bounded but work and memory remain O(n), as in TypeScript. A compatible dual-runtime bounded-memory correction and larger disposable-store coverage remain follow-ups. Project listing rejects literal UNC/device paths before probing but inherited local reparse/mapped-path probes can still reach a redirected location before final-path rejection. This is not a universal no-network guarantee. The approved plan explicitly accepts user-chosen mapped-drive resolution; reparse-to-UNC probing remains a distinct shared security residual for the filesystem slice. No real data was opened and no network path was probed by this increment. Full P2 security acceptance is not established by these parity tests.

### Dual-runtime legacy task-page memory correction

The legacy-memory follow-up above is now corrected in both implementations. Pre-v5 task pages stream every stored row and keep only the best `limit + 1` candidate documents, plus the current row/transient insertion, rather than retaining the complete history. Stable locale ordering, cursor filters, cursor-independent high-water selection, omission, page-byte limits and malformed-data errors remain unchanged. The scan still takes O(n) time; candidate memory is O(limit) documents, not a universal byte bound, because an individual persisted row is still parsed before the page budget check. The C# reader stays on its owning loop and disposes its command/reader on success or failure. The v5 indexed query path is unchanged.

**Migration correction record:** this resource-availability improvement is dual-landed in the local TypeScript and C# candidates, without adding an API, schema, dependency or intentional wire difference. The existing workspace-page corpus remains byte-for-byte unchanged. A new independent reference uses the previous whole-history algorithm over **20,000 rows in each of v1–v4** and pins full-output hashes/IDs for **ten pages per era**; a malformed final row still fails instead of being skipped. Cleanup checks prove subsequent commands work and disposable directories remain removable. The Node regression also refuses an accidental call to `allTasks` from the production query.

Validation: **11/11 focused C# tests** (four large-history eras plus seven existing page comparisons), Node focused **2/2**, zero-warning/error Release build, **6,036 solution tests passed, zero failed, one expected local registry-policy skip (6,037 total)**, and `pnpm check` with type checking, lint and **504 tests across 68 files**. Actual Node/C# process parity, **21/21 Electron E2E**, local package creation and package/expansion smoke pass on the corrected TypeScript candidate. These user-path/package results cover Electron+TypeScript; Electron+.NET remains unqualified. `git diff --check` passes. Logs and focused results: `test-results/p2-legacy-memory-{build,focused,node-focused,page-tests,dotnet,node,process-parity,e2e,package,package-smoke}.*`.

Both existing **GPT-6 Luna/max** read-only security and data reviewers, selected by the supplied AGENTS.md Critical approved route, accepted the exact production delta; data independently passed the large-history Node and C# tests. Source SHA-256: TypeScript `workspace-queries.ts` `EE395B282325C99775EBC081BB9AFDCC9A0160A275B05981BD982787A9D76DE9`; C# `Store.WorkspacePages.cs` `42A4A1AA4437C9AEAB3B2D16BED9E147F44EC7DDDC5D5FAE44DBECADD254F34C`. New corpus SHA-256: `0DCB085FCE395ABC3295EFB55794D1EABDC6BD126859C9A0188E0F918105DC74`. No original SQLite fixture was opened. The separate reparse-path security residual remains open for the filesystem slice; FULL durability and publication after commit remain the only approved intentional compatibility differences.

These increments do not establish the complete P2 security gate. Remaining Store/projects/tasks query/service surfaces precede Git/files, commands/approvals, Azure providers, MCP, orchestration, automation/continuity/usage/channel and browser tools in plan order. P2 exits only after both-runtime security suites, deterministic differential traces and the specified Electron+.NET E2E/smoke gates pass. Retain the approved **16–22 week** P2 planning range; refine it after the first complete Store/projects/tasks slice. Main integration, adoption, live-provider calls and production remain held. Newer local increments remain unpublished; the earlier exact-source publication approval does not extend to them. External publication boundaries do not prevent independently authorized local implementation.

### Local retained usage and compaction reads

The opt-in isolated development runtime now serves `task.usageRecords`, `task.compactions` and `task.compactionContent`, in addition to the thirteen existing methods. These are read projections only: they neither execute compaction nor grant approval, provider or repository authority. Usage pages preserve the legacy ledger shape, current finished-request outcomes, coordinated-root child aggregation, rowid cursors and redacted reason clipping. Compaction pages retain their ordinal/count/token fields, bounded summaries and byte cursors; opaque provider state remains stored and absent from public output.

The committed Node corpus contains **109 requests in each of seven eras (763 outcomes)**, covering absent/foreign tasks, pagination, unfinished requests, legacy/current usage, redaction, supplementary Unicode, offsets within UTF-8 sequences, embedded NULs, oversized escaped content and EOF. Every query checks that task, usage and compaction rows remain unchanged. C# fixture copies seed raw summary bytes with `CAST(... AS TEXT)` because the .NET string parameter binder truncates embedded NUL text; production reads decode SQLite's counted UTF-8 bytes rather than the NUL-terminated string conversion. This corrects a C# port mismatch; it does not require a TypeScript hotfix. Direct raw-string writes containing NUL must use explicit counted-byte/TEXT binding when later compaction writes are ported. The corpus and opaque state are not rewritten to accommodate the port.

An additional C# process lifecycle correction observes unexpected handler faults while stdin remains open. The owning loop closes admission and cancels active fake responses before signalling failure; queued mutations cannot start afterward. Both P1-default and P2-opt-in regressions cover malformed persisted JSON and non-object documents and verify prompt nonzero exit, fixed redacted stderr, no misleading response and no queued task/ledger mutation. This closes an unobserved-task gap in the C# entry point, rather than changing the shipping TypeScript error handling. The existing shared message chunk algorithm remains byte-for-byte compatible, including replacement-character behavior when callers request an offset inside a UTF-8 sequence.

Validation: locked restore, zero-warning/error Release build, **49/49 focused tests**, **6,048 solution tests passed, zero failed, one expected local policy skip (6,049 total)**, and `pnpm check` with type checking, lint and **505 tests across 69 files**. The actual Node/C# stdin/stdout differential includes usage pages, empty compaction pages and ownership errors. A seeded process test verifies content retrieval, UTF-8 fallback, ownership denial and omission of opaque state. All disposable directories remain removable. `git diff --check` passes. Logs/results: `test-results/p2-retained-read-{restore,build,focused,node-focused,dotnet,node,process-parity}.*`. Both existing GPT-6 Luna/max read-only reviewers accepted the exact final production hashes under the supplied AGENTS.md Critical approved route. Security reviewed bounds, ownership, opaque-state omission and fault shutdown; data independently passed 16 focused C# tests and the Node corpus. The owner retains integration and final process validation. Reviewed SHA-256: Store reads `E5AFD7C72947F12DE11E5CCE63A38564A808524D1C057A7148FE228FD8C99062`, counted-text Store `6CDB4032A620CE821B838DA0C312468CCEC15663C84D6C04CD9FD44F61F5D9EB`, development dispatch `FD0F37A0FE88C48404B5F6247400C43C1CDF34B6B550453683382A3C5F4700F9`, process entry `7D89A9FDB9C2A43D48B681987702E5587FC1D0C595DE2F36C566DE550C5F3531`. Fetching/redacting a retained field still uses memory proportional to that field, matching Node; bounded output is not a universal input-memory bound.

No TypeScript production, Electron renderer/supervisor or shipping packaging code changed in this increment. The previous exact TypeScript candidate's **21/21 E2E and package/expansion smoke** remain separate evidence; Electron+.NET qualification remains open. Corpus SHA-256: `F175B6EF9D42C71C8D05AC7808903BA581BDAB6800448B7DD5E8E9356722DAA6`. P2 remains incomplete; main integration, adoption, v6, paid providers, new publication and cutover remain held.

### Local archive/restore and feature admission

The opt-in development runtime now additionally serves existing `features.get`, `features.set` and `task.setArchived` contracts. The Store uses the existing v5 feature tables and keeps bounded, newest-first history; it does not migrate older eras. Pre-v5 snapshots report migration-required, feature writes are refused, archive admission is paused and restore remains available. Pausing archive blocks archive before task lookup; enabling it does not enable an automation engine. Hooks and scheduling admission are persisted settings only in this development slice; their execution engines remain deferred.

Archive/restore changes root-group visibility inside one synchronous transaction. Coordinated children follow their root; direct child changes are rejected. Repeated archives retain the timestamp, restore uses absent-field omission, and the existing empty/null rules remain unchanged. Task status, provider requests, approvals, unknown outcomes and opaque retained properties remain intact. Feature-state/history changes also share one transaction. Existing service notifications follow the state commit and remain separately durable; the approved publication-after-commit difference is preserved.

The committed TypeScript oracle pins **74 steps across seven eras (518 outcomes)**, including paused/restored behavior, child rejection, missing tasks, repeated calls, empty archive values, runtime-fault reasons, forbidden migration-required setters, default/legacy states and the 50-entry feature-history cap. A failure-injection test proves child cascade and feature-history errors roll back completely. A controlled fake-provider test archives and restores a running response while preserving its reservation and pending approval, then releases it to finish normally. Actual Node/C# process comparison covers archive, pause, denial, restore, feature snapshots, durable rows and notifications.

Validation: zero-warning/error Release build, **9/9 focused visibility tests**, **6,057 solution tests passed, zero failed, one expected local policy skip (6,058 total)**, clean `pnpm check` with **506 tests across 70 files**, actual process differential and `git diff --check`. Logs/results: `test-results/p2-visibility-{build,focused,node-focused,dotnet,node,process-parity}.*`. Both existing GPT-6 Luna/max read-only security and data/concurrency reviewers accepted these exact source hashes, selected by the supplied AGENTS.md Critical route for authority, persistence and concurrency risk. No new child was spawned; implementation and final validation stayed with the owner. This is passing local implementation evidence, not full P2 qualification. Original database fixtures remain unopened; scratch copies are removed. Source SHA-256: `Store.Visibility.cs` `084970327EA4843C8B28437E0D28080B067CA94DC4F5FBA6E36AE797CEE70BA2`, development dispatch `012008DB5601CF1C8934FB4BEDAB1EA380659060F4A302AAE31C9014F29EFE43`. Corpus SHA-256: `EF22A226E49A73E03FF702E26D45F8145927E9034B05269F06E9CB663EA0C562`.

P2 remains incomplete and is not ready to archive. Next are remaining bounded workspace queries and Store/projects/tasks service admission before the plan's Git/files and command/approval slices. The isolated development executable currently supports nineteen existing methods; Electron still ships TypeScript. Main integration, adoption, v6, external providers, new publication/CI and cutover remain held. No renderer, shipping selector or packaging code changed; prior exact TypeScript E2E/package results remain independent of the new C# process evidence.

### Local global Inbox projection

The opt-in isolated development runtime now additionally serves `workspace.actions`. Its fixed, parameterized SQL returns at most `limit + 1` candidates and computes global tier counts independently of the page cursor. The projection preserves TypeScript's decision/in-progress/recent tiers, stable timestamp/ID ordering, inclusive 30-day outcome cutoff, latest failed validation selection, draft classification and optional source-ID omission. Supported v5 records map child obligations to their root and retain archived-root visibility. Legacy eras keep their existing smaller candidate set without migration. This read never executes an action, grants an approval, dismisses an obligation or rewrites retained records.

The committed Node oracle traverses every page at limits **1, 2, 5 and 50** in fresh data and disposable copies of all six fixture eras. It covers archived-root child approvals, unknown/orphan/malformed intents, active/waiting runs, drafts, validation supersession and outcomes on both sides of the cutoff. Every read snapshots task, intent, event and applicable run/validation/draft rows to prove they are unchanged. Three additional NUL-bearing timestamp cursors per era match Node without a binding change. Ordinary tests only consume committed expectations; original fixture databases remain unopened and scratch directories are removable. The actual Node/C# stdin/stdout differential now includes the Inbox reply alongside its existing task, visibility, notification and durable-row checks.

Validation: zero-warning/error Release build, **7/7 focused era tests**, **6,064 solution tests passed, zero failed, one expected local policy skip (6,065 total)**, clean `pnpm check` with **507 tests across 71 files**, actual process differential and `git diff --check`. Logs/results: `test-results/p2-actions-{build,focused,node-focused,dotnet,node,process-parity}.*`. Both existing **GPT-6 Luna/max** read-only security and data/concurrency reviewers accepted the exact source and final corpus, selected by the supplied AGENTS.md Critical route for obligation visibility and persistence risk. No new child was spawned; implementation and final validation remained with the owner. Reviews inspected source and tests without opening original fixtures; automated results are owner evidence.

Reviewed SHA-256: Store projection `40C0C09ED51B1ADD5FC71FB4506CBBBD0CEF6208F45BB3AE6AABD3AF57864FB6`, development dispatch `E5718F485582D47BB1EB38D5A7DFE14569A7C01F3233587BC4A8F7DF6D1912C1`, C# corpus consumer `6AE71AA7FFABDBDFAD979B8F1F1B4571E403EFD35FBF9FB02B4F0202EF819E72`, Node oracle `B788EE2529944108978910E493E315943F5A3C35B6209B4BB00559E246A475D3`, corpus `3BD5B1D45AA7D246131B16DEA3A2AD3A692259F001A8ABDFF883B5F1F214BF1B`. The unchanged TypeScript query reference remains `EE395B282325C99775EBC081BB9AFDCC9A0160A275B05981BD982787A9D76DE9`.

The development executable now supports **twenty existing methods**, but P2 remains incomplete and is not ready to archive. Row-count paging is not a universal byte/input-memory bound: large persisted fields still follow Node behavior, and the process enforces its existing oversized-result error. Remaining workspace search and Store/projects/tasks service admission precede the ordered Git/files and command/approval slices. No renderer, shipping selector, production TypeScript or packaging code changed; prior TypeScript user-path/package receipts remain separate from this C# process evidence. Main integration, adoption, v6, live providers, new publication/CI and shipping cutover remain held. FULL durability and publication after commit remain the only approved intentional compatibility differences.

### Local workspace search

The opt-in development runtime now serves `workspace.search`. Legacy title searches retain JavaScript casing through the existing Unicode compatibility tables and the pinned locale ordering. Supported v5 searches use the existing SQLite title predicates and FTS message query, preserving their era-specific behavior rather than replacing it with a common case-insensitive .NET comparison. SQL filters and cursors are bound values; the filter fingerprint retains the exact JavaScript key order/null defaults. Title and message phases share captured task-rowid/message-ordinal high-water marks, preserve cursor omission and limit changes, map child message hits through their root, and apply the existing archive/project/mode/status/date filters. Message excerpts are redacted and clipped to 500 UTF-8 bytes; opaque retained state is absent from search results.

The committed Node oracle traverses limits **1, 2 and 50** across fresh data and disposable copies of all six fixture eras. It covers archive/root filters, locale/SQLite Unicode differences, exact ECMAScript whitespace, the eight-token FTS cap, quote/punctuation/NUL searches, trimmed inputs, redaction and UTF-8 clipping, mismatched filter hashes and empty high-water ranges. An explicit append-after-cursor case adds a later task and message and verifies the retained cursor excludes them. Source task/message/FTS rows remain unchanged around each read. The frozen contract accepts a NUL-only query; when it reaches FTS, Node reports `unterminated string`. C# maps only the same NUL-query, SQLite-code-1, exact pinned FTS error to the bounded RPC error; other database exceptions remain unexpected failures. Actual Node/C# stdio testing proves phase continuation, that error and a successful subsequent request.

Validation: zero-warning/error Release build, **7/7 focused era comparisons**, **6,071 solution tests passed, zero failed, one expected local policy skip (6,072 total)**, clean `pnpm check` with **508 tests across 72 files**, actual process differential and `git diff --check`. Logs/results: `test-results/p2-search-{build,focused,node-focused,dotnet,node,process-parity}.*`. Both existing **GPT-6 Luna/max** read-only security and data/concurrency reviewers accepted the exact final source/tests/corpus under the supplied AGENTS.md Critical route. No new child was spawned; the owner retained implementation and final validation. Reviews inspected source/tests without opening original fixtures; automated results are owner evidence. Disposable directories remain removable.

Reviewed SHA-256: Store search `AFB4DB2B0E477E0D940ADFCB65D60D72424B624498BCF709BCB764A98E86DDC0`, development dispatch `4889487E31C60C2C76810C384EBBABC0F41932986DF4E9A24CBCD8E2F1D37F4B`, C# corpus consumer `8B2EC89236A55F74010A1BD4E2BED9BE3E12DBDDFEECBBB71422316236D42B16`, Node oracle `C23168693C71B3C7206926D8556390CB27090CD90A6C0A8C86C1FF9F9C363471`, corpus `CC1FDFB287597414A65269FD5DDBCCC28341F86309C555A93353E935D90014CE`. The unchanged TypeScript query reference remains `EE395B282325C99775EBC081BB9AFDCC9A0160A275B05981BD982787A9D76DE9`; the reused case helper remains `7A95FD733374A342966D6C54BA28E673325115B449D4FC3AD246FF6D39B4316A`.

The development executable now supports **twenty-one existing methods**; P2 remains incomplete and is not ready to archive. Legacy search still scans and sorts the full title history in memory, matching Node; the separate task-list memory correction does not cover search. Result/row-count limits are not universal input-memory limits, and the process retains the existing oversized-result envelope. Remaining usage-trend projections and Store/projects/tasks service admission precede the ordered Git/files and command/approval slices. No shipping TypeScript, renderer, supervisor selector or packaging code changed; previous exact TypeScript user-path/package evidence remains separate from this C# process qualification. Publication/CI, main integration, adoption, v6, live providers and cutover remain held. FULL durability and publication after commit remain the only approved intentional compatibility differences.

### Local usage-trend projection and fractional-date correction

The opt-in development runtime now serves `workspace.usageTrend`, bringing its executable surface to **twenty-two existing methods**. Current and legacy ledgers preserve day/profile/task grouping, coordinated-root attribution, known/unknown/pending/not-sent classifications, cache observations, reserves, filters and cursor omission. Reads leave source task and ledger rows unchanged. Both runtimes normalize validated UTC timestamps to ordinal instant keys by removing the terminal `Z` and trailing fractional zeroes only; they do not round through floating-point or calendar conversions. Exact SQL bounds follow an indexable whole-second window. Independent assertions cover equivalent spellings, arbitrary precision, reversed ranges, midnight, year 0000 and year 9999 before comparison with the committed Node corpus. Ordinary tests never regenerate expected results.

Validation on the corrected source: Release build **zero warnings/errors**; **7/7** focused era comparisons; **6,078 solution tests passed, zero failed, one expected local policy skip (6,079 total)**; clean `pnpm check` with **509 tests across 73 files**; actual Node/C# process differential **1/1**; Electron/TypeScript E2E **21/21**; package creation and package/expansion smoke **PASS**; `git diff --check` clean. Logs are retained under `test-results/p2-usage-trend-*`. Electron/TypeScript user-path and package evidence remains separate from C# process qualification; Electron+.NET is not qualified by these checks.

The existing independent **GPT-6 Luna/max** security and data/concurrency reviewers accepted the final bounded implementation. Selection source: the supplied AGENTS.md Critical approved route; reason: independent persistence, time-bound accuracy and process review. No new child was spawned; the owner retained implementation and final validation. Data review was static. Security review independently passed the Node oracle **1/1**, C# era tests **7/7** and rebuilt process differential **1/1**. Accepted SHA-256 identities: TypeScript `workspace-queries.ts` **BF85E944B15FC8E780CE1F51DADDA91813AFD1F36EB6629EA43AF71FDBAB4B47**; C# `Store.UsageTrend.cs` **EAE3FD33DB1960E7875AA12423AA2CF94B0254D4C4393378694C4A0C5604E7F2**; corpus **364958D9D1D283224755DF08BD18225D700B91135AA4FA72C85754A801DB4F42**.

P2 remains incomplete and is not ready to archive. Remaining Store/projects/tasks service admission precedes ordered Git/files and command/approval slices. Legacy full-history search and large retained-field reads still have proportional input-memory costs; response limits are not universal input-memory limits. The local-reparse network-probe residual remains open. No renderer, supervisor selector, schema or packaging code changed. Publication/CI, main integration, real-data adoption, v6, live providers and cutover remain held. FULL durability and publication after commit remain the two approved intentional compatibility differences; this explicitly authorized accuracy correction is shared by both runtimes.

### Local Store/projects/tasks service admission

The opt-in development runtime now serves `project.update`, `workspace.preferences.save` and `workspace.schema`, bringing its executable surface to **twenty-five existing methods**. Saved-project name/visibility updates preserve unknown persisted properties, rowid and the original path key without probing the saved path. Preference updates merge omitted fields, validate referenced profiles/projects, allow the existing `none` grouping, preserve unknown properties and deduplicate collapsed IDs in first-occurrence order. Both mutations require schema v3 or newer, preserve the existing backed-up-upgrade error on older eras, and commit their durable notification event with the state change. Schema reporting never upgrades data; `coordinatedAvailable` is explicitly **false** for this incomplete C# slice. The process comparison asserts this deferred capability against Node's available orchestration and compares the remaining schema fields; it does not report full-runtime capability parity.

Admission remains atomic: `project.add`, Git-backed `task.create`, `workspace.upgrade` and project-backed/coding/coordinated `task.start` execute no partial handler, path probe, task-start reservation or project/task/intent write. Existing projectless ordinary fake-provider execution remains supported. Repository inspection and worktree creation must land together with their complete handlers in the ordered Git/files slice; model configuration/probing and provider authority remain deferred. No real data, schema v6, renderer or supervisor selector changed.

The committed Node service corpus records **84 transitions across seven disposable eras**, including missing references, empty updates, trimming, visibility, omitted fields, deduplication, unknown-field preservation and unchanged project path keys/rowids. Fault injection covers both mutations' state/event rollback and committed-event retention after delivery failure. Controlled awaits prove queued orchestration cannot create a child, hold or intent after close, and completed real script-pin validation cannot launch a queued script after close. Already-admitted provisioning retains its conservative recovery path. Off-loop calls fail before Store access; disposable directories are removable after owning-loop shutdown. The TypeScript data-integrity and lifecycle corrections are listed in the dual-landed hotfix list above.

The existing **GPT-6 Luna/max** read-only security and data/concurrency reviewers accepted this bounded implementation. Selection source: the supplied AGENTS.md Critical approved route; routing reason: independent persistence, concurrency and lifecycle evidence. No new child was spawned; the owner retained implementation and final validation. Data review was static. Security independently ran the seven Node admission/fault tests and earlier C# era/process checks; its subsequent fixture/comment review was static. Accepted production SHA-256 identities: C# `Store.ServiceAdmission.cs` **335CF7939111F0A4A95CAE9BA9FD8E8F063F35ED0BC11F6BCD7BB3AF0AF23A6D**; TypeScript `service.ts` **F88D17EC219671E6C1ABEDEFF7D2647F647F8F8C7B2E682C97CDC1ED3F29B30B**, `orchestrator.ts` **F6FCE76B3B85FBDACAA025E13F03020FA390416556028C5F9B7A1FF5325E7E16**, `automation.ts` **40560BDC7DF32EBDEE396F7E7A0FA05F8EE0B5A5F0A0969F89E253EC1ABA59E3**. Corpus SHA-256: **6323A115A2A734DB219707ADC93CEABB07FF12940014355666B37D49BF1E7B43**.

Final validation: Release build **zero warnings/errors**; **11/11** C# admission/era/fault tests; **6,089 solution tests passed, zero failed, one expected local policy skip (6,090 total)**; clean `pnpm check` with **516 tests across 74 files**; **7/7** focused Node admission tests and **8/8** trace tests; rebuilt actual Node/C# process differential **1/1**; Electron/TypeScript E2E **21/21**; package creation and package/expansion smoke **PASS**. Evidence: `test-results/p2-admission-{focused,dotnet,node-final,process-final,e2e-lifecycle,package,package-smoke}.*`. Electron/TypeScript user-path/package proof remains separate from C# process proof; this is not Electron+.NET qualification.

Earlier failures are preserved rather than replaced by the final pass: the first E2E run passed 20/21 and failed to activate a focused grant button with Enter at 200% zoom; its focused retry passed. The second passed 20/21 but recorded an empty coordinated Git integration. Their exact causes remain unconfirmed; the final rebuilt sequential E2E run passed both unchanged tests. Logs and traces remain in `test-results/p2-admission-e2e*.txt`, `test-results/e2e` and `test-results/p2-admission-e2e-final`. A full Node run also exposed a trace-fixture race between independent stdout/stderr pipes. Its diagnostics now use a separate request and an observed-stderr handshake before the next frame; all frames, exact normalization, redaction, oversized-input and EOF assertions remain. That deterministic test correction was independently accepted; the final full Node suite passed. The expected local registry-policy skip does not establish the ephemeral Windows CI gate, and no new CI was dispatched.

P2 remains incomplete and is not ready to archive. Main integration, publication/CI, real-data adoption, v6, live providers and cutover remain held. The local-reparse network-probe residual and proportional input-memory costs remain open. FULL durability and publication after commit remain the two approved intentional compatibility differences; the shared hotfixes do not add a planned product API delta.

### Local Git metadata reference parsing prerequisite

The internal, unwired `GitMetadataReference` helper parses already-supplied `.git` pointer and `commondir` bytes. It caps input at 16,384 bytes before UTF-8 replacement decoding, uses the existing ECMAScript trim set, preserves the exact pointer capture, keeps empty/independent `commondir` semantics and rejects raw network/device prefixes before any normalization. Its results remain untrusted reference text: drive/root-relative paths, NUL and other filesystem-invalid text are not admitted paths. It performs no filesystem access, Git/process execution, canonicalization, persistence or authority grant. Only its conformance tests call it; the twenty-five-method development surface and all deferred handler admission remain unchanged.

The reproducible Node oracle extracts the pointer/network expressions and metadata cap from the current TypeScript sources, records their SHA-256 identities and Node version, and verifies **698 committed vectors**. These cover every individual byte, malformed/truncated UTF-8 sequences, ECMAScript trim differences, BOMs, Unicode/spaces, exact captured text, pointer-versus-commondir grammar, mixed network/device prefixes and exact/over-limit byte inputs. The corpus is lexical evidence only; no Git, SQLite, provider, application data or network fixture is used by these new tests. Run `node tests/p2/git-metadata-oracle.mjs` to verify; explicit `--write` regenerates only the adjacent corpus.

Local validation: Release build **zero warnings/errors**; **699/699** focused conformance tests; **6,800 native tests passed, zero failed, one expected local registry-policy skip (6,801 total)**; clean `pnpm check` with **542 tests across 75 files**; local package creation and package/expansion smoke **PASS**. Electron/TypeScript package proof remains separate from native helper conformance. Exact-source independent review is tracked in the sealed `test-results/p2-git-metadata-review` packet. The first Node check failed lint because the new oracle omitted an explicit `URL` import; that import was added, the failed log retained, and the final full check passed. Receipts: `test-results/p2-git-metadata-{oracle,build,focused,native-tests,pnpm-check,package,package-smoke}.log`. Renderer/IPC/user-path source did not change, so no new Electron E2E run was required.

This is a Git/files prerequisite, not complete repository inspection/admission or native Git handlers. Filesystem identity, alias/volume validation, pinned metadata and complete handlers remain future work. Electron/TypeScript remains shipping. Main integration, publication, adoption/real data, cutover/runtime selection, .NET enablement/native handler wiring, deployment, capture/installed S6, schema v6, live providers and protected approvals remain held. No push or new CI run is part of this increment.

### Successor ownership transfer

Recorded 16 October 2026. Ownership of the P2 port moved from Codex task `01a13d05` to a Claude Code session on branch `claude/foundry-p2-cutover-plan-11b4a7`. That branch was fast-forwarded to the retained parser commit `86827ae` (tree `94deb46`); no other source changed. The outgoing managed worktree was removed when its session was archived, and its ignored `test-results/` went with it.

**Lost evidence.** The parser seal, delivery receipt and raw logs cited above are lost, and so are the 14–15 October packets: baseline qualification, admission v2, native lease, PID diagnostics, stage markers and fixture launcher. They are not reconstructed.

**What survives.** The parser's independent SOURCE GO and the earlier independent reviews survive. The parser patch regenerates byte-exactly from Git.

**Where evidence lives now.** The surviving evidence, its hashes and the loss record are kept outside every worktree, in the owner's evidence store at `C:\Users\rdpro\Projects\foundry-evidence\transfer-86827ae\`. New increments write their evidence to sibling folders there. Publishing this stack still needs fresh validation bound to its candidate tree.

### P2 coverage for the Git/files slice

P2.0 is reconciled here only for the Git/files slice. The module map for later slices remains open.

**Method counts, enumerated from code at `86827ae`.**
- `RpcMethods` declares **89** methods. They are set-equal to the 89 RPC schemas among the 99 in `Contracts.json`. The migration plan's figure of 86 (in its summary and its P2 row) is historical.
- The development runtime's `DevelopmentChat.Dispatch` implements **25** of them. The other **64** reach its `NotSupportedException` default and execute nothing.

**Deferred methods that reach Git or files:**
- `project.add`, `task.create`, `workspace.upgrade`, and project-backed, coding or coordinated `task.start`.
- `files.list`, `files.read`, `task.diff`, `task.commit`, `task.push`, `task.retire` and `task.reconcilePublication`.
- The orchestration and continuity methods that create child or continued worktrees.

**Seam security tests that exist today.**
- TypeScript: `network-path`, `agent-channel` (alias coalescing; rebinding a junction, `commondir` or gitdir; legacy bindings), `projects`, `repository`, and `tests/p2/folder-admission.test.ts` (queued identity, final-boundary alias rebinding, unknown outcome after `worktree add`).
- C#: `RepositoryFolderTests`, the network vectors in `SecurityParityTests`, and the 698 `GitMetadataReferenceTests` vectors.

P2.1 below adds native identity coverage. The queued-identity, final-boundary and unknown-outcome workflows still need native worktree creation, which is P2.2.

**Open reconciliation items:**
- **Local aliases: open decision.**
  - Native refuses every reparse point. `RepositoryFolderLease` has done so since the native-lease increment, and P2.1's Git identity now does too.
  - TypeScript follows local junctions and symbolic links.
  - This difference was never listed as approved. It must be decided before native Git-backed handlers are enabled: either prove that following aliases is safe, or accept refusal for projects whose folder, `.git`, gitdir or `commondir` passes through an alias.
  - Cloud-file placeholders, such as OneDrive Files On-Demand, are also reparse points and are refused.
- **Mapped and removable drives: conflicting docs.**
  - The shared residuals above say the approved plan "accepts user-chosen mapped-drive resolution".
  - The detail of migration decision 8 says projects on mapped network drives are refused.
  - Native refuses roots that are not fixed drives, which also excludes removable drives that TypeScript admits. It now refuses network drives by drive type before any open, while TypeScript refuses them only after realpath.
  - One decision is needed; this entry does not choose.

### Local native Git identity foundation (P2.1)

**What it is.** `GitRepositoryLease` is internal and unwired. It is the native counterpart of `resolveGitAdmission`.
- Given a held `RepositoryFolderLease`, it walks up to the nearest `.git`.
- It reads the `.git` and `commondir` pointers through `GitMetadataReference` and resolves them as `path.win32.resolve` does.
- It returns the canonical `{path, root, gitDirectory, common}` identity, with a serialization key equal to `common.toLowerCase()`.

**Differences from TypeScript, all of which fail closed:**
- **No redirected probe.**
  - **Chain first.** For the folder's canonical path and for each referenced directory, the parent chain is opened one component at a time without following reparse points (`DirectoryLease`). Only then is the final component probed, pinned and canonicalized with `FinalPath`. When a subst or 8.3 spelling is used, the canonical chain is verified and pinned as well.
  - **Exact names.** Every component and metadata open uses its `\\?\` namespaced name, so Win32 cannot strip a trailing space or dot and verify a different entry than the one traversal later reaches. Referenced paths with a component ending in a dot or space are refused outright.
  - **Drives.** Mapped network drives are refused by drive type before any open.
  - The shared local-reparse residual for project listing is unchanged.
- **Bounded pointer reads.** Pointer files are pinned with read-only sharing and read through the handle up to 16,385 bytes; a 16,385th byte rejects the file. TypeScript stats the file and then reads all of it, so growth after the stat is read without bound. Shipping TypeScript is unchanged, because this is neither a security nor a data-loss fix.
- **Pins that let Git work.** Directory pins share writes but never deletes. Git's lock-file renames inside a pinned directory keep working, while the pinned directories themselves cannot be renamed, deleted or replaced until disposal. Pins defend against races, not against a hostile process running as the same user, which could still empty a pinned directory and turn it into a mount point.
- **Strict revalidation.** Revalidation resolves again and requires ordinal equality with both the lease and the expected binding. A null or incomplete binding never matches.
- **Approved differences, named in the corpus:**
  - Local aliases are refused (the open decision above).
  - A drive-relative pointer to another drive is refused, because TypeScript resolves it from per-drive process state.
  - A `commondir` that names a file is refused, where TypeScript accepts the file as the "common directory".
- **Ambiguous references are refused before the lease opens them.** These are references that Win32 would read as another entry: a component ending in a dot or space, a stream suffix, or a reserved device name. TypeScript also fails them, but later and with raw filesystem errors. A real directory whose name ends in a dot or space is refused too, which is stricter than TypeScript.

**Supporting changes.**
- `DirectoryLease` gained a write-sharing variant and a typed `ReparsePointException`, which keeps the existing message.
- `DirectoryLease` now opens each component by its namespaced name. This also affects data-directory and folder admission:
  - an intermediate name ending in a space or dot is taken literally, so a junction with such a name is refused rather than verified through a decoy (the same exposure existed in `RepositoryFolderLease`);
  - paths longer than `MAX_PATH` now work instead of failing closed.

  `PinDatabase` still opens its file by its Win32 path.
- `MetadataFile`, `PinnedMetadataFile` and `PathReference` are new Platform primitives.
- Nothing in Store, DevelopmentChat, Program or the protocol calls any of this. The 25-method surface, handler admission and selectors are unchanged.

**Evidence.**
- `tests/p2/git-identity.test.ts` builds **43** disposable trees: hand-built pointers, junctions, and a real `git worktree add`. It pins the shipping resolver's outcomes in `git-identity-vectors.json`, bound to the SHA-256 of `repository.ts` and `network-path.ts`. Regenerating the vectors requires `P2_WRITE_GIT_IDENTITY=1`.
- `GitRepositoryLeaseTests` rebuilds every tree and must match each outcome or its named difference. Where Node raised a raw `ENOENT` or `EISDIR`, native must refuse. The class adds tests for:
  - pins and Git lock-file renames;
  - revalidation;
  - release of partial pins after a failure;
  - loop affinity;
  - folders with no repository;
  - the serialization key;
  - decoy-plus-junction regressions for names ending in a space or `..`, covering the folder lease, the gitdir and the `commondir`;
  - exact refusal messages for each screened name form;
  - paths longer than `MAX_PATH`.
- `MetadataFileTests` covers:
  - probe kinds;
  - exact-limit and over-limit reads, up to 64 MiB;
  - pin refusal of append, rename and delete;
  - a fail-closed open while a writer holds the file;
  - refusal of directories and junctions;
  - refusal of anything that is not a drive-absolute path, before any open;
  - paths longer than `MAX_PATH`;
  - reference resolution checked against Node.

  The file-symbolic-link case skips when Developer Mode is off.

**Independent review.** A read-only filesystem/security reviewer (Opus, high effort, below the xhigh owner) reviewed the first committed tree, `a9c88b6`. It returned **NO-GO** on one confirmed medium finding:
- `GetFullPath` keeps an intermediate component ending in a space or `..`.
- `DirectoryLease` opened that component without a namespace, so Win32 stripped the suffix. Verification therefore checked a plain decoy directory while traversal went through an unverified junction with the exact name.
- The reviewer reproduced this with a decoy and a junction named `a `.
- The same root cause also reached `RepositoryFolderLease`.

The reviewer also raised:
- **Low:** the case count was overstated (44 instead of 43), and two claims overreached.
- **Low:** paths longer than `MAX_PATH` failed without being listed as a difference.
- **Informational:** an unpinned subst chain.
- **Informational:** a test assertion that was too weak.

Each finding is fixed in the follow-up commit, with regression tests.

Re-review of `bbf5360` returned **GO** with one low, non-blocking finding. `GetFullPath` still stripped a trailing dot or space from the *last* component, so `DirectoryLease` pinned a decoy for a name such as `a `. Inside the Git lease this could not cause an unverified traversal, but the fix is cheap: `DirectoryLease` now refuses a final component ending in a dot or space and still normalizes `.` and `..`. A final-component decoy test covers it. The reviewer's confirmation of that delta is recorded with the evidence.

**Local validation of the final tree.**
- Release build: **zero warnings or errors**.
- Focused conformance: **792/792**. This adds the Store and Upgrade classes, which use `DirectoryLease`.
- Focused platform: **30/31**; the file-symbolic-link case skipped.
- Full native suite: **6,890 passed, zero failed, two skipped (6,892 total)**. The skips are the expected local registry-policy test and the file-symbolic-link test.
- `pnpm check`: clean, **543 tests across 76 files**.
- Local package creation and package/expansion smoke: **PASS**. This is Electron/TypeScript proof only.
- `git diff --check`: clean.

**Failures that are retained.**
- The first full run failed two existing assertions that expected exactly `IOException` for a junction refusal. They now assert the typed `ReparsePointException`.
- One final-tree `pnpm check` timed out in the unchanged `git-operations.test.ts` cherry-pick case after 20 seconds and then reported `EBUSY` during cleanup. That file took 243 seconds in the run. Run alone, it passed **27/27**, and the repeated full check passed.

Both failed logs are retained. The final-component guard changed only native source, tests and this document. Its native checks reran in `run4`; the `run3` `pnpm check` and package proof still applies to the unchanged TypeScript and Electron sources. All logs are in `foundry-evidence\p2.1-git-identity\run1` through `run4`. No renderer, IPC or user-path source changed, so no Electron E2E run was required.

**Residuals.** These belong to P2.2:
- the per-common-repository serialization queue;
- revalidation at handler time;
- the read-only sharing of `RepositoryFolderLease`, which blocks renames into the project folder while it is held.

Tests do not exercise mapped-drive or subst behavior, because no network share or session drive letter is touched. P2 remains incomplete, and every hold listed above is unchanged.

### P2.2 Git/files handlers and project/task admission — authority and slices

Recorded 16 October 2026. Rudy wrote: "Start P2.2 in a fresh session and I authorize wiring the completed Git/files handlers into the development-only DevelopmentChat surface (FOUNDRY_RUNTIME_P2_CHAT gate only, no shipping selector); keep native alias refusal for now." He then approved this slice order:
- **a:** an unwired foundation: Git execution, read-only inspection, the per-repository queue and intents;
- **b:** `files.list`, `files.read` and `task.diff`;
- **c:** `project.add`;
- **d:** `task.create`, with worktree creation;
- **e:** `task.commit`, `task.push`, `task.reconcilePublication` and `task.retire`;
- **f:** project-backed `task.start` for folders that are not Git repositories;
- **g:** an unwired one-shot primitive for editing existing files.

**Left out of P2.2:**
- `workspace.upgrade`.
- Git-project `task.start`, and `task.send` on Git tasks. Every Git task's first turn advertises project-channel tools, and coding adds tools that need approvals and the native tool loop.
- Coordinated mode.

Everything else stays held: shipping or runtime selectors, Electron-side .NET enablement, push, PR, CI, main integration, schema v6, adoption, real data, live providers and cutover.

### Local Git execution and inspection foundation (P2.2a)

**What it is.** These internal classes are unwired. Nothing in `DevelopmentChat`, `Program` or the protocol calls them, so the 25-method surface is unchanged.
- `GitRunner` is the counterpart of `RepositoryService.git` and `gitEnvironment`.
- `RepositoryService` is the counterpart of the read-only half of `repository.ts`: `requireRoot`, `requireRepository`, `isGitWorkingTree`, `listFiles`, `readFile`, `uncommittedPaths`, `diff`, and the three filter refusals.
- `RepositoryAdmission`, the per-common-repository queue, and the Store intent primitives.

**Git execution.**
- **Launching.** Git runs only through `JobProcess`. The executable is the first `git.exe` in an absolute `PATH` entry that is a regular file outside the repository first asked about. The choice, or the failure, is remembered for the life of the service, as in TypeScript.
- **Environment and configuration.** Every variable whose JavaScript upper-case name starts with `GIT_` is dropped; this includes the dotless `ı`, which .NET's invariant casing would keep. `GIT_CONFIG_NOSYSTEM` and `GIT_TERMINAL_PROMPT` are pinned. Hooks point at the empty hooks directory, fsmonitor is off, and credential helpers are off unless allowed.
- **Limits and errors.** The timeout is 15 seconds and the output cap 256 KiB. Error mapping, including which messages gain the `Git command failed:` prefix, follows `repository.ts`.

**Revalidation, pins and queue (residuals 1–3 of P2.1).**
- **Revalidation.** The admitted identity is checked again before launch, at the final boundary (`BeforeMutation`), and after exit. A folder with no repository must still have none.
- **Pins.** A `RepositoryAdmission` holds the folder lease and the Git lease across every await of an operation. `RepositoryFolderLease` now shares writes but never deletes: renames into the folder work, and the folder chain itself cannot be renamed or deleted while held.
- **Queue.** Callers key the queue on the identity's `common.toLowerCase()`. Operations with one key run in arrival order, a failure never blocks its successor, and the key is released when its last operation settles. As TypeScript's `.then` defers, an operation starts only after its key is registered.
- **Outcomes.** Git failures (`GitCommandException`) and plain refusals never claim an outcome. Only a caller that knows where its final mutation boundary was classifies one (`RepositoryException`, TypeScript's `RepositoryError`), as `createTaskWorktree` does with the flag its final-boundary callback sets.

**File access at the execution boundary.**
- The parent chain is pinned and verified free of reparse points (`DirectoryLease`).
- The final entry is opened by its exact namespaced name without following a reparse point (the new Platform `ExistingEntry`).
- Containment and sensitive-name checks run on the handle's real path. Reads go through that handle, bounded at 64 KiB plus one byte, where TypeScript stats the file and then reads it unbounded.
- Name rules reproduce JavaScript regular expressions: ASCII-only case folding (a Kelvin sign never matches `k`), `.` excluding U+2028/U+2029, and `$` meaning end of input.
- Listings sort with the `en-US` collation, stably.

**Differences from TypeScript, all of which fail closed or are invisible on success:**
- Local aliases are refused (the approved difference).
- Every reparse point is refused as "Symbolic links cannot be accessed.", including cloud placeholders, which Node follows.
- Node's raw filesystem errors (`ENOENT`, `ENOTDIR`) become fixed native messages.
- `PATH` entries that are network or device paths, or that are not on a fixed local drive, are skipped before any probe. As in TypeScript, a link inside a local entry is still followed.
- A timeout or an output overflow terminates the whole job tree; Node signals only the root process.
- Standard input is closed at launch.
- Revalidation also runs after a non-zero exit.
- A NUL argument gets a fixed message.
- A root or folder segment ending in a dot or space is refused by name. `GetFullPath` would otherwise strip the ending and admit the sibling, while Node opens the literal name; a real folder with such a name is refused too, as P2.1 refuses those names in Git references.
- Filters at a revision accept only a full object id; every TypeScript caller passes the id `rev-parse` returned.
- Truncated output is the first 256 KiB of bytes, where Node's cut point can depend on pipe chunking for multi-byte text.

**Evidence.**
- `tests/p2/repository-inspection.test.ts` builds **87** disposable trees with an isolated `HOME`, no system Git configuration and the C locale. It pins the shipping outcomes in `repository-inspection-vectors.json`, bound to the SHA-256 of `repository.ts`, `git-environment.ts` and `network-path.ts`. The cases cover listings, reads, status, diffs, classification, `core.worktree`, bare and unborn repositories, linked worktrees, and filters at the working tree and at a revision. The file also pins `gitEnvironment()`'s handling of edge variable names. Regenerating the vectors requires `P2_WRITE_REPOSITORY_INSPECTION=1`.
- `RepositoryInspectionTests` rebuilds every tree and must match each outcome or its named difference. Mutating two expected outcomes made both cases fail.
- `GitRunnerTests` covers:
  - injected `GIT_*` variables that try to redirect the repository;
  - executable selection;
  - a timeout that must kill a grandchild holding the pipes;
  - overflow and non-zero exits, with and without permission;
  - identity changes before launch, at the final boundary and after exit;
  - queue ordering and failure isolation;
  - intent bytes and states;
  - quoting round-tripped through `CommandLineToArgvW`;
  - loop affinity;
  - `ExistingEntry`.
- `RepositoryFolderTests` now proves renames into a held folder.

**Independent review.** A read-only filesystem/security reviewer (`cloud-security-vulnerability-expert`, Opus at high effort below the xhigh owner, chosen for the security and data-integrity verdict) reviewed the sealed commit `c44b469`. Its verdict was **GO with conditions**. It verified the seal, built an archive export and probed each finding.
- **M1 (medium).** The runner reported every failure after launch as "no mutation started". A probe ran an alias that updated a ref and then outlived its timeout; the ref landed. Fixed: the runner and plain refusals carry no outcome, and a test proves that a mutating command that times out is not reported as "none".
- **M2 (medium).** `GetFullPath` stripped a trailing dot or space from a root segment, so native listed `repo` for `repo.`, `repo ` and `repo...`, which Node reports as missing. Fixed by the name screen above, with four new vectors.
- **L1 (low).** Classifying a file root threw where TypeScript returns false. Fixed, with two vectors; the catch now covers every failure TypeScript's catch-all would.
- **L2 (low).** An operation with no predecessor started before its queue key was registered. Fixed, with a test.
- **L3 (low).** The documentation overstated how far the `PATH` lookup avoids the network. Fixed by the drive-type check and the corrected wording above.
- **L4 (low).** The runner took a working directory separate from the admitted folder. It now always runs in the admitted folder.
- **Informational.** Applied: unreadable untracked files are skipped as TypeScript skips them; Git's reported top-level path is opened only on a fixed local drive; revisions must be full object ids. Not changed: a running Git process is not cancelled by shutdown and ends within its timeout, as TypeScript's drain waits; `ExistingEntry.Links` stays unused, because hard-linked reads match TypeScript.

### Read-only Git/files handlers (P2.2b)

**What it is.** With `FOUNDRY_RUNTIME_P2_CHAT=1`, the development runtime now serves `files.list`, `files.read` and `task.diff`. That brings it to **28** of the 89 methods. No other surface, selector or schema changed.
- **Task roots.** They follow `service.ts`:
  - a Git task (including a legacy task with no workspace kind) uses its worktree;
  - a folder task uses its saved folder only while that folder still resolves to the same physical folder under the exact spelling it was saved with;
  - any other task has no folder access.
- **Redaction.** `files.read` content and the diff's patch and summary are redacted. Refusals reach the caller as TypeScript's entry reports them: the message, redacted.
- **Worktree base.** It is the data directory's `wt` folder, as `entry.ts` places it.

**Approved-path comparison.** For a folder task, the saved spelling is both the candidate and the approved path, and the folder lease refuses every reparse point. Native therefore keeps only the check that the real path still has the saved spelling, case-insensitively. Today TypeScript refuses a short (8.3) or otherwise non-canonical spelling one check earlier, with the shorter "different location" message; both runtimes refuse. A TypeScript fix for 8.3 approved paths is under separate review. The native comparisons that slice c adds will compare file identity, never lowercased keys.

**Differences:**
- Local aliases are refused (the approved difference).
- Node's raw filesystem errors become fixed messages.

**Evidence.**
- `tests/p2/repository-handlers.test.ts` drives the shipping `RuntimeService` over seeded folder, Git, legacy, projectless and missing tasks, including:
  - network and moved roots;
  - spelling variants;
  - junctions;
  - redaction;
  - refusals.

  It pins the outcomes of 41 calls across 14 cases in `repository-handler-vectors.json`, bound to the SHA-256 of `service.ts`, `repository.ts`, `redaction.ts` and `store.ts`. It also asserts that no persisted row changes. Regenerating the vectors requires `P2_WRITE_REPOSITORY_HANDLERS=1`.
- `RepositoryHandlerTests` seeds the same tasks into a fresh native Store and dispatches through `DevelopmentChat`. It must match each outcome or its named difference, and leave every row unchanged. Mutating a redacted result and an error made both cases fail.
- `DevelopmentChatProcessTests` drives the three methods through the stdio entry point: listing, redacted content, refusals, a redacted diff, and no notifications.
- The two oracles share `tests/p2/repository-fixture.ts`. Slice a's inspection vectors are unchanged.

**Independent review.** The same reviewer re-reviewed the P2.2a fixes and slice b at `ddfa750`. It confirmed M1, M2 and L1–L4 fixed, then returned **NO-GO** on one new confirmed medium. Its stdio probe against the built runtime found the defect.
- **N1 (medium).** A NUL in a renderer-supplied `files.read` or `files.list` path made `GetFullPath` throw an unmapped `ArgumentException`, which stopped the development runtime. TypeScript answers with a redacted error and keeps serving.
- **N1b (low).** A NUL in the final segment read the truncated name, so `notes.txt\0zzz` returned `notes.txt`. Deny-listed names stayed refused, because the real-path check caught them.

Fixed in the follow-up commit:
- Relative paths with NUL are refused as forbidden segments.
- The folder lease and `SameFolder` refuse NUL before any path call, and `MetadataFile.Namespaced` refuses it before any open.
- Every argument, filesystem or access failure in a Git/files handler now becomes the redacted refusal.

The reviewer's informational notes were also applied:
- A folder task's lease stays held across the list or read it checked (N2).
- The folder lease screens the real path for dot and space endings as well as the spelling (N3).
- Like TypeScript, listings and reads stay synchronous with no entry limit, and a stuck Git process holds shutdown until its timeout (N4); the reply size limit still applies.

New coverage:
- vectors for NUL in middle and final segments, in `files.list`, `files.read` and `project.add`; Node refuses each with `ERR_INVALID_ARG_VALUE`;
- an `ExistingEntry` NUL test;
- a stdio test that the runtime answers every NUL request with a refusal and then serves a valid read.

### Project admission (P2.2c)

**What it is.** The development runtime now serves `project.add`, bringing it to **29** of the 89 methods. The handler follows `service.ts`:
1. **Refusals before any probe.** Saved projects require schema v3 or newer. A relative path is refused, and so is a network or device path, before anything is opened.
2. **Pin and classify.** The folder is pinned from its first resolution until the row is saved. A folder that is already saved returns its project without a notification. Classification runs `isGitWorkingTree` under the pin.
3. **Final checks.** The requested spelling must still name the pinned folder, and the Git identity read before classification must be unchanged.
4. **Save.** Only then is the project inserted, or found again if a concurrent request saved it first. The `projects.changed` event commits in the same transaction.

**Approved-path comparison by identity.** TypeScript's recheck, `resolveLocalPath(raw, path)`, becomes `RepositoryPaths.SameFolder`. It follows the reviewed guidance from the TypeScript 8.3 fix:
- Both chains are pinned without following a reparse point, and a reparse point in either refuses.
- The drive type is checked before the approved spelling is probed.
- The spellings match only when they have the same root, the same depth, and the same volume serial number and 128-bit file identifier (`FileIdInfo`) at every prefix. The new `DirectoryLease.Identities` provides these.
- So a different case or a short (8.3) spelling of one folder matches. Two folders that differ only in case inside a case-sensitive directory never do; a lowercased key would have matched them.
- A segment ending in a dot or space is refused, as the folder lease refuses it.

**Differences:**
- Local aliases are refused (the approved difference).
- Node's raw filesystem errors become fixed messages.
- **Atomic notification.** The project row and its notification commit together, and the notification is published after the commit. TypeScript inserts the project and then records the event separately, so a failed event insert leaves a project with no notification. That gap is pre-existing in TypeScript and is not changed here.

**Evidence.**
- `tests/p2/project-admission.test.ts` adds folders through the shipping `RuntimeService`:
  - every spelling of one repository;
  - subfolders, plain folders, linked worktrees and nested repositories;
  - a repository that configures `core.worktree`;
  - root-relative, relative, network and device paths;
  - files, missing folders, broken Git pointers and a junction;
  - two concurrent additions of one folder.

  It pins the returned projects, refusals, saved rows (path keys included) and events in `project-admission-vectors.json`, with generated identities and stamps normalized in order of appearance. It is bound to the SHA-256 of `service.ts`, `repository.ts`, `store.ts` and `network-path.ts`. Regenerating the vectors requires `P2_WRITE_PROJECT_ADMISSION=1`.
- `ProjectAdmissionTests` replays every case through `DevelopmentChat`. It must match each outcome or its named difference, and every committed notification must be published after its commit, in order. The class also covers:
  - folder identity: case, separators, `..`, 8.3 where the volume generates short names, aliases in either chain, missing folders, network and device spellings, and case-sensitive directories where `fsutil` can enable them;
  - prefix identities from the drive root;
  - a common directory redirected while classification runs Git, which must save nothing and notify nothing.

### Git-backed task creation (P2.2d)

**What it is.** The development runtime now serves `task.create`, bringing it to **30** of the 89 methods. It creates a chat or coding task with its own app-owned worktree, following `service.ts`, `RepositoryService.createTaskWorktree` and `agent-channel.ts`:
1. **Refusals before any intent.** These come first, in TypeScript's order:
   - network and device paths, missing paths and aliases;
   - profiles;
   - coordination settings on a chat task;
   - the coding-profile probe;
   - an earlier unknown creation;
   - a folder that is not a repository.
2. **Durable intent.** The `worktree.create` intent is written next, before any Git mutation.
3. **Serialized creation.** The worktree is created under the per-common-repository queue. The caller's admitted identity is revalidated across every await, at the final boundary before `git worktree add --no-checkout`, and before `checkout --no-recurse-submodules`. Filters are refused at the base revision, and the worktree base `<data>\wt` is pinned free of reparse points while the worktree is added.
4. **One commit.** The project (upserted, and promoted from folder to Git), the task, the channel identity binding, the completed intent and the `tasks.changed` notification commit together.

**Outcomes.** A failure before the final boundary leaves the intent complete. Any failure after it leaves the intent unknown, saves no task, and refuses every later creation until someone inspects the retained worktree. Restart recovery turns an interrupted (pending) intent into unknown. Nothing retries.

**Differences:**
- Local aliases are refused (the approved difference).
- Coordinated tasks need the orchestrator, a later slice, so native refuses them before any intent with TypeScript's "not available in this build" message.
- A project path that names a file is refused before any intent. TypeScript refuses it inside worktree creation and leaves a complete intent row.
- Node's raw filesystem errors become fixed messages.
- **Atomic project upsert.** The project upsert commits with the task. TypeScript saves it before the task's transaction.

**Evidence.**
- `tests/p2/task-creation.test.ts` drives the shipping `RuntimeService` through 19 cases:
  - chat and coding tasks;
  - repeated, concurrent, subfolder and linked-worktree creation;
  - a folder project that later becomes a repository;
  - redaction, external profiles with and without a probe, and coordination settings;
  - unknown profiles;
  - non-repositories, and missing, relative, network and NUL paths;
  - unborn repositories, base-revision filters and `core.worktree`;
  - an earlier unknown creation;
  - a junction and a coordinated task.

  It pins every outcome in `task-creation-vectors.json`, bound to the SHA-256 of `service.ts`, `repository.ts`, `agent-channel.ts`, `store.ts` and `git-environment.ts`. The pinned state covers every task, intent, project and event row, plus the repository's refs, worktrees, and each new checkout's status and files. Generated identities and stamps are normalized in order of appearance, and refs and worktrees are ordered by placeholder. Regenerating the vectors requires `P2_WRITE_TASK_CREATION=1`.
- `TaskCreationTests` replays every case through `DevelopmentChat`. Where a difference is named, it requires the refusal and unchanged rows and repository. It also ports `folder-admission.test.ts`'s three workflows to native form:
  - queued requests whose identity changes while the first waits (via a redirected common directory, since aliases are refused) both fail before mutation;
  - an identity change at the final boundary is a known pre-mutation failure;
  - a failure after `worktree add` keeps the branch and worktree, marks the intent unknown, blocks later creation and stays unknown across a restart.

  A pending intent recovered on restart blocks creation too.
- `DevelopmentChatProcessTests` drives `project.add`, `task.create` (with protocol defaults and trimming applied by the entry point), `files.list` and `task.diff` through stdio, with their notifications.

## Personal workspace expansion — local implementation

Recorded 27 September 2026. The [six-stage expansion contract](personal-workspace-expansion.md) extends the [product baseline](foundry-agent-workspace-plan.html). All six stages are implemented on `codex/personal-workspace-expansion`, integrated with main's saved projects, usage analytics, browser workflows and portable packaging. No installation or live-provider qualification is implied.

| Stage | Delivered behavior | Principal evidence |
| --- | --- | --- |
| 0 | Shared coordinator transcript; canonical MCP configuration with safe status/edit types and verified repair; accessible inspector drawer; explicit documentation screenshot command | Coordinator restart and keyboard approval at 200% zoom, MCP rejection/repair/canary and large-server regressions |
| 1 | Inbox, Recent, All tasks, Archived; root-group archive independent of execution; FTS search; bounded stable task/message/action pages and complete chunks | 1,000-task/100,000-message fixtures, concurrent/escaped paging, archived pending child recovery, Inbox failure behavior |
| 2 | Recorded activity, SVG dependency/usage views with accessible alternatives, recovery links, opt-in generic native notifications | Authoritative event/record mappings, unknown-usage separation, notification sender/content tests |
| 3 | Local task templates; typed lifecycle rules and inert drafts; pinned PowerShell/JavaScript revisions, revocable grants and supervised execution | No-grant/expired/changed-pin cases, renewal/revocation races, unknown restart, output limits, Windows child cleanup and split UTF-8, fresh ordinary approval for action drafts |
| 4 | Decision history, cited continuation context and exact source revisions, safe local previews, Markdown/JSON/checksum export | Independent authority, unknown/dirty-source rejection, path/signature/size checks, escaped preview bounds, export snapshot consistency and interruption cleanup |
| 5 | App-open one-time/daily/weekly reminders and prompt drafts, editable task/zone/date/weekday settings, archived-task reminders | DST gap/fold, activation boundary, UTC occurrence retention, timezone revisions, missed-occurrence coalescing and no automatic model turn |

The runtime remains the sole application-data writer and execution authority; Chromium owns its isolated browser-profile databases. Integrated schema v5 follows the saved-projects v3 and usage v4 migrations. Existing v1–v4 databases require explicit confirmation and a verified WAL-aware backup. Migration/index/FK failure rolls back inside the transaction. Existing unsafe MCP configuration is logically quarantined; retained backups and historical filesystem bytes are not claimed to be erased.

Integration preserves draft-first task creation and exact profile credential binding. Browser cancellation and retirement invalidate attachments even while eligibility reads are pending; stale transport callbacks cannot tear down a replacement runtime. Paged usage and trend queries now use the canonical provider-request ledger, count migrated records once, include coordinator children, and distinguish observed tokens, pending reservations, unknown usage and requests not sent. Independent security review found no remaining blocker in these boundaries.

Archive, hook and scheduling admission can be paused persistently while retaining history and recovery. The reusable script grant is an explicit new permission class: scripts run with Windows user privileges, and a pinned entry file does not pin imported code or external effects. Script-produced application actions still require a new review and one-shot approval. Schedules only produce reminders/drafts; the user presses Send.

Independent review used three GPT-6 Sol / medium specialists under the Critical owner, selected by the working agreements and workflow-router. Runtime/data review covered schema, paging, source verification and export consistency. Product/UI covered navigation, accessibility, bounded rendering and restart journeys. Security/QA reviewed credentials, MCP, IPC, script grants, dispatch races and process cleanup. The owner retained service integration and final verification. Concrete findings were fixed and tested, including queued grant renewal, oversized config responses, UTF-8/pipe handling, and source-lock validation order.

| Specialist | Model / effort | Selection source | Routing reason |
| --- | --- | --- | --- |
| Architecture and runtime (`architecture_audit`) | GPT-6 Sol / medium | Working agreements and workflow-router | Bounded data/query work and independent migration, upgrade-admission and script-launcher review |
| Desktop UX (`product_ux_roundtable`) | GPT-6 Sol / medium | Working agreements and workflow-router | Navigation, transcript presentation, accessible dialogs and desktop regression journeys |
| Security and QA (`security_audit`) | GPT-6 Sol / medium | Working agreements and workflow-router | Trust boundaries, negative tests, process supervision and independent review of runtime/data changes |

The owner independently reviewed the runtime supervisor pipe-failure change. The final PowerShell launcher received independent architecture review and a separate real-Windows run of its 35-test automation suite; both passed. Final desktop review also closed native-dialog focus wrapping and nested close-event bubbling; the 200% grant test verifies natural keyboard traversal, viewport visibility and preservation of the outer settings dialog. These reviews supplement the integrated gates below.

### Expansion verification before main integration

| Boundary | Passing evidence | Scope |
| --- | --- | --- |
| Types, lint and automated tests | `pnpm check --maxWorkers=1 --hookTimeout=60000`: **33 files, 329 tests passed** in 523.63 seconds, clean typecheck and lint | Final application and test-harness files; v1/v2 upgrades and failure rollback, MCP quarantine/canaries, 1,000 tasks and 100,000 messages, bounded/escaped queries, script authority/races/cleanup, continuity/export, schedules and desktop transport failures |
| Desktop user paths | `pnpm test:e2e`: **13 passed (2.5m)** | Coordinator history and completion/restart, archived child approvals through Inbox, action-query failure, v1 upgrade, native 200% approval/grant keyboard paths, nested-dialog close preservation, reminders, compaction, MCP, reviewed editing and commands |
| Packaged build | `pnpm package:dir`: **PASS** | Final Windows x64 unpacked build at `release/win-unpacked/Foundry Agent Workspace.exe`, with the unpacked Job Object helper and native SQLite dependency |
| Packaged runtime | `pnpm smoke:package`: **PASS** | SQLite v3; 14 bound coordinated approvals, 3 serial integrations and exact-tree validation; archive obligations, fresh continuation and checksummed export; Unicode PowerShell/JavaScript hooks, pinned-source review, changed/untrusted revisions, malformed/oversized output, revocation and descendant cleanup; archived reminders and forced runtime crash recovered as unknown without replay |

Final logs are retained under `.local/verification/personal-workspace/`: `check-complete.log`, `e2e-release-qualified.log`, `package-qualified.log`, and `smoke-final-qualified.log`. The packaged executable and smoke assertions were unchanged by the subsequent test-harness error-reporting-only cleanup; the final full check covers that cleanup. Earlier failed diagnostic logs remain separate and are not passing evidence.

The same directory retains `script-grant-200-percent.png` (native Electron capture), `usage-chart.png`, and `orchestration-complete.png`, all visually inspected. Routine renderer screenshots remain in ignored `test-results/`; updating documentation images requires the separate `pnpm docs:screenshots` command, which was not run. The source/diff check is clean, and first-party application, script and test searches found no remaining `workspace.snapshot` or `task.get` RPC callers.

Live Azure model qualification, clean Windows installation, publisher signing and external distribution remain separate gates. `Get-AuthenticodeSignature` reports the unpacked executable as **NotSigned**. Native Windows toast delivery was not manually qualified; automated coverage verifies preference, sender and safe notification-content behavior. No production/user data was migrated by this implementation task. Tests use isolated repositories, databases and injected providers.

One failed-smoke fixture remains at `C:\Users\rdpro\AppData\Local\Temp\foundry-package-smoke-TIjYKj`. Its runtime was terminated; a later explicit cleanup was rejected by the command policy with "blocked by policy," so no alternate deletion route was attempted. This directory contains isolated test data, not application/user data.
### Integrated validation after main synchronization

The final integrated source passed `pnpm check --maxWorkers=2 --hookTimeout=60000`: **43 files, 423 tests**, clean typecheck and lint (404.66 seconds). `pnpm test:e2e` passed **21 tests (3.6 minutes)**, including saved projects, browser actions, canonical usage, coordinator restart, archived approvals and keyboard operation at 200% zoom. Independent review cleared the canonical usage queries and cancellation/transport race fixes.

Logs: `.local/verification/personal-workspace/integration-check-final.log` and `integration-e2e-qualified.log`. The screenshots prefixed `integration-` in that directory preserve the grant, coordinator and usage views. Later smoke-harness-only edits update two schema-version assertions from v3 to v5 and wait for the queued-to-cancelled revocation transition while rejecting any dispatch. Scoped ESLint passed; independent review confirmed the timing boundary, and the packaged smoke run directly validates those assertions.

`pnpm package:dir` and `pnpm smoke:package` passed against the integrated application. Packaged evidence covers schema v5, saved projects, idempotent draft starts, canonical usage, 14 bound coordinator approvals, 3 integrations, MCP, continuation/export, archived reminders, script limits/revocation/process cleanup and crash recovery without replay. Logs: `integration-package.log` and `integration-smoke-package-final.log`. Earlier diagnostic failures are retained separately and superseded by this passing run.

`pnpm package:portable` and `pnpm smoke:portable` also passed; the portable executable extracts and starts bundled Electron 44.4.1 with functioning SQLite. Logs: `integration-portable-build.log` and `integration-portable-smoke.log`. Portable SHA-256: `805906f7e35e758a77786ee417e021aa358b5b9f5a225345d788f92b588ae1b4`; packaged `app.asar` SHA-256: `3956803d55a98b9f4ff86eaa1db2283a830421cce4e9f1fb1449a2196c645aef`. The portable executable is **NotSigned**. These local results do not assert a published release, clean installation or live Azure qualification.

## Saved projects and draft-first chat creation — 27 September 2026

Local implementation on `codex/saved-projects-sidebar` in the [Foundry Agent Workspace source](https://github.com/koala-man-64/foundry-agent-workspace). Publication, installed application upgrades, and live provider qualification are separate gates.

- The sidebar now groups chats under saved projects, with compact status dots, alphabetical project ordering, recent chat ordering, and a final **No folder** group. Project menus and **Manage projects** support rename, hide, and restore. Hiding retains chats and files; collapsed groups persist. Settings and diagnostics are in the footer.
- **New chat** and project **+** controls open session drafts in the main area. Switching projects preserves drafts, and background refreshes do not replace them. The first send creates the chat; an omitted title comes from the first message's first line, limited to 80 characters. Model and Git mode preferences persist app-wide; ordinary-folder and projectless drafts use Chat without changing the remembered Git mode.
- Saved projects use stable IDs and canonical paths. Folder registration uses the native picker and runtime validation. Missing folders stay listed as unavailable. Task workspace kinds distinguish Git worktrees, ordinary folders, and no folder; the runtime enforces the same capabilities as the inspector. Ordinary-folder browsing retains containment, symlink, secret-file, and size checks. Coding, coordination, worktree operations, and Git publication require Git workspaces.
- `task.start` binds a client request ID to the first message and settings. Durable reservation precedes workspace creation and dispatch. Completed retries return the existing task; unknown outcomes retain their evidence and do not replay automatically. The renderer retains failed drafts and their original request. Existing task-creation callers remain supported and their successful creations associate with saved projects.
- Schema v3 adds projects, preferences, and first-send records. Existing v1/v2 databases remain readable until the user confirms the existing verified-backup upgrade flow. Migration groups legacy tasks by project path and preserves task IDs, history, and coordinator/child relationships.

Validated locally using temporary folders, fresh application data, and offline providers:

- `pnpm check`: typecheck and lint passed; 256 tests passed across 24 files after integrating the project channel.
- `pnpm test:e2e`: all 11 Electron workflows passed, including coordinated draft first-send, saved ordinary folders, Git projects, No folder, confirmed v1 upgrade, restart history, keyboard navigation, and the narrow layout. Background task events preserve another project's draft. Git chats retain the project channel; folder and projectless chats cannot access it.
- The initial integrated Electron run exposed an approval test helper that silently stopped waiting before the next approval arrived. The helper now waits for completion or a pending approval and binds its evidence, click, and state check to one stable approval ID. Independent review found no remaining issue; typecheck and scoped lint passed.
- `pnpm package:dir` and `pnpm smoke:package`: passed. The packaged runtime verified schema v3, idempotent folder/projectless first-send, saved-project management, reviewed coding tools, coordination, compaction, MCP, diagnostics, and safe Git retirement against isolated fixtures.
- Independent GPT-6 Sol/medium review of filesystem, IPC, persistence, concurrency, and draft boundaries found no remaining actionable defects after fixes. Three GPT-6 Sol/medium agents handled runtime implementation, renderer implementation, and independent review under the supplied AGENTS.md Critical lane.

The final stable-ID coordinator Electron rerun passed (1.7 minutes). Packaging and packaged smoke passed again after integration. Exact command logs and review evidence are retained under `.local/validation/saved-projects-*` and `.local/validation/delivery-*`. Packaged `release/win-unpacked/resources/app.asar` SHA-256: `1f8e1f9d4cadeeb857700a687195142c0cadad7056043ccdfed803cd2b59fd21`.

This is a local source and unpacked-package result. No user's application database was upgraded. External publication, installed/signed installer validation, live Foundry qualification, and live deployment remain unverified and outside this change's execution.

## Project channel — local implementation

Recorded 27 September 2026. Agents in separate task chats and coordinator teams can discover teammates, broadcast project messages, and send direct messages. The runtime derives membership from the canonical local Git common directory, including linked worktrees. Independent clones stay separate. The inspector exposes **Project channel**, a participant list, paginated retained history, and a user-labelled message composer.

The protocol validates every request. Sender identity comes from the active runtime task; messages cannot supply authority, widen assignments or approve actions. Cancelled/terminal coordinated agents and retired tasks cannot send. Secret-screened messages have byte and per-task count limits. Communication-only tools are available to capable chat profiles without enabling repository tools; text-only profiles can receive pending context. Coding and coordinated agents retain their existing action gates.

Messages and per-recipient delivery cursors use existing events, with an incremental runtime metadata index and primary-key body reads. No schema upgrade is added. Delivery occurs on the next model request, including native tool continuation, and never wakes an idle agent. Cursors advance with successful provider-state persistence; a failed request leaves messages pending. Serialized delivery is bounded and explicitly marks truncated text, while history retains the full message. Real native chat histories also participate in compaction and pending messages are included in usage estimates.

Independent review used GPT-6 Sol at medium effort, selected by the project working agreements for IPC, persistence and concurrency risk. Review findings on event-scan cost, linked-worktree identity, and escaped-message bounds were fixed with regressions; the final channel and compaction review found no remaining blocker.

Validation completed locally against isolated fixtures:

| Boundary | Evidence | Scope |
| --- | --- | --- |
| Types, lint and automated tests | `pnpm check --maxWorkers=1 --hookTimeout=60000`: **23 files, 242 tests passed**, clean typecheck and lint | Includes 9 channel unit tests, 4 channel integration tests, native chat/coding compaction, and existing approval/coordinator coverage. One worker and a 60-second fixture setup limit accommodate slow Windows Git setup; application timeouts and safety assertions are unchanged. |
| Desktop user paths | `pnpm test:e2e`: **8 passed (3.2m)** | Agent broadcast, user direct message, recipient isolation, idle-agent behavior, retained visible history, and existing desktop workflows. After the final CSS-only contrast adjustment, `pnpm exec playwright test tests/e2e/agent-channel.spec.ts` passed again (6.4s), and the screenshot was visually inspected. |
| Packaged build | `pnpm package:dir`: **PASS** | Final Windows unpacked build at `release/win-unpacked/Foundry Agent Workspace.exe`, including the final styling. |
| Packaged runtime | `pnpm smoke:package`: **PASS** | SQLite v2, approved editing/commands, 14 bound coordinated approvals, 3 serial integrations, compaction, MCP, diagnostics and clean fixture retirement through the packaged executable. |

Exact logs and the final channel screenshot are retained locally under `.local/verification/agent-channel/`: `check-serial.log`, `e2e.log`, `channel-ui-final.log`, `package.log`, `smoke.log`, and `agent-channel.png`. Earlier failed diagnostics are also retained; their results do not replace the passing evidence above. The package smoke verifies runtime compatibility; the dedicated channel tests supply messaging behavior evidence. Live paid-provider messaging, installer installation and external publication are unverified. No dependency or database schema change was required.

## Built-in usage analytics — 27 September 2026

Implemented locally: a Usage overview with local-calendar date ranges, daily measured tokens, conversation/model/effort/profile/API comparisons, request drilldowns, child attribution, and separately labelled profile checks. Offline demo requests are excluded by default. Cached input and reported reasoning are subsets of input/output; missing breakdowns remain unavailable. Reservations and unreported consumption are distinct from measured tokens.

Model profiles now support optional requested-effort presets. The native provider parameter is sent on each request and included in verification identity. Existing default profiles keep their fingerprints. Explicit-effort connection checks use the configured output allowance and disclose up to four requests; routine tests use injected providers.

Schema v4 adds one canonical request ledger after the saved-projects v3 migration. Admission and budget reservation are transactional, as are terminal accounting and budget settlement. Final provider usage can be retained for failed/cancelled requests without executing their tools. Restart recovery retains original request identities and never retries inference. Existing v1/v2/v3 data is upgraded only through the explicit verified-backup action; historical attribution/outcome remains unknown where it was not recorded, and original usage rows are retained. Existing v2 orchestration and v3 saved projects remain available before upgrading.

Initial validation completed on Windows on 27 September 2026, before integration with the project-channel increment, using isolated application data and injected/offline providers:

| Gate | Result | Local evidence |
| --- | --- | --- |
| `pnpm check --maxWorkers=2` | Type checking, lint, and **266 tests in 25 files passed** | `usage-check-final.log` |
| `pnpm test:e2e` | **10 tests passed**, including v1 upgrade, Usage filters, partial metrics, pagination, child navigation, and effort choices | `usage-e2e-final.log`; `test-results/usage-seeded-overview.png` |
| `pnpm package:dir` | Windows application directory built successfully | `usage-package-dir.log`; `release/win-unpacked` |
| `pnpm smoke:package` | Packaged schema v3, usage RPCs/pagination, coding, orchestration, MCP, compaction, publication, and retirement checks passed | `usage-smoke-final.log` |
| Independent implementation review | Provider, accounting/persistence, IPC/runtime integration, and UI reviews completed; findings resolved and rechecked | Specialists `usage_provider_impl`, `usage_ledger_impl`, and `usage_accounting_review`: GPT-6 Sol, medium, selected under the AGENTS.md Critical lane |

The first unconstrained check was interrupted after widespread timing failures; the final run used two workers. Effort choices were checked against current [Azure reasoning guidance](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning) and [Anthropic effort guidance](https://platform.claude.com/docs/en/build-with-claude/effort); Azure `max` is offered only for Responses, and deployment-specific support still requires connection verification. Test-generated documentation screenshots are retained. Local evidence logs and test-result images are ignored build artifacts, not external publication evidence.

Delivery integration preserves the [project-channel changes](https://github.com/koala-man-64/foundry-agent-workspace/commit/2b42bb7c5ac99d8a520df8fa9bbd310e83a0acbd) and the later [saved-projects changes](https://github.com/koala-man-64/foundry-agent-workspace/commit/cdec0a376b31f8bab1815953828b5a8002ab5944). Channel acknowledgement and usage settlement remain transactional; each channel-tool continuation has a separate request identity. The upgrade guard allows read-only channel queries and blocks channel sends. Saved projects retain schema v3, while usage becomes v4; folder and projectless first-send requests are measured once, including idempotent retries. Independent GPT-6 Sol/medium review confirmed runtime and migration boundaries after integration.

Validation before the saved-projects integration for [PR #7](https://github.com/koala-man-64/foundry-agent-workspace/pull/7): `pnpm check --maxWorkers=2 --hookTimeout=60000 --testTimeout=60000` passed type checking, lint, and **282 tests in 27 files**. All **11 desktop tests**, the Windows package build, and packaged smoke also passed. A previous run reached 281 passing tests but timed out during the existing forged-provenance Git fixture and then encountered a cleanup lock; the final run used a 60-second test allowance without changing application timeouts or assertions. Delivery logs are `usage-delivery-check.log`, `usage-delivery-e2e.log`, `usage-delivery-package.log`, and `usage-delivery-smoke.log`.

Final saved-projects integration validation: the full `pnpm check --maxWorkers=2 --hookTimeout=60000 --testTimeout=60000` passed type checking, lint, and 299 of 300 tests across 28 files. Its sole failure was the upstream unsupported-future-schema fixture still using version 4. After updating that test-only fixture to version 5, `pnpm check packages/runtime/tests/orchestration-store.test.ts --maxWorkers=1 --hookTimeout=60000 --testTimeout=60000` passed type checking, lint, and all 17 affected tests. No application code changed after the full run; these results cover all 300 tests. `pnpm test:e2e` passed all 14 tests, and the rendered Usage page was visually inspected with the saved-projects sidebar. `pnpm package:dir` and `pnpm smoke:package` passed with schema v4, saved projects, projectless/folder first-send chats, and usage summaries/breakdowns/pagination. Exact logs: `usage-main-check.log`, `usage-main-schema-check.log`, `usage-main-e2e.log`, `usage-main-package.log`, and `usage-main-smoke.log`.

Live provider qualification and application installation have not been performed for this increment. No existing user database was upgraded. Durable coordination registration was unavailable (`session_token_unavailable` / installation mismatch); implementation used disjoint file ownership in a private task worktree and has no registered claims to release.

## Portable Windows build automation — 27 September 2026

Hosted qualification follow-up: Windows aliases exposed an MCP containment gap. Validation now compares both authored and canonical paths, resolves existing ancestors for missing paths, and fails closed when inspection fails. Browser resizing now uses available workspace geometry, hides native content during dragging, and releases capture on cancellation or blur. Expanded mode hides the resize handle and remains visible on narrow windows. Project fixtures compare canonical paths.

The [timed hosted diagnostic](https://github.com/koala-man-64/foundry-agent-workspace/actions/runs/36339163356) measured 32.3 seconds before the MCP fixture started, followed by an immediate reply after the former 30-second initialization deadline. Initialization now has a bounded 60-second allowance; listing and configured tool-call deadlines are unchanged. The command helper watchdog separately allows 60 seconds for startup while its native command execution deadline remains unchanged. Both Windows helpers check cancellation before process creation and resume. Actual-helper regressions prove that pre-cancelled launches do not execute user code. Numeric transport diagnostics retain no protocol content. The slow phase within Windows host preparation has not been isolated.

The follow-up passed independent GPT-6 Sol/medium review under the project's Critical policy, focused helper and process-tree regressions, typecheck and scoped lint, `pnpm package:dir`, and `pnpm smoke:package`. The [hosted qualification run](https://github.com/koala-man-64/foundry-agent-workspace/actions/runs/36339879307) passed typecheck, lint, all **325 tests across 32 files**, all **16 Electron workflows**, the portable build, both packaged-runtime and portable-launcher smoke tests, and artifact/checksum upload. Earlier evidence below describes its respective source revision; signed distribution, live providers, and interactive use on a fresh machine remain separate qualification gates.

The final `pnpm smoke:package` also passed: packaged schema v4, folder/projectless first-send, saved projects, usage summaries, reviewed coding operations, 14 coordinated approvals, compaction, MCP, sanitized diagnostics, and safe Git retirement all ran against isolated fixtures.

Final integration verification after combining the browser with saved projects, the project channel, and usage analytics: `pnpm check --maxWorkers=1` passed **32 files / 320 tests** (540.32 seconds), including typecheck and lint; `pnpm test:e2e` passed **16 tests** (2.7 minutes). The narrow-window regression is covered by retaining New chat navigation while hiding native browser content. Both `pnpm package:dir` and `pnpm package:portable` passed. `pnpm smoke:portable` passed against the actual Windows x64 EXE, including bundled Electron 44.4.1 and SQLite. The smoke script's final diagnostic change also passed scoped ESLint and independent GPT-6 Sol/medium review. The first combined check exposed one stale denial-message assertion and Windows Git-fixture timeouts; the final run passed without extending timeouts. Logs are retained locally under `.local/browser-verification/merge-*`.

The `Portable Windows build` workflow runs for every push to `main` without path filters and can also be started manually. A Windows x64 runner installs the frozen lockfile and pinned Electron runtime, runs `pnpm check --maxWorkers=1` and offline Electron E2E tests, builds `pnpm package:portable`, and smoke-tests the packaged runtime and portable launcher before uploading the portable EXE and its SHA-256 checksum. The launcher check exercises extraction and bundled Electron/SQLite with an isolated temporary directory; it does not qualify interactive use on a fresh machine. Tests use one worker to reduce Windows process contention. Artifacts expire after 30 days. Actions are pinned to verified commit SHAs, checkout does not retain credentials, and the workflow token has only `contents: read` permission.

The portable build needs no installer or Node.js/pnpm on the destination machine. Git remains necessary for repository tasks. Application data and browser sessions remain per Windows user, rather than beside the EXE. Signing, automatic updates, and GitHub Release publication are not configured. The matching GitHub Actions run and its uploaded artifact are authoritative for hosted build success; local validation alone does not establish it.

Local verification: actionlint 1.7.12 passed; `pnpm check --maxWorkers=1` passed all **25 files / 248 tests** (721.35 seconds), including typecheck and lint; `pnpm test:e2e` passed **9 tests** (3.3 minutes); `pnpm package:dir`, `pnpm package:portable`, and `pnpm smoke:package` passed. The generated portable EXE's SHA-256 checksum was independently verified. The initial parallel test run timed out in one Git fixture (247 passed); the final single-worker command passed the entire suite without changing test limits. Exact logs are retained locally under `.local/browser-verification/ci-*` and are not committed.

## Integrated browser — 27 September 2026

Local implementation adds the resizable Browser inspector, managed tabs, expansion, navigation controls, and one app-owned Chromium profile shared across projects. Cookies and website storage live under `userData/browser-data` (including the isolated test-data override). Restart begins with one blank tab; there is no application browsing-history database or saved tab list. Confirmed site/profile clearing touches browser storage only.

Website views use sandboxed `WebContentsView` without Node, preload, or an application bridge. The main process owns lifecycle, profile, navigation policy, native dialogs, and bounded CDP operations; the runtime retains sole ownership of application SQLite. No production dependency or separate browser installation was added. Permission requests default to denied, certificate errors are not bypassed, and only HTTP/HTTPS navigation is accepted.

Explicit attachment shares a bounded visible-page snapshot with that chat's configured model. Ordinary chats receive browser tools without repository tools; coding tasks also use the native continuation path. Every interaction uses an existing persisted approval record bound to chat, tab, attachment, origin, document generation, snapshot target, and exact arguments. Navigation or takeover invalidates pending actions; origin changes suspend reads. Dispatch failures with uncertain results remain unknown, are never replayed automatically, and have a browser-specific inspection acknowledgment that does not relax filesystem or external-tool recovery.

File selection and download destinations are manual. Attachment refuses pages with selected files and blocks input/navigation during the attachment scan. Agent tools expose no chooser, filesystem, cookie, storage, raw CDP, or arbitrary JavaScript access. Attached views block downloads and common direct file-transfer request bodies. This is not a general data-loss-prevention boundary: website JavaScript can still send data it already holds using ordinary network requests. Password fields and hidden form values are excluded from snapshots; websites and page instructions remain untrusted.

Independent GPT-6 Sol/medium review found no remaining concrete security blocker after fixes for focus-redirection during key actions, selected-file inheritance and attachment races, origin handling, popup adoption/self-close, and shutdown cleanup. All four bounded agents used GPT-6 Sol/medium, selected under the project's Critical lane: `browser_controller` owned the native host and lifecycle; `browser_runtime` owned persisted approvals and native continuations; `browser_ui` owned controls and bounds synchronization; `browser_security_plan_review` independently reviewed IPC, persistence, and concurrency. Final integration and validation were performed by the owner.

| Evidence | Result | Scope |
| --- | --- | --- |
| `pnpm check --maxWorkers=1` | **25 files / 248 tests passed**, typecheck and lint passed | Full suite, serialized to reduce concurrent host load. Final typecheck/lint also cover the subsequent popup lifecycle, coordinated-inspector layout, and fixture changes. |
| Focused browser suites | **4 files / 19 tests passed** | Protocol validation, ordinary-chat tool isolation, durable approvals and unknown acknowledgment, target staleness, one-shot concurrent dispatch, redirect suspension, takeover/crash/detachment, selected-file rejection, popup adoption/self-close, address normalization. |
| `pnpm test:e2e` | **9 passed** | Browser storage restart (persistent cookie, local storage, IndexedDB), blank startup, native view isolation, expansion/dialog hiding, managed popup login/self-close, site/profile clearing, ordinary-chat approved action, secret canaries, takeover and destination-controlled download; existing coordinated, coding, MCP, and history routes remain passing. |
| Expanded browser E2E rerun | **2 passed** | Added real file-chooser selection and multipart upload to the isolated local server, including attachment refusal while the file was selected. |
| `pnpm package:dir` | **Passed** | Unpacked Windows application built successfully with existing dependencies. |
| `pnpm smoke:package` | **Passed** | Packaged runtime/SQLite, approved coding edit and command, coordinated workflow (14 bound approvals), compaction, MCP host, diagnostics, and safe retirement. Runtime-only fixture explicitly responds to the private browser channel with no attached tabs. |

Exact logs are retained under `.local/browser-verification/`: `check.log`, `browser-unit.log`, `e2e-final.log`, `browser-e2e.log`, `typecheck-final.log`, `lint-final.log`, `package.log`, and `smoke.log`. Earlier failures exposed fixture synchronization gaps, popup lifecycle defects, and a five-pixel coordinated inspector caused by the new resize column; the final runs above include their fixes. Tests use isolated data and local fixtures with no paid provider probes.

These results establish local source, desktop user-path, and packaged-runtime evidence. The pull request and matching GitHub Actions run separately establish main-branch integration and hosted artifact delivery. Real provider/browser combinations, third-party identity-provider policies, clean-profile installation, and signing remain separate release gates. Browser extensions, multiple profiles, password management, and system-browser imports remain out of scope. File chooser automation and save-dialog destination injection qualify application behavior; human interaction with the platform-native save dialog remains a manual release check.

## Phase 05 — Independent review and Windows release

Recorded 19 September 2026 (America/Chicago) on branch `main`. Delivered via parallel multi-agent workstreams:
- **Workstream A (Security, IPC & Canary Hardening)**: Claude Opus 5 (`c642667`)
- **Workstream B (Live Deployment Qualification Framework)**: Claude Sonnet (`f2e6533`)
- **Workstream C (Packaging & Clean Installer)**: Claude Sonnet (`1c05b87`)
- **Workstream D (Disaster Recovery & Operational Runbook)**: Antigravity (`c0d1352`)
All four workstreams merged into `main` with zero conflicts and full automated test, packaging, and smoke verification.

### Delivered

- **IPC sender origin & subframe security hardening.** `authorize(event)` in `apps/desktop/src/main/index.ts` validates that IPC requests originate strictly from the main frame on the expected scheme (`file:` in packaged builds, `http:` on localhost in development). Because `URL.origin` evaluates to the string `"null"` for `file:` and non-special schemes, the gate now compares protocols explicitly and fails closed with `'Untrusted IPC origin.'` if the scheme differs, preventing foreign-scheme frame spoofing. Unparsable URLs fail closed cleanly.
- **JSON-escaped credential canary screening.** `Redactor.add` in `packages/runtime/src/redaction.ts` registers bounded JSON encoding levels of known credentials (including escaped quotes, backslashes, and newlines). Tests verify the specified canaries and surfaces. Pattern screening also detects some bearer tokens and private keys; it is not a universal secret detector, and logical repair does not erase historical WAL pages or backups.
- **Product-wide security audit suite.** `tests/integration/security-audit.test.ts` (734 lines) provides comprehensive automated regression testing across 4 critical security boundaries: IPC frame sender origin verification (stand-in Electron module exercising real handlers with forged senders and subframes), Windows path containment (asserting rejection of UNC paths `\\.\`, `\\?\`, NTFS Alternate Data Streams `:stream`, 8.3 short-name aliases, trailing dots/spaces, and junction traversal), synthetic secret canary leak matrices, and Windows Job Object descendant termination.
- **Standalone Azure Foundry deployment qualification CLI.** `scripts/qualify-deployments.mjs` (769 lines) executes the full 5-point qualification protocol against live or mock Azure Foundry endpoints across all three supported API kinds (`responses`, `chat-completions`, `anthropic`): (1) streaming text & time-to-first-token latency, (2) native tool-call generation and schema parsing, (3) tool continuation with opaque reasoning / signature preservation, (4) mid-stream cancellation via `AbortController`, and (5) token burndown & cache accounting. Includes `--mock` flag for 100% offline testing without live network calls, TypeScript definitions (`scripts/qualify-deployments.d.mts`), automated Vitest coverage in `packages/providers/tests/qualification.test.ts`, and reference schema `docs/qualification-template.json`.
- **Windows clean-profile installer auditor.** `scripts/verify-clean-install.ps1` (232 lines) audits the production NSIS package: validates executable presence and size, captures Authenticode signature status via `Get-AuthenticodeSignature`, verifies unpack configuration and unpacked helper scripts (`mcp-host.ps1`, `job-runner.ps1`, native `.node` binaries), verifies non-elevated per-user installation target (`%LOCALAPPDATA%\Programs\Foundry Agent Workspace`), verifies application data segregation (`%LOCALAPPDATA%\FoundryAgentWorkspace`), and confirms safe uninstallation scope (preserves user project repositories and worktrees).
- **Code signing and distribution documentation.** `docs/signing-and-distribution.md` provides comprehensive guidance on Authenticode signing options (unsigned developer builds with SmartScreen instructions, self-signed test certificates, and enterprise Azure Trusted Signing configuration), per-user non-elevated installation, and data retention policies.
- **Disaster recovery runbook.** `docs/recovery.md` documents operational procedures for: read-only reconciliation of unknown commit, push, and worktree retirement intents; SQLite database integrity verification (`PRAGMA integrity_check`) and WAL checkpointing; rolling back schema upgrades from automatic `.bak` backups; resolving and adopting coordinator cherry-pick merge conflicts in external editors; and rotating credentials in Electron `safeStorage`. *Superseded 16 October 2026:* an audit against the code found wrong RPC names, file names and controls, plus unsafe steps (discarding changes, removing worktrees by hand, checkpointing the live WAL, restoring by copy). The runbook was rewritten.
- **Release evidence matrix.** `docs/release-evidence.md` tabulates all 9 release acceptance criteria from Section 07 of the plan against exact automated test suites, commit citations, and verification artifacts. *Corrected 16 October 2026:* criteria 1 and 9 are open, and 4 is partly met; the earlier statuses overstated offline evidence.

### Validation

| Boundary | Evidence | Scope |
| --- | --- | --- |
| Types, lint, tests | `pnpm check`: **21 files, 228 tests passed (clean typecheck and lint)** | Prior 192 tests plus security audit suite (26 tests in `security-audit.test.ts`) and qualification suite (5 tests in `qualification.test.ts`). Zero failures. |
| Live deployment qualification | `node scripts/qualify-deployments.mjs --mock`: **PASS** | 5-point qualification protocol passes offline for streaming, toolCalling, toolContinuation, cancellation, and usageAccounting. |
| Packaged runtime | `pnpm package:dir` & `pnpm smoke:package`: **PASS** | Built `release/win-unpacked`. Packaged Electron/SQLite v2 runtime: coding and coordinated workflows, 14 bound approvals, 3 cherry-picks, compaction, MCP demo via unpacked Job Object host, diagnostics export, and clean worktree retirement. |
| Production installer | `pnpm package:win`: **PASS** | Built `release/Foundry Agent Workspace Setup 0.2.0.exe` (115.63 MB) and blockmap. |
| Clean installer audit | `powershell -File scripts/verify-clean-install.ps1`: **PASS** | 6 passed, 1 expected signature warning (unsigned candidate), 0 failed. Verifies artifact presence, unpack manifest, path containment, and uninstall safety. |
| Desktop user paths | `pnpm test:e2e`: **7 passed (2.7m)** | Chat, Coding, coordinated workflows, scoped cancellation, IPC forgery rejection, legacy v1 database upgrade, compaction, MCP approval, diagnostics export, and worktree retirement. |
| Independent review | Completed across all 4 workstreams; all security and qualification findings addressed on `main`. | Independent review by Claude Opus 5 on security/IPC and Claude Sonnet on qualification/packaging. |

---

## Phase 04 — Context and external tools

Recorded 18 September 2026 (America/Chicago) on branch `agent/claude/phase-04-context-and-tools`, merged to `main` at `db08e16`. Owner: Claude (Fable 5.1) as Lead Systems Engineer under Antigravity's assignment in `TASK_PHASE_04.md`.

### Delivered

- **Controlled compaction.** `task.compact` (header and Usage-panel button) summarizes older complete turns into a runtime-generated, bounded, secret-screened structured summary that is labelled as data and never produced by a model or from repository text. The summarized range, message ids, estimates before/after and the provider state before/after are retained in the additive `compactions` table; the original messages are never deleted and the transcript keeps them dimmed beneath the summary. Provider-native continuation is compacted shape by shape (Responses `input`, Chat Completions `messages`, Anthropic `messages` + `system`): the cut is placed only at a plain user turn, so system/developer items, complete tool-call/result units, opaque reasoning and signature blocks and the pending tail (calls awaiting results) survive; Anthropic histories still start with a user turn. Every candidate is validated against a per-shape Zod schema plus call/result pairing before anything is persisted; an invalid result throws and leaves the task unchanged. Automatic warnings (`task.context-warning`) fire once per turn when the conservative reservation reaches 80% of the profile context limit; the previous "compaction is not available yet" limit error now points at compaction. Compaction is refused while a response is active or a task is retired.
- **MCP under the same policy.** `mcp.save/list/remove` configure stdio servers by absolute `.exe` command, arguments, optional working directory and a restricted environment (credential-like and reserved names refused, secret-like values refused at configuration). Saving launches the server once through `mcp-host.ps1`, a kill-on-close Windows Job Object host that verifies the runtime parent, lets the server inherit the runtime's pipes directly, terminates the job on cancellation, lifetime expiry or parent death, and writes a nonce-bearing result once the job is verified empty. Tool listings are bounded (128 tools, 1 KB descriptions, 16 KB schemas, provider-safe names) and stored; coding tasks advertise them as `mcp__key__tool`. Only tools on the user-managed read-only allowlist run within policy; every other call creates a one-shot approval bound to the exact screened arguments (`Approval.mcp`). Server annotations are shown as hints only. Arguments and results are secret-screened; results are bounded to 64 KB with head/tail excerpts; a timeout or broken transport after the request was sent marks the approval **unknown**, stops the server, and is never replayed. Servers idle-stop after two minutes and are terminated with their descendants on runtime shutdown.
- **Usage visibility and diagnostics.** Every provider reservation is recorded in the additive `usage_records` table with prompt, completion, cache-read and cache-creation tokens (Anthropic cache fields and OpenAI `cached_tokens` are now surfaced by the adapters) or, when usage is unknown, the retained reservation and its reason. `task.usage` returns the burndown, the conservative next-request estimate against the context limit, totals and the compaction history; the Usage panel renders it. `diagnostics.export` writes a sanitized JSON bundle (profiles without credentials, task and usage summaries, approval metadata without before/after/patch/command text, MCP configuration without environment values, bounded recent events) through the redactor and refuses to write if secret-like content remains.
- **Explicit commit/push and safe retirement.** `task.commit`, `task.push` and `task.retire` exist only as user actions in the Publish panel; no tool proposes them. Commit stages every change except secret-named paths (index reset if one slips through), runs with hooks disabled and no signing, and uses the user's Git identity. Push targets a remote configured in the project repository, never forces or prompts, and is the only Git action that may use the user's credential helper. Retirement checks every worktree of the task (children included for coordinated roots) read-only first, refuses when any has uncommitted or untracked files, then removes them with `git worktree remove` without `--force`; the branch, commits, history and evidence remain and the task becomes `retired`. Each action records an intent first and marks it unknown on an ambiguous failure.
- **Worktree creation race.** Concurrent `git worktree add` calls in one repository raced on Git's worktree metadata (observed as a pre-existing flake in `coding.test.ts`); creation is now serialized per repository.

### Validation (owner-run)

| Boundary | Evidence | Scope |
| --- | --- | --- |
| Types, lint, tests | `pnpm check`: **19 files, 192 tests passed (clean typecheck and lint)** | Prior suites plus compaction shapes/validation (unit), MCP JSON-RPC client bounds (unit), compaction integration with a real Chat-Completions-shaped continuation, MCP integration through the real Job Object host and fixture server (allowlist vs approval, rejection, redaction, truncation, timeout as unknown outcome, descendant termination on shutdown), commit/push/retire/diagnostics integration against a bare remote, creation-race regression, and all 6 post-review regression tests (tool outcome blocking, MCP EPIPE handling, store recovery reservation reset, commit exact identity verification, push ancestry verification, startTurn intent blocking). |
| Desktop user paths | `pnpm test:e2e`: **7 passed** | Prior Chat, Coding and coordinated paths plus a Phase 04 flow: chat compaction with the summary rendered, MCP server configured from settings with the read-only allowlist, `/mcp-demo` stopping at the write_note approval ([screenshot](mcp-approval-screenshot.png)), diagnostics export scrubbed of a credential canary, explicit commit, and retirement of a clean worktree. |
| Packaged runtime | `pnpm package:dir` and `pnpm smoke:package`: **passed** | Packaged Electron/SQLite runtime: prior coding and coordinated flows plus compaction, the MCP demo through the unpacked `mcp-host.ps1`, diagnostics export, and commit/retire. |
| Independent review | Completed; all initial Sonnet findings plus all 6 subsequent Codex/GitGuardian review findings addressed on commit `81dbd83` and re-verified. | Independent reviews covering security, persistence, Git publication, IPC and QA coverage closed with zero remaining findings. |

Logs are in `.local/validation/` of the implementation worktree (`phase04-check.log`, `phase04-e2e.log`, `phase04-package.log`, `phase04-smoke.log`).

### Independent review findings

Two bounded, read-only Sonnet reviewers (below the Fable owner; neither authored the code) reviewed the diff against `main` before the initial validation cycle. Subsequent automated Codex review and GitGuardian scanning on PR #2 identified 6 additional findings that were remediated on commit `81dbd83`.

Security, persistence and IPC review:

- **P1 fixed.** `task.commit` ran `git add --all` without re-checking Git filter attributes, so a `.gitattributes` edit made through an ordinary reviewed file change could have run a clean filter with the user's privileges during the explicit commit. Commit now re-checks every tracked path and every path about to be staged and refuses when a `filter` attribute is present (regression test in `publish.test.ts`).
- **P2 fixed.** The MCP host launched the server with `bInheritHandles` and no handle list, so any inheritable handle open in the PowerShell host could have reached the server. The host now uses `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` so exactly the three standard handles are inherited.
- **P2 fixed.** Environment-name screening for MCP servers was a short substring list; segment names such as `AUTH`, `KEY`, `PASS`, `PAT`, `PWD`, `SESSION` and `SIGNING` plus `bearer`/`private`/`passwd` are now refused, and the settings copy states that values are stored in plain text and that screening is best-effort.
- **P3 fixed.** The host's `cleanupVerified` result was discarded; an unverified stop is now surfaced as the server's status note (visible in settings and diagnostics).
- **P3 accepted.** The retire dirty-check and removal are two steps; Git's own refusal to remove a dirty worktree without `--force` covers the window, and a race fails loudly rather than deleting files.
- Verified sound: allowlist-only execution authority (annotations never used for policy), command/cwd/environment validation, parent verification and job termination paths in the host, JSON-RPC bounds and refusal of server-initiated requests, unknown-outcome classification, compaction validation and atomic persistence, diagnostics redaction and field selection, no-force push and app-owned-path checks for removal, and Zod validation of every new RPC in both main and runtime.

Codex and GitGuardian post-PR review findings (closed on commit `81dbd83`):
- **Finding 1 fixed (Git publication safety):** `publishable()` in `packages/runtime/src/workspace-operations.ts` explicitly rejects `task.commit` and `task.push` when any tool approval in the task is in an `unknown` state.
- **Finding 2 fixed (MCP transport error handling):** `McpClient` in `packages/runtime/src/mcp.ts` registers an output error listener on stdin, catches synchronous and asynchronous `Writable.write()` transport errors (e.g. `EPIPE`), and classifies in-flight calls as durable `unknown` outcomes rather than crashing Node.
- **Finding 3 fixed (Reservation atomicity & store recovery):** `legacyHooks.reserve` persists `status: 'running'` atomically with token holds; `store.recover()` resets unstarted holds on idle tasks with 0 messages to 0 tokens without wiping historical usage.
- **Finding 4 fixed (Commit identity verification):** `verifyCommitOutcome` in `packages/runtime/src/repository.ts` & `workspace-operations.ts` verifies exact commit identity (`HEAD^ == baseCommit` and commit message match) before declaring success; discarding staged changes without committing is identified as failed.
- **Finding 5 fixed (Push ancestry verification):** `verifyPushOutcome` in `packages/runtime/src/repository.ts` runs `git merge-base --is-ancestor` when remote tip differs, returning `undefined` (inconclusive / remains unknown) if ancestry cannot be proven.
- **Finding 6 fixed (Turn execution fencing):** `startTurn` in `packages/runtime/src/service.ts` blocks `task.send` while `unknownRetireIntents` or `unknownPublicationIntents` remain unreconciled.
- GitGuardian security scan passed with 0 secret leaks or vulnerabilities detected.

QA and coverage review (added as regression tests): compaction refused while a mutation outcome is unknown; retirement/commit/push refused on a coordinated root with non-terminal runs; a pending MCP approval is revoked when the runtime stops and the interrupted call is answered with an error rather than replayed; the unknown-usage accounting path (`unknownRequests`, `reservedUnknown`); a specific assertion for a server that fails to start; the push confirmation token asserted as a schema rejection. Accepted without tests: idle/lifetime timers (time-based), push over HTTPS without a helper (network), and coordinator/child compaction beyond the fixed system-item guarantee.

### Known limits of this increment

- Summaries are deterministic excerpts, not model-written prose; a summarized turn loses detail, which is why the originals stay in the transcript. Compaction is manual; the runtime only warns automatically.
- Coordinated roots and children can be compacted while idle, but their long-lived coordinator brief is a system item and therefore always retained; there is no separate compaction of orchestration records (assignments and results live in SQLite, not in context).
- MCP tool schemas are passed to providers as supplied by the server (bounded, redacted, not validated as JSON Schema); argument validation against the schema is left to the server. Only stdio servers are supported; HTTP/SSE transports, sampling, roots and elicitation are refused. MCP tools are advertised to single-agent coding tasks only.
- The MCP host inherits the same PowerShell/C#-compilation requirement as the command helper and adds roughly one second of startup per server launch.
- Push relies on the user's credential helper or SSH agent; there is no in-app credential prompt. Commit uses `git add --all`, so intentionally untracked scratch files must be ignored or removed first.
- `retired` is recorded in the task JSON; the additive Phase 04 tables are created with `IF NOT EXISTS` on open rather than through a numbered schema version, so an older build ignores them and a newer one reads them without migration.

---

## Local task-branch integration — 17 September 2026

Claude's completed `3a45143` branch was merged without conflicts into `agent/codex/foundation/foundry-agent-workspace` at `aa524c9bb62f26a709f5d791c9bab7fa0fdb9bcc`. Application source matches the independently reviewed final Claude branch; the extra change is the comprehensive HTML progress section. Subsequent documentation commits do not change application code.

Codex reran the required checks in this checkout: `pnpm check` passed (145 tests, clean typecheck/lint); `pnpm test:e2e` passed (6 tests); `pnpm package:dir` exited 0; `pnpm smoke:package` passed (14 bound approvals, at most two active children, three serial integrations and exact-tree validation). Full logs: `.local/validation/integrated-check.log`, `integrated-e2e.log`, `integrated-package.log`, `integrated-smoke.log`.

Packaged `resources/app.asar` SHA-256: `ba77f180c5a2c1f1cd0342c62f926cd95cde7a82f747988fa611820371752bb0`.

Rudy authorized push, PR and merge. Publication remains blocked because this repository has no configured remote/default branch; destination requested. This local task-branch merge is not a remote/default-branch merge. No PR URL, CI result, live Foundry qualification, signed installer or deployment is claimed. The historical evidence below retains its original source and scope.


## Coordinated orchestration increment

Recorded 17 September 2026 (America/Chicago) on private branch `agent/claude/coordinator-orchestration`, a direct descendant of `f75d1ed` (0.2.0). This implements the [approved coordinator plan](coordinator-orchestration-plan.md). It is a local engineering build, not full v1 acceptance. Validated code commit: `3e5385e316248802296764ec10b01d0dae442cd8`; a following documentation-only commit records this evidence.

### Delivered

- Explicit `coordinated` task mode. Chat, Coding and records without `mode` keep their previous behavior; child agents never appear as top-level tasks and `task.send`/`task.cancel` on a child are rejected before any provider or repository activity.
- SQLite schema v2: immutable assignments (at most eight revisions per task), depth-one agent runs with generation fencing, at most two admitted nonterminal children, dependencies, budget holds/reservations/settlements, deliver-once waits, handoff and integration operations, validation evidence and completion records. Database triggers enforce immutability, no resurrection, no reversal of fencing and retention. New databases start at v2. An existing v1 database opens unchanged; the desktop banner performs a separately confirmed upgrade that first creates a WAL-aware SQLite backup, verifies it (integrity, version, row counts), then migrates in one transaction. Rollback means opening the retained v1 backup with 0.2.0; v2 is never downgraded in place.
- Aggregate budget authority: charged, in-flight, unused child holds and unallocated funds reconcile to the cap; 20% of the cap is protected for the coordinator; holds convert to reservations without double counting; settlement is idempotent; interrupted or unknown usage is retained in full; overruns are recorded and block admission.
- Bounded scheduler: round-robin admission across tasks, the shared three-slot limit plus a two-request per-profile limit for coordinated runs, excess assignments unprovisioned with no worktree or hold, and dependent children admitted only after predecessors are integrated and the required combined validation passed on the current HEAD/tree. Dependencies resolve through assignment revisions.
- Native coordinator tools (`delegate_assignments`, `await_children`, `integrate_result`, `complete_task`) and child tools (`commit_handoff`, `submit_handoff`) with role policy enforced at the runtime boundary. The coordinator waits without an execution slot and receives one bounded, redacted result per child. Child prose is labelled as an untrusted claim.
- Scope policy: segment-aware, Windows case-insensitive read/write scopes; overlapping concurrent write scopes are rejected; `.git`, `.gitmodules`, `.gitattributes`, secret names, reserved names and traversal are denied; scope is enforced before file access and rechecked at commit and integration.
- Typed Git operations with a sanitized environment (every inherited `GIT_*` variable stripped): exact-base child worktrees (filter attributes read from the base tree), one reviewed handoff commit per assignment (literal staging, blob/mode verification, `write-tree`/`commit-tree`/compare-and-swap `update-ref`), canonical effect manifests, serial `cherry-pick --no-edit -x` integration verified by parent and exact effect, preserved conflicts continued only with a newly approved resolved index tree, distinct blocked empty outcomes, and read-only reconciliation of unknown worktree creation, handoffs and integrations. Nothing resets, aborts, skips, cleans or deletes worktrees.
- Bound approvals: every coordinated approval binds root, target agent, assignment revision, generation and fingerprint and is decided only through `orchestration.decide`; stale or sibling decisions fail. Validation evidence binds the exact command, working directory, timeout, HEAD, tree, clean state and verified cleanup; commands with model-supplied environment changes never count as validation. Completion requires every assignment integrated, no pending/unknown effect or conflict, a clean task worktree and passing combined validation on the exact current tree.
- Scoped cancellation (child or whole task, fenced durably first) and restart recovery that never resumes paid inference or mutations: reservations are retained, approvals revoked, in-flight Git operations marked unknown, and explicit Resume reconciles read-only, starts only never-started children and delivers a recorded wait once.
- Desktop: upgrade banner, coordinated task creation (child profiles, required validation command, budget), agent tree, aggregate budget and completion header, per-child read-only detail and assignment, bound approval cards with target labels and patches, orchestration tab (assignments with revision, results, integrations with check/continue, evidence, events), scoped cancel controls. The deterministic offline `/orchestrate-demo` fixture exercises two independent children and one dependent child.

### Validation (owner-run on `3e5385e`)

| Boundary | Evidence | Scope |
| --- | --- | --- |
| Types, lint, tests | `pnpm check`: **14 files, 145 tests passed** | 83 prior tests plus schema/upgrade/budget/constraints (15), scope (4), execution slots (2), Git operations (27) and orchestration integration (14) using real temporary Git repositories, SQLite and Windows commands with injected providers. |
| Desktop user paths | `pnpm test:e2e`: **6 passed** | Prior Chat and Coding paths; full coordinated workflow through rendered approvals with real commits and restart; scoped child and root cancellation; IPC forgery rejection; v1 database with legacy history upgraded through the banner. |
| Packaged runtime | `pnpm package:dir` and `pnpm smoke:package`: **passed** | Packaged Electron/SQLite v2 runtime: prior coding demo plus coordinated workflow with 14 bound approvals, at most two active children, three serial cherry-picks, combined validation on the exact final tree, source repository unchanged. `resources/app.asar` SHA-256 `ba77f180c5a2c1f1cd0342c62f926cd95cde7a82f747988fa611820371752bb0`. |
| Independent review | Three read-only reviewers, none an author; fixes re-verified by the Git and QA reviewers | Security/IPC/credentials/persistence: one P2 (evidence environment binding) fixed. Git operations: two P1 (base-tree filter check, inherited `GIT_*`), one P2 (embedded repositories), one P3 fixed. QA/data integrity: one P0 (unknown worktree creation), one P1 (revisions orphaning dependents), one P2 (wait on unadmittable assignment), P3s fixed. Each fix has a regression test. |

Logs are in `.local/validation/` of the implementation worktree (`final-check.log`, `final-e2e.log`, `final-package.log`, `final-smoke.log`, plus earlier `check-orchestration-*.log`). No live Azure request, CI run, remote publication, installer build, signing or clean-profile installation is claimed for this increment.

### Known limits of this increment

- Actual model-family qualification of the coordinator/child tool loop against real Foundry deployments is open; only injected transports and the offline fixture were exercised.
- Git 2.40 or newer is required (`check-attr --source`); older Git fails closed with a generic Git error.
- An unknown worktree creation, handoff or integration that reconciliation cannot prove stays blocked for manual inspection; there is no automated adoption or cleanup.
- Worktree-creation crashes were exercised by injected failures, not by killing a real process mid-operation. Deletion-guard triggers are asserted only for child results.
- Commands still run with the user's Windows privileges; scopes are checked on Git-visible changes, not enforced on process behavior.
- The main-process frame/origin check is exercised only for main-frame IPC; a subframe sender is not separately tested.
- The coordinator composer remains visible on a completed task (the runtime rejects the send), and the child-profile fieldset legend overlaps its border.

---

# Earlier increment — reviewed coding tools

Recorded 17 September 2026 (America/Chicago), version 0.2.0. This is a local engineering build, not full v1 acceptance. The [original plan](foundry-agent-workspace-plan.html) remains the product baseline. Foundation commit: `6bbaef8`.

## Delivered

- Electron/React desktop, typed private JSON-RPC, supervised runtime, SQLite WAL history, OS-backed credential vault, explicit Azure profiles, and task-owned Git worktrees.
- Separate Chat and Coding modes. Real coding requires successful text, usage, cancellation, tool-call, and continuation qualification. The built-in `/demo` fixture performs a read, proposes a README edit, then proposes a harmless command without network access.
- Native Responses, Chat Completions, and Anthropic tool loops. Complete validated calls execute only after provider completion. Opaque reasoning/signatures remain outside renderer history. Tool results and native continuation survive restart; interrupted calls are never replayed.
- Bounded directory listing, literal text search, file reads, tracked/untracked diff inspection, and existing-file replacement with exact SHA-256 preconditions. New-file creation through the file tool is deliberately disabled because a safe Windows directory-relative primitive is not implemented.
- One-shot edit/command approvals bound to task, nonce, and exact proposal. File review includes before/after content and hashes. Command review includes script, canonical directory, fixed shell, environment, timeout, and worktree fingerprint. Stale and replayed decisions fail closed.
- Durable intent before mutations. Restart revokes unexecuted approvals and marks executing actions unknown. File reconciliation compares hashes read-only. Unknown command effects remain blocked in that task and are never treated as successful or automatically retried.
- Windows command supervision: suspended creation, Job assignment before execution, kill-on-close, cancellation/timeout, parent-process death monitoring, bounded output, minimal environment, and explicit cleanup evidence. Background descendants are terminated before completion. Commands run with the user's Windows privileges; approval and worktrees are not a sandbox.
- Three shared model/command slots; approval waits consume no slot. Conservative per-request reservations include tool schemas and native context. Turns stop at context/budget limits or 50 tools, retaining their work and evidence.
- Approval/history UI, rejection/cancellation, retained evidence after restart, and a per-user Windows installer candidate. [Reviewed approval screenshot](coding-approval-screenshot.png).

## Validation

The final local candidate passed the combined checks below. No live Azure request, CI run, remote publication, production deployment, or clean-profile installation is claimed.

| Boundary | Evidence | Scope |
| --- | --- | --- |
| Types, lint, tests | `pnpm check`: **83 tests passed** | TypeScript and ESLint pass. Isolated Git/SQLite fixtures, injected provider transports, and actual Windows process lifecycle tests. |
| Desktop user paths | `pnpm test:e2e`: **2 tests passed** | Chat/settings/history path plus Coding `/demo`: rejection leaves content unchanged; exact approved edit and command succeed; source stays clean; restart preserves evidence. |
| Process crash | Command-runner integration host | Kills the owned Node runtime host and verifies both root and child command PIDs terminate. |
| Packaged runtime | `pnpm package:dir` and `pnpm smoke:package`: **passed** | Actual packaged Electron/SQLite, approved edit, unpacked Job helper, verified command cleanup, and unchanged source fixture. Smoke ran against the final package produced by the installer build. |
| Installer candidate | `pnpm package:win`: **passed** | `release/Foundry Agent Workspace Setup 0.2.0.exe`. Authenticode reports **NotSigned**. Build success is separate from clean installation and signing. |
| Dependencies | `pnpm audit`: **zero reported vulnerabilities** | Current registry result; no new production dependency was added for this increment. |
| Independent review | Three bounded specialists and owner integration | Provider fidelity, approval/persistence/recovery, filesystem protection, and Windows lifecycle findings addressed; full v1 review remains open. |

Validation logs are retained in `.local/validation/` (ignored by Git). `check-coding.log`, `e2e-coding.log`, `package-coding.log`, `packaged-smoke-coding.log`, and `audit-coding.json` identify this increment.

Final SHA-256 fingerprints:

- Installer: `9b26166d7583942b03050d1a72fa262fb5ba8f4427fb607d18fa4893c9ec4a5b`.
- Packaged `resources/app.asar`: `d0f6262ef4875aacde8af4d4584676ea38fae45f71f08047dcf533184b8dd534`.

## Important review findings closed

- Prevented new-file creation through an unsafe Windows parent-directory race; existing edits reject stale hashes, symlinks, hard links, and protected paths.
- Withheld untracked diff content when a tracked sensitive deletion could disguise a secret rename.
- Rejected forged/replayed/stale approvals, revoked waiting decisions on cancellation/restart, and distinguished known preflight failures from unknown mutation outcomes.
- Screened full provider state before persistence and kept native reasoning/signatures away from the renderer. Rejected repeated historical tool-call IDs.
- Made command preparations one-shot; refreshed worktree/shell/spec fingerprints before launch; discarded unused preparations.
- Fixed runtime-parent death, suspended-process assignment failure, helper environment, cancellation timing, background pipe holders, and unpacked helper resolution.
- Disabled OpenAI strict-schema mode for dynamic runtime tool schemas while retaining independent Zod validation.
- Rejected malformed terminal ordering, missing stop reasons, unfinished Anthropic blocks, negative/fractional usage, and mismatched authoritative Responses output.
- Capability probes now verify a random value supplied only through a fixture tool result. A failed fresh probe invalidates prior verification.

## Plan progress and remaining gates

| Plan stage | Actual position |
| --- | --- |
| 00 — Foundation verification | Local toolchain, native SQLite, package and installer path established. Actual Foundry deployment/authentication qualification remains open. |
| 01 — Desktop, state, isolation | Core local paths implemented and exercised. Large-history ergonomics and worktree-creation reconciliation remain. |
| 02 — Single-agent coding | Reviewed edits/commands, native tools, provider continuation, durable decisions, cancellation and conservative recovery implemented. Live model-family qualification remains open. |
| 03 — Coordinator/specialists | Implemented, independently reviewed, and merged to `main` at `70d0a0c`. Live model qualification remains open. |
| 04 — Context/external tools | **Delivered & validated on main (`db08e16`).** Implemented on branch `agent/claude/phase-04-context-and-tools` (commit `81dbd83`, PR #2): controlled compaction, MCP under approval policy, usage/diagnostics, explicit commit/push and safe retirement. 192 unit/integration tests, 7/7 E2E tests, package build and packaged smoke pass. Merged to `main` at `db08e16`. |
| 05 — Windows release | **Delivered & validated on main.** Parallel multi-agent delivery across 4 workstreams (Claude Opus 5 for security/IPC audit, Claude Sonnet for qualification framework & clean installer, Antigravity for recovery & evidence). Product-wide security audit suite (`tests/integration/security-audit.test.ts`), 5-point deployment qualification framework CLI (`scripts/qualify-deployments.mjs`), NSIS production installer build (`Foundry Agent Workspace Setup 0.2.0.exe`, 115.63 MB), clean installer audit script (`scripts/verify-clean-install.ps1`), recovery runbook (`docs/recovery.md`), Authenticode guide (`docs/signing-and-distribution.md`), and release evidence matrix (`docs/release-evidence.md`). 21 test files, 228 automated tests pass, 7/7 E2E tests pass, packaged smoke passes. |

All primary implementation phases (Phases 00 through 05) are delivered, merged, and validated on `main`.

Open qualification: live user-selected Azure Foundry deployment qualification via `scripts/qualify-deployments.mjs` with production credentials, production Authenticode certificate signing for Windows SmartScreen reputation, and distribution/license notice review. Routine automated test suites run 100% offline without discovering credentials or making paid probes.

## Practical limits

- Buffered response text appears after whole-response screening. A hard crash can lose the current in-memory fragment; prior messages and conservative reservations survive. Local cancellation does not prove server-side cancellation or billing cessation.
- Unknown worktree creation blocks further task creation. Preserve the recorded branch/path/registration and inspect the SQLite intent; automated adoption is not implemented.
- Unknown command effects require inspection. Read-only reconciliation cannot infer external effects or manufacture a missing exit/cleanup result. Create a separate task only after retaining and investigating the affected worktree.
- History pagination/export, compaction, remembered approvals, automatic runtime restart, provider fallback, updating, browser tools, scheduling and cloud hosting are absent. RPC/history limits fail visibly without deleting retained history.
- The runtime uses Git HEAD when creating worktrees; source uncommitted changes are preserved in the source checkout and are not copied. No implicit fetch, commit, push, PR, merge or worktree deletion occurs.
- Secret screening and same-user filesystem checks are defense in depth. Commands can act outside the worktree with the approved user's rights. Windows Job cleanup is not a security sandbox or proof that every external side effect was undone.
- This earlier increment used schema version 1. The orchestration increment introduces v2 with an explicit, backed-up upgrade.
- Command freshness checks currently fingerprint at most 10,000 files / 64 MiB of worktree content and reject larger trees, including large dependency folders. Commands start with a Windows-only PATH; use an explicit developer-tool path or set PATH in the reviewed script. Broader developer-tool discovery and scalable fingerprints remain usability work.

## Ownership and routing

All work remains on private local branch `agent/codex/foundation/foundry-agent-workspace`; no remote is configured. The owner integrated and validated the product. Three bounded agents were selected using Rudy's `AGENTS.md` and workflow-router guidance, each **GPT-5.6 Terra / medium**, below the parent route:

| Agent | Bounded implementation | Independent review |
| --- | --- | --- |
| `providers` | Native provider adapters, probes and transport tests | Runtime continuation and command runner |
| `desktop_ui` | Renderer approvals, coding E2E and screenshot | Repository/filesystem, approvals and provider/command boundaries |
| `repository_tools` | Windows Job helper, command runner and crash fixtures | Runtime persistence, budgets, approval ordering and recovery |

Agentcoord bridge health succeeded, but session registration remained unavailable; no durable claims were acquired. Explicit built-in agent messages separated file ownership on this owned local branch. No external messages or publication occurred.

Primary implementation references: [Foundry Responses](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses), [Anthropic tool results](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls), [Anthropic extended thinking](https://platform.claude.com/docs/en/about-claude/models/extended-thinking-models), and [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects). Documentation is not evidence of compatibility with a specific deployment.
