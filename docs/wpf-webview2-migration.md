# WPF + WebView2 migration plan (.NET 10)

**Status:** approved 2026-10-08; phase P0 is in progress. No product behavior has moved yet. Electron remains the shipping product until the P5 cutover. Progress and gates are tracked in [implementation-status.md](implementation-status.md).

## Context

Foundry Agent Workspace (v0.2.0, `e21d9ae`) is an Electron 44 app with three layers:
- **Electron main** (~800 LOC): window, IPC authorization, safeStorage vault, WebContentsView browser, toasts, runtime supervision.
- **UI**: a preload `window.workspace` bridge and a React 19 renderer (~3K LOC). The renderer touches the bridge once (`App.tsx:56`).
- **Runtime + providers** (~13K dense LOC): better-sqlite3, git CLI, PowerShell/Add-Type Job Objects, MCP, Azure adapters. Main talks to it over newline-delimited JSON-RPC 2.0 on stdio: 1 MiB frames, 86 RPC methods plus 5 non-RPC frames, ~40 tables, schema v1–v5.

The goal is to remove Electron and Node entirely: a WPF shell on .NET 10, WebView2 for web content, and every invariant in `AGENTS.md` preserved.

This plan is the output of a three-seat roundtable chaired by the owner. Round 1 was independent position papers from the code. Round 2 was cross-examination, which resolved every contested point. The user's decisions are folded in.

**Intended outcome:**
- The unchanged React UI runs in WebView2 under a hardened WPF host.
- A C# runtime is behavior-identical to today's, proven by the existing suites plus differential traces.
- The user's existing data is adopted in place behind a verified backup and a v6 fence.
- It ships as a portable ZIP plus a per-user installer, with no Electron or Node in the artifact.

## Decisions

**User decisions**
1. WPF (.NET 10 LTS) is the shell. WebView2 hosts the existing React UI behind the same `window.workspace` DesktopApi contract.
2. Runtime and providers are ported to C#. The release ships no Electron and no Node.
3. `%LOCALAPPDATA%\FoundryAgentWorkspace` is adopted in place after a verified WAL-aware backup. The cutover is one-way. API keys are re-entered, and integrated-browser sign-ins are lost.
4. **Single cutover** at the end. Electron remains the shipping product until then.
5. **JavaScript is dropped** as a script/hook language; only Windows PowerShell 5.1 remains.
6. Ship a **portable ZIP plus a per-user Inno Setup installer** (replaces NSIS).
7. If the browser input-control spike fails, ship with **agent attach disabled (view-only browsing)**. This does not block the cutover.

**Provenance.** An owner-chaired review with three independent seats produced this plan: architecture and delivery, security, and data integrity and concurrency. Each seat first wrote a position paper from the code at `e21d9ae`; the seats then cross-examined each other. The owner kept the test strategy and the synthesis. Claims checked against official documentation are marked "verified". Unverified platform behavior is assigned to a named P0 spike.

**Disputes resolved**

| Topic | Resolution |
|---|---|
| UI serving | Use a custom scheme with embedded resources, not virtual-host mapping. Virtual-host mapping never fires `WebResourceRequested` (verified), so it cannot carry a CSP header, and its loose files sit outside the signature. |
| Bridge shim | A bundled TypeScript module rather than injected script; both seats accepted. The host gate is the control either way. |
| Old-app detection | A non-mutating `FileShare.None` open probe. The `BEGIN EXCLUSIVE` probe was withdrawn because WAL mode only takes the write lock. |
| Browser input control | The disabled-HWND/overlay/ignore-input ladder replaces the sentinel-first design. The sentinel is kept in reserve. If the ladder fails, fail closed. |
| Event outbox | Fix notify-before-commit in .NET only. The TS runtime stays frozen. Differential tests compare committed event rows, not the emitted stream. |
| Data root | Release uses the known-folder API. Env overrides work only in Debug/E2E builds. |
| `grantUniveralAccess` | That misspelling is CDP's own (verified in `Page.pdl`). Keep it, with value `false`. |

## Target architecture

```
Foundry.exe  (WPF host, .NET 10)                         Foundry.Runtime.exe  (headless, .NET 10)
 ├─ UI WebView2  [env webview2\ui, foundry-app://ui/]     ├─ StdioTransport (protocol unchanged)
 │   React bundle (embedded) ─postMessage─► BridgeGate ─► RuntimeSupervisor ═stdio═► RuntimeLoop (1 thread)
 ├─ Browser WebView2 tabs [env webview2\browser, NO bridge]   ├─ Store: sole SQLite writer, WAL, sync=FULL
 ├─ DpapiVault (credentials-v2)                           ├─ agent loop, tools, approvals, orchestrator
 ├─ toasts, dialogs, single instance                      ├─ git/files, commands (native Job Objects)
 └─ runtime held in a KILL_ON_JOB_CLOSE job               └─ providers (HttpClient + SSE), MCP, automation
```

**Trust boundaries:**
- The renderer holds no authority.
- The host gate validates everything coming from the renderer.
- The runtime is the authority and re-validates.
- Browser tab content has no channel to either process.

**Solution layout** (`src/`, `tests/`, `ui/`, `installer/`, root `build.ps1`)

| Project | Responsibility | May reference |
|---|---|---|
| `Foundry.Protocol` | records, validators, framing (byte-capped LineReader), JSON options, `JsJson` (ECMAScript-exact stringify), `Clock.Iso` | — |
| `Foundry.Platform` | Hand-written `LibraryImport` P/Invoke with `unsafe` confined here: `JobProcess`, `FinalPath`, `ProtectedDirectory`, `ProtectedSecret` (spike S7) | — |
| `Foundry.Providers` | Responses / Chat Completions / Anthropic adapters, SSE, shipped fixtures (fake, orchestration, browser) | Protocol |
| `Foundry.Runtime.Core` | `RuntimeLoop`, `Store`, all runtime modules (namespace `Foundry.Runtime`) | Protocol, Providers, Platform, Microsoft.Data.Sqlite |
| `Foundry.Runtime` | ~30 LOC stdio entry; builds `Foundry.Runtime.exe` | Runtime.Core |
| `Foundry.Host` | non-WPF policy: `RuntimeSupervisor`, `BridgeGate`, vault, browser policy/state machine, preferences | Protocol, Platform |
| `Foundry.Desktop` | WPF shell, WebView2 adapters (`IBrowserSurface`, the only new abstraction), embedded `ui/dist`; builds `Foundry.exe` | Host |

The runtime library is `Foundry.Runtime.Core` because the `Foundry.Runtime.exe` entry point owns the assembly name `Foundry.Runtime`; two assemblies with one name would collide in a shared publish folder.

Test projects: `Protocol.Tests`, `Platform.Tests`, `Runtime.Tests`, `Host.Tests`, `Conformance`, and `Architecture.Tests`. Each is added with its first code. They use xunit.v3 on Microsoft.Testing.Platform; `global.json` opts `dotnet test` into that runner, so no VSTest packages are needed.

The architecture tests read every source `.csproj` and fail on:
- a project reference outside the allowed graph;
- `Desktop` or `Host` reaching `Runtime.Core`, `Runtime` or `Providers`, even transitively;
- `Runtime.Core` or `Runtime` reaching `Host` or `Desktop`, even transitively;
- WebView2, SQLite or DPAPI packages outside their owning project;
- WPF outside `Desktop`, Windows Forms anywhere, unsafe code outside `Platform`, or raw assembly references.

**Root configuration**
- `global.json`: SDK 10.0.x, `rollForward: disable`.
- `Directory.Build.props`: `net10.0-windows`, Nullable, TreatWarningsAsErrors, AnalysisMode, EnforceCodeStyleInBuild, `RestorePackagesWithLockFile`.
- `Directory.Packages.props`: central package management.
- `nuget.config`: source mapping to nuget.org only. NuGetAudit warnings are errors.
- The UI keeps pnpm and its lockfile in `ui/`.

