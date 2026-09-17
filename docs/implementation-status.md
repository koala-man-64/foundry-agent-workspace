# Implementation status — foundation increment

Recorded 16 September 2026 (America/Chicago). This is a local engineering build, not v1 release acceptance. The [original plan](foundry-agent-workspace-plan.html) remains the product baseline.

## Delivered

- Pinned pnpm/TypeScript monorepo with Electron, React, typed JSON-RPC, runtime supervision, and SQLite WAL storage.
- Persistent tasks, conversations, ordered events, usage reservations, and mutation-intent records. Startup marks interrupted responses truthfully; shutdown drains accepted work before closing the database.
- Per-task Git worktrees from local HEAD, preserving the source checkout and its uncommitted changes. No remote fetch, push, PR, or main-branch merge.
- Offline deterministic provider plus three text adapters: Responses, Chat Completions, Anthropic Messages. Explicit deployment profiles, Azure endpoint checks, bounded SSE, completion/error handling, client cancellation, and user-triggered capability probes. Live profiles require successful verification.
- Multiple model profiles and a protected offline profile. API keys remain in the OS-backed main-process vault, bound to API/endpoint/deployment. Configuration or credential changes invalidate verification appropriately.
- Task/history sidebar, response status/cancellation, nested file browsing, diff inspection, inspector refresh, and model settings.
- Context/budget checks, three simultaneous response slots, an 80% warning, conservative charging for unknown usage, redaction before persistence/display, and retained original worktrees after uncertain outcomes.
- Per-user Windows NSIS installer configuration and actual build artifacts. The current installer is unsigned.

## Evidence for this increment

| Boundary | Evidence | Meaning and limit |
| --- | --- | --- |
| Types and lint | `pnpm check` | TypeScript and ESLint pass. |
| Unit/integration | `pnpm check`: 44 passing tests | Fake transports, temporary Git repositories, real SQLite, credential/probe races, cancellation, recovery, shutdown draining, UTF-8 RPC limits, and path security. No real Azure endpoint is exercised. |
| Desktop user path | `pnpm test:e2e`: one complete Electron workflow | Creates a task, exchanges an offline message, navigates nested files, refreshes a real diff, cancels a response, rejects unsupported IPC, saves a credential, checks plaintext exclusion, and reopens history after restart. The source checkout stays clean. |
| Rendering | Screenshot inspected after the desktop test | Conversation/composer and inspector layout corrected; button-height regression included. [Screenshot](workspace-screenshot.png). |
| Packaged runtime | `pnpm package:dir` and `pnpm smoke:package` | Actual packaged Electron launches the private-stdio runtime, loads the distributed SQLite native binary, and persists local state. |
| Installer artifact | `pnpm package:win` | Produces `release/Foundry Agent Workspace Setup 0.1.0.exe`. Building an installer does not prove clean-profile installation or signing. |
| Dependencies | `pnpm audit`: zero known vulnerabilities | Current registry audit after removing the unused Monaco dependency. This is not a completeness guarantee. |
| Independent review | Cross-reviews described below | Foundry transport, runtime/credential/IPC, and repository boundaries reviewed; concrete findings fixed and relevant tests rerun. Does not constitute the plan's full-v1 release review. |

Final local artifact fingerprints (SHA-256):

- Installer: `aaa759101f2e9802713c2d4a60bb9d376c57d7649e153dc7e5ef967823556ffb`.
- Packaged `resources/app.asar`: `cfbe977c2b3c4f510a36d7ac005bcfcbae474bbd7ec8166b9986a9a344ac4624`.

Authenticode inspection reports `NotSigned`. Final check, Electron workflow, packaging, package smoke, and audit outputs are retained locally under `.local/validation/` (ignored by Git). No CI, live Azure deployment, or clean-profile installation result is claimed.

## Review findings closed

- Restricted development renderer origins and checked the exact main frame/origin/path on privileged IPC.
- Bound vault records to model transport configuration, forgot mismatched in-memory keys, and prevented in-flight probes from verifying changed credentials.
- Enforced literal Git pathspecs; denied secret aliases and tainted secret rename destinations before rendering diffs.
- Removed automatic destructive worktree rollback; rejected `core.worktree` redirection, configured filters, hooks, and filesystem monitors.
- Resolved Git from absolute PATH entries outside the repository, preventing a repository-local `git.exe` from being executed.
- Rejected unsupported tool/refusal/content-filter frames instead of reporting successful text completion.
- Added cancellation for stalled readers, fair scheduling in the fake provider, probe deadlines, and explicit unknown usage.
- Fixed stale selected-task messages in the renderer and verified the correction through Electron.
- Drained accepted runtime operations during shutdown; a forced termination retains unknown mutation intent.

## Plan phase assessment

