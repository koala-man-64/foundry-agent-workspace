# Implementation status

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
| 03 — Coordinator/specialists | Implemented locally in the coordinated orchestration increment above (not merged to main). Live model qualification remains open. |
| 04 — Context/external tools | Budgets implemented; compaction, MCP, publish grants and worktree retirement remain. |
| 05 — Windows release | Local candidate build and tests are separate from full release acceptance, signing and clean-profile install/uninstall. |

Next implementation: continue with compaction, MCP under the same approval policy, explicit commit/publish grants, diagnostics, and safe worktree retirement.

Open qualification: actual user-selected Azure deployments, Entra/sovereign/custom-endpoint support, model-specific reasoning settings, full security/recovery matrix, clean Windows-profile installation/uninstallation, signing, and distribution/license notice review. Routine tests must not discover credentials or make paid probes.

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
