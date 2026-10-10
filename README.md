# token-furnace

Where the token budget actually went. `token-furnace` reads your local Claude Code and Codex
transcripts, finds token leaks, and shows the result in your terminal, as JSON for agents, and in a
local dashboard. Transcript data never leaves your machine.

## Requirements

- Node.js 22.13 or newer.

Run it without installing:

```
npx token-furnace
```

Or install it globally:

```
npm install -g token-furnace
```

## Commands

| Command | Result |
|---|---|
| `token-furnace [days] [--source claude\|codex]` | Ranked verdict on stdout. `days` defaults to 7. Exits 1 on leaks or no data. |
| `token-furnace --full` | Full text report. |
| `token-furnace --json` | The `Report` JSON on stdout, for agents and scripts. Exits 0 even when leaks are present. |
| `token-furnace --html <path>` | Writes a static HTML report with the report JSON inlined. It does not change the exit code. |
| `token-furnace --list-sources` | Each agent, its path, and its transcript count. |
| `token-furnace serve [--port 8765]` | Live dashboard on `http://127.0.0.1:<port>`. It serves the last scan and refreshes it in the background. |
| `token-furnace setup [--apply] [--verify] [--rollback] [--aggressive]` | Installer. Dry run unless `--apply`. |
| `token-furnace hook churn` | Claude Code PostToolUse churn hook. Reads the payload on stdin. Never blocks. |

Options:

- `--weekly-budget <M>` — weekly budget in millions of weighted tokens. `TOKEN_FURNACE_WEEKLY_BUDGET`
  sets the same value.
- `--no-cache` — parse every file and write no cache.
- `--no-plan-usage` — never call `api.anthropic.com`. A saved reading is still used.
- `-h`, `--help` — usage text.

## Setup and hook

`token-furnace setup` prints the planned changes and changes no file. Add `--apply` to write them.
Existing values and comments are preserved. Invalid or unsupported Codex settings are skipped
with a warning.
`--verify` checks an existing install and exits 1 on any failure. `--rollback` restores the most
recent backup. `--aggressive` also sets the flagged-risky subagent spawn depth; verify that
subagents still spawn after any Claude Code upgrade.

`token-furnace hook churn` is the PostToolUse hook. It counts edits per file per session and
injects an escalation prompt at the 4th, 7th, and 10th edit.

## Privacy

- Transcript data stays on this machine. The tool sends no telemetry.
- The local cache stores metadata only: session titles, token counts, timestamps, models, tool
  names, and file paths. It never stores message text.
- One network call exists: plan usage. It runs only when a Claude Code login exists on the machine.
  It sends the plan auth token to `api.anthropic.com` and nowhere else. `--no-plan-usage` turns it
  off.
- The server binds to `127.0.0.1` only. It rejects a `Host` header that is not loopback.

## Cache

The cache lives at:

- `$XDG_CACHE_HOME/token-furnace/` when `XDG_CACHE_HOME` is set.
- `$HOME/.cache/token-furnace/` otherwise.

It holds `cache.sqlite` (parsed sessions) and `usage.json` (the last plan reading). To clear it:

```
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/token-furnace"
```

Use `--no-cache` to skip the cache for one run. The cache is disposable; a schema change rebuilds it.

## Progress and workers

A terminal gets a redrawn progress line on stderr. Set `TOKEN_FURNACE_WORKERS=0` to parse on the
main thread, or a positive number to set the worker count.

## Exit codes

- `0` — no leaks found. The `--json` and `--full` reports also exit 0 when leaks are present.
- `1` — leaks found, or no transcripts found.
- `2` — a rejected value for `days`, `--source`, or `--port`.

An unknown option does not exit 2. `node:util` `parseArgs` throws, so that run exits 1 with a stack
trace.

## Release status

Version 0.1.0. The `setup` and `hook` commands are integrated and tested (PRD-006). The dashboard
is a React + Vite + TypeScript single-file build (PRD-005). `--html` writes one file and `serve`
serves the same page. Both load no external URL: no CDN `<script>` or `<link>`.

The package smoke test passes on both Node.js 22.13 and Node.js 24.16: `npm pack`, a temporary
install, and `npx --no-install` runs of the CLI (`--json`), `--html`, and `serve` all match the
expected totals and routes. The tarball includes `dist/scan-worker.js` and `dist/dashboard.html`. The package file allowlist
contains `dist/`, `SKILL.md`, `references/`, and `README.md`, plus npm metadata and the license.
It contains no `.py`, `.sh`, test, or fixture files.

The full Vitest suite (86 tests) plus the root and web typechecks and the build pass. The four CLI
paths (cold workers, warm cache, inline main-thread, and `--no-cache` workers) return identical
`Report` JSON. Publishing to npm is pending the package owner.
