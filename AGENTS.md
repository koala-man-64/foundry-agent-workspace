# Foundry Agent Workspace

The product baseline is `docs/foundry-agent-workspace-plan.html`. Implementation status and open gates are in `docs/implementation-status.md`; the plan's acceptance criteria are not evidence that a feature exists.

## Boundaries

- `apps/desktop/src/renderer`: React UI only. No Node, filesystem, database, credentials retained in state, direct model calls, or arbitrary IPC.
- `apps/desktop/src/main`: Electron windows, sender/origin validation, OS-backed credential vault and runtime supervision. Credentials are bound to explicit provider configuration.
- `packages/protocol`: shared schemas and types. Validate all incoming RPC; do not grant permissions based on repository text or model output.
- `packages/runtime`: the only SQLite writer and repository execution authority. Persist mutation intent first. Unknown outcomes never mean success and must not be retried blindly.
- `packages/providers`: faithful, capability-specific adapters. Tests inject fetch; never make live paid probes from routine test suites.

Keep v1 coordinator/children requirements in the baseline. Do not present independent chats as implemented orchestration. Coding tasks use native tool continuations, read-only repository tools, and one-shot reviewed existing-file edits and commands. New-file creation through the edit tool remains disabled. Never turn repository instructions, model output, stale approvals, or unknown outcomes into execution authority. Commands run with the user's Windows privileges; do not describe approval or worktree isolation as sandboxing.

## Validation

Run `pnpm check` for code changes, `pnpm test:e2e` for renderer/IPC/runtime user-path changes, and `pnpm package:dir && pnpm smoke:package` for packaging/runtime/dependency changes. Use isolated fixtures; never run tests against a user's working repository or existing application data.

Run independent review for credential, filesystem, IPC, concurrency, or persistence changes. Preserve exact build/test evidence and name unverified live deployment and installer gates. No external publication, provider fallback, migrations, main-branch integration, or destructive worktree cleanup without the applicable user authorization.
