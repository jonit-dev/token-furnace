# PRD-008 — Scan progress and a cold start that never looks frozen

**Status:** NOT STARTED
**Priority:** P1 — João's request on 2026-10-09: the first load took minutes with a dead page.
**Complexity:** 5 (MEDIUM)
**Owner:** João
**Depends on:** PRD-004, PRD-005

## Context

- Measured 2026-10-09 on real data (about 7,700 transcripts, 26 GB): a cold scan takes minutes. `serve` used to refuse connections until the scan ended. After f5f8e77 it binds first, but `app.reports.refresh()` still blocks the event loop, so a request waits with no feedback.
- PRD-004 makes warm runs fast. It does not fix the first run on a new machine, or the first run after a cache rebuild.

## Solution

- The scan runs without blocking the event loop. It processes files in small batches and yields between batches (`setImmediate`).
- One progress object: `ScanProgress { phase: "scanning" | "ready", filesDone, filesTotal, bytesDone, bytesTotal, startedAt, updatedAt }`. The repository reports it. `core/` stays free of I/O.
- `GET /api/status` returns `ScanProgress` at any time. It never waits for the scan.
- `GET /api/report` returns `202` with `{ status: "scanning", progress }` while no report exists. It returns `200` with the `Report` when the scan ends. With a warm cache it returns `200` at once.
- The React dashboard shows a loading screen while `phase` is `scanning`: a spinner, the text "Scanning your transcripts. Please wait.", "`filesDone` of `filesTotal` files", a progress bar, and the elapsed time. It polls `/api/status` every second and swaps to the report on its own.
- `GET /` while scanning answers `200` with a small self-contained loading page (inline CSS and JS, no bundle needed). It shows the same spinner and bar and reloads when ready.
- The CLI prints progress to **stderr** when stderr is a TTY: `Scanning 3,412 / 7,700 files (44%)`, redrawn in place. `--json` keeps stdout to the Report alone. Non-TTY runs print nothing.
- `serve` prints its URL first, then `Scanning N transcripts in the background...`.

## Acceptance Criteria

- [ ] AC-1 [local]: During a scan over a slow fake repository, `GET /api/status` answers in under 200 ms and `filesDone` rises between two reads. proof: `npx vitest run test/progress.test.ts` — Evidence: pending.
- [ ] AC-2 [local]: While scanning, `GET /api/report` returns 202 with `status: "scanning"`. After the scan it returns 200 and the `Report`. proof: `npx vitest run test/progress.test.ts` — Evidence: pending.
- [ ] AC-3 [local]: While scanning, `GET /` returns 200 HTML that contains the progress bar and the text "Please wait". After the scan it returns the dashboard. proof: `npx vitest run test/progress.test.ts` — Evidence: pending.
- [ ] AC-4 [local]: The React loading screen renders the bar at the right width for a given `ScanProgress`, and switches to the report when `phase` is `ready`. proof: `npx vitest run test/web/loading.test.tsx` — Evidence: pending.
- [ ] AC-5 [local]: `token-furnace --json` with a TTY stderr writes progress to stderr only. Stdout parses as one JSON value. proof: `npx vitest run test/cli.test.ts` — Evidence: pending.
- [ ] AC-6 [local]: The Report from the async scan equals the Report from the old blocking scan on the same fixture. proof: `npx vitest run test/progress.test.ts` — Evidence: pending.
- [ ] AC-7 [local]: On João's real transcripts with an empty cache, `/api/status` shows `phase: "scanning"` and `filesTotal > 0` within 2 seconds of `serve` start. proof: `rm` the cache file, start `serve`, `curl /api/status` — Evidence: pending.

## Integration Ledger

| Item | Source | Target | AC |
|---|---|---|---|
| Async batch scan | `report-service.ts` `refresh()` | `repo` scan loop with `ScanProgress` | AC-1, AC-6 |
| Status route | none | `server.ts` `/api/status` | AC-1 |
| 202 while scanning | none | `server.ts` `/api/report` | AC-2 |
| Loading page | none | `src/render/loading.ts` | AC-3 |
| Loading screen | none | `web/src/Loading.tsx` | AC-4 |
| CLI stderr progress | none | `cli.ts` | AC-5 |

## Phases

### Phase 1: async scan and progress object
**Files:** `src/repo/*`, `src/services/report-service.ts`, `src/core/model.ts` (type only)
**Implementation:** Batch the file loop and yield between batches. Update `ScanProgress` after each file. Keep the Report identical.
**Verification:** `npx vitest run test/progress.test.ts` — AC-1, AC-6.

### Phase 2: server routes and loading page
**Files:** `src/server.ts`, `src/render/loading.ts`
**Implementation:** Add `/api/status`, the 202 path, and the inline loading page for `/` while scanning.
**Verification:** `npx vitest run test/progress.test.ts` — AC-2, AC-3.

### Phase 3: React loading screen and CLI progress
**Files:** `web/src/Loading.tsx`, `src/cli.ts`
**Implementation:** Poll `/api/status` and draw the screen. Write TTY progress to stderr.
**Verification:** `npx vitest run test/web/loading.test.tsx test/cli.test.ts` — AC-4, AC-5.

### Phase 4: real-data check
**Implementation:** The caller runs AC-7 on the real transcripts.
