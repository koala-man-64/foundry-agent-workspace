# Foundry Agent Workspace

A local Windows desktop workspace for Azure Foundry models. This repository implements the foundation and reviewed single-agent coding increment of the [product plan](docs/foundry-agent-workspace-plan.html).

**Current scope:** persistent tasks, isolated Git worktrees, text conversations, native provider tool loops, reviewed existing-file edits and Windows commands, cancellation, recovery, model settings, credential protection, file inspection, and diff review. Coordinator/child integration remains to be built. The offline profile provides a deterministic coding fixture, not a general-purpose coding model.

## Run locally

Use Windows, Git, Node.js 22.12+ (Node 24 tested), and pnpm 10.28.1.

```powershell
pnpm install
pnpm dev
```

The app opens with an **Offline demo** profile. Select a local Git repository with at least one commit, create a task, and send a message. The demo echoes the message without network access. A task starts from the repository's local HEAD; existing uncommitted changes remain in the original checkout and are not copied. Configured Git filters and custom `core.worktree` are rejected because checkout could execute code or redirect writes. Hooks and filesystem monitors are disabled for app-owned operations.

The runtime owns an SQLite database and task worktrees beneath `%LOCALAPPDATA%/FoundryAgentWorkspace`. No worktrees are automatically deleted, pushed, or merged.

Choose **Coding with reviewed tools** to enable the coding loop. With **Offline demo**, send `/demo` in a repository containing a non-empty `README.md`: it reads the file, proposes appending a demo line, and then proposes a harmless `Write-Output` command. Review each action in **Approvals**. Rejecting the edit leaves the file unchanged. Ordinary offline messages still produce deterministic echoes.

Real coding profiles can list/search/read files, propose full or single-match replacement of existing files, and propose commands. File proposals carry SHA-256 preconditions and full before/after evidence. Commands bind the exact command, worktree state, canonical directory, Windows PowerShell executable, environment, and timeout. Each mutation needs a new one-shot approval. **Commands run with your Windows privileges; the worktree and approval UI are not a sandbox.** New-file creation through the file-edit tool is disabled until a race-safe Windows creation primitive exists; commands can have broader effects when explicitly approved.

## Configure Foundry

Open **Model settings**, create a profile, choose the explicit API kind, and enter your Azure resource root URL and deployment name. Public Azure resource hosts are supported; private proxies/custom domains and Entra authentication are not implemented in this increment. API keys are protected with Electron safeStorage, stored only in the main process vault, and bound to that profile's API, endpoint, and deployment.

**Test connection may make up to four small paid requests when you click it.** It checks text streaming, usage, local client cancellation, a fixture tool call, and its native continuation. Real coding requires verified tool and continuation capabilities. Changing the destination requires re-entering the credential. No live Foundry probe has been run as part of this implementation.

Responses and Chat Completions use the OpenAI v1 routes; Anthropic uses `/anthropic/v1/messages`. The app rejects redirects and non-Azure credential destinations. A failed probe disables real requests until a successful test.

## Validation and packaging

```powershell
pnpm check                 # TypeScript, ESLint, unit + integration tests
pnpm test:integration      # SQLite, task/worktree, recovery and budget fixtures
pnpm test:e2e              # Built Electron user workflow, offline only
pnpm package:dir           # Unpacked Windows app
pnpm smoke:package         # Packaged SQLite + approved edit/Windows command fixture
pnpm package:win           # Per-user NSIS installer; unsigned unless configured
```

Dependencies and the lockfile are pinned. `better-sqlite3` 13 ships a Node-API Windows binary, tested in both Node and Electron; it does not need an Electron ABI rebuild. Its inferred source-build hook is deliberately disabled, and packaging retains `.node` files outside the ASAR archive. Electron's official download can be slow on first install; if interrupted, run `pnpm rebuild electron` and retry. Do not disable package checksums or use an untrusted mirror.

## Recovery and limits

- Reopen the application to recover saved tasks after runtime failure. Incomplete responses become **interrupted**, and reserved usage is retained. A response in progress is held in memory for whole-response secret screening, so a hard crash may lose that response's partial text.
- Cancellation stops the local model stream. It does not prove server-side billing stopped. Failed/cancelled requests retain a conservative input/output reservation; successful requests use reported usage when available.
- Budgets use UTF-8 byte ceilings plus framing and the configured output limit when usage is unknown. Charges are intentionally conservative, and the UI labels them accordingly.
- Unknown worktree-creation effects block new task creation and remain in the `intents` table. Preserve the app-data directory and inspect the corresponding `codex/task/<id>` branch/worktree registration; an automated reconciliation UI is not implemented yet. Never delete a retained worktree merely because a task failed.
- Restart revokes waiting approvals and marks executing mutations **unknown**. **Check outcome** only reads file hashes; it never retries a mutation. Unknown command effects require inspection and remain blocked in that task. Interrupted provider calls receive explicit error results on continuation and are never replayed. Recent approval evidence survives restart; older full evidence remains in SQLite.
- Approved commands run in a Windows Job Object. Cancellation, timeout, parent death, and helper failure are handled conservatively; success requires a verified cleanup result. The packaged helper uses Windows PowerShell and local C# compilation. Host policies that prohibit these facilities will fail closed.
- Commands start with a Windows-only PATH. Use explicit paths for developer executables or set PATH in the reviewed script. Freshness checks currently reject worktrees over 10,000 files / 64 MiB, including large dependency directories.
- Three model/command execution slots are shared across tasks. Waiting approvals consume no execution slot. A turn is limited to 50 tools; context/budget exhaustion stops it with its work preserved. Native reasoning/signatures stay outside renderer history; secret-like opaque state is rejected rather than modified.
- Secret screening and path restrictions are defense in depth. They cannot detect every secret or eliminate hostile host-filesystem races. Response text is shown after completion so split secret strings cannot leak through partial frames.
- Context compaction, MCP, durable child agents, serial integration, remembered approval policies, and a full Monaco diff editor remain pending. Live Azure qualification, clean-profile installation, and signing are separate open release gates.

See [implementation status](docs/implementation-status.md) for the evidence and next steps.