**Dependencies** (each justified)
- `Microsoft.Web.WebView2`, exact pin.
- `Microsoft.Data.Sqlite` 10.0.12 with its default `SQLitePCLRaw.bundle_e_sqlite3` 2.1.12 (SQLite 3.53.3), chosen by spike S8a. It returns better-sqlite3's results on every era fixture, so the newer 3.0.5 bundle is not needed.
- `System.Security.Cryptography.ProtectedData` 10.0.12 (Microsoft, MIT) for DPAPI, confined to `Platform`: the supported wrapper over `CryptProtectData`, rather than marshaling it by hand.
- Build-time only: `Microsoft.CodeAnalysis.BannedApiAnalyzers`, in every product project. Spike S7 replaced the planned CsWin32 generator with the plan's fallback: eighteen hand-written kernel32 `LibraryImport` declarations, loaded from System32 only, so no generator package is needed.
- Tests only: xUnit v3, FsCheck.
- Toasts use the WinRT projection via the `net10.0-windows10.0.19041.0` TFM, with no extra package.

Explicitly not added: EF Core, a DI container or Generic Host, a logging framework, an MVVM toolkit, NotifyIcon libraries, Velopack, MSIX, or a Fixed-Version WebView2 runtime.

**Data directory after cutover**

```
%LOCALAPPDATA%\FoundryAgentWorkspace\
  workspace.db (+-wal/-shm)        v6 + runtime_meta (adopted in place)
  wt\                              worktrees, unchanged (absolute registrations: dir must not move)
  credentials-v2\                  DPAPI vault (new)
  credentials\  browser-data\      Electron vault / Chromium profile: never read, never deleted
  webview2\ui  webview2\browser    new WebView2 user-data folders (protected ACL)
  adoption\adopt-<id>.json         adoption journal
  backups\ (protected ACL)         verified pre-adoption backup, kept until the user deletes it
  notification-preferences.json    reused
```

## Component design

### 1. Runtime execution model (`Foundry.Runtime.Core`). Today's atomicity comes from Node's single thread.

**RuntimeLoop.** One dedicated thread runs a FIFO `SynchronizationContext` (`Send` throws). The stdin reader posts each line, and each handler is its own task, as in `entry.ts:84-95`. All state lives on the loop and continuations return to it, so code between awaits stays atomic. Seat C counted about 45–60 dependent sites: admission gates, per-task flags, `ExecutionSlots`, the `waiting` approval map and ~40 synchronous transactions.

**Enforcement**
- BannedApiAnalyzers (`src/Foundry.Runtime.Core/BannedSymbols.txt`) bans:
  - every `ConfigureAwait` overload;
  - blocking waits (`.Result`, `.Wait()`, `GetAwaiter().GetResult()`);
  - `Task.Run`, `Task.Factory`, `ThreadPool`, `Parallel` and `Thread`, so work goes through `Offload()` and the loop owns its thread with a local suppression;
  - `Task.Yield`, allowed only at the two deferral sites with a local suppression;
  - both timer types, `Monitor` and `Lock`;
  - `DateTime`/`DateTimeOffset.ToString(format)`.
- The `lock` statement and `async void` are language constructs that an analyzer list cannot name. An architecture test scans the runtime sources for them.
- CA1305, CA1309 and CA1310 are errors, and the default thread culture is invariant.
- `Store` and the ledgers assert `RuntimeLoop.IsCurrent`.
- `Offload()` (Task.Run returning plain data) is allowed only for state-free CPU or blocking work.
- `Task.Yield()` appears only at the two JS microtask-deferral sites (`service.ts:515,648`).

