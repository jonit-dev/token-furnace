# PRD-004 — SQLite cache for incremental scans

**Status:** DONE
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

- [x] AC-1 [local]: For the same fixture, the report from the SQLite repository equals the report from the memory repository. proof: `npx vitest run test/sqlite-repo.test.ts` — Evidence: 2026-10-09, 5 cache tests pass on Node 24.16.0. Cold, warm and uncached CLI JSON are byte-identical on the frozen 1.7 GB real-data snapshot.
- [x] AC-2 [local]: A second run parses 0 files. After one transcript gets a new line, the next run parses exactly that file. A deleted transcript loses its rows. proof: `npx vitest run test/sqlite-repo.test.ts` (count calls to `source.parse`) — Evidence: call counts and deletion assertions pass. Appending a valid assistant turn to an isolated copy of a real transcript changes the cached CLI report; that report equals a full uncached parse.
- [x] AC-3 [local]: A cache file with `user_version = 0`, or with garbage bytes, is rebuilt, and the run succeeds. proof: `npx vitest run test/sqlite-repo.test.ts` — Evidence: both rebuild cases pass. A CLI run with a disposable garbage DB rebuilds the full snapshot and produces byte-identical cold-run JSON. Missing DB creation also passes.
- [x] AC-4 [local]: `--no-cache` creates no cache file. proof: `npx vitest run test/sqlite-repo.test.ts` — Evidence: fixture assertion and snapshot CLI run pass; the isolated uncached run creates no database.
- [x] AC-5 [local]: The cache holds no message text: a fixture with a unique marker string in user and assistant text leaves no marker in the cache file. proof: `npx vitest run test/sqlite-repo.test.ts` — Evidence: marker test passes and asserts one parsed turn exists. A unique assistant-text marker appended to a real transcript copy is also absent from its cache DB.
- [x] AC-6 [local]: Cold and warm run times on João's real transcripts are recorded here. proof: timed `node dist/cli.js --json` runs — Evidence: frozen 1.7 GB snapshot, Node 24.16.0, in-process parsing: cold 10.369 s, warm 0.613 s, uncached 10.776 s. Times cover this snapshot, not the full live transcript collection.

## Integration Ledger

Integration verified on 2026-10-09: typecheck, all 54 tests and build pass with the async worker scan. Cold and warm SQLite CLI runs, an uncached in-process run and an uncached Node 22.13.0 worker run produce byte-identical JSON on the same frozen real-data snapshot. Worker selection uses the injected environment. TTY progress tests explicitly request an uncached scan; the 200 ms status test passes with a 25 ms in-process yield interval.

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
