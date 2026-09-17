# Foundry Agent Workspace

A local Windows desktop workspace for Azure Foundry models. This repository implements the first runnable foundation of the [product plan](docs/foundry-agent-workspace-plan.html).

**Current scope:** persistent tasks, isolated Git worktrees, offline/Foundry text conversations, cancellation, history recovery, model settings, credential protection, file inspection, and diff review. Agent editing, approval-gated commands, tools, and coordinator/child integration are still to be built. The offline profile does not perform coding work.

## Run locally

Use Windows, Git, Node.js 22.12+ (Node 24 tested), and pnpm 10.28.1.

```powershell
pnpm install
pnpm dev
```

The app opens with an **Offline demo** profile. Select a local Git repository with at least one commit, create a task, and send a message. The demo echoes the message without network access. A task starts from the repository's local HEAD; existing uncommitted changes remain in the original checkout and are not copied. Configured Git filters and custom `core.worktree` are rejected because checkout could execute code or redirect writes. Hooks and filesystem monitors are disabled for app-owned operations.

The runtime owns an SQLite database and task worktrees beneath `%LOCALAPPDATA%/FoundryAgentWorkspace`. No worktrees are automatically deleted, pushed, or merged.

## Configure Foundry

Open **Model settings**, create a profile, choose the explicit API kind, and enter your Azure resource root URL and deployment name. Public Azure resource hosts are supported; private proxies/custom domains and Entra authentication are not implemented in this increment. API keys are protected with Electron safeStorage, stored only in the main process vault, and bound to that profile's API, endpoint, and deployment.

**Test connection makes two small paid requests when you click it.** It verifies text streaming, usage, and local client cancellation. It does not qualify a deployment for coding tools. Tool and native continuation capabilities remain false. Changing the destination requires re-entering the credential. No live Foundry probe has been run as part of this implementation.

Responses and Chat Completions use the OpenAI v1 routes; Anthropic uses `/anthropic/v1/messages`. The app rejects redirects and non-Azure credential destinations. A failed probe disables real requests until a successful test.

## Validation and packaging

```powershell
pnpm check                 # TypeScript, ESLint, unit + integration tests
pnpm test:integration      # SQLite, task/worktree, recovery and budget fixtures
pnpm test:e2e              # Built Electron user workflow, offline only
pnpm package:dir           # Unpacked Windows app
pnpm smoke:package         # Actual packaged runtime + bundled SQLite
pnpm package:win           # Per-user NSIS installer; unsigned unless configured
```

Dependencies and the lockfile are pinned. `better-sqlite3` 13 ships a Node-API Windows binary, tested in both Node and Electron; it does not need an Electron ABI rebuild. Its inferred source-build hook is deliberately disabled, and packaging retains `.node` files outside the ASAR archive. Electron's official download can be slow on first install; if interrupted, run `pnpm rebuild electron` and retry. Do not disable package checksums or use an untrusted mirror.

## Recovery and limits

- Reopen the application to recover saved tasks after runtime failure. Incomplete responses become **interrupted**, and reserved usage is retained. A response in progress is held in memory for whole-response secret screening, so a hard crash may lose that response's partial text.
- Cancellation stops the local model stream. It does not prove server-side billing stopped. Failed/cancelled requests retain a conservative input/output reservation; successful requests use reported usage when available.
- Budgets use UTF-8 byte ceilings plus framing and the configured output limit when usage is unknown. Charges are intentionally conservative, and the UI labels them accordingly.
- Unknown worktree-creation effects block new task creation and remain in the `intents` table. Preserve the app-data directory and inspect the corresponding `codex/task/<id>` branch/worktree registration; an automated reconciliation UI is not implemented yet. Never delete a retained worktree merely because a task failed.
- Secret screening and path restrictions are defense in depth. They cannot detect every secret or eliminate hostile host-filesystem races. Response text is shown after completion so split secret strings cannot leak through partial frames.
- Provider-native reasoning/tool continuation, context compaction, command approvals, MCP, durable child agents, integration, and a full Monaco diff editor are pending.

See [implementation status](docs/implementation-status.md) for the evidence and next steps.