**Store**
- One hidden connection with `Pooling=False`. It also disables double-quoted string literals (`sqlite3_db_config` `DQS_DML`/`DQS_DDL` = 0), matching better-sqlite3's `DQS=0` build, so a stray `"literal"` stays an error on both engines. The candidate is in `tests/Foundry.Runtime.Tests/CandidateConnection.cs`.
- Pragmas: `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, and `synchronous=FULL`. FULL is a deliberate durability upgrade so "persist intent first" holds across power loss.
- Read `user_version` on a read-only connection before touching `journal_mode`. Today `store.ts:35` sets WAL first. Refuse any version newer than current.
- DDL is copied byte-identical into embedded `.sql` files, applied in today's order (`store.ts:46`), with a SHA-256 manifest test.
- Never `VACUUM`: FTS and the cursors are linked by rowid.

**Transactions**
- `Store.Transaction(Func<T>)` is deferred; `Store.Immediate(Func<T>)` uses BEGIN IMMEDIATE.
- Nesting uses `sp_N` savepoints. `Immediate` inside an outer transaction degrades to a savepoint, as better-sqlite3 does (`orchestrator.ts:579`).
- The async overload is `[Obsolete(error:true)]`, and a guard rejects any callback that returns a Task.
- `Store.Command` binds the transaction.
- `automation.ts`'s direct `store.db` transactions move onto the helper.

**Event outbox**
- `Store.Event` inserts the row and enqueues it on the open transaction.
- Events publish in sequence order after the outermost commit and are dropped on rollback.
- Delete the `lastEvent` re-read (`service.ts:97-98`). `task.progress` (sequence 0) bypasses the outbox.
- This fixes publish-inside-transaction at `orchestrator.ts:333,374,467,475,484`, a documented intentional divergence.

**JSON**
- Incoming RPC uses strict records: `UnmappedMemberHandling.Disallow`, `MaxDepth` 32, duplicate keys rejected (`AllowDuplicateProperties = false`, available in .NET 10), and UUIDs kept as strings checked by a strict regex. Validators reproduce zod's `.default()` and `.trim()` semantics.
  - Spike S8b decided the parser differentials, and both boundaries (bridge strings and stdio bytes) reject:
    - integers written as `4.0` or `4e0`. Only canonical spellings are accepted; JSON.stringify never emits these, although zod would accept the integer 4.
    - lone-surrogate escapes (malformed UTF-16), which JSON.parse would keep.
    - a leading byte order mark. The span reader rejects it, but stream reads skip it, so the framing checks it explicitly.
  - The candidate options are in `tests/Foundry.Protocol.Tests/CandidateJson.cs`.
- Persisted documents (`tasks.data`, `intents.data`, approvals) use a round-trip-preserving `JsonNode` or `[JsonExtensionData]`, so unmodeled properties survive `saveTask` (`store.ts:195`).
- Provider continuation blobs stay raw.

**Hash inputs**
- `JsJson.Stringify` reproduces `JSON.stringify` exactly: insertion order, undefined-versus-null omission, escaping and number format.
- It covers the ~12 hash sites:
  - `git-operations.ts:817` (manifest, persisted and recompared at `orchestrator.ts:307,507`)
  - `automation.ts:488` (configDigest)
  - `mcp.ts:472`
  - `usage-ledger.ts:24`
  - `service.ts:512,523`
  - `command-runner.ts:262`
  - `repository.ts:366`
  - `browser-tools.ts:61`
  - `workspace-queries.ts:18`
  - both `profileFingerprint` variants
- Sort orders that feed a persisted and recompared hash are replicated exactly. Elsewhere use Ordinal: the `localeCompare` sorts at `command-runner.ts:167` and `mcp.ts:345` are session-scoped.
  - Handoff manifest entries are sorted by **UTF-8 bytes** (`Buffer.compare`, `git-operations.ts:812`). That is not UTF-16 ordinal, which orders U+E000 after an astral character.
  - The providers' `profileFingerprint` hashes the WHATWG URL serialization of the endpoint.
- Golden vectors generated from Node live in `tests/golden/data` (see `tests/golden/README.md`). A no-ambiguity test is still to come.

**Other parity rules**
- **`Clock.Iso()`**: exactly `yyyy-MM-ddTHH:mm:ss.fffZ`. Text ordering at ~73 sites depends on it.
- **Collation**: Ordinal for ISO timestamps and UUIDs. Current-culture `CompareInfo` for display-name sorts, with the ICU-version divergence documented. Legacy `toLocaleLowerCase` becomes `ToLowerInvariant`. Title-search SQL is unchanged.
- **Regex**: `Redactor` and the MCP checks reproduce JavaScript semantics with explicit character classes.
  - In JavaScript, `\b` and `\w` are ASCII, so `ésk-…` is still redacted. `\s`, however, is Unicode: it includes U+00A0 and U+FEFF and excludes U+0085.
  - Case-insensitive matching never maps a non-ASCII character to ASCII, so the Kelvin sign does not match `k`.
  - Neither .NET's default regex nor `RegexOptions.ECMAScript` matches all of this, so `tests/golden/data/redaction.json` is the oracle.
  - A mismatch either leaks a token or quarantines extra MCP servers on adoption (`mcp-config.ts:25-32` clears args and env).
- **`path_key`** (`store.ts:24-25`), computed exactly as Node 24 in Electron 44 does (spike S7):
  - A port of `path.win32.resolve`, then Node's `\\?\` namespacing of drive and UNC paths, applied in C++ before libuv. Trailing dots and spaces are therefore not stripped, and MAX_PATH does not apply.
  - `CreateFile(BACKUP_SEMANTICS)` plus `GetFinalPathNameByHandleW(VOLUME_NAME_DOS)` with libuv's prefix stripping, falling back to the resolved path.
  - JavaScript lowercase: ICU full case mapping in the root locale. .NET's `ToLower` maps characters one to one, so it differs for `İ` (JavaScript gives `i̇`) and the final sigma.
    - The port ships Electron 44's Unicode 17.0 data in `src/Foundry.Platform/EcmaScriptLowercase.json`: 1,488 mappings, plus the Cased and Case_Ignorable sets the final sigma needs. `tests/golden/ecmascript-case.test.ts` generates the file and checks it for drift.
    - The system ICU is not used, because Windows' ICU 72.1 (Unicode 15.1) lowercases 55 of those code points differently. With pinned tables, keys never move when Windows updates its ICU.
  - Checked against `scripts/golden-path-key.mjs` under Node 24 on a real tree:
    - case, `..`, forward slashes, and trailing separators, dots and spaces;
    - 8.3 names, junctions, symlinks (where they can be created), UNC, `\\?\` and `\\.\` (including a pipe);
    - paths over 260 characters, missing paths, NUL;
    - non-ASCII, NFD, Turkish İ and the final sigma.
    Not covered: subst (a global drive mapping) and drive-relative input, which depends on hidden `=C:` variables.
  - Scope and containment checks use `FinalPath.TryResolve`. It has the `fs.promises.realpath` semantics of the TypeScript checks and fails closed. `Canonical` and `Key` keep `pathKey`'s lexical fallback.
  - Residual, inherited from the TypeScript runtime:
    - Lowercasing can give distinct directories one key, for example the Kelvin sign and `k`, or names in a case-sensitive directory.
    - Computing a key opens the path, so a UNC path reaches the network.
- **Schedules**:
  - `resolveLocalInstant` (`automation.ts:548-563`) is ported verbatim on `TimeZoneInfo.GetUtcOffset`. Keys stay `${revision}:${localDate}`. Keep ICU (no `InvariantGlobalization`).
  - Checked against a golden grid from Node: New_York gap and fold, Lord_Howe, Kolkata, Apia, Dublin, Casablanca, and an unknown zone.
- **Process semantics**:
  - An unhandled exception writes the fixed redacted stderr line and exits 1 (`entry.ts:98`).
  - stdin EOF triggers a bounded drain.
  - Output over 1 MiB returns error -32001 (`entry.ts:15-19`).

### 2. Runtime module port map

| TS module(s) | C# target | Size / risk |
|---|---|---|
| `entry.ts` | `Foundry.Runtime` (exe) + `StdioTransport` | S / low |
| `service.ts`, `execution-slots`, `feature-admission` | `RuntimeService`, `RpcRouter` | L / high |
| `store`, `schema`, `automation-schema`, `continuity-schema`, ledgers, `usage-accounting` | `Runtime.Data` (reuse `Store.recover()` `store.ts:423-464` and `upgradeToCurrent` `store.ts:98-147` semantics verbatim) | L / high |
| `backup-protection` | `Platform.ProtectedDirectory`: `CreateDirectoryW` with the descriptor, so no inherited-access window exists; the DACL is re-stamped for the auto-inherited flag; same SDDL and verification as `backup-protection.ts:33-40` | S / med |
| `workspace-queries`, `workspace-operations`, `continuity`, `mcp-config`, `mcp-repair`, `profile-fingerprint` | `Runtime.Queries`, `Operations`, `Continuity` (SQL text reused verbatim) | L / high |
| `repository`, `git-operations`, `git-environment`, `scope` | `Runtime.Git`, `Runtime.Files` (git CLI via `JobProcess`, `FinalPath`, reparse checks) | XL / high |
| `command-runner` + `job-runner.ps1` | `Runtime.Exec` + `Platform.JobProcess` | M / high |
| `mcp` + `mcp-host.ps1` | `Runtime.Mcp` + `JobProcess` | L / high |
| `hook-runner`, `automation` | `Runtime.Automation` (PowerShell only) | L / high |
| `tool-runtime`, `tool-definitions`, `redaction`, `browser-tools`, `channel-tools`, `orchestration-tools`, `agent-channel`, `compaction` | `Runtime.Agent.*` | M–L / med |
| `agent-loop`, `orchestrator`, `orchestration-records` | `Runtime.Agent.Loop`, `Orchestrator` (async generators become `IAsyncEnumerable`) | XL / high |
| `providers/index.ts` | `Providers.Azure`: HttpClient with `AllowAutoRedirect=false`, `UseCookies=false`, no certificate callback, `ResponseHeadersRead`; `SseParser` over a counting stream that keeps today's caps; strict ASCII host-suffix allowlist (`providers/index.ts:11,476`) | L / med |
| fake / orchestration / browser fixtures | `Providers.Fixtures`. Shipped product code; E2E and smokes depend on it. | M / med |
| `credentials.ts`, `supervisor.ts`, `notification-preferences.ts`, `index.ts` | `Host.DpapiVault`, `RuntimeSupervisor`, `Preferences`, `BridgeGate` | M / med |
| `browser-manager.ts` | `Host.Browser` + `Desktop.WebView2Surface`. `SNAPSHOT_SCRIPT` and `TARGET_SCRIPT` (`:29-63`) reused verbatim. | XL / high |

### 3. Desktop host (`Foundry.Desktop` + `Foundry.Host`)

**Main-process policy, ported unchanged**
- Lazy per-profile credential load bound to `[apiKind, endpoint, deployment]` (`index.ts:90,131-146`).
- Browser attach preconditions checked through runtime RPC (`index.ts:95-110`).
- Revoke attachments on cancel and retire (`index.ts:120-124`).
- Credentials travel only host→runtime over stdio, never to the renderer.

**RuntimeSupervisor**
- Spawns `Foundry.Runtime.exe` through `JobProcess` inside a KILL_ON_JOB_CLOSE job.
- Env allowlist as `supervisor.ts:21-22`, minus `ELECTRON_RUN_AS_NODE`, plus `FOUNDRY_WORKSPACE_DATA`.
- 120 s request timeout and at most 32 concurrent browser calls. A malformed line kills the transport.
- No auto-restart: on exit it emits `runtime.stopped`, as today.
- Close sequence: stdin EOF, a 45 s graceful drain, then job kill.

**Single instance and dialogs**
- A `Local\` mutex plus an activation event carrying a GUID payload only. Toast and second-instance arguments are untrusted: they can only navigate.
- `OpenFolderDialog` and `SaveFileDialog`. Tabs stay hidden while a dialog is open (`index.ts:151`).

**Toasts.** Use WinRT `ToastNotificationManager` with HKCU AUMID registration. In-process `Activated` focuses the window and routes, as `index.ts:62-63` does. If spike S6 fails, fall back to the in-app Inbox plus a taskbar flash.

**Process hygiene**
- Manifest: `asInvoker`, PerMonitorV2, `longPathAware`. Refuse to run elevated (token check).
- Show the window after the first `NavigationCompleted`.
- No WER local dumps. The unhandled-exception handler never serializes params. Runtime stderr stays dropped (`supervisor.ts:28`).

**Data root (release)**
- `SHGetKnownFolderPath(LocalAppData)\FoundryAgentWorkspace`.
- Validated: absolute, local fixed drive, not UNC, no reparse points, owned by the current user.
- Overrides such as `FOUNDRY_WORKSPACE_TEST_DATA` work only in Debug and E2E builds (parity with `index.ts:21`).

**WebView2 runtime.** Check Evergreen availability at startup and show a clear error if it is missing. On `NewBrowserVersionAvailable`, prompt for a restart.

**Policy kept as-is (port, don't fix).** Credential re-entry clears profile verification (`service.ts:152,163`). After cutover each real profile therefore needs one paid connection test, and a test after every restart, exactly as today. The port keeps this fail-closed rule.

### 4. App UI WebView2 and bridge

**Environment and assets**
- Environment `webview2\ui` registers the `foundry-app` custom scheme (`HasAuthorityComponent`, `TreatAsSecure`) before the environment is created.
- Assets are embedded in `Foundry.exe` and served from `WebResourceRequested` with correct MIME types (`text/javascript` for modules). Unknown paths return 404.

**Response headers**
- `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. This drops today's `'unsafe-inline'` and `ws://localhost:*` from `index.html:6`.
- `X-Content-Type-Options: nosniff`.

