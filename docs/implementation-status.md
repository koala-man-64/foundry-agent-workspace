# Implementation status — reviewed coding increment

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
| 03 — Coordinator/specialists | Not implemented. Independent UI tasks are not coordinator delegation. |
| 04 — Context/external tools | Budgets implemented; compaction, MCP, publish grants and worktree retirement remain. |
| 05 — Windows release | Local candidate build and tests are separate from full release acceptance, signing and clean-profile install/uninstall. |

Next implementation: durable coordinator assignments, child worktrees and dependencies, bounded scheduling, aggregate budgets, serial integration, and combined-result validation. These remain v1 requirements. Continue with compaction, MCP under the same approval policy, explicit commit/publish grants, diagnostics, and safe worktree retirement.

Open qualification: actual user-selected Azure deployments, Entra/sovereign/custom-endpoint support, model-specific reasoning settings, full security/recovery matrix, clean Windows-profile installation/uninstallation, signing, and distribution/license notice review. Routine tests must not discover credentials or make paid probes.

## Practical limits

- Buffered response text appears after whole-response screening. A hard crash can lose the current in-memory fragment; prior messages and conservative reservations survive. Local cancellation does not prove server-side cancellation or billing cessation.
- Unknown worktree creation blocks further task creation. Preserve the recorded branch/path/registration and inspect the SQLite intent; automated adoption is not implemented.
- Unknown command effects require inspection. Read-only reconciliation cannot infer external effects or manufacture a missing exit/cleanup result. Create a separate task only after retaining and investigating the affected worktree.
- History pagination/export, compaction, remembered approvals, automatic runtime restart, provider fallback, updating, browser tools, scheduling and cloud hosting are absent. RPC/history limits fail visibly without deleting retained history.
- The runtime uses Git HEAD when creating worktrees; source uncommitted changes are preserved in the source checkout and are not copied. No implicit fetch, commit, push, PR, merge or worktree deletion occurs.
- Secret screening and same-user filesystem checks are defense in depth. Commands can act outside the worktree with the approved user's rights. Windows Job cleanup is not a security sandbox or proof that every external side effect was undone.
- Native SQLite schema remains version 1. This increment reuses existing JSON records/intents; no database migration was introduced.
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
