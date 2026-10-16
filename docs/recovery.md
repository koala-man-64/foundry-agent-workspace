# Foundry Agent Workspace: recovery runbook

Recovery procedures for the shipping Electron application. Each step was checked against the code on 16 October 2026 (`e5517ac`). The WPF cutover will replace this runbook ([migration plan](wpf-webview2-migration.md), "Documentation updates").

Rules that apply to every section:
- **Preserve `%LOCALAPPDATA%\FoundryAgentWorkspace`.** Copy it aside before any manual change. Never delete a retained worktree because a task failed; nothing is deleted automatically.
- **Nothing is retried.** The runtime never replays an operation whose outcome is unknown, and no check below retries one.
- **Use the in-app checks first.** They read Git and file state without changing them.
- **Manual Git work runs outside the app's hardened environment.** Prefix every command with `git -c core.hooksPath=NUL -c core.fsmonitor=false -C <worktree>` so your hooks and filesystem monitor do not run. Do not fetch, check out, reset, clean or commit inside an app-owned worktree. The only exceptions are the `add` and `checkout -m` steps in section 3.
- **Commands run with your Windows privileges.** Approval and worktrees are not a sandbox, so an unknown command outcome can have effects outside the worktree.

---

## 1. Unknown outcomes

### 1.1 What becomes unknown after a crash or restart

| Kind | After restart | What it blocks |
|---|---|---|
| Commit, push, worktree retirement (intent written before acting) | `unknown` | `task.send`, commit, push and retirement for that task |
| Reviewed edit, command, MCP call, browser action, child handoff (approval record) | Waiting approvals are revoked; executing ones become `unknown` | The next turn in that task, and its commit, push, compaction and retirement |
| Worktree creation (intent written before acting) | `unknown` | Creating any new Git-backed task: "An earlier worktree creation has an unknown outcome." Existing tasks and chats without a repository keep working. |
| Chat creation that was in flight | `unknown` | Retrying that same request fails with "Chat creation has an unknown outcome." Inspect the saved chat instead. |
| Coordinated integration, handoff or child provisioning | `unknown`, shown as **Unknown (blocked)** for integrations | That coordinated task until reconciled |
| Trusted script run that was dispatching or running | `unknown` | Nothing is replayed. Inspect the script's external effects yourself. |

Nothing is reconciled at restart. An in-app check runs only when you click it, or, for a coordinated task, when you send it the next message (section 1.2).

### 1.2 In-app checks

| Situation | Where | Control | What it does |
|---|---|---|---|
| Unknown commit, push or retirement in a **chat or coding** task | Task inspector, **Publish** tab ("Unknown publication outcome") | **Check publication outcome** | Compares Git state with the recorded intent (section 1.3). Clears the intent only when Git proves the outcome. |
| Unknown **edit** | Task inspector, **Approvals** tab | **Check outcome** | Compares the file hash with the original and approved content. A match clears it; anything else stays unknown. |
| Unknown **command** or **MCP call** | Task inspector, **Approvals** tab | **Check outcome** | Records that the outcome cannot be reconstructed. **It stays unknown permanently**, so the task can no longer run turns, commit, push, compact or retire (section 1.5). |
| Unknown **browser action** | Task inspector, **Approvals** tab | **I inspected the tab · allow new actions** | Records your inspection and unblocks the task. The action stays unknown and is never replayed. |
| Unknown or blocked coordinated **integration** | Coordinated task, **Orchestration** tab | **Check outcome** on the integration | Read-only reconciliation from Git state. Read section 3 before using it on a conflict. |
| Unknown coordinated **handoff** or **child provisioning** | Coordinated task | Send the coordinated task its next message | Before the new turn starts, the runtime reconciles unknown integrations, handoffs and child provisioning read-only. |

Coordinated tasks open in the coordinated view, which has no task inspector and so no **Publish** tab. The runtime's `task.retire` can retire a coordinated root together with its children once every run is terminal, but no control in the app calls it. Commit, push, retirement and **Check publication outcome** are therefore unavailable for coordinated tasks.

### 1.3 How commit, push and retirement outcomes are decided

Use this when you inspect a worktree by hand. Task worktrees are at `%LOCALAPPDATA%\FoundryAgentWorkspace\wt\<taskId>` on branch `codex/task/<taskId>`. Coordinated children are at `wt\children\<childId>` on `codex/child/<childId>`.

- **Commit.** The intent records the branch, the base commit and the message, not a resulting SHA. The commit landed if `HEAD^` is the base commit, the message matches and the tree is clean. It did not land if `HEAD` is still the base commit. Anything else is unresolved. Do not discard or re-stage changes; copy anything you need aside.
- **Push.** The runtime runs `git ls-remote --heads <remote> refs/heads/<branch>` with the remote recorded in the intent, which is not necessarily `origin`. The push succeeded if the remote tip equals the recorded commit or contains it. It did not happen if the remote branch is absent. A remote tip that does not contain the commit stays unknown.
- **Retirement.** The check only tests whether the recorded worktree directories still exist. None left records the retirement as complete. Any left records it as failed, without retrying. Retire again with **Retire worktree…** on the **Publish** tab, which refuses a worktree with uncommitted or untracked files and keeps the branch. Do not run `git worktree remove` by hand.