| Phase | State |
| --- | --- |
| 00 — Foundation verification | Toolchain, native SQLite, packaged runtime, installer build completed. Actual Foundry deployment/authentication qualification remains open. |
| 01 — Desktop, state, isolation | Core local path implemented and exercised. Some recovery/large-history ergonomics remain below. |
| 02 — Single-agent coding | Text adapters and read-only repository boundary implemented. Agent tool calls, edits, commands, approvals, provider-native continuation, and execution/process reconciliation remain. |
| 03 — Coordinator/specialists | Not implemented. Parallel independent UI conversations are not coordinator delegation. |
| 04 — Context/external tools | Budget controls implemented. Compaction, MCP, publish controls, and retained-worktree management remain. |
| 05 — Windows release | Foundation checks and installer build completed. Full release gates remain open. |

## Known limits and next work

1. Qualify actual user-selected Foundry deployments and authentication. This implementation made no paid calls and inspected no existing credentials. Entra login, sovereign/custom endpoint configuration, cache accounting, and model-specific reasoning capabilities remain unverified/unimplemented.
2. Implement faithful native tool-call/result continuation, capability probes for coding, and offline scripted provider fixtures before enabling agent tools.
3. Implement hash-precondition edits and durable execution intents, then exact/revocable command approvals, Windows process-tree lifecycle, and user-visible reconciliation. Only after these pass should coding be enabled.
4. Add coordinator assignments, child worktrees, bounded scheduling/dependencies, serial integration, combined-result validation, and aggregate budgets. These remain v1 requirements.
5. Add compaction, MCP under the same policy, read-only Monaco diff editing infrastructure, explicit commit/publish grants, diagnostics, and safe worktree retirement.
6. Complete live model-family evidence, full security/recovery matrices, clean Windows-profile installation/uninstallation, and signing before v1 release.

Additional foundation limits:

- Responses are buffered in memory until whole-response secret screening. Activity streams, but text appears after completion/cancellation. A hard crash can lose the current response's partial text; prior messages and conservative usage survive.
- Unknown worktree-creation outcomes block new task creation and remain in SQLite `intents`; automated reconciliation/adoption is not implemented. Retain the branch, registration, and path for investigation. Do not delete or retry blindly.
- Main allows 45 seconds for graceful runtime shutdown, then terminates it. Arbitrary command/process-tree support and Job Object qualification are not yet implemented.
- Transcript/RPC size limits fail visibly; history pagination/export and compaction are not implemented. No history is deleted to make a response fit.
- Diff inspection covers tracked changes relative to HEAD, not untracked file content. Secret screening is defensive and does not guarantee that arbitrary credentials or host-filesystem races are eliminated.
- No automatic runtime restart, silent provider fallback, automatic updater, browser automation, scheduling, or cloud hosting is implemented.

## Ownership and routing

The folder was initially empty and not a Git repository. All work is local on `agent/codex/foundation/foundry-agent-workspace`, with no remote configured. There was no remote base to fetch and no existing checkout to disturb.

Three agents were selected under Rudy's `AGENTS.md` and workflow-router guidance, each **GPT-5.6 Terra / medium**, with bounded context and non-overlapping implementation ownership:

| Agent | Implementation | Independent review |
| --- | --- | --- |
| `providers` | Provider package; later scoped runtime shutdown fix | Main/preload/runtime/credentials; credential-race integration regression |
| `desktop_ui` | Renderer | Repository isolation and secret diff boundaries |
| `repository_tools` | Repository/worktree service | Provider endpoints, SSE, completion and cancellation |

The owner integrated and exercised the combined desktop/runtime/package. Agentcoord's bridge health check passed, but session registration failed; no durable work/claims were acquired. This new local repository used explicit built-in agent messaging for file ownership. No external messages or publication occurred.

## Dependency and integration notes

Versions are recorded in `package.json` and `pnpm-lock.yaml`. Electron 44.4.1 and better-sqlite3 13.0.3 were tested together. SQLite 13's distributed Node-API binary loaded successfully in Node and packaged Electron; source rebuild is disabled to avoid pnpm's unnecessary inferred node-gyp invocation. Bundled `.node` binaries are unpacked from ASAR.

Dependencies are used for explicit boundaries: Electron/React for desktop/UI, Zod for schemas, better-sqlite3 for transactional local state, electron-vite/electron-builder for build/packaging, and Vitest/Playwright for offline tests. Native fetch handles providers without additional SDK dependencies. Library licenses remain in installed packages; packaging retains Electron's notices. A complete distribution/license notice review remains a release gate.

Implementation research checked primary guidance: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [Electron sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox), [electron-vite setup](https://electron-vite.org/guide/), [Foundry endpoints](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/endpoints), and [Foundry Claude models](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/claude-models). Source guidance does not establish compatibility with a specific user's deployment.
