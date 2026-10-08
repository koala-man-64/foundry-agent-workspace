# Golden vectors for the WPF migration

TypeScript is the behavioral authority until cutover ([migration plan](../../docs/wpf-webview2-migration.md)). These files pin its behavior so the C# port can be tested against it. `golden.test.ts` regenerates every set from the real TypeScript code and fails when the checked-in files drift. Run it with the unit tests in `pnpm check`.

To change a vector deliberately, regenerate and review the diff like any other behavior change:

```powershell
$env:UPDATE_GOLDEN = '1'; pnpm vitest run --project unit tests/golden; Remove-Item Env:UPDATE_GOLDEN
```

Each file has the shape `{ "generator": {...}, "content": ... }`. `generator` records the Node, ICU, time-zone-database and Unicode versions. It is informational and not compared.

| File | Pins | Consumer |
| --- | --- | --- |
| `jsjson.json` | `JSON.stringify` output and SHA-256 for edge values: key order (array-index keys move first), `undefined` omission, escaping, number formatting | `JsJson` (P1) |
| `profile-fingerprint.json` | Both `profileFingerprint` variants. Providers hash the WHATWG-normalized endpoint; the runtime hashes it raw. | provider and runtime ports |
| `manifest.json` | Handoff manifest entries sorted by UTF-8 bytes (not UTF-16), and their hash | git operations port |
| `schedules.json` | Wall-clock resolution across gaps, folds and half-hour zones; local stamps; due occurrences | automation port |
| `redaction.json` | `Redactor` output, including JavaScript regex semantics: `\b` and `\w` are ASCII, `\s` is Unicode | redaction port |
| `mcp-config.json` | MCP admission: forbidden and reserved environment names, secret-screened fields | MCP configuration port |
| `rpc-corpus.json` | For every protocol schema (RPC methods, bridge channels, non-RPC frames): seeds and mutations with zod's verdict, normalized output or issue paths | `Foundry.Protocol` validators (P1 exit gate: 100% agreement) |
| `rpc-wire.json` | JSON text where `JSON.parse` and a strict parser can disagree. `host` is the decided host behavior; `decide in S8` cases are fixed by spike S8. | host and runtime JSON readers |

Values JSON cannot carry use the tags documented in `encoding.ts`: `$undefined`, `$number` (`-0`, `NaN`, `Infinity`, `-Infinity`), `$utf16` (strings with lone surrogates), `$object` (authored key order) and `$repeat` (long single-character strings).

`path_key` values depend on the machine, so they are not checked in. The C# port runs `scripts/golden-path-key.mjs`, which reads a JSON array of paths on stdin, against a scratch tree, and compares the keys. `path-key.test.ts` proves that the script still matches the runtime's `pathKey`.