### 1.4 Unknown worktree creation

No in-app check exists for this case yet. Until one does, new Git-backed tasks cannot be created.
1. Preserve the data directory.
2. Inspect read-only:
   ```powershell
   git -C <project> branch --list "codex/task/*"
   git -C <project> worktree list --porcelain
   ```
   Compare the output with the tasks the app shows.
3. Keep any retained branch and worktree. There is no supported way to clear the intent. Report the state rather than editing the database.

### 1.5 A task permanently blocked by an unknown command or MCP call

The runtime cannot reconstruct what a command or external tool did, so the task stays blocked. Continuing it into a new task is also refused while execution is unresolved.
1. Inspect the worktree (`status`, `diff`, with the flags above) and any external effect the command or server could have had.
2. Start a new task for the same project. It begins from the project's local HEAD, not from the blocked worktree.
3. Copy any changes you want to keep from the blocked worktree into the new task's worktree by hand.

The blocked task, its worktree and its branch stay as they are.

---

## 2. Database

### 2.1 Location

`%LOCALAPPDATA%\FoundryAgentWorkspace` holds:
- `workspace.db`, with its `workspace.db-wal` and `workspace.db-shm` files;
- `wt\` (worktrees);
- `credentials\`;
- `backups\`.

While the app runs, only the runtime writes the database. The restore in section 2.4 is an offline operator action, done with the app closed.

### 2.2 Checking integrity after a crash

1. Close the application. Confirm in Task Manager that no Foundry Agent Workspace process remains.
2. Copy `workspace.db`, `workspace.db-wal` and `workspace.db-shm` together into a separate folder.
3. Run `PRAGMA integrity_check;` against the copy only. The application ships no `sqlite3` tool.

Do not run `wal_checkpoint` or any other write against the real files. The runtime replays the WAL itself on the next start. Checkpointing a suspect database destroys the evidence in the WAL.

### 2.3 Backups

Backups are created in only two situations:
- **Schema upgrade.** When you confirm **Create backup and upgrade** in the upgrade banner (v1–v4 to v5), the runtime writes a backup with SQLite's backup API. Before changing anything, it checks the backup's `integrity_check`, `user_version` and row counts. If any check fails, the database is not changed.
- **MCP repair.** Historical MCP credential repairs write their own backups, taken from the live database before the repair.

A new database starts at v5 with no backup.

Backups live under `backups\private-<random>\`, in folders restricted to you, SYSTEM and Administrators:
- upgrade backups are named `workspace-v<source version>-<timestamp>-<8 hex>.db`;
- repair backups are named `mcp-repair-<timestamp>-<8 hex>.db`.

Each is a single self-contained file with no WAL. To list them:

```powershell
Get-ChildItem "$env:LOCALAPPDATA\FoundryAgentWorkspace\backups" -Recurse -Filter '*.db'
```

### 2.4 Restoring a backup (last resort)

This loses data. Restoring returns the database to the backup's moment. Work recorded since then is gone. Tasks created since then keep their branches and worktrees on disk, but lose their records.

Restore only a `workspace-v*.db` upgrade backup. It brings back the older schema, so the app shows the upgrade banner again. **Do not restore an `mcp-repair-*.db` backup.** It would bring back the unsafe MCP configuration values that the repair removed.

Never copy a backup over `workspace.db`. Spike S10 found that a copy succeeds while another process holds the database. That process's close-time checkpoint then silently undoes the restore, and the result still passes `integrity_check`.

Before you start:
- Check the chosen backup on a copy with your own `sqlite3`: `PRAGMA integrity_check;` and `PRAGMA user_version;`.
- Close the app normally. Do not use `Stop-Process -Force`.
- Save the script below as a `.ps1` file, set `$backup`, and run the file. Pasted line by line into a console, a failed step does not stop the remaining ones.

```powershell
$ErrorActionPreference = 'Stop'
$data = "$env:LOCALAPPDATA\FoundryAgentWorkspace"
$backup = '<full path of the chosen workspace-v*.db backup>'
if (-not (Test-Path -LiteralPath $backup)) { throw "Backup not found: $backup" }

# 1. Prove that nothing holds the database or the Chromium lockfile.
foreach ($name in 'workspace.db', 'workspace.db-wal', 'workspace.db-shm', 'lockfile') {
  $path = Join-Path $data $name
  if (Test-Path -LiteralPath $path) {
    try { [System.IO.File]::Open($path, 'Open', 'ReadWrite', 'None').Dispose() }
    catch { throw "Still in use, stopping: $path" }
  }
}

