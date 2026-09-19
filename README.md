# Foundry Agent Workspace

A local Windows desktop workspace for Azure Foundry models. This repository implements the foundation and reviewed single-agent coding increment of the [product plan](docs/foundry-agent-workspace-plan.html).

**Current scope:** persistent tasks, isolated Git worktrees, text conversations, native provider tool loops, reviewed existing-file edits and Windows commands, coordinated coordinator/child tasks, controlled context compaction, external MCP tools under the same approval policy, usage and diagnostics visibility, explicit commit/push actions, safe worktree retirement, cancellation, recovery, model settings, credential protection, file inspection, and diff review. The offline profile provides deterministic fixtures, not a general-purpose coding model.

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

## Context, usage and compaction

The task header shows the task budget and a conservative estimate of the next request's context. The runtime warns at 80% of the profile's context limit; **Compact context** (header or **Usage** panel) replaces older turns with a runtime-generated structured summary. Summaries are produced locally from retained records, never by a model, and are labelled as data rather than instructions. Every original message stays in SQLite and in the transcript (dimmed), and the compacted native provider history keeps system instructions, complete tool-call/result units, opaque reasoning blocks and any pending tail. A compaction that would produce an invalid provider continuation fails visibly and changes nothing. The **Usage** panel lists prompt, completion and cache tokens per request, retained unknown reservations, and the compaction history.

## External tools (MCP)

**Model settings → MCP servers** configures stdio MCP servers by absolute `.exe` path, arguments, optional working directory and a restricted environment (credential-like names are refused). Saving launches the server once in a supervised Windows Job Object, lists its tools, and stores that listing; coding tasks then see the tools as `mcp__key__tool`. Servers are started on demand, stopped when idle, and terminated with their descendants on cancellation, runtime shutdown or runtime death. Only tools you tick in the **Read-only allowlist** run without a per-call approval; every other call stops for a one-shot decision that shows the server, tool and exact arguments. Server annotations such as `readOnlyHint` are displayed as hints and grant nothing. Arguments and results are secret-screened and bounded; a call that times out or loses its transport after being sent is recorded as an **unknown** outcome and is never replayed. With **Offline demo**, configure the fixture server in `tests/fixtures/mcp-fixture-server.mjs` under the key `fixture` and send `/mcp-demo` in a coding task.

## Publishing and retiring

The **Publish** panel holds the only Git publication controls, and the agent never proposes or runs them. **Commit all changes** stages every change in the task worktree except secret-named paths (hooks stay disabled; the commit identity comes from your Git configuration). **Push branch…** pushes the task branch to a remote configured in the project repository without forcing; your Git credential helper may run for that action only. **Retire worktree…** removes the app-owned worktree directory only after Git proves it has no uncommitted or untracked files; the branch, commits, task history and evidence remain, and a retired task cannot receive new messages. **Export diagnostics** writes a sanitized JSON bundle under the app data directory that excludes credentials, file contents, patches, message text and environment values.

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
- MCP servers run with your Windows privileges outside the worktree; the allowlist and approvals bound which calls happen, not what a server can do. The MCP host uses Windows PowerShell and local C# compilation like the command helper. Compaction summaries are deterministic excerpts, so a summarized turn loses detail; the originals stay retained for you to read.
- Remembered approval policies, automatic compaction, and a full Monaco diff editor remain pending. Live Azure qualification, clean-profile installation, and signing are separate open release gates.

See [implementation status](docs/implementation-status.md) for the evidence and next steps.