**Vite build.** `modulePreload.polyfill=false`, `assetsInlineLimit=0`, `base '/'`, no release source maps. The dev server is reachable only under `#if DEBUG`, with localhost validation as in `index.ts:80` and a separate dev CSP.

**Settings and denials**
- `AreHostObjectsAllowed=false`, `AreDevToolsEnabled=false` in release, and default context menus, script dialogs, browser accelerator keys, autofill and password save all off.
- Zoom stays enabled; the host maps it into browser bounds.
- `NavigationStarting` cancels everything except the initial app URI and same-document changes.
- `FrameCreated` and `FrameNavigationStarting` are denied.
- Handled or denied: `NewWindowRequested`, `PermissionRequested`, `LaunchingExternalUriScheme`, `ScreenCaptureStarting`, `DownloadStarting`.

**Bridge shim.** `ui/src/bridge/` replaces `preload/index.ts`. It is TypeScript, tested with vitest, and implements DesktopApi over `chrome.webview.postMessage` with request ids. The exported object is frozen and message size is capped.

**BridgeGate** (pure and unit-tested). Gate order:
1. Read with `TryGetWebMessageAsString` only, capped at 1 MiB.
2. On every message, `Source` must equal the exact app URI.
3. Track the document generation, resetting it on `NavigationStarting` and `ProcessFailed`.
4. Accept `hello`, carrying a per-document nonce, only after `NavigationCompleted` on the app URI.
5. Check the closed method allowlist.
6. Run strict validation, then dispatch.

Host-to-page `PostWebMessageAsJson` is sent only after a `Source` check. A message from any frame is fatal: the host reloads the app document.

### 5. WebView2 lock-down (P0 risk). Environment variables and policies override API arguments for non-elevated apps (verified).

**Before the first WebView2 call**, read and clear:
- `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`
- `WEBVIEW2_USER_DATA_FOLDER`
- `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER`
- `WEBVIEW2_RELEASE_CHANNEL_PREFERENCE`
- `WEBVIEW2_CHANNEL_SEARCH_KIND`

**Policy keys.** If HKCU or HKLM `Software\Policies\Microsoft\Edge\WebView2` has values, a release build refuses to start with a clear message. Debug builds only warn.

**Child process scan.** Pass explicit benign `AdditionalBrowserArguments`. After environment creation, scan the `msedgewebview2.exe` child command lines and fail closed if any contains:
- `remote-debugging`, `remote-allow-origins`, `auto-open-devtools-for-tabs`
- `disable-web-security`, `no-sandbox`, `disable-site-isolation-trials`
- `ignore-certificate-errors`, `allow-running-insecure-content`, `allow-insecure-localhost`, `allow-file-access-from-files`, `unsafely-treat-insecure-origin-as-secure`
- `log-net-log`, `net-log-capture-mode`, `enable-logging`
- `proxy-server`

**E2E configuration** builds `Foundry.E2E.exe`, which is never published.
- Debug switches are passed through the API only, never env.
- CDP binds 127.0.0.1 on random ports on both environments.
- It uses its own mutex and AUMID.
- It refuses to start without an explicit data root under a temp tree.
- It exposes `test.*` bridge methods (`#if E2E`) with a separate `.d.ts`.

**Release artifact audit (CI)**
- None of these ships: `Foundry.E2E`, `test.` method strings, E2E types, `node.exe`, Electron files.
- DevTools are off.
- With `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=…` set, no port listens.

### 6. Integrated browser

**Environment and tabs**
- A separate environment and UDF, `webview2\browser`, runs as a separate browser process and registers no custom scheme. Profile `workspace-browser-v1`, at most 20 tabs.
- One HWND WebView2 per tab, positioned at CSS px × the UI `ZoomFactor`, rounded per DPI.
- Re-sync on `ZoomFactorChanged`, `RasterizationScaleChanged` and resize. Tabs hide during confirmations and dialogs (`BrowserPanel.tsx:63`).

**Tab webviews.** `IsWebMessageEnabled=false`, no host objects, DevTools, menus, autofill or password save, and no document-created scripts. Pages have no host channel.

**Handlers**
- `PermissionRequested` and `LaunchingExternalUriScheme`: deny.
- `BasicAuthenticationRequested` and `ClientCertificateRequested`: cancel.
- `ServerCertificateErrorDetected`: deny, no bypass.
- `NavigationStarting`: redirect guards allow http/https only, no userinfo, and keep the `pendingOrigin` logic.
- `NewWindowRequested`: with a deferral, adopt the popup as a tab via `NewWindow` (opener preserved).
- `DownloadStarting`: with a deferral, show `SaveFileDialog`; cancel when the tab is attached.
- `ProcessFailed`: detach and show the error.

**CDP** via `CallDevToolsProtocolMethodAsync`:
- `Page.createIsolatedWorld` with `grantUniveralAccess:false`, the protocol's spelling.
- `Runtime.evaluate` of the fixed host-authored scripts only.
- `Page.setInterceptFileChooserDialog`, with a receiver for `Page.fileChooserOpened`.
- Per-origin clearing via `Storage.clearDataForOrigin` plus `CookieManager`. Whole-profile clearing via `ClearBrowsingDataAsync`.

**Upload control.** Source-level controls first:
- file-chooser interception
- the selected-file precheck (`browser-manager.ts:254-257`)
- `AllowExternalDrop=false` while attached

Second, a three-argument `WebResourceRequested` filter with `SourceKinds` blocks multipart and octet-stream bodies while attached. Worker kinds are registered on one webview per environment.

**Agent/human input ladder.** Every layer must succeed, or the attach is refused:
1. `EnableWindow(false)` on the tab host HWND.
2. Move keyboard focus out of the tab and make the host non-focusable.
3. An owned layered overlay (alpha 1/255) over the tab. Any pointer, wheel or touch event means take control.
4. CDP `Input.setIgnoreInputEvents(true)`.
5. `AcceleratorKeyPressed` for key chords.

