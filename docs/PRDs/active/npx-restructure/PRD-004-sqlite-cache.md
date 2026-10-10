# PRD-004 — SQLite cache for incremental scans

**Status:** NOT STARTED
**Priority:** P2 — AC-2 makes repeat runs and every `/api/report` refresh parse only changed files.
**Complexity:** 4 (MEDIUM)
**Owner:** João
**Depends on:** PRD-003

## Context

- `burn.py` keeps an in-process parse cache keyed by `(mtime_ns, size)` (`cached()`, `burn.py:516`). It only helps a long-running `--serve`. Every CLI run parses every transcript again.
- After PRD-003, `MemorySessionRepository` has the same limit.
- The interview default was "cache only when a cold scan takes more than about 3 seconds". João kept this PRD at P2. Phase 1 records the cold-scan time first, so the gain is measured, not assumed.

## Solution

- `src/repo/sqlite-repo.ts`: `SqliteSessionRepository` on `node:sqlite` (`DatabaseSync`), with the schema in schema.md.
- `compose.ts` picks SQLite by default. `--no-cache` or `TOKEN_FURNACE_NO_CACHE=1` picks the memory repository.
- A schema version mismatch, or a cache file that does not open, drops and rebuilds the cache. A cache error never fails a run.

## Acceptance Criteria

- [ ] AC-1 [local]: For the same fixture, the report from the SQLite repository equals the report from the memory repository. proof: `npx vitest run test/sqlite-repo.test.ts` — Evidence: pending.
- [ ] AC-2 [local]: A second run parses 0 files. After one transcript gets a new line, the next run parses exactly that file. A deleted transcript loses its rows. proof: `npx vitest run test/sqlite-repo.test.ts` (count calls to `source.parse`) — Evidence: pending.
- [ ] AC-3 [local]: A cache file with `user_version = 0`, or with garbage bytes, is rebuilt, and the run succeeds. proof: `npx vitest run test/sqlite-repo.test.ts` — Evidence: pending.
- [ ] AC-4 [local]: `--no-cache` creates no cache file. proof: `npx vitest run test/sqlite-repo.test.ts` — Evidence: pending.
- [ ] AC-5 [local]: The cache holds no message text: a fixture with a unique marker string in user and assistant text leaves no marker in the cache file. proof: `npx vitest run test/sqlite-repo.test.ts` — Evidence: pending.
- [ ] AC-6 [local]: Cold and warm run times on João's real transcripts are recorded here. proof: `time npx token-furnace --json >/dev/null` twice — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Incremental scan | `compose.ts` → `ReportService.refresh()` | `cached()` in-process dict (deleted in PRD-003) | AC-2 |
| Cache opt-out | `--no-cache`, `TOKEN_FURNACE_NO_CACHE` | none (new) | AC-4 |

## Execution Phases

#### Phase 1: Measure
**Status:** NOT STARTED
**Files:** this PRD
**Implementation:** Run `time npx token-furnace --json --no-cache >/dev/null` on João's machine and write the result under AC-6. If the cold scan is under 1 second, stop and ask João whether to close this PRD as not needed.
**Verification:** The number is in this file.

#### Phase 2: SQLite repository
**Status:** NOT STARTED
**Files:** `src/repo/sqlite-repo.ts`, `src/compose.ts`, `src/cli.ts` (`--no-cache`), `test/sqlite-repo.test.ts`
**Implementation:** Write each changed file's rows in one transaction. Prepare statements once. Use the `files` table as the change index. Create the cache directory if it is missing.
**Verification:** `npx vitest run test/sqlite-repo.test.ts` — AC-1 to AC-5. Timings — AC-6.
