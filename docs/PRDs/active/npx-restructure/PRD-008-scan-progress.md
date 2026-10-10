# PRD-008 — Scan progress and a cold start that never looks frozen

**Status:** NOT STARTED
**Priority:** P1 — João's request on 2026-10-09: the first load took minutes with a dead page.
**Complexity:** 5 (MEDIUM)
**Owner:** João
**Depends on:** PRD-004

## Context

- Measured 2026-10-09 on real data (about 7,700 transcripts, 26 GB): a cold scan takes minutes. `serve` used to refuse connections until the scan ended. After f5f8e77 it binds first, but `app.reports.refresh()` still blocks the event loop, so a request waits with no feedback.
- PRD-004 makes warm runs fast. It does not fix the first run on a new machine, or the first run after a cache rebuild.

## Where it goes

One choke point: `ReportService.refresh()` at `src/services/report-service.ts:30`. It is a synchronous loop with one `source.parse()` per changed file. Every cold scan runs through it. Three callers wait on it today: `src/server.ts:73` (warm-up), `src/server.ts:83` (every request), `src/cli.ts:112`.

| Piece | File | Change |
|---|---|---|
| `ScanProgress` type | `src/core/model.ts` | Type only. No I/O in `core/`. |
| Progress state, async loop, single-flight | `src/services/report-service.ts` | `refresh()` becomes `async`. It yields (`setImmediate`) every 25 files or 50 ms. It keeps one in-flight promise, so overlapping requests share one scan. |
| `GET /api/status`, 202 path | `src/server.ts` (before `/api/report`, line 54) | Read `app.reports.progress`. Never await the scan. |
| Loading page for `/` | `src/render/loading.ts` (new) | One string of inline HTML, CSS and JS. It polls `/api/status` and calls `location.reload()` when ready. |
| Progress on stderr | `src/cli.ts:112` | `await app.reports.refresh(onProgress)`. Draw only when `process.stderr.isTTY`. |

- `filesTotal` counts **changed** files, not all files. A warm cache gives total 0 and no spinner at all.
- The React page (PRD-005) never sees the scanning state, because `/` serves the loading page until the report is ready. PRD-008 does not touch `web/`.
- Conflict risk: PRD-004 edits `report-service.ts` (batched saves) and `cli.ts` (`--no-cache`). Run PRD-008 after PRD-004 merges. PRD-005 edits `server.ts` (serve the bundle). Expect a small merge there.
- Ceiling: one very large transcript still blocks the loop while it parses. Per-file yield is enough for the spinner. Move the scan to a `worker_threads` worker only if a single file is measured above 1 s.

## Solution

- The scan yields between files, so the event loop keeps answering.
- `ScanProgress { phase: "scanning" | "ready", filesDone, filesTotal, bytesDone, bytesTotal, startedAt, updatedAt }`.
- `GET /api/status` returns it at any time.
- `GET /api/report` returns `202` with `{ status: "scanning", progress }` while no report exists. It returns `200` with the `Report` when ready. A warm cache returns `200` at once.
- `GET /` while scanning returns a self-contained loading page: a spinner, "Scanning your transcripts. Please wait.", "`filesDone` of `filesTotal` files", a progress bar, and elapsed time. It reloads into the dashboard when ready.
- The CLI draws `Scanning 3,412 / 7,700 files (44%)` on stderr when stderr is a TTY. `--json` stdout stays one JSON value.
- `serve` prints its URL first, then `Scanning N transcripts in the background...`.

## Acceptance Criteria

- [ ] AC-1 [local]: During a scan over a slow fake repository, `GET /api/status` answers in under 200 ms and `filesDone` rises between two reads. proof: `npx vitest run test/progress.test.ts` — Evidence: pending.
- [ ] AC-2 [local]: While scanning, `GET /api/report` returns 202 with `status: "scanning"`. After the scan it returns 200 and the `Report`. proof: `npx vitest run test/progress.test.ts` — Evidence: pending.
- [ ] AC-3 [local]: While scanning, `GET /` returns 200 HTML that contains the progress bar and the text "Please wait". After the scan it returns the dashboard. proof: `npx vitest run test/progress.test.ts` — Evidence: pending.
- [ ] AC-4 [local]: The loading page contains the bar, the spinner, `/api/status` polling and `location.reload()`, and it needs no bundle file. proof: `npx vitest run test/progress.test.ts` — Evidence: pending.
- [ ] AC-5 [local]: `token-furnace --json` with a TTY stderr writes progress to stderr only. Stdout parses as one JSON value. proof: `npx vitest run test/cli.test.ts` — Evidence: pending.
- [ ] AC-6 [local]: The Report from the async scan equals the Report from the old blocking scan on the same fixture. proof: `npx vitest run test/progress.test.ts` — Evidence: pending.
- [ ] AC-7 [local]: On João's real transcripts with an empty cache, `/api/status` shows `phase: "scanning"` and `filesTotal > 0` within 2 seconds of `serve` start. proof: `rm` the cache file, start `serve`, `curl /api/status` — Evidence: pending.

## Integration Ledger

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

### Phase 3: CLI progress
**Files:** `src/cli.ts`
**Implementation:** Draw TTY progress on stderr from the `onProgress` callback.
**Verification:** `npx vitest run test/cli.test.ts` — AC-5.

### Phase 4: real-data check
**Implementation:** The caller runs AC-7 on the real transcripts.