On take control, bump the generation and detach first, then re-enable the window. The isolated-world `isTrusted` sentinel stays in reserve.

Accepted residuals: UIA invocations bypass the ladder, and screen-reader users cannot use the pane while it is attached. If spikes S3 or S4 miss their exit criteria, ship with **Attach to chat** disabled (decision 7).

**Prepared actions.** One-shot; bound to generation, origin and attachment; TTL 10 min; at most 32 per tab. Ported as pure logic.

### 7. Credential vault

**Storage**
- DPAPI `ProtectedData` (CurrentUser). The entropy is a SHA-256 over a domain tag and the length-prefixed id and binding, so the fields cannot run into each other. `ProtectedSecret` rejects anything but 32 bytes.
- Files at `credentials-v2\<uuid>.bin` containing `{value, binding}`. The binding is re-checked after decrypt, which also rejects a substituted machine-scoped blob: DPAPI decrypts those too, and entropy binds context without authenticating anything.
- Write: `ProtectedSecret.WriteAtomically`, which creates a temporary file with `CreateNew`, calls `Flush(true)`, then renames it over the target with a write-through `MoveFileEx`.
  - The vault verifies its directory before writing.
  - At startup it sweeps orphaned `.<name>.*.tmp` files.
- An explicit protected DACL (owner plus SYSTEM) is verified; the vault fails closed if it doesn't hold.

