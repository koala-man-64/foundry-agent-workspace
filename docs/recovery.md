# Foundry Agent Workspace: Disaster Recovery & Operational Runbook

This document provides operational recovery procedures, disaster recovery protocols, and diagnostic runbooks for Foundry Agent Workspace.

---

## 1. Worktree & Intent Reconciliation

### 1.1 Understanding Unknown Mutation Outcomes
Foundry Agent Workspace enforces a strict **durable intent before mutation** invariant. Before any filesystem or Git mutation executes, the runtime writes an intent record to the local SQLite database. If an abnormal shutdown, power failure, or process crash occurs during execution:
- The unfinished mutation is marked with status `unknown`.
- The runtime refuses to guess or treat interrupted side-effects as successful.
- The task enters a fenced state: `task.send` is blocked until the ambiguous intent is reconciled.

### 1.2 Read-Only Reconciliation Commands
The runtime automatically attempts read-only reconciliation upon task restart or explicit user reconciliation RPC (`task.reconcile` / `orchestration.resume`). If manual operator inspection is required:

#### Commit Intent Reconciliation
Inspect the task worktree to determine if the commit landed:
```powershell
cd %LOCALAPPDATA%\FoundryAgentWorkspace\wt\<taskId>
git log -n 1 --format="%H %s"
```
- **Matches Intent**: If `HEAD` commit message and parent match the attempted intent SHA, the commit succeeded.
- **Unstaged/Staged Changes**: If changes remain in the index or working tree without a commit object, the commit did not land. Discard or re-stage cleanly.

#### Push Intent Reconciliation
Inspect whether the remote tracking branch contains the attempted commit:
```powershell
git fetch origin
git merge-base --is-ancestor <attemptedCommitSha> origin/<targetBranch>
```
- Exit code `0`: The commit is an ancestor of the remote tip; push was successful.
- Non-zero: Inconclusive or unpushed; push was not completed.

#### Worktree Retirement Reconciliation
If a task was being retired and crashed:
```powershell
git worktree list
```
- If the path is absent from `git worktree list` and deleted from disk, retirement completed.
- If the worktree remains, inspect for uncommitted changes:
  ```powershell
  git status --short
  ```
  If clean, safely remove with `git worktree remove <worktreePath>`.

---

## 2. SQLite Database Recovery & Maintenance

### 2.1 Storage Location & WAL Files
Application state is stored in `%LOCALAPPDATA%\FoundryAgentWorkspace`:
- `workspace.db`: Primary SQLite database file.
- `workspace.db-wal`: Write-Ahead Log.
- `workspace.db-shm`: Shared-memory index file.

### 2.2 Integrity Verification & WAL Checkpoint
If SQLite reports corruption or hangs after an OS crash:
```powershell
# Verify database integrity
sqlite3 "$env:LOCALAPPDATA\FoundryAgentWorkspace\workspace.db" "PRAGMA integrity_check;"

# Force a WAL checkpoint and truncate the log
sqlite3 "$env:LOCALAPPDATA\FoundryAgentWorkspace\workspace.db" "PRAGMA wal_checkpoint(TRUNCATE);"
```

### 2.3 Restoring from Migration Backups
During major schema upgrades (such as the Schema v1 to v2 migration), an automatic backup is generated before the upgrade transaction:
```powershell
# Locate backup files
Get-ChildItem "$env:LOCALAPPDATA\FoundryAgentWorkspace\workspace.db.*.bak"

# To roll back, terminate Foundry Workspace and restore the backup:
Stop-Process -Name "Foundry Agent Workspace" -Force -ErrorAction SilentlyContinue
Copy-Item "$env:LOCALAPPDATA\FoundryAgentWorkspace\workspace.db.v1.<timestamp>.bak" "$env:LOCALAPPDATA\FoundryAgentWorkspace\workspace.db"
Remove-Item "$env:LOCALAPPDATA\FoundryAgentWorkspace\workspace.db-wal" -Force -ErrorAction SilentlyContinue
Remove-Item "$env:LOCALAPPDATA\FoundryAgentWorkspace\workspace.db-shm" -Force -ErrorAction SilentlyContinue
```

---

## 3. Coordinated Merge Conflict Resolution

When a coordinator agent integrates child specialist worktrees via serial cherry-pick, conflicting changes halt automatic integration and enter a blocked `conflict` state.

### 3.1 Inspecting the Conflict
1. Identify the coordinator task worktree:
   ```powershell
   cd %LOCALAPPDATA%\FoundryAgentWorkspace\wt\<coordinatorTaskId>
   git status
   ```
2. Unmerged paths will be listed under `Unmerged paths:`.

### 3.2 Resolving the Conflict in an External Editor
1. Open the repository worktree in VS Code or your preferred editor:
   ```powershell
   code .
   ```
2. Resolve standard Git conflict markers (`<<<<<<< HEAD`, `=======`, `>>>>>>>`).
3. Stage the resolved files:
   ```powershell
   git add <resolved-files>
   ```
4. Do **not** commit via manual `git commit`.
5. Return to the Foundry Agent Workspace UI:
   - The Orchestration tab will detect the resolved index.
   - Click **Submit Resolved Integration** to review the resolved tree diff and record the resolution evidence.

---

## 4. Credential Rotation & Vault Recovery

### 4.1 Storage Architecture
Credentials are never stored in SQLite, plain text configuration files, or logs. They are encrypted using Windows DPAPI via Electron's `safeStorage` API in:
`%LOCALAPPDATA%\FoundryAgentWorkspace\credentials\<profileId>.enc`

### 4.2 Rotating an Expired or Leaked Credential
1. Open Foundry Agent Workspace -> **Settings** -> **Model Profiles**.
2. Select the affected profile and click **Update Credential**.
3. Enter the new API key or bearer token and click **Verify & Save**.
4. The runtime will:
   - Clear the in-memory credential cache.
   - Execute an isolated verification probe (`profile.probe`) with the new secret.
   - Re-encrypt and persist the updated key to the OS vault upon successful qualification.