# 2. Preserve the current state. This copy holds your data, so keep it private and remove it once you no longer need it.
$keep = Join-Path $env:USERPROFILE ("foundry-before-restore-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $keep | Out-Null
Get-ChildItem -LiteralPath $data -Filter 'workspace.db*' | Copy-Item -Destination $keep

# 3. Stage the backup beside the database (same volume) before anything is removed.
$staged = Join-Path $data 'workspace.db.restore'
Copy-Item -LiteralPath $backup -Destination $staged

# 4. Remove the old WAL, so its frames cannot replay onto the restored pages.
foreach ($name in 'workspace.db-wal', 'workspace.db-shm') {
  $path = Join-Path $data $name
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
}

# 5. Rename the staged backup over workspace.db. Windows refuses the rename while any process holds the file.
Move-Item -LiteralPath $staged -Destination (Join-Path $data 'workspace.db') -Force
```

Then run `PRAGMA integrity_check;` on a copy of the restored file, and start the application.

---

## 3. Coordinated integration conflicts

The coordinator integrates each child commit into its own worktree, `wt\<coordinatorTaskId>`, by serial cherry-pick. When a cherry-pick conflicts, the worktree, index and `CHERRY_PICK_HEAD` are preserved. The operation shows **Conflict** under **Integrations** in the **Orchestration** tab, and the coordinator waits with "Blocked on a conflict". The application never aborts, resets or skips the cherry-pick.

These steps use `git add` and `git checkout -m` in the coordinator worktree, the only exceptions to the rule against changing an app-owned worktree. Use the hardened flags: `git -c core.hooksPath=NUL -c core.fsmonitor=false -C <worktree> …`.

### 3.1 Resolve and continue

1. Open the coordinator worktree in your editor and resolve the conflict markers.
2. Stage the resolved files with `add <files>`. Do not commit, and do not run `cherry-pick --continue` or `--abort`.
3. **Click Prepare continuation on the Conflict operation right away. Do not click Check outcome first** (section 3.2).
4. Open the **Approvals** tab and review the "Coordinator conflict continuation" card: the resolved tree, changed paths and patch.
5. Click **Approve** only when the resolution is right. **Rejecting leaves the original operation marked Continued, and the app then offers no control to prepare another continuation** (the runtime would accept one, but no button exposes it).
6. After approval, the continuation shows **Succeeded**, the original operation shows **Continued**, and the assignment shows **Integrated**. Combined validation must run again on the new tree before the task can complete.

### 3.2 Known defect: Check outcome after staging

After you stage a resolution, the index has no unmerged paths while the cherry-pick is still in progress. **Check outcome** reads that state as an empty cherry-pick and marks the operation **Empty (blocked)**. **Prepare continuation** then refuses with "Only a preserved conflict can be continued.", and later checks report "State unchanged". This was reproduced on 16 October 2026 with the real Git and SQLite integration harness.

To recover:
1. Copy your resolved files somewhere outside the worktree.
2. Recreate the conflict with `checkout -m -- <files>`. This restores the conflict markers in the worktree and the unmerged entries in the index, and replaces your resolution in those files.
3. Click **Check outcome**. The operation returns to **Conflict**.
4. Copy the resolved files back, `add <files>`, and continue from step 3 of section 3.1.

This sequence was verified end to end in the same harness: the continuation reached **Succeeded**.

---

## 4. Credentials

### 4.1 Storage

Each model profile's key is in `%LOCALAPPDATA%\FoundryAgentWorkspace\credentials\<profileId>.bin`. The file holds JSON `{ value, binding }`, encrypted with Electron `safeStorage`, which on Windows uses DPAPI for the current user. The binding is the profile's API kind, endpoint and deployment.

Keys are never written to SQLite, logs, diagnostics or the renderer. A `.bin` file cannot be decrypted by another Windows user or on another machine, so recovering a credential always means entering it again.

### 4.2 Rotating a key

1. Cancel any running responses. The runtime refuses to change credentials while one is active.
2. Select the profile in the **Model** dropdown, then click **Model settings** in the sidebar. The **Model profile** dialog edits the selected profile.
3. Type the new key in **Credential**.
4. Click **Save profile**. This stores the key and marks the profile unverified. It does not test the connection.
5. Reopen **Model settings** and click **Test connection** until **Connection ready** appears. It can make up to four paid requests. Real requests stay disabled until a test succeeds.

You can also click **Test connection** directly at step 4; it saves the key first. Either way, the key stays saved even if the test fails.

If a key leaked, also revoke it on the Azure resource. The application cannot do that.

### 4.3 Changing API kind, endpoint or deployment

These three fields are the credential binding. After changing any of them, enter the key again and run **Test connection**. Otherwise requests fail with "Could not unlock a saved credential for this endpoint. Re-enter it in model settings."

A change to the context limit, output limit or reasoning effort keeps the key. The profile still needs a new **Test connection**.
