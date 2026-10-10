# PRD-008 — Scan progress and a cold start that never looks frozen

**Status:** IN PROGRESS — built on `feat/npx-restructure` ahead of PRD-004 because the first load blocked for minutes; AC-1 to AC-7 verified, merge with PRD-004's `report-service.ts` and `cli.ts` edits pending
**Priority:** P1 — João's request on 2026-10-09: the first load took minutes with a dead page.
**Complexity:** 5 (MEDIUM)
**Owner:** João
**Depends on:** PRD-004

## Context

- Measured 2026-10-09 on real data (about 7,700 transcripts, 26 GB): a cold scan takes minutes. `serve` used to refuse connections until the scan ended. After f5f8e77 it binds first, but `app.reports.refresh()` still blocks the event loop, so a request waits with no feedback.
- PRD-004 makes warm runs fast. It does not fix the first run on a new machine, or the first run after a cache rebuild.

## Where it goes

One choke point: `ReportService.refresh()` in `src/services/report-service.ts`. Every cold scan runs through it. The CLI awaits the scan. The server starts it in the background and serves the previous report during later rescans.

| Piece | File | Change |
|---|---|---|
| `ScanProgress` type | `src/core/model.ts` | Type only. No I/O in `core/`. |
| Progress state, async loop, single-flight | `src/services/report-service.ts` | `refresh()` is async. It uses the parse pool for every nonempty scan, capped to the changed-file count, or yields in-process every 25 ms when workers are disabled or unavailable. Overlapping requests share one scan. |
| Parallel transcript parsing | `src/services/parse-pool.ts`, `src/scan-worker.ts`, `src/compose.ts`, `tsup.config.ts` | Built CLI runs use up to 8 worker threads. Source runs and `TOKEN_FURNACE_WORKERS=0` use the in-process path. |
| Background rescan | `src/server.ts` | After 5 seconds, a request starts a rescan and serves the previous report. Later polls see the refreshed report. |
| `GET /api/status`, 202 path | `src/server.ts` (before `/api/report`, line 54) | Read `app.reports.progress`. Never await the scan. |
| Loading page for `/` | `src/render/loading.ts` (new) | One string of inline HTML, CSS and JS. It polls `/api/status` and calls `location.reload()` when ready. |
| Progress on stderr | `src/cli.ts:112` | `await app.reports.refresh(onProgress)`. Draw only when `process.stderr.isTTY`. |

- `filesTotal` counts **changed** files, not all files. A warm cache gives total 0 and no spinner at all.
- The React page (PRD-005) never sees the scanning state, because `/` serves the loading page until the report is ready. PRD-008 does not touch `web/`.
- Conflict risk: PRD-004 edits `report-service.ts` (batched saves) and `cli.ts` (`--no-cache`). Run PRD-008 after PRD-004 merges. PRD-005 edits `server.ts` (serve the bundle). Expect a small merge there.
- The in-process fallback can block while one large transcript parses. The built worker pool keeps parsing off the server event loop.
- Earlier measurement on the 1.7 GB snapshot: 83.9 seconds in-process and 36.0 seconds with 8 workers. These are historical timing results from the handoff; output parity and acceptance checks must pass again before closure.

## Solution

- The built worker pool parses files in parallel. The in-process fallback yields between files, so the event loop can answer between parses.
- Rescans use stale-while-revalidate: a request receives the existing report while the background scan refreshes it.
- `ScanProgress { phase: "scanning" | "ready", filesDone, filesTotal, bytesDone, bytesTotal, startedAt, updatedAt }`.
- `GET /api/status` returns it at any time.
- `GET /api/report` returns `202` with `{ status: "scanning", progress }` while no report exists. It returns `200` with the `Report` when ready. A warm cache returns `200` at once.
- `GET /` while scanning returns a self-contained loading page: a spinner, "Scanning your transcripts. Please wait.", "`filesDone` of `filesTotal` files", a progress bar, and elapsed time. It reloads into the dashboard when ready.
- The CLI draws `Scanning 3,412 / 7,700 files (44%)` on stderr when stderr is a TTY. `--json` stdout stays one JSON value.
- `serve` prints its URL first, then `Scanning N transcripts in the background...`.

## Acceptance Criteria

