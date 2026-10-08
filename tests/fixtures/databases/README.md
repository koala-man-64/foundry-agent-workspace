# Fixture databases for the WPF migration

These are real databases written by each schema era's runtime. `scripts/fixtures/generate-fixture-databases.mjs` builds every era from its commit and drives one shared data directory forward through each era's own upgrade confirmation. Later fixtures therefore also contain rows in every earlier era's shape, as a long-lived profile does.

| Fixture | Runtime | Adds |
| --- | --- | --- |
| `v1` | `f75d1ed` (0.2.0 layout, before schema versioning) | chats with Unicode and CRLF, approved and rejected coding demos, an unverified Azure profile |
| `v2` | `2b42bb7` | the confirmed upgrade, a coordinated workflow, channel broadcast and direct messages, compaction, the MCP demo, commit and retirement |
| `v3` | `cdec0a3` | saved git and folder projects, draft-first chats in each and projectless, preferences |
| `v4` | `0212982` | usage-era requests, a profile with an effort preset |
| `v5` | current `main` | the personal-workspace expansion: archive, search, continuation, automation rules, PowerShell and JavaScript scripts with grants, crash recovery |
| `v5-wal` | current `main` | `v5` plus a chat killed while streaming: committed but uncheckpointed WAL pages (`workspace.db-wal`, `workspace.db-shm`) |

Each fixture's `expected-after-open.json` records what the current TypeScript `Store` changes when it opens a copy:
- the `user_version` stamp;
- the schema after the DDL that runs on every open;
- `recover()`'s added, removed and changed rows, with newly minted identifiers and timestamps masked.

`tests/golden/fixture-databases.test.ts` keeps that contract current. The C# `Store` must produce the same differences (P1).

Paths in the fixtures come from a name-free scratch root (`%ProgramData%\FoundryFixtures`). The generator rejects any output that contains the user name or profile path. Content is synthetic: offline demo responses and fixture repositories. No credential is ever stored in a database.

To regenerate (this needs network for each era's `pnpm install` and takes several minutes):

```powershell
node scripts/fixtures/generate-fixture-databases.mjs
$env:UPDATE_GOLDEN = '1'; pnpm vitest run --project unit tests/golden/fixture-databases.test.ts; Remove-Item Env:UPDATE_GOLDEN
```

Review regenerated fixtures like a behavior change.
- Never `VACUUM` them: rowids link FTS rows and cursors.
- Never open them in place, not even read-only. SQLite then creates or rewrites `-wal` and `-shm` files. Copy a fixture first. The fixture test fails if an ordinary fixture gains these files.
