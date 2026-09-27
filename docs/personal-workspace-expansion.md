# Personal workspace expansion

Implementation contract, 27 September 2026. This extends the [product baseline](foundry-agent-workspace-plan.html) for [Foundry Agent Workspace](https://github.com/koala-man-64/foundry-agent-workspace). [Implementation status](implementation-status.md) records validation separately from this design. Historical test results do not qualify this increment.

## Operating model

The renderer presents bounded records. Electron main validates IPC senders, mediates credentials and native notifications, and supervises the runtime. The runtime remains the sole SQLite writer and repository execution authority. Providers retain their native continuation and compaction behavior. Repository text, model output, event records, templates, exports and script output never confer execution authority.

Archive changes conversation visibility. It does not stop inference, dismiss approvals, release reservations, retire worktrees or resolve uncertain effects. A coordinator and its children archive as one grouping; children remain inspectable. **Retire worktree** is a different, explicit operation. Inbox obligations survive archiving and restart. A read marker cannot resolve an obligation.

Commands and trusted scripts run with the user's Windows privileges. Approval, worktree isolation, path screening and event scopes are not operating-system sandboxing.

## Stage 0: repair and access

- Coordinator, child and ordinary task conversations use the shared transcript component, including response states, errors, retained messages and compaction annotations.
- MCP input, editable configuration and status are separate contracts. Disabled and failed configurations receive the same structural and sensitive-value checks as enabled ones. Status omits raw arguments and environment values. Toggle, reconnect and allowlist updates resolve canonical configuration inside the runtime.
- Legacy unsafe MCP configuration is disabled and logically sanitized after a verified backup. A repair notice explains why execution is unavailable. The backup is retained for recovery; sanitization does not claim erasure of old WAL, free pages or external copies.
- The responsive inspector becomes an accessible drawer, with keyboard dismissal and focus return. Approvals, recovery, usage and publication remain reachable at narrow sizes and zoom.
- Routine E2E screenshots go to ignored test artifacts. `pnpm docs:screenshots` explicitly copies the selected artifacts into documentation. Assurance claims describe tested cases and never promise universal absence of leaks.

## Stage 1: history, archive and Inbox

Navigation exposes Inbox, Recent, All tasks and Archived, with a collapsible creation form. Filters cover project, mode, execution status, archive visibility and dates. Search indexes redacted task titles and retained user-visible messages; child results retain coordinator identity.

History uses deterministic creation identity and an initial high-water mark. Recent is a separate refreshed view. Message pages use durable ordinals; oversized messages provide marked excerpts and explicit complete-content chunks. Cursor identity includes the filters. Pages default to 50 records and use serialized byte budgets below 256 KiB. Streaming progress is transient and does not become a history reload event. View refreshes coalesce while a request is in flight.

Inbox is derived from canonical approvals, intents, coordination records, validation and drafts, including archived work. Needs decision precedes In progress, then Recent outcomes. Links open the exact target and supporting records. Summary cards neither approve nor retry. A failed Inbox query displays an error, retains task-navigation access to archived active work and disables further archiving until visibility recovers.

## Stage 2: evidence and recovery

- **Activity:** durable events and exact task/evidence references, including legacy-event provenance.
- **Coordination:** bounded SVG dependency graph plus accessible list/table information, assignment revisions, lifecycle, integration and validation state. Unknown and absent evidence remain distinct.
- **Usage:** observed tokens, held reservations, unknown usage, cache fields and context estimates remain separate, with task/profile/day breakdowns. No inferred completion percentages or dollar pricing.
- **Recovery:** interrupted/unknown operations and retained reservations link to the existing supported reconciliation controls. A chart cannot authorize replay.
- **Notifications:** opt-in native notices for actionable decisions, completion/failure and reminders. Notifications contain generic text rather than conversation or tool payloads. Clicking opens the recorded task. Durable Inbox remains authoritative when the app was closed or the OS did not display a notice.

## Stage 3: templates, rules and trusted scripts

Templates are local presets for prompt, mode, profile, budget, scope and validation requirements. The resulting task is previewed before creation. Templates contain no credentials, approvals, grants or pending execution.

Built-in rules select named lifecycle events and validated task/project conditions, then produce labels, notices, follow-up prompt drafts or typed application-action drafts. Preview is side-effect-free. Enabling starts at the current event cursor. Delivery history and unique event/revision identities prevent duplicate derived results. Streaming, hook-origin decisions, hook execution and draft/schedule events are excluded from recursive triggering.

### Distinct reusable permission

Custom `.ps1` and `.js` scripts are copied into application-managed immutable revisions. `.ps1` uses Windows PowerShell; `.js` uses the application's bundled Node runtime. A grant binds the revision/hash, interpreter identity/hash, arguments, working-directory policy, event types, project scope, allowed input fields and all limits. Changing a bound field requires a new grant. New revisions are untrusted and disabled.

PowerShell snapshots include a runtime-added UTF-8 BOM so Windows PowerShell 5 reads the reviewed source faithfully. The launcher sets UTF-8 input/output encodings and preserves the script's exit status. Its version/hash is included in the configuration pin; older incompatible PowerShell revisions require registration and review of a new revision. Source review omits the transport BOM while verifying the exact pinned snapshot bytes.

PowerShell arguments support literal values and simple `-Name` parameter tokens; unsupported complex dash syntax fails before launch. PowerShell error output prevents acceptance of drafts, even if a script emits valid JSON afterward.

| Control | Default / limit |
| --- | --- |
| Grant lifetime | 30 days |
| Allowance | 100 runs per rolling 24 hours |
| Timeout | 30 seconds; maximum 120 seconds |
| Concurrent scripts | 1 |
| JSON stdin/stdout | 64 KiB each |
| Diagnostic stderr | 16 KiB |
| Returned drafts | At most 10 |

The trust screen explains full Windows user privileges. Pinning the entry file does not freeze imported code, external programs, network responses or files it reads. Event scope controls supplied data, not filesystem/network access.

The hook launcher provides a dedicated one-shot bounded JSON protocol, reusing the existing Windows Job Object supervisor (`mcp-host.ps1`) for descendant cleanup. It does not reuse the command runner's closed-stdin protocol. Dispatch persists a unique run and intent before process launch. One dispatch lock rechecks grant/revocation/expiry/rate/scope, feature admission and pinned identities immediately before launch. Grant renewal cancels runs queued under the old grant.

Never-launched queued work can resume only with its original valid grant. Interrupted dispatching/running work becomes unknown and is never automatically replayed. Revocation prevents new dispatch, cancels queued work and requests termination of running work. It does not undo external effects. Successful exit, verified process cleanup and valid bounded output are all necessary before accepting drafts.

Script output is untrusted structured data. It cannot create approvals, nonces, tool results or provider continuation. Selecting Review on an action draft resolves current task state, reruns normal preflight and creates a fresh ordinary one-shot approval. The reusable grant authorizes the script itself; review of an application action is a separate decision. Current typed action proposals cover reviewed existing-file edits and reviewed commands. Unsupported proposals fail closed.

## Stage 4: continuity and artifacts

Decision cards retain rationale and exact message/evidence references. Superseding preserves the original card. Model text is never silently promoted to an instruction. Lineage links related tasks and continuations.

A continuation previews selected retained context, verified source revision and provenance. Creation selects destination profile, budget and mode and creates a fresh independent worktree/task from a clean exact source HEAD, or an explicitly selected retained local revision for a retired task. Source execution is locked and revalidated across creation. Credentials, approvals, pending tool calls, mutation intents and opaque provider continuation are never copied. Unresolved execution blocks inheritance, and no automatic merge occurs.

Artifact previews use contained runtime reads with sensitive-path checks. Markdown and plain text are bounded to 256 KiB; PNG/JPEG/WebP are bounded to 4 MiB and 16 megapixels with signature/dimension validation. Unsupported, escaped, symbolic-link and oversized paths fail visibly. Raw HTML, SVG, embedded applications, scripts and automatic remote-resource loading are disabled. Markdown is rendered using exact `react-markdown` 10.1.0, pinned in the lockfile; its package declares MIT licensing and React >=18 compatibility. No chart dependency was added.

Transcript export writes Markdown, versioned JSON and a SHA-256 manifest from a consistent read transaction into a temporary directory, then finalizes only after successful completion. It includes user-visible retained messages, compaction annotations, lineage, usage and selected evidence references. It excludes credentials, opaque provider state, executable approvals and raw sensitive tool payloads. Final redaction is applied while streaming. Application-state import and restoration from transcript bundles are out of scope.

## Stage 5: app-open schedules

One-time, daily and weekly schedules retain timezone, wall-clock intent, revision and calculated UTC occurrences. The activation instant is a lower bound: creating a schedule after today's selected time does not invent a missed occurrence. While the app is open schedules create local reminders and prefilled prompts only. The user presses **Send** to begin inference. Schedules never invoke custom scripts. On reopening, missed eligible occurrences coalesce into one catch-up reminder. Revision/occurrence identities prevent duplication. DST gaps advance to the next valid local instant; repeated local times deliver once, at the first matching instant. Editing/disabling prevents future delivery and preserves history. Archived targets remain eligible and appear in Inbox.

No Windows service, Task Scheduler integration, closed-app execution or unattended model turn is included.

## Schema, admission and recovery

Schema v5 is the first expansion schema after integration: saved projects and usage on main already occupy v3/v4. Existing v1–v4 stores keep the explicit confirmation gate. Upgrade creates and verifies a WAL-aware SQLite backup before sequential transactional migrations and index rebuild; failure retains the old schema. Newer unsupported schemas are refused. Later schema changes require sequential migrations. Older binaries must not write a v5 database. Rollback means explicitly restoring the verified backup, not opening new data with an older binary.

Upgrade admission closes before awaiting existing requests and credential repairs. Active model turns, provider probes, MCP changes and background coordinator work prevent upgrade; cancellation stays available when work is already active. The runtime checks again after draining accepted requests and before creating the backup. Bounded response limits include JSON escaping and cursor metadata, with complete message and compaction text available in successive chunks.

Metadata and redacted FTS5 rows are updated transactionally with canonical records. Durable transitions are recorded with the corresponding state change; notification follows commit. Events carry version, sequence, source, task/root identity, timestamp and bounded payload. Events never grant authority. First-party desktop, E2E and packaged smoke callers use bounded reads instead of the removed public full-workspace/full-transcript RPCs.

Archive, hooks and scheduling have persistent admission switches. Fault handling disables new admission while preserving history, restore and recovery. A switch is not an undo operation. A runtime automation failure requires explicit re-enabling after investigation.

## Validation and ownership

Each stage is checked with isolated fixtures; no user's working files or application database is a test fixture. Required commands are `pnpm check`, `pnpm test:e2e`, and `pnpm package:dir` followed by `pnpm smoke:package`. Exact current results and retained log locations belong in [implementation status](implementation-status.md).

Release stops if an obligation becomes inaccessible, an uncertain effect is replayed, a script bypasses its grant, an output draft inherits authority, or sensitive input reaches an unauthorized surface. Required coverage includes v1/v2 upgrades/backup failure, deterministic FTS rebuild, 1,000 tasks and 100,000 messages, concurrent paging, escaped oversized messages, archived active/pending work, restart, Inbox failure, keyboard/zoom, MCP canaries, grant invalidation and dispatch races, Windows process cleanup, malformed output, schedule reopen/DST, preview injection, independent fork authority and interrupted export.

The Critical-lane owner retains shared contracts, service integration and final verification. Three GPT-6 Sol / medium specialists, selected by the working agreements and workflow-router, cover runtime/data, desktop UX, and independent security/QA. Cross-review findings are resolved before local release qualification. Live Azure model qualification, clean installation, signing and external distribution remain distinct gates.
