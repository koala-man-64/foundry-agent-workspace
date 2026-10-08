# Implementation status

## WPF + WebView2 migration — phase P0 in progress

Recorded 8 October 2026. The [migration plan](wpf-webview2-migration.md) replaces Electron and Node with three parts, delivered in a single cutover:
- a WPF host on .NET 10;
- WebView2 hosting the existing React UI;
- a C# runtime.

**No product behavior has moved.** The Electron application and the TypeScript runtime remain the product and the behavioral authority.

P0 deliverables so far:
- The approved plan (#12).
- The .NET solution skeleton (`Foundry.slnx`): the seven projects of the plan's layout, with placeholder entry points that exit non-zero; `global.json` (SDK 10.0.300, no roll-forward); central package management; lock files restored in locked mode in CI; nuget.org-only source mapping; NuGet audit with warnings as errors.
- Culture-sensitive string analyzers (CA1304, CA1305, CA1309, CA1310, CA1311) as errors.
- `BannedSymbols.txt` enforcing the runtime loop model. Each of its 41 entries was shown to fire with a temporary probe.
- `Foundry.Architecture.Tests` enforcing the dependency graph and trust boundaries. Injected violations were shown to fail.
- The `.NET build` workflow: locked restore, build with warnings as errors, and test on every pull request.
- Golden vectors (`tests/golden`) that pin TypeScript behavior for the port: `JSON.stringify` edges and hashes, both profile fingerprints, UTF-8-ordered handoff manifests, schedule gaps and folds, redaction regex semantics, and MCP admission. The RPC corpus covers 99 schemas (RPC methods, bridge channels and non-RPC frames) with 4,149 seeded and mutated cases and zod's verdicts, plus 15 wire-level parser cases. The unit tests fail on drift. `scripts/golden-path-key.mjs` mirrors `pathKey` for machine-local cross-language checks and is proven equal to the runtime's.

Next: fixture databases, the trace recorder, the zod-free limits module, and spikes S1–S10.

These program rules hold until the P5 cutover:
- Protocol and runtime features are frozen, except the planned P4 deltas: adoption RPCs and removal of the JavaScript script language.
- Security and data-loss fixes land in both implementations and are listed below.
- The .NET runtime never opens the real data directory before adoption.

Dual-landed fixes: none yet.

| Seat | Model / effort | Selection source | Routing reason |
| --- | --- | --- | --- |
| Architecture and delivery (`architecture-review-agent`) | Sonnet / high | Agent definition frontmatter | Independent architecture view; parallel reading of main, protocol, runtime and providers |
| Security (`cloud-security-vulnerability-expert`) | Sonnet / high | Agent definition frontmatter | Required independent review for credential, IPC, filesystem and process changes |
| Data integrity and concurrency (`db-steward`) | Sonnet / high | Agent definition frontmatter | In-place adoption and the Node-to-.NET concurrency model carry the highest-consequence risk |

The owner (Claude Opus 5.5, max effort) chaired two review rounds and kept the test strategy and synthesis. The owner also verified the disputed facts, for example the CDP `grantUniveralAccess` spelling and that `setCredential` clears profile verification. The review produced a plan, not an implementation; its acceptance criteria are not evidence that any migration phase exists.

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
- **Disaster recovery runbook.** `docs/recovery.md` documents operational procedures for: read-only reconciliation of unknown commit, push, and worktree retirement intents; SQLite database integrity verification (`PRAGMA integrity_check`) and WAL checkpointing; rolling back schema upgrades from automatic `.bak` backups; resolving and adopting coordinator cherry-pick merge conflicts in external editors; and rotating credentials in Electron `safeStorage`.
- **Release evidence matrix.** `docs/release-evidence.md` tabulates all 9 release acceptance criteria from Section 07 of the plan against exact automated test suites, commit citations, and verification artifacts.

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
