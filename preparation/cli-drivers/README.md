# Isolated C# CLI driver preparation

Rudy authorized this preparation on 17 October 2026. The complete CLI-model feature targets the WPF/.NET app **after P5**. This directory is a separate solution; no shipping project, frozen protocol, database schema, application-data path, renderer, runtime dispatcher, or package entry point references it.

## Implemented here

- A one-shot Codex app-server client: initialization, account-status inspection, bounded model-catalog pagination, explicit thread start/resume, correlated turn streaming, native-request denial, and session checkpoints.
- A one-shot Claude Code print-mode `stream-json` reader/writer: user input, initialization/session validation, partial-text/snapshot reconciliation, final usage, and explicit failure handling. Model/effort and resume selection belong to the future admitted launch configuration; the stream user message does not configure those settings.
- Strict UTF-8/JSONL framing with duplicate-member, depth, message-count, byte, text, and timeout bounds. Unknown message/tool types fail closed instead of granting capabilities.
- Codex cumulative-usage checkpoints become per-operation usage; repeated snapshots are replacements, not additive charges. An unknown resume baseline stays unknown. Claude uses the final result's per-operation usage, including cache tokens, and ignores duplicate assistant usage and cumulative cost fields. Missing usage remains null.
- Typed unknown-outcome metadata for cancellation, timeouts, transport loss, and malformed responses. Cleanup errors preserve an already confirmed turn and usage. Drivers are one-shot and never retry, fall back, or select an unrelated saved session.
- An internal, fixture-only transport reusing `Foundry.Platform.JobProcess`: explicit process specification, discarded/bounded stderr, stdin closure, bounded graceful exit and verified Job Object tree termination. It exposes no public admitted-launch API.

The shared preparation types are independent of `Foundry.Protocol`. Observers receive untrusted text, reported model, and usage snapshots; they confer no execution authority. Claude initialization must advertise no tools/MCP servers/plugins. Codex approval requests are declined; other server requests and native tool notifications are rejected. These are **text-protocol fixtures, not full coding/coordinator adapters**.

## Run

From the repository root, with the pinned SDK in `global.json`:

```powershell
dotnet restore preparation/cli-drivers/CliDrivers.slnx --locked-mode
dotnet build preparation/cli-drivers/CliDrivers.slnx -c Release --no-restore
dotnet test --project preparation/cli-drivers/Foundry.CliDrivers.Tests/Foundry.CliDrivers.Tests.csproj -c Release --no-build --no-restore
pnpm check
```

Tests use handwritten protocol fixtures and a compiled fake executable in disposable temporary folders. They invoke neither installed CLI, read no provider credentials, send no paid requests, and open no existing application data or working repository. Process tests prove native pipe streaming, cancellation of a root and descendant, and bounded stderr cleanup. Architecture checks ensure shipping projects do not reference this preparation. Generated lockfiles use only the repository's existing pinned packages.

Local validation logs are retained under `test-results/cli-drivers-preparation-01a14a3d/`, with publication checks under `test-results/cli-drivers-publication-01a14a3d/`. Use `pnpm install --frozen-lockfile` to supply the unchanged JavaScript dependency set when needed. CI, installer and live-provider qualification are separate evidence gates. Existing .NET CI targets `Foundry.slnx`, so it does not run this standalone preparation suite; use the explicit commands above.

The local Release build has zero warnings/errors; **69 preparation tests** pass with zero failures/skips. The existing shipping architecture suite passes **23 tests**. `pnpm check` passes type checking, lint and repository tests; the draft PR records the publication run's counts and source revision. A PID-marker sharing race found during validation was fixed by publishing the closed fixture file through an atomic move; the failed-run log is retained beside the final passing result.

Independent security and QA reviews used **gpt-6-luna/max**, selected by repository `AGENTS.md` / `workflow-router` for bounded Critical-lane review under the verified Sol/max owner route. Review fixes preserve cancellation/confirmation metadata, classify missing fields and local observer failures, and validate Claude content-block types/indexes. Review is preparation-only; it does not admit installed CLI executables or authorize integration.

Source was initially prepared from `7df623a9167d82d8a73e4430fd153ea3945162e2`; the private publication branch `codex/cli-drivers-prep-01a14a3d` is rebased onto `677dc16d29bdf7a6c17aa063626f59abc49e291d`. Rebase onto the accepted post-P5 baseline before integration. Agent coordination was unavailable (`session_token_unavailable`); no shared claim is asserted. Publication as a draft PR does not authorize runtime/model-picker integration, migration, cutover or feature activation.

## Required after P5, before product integration

1. Add reviewed executable discovery/admission, fixed launch arguments, effective-policy checks, supported-version tests, CLI sign-in reuse and exact/alias model verification. Never claim that injected streams prove these controls. No installed CLI is approved for launch by this preparation.
2. Supply the app-owned MCP/named-pipe tool bridge and enforce role/task identity, existing approvals, durable intent/results, limits and managed policy. Replace the preparation's blanket tool rejection only after independent security and QA qualification.
3. Integrate native checkpoints with the owning runtime, budget accounting, redaction, crash recovery, user-confirmed session replacement and protected schema upgrade. Provider completion and process cleanup are independent facts; a confirmed result must not be replayed because cleanup failed.
4. Extend authoritative contracts and model settings/pickers, then earn the specified disposable-repository user-path, package, installer and explicit signed-in CLI evidence. This directory is not a migration, cutover, publication or activation authorization.

Protocol references: [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Claude Code programmatic execution](https://code.claude.com/docs/en/headless), [Claude CLI options](https://code.claude.com/docs/en/cli-reference). Compatibility with a real installed CLI remains unverified; fixtures are not captured live receipts.