**Handling**
- The secret is handled as a UTF-8 `byte[]`, zeroed after use, and never logged.
- The legacy `credentials\` folder is never read or deleted. The UI says "re-enter key".

### 8. Process execution

**`Platform.JobProcess`**
- `CreateProcessW` with `EXTENDED_STARTUPINFO_PRESENT`, `CREATE_SUSPENDED`, `PROC_THREAD_ATTRIBUTE_JOB_LIST`, and a mandatory `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`. The handle list fixes today's full inheritance at `job-runner.ps1:83`.
- KILL_ON_JOB_CLOSE, no breakaway.
- The runtime owns the job handles, so the kernel kills the trees if the runtime dies. This replaces the 50 ms polling.
- Timeout and cancel go through `TerminateJobObject`. Cleanup counts as verified when `ActiveProcesses==0` within 5 s, as today.
- Every launch goes through `JobProcess`. `System.Diagnostics.Process` is banned in every product project (`src/BannedSymbols.Launch.txt`). A redirected `Process.Start` inherits every inheritable handle, including the child pipe ends, which `JobProcess` makes inheritable only for the duration of `CreateProcess` (proven in spike S7).
- `JobProcess` launches only an `.exe` given by a fully qualified path, and rejects NUL in any string. `CreateProcessW` hands `.bat` and `.cmd` files to `cmd.exe`, whose parsing differs from the caller's quoting, so a batch file needs an explicit `cmd.exe` command line with cmd escaping. The MCP configuration already requires an absolute `.exe` (`mcp.ts:300`).
- "Cleanup verified" means the job is empty. Work handed to COM, WMI, Task Scheduler or a service runs outside any job.

**Commands**
- Commands keep Windows PowerShell 5.1 and `-EncodedCommand` exactly as reviewed (`command-runner.ts:170-178`).
- The environment block is sorted case-insensitively.
- `Quote()` (`mcp-host.ps1:75`) is ported verbatim and fuzzed against `CommandLineToArgvW`.
- The env denylist gains `DOTNET_*`, `COMPLUS_*`, `COR_*`, `CORECLR_*`, `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`, `PYTHONPATH`, `PYTHONSTARTUP`, `PERL5OPT`, `RUBYOPT` and `__COMPAT_LAYER`.

**MCP servers and PowerShell hooks/scripts** are launched natively by `JobProcess`.
- In-process calls replace the `%TEMP%` spec, result and cancel files.
- `job-runner.ps1`, `mcp-host.ps1` and the per-command `Add-Type` compile are deleted.

**JavaScript scripts and hooks.** New registrations are rejected. Existing JS revisions round-trip but show "interpreter unavailable" and never run.

## Data compatibility, adoption and rollback

### Before cutover (P1–P4)
- Through P3 the .NET runtime matches TS at **v5**, with identical `sqlite_master`. P4 turns on v6, which is v5 plus `runtime_meta`, for fresh databases and adoption.
- It opens a writable Store only in three cases:
  - no DB (fresh);
  - a fenced v6 DB (P4+);
  - an existing un-fenced DB in a directory that is **not the real data root**, compared by `FinalPath` against the known-folder root.

  Anything else enters adoption-pending. The real data directory therefore can never be opened writable before adoption, and E2E temp directories need no edits to the specs.
- Rehearsals use a copy made with the backup API, in an owner-only scratch directory, with `FOUNDRY_REHEARSAL=1`. That flag forces adoption-pending, so the adoption itself is rehearsed. It also disables all repository, git and command execution, because those tasks still point at the real worktrees.

### Runtime states: Probe → AdoptionPending → Normal

**AdoptionPending** opens only a read-only classifier (`Mode=ReadOnly`, `query_only`). It creates no Store, timers or automation, and never runs `recover()`.

Allowed RPCs (a planned protocol delta in P4):
- `workspace.schema`, extended with adoption status: version, row counts, free space, exclusion state, a `path_key` mismatch report, and the MCP dry-run.
- `workspace.adopt`, with a confirm literal.

Everything else returns a typed `adoption-pending` error.

Classification:

| DB state | Result |
|---|---|
| No file | Create a v6 DB (P4+) |
| `user_version` 0 with a `tasks` table | Legacy v1. Do not write `user_version`. |
| `user_version` 1–5 | Pending |
| v6 with `runtime_meta` | Normal |
| Above 6 | Refuse |

### Exclusion

Any "busy" signal blocks adoption.
1. A `FileShare.None` open probe of `workspace.db`, `-wal` and `-shm`. Non-mutating; spike S10.
2. Chromium's `lockfile` in the data directory. Advisory, UNVERIFIED.
3. A scan for Electron processes. Advisory.
4. An exclusive locking-mode probe. Corroborating only.

After the check passes, the app holds a `Local\` mutex and a `FileShare.None` lockfile for the runtime's lifetime.

### `workspace.adopt`

Each phase writes the journal `adoption\adopt-<id>.json` via temp file, fsync and rename.
1. **Preflight**:
   - free space at least 2× (db + wal)
   - `integrity_check` and `foreign_key_check`
   - row counts and `data_version`
   - recompute every `path_key` and report mismatches; never rewrite them silently
   - MCP sanitizer dry-run, which must show zero newly quarantined servers
2. **Backup directory**: create it with the protected ACL atomically and verify the ACL.
3. **Backup**: run `BackupDatabase`.
4. **Verify the copy** read-only:
   - `integrity_check` is ok
   - `user_version`, row counts and normalized `sqlite_master` match
   - `sqlite_sequence` matches
   - the source `data_version` is unchanged
5. Hash the backup and journal `backup-verified`.
6. **Migrate** in one `Immediate` transaction:
   - run any missing v≤5 steps (`store.ts:111-143`);
   - create `runtime_meta` with the adoption id, source version, backup hash and the count of revoked grants;
   - revoke every script grant, mark revisions untrusted, and write `automation_grant_history` rows with reason `runtime-migrated`;
   - require `foreign_key_check` to come back empty;
   - set `user_version=6` last.
7. Journal `fenced`.
8. **Construct the Store.** `recover()` runs:
   - pending intents and starts become unknown
   - waiting approvals are revoked and executing ones become unknown
   - reservations become retained
   - running tasks become interrupted
9. Journal `complete`.

**Crash mid-adoption.** The journal plus `user_version` decide:
- v6 with a matching adoption id means the migration committed: finish the journal.
- v5 or lower means the transaction rolled back: keep the verified backup and return to pending.

### Rollback
1. Close the app and call `ClearAllPools`.
2. Restore the verified backup and delete `-wal` and `-shm`.
3. Reinstall the last Electron build.

Data created after the cutover is lost by design (decision 3). Worktrees created after the cutover are listed for manual cleanup and are never auto-retired. Backups stay under the protected ACL until the user deletes them.

## Sequencing (single cutover)

**Program rules**
- **Freeze:** the protocol and runtime features are frozen from P0 to cutover, except planned deltas (adoption RPCs, JS removal) in P4.
- **Hotfixes:** security and data-loss fixes land in both TS and C# and are tracked on a hotfix list.
- **Shipping:** Electron `main` stays shippable throughout. Nothing user-visible changes before P5.
- **PRs:** every increment is a reviewable PR on a task branch with its own validation.
- **Reviews:**
  - Independent security review in each phase that touches credentials, IPC, filesystem or process code.
  - Data review for the Store work and for adoption.
- **Status:** tracked in `docs/implementation-status.md`.

| Phase | Scope | Exit gate | Est. (solo + AI, ±40%) |
|---|---|---|---|
| **P0 Foundations & spikes** | Commit this plan as `docs/wpf-webview2-migration.md` (the decision record lives inside it). .NET skeleton and CI job (analyzers, lock files, boundary tests). stdio trace recorder. Golden corpus: 86 methods plus 5 non-RPC frames, valid and invalid, including parser-differential cases (duplicate keys, `__proto__`, >2^53, lone surrogates, `-0`, deep nesting). `ui/src/limits.ts` so the renderer drops zod (landed as the import-free `packages/protocol/src/limits.ts`, which moves with the UI). Fixture DBs v1–v5, an uncheckpointed-WAL v5, and `expected-after-open.json` contracts, all from the TS runtime via RPC scenarios (~3.5 MB). Node golden vectors (JsJson hashes, `path_key`, schedules, regex). Spikes S1–S10. | Spike decisions recorded; S7 and S8 passed; fallbacks decided for any failed host spike | 4–5 wk |
| **P1 Contract & platform** | `Foundry.Protocol`, `Foundry.Platform`, `RuntimeLoop`, Store (helper, outbox, pragmas, DDL, classifier, adoption-pending, fence code), `workspace.summary` read path | Corpus agrees 100% with zod. Fixtures open with identical normalized dumps. Structure diff equal. Ported Platform security tests green. | 4–5 wk |
| **P2 Runtime port under Electron** | Security suites ported first, then slices: store/projects/tasks + fake provider → git/files → commands/approvals → Azure providers → MCP → orchestrator → automation/continuity/usage/channel → browser tools. ~10-line supervisor switch (`FOUNDRY_RUNTIME=dotnet`, unpackaged only). | Unchanged Electron E2E, `packaged-smoke.mjs` and `expansion-smoke.mjs` green on `Foundry.Runtime.exe`. Differential traces equal. xUnit ports green. Security suite green against both runtimes. | 16–22 wk |
| **P3 WPF host** | Shell, bridge, lock-down, vault, dialogs, toasts, browser surface with input ladder, E2E build with `test.*` hooks. E2E specs ported (launcher and hooks only). Developed against the TS runtime (dev-only Node via `FOUNDRY_RUNTIME_COMMAND`, Debug/E2E) and then the .NET runtime. May overlap the last P2 slices. | All 21 tests in 8 specs green on WPF+TS and WPF+.NET, including `browser.spec` at 100/150/200% DPI and zoom 2. No CSP violations. Bridge and lock-down negatives green. | 9–12 wk |
| **P4 Integration, packaging, rehearsal** | `build.ps1`; self-contained folder publish (R2R, no trimming, no single-file; the runtime in its own `runtime\` subfolder per spike S1); ZIP + SHA-256 + CycloneDX SBOM; Inno Setup installer; rewritten clean-install verification; artifact audit; v6 enabled; adoption UI on the existing upgrade-banner pattern, with the legacy-v1 E2E (`orchestration.spec.ts:262`) moved to the adoption flow; JS removal in UI and protocol; adoption rehearsal on a copy of real data; release evidence re-run; docs rewrite | The 9-criterion evidence matrix re-earned. Rehearsal report: integrity ok, equal row counts, only `recover()` rows changed, zero `path_key` mismatches, zero new MCP quarantines. Independent security and data reviews GO. | 3–4 wk |
| **P5 Cutover** | The user adopts the real data directory through the UI. Then delete `apps/desktop/src/main`, `preload`, `packages/runtime`, `packages/providers`, the protocol zod, better-sqlite3, electron, electron-builder, electron-vite and the PowerShell helpers. Protocol authority flips to C# (`JsonSchemaExporter` → `ui/src/protocol/generated.d.ts`). CI runs a single path. | Post-cutover smoke on real data; artifact audit clean; CI green | 1 wk |

**Total ≈ 37–49 weeks.** Re-baseline after P0.

**Blocking order (Seat B, aligned to phases)**
- Before P1 code: S7 (Platform design) and S8 (SQLite parity and STJ strict-option choice).
- Before P3: S1–S6 and S9. S3/S4 can also resolve through decision 7.
- Before P4: S10.

## Spikes (P0)

| # | Question | Exit criterion |
|---|---|---|
| S1 | Do two self-contained apphosts share one folder? Does the runtime start without WPF? How fast is a cold start? | The runtime smoke runs from the shared folder; sizes and times recorded |
| S1 | Result (2026-10-08): `dotnet publish -c Release -r win-x64 --self-contained`, with and without `PublishReadyToRun`, of `Foundry.Runtime` and `Foundry.Desktop` (the P0 placeholders) into separate folders and into one shared folder. SDK 10.0.300 bundles runtime pack 10.0.8.<br>**Runtime without WPF:** yes. Its runtimeconfig includes only `Microsoft.NETCore.App`, its deps.json names nothing from WindowsDesktop, and it runs from a folder without WPF.<br>**Sizes (R2R):** runtime 201 files, 76.8 MB (34.1 MB zipped); desktop 406 files, 139.4 MB (60.1 MB zipped); one shared folder 415 files, 139.7 MB (60.2 MB zipped).<br>**Start to exit, placeholder apps:** runtime 121–229 ms on the first run, 61 ms warm median; desktop (WPF start-up, then `Shutdown`) 373–452 ms first, 250 ms warm. ReadyToRun makes no measurable difference for an empty `Main`.<br>**Sharing:** the folder works mechanically, but the two closures disagree on two files:<br>• `WindowsBase.dll`: a 16 KB `Microsoft.NETCore.App` facade (assembly 4.0.0.0) for the runtime, WPF's 2.1 MB assembly (10.0.0.0) for the desktop.<br>• `System.Security.Cryptography.ProtectedData.dll`: the 10.0.12 package for the runtime, WindowsDesktop's 10.0.8 copy for the desktop.<br>Publish copies the newest file, so the shared folder kept WPF's `WindowsBase` and the package's `ProtectedData`. Each app then runs a file its deps.json did not select, and the outcome depends on timestamps. | Met. **Decision:** P4 publishes the runtime self-contained into its own `runtime\` subfolder, costing 76.8 MB unpacked and 34 MB zipped. A shared folder saves that only with reconciliation (move DPAPI from `Platform` to `Host` so the runtime closure has no `ProtectedData`, publish the desktop last, and have the artifact audit check every shared file against both closures). Revisit only if download size matters. |
| S2 | Bridge rig: custom-scheme header CSP enforced; `Source` values; iframe, popup and redirect messages; env/registry neutralization; child command-line scan | Bad-origin, subframe, oversized and malformed messages never reach dispatch; no debug port under any override |
| S3 | Tab bounds under DPI and zoom | At most 1 device px of error at 100/125/150/200% and zoom 2; hidden behind modals |
| S4 | Input ladder, driven by a separate harness (SendInput, InjectTouchInput, IME, Ctrl+V/Win+V, OLE drag, UIA `SetValue`) | Zero events reach the page except UIA (documented); detach under 100 ms; disabled HWND renders correctly. Otherwise apply decision 7. |
| S5 | CDP and event parity: isolated worlds, file-chooser interception, `clearDataForOrigin`, request bodies and workers, `NewWindow` opener, `DownloadStarting` deferral, cert/auth denial | Every `browser.spec` scenario reproducible, or the gap recorded with a source-level control |
| S6 | Toast click activation from the unzipped exe and the installed exe | Works, or the fallback ships |
| S7 | `JOB_LIST` + `HANDLE_LIST` in a nested job; tree death on runtime kill; decoy handle not inherited; `FinalPath` versus `realpathSync.native`; managed ACL equals the PowerShell SDDL; DPAPI atomic write | Process-cleanup tests (`security-audit.test.ts:799-855`) pass natively; corpus parity |
| S7 | Result (2026-10-08): `tests/Foundry.Platform.Tests` (62 tests) proves the four `Foundry.Platform` primitives.<br>**`JobProcess`:** the TypeScript cleanup scenarios pass natively: terminate (the timeout and cancel path), a background grandchild after a normal exit, and dispose. Killing a real owner process (`Foundry.Platform.TestProbe`, which stands in for the runtime and runs inside an enclosing job) reclaims its nested tree while the enclosing job stays open. Cleanup verifies within 5 s. A decoy inheritable handle is not inherited, and concurrent launches never share pipe ends; a redirected `Process.Start` does inherit the decoy, so `System.Diagnostics.Process` is banned in all product code.<br>**`FinalPath`:** agrees with Node 24's `pathKey` on every corpus path, and its lowercase agrees with V8 on 1,092 vectors (see `path_key` above).<br>**`ProtectedDirectory`:** its on-disk owner, group and DACL (`D:PAI`) equal the result of `backup-protection.ts`'s PowerShell; extra, deny, uninherited and unprotected rules and junctions fail verification.<br>**`ProtectedSecret`:** an 8 KiB secret round-trips; other entropy, a tampered blob and a non-digest entropy fail; an injected failure and a locked target both keep the old file and leave no temporary file.<br>Removing `HANDLE_LIST` or `KILL_ON_JOB_CLOSE`, or checking cased before case-ignorable for the final sigma, fails the tests meant to catch it.<br>The independent security review (Sonnet, high) returned a conditional GO. Every condition is addressed in this result: the child pipe ends are inheritable only during `CreateProcess`, with the ban widened to all product code; `TryResolve` fails closed for scope checks; entropy must be a digest; the application must be an `.exe` with no NUL; the job closes first on dispose; the lowercase tables are pinned. | Met. **Adopt** the primitives. The interop is hand-written `LibraryImport` (the plan's fallback to CsWin32). The vault's owner-plus-SYSTEM descriptor (section 7) is a P3 parameter; S7 proved the mechanism with the backup descriptor. |
| S8 | SQLite parity: compile options and version, FTS5, the `json_extract` expression index, ~280 captured statements, `BackupDatabase` on a WAL DB, read-only open with a leftover `-wal`; STJ option set plus the parser-differential corpus | Identical results; backups verify |
| S8a | Result (2026-10-08): `tests/Foundry.Runtime.Tests` runs every query recorded by `tests/golden/sqlite-engine.test.ts` against copies of all six era fixtures and gets identical rows. Covered: the real search statement, FTS5 `unicode61` (CJK, prefix, accent folding), both index plans (`intents_task_json`, `tasks_root_created`), JSON, number and date functions, and the double-quoted-literal error. Also verified: `BackupDatabase` of a live WAL database, and a read-only open that sees committed WAL pages. The only semantic compile-option difference is `DEFAULT_WAL_SYNCHRONOUS` (FULL versus NORMAL), made moot by the explicit `synchronous=FULL`. better-sqlite3 hands integers above 2^53 to TypeScript rounded, so parity compares numbers as doubles; the runtime stores no such values. The captured-statement replay moves to the P1 Store tests, which execute the real SQL. | Met. **Adopt** Microsoft.Data.Sqlite 10.0.12 with its default bundle. |
| S8b | Result (2026-10-08): `tests/Foundry.Protocol.Tests` runs all 15 cases in `rpc-wire.json` through the candidate strict reader on both host paths (bridge strings, stdio UTF-8 bytes). Rejected: duplicate keys, `__proto__`, nesting deeper than 32, numeric ids, BOM, trailing comma, comment, `NaN` and top-level arrays, and the three cases this spike decided (`4.0`, `4e0`, lone-surrogate escapes). Accepted: an escaped method name. A test pins why the stdio path checks the BOM explicitly: stream reads skip it. | Met. The corpus records every decision; no case remains open. |
| S9 | Does `windows-2025` have the WebView2 runtime? Can Playwright `connectOverCDP` attach to both environments? | A green E2E skeleton in CI |
| S10 | `FileShare.None` probe against a live idle Node holder; Chromium lockfile behavior; `ClearAllPools` and restore on Windows; Inno Setup in CI (preinstalled, or a pinned and hash-verified install) | "Busy" reliably detected; restore works; installer builds |

## Verification strategy

The evidence layers are independent; none substitutes for another.

1. **Contract.** The golden corpus runs in vitest (zod) and xUnit (C#) and must agree 100%.
2. **Unit.** xUnit ports of `packages/runtime/tests`, `packages/providers/tests` (`HttpMessageHandler` fakes, never live calls) and the main-process tests: `BridgeGate`, supervisor, and browser policy over `IBrowserSurface` fakes. New tests:
   - loop invariants, the transaction helper and the outbox (rollback drops events)
   - JsJson vectors, `path_key`, schedules, regex
   - FsCheck ledger models, including the 40-way reserve test (`orchestration-store.test.ts:250-265`)
   - architecture boundary tests
3. **Conformance and differential** (black-box over stdio):
   - `scripts/packaged-smoke.mjs` and `expansion-smoke.mjs` run unchanged except for the launcher.
   - The ~120 tests in `tests/integration` become stdio scenarios run against both runtimes.
   - Comparison is normalized: ids and timestamps masked, JSON canonicalized, committed `events` rows compared. Rollback scenarios are .NET-only.
   - `scripts/runtime-trace.mjs` (P0) records a driver's stdio conversation in both directions, plus stderr and exit, as JSON lines. It is a tap inside the driver rather than a proxy process, so killing the child still kills the runtime.
     - It observes what the driver writes to a live stream and what the driver reads, by wrapping `emit` rather than adding a listener, so it never changes when the driver reads.
     - It never throws into the driver. The first failure stops recording, and `close()` returns it.
     - Credential values never reach the file:
       - `runtime.credential` frames are redacted, with the binding kept only as a digest;
       - host lines that do not parse are recorded by size only;
       - any later echo of a credential value is scrubbed.
     - It writes a new file only (never appending to an earlier run), for example under the git-ignored `test-results/`.
     - `normalizeTrace` and `node scripts/runtime-trace.mjs compare` drop timings. They number UUIDs, digests and git object ids by first appearance, mask millisecond timestamps (another precision stays visible) and scratch roots, and sort keys. Hash values themselves are pinned by `tests/golden`, not by traces. `compare` refuses an empty trace, or one without the runtime's exit.
     - `FOUNDRY_RUNTIME_TRACE=<prefix> pnpm smoke:package` records one trace per runtime launch.
   - P0 finding: two runs of the packaged smoke against the same TypeScript runtime diverge after 139 normalized records.
     - Polls observe racing intermediate states.
     - Concurrent children interleave their events.
     - The event count itself varies (324 versus 325).
     So trace equality is defined only for deterministic scenarios: sequential steps that wait on events rather than polling, one active child at a time or per-task event streams, and fixed fixture names and tokens. Timing-dependent suites compare committed rows.
4. **Data.**
   - Fixture DBs v1–v5 and the WAL fixture through open, upgrade and fence; structure diff; `expected-after-open.json` contracts (`tests/fixtures/databases`).
   - Fault points: after intent, before commit, mid-backup, mid-adoption. Process-kill tests.
   - Performance at 1000 tasks / 100k messages, generated at test time.
   - WAL restore flow.
5. **Security.**
   - Port `security-audit.test.ts` and `security.test.ts` 1:1: `BridgeGate` replaces IPC authorize, plus path normalization, the canary/leak matrix and process cleanup.
   - Add WebView2-specific negatives:
     - spoofing from iframes and from the integrated browser, and app-navigation attempts (`location=`, meta refresh, `window.open`, `target=_blank`)
     - oversized, malformed and duplicate-key messages, and messages before `hello`
     - `ProcessFailed`
     - canaries in logs, events, renderer messages, exports and stderr; legacy `credentials\` left untouched
     - upload and download blocked while attached; no `chrome.webview` in tabs; external URIs denied; CDP unreachable in release
     - decoy DLL; the `WEBVIEW2_*` env test
   - Run against both hosts and both runtimes at each seam.
6. **E2E.**
   - The 21 Playwright tests connect to `Foundry.E2E.exe` via `connectOverCDP`.
   - `test.*` hooks replace roughly 30 `app.evaluate` uses: window size, zoom, dialog stubs, browser views and targets.
   - `browser.spec` runs at 100/150/200% DPI.
   - Tests fail on any `securitypolicyviolation`. Screenshots go to `test-results`.
7. **Package.**
   - Run the release artifact audit.
   - Smoke the published `Foundry.Runtime.exe` over stdio with a temp data dir.
   - Run the desktop clean-profile smoke only on the ephemeral CI runner or in Windows Sandbox, because the release exe uses the real LocalAppData.
   - Verify the installer: per-user, no elevation, app data kept on uninstall.
   - Check ZIP checksums.
8. **Adoption rehearsal.** On a backup-API copy in rehearsal mode; produces the P4 report.
9. **Live (operator gate, unchanged).** `profile.probe` against real Foundry deployments using the C# adapters. `scripts/qualify-deployments.mjs` stays a standalone dev tool.

**End-state commands** (AGENTS.md validation section updated to match)
```
pwsh ./build.ps1 check      # dotnet build -warnaserror + dotnet test + ui typecheck/lint/vitest + corpus
pwsh ./build.ps1 e2e        # builds Foundry.E2E.exe, runs Playwright
pwsh ./build.ps1 package    # pnpm --dir ui build -> dotnet publish -> ZIP + SHA-256 + SBOM -> iscc installer
pwsh ./build.ps1 smoke      # runtime stdio smoke + artifact audit (+ clean-profile smoke in CI)
```

**CI** runs on `windows-2025` with SHA-pinned actions: `setup-dotnet` via `global.json`, pnpm, `restore --locked-mode`, NuGet audit, the four targets, then upload of the ZIP, installer and SHA-256. During P2–P4 the matrix also runs four combinations: Electron+TS (baseline), Electron+.NET, WPF+TS (dev), and WPF+.NET.

## Top risks

| Pri | Risk | Mitigation |
|---|---|---|
| P0 | Loop affinity lost, causing duplicate admission or settlement | RuntimeLoop, analyzers, `IsCurrent` assertions, stress tests |
| P0 | Bridge caller identity (iframes, navigation, XSS) | Custom scheme, `Source` checked per message, generation-bound `hello`, CSP, frames denied, negative tests |
| P0 | `WEBVIEW2_*` env or policy opens CDP or weakens the sandbox | Lock-down plus artifact audit |
| P0 | Unmodeled JSON properties dropped; WAL mishandled in backup or restore | Round-trip persisted models and fixtures with extra properties; `BackupDatabase` only; `ClearAllPools` |
| P0 | Parity drift while TS still changes | Freeze, traces, differential harness, hotfix list |
| P1 | Hash, `path_key`, regex or timestamp drift on adopted data | JsJson with golden vectors; `path_key` corpus and preflight report; ECMAScript regex and MCP dry-run; `Clock.Iso` |
| P1 | The old Electron build opens the adopted DB | Exclusion layers plus the v6 fence |
| P1 | Input-control and upload-block gaps | The ladder, source-level controls, spikes S4/S5, fail closed (decision 7) |
| P1 | Effort overrun in P2 or S4 | Gated slices; Electron remains the product; re-baseline after P0 |
| P2 | Evergreen drift, toast delivery, WebView2 availability in CI | Restart prompt, fallback, S9 |

## Documentation updates (P4/P5)

- `AGENTS.md`: boundaries for `ui/` and `src/Foundry.*`, host-versus-runtime rules, WebView2 lock-down, the PowerShell-only scripts rule, new validation commands.
- `README.md`.
- `docs/foundry-agent-workspace-plan.html`: amend the baseline from Electron to WPF/WebView2 (19 mentions).
- `docs/implementation-status.md`.
- `docs/recovery.md`: rewrite as a runbook. Today it is stale (`.bak`, `.enc`, `task.reconcile`).
- `docs/signing-and-distribution.md`: ZIP plus Inno Setup; sign every PE and the installer; unsigned builds are not releasable beyond the team.
- `docs/release-evidence.md`.
- `docs/personal-workspace-expansion.md`: script languages.
- The workflow, the smokes, `verify-clean-install.ps1`, and `update-doc-screenshots.mjs`. Images change only through the explicit command.

## Critical files

- **Replaced:**
  - `apps/desktop/src/main/*.ts` → `src/Foundry.Host`, `src/Foundry.Desktop`
  - `apps/desktop/src/preload/index.ts` → `ui/src/bridge/`
  - `packages/runtime/src/*` → `src/Foundry.Runtime`
  - `packages/providers/src/index.ts` → `src/Foundry.Providers`
  - `packages/protocol/src/*` → `src/Foundry.Protocol`, plus generated TS types after cutover
  - `job-runner.ps1`, `mcp-host.ps1` → `Foundry.Platform.JobProcess`
  - `electron.vite.config.ts` → `ui/vite.config.ts`
  - `.github/workflows/portable-windows.yml` → the new Windows workflow
  - the `package.json` build block → `build.ps1` plus `installer/foundry.iss`
- **Reused verbatim:**
  - `tests/e2e/*.spec.ts`, with a new launcher fixture and hooks
  - `scripts/packaged-smoke.mjs`, `scripts/expansion-smoke.mjs`
  - the React components, except the bridge and limits imports
  - the SQL DDL in `schema.ts`, `automation-schema.ts`, `continuity-schema.ts`, `feature-admission.ts`
  - `SNAPSHOT_SCRIPT` and `TARGET_SCRIPT`
  - the `recover()`, `upgradeToCurrent()`, `resolveLocalInstant()`, `pathKey()` and `Quote()` semantics

## Out of scope

- New features.
- Enabling new-file creation through the edit tool. A native primitive becomes possible, but enabling it is a feature change.
- Clipboard UI limits for commands.
- Auto-update, MSIX, Fixed-Version WebView2.
- History browsing while adoption is pending.
- Decrypting old safeStorage credentials, or migrating Electron browser sessions.
- Automatic deletion of backups, legacy folders or worktrees.
- Changing the verification-clearing semantics.

## Assumptions

- Windows 11 x64 is primary; Windows 10 22H2 x64 is best effort (`JOB_LIST` needs Windows 10 or later).
- Evergreen WebView2, Windows PowerShell 5.1 and Git are present. PowerShell 5.1 is a permanent prerequisite, tested under policy variations.
- Same-user malware is out of scope, per AGENTS.md.
- A single developer with AI assistance.
- Signing (Azure Trusted Signing) and live Foundry qualification remain open release gates.
