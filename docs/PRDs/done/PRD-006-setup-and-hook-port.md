# PRD-006 — Port the installer and the churn hook

**Status:** DONE
**Priority:** P2 — AC-1 to AC-4 remove the last Python and `jq` requirements from the install path.
**Complexity:** 3 (LOW)
**Owner:** João
**Depends on:** PRD-003

## Context

- `scripts/setup-agents.sh` (340 lines, Bash + `jq` + Python 3.11+) is an idempotent installer. It links three skills, adds an always-on line to `CLAUDE.md` and `AGENTS.md`, sets token-saving defaults, wires the churn hook, and backs up config. It is a dry run unless `--apply`.
- `scripts/escalate-on-churn.py` (95 lines) is a Claude Code PostToolUse hook. It counts edits per file per session and injects an escalation prompt at the 4th, 7th, and 10th edit. It never blocks.

## Solution

- `token-furnace setup [--apply] [--rollback]` in `src/setup/agents.ts`. It edits JSON with `JSON.parse`/`JSON.stringify` instead of `jq`. It keeps the same backup location and the same dry-run output.
- `token-furnace hook churn` in `src/setup/churn-hook.ts`. It reads the hook payload from stdin and keeps its per-session counter state in the same place as the Python version.
- `setup` writes the hook command as `npx -y token-furnace hook churn`, or as the absolute `node` path when the tool is installed globally.

## Acceptance Criteria

- [x] AC-1 [local]: `setup` dry run on a temp `HOME` prints the same planned changes as `setup-agents.sh` and changes no file. proof: `npx vitest run test/setup.test.ts` — Evidence: Built dry-run prints the legacy defaults, backup and hook plan; the entire isolated HOME remains empty.
- [x] AC-2 [local]: `setup --apply` twice on a temp `HOME` gives the same files as one run (idempotent), and writes a backup. proof: `npx vitest run test/setup.test.ts` — Evidence: Installer tests apply twice, preserve config bytes on the no-op, keep the original backup, and back up before real changes.
- [x] AC-3 [local]: `setup --rollback` restores the backed-up files byte for byte. proof: `npx vitest run test/setup.test.ts` — Evidence: Byte-for-byte rollback passes, including legacy backups, missing original files and saved pre-rollback content.
- [x] AC-4 [local]: Piping 10 edit payloads for one file into `token-furnace hook churn` emits escalation output on edits 4, 7, and 10 only, and always exits 0. proof: `npx vitest run test/churn-hook.test.ts` — Evidence: Unit and built CLI checks emit only edits 4/7/10 and exit 0; malformed JSON and non-string paths are ignored.
- [x] AC-5 [local]: `scripts/setup-agents.sh` and `scripts/escalate-on-churn.py` are deleted, and `SKILL.md` names the new commands. proof: `git ls-files scripts` — Evidence: Both legacy scripts are deleted and SKILL.md uses token-furnace setup and hook churn.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Installer | `token-furnace setup` → `src/setup/agents.ts` | `setup-agents.sh` deleted | AC-1 to AC-3 |
| Churn hook | Claude Code PostToolUse → `token-furnace hook churn` | `escalate-on-churn.py` deleted | AC-4 |

## Execution Phases

#### Phase 1: Installer port
**Status:** DONE
**Files:** `src/setup/agents.ts`, `src/cli.ts` (register command), `test/setup.test.ts`
**Implementation:** Read `setup-agents.sh` fully first. Port each step in order. Keep the backup path and rollback format, so a backup made by the shell version still restores.
**Verification:** `npx vitest run test/setup.test.ts` — AC-1, AC-2, AC-3.

#### Phase 2: Churn hook port and deletion
**Status:** DONE
**Files:** `src/setup/churn-hook.ts`, `test/churn-hook.test.ts`, `SKILL.md`, delete both scripts
**Implementation:** Port the counter logic and thresholds as they are. Point the hook entry that `setup` writes at the new command.
**Verification:** `npx vitest run test/churn-hook.test.ts` — AC-4. `git ls-files scripts` — AC-5.

Integration verification (2026-10-09, Node 24.16.0): typecheck, build and all 71 tests pass. Setup/hook dispatch runs before SQLite composition; built setup dry-run creates no cache or config files. Installer checks cover safe shell quoting, legacy hook replacement, instruction boundaries and malformed configuration preservation.

Hook input regression: both one multiline JSON payload per invocation and newline-delimited batch payloads emit only at edits 4/7/10. All three focused hook tests pass.