- [x] AC-1 [local]: During a scan over a slow fake repository, `GET /api/status` answers in under 200 ms and `filesDone` rises between two reads. proof: `npx vitest run test/progress.test.ts` — Evidence: re-run on 2026-10-09 with the assertion tightened to 200 ms; both progress tests pass and `filesDone` rises.
- [x] AC-2 [local]: While scanning, `GET /api/report` returns 202 with `status: "scanning"`. After the scan it returns 200 and the `Report`. proof: `npx vitest run test/progress.test.ts` — Evidence: `test/progress.test.ts` passes: 202 `scanning`, then 200 with the same Report as the blocking scan.
- [x] AC-3 [local]: While scanning, `GET /` returns 200 HTML that contains the progress bar and the text "Please wait". After the scan it returns the dashboard. proof: `npx vitest run test/progress.test.ts` — Evidence: `test/progress.test.ts` passes: `/` returns the loading page mid-scan and the dashboard after.
- [x] AC-4 [local]: The loading page contains the bar, the spinner, `/api/status` polling and `location.reload()`, and it needs no bundle file. proof: `npx vitest run test/progress.test.ts` — Evidence: `test/progress.test.ts` passes: the page holds `progressbar`, `/api/status` polling and `location.reload()`.
- [x] AC-5 [local]: `token-furnace --json` with a TTY stderr writes progress to stderr only. Stdout parses as one JSON value. proof: `npx vitest run test/cli.test.ts` — Evidence: `test/cli.test.ts` passes: TTY stderr draws progress, non-TTY stderr stays empty, `--json` stdout parses.
- [x] AC-6 [local]: The Report from the async scan equals the Report from the old blocking scan on the same fixture. proof: `npx vitest run test/progress.test.ts` — Evidence: `test/progress.test.ts` passes: Report equals the harness Report. Scan order is newest first, and `getRaw` sorts sessions back into file order.
- [x] AC-7 [local]: On João's real transcripts with an empty cache, `/api/status` shows `phase: "scanning"` and `filesTotal > 0` within 2 seconds of `serve` start. proof: `rm` the cache file, start `serve`, `curl /api/status` — Evidence: 2026-10-09 on 7,231 real files (13.3 GB): `/api/status` answered in 82 ms with `filesTotal: 7231` 2 s after start, and `/` served the loading page in 0.16 s.

## Integration Ledger

Verification on 2026-10-09, Node 24.16.0: typecheck, all 56 tests and build pass. Single-file cold scans use real parser workers with configured sizes 1 and 4; the regression makes main-thread parsing throw, so a fallback cannot falsely pass. Worker startup now also applies to small scans. Two sequential in-process CLI runs and an 8-worker run produce byte-identical JSON on the frozen 1.7 GB snapshot with plan usage disabled. The earlier Codex week mismatch did not reproduce; no cause is claimed. The fixture test selects an explicit Codex rate-limit reading and compares full reports. Worker exits with code 0 or 1 fall back without losing report data, and an unreadable fallback transcript rejects the scan. After SQLite integration and the small-scan worker change, an explicitly fresh-cache preview on 7,240 real transcripts (13.3 GB) returned scanning status in 57 ms about 1 second after launch, with 27 files already parsed; `/` contained the loading text and progress bar. Re-run the acceptance checks after the React merge.

| Item | Source | Target | AC |
|---|---|---|---|
| Async batch scan | `report-service.ts:30` `refresh()` | same method, async with `ScanProgress` and single-flight | AC-1, AC-6 |
| Status route | none | `server.ts` `/api/status` | AC-1 |
| 202 while scanning | none | `server.ts` `/api/report` | AC-2 |
| Loading page | none | `src/render/loading.ts` | AC-3, AC-4 |
| CLI stderr progress | none | `cli.ts` | AC-5 |

## Phases

### Phase 1: async scan and progress
**Files:** `src/core/model.ts`, `src/services/report-service.ts`, callers in `src/server.ts` and `src/cli.ts` (add `await`)
**Implementation:** Batch the loop, yield, keep one in-flight promise, update `ScanProgress` per file. The Report stays identical.
**Verification:** `npx vitest run test/progress.test.ts` — AC-1, AC-6.

### Phase 2: server routes and loading page
**Files:** `src/server.ts`, `src/render/loading.ts`
**Implementation:** Add `/api/status`, the 202 path, and the loading page for `/` while scanning.
**Verification:** `npx vitest run test/progress.test.ts` — AC-2, AC-3, AC-4.

### Phase 3: CLI progress and real-data check
**Files:** `src/cli.ts`
**Implementation:** Draw TTY progress on stderr from the `onProgress` callback.
**Verification:** `npx vitest run test/cli.test.ts` — AC-5. Run AC-7 on the real transcripts after integration.
