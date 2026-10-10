# Functional requirements — npx restructure

**Status:** PROPOSED
**Date:** 2026-10-09

Each requirement names the PRD that delivers it. "Same as Python" means the behavior of `scripts/burn.py` at commit `f3442b5`.

## Data collection

| ID | Requirement | PRD |
|---|---|---|
| FR-1 | Read Claude Code transcripts from `$CLAUDE_CONFIG_DIR/projects/*/*.jsonl`, default `~/.claude`. Subagent transcripts in `<session>/subagents/` are not read, same as Python. | 001 |
| FR-2 | Read Codex transcripts from `$CODEX_HOME/sessions/**/rollout-*.jsonl`, default `~/.codex`. | 001 |
| FR-3 | Skip a malformed transcript line, count it, and continue. One bad line never stops the scan. | 001 |
| FR-4 | Keep only token counts, times, models, tool names, read counts, wake kinds, and session titles. Drop message text after classification. | 001 |
| FR-5 | `--source claude\|codex` limits the scan to one agent. A missing agent directory is "not installed", not an error. | 001, 003 |

## Analysis

| ID | Requirement | PRD |
|---|---|---|
| FR-6 | Detect the five session leaks with the Python thresholds: late compaction (peak over 300k), caller reads (100 or more), wakeups (50 or more), loop (200 or more turns per human prompt), long-lived (12 hours or more). | 002 |
| FR-7 | Run the config checks: `autoCompactWindow`, subagent cap and depth, tool concurrency, Codex `max_concurrent_threads_per_session`, and `MEMORY.md` over 200 lines. | 002 |
| FR-8 | Rank issues and build one copy-to-Claude prompt for each issue, same as `top_issues()` and `issue_prompt()`. | 002 |
| FR-9 | Compute weighted tokens with the Python model rates and cache multipliers. List models without a rate under `unpriced`. | 002 |
| FR-10 | Compute the weekly burn, goal, burndown, and projection. `--weekly-budget M` or `TOKEN_FURNACE_WEEKLY_BUDGET` sets the goal. | 002 |
| FR-11 | Codex weekly usage comes from the `rate_limits` in local rollouts. No network. | 002 |

## Output

| ID | Requirement | PRD |
|---|---|---|
| FR-12 | Default command prints the doctor verdict, the leaks, and the fixes. Exit 1 on leaks or no data, exit 0 when clean. | 003 |
| FR-13 | `--full` prints the full text report, same as `burn.py` with no `--doctor`. | 003 |
| FR-14 | `--json` prints the `Report` (schema.md) on stdout and nothing else. | 003 |
| FR-15 | `--html <path>` writes one self-contained HTML file with the report inlined. It opens with no server and no network. | 003, 005 |
| FR-16 | `--list-sources` prints each agent, its path, and its transcript count. | 003 |
| FR-17 | `serve [--port 8765]` binds `127.0.0.1` only, rejects a foreign `Host` header, and rebuilds the report on each `/api/report` request. | 003 |
| FR-18 | The dashboard refreshes every 60 seconds. A failed refresh keeps the old data and shows an offline tag. | 005 |

## Cache and network

| ID | Requirement | PRD |
|---|---|---|
| FR-19 | A second run parses only files whose `mtime` or `size` changed. | 004 |
| FR-20 | `--no-cache` or `TOKEN_FURNACE_NO_CACHE=1` uses the in-memory repository and writes no cache file. | 004 |
| FR-21 | No network call by default. `--plan-usage` enables the Claude plan-usage call to `api.anthropic.com`. | 003 |

## Install and hook

| ID | Requirement | PRD |
|---|---|---|
| FR-22 | `setup` is a dry run unless `--apply`. It is idempotent, makes a backup, and `--rollback` restores it. | 006 |
| FR-23 | `hook churn` escalates on the 4th, 7th, and 10th edit of one file in one session, and never blocks. | 006 |
| FR-24 | `npx token-furnace` runs on Node 22.13 or later with no Python and no `jq`. | 007 |
| FR-25 | A scan never blocks the server. `/api/status` reports files done and total, and a loading page shows a spinner, a progress bar, and "Please wait" until the report is ready. | 008 |
| FR-26 | The CLI shows scan progress on stderr when it is a TTY, and keeps `--json` stdout to the Report alone. | 008 |

## Non-functional

- NFR-1: Runtime dependency is `express` only.
- NFR-2: `core/` has no I/O and imports nothing outside `core/`.
- NFR-3: Every report is identical with the memory repository and with the SQLite repository.
