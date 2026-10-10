# PRD-003 — CLI, Express server, and cutover from `burn.py`

**Status:** DONE
**Priority:** P1 — after this PRD the tool runs on Node only, and the Python is gone.
**Complexity:** 6 (MEDIUM)
**Owner:** João
**Depends on:** PRD-002

## Context

- `burn.py` `main()` (`burn.py:987`) uses argparse: `days` (default 7), `--source`, `--list-sources`, `--html`, `--weekly-budget`, `--serve PORT`, `--doctor`. Exit 1 when there is no data, or with `--doctor` when there are leaks.
- `print_doctor` (`burn.py:1028`) and `print_text` (`burn.py:1142`) render the terminal output.
- `serve()` (`burn.py:953`) answers `/dashboard.html` (raw page, polled for hot reload), `/api/report` (rebuilt per request), and every other path (page with the report inlined). It binds `127.0.0.1` with no `Host` check.
- `render_html()` (`burn.py:1498`) replaces `/*REPORT*/null` in `dashboard.html` with the report JSON.
- `plan_week()` (`burn.py:862`) sends the Claude OAuth token to `api.anthropic.com` on every run, and caches the result in `usage_cache()`.
- `scripts/doctor` starts a background `--serve 8765`, then runs `--doctor --html ~/.cache/token-furnace/report.html`. `SKILL.md` tells agents to run `scripts/doctor`.

## Solution

- `src/services/report-service.ts`: `ReportService(sources, repo)` with `refresh()` and `getReport(days, source, opts)`, as in architecture.md "Data flow".
- `src/repo/session-repo.ts` (interface) and `src/repo/memory-repo.ts`. PRD-004 adds SQLite.
- `src/services/usage-client.ts`: port of `plan_week()`, called by default when a login exists; `--no-plan-usage` turns it off (changed 2026-10-09).
- `src/compose.ts`: the composition root from architecture.md.
- `src/render/text.ts`: port of `print_doctor` and `print_text`, same strings.
- `src/cli.ts`: `node:util` `parseArgs`. Commands and flags from architecture.md "Entry points", plus `--full` (old `burn.py` default text), `--list-sources`, `--weekly-budget`, and `--plan-usage`. Exit codes are the same as Python.
- `src/server.ts`: Express 5 on `127.0.0.1`. Routes are `/api/report?days=&source=`, `/` (page with the report inlined), and `/dashboard.html`. A middleware rejects a `Host` other than `127.0.0.1:<port>` or `localhost:<port>` with 403.
- The old `dashboard.html` moves to `web/legacy/dashboard.html`. The server and `--html` serve it until PRD-005.

## Acceptance Criteria

- [x] AC-1 [local]: `token-furnace --json` on the fixture prints JSON that equals `toView(buildReport(...))`, and nothing else on stdout. proof: `npx vitest run test/cli.test.ts` — Evidence: 10 tests pass; stdout is one JSON line equal to `tsReport(...)`, and the built `node dist/cli.js --json` prints 1 line with all Report keys.
- [x] AC-2 [local]: The default command prints the same verdict text as `burn.py --doctor` on the same fixture (captured into the test before Python is deleted). It exits 1 with leaks, 1 with no data, and 0 on a clean fixture. proof: `npx vitest run test/cli.test.ts` — Evidence: masked output equals `test/golden/doctor.txt`; exit 1 on leaks, 1 on no data, 0 on the clean fixture. `node dist/cli.js` on the live fixture printed 14 leaks and exited 1.
- [x] AC-3 [local]: `GET /api/report` returns the `Report`. A request with `Host: evil.example:8765` gets 403. The server listens on `127.0.0.1` only. proof: `npx vitest run test/server.test.ts` — Evidence: 6 tests pass; 403 on the evil Host for all three routes, ECONNREFUSED on the LAN address. Live `serve --port 18765` returned the report JSON and 403 for `Host: evil.example:18765`.
- [x] AC-4 [local]: A run with `--no-plan-usage`, or with no login on the machine, makes no network call. proof: test stubs `fetch` to throw, and the run passes — `npx vitest run test/cli.test.ts` — Evidence: the `fetch` stub was never called and the run still exited 1 with "the subscription usage was unavailable".
- [x] AC-5 [local]: `--html out.html` writes a file that shows the report when opened from disk. proof: open the file in a browser, and the leak list is visible — Evidence: 70 KB page written; headless Chrome render shows the KPI tiles plus "Sessions compact too late", "The caller reads files and logs itself" and 8 more leaks with Copy fix buttons.
- [x] AC-6 [local]: `burn.py`, `test_burn.py`, `doctor`, and `scripts/__pycache__` are deleted. `SKILL.md` and `references/` name `npx token-furnace` instead of `scripts/doctor` and `burn.py`. proof: `git ls-files scripts` lists only PRD-006 files, and `grep -rn "burn.py\|scripts/doctor" SKILL.md references` returns no lines — Evidence: the four Python files, `test/parity.test.ts` and the Python-only golden-capture test are gone; the grep returns nothing; `npm test` passes 37 tests with only `/usr/bin:/bin` on PATH (no python3).

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Doctor verdict | `npx token-furnace` → `cli.ts` | `scripts/doctor`, `burn.py --doctor`, deleted | AC-2 |
| Agent JSON | `npx token-furnace --json` | none (new) | AC-1 |
| Live report | `token-furnace serve` → `server.ts` | `burn.py --serve`, deleted | AC-3 |
| Static report | `--html` → `web/legacy/dashboard.html` | `render_html`, deleted | AC-5 |
| Plan usage | default when a login exists → `usage-client.ts` | `plan_week` (was always on) | AC-4 |

## Execution Phases

#### Phase 1: Service, repository, composition
**Status:** DONE
**Files:** `src/services/report-service.ts`, `src/repo/session-repo.ts`, `src/repo/memory-repo.ts`, `src/services/usage-client.ts`, `src/compose.ts`, `test/report-service.test.ts`
**Implementation:** `ReportService` reads config files through the sources and passes contents to the pure `buildReport()`. `usage-client.ts` keeps the Python cache file location and the 5-minute reuse rule.
**Verification:** `npx vitest run test/report-service.test.ts`.

#### Phase 2: CLI and text rendering
**Status:** DONE
**Files:** `src/cli.ts`, `src/render/text.ts`, `test/cli.test.ts`
**Implementation:** Before you delete Python, capture `burn.py --doctor` and `burn.py` output on the fixture into `test/golden/doctor.txt` and `test/golden/full.txt`. Mask times that change per run.
**Verification:** `npx vitest run test/cli.test.ts` — AC-1, AC-2, AC-4.

#### Phase 3: Server
**Status:** DONE
**Files:** `src/server.ts`, `web/legacy/dashboard.html` (`git mv`), `test/server.test.ts`
**Implementation:** Add `express` as the only runtime dependency. Port the three routes. `serve` prints the URL. It does not open a browser.
**Verification:** `npx vitest run test/server.test.ts` — AC-3. Manual browser check — AC-5.

#### Phase 4: Cutover
**Status:** DONE
**Files:** delete `scripts/burn.py`, `scripts/test_burn.py`, `scripts/doctor`, `scripts/__pycache__`, `test/parity.test.ts`; edit `SKILL.md`, `references/evidence.md`
**Implementation:** The parity test needs Python, so it goes with Python. `test/analysis.test.ts` and the golden files keep the behavior pinned.
**Verification:** `npm test` passes with no `python3` on `PATH` — AC-6.
